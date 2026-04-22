"""`gt-wizard setup-telegram` — collect / update Telegram bot tokens.

Separate from `init` so the skill can send users here directly when they want
to rotate tokens or add the operator chat ID after the fact.

gt-bot (`GT_BOT_TOKEN`) is the one required bot. TeleTalk and Crow are optional
add-ons — the user can press enter to skip them and fill them in later.
"""

from __future__ import annotations

import argparse
import re

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
    _set_chat_id(env, "OPERATOR_TELEGRAM_CHAT_ID", args.non_interactive)

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


def _set_chat_id(env: EnvFile, key: str, non_interactive: bool) -> None:
    existing = env.get(key) or ""
    if existing and _CHAT_ID_RE.match(existing):
        ui.success(f"{key} already set to {existing}.")
        return

    if non_interactive:
        ui.warn(f"{key} missing — message @userinfobot on Telegram to find yours.")
        return

    ui.info(
        "Your operator chat ID is the Telegram user ID the bots will DM for "
        "escalations. On first boot the container seeds this as gt-bot's first "
        "admin row. Message @userinfobot on Telegram to find yours."
    )
    while True:
        raw = ui.prompt(f"{key}")
        if _CHAT_ID_RE.match(raw):
            env.set(key, raw)
            ui.success(f"{key} saved.")
            return
        ui.warn("Chat ID must be an integer (often 9+ digits).")
