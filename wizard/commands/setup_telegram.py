"""`gt-wizard setup-telegram` — collect / update Telegram bot tokens.

Separate from `init` so the skill can send users here directly when they want
to rotate tokens or add the operator chat ID after the fact.

gt-bot (`GT_BOT_TOKEN`) is the one required bot. TeleTalk and Crow are optional
add-ons — the user can press enter to skip them and fill them in later.
"""

from __future__ import annotations

import argparse
import json
import re
import time
import urllib.error
import urllib.parse
import urllib.request

from lib import ui
from lib.env import EnvFile

NAME = "setup-telegram"
HELP = "Collect or update Telegram bot tokens and operator chat ID."

_TOKEN_RE = re.compile(r"^\d{6,}:[A-Za-z0-9_-]{20,}$")
_CHAT_ID_RE = re.compile(r"^-?\d+$")


def register(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "--non-interactive",
        action="store_true",
        help="Fail instead of prompting when a required value is missing.",
    )


def run(args: argparse.Namespace) -> int:
    ui.header("Telegram bots")
    ui.info(
        "gt-bot is Gas Town's default Telegram bridge — you need one bot for it. "
        "Create it by chatting with @BotFather on Telegram (`/newbot`) and paste "
        "the token below."
    )
    ui.info(
        "TeleTalk and Crow are optional add-ons. Press enter at their prompts to "
        "skip — you can set them later by re-running `gt-wizard setup-telegram`."
    )

    env = EnvFile.load()

    _set_token(
        env,
        "GT_BOT_TOKEN",
        "gt-bot Telegram bot token (required)",
        args.non_interactive,
        required=True,
    )
    _set_chat_id(
        env,
        "OPERATOR_TELEGRAM_CHAT_ID",
        args.non_interactive,
        bot_token=env.get("GT_BOT_TOKEN") or "",
    )
    _set_token(
        env,
        "TELETALK_BOT_TOKEN",
        "TeleTalk bot token (optional — press enter to skip)",
        args.non_interactive,
        required=False,
    )
    _set_token(
        env,
        "CROW_BOT_TOKEN",
        "Crow bot token (optional — press enter to skip)",
        args.non_interactive,
        required=False,
    )

    env.save()
    ui.success("Telegram settings saved to .env.")
    return 0


def _set_token(
    env: EnvFile,
    key: str,
    label: str,
    non_interactive: bool,
    required: bool = True,
) -> None:
    existing = env.get(key) or ""
    if existing and _TOKEN_RE.match(existing):
        if non_interactive or not ui.confirm(f"{key} already set — replace it?", default=False):
            ui.success(f"{key} left unchanged.")
            return

    if non_interactive and not existing:
        if required:
            ui.warn(f"{key} is missing — set it in .env before starting agents.")
        else:
            ui.info(f"{key} not set (optional).")
        return

    while True:
        token = ui.prompt(label, secret=True)
        if not token:
            if required:
                ui.warn(f"{key} is required. Paste the token from @BotFather to continue.")
                continue
            ui.info(f"{key} left blank (optional — skipping).")
            return
        if _TOKEN_RE.match(token):
            env.set(key, token)
            ui.success(f"{key} saved.")
            return
        ui.warn("That doesn't look like a Telegram bot token (expect `digits:letters`). Try again.")


def _set_chat_id(
    env: EnvFile,
    key: str,
    non_interactive: bool,
    bot_token: str = "",
) -> None:
    existing = env.get(key) or ""
    if existing and _CHAT_ID_RE.match(existing):
        ui.success(f"{key} already set to {existing}.")
        return

    if non_interactive:
        ui.warn(f"{key} missing — message @userinfobot on Telegram to find yours.")
        return

    ui.info(
        "Your operator chat ID is the Telegram user ID the bot will DM for "
        "escalations. On first boot the container seeds this as gt-bot's "
        "first admin row."
    )

    # Auto-detect by having the user message the bot. Requires GT_BOT_TOKEN.
    if bot_token and _TOKEN_RE.match(bot_token):
        ui.info(
            "Open Telegram, find the bot you just created, and send it any "
            "message (e.g. \"hello\"). The wizard will read your chat ID "
            "from the Telegram API."
        )
        detected = _detect_chat_id(bot_token, timeout_s=90)
        if detected:
            env.set(key, str(detected))
            ui.success(f"{key} auto-detected: {detected}")
            return
        ui.warn(
            "Did not receive a message within the timeout. Falling back to "
            "manual entry — message @userinfobot on Telegram to find your ID."
        )

    while True:
        raw = ui.prompt(f"{key}")
        if _CHAT_ID_RE.match(raw):
            env.set(key, raw)
            ui.success(f"{key} saved.")
            return
        ui.warn("Chat ID must be an integer (often 9+ digits).")


def _detect_chat_id(bot_token: str, timeout_s: int = 90) -> int | None:
    """Poll Telegram getUpdates until a message arrives or we time out.

    Returns the sender's chat_id from the first message we see, or None.
    Uses long-polling (Telegram holds the HTTP response open) to keep
    network chatter low.
    """
    base = f"https://api.telegram.org/bot{bot_token}"

    # Start from the latest update_id so we ignore any pre-existing history.
    try:
        offset = _latest_update_id(base) + 1
    except _TelegramApiError as e:
        ui.warn(f"Could not reach Telegram: {e}. Falling back to manual entry.")
        return None

    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        remaining = max(1, int(deadline - time.monotonic()))
        poll = min(25, remaining)  # Telegram caps long-poll at 50s; 25s is safe.
        try:
            qs = urllib.parse.urlencode({"offset": offset, "timeout": poll})
            with urllib.request.urlopen(
                f"{base}/getUpdates?{qs}", timeout=poll + 10
            ) as resp:
                payload = json.loads(resp.read().decode("utf-8"))
        except (urllib.error.URLError, TimeoutError, OSError, json.JSONDecodeError):
            # Any transient failure — retry until the deadline.
            time.sleep(1)
            continue
        if not payload.get("ok"):
            return None
        for update in payload.get("result", []):
            offset = update["update_id"] + 1
            message = (
                update.get("message")
                or update.get("edited_message")
                or update.get("channel_post")
            )
            if not message:
                continue
            chat = message.get("chat") or {}
            chat_id = chat.get("id")
            if isinstance(chat_id, int):
                return chat_id
    return None


class _TelegramApiError(RuntimeError):
    pass


def _latest_update_id(base: str) -> int:
    """Return the most-recent update_id, or 0 if the queue is empty."""
    try:
        with urllib.request.urlopen(f"{base}/getUpdates?offset=-1", timeout=10) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
    except (urllib.error.URLError, TimeoutError, OSError, json.JSONDecodeError) as e:
        raise _TelegramApiError(str(e)) from e
    if not payload.get("ok"):
        raise _TelegramApiError(payload.get("description") or "Telegram API error")
    results = payload.get("result") or []
    if not results:
        return 0
    return int(results[-1]["update_id"])
