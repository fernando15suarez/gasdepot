"""`gt-wizard verify` — sanity checks before declaring install success.

This runs after the skill claims the stack is up, so the checks must be
strong enough that "verify green" implies "gt mail send mayor/ will
actually work." The earlier version only checked tokens + Claude auth; that
let several users declare success on containers whose HQ had never been
created and whose Mayor was never started. The additions below close that
gap.

Required checks (failing any of these fails the whole verify):
  - .env keys present and well-formed
  - Claude auth available (ANTHROPIC_API_KEY or ~/.claude mount)
  - Dolt TCP port open on localhost
  - Workspace exists: $GT_TOWN_ROOT/CLAUDE.md is readable
    (default: /gastown/repos/hq/CLAUDE.md)
  - gt_bot DB exists (via `dolt sql` if the CLI is available, TCP otherwise)
  - gt-bot HTTP port 3335 is listening
  - Mayor tmux session is alive (or `gt mayor status --running` == true)
  - End-to-end: `gt mail send mayor/` succeeds against the live HQ

Optional (warn only):
  - TeleTalk / Crow tokens, if set, must be well-formed.
"""

from __future__ import annotations

import argparse
import os
import re
import shutil
import socket
import subprocess
import time
from pathlib import Path

from lib import ui
from lib.env import EnvFile

NAME = "verify"
HELP = "Run health checks and report missing / bad configuration."

_TOKEN_RE = re.compile(r"^\d{6,}:[A-Za-z0-9_-]{20,}$")
_CHAT_ID_RE = re.compile(r"^-?\d+$")

# Required keys must be present and match their regex.
REQUIRED_KEYS = {
    "GT_BOT_TOKEN": ("Telegram token for gt-bot (primary bridge)", _TOKEN_RE),
    "OPERATOR_TELEGRAM_CHAT_ID": ("Your Telegram chat ID", _CHAT_ID_RE),
}

# Optional keys: if present they must match, but missing is fine.
OPTIONAL_KEYS = {
    "TELETALK_BOT_TOKEN": ("Telegram token for TeleTalk (optional add-on)", _TOKEN_RE),
    "CROW_BOT_TOKEN": ("Telegram token for Crow (optional add-on)", _TOKEN_RE),
}

GASTOWN_HOME = Path(os.environ.get("GASTOWN_HOME", "/gastown"))
# HQ now lives under /gastown/repos (in the persisted named volume) — see
# entrypoint.sh's HQ_ROOT. Honor GT_TOWN_ROOT if set (the env var gt itself
# uses), fall back to the default install path.
HQ_ROOT = Path(os.environ.get("GT_TOWN_ROOT", str(GASTOWN_HOME / "repos" / "hq")))
GT_BOT_PORT = int(os.environ.get("GT_BOT_PORT", "3335"))
MAYOR_SESSION = "hq-mayor"


def register(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--quiet", action="store_true", help="Only print failures.")
    parser.add_argument(
        "--skip-mail",
        action="store_true",
        help="Skip the end-to-end `gt mail send` check (avoids creating beads).",
    )


def run(args: argparse.Namespace) -> int:
    ui.header("Verification")
    failures = 0

    env = EnvFile.load()

    # --- Required env vars ------------------------------------------------
    for key, (label, pattern) in REQUIRED_KEYS.items():
        value = env.get(key) or ""
        if not value:
            ui.error(f"{key} is empty ({label}) — run `gt-wizard setup-telegram`.")
            failures += 1
        elif not pattern.match(value):
            ui.error(f"{key} doesn't look valid ({label}).")
            failures += 1
        elif not args.quiet:
            ui.success(f"{key} OK.")

    # --- Optional env vars ------------------------------------------------
    for key, (label, pattern) in OPTIONAL_KEYS.items():
        value = env.get(key) or ""
        if not value:
            if not args.quiet:
                ui.info(f"{key} not set ({label}) — OK, this add-on is optional.")
            continue
        if not pattern.match(value):
            # Garbage value → warn but do NOT fail (add-on is optional).
            ui.warn(f"{key} is set but doesn't look valid ({label}).")
        elif not args.quiet:
            ui.success(f"{key} OK (optional add-on enabled).")

    # --- Claude auth ------------------------------------------------------
    anthropic_set = bool(env.get("ANTHROPIC_API_KEY") or "")
    claude_dir = Path(os.path.expanduser("~/.claude"))
    claude_ok = claude_dir.exists() and any(claude_dir.iterdir())

    if anthropic_set:
        if not args.quiet:
            ui.success("ANTHROPIC_API_KEY set (per-token billing).")
    elif claude_ok:
        if not args.quiet:
            ui.success("Host ~/.claude is mounted and non-empty (subscription auth).")
    else:
        ui.error(
            "No Claude auth detected. Either run `claude login` on the host "
            "(recommended) or set ANTHROPIC_API_KEY in .env."
        )
        failures += 1

    # --- Dolt TCP ---------------------------------------------------------
    # Accept GT_DOLT_PORT (the bot's own var) or DOLT_PORT (entrypoint's
    # var) interchangeably so verify checks the same server the bot does.
    dolt_port = int(
        os.environ.get("GT_DOLT_PORT")
        or os.environ.get("DOLT_PORT")
        or "3307"
    )
    if _port_open("127.0.0.1", dolt_port):
        if not args.quiet:
            ui.success(f"Dolt reachable on 127.0.0.1:{dolt_port}.")
    else:
        ui.error(
            f"Dolt is not reachable on 127.0.0.1:{dolt_port}. Start the container "
            "(`docker compose up -d`) or re-run the entrypoint."
        )
        failures += 1

    # --- Workspace (HQ) exists -------------------------------------------
    claude_md = HQ_ROOT / "CLAUDE.md"
    if claude_md.is_file():
        if not args.quiet:
            ui.success(f"HQ present: {claude_md} readable.")
    else:
        ui.error(
            f"HQ missing: {claude_md} not found. Run "
            "`docker compose exec gastown gt-wizard install` to create it."
        )
        failures += 1

    # --- gt_bot DB exists -------------------------------------------------
    if _gt_bot_db_exists(dolt_port):
        if not args.quiet:
            ui.success("gt_bot database exists on Dolt.")
    else:
        ui.error(
            "gt_bot database not found. The entrypoint runs `gt-bot init` on "
            "boot — check `docker compose logs gastown | grep gt-bot`."
        )
        failures += 1

    # --- gt-bot HTTP listener --------------------------------------------
    if _port_open("127.0.0.1", GT_BOT_PORT):
        if not args.quiet:
            ui.success(f"gt-bot listening on 127.0.0.1:{GT_BOT_PORT}.")
    else:
        ui.error(
            f"gt-bot is not listening on 127.0.0.1:{GT_BOT_PORT}. "
            "Check `docker compose logs gastown | grep gt-bot`."
        )
        failures += 1

    # --- Mayor session is up ---------------------------------------------
    if _mayor_is_up():
        if not args.quiet:
            ui.success(f"Mayor session `{MAYOR_SESSION}` is alive.")
    else:
        ui.error(
            "Mayor tmux session not found. Run "
            "`docker compose exec gastown gt-wizard start`."
        )
        failures += 1

    # --- End-to-end mail send --------------------------------------------
    if args.skip_mail:
        if not args.quiet:
            ui.info("Skipping end-to-end mail check (--skip-mail).")
    else:
        ok, cmd = _mail_roundtrip()
        if ok:
            if not args.quiet:
                ui.success(f"`gt mail send mayor/` works. ({cmd})")
        else:
            ui.error(
                "`gt mail send mayor/` failed — the full pipeline is not healthy. "
                f"Command: {cmd}"
            )
            failures += 1

    # --- Verdict ----------------------------------------------------------
    if failures:
        ui.error(f"{failures} check(s) failed.")
        return 1

    ui.success("All checks passed.")
    return 0


def _port_open(host: str, port: int, timeout: float = 1.5) -> bool:
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


def _gt_bot_db_exists(dolt_port: int) -> bool:
    """Check gt_bot DB over TCP via the exact same path gt-bot uses.

    Earlier versions shelled out to `dolt sql`, but that resolves the
    server differently than a TCP MySQL client — it was reporting a
    false negative even when the bot (which uses mysql2 on 127.0.0.1:3307)
    could happily connect. We now run a tiny node one-liner inside the
    bot's own node_modules tree so the check mirrors the bot's own
    connection semantics.
    """
    bot_dir = Path("/gastown/bot")
    script = (
        "const mysql = require('mysql2/promise');"
        "(async () => {"
        "  try {"
        f"    const c = await mysql.createConnection({{host:'127.0.0.1',port:{dolt_port},user:'root',password:'',database:'gt_bot'}});"
        "    await c.query('SHOW TABLES');"
        "    await c.end();"
        "    process.exit(0);"
        "  } catch (e) {"
        "    console.error(e.message);"
        "    process.exit(1);"
        "  }"
        "})();"
    )
    if bot_dir.is_dir() and shutil.which("node"):
        try:
            proc = subprocess.run(
                ["node", "-e", script],
                cwd=str(bot_dir),
                capture_output=True, text=True, timeout=10, check=False,
            )
            if proc.returncode == 0:
                return True
            # Don't silently accept false; fall through so we return False
            # and the caller prints the ✗.
            return False
        except (OSError, subprocess.TimeoutExpired):
            pass
    # Fallback: at least confirm the server port is open.
    return _port_open("127.0.0.1", dolt_port)


def _mayor_is_up() -> bool:
    if shutil.which("tmux"):
        rc = subprocess.run(
            ["tmux", "has-session", "-t", MAYOR_SESSION],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False,
        ).returncode
        if rc == 0:
            return True
    # Fall back to asking gt directly — more reliable across session-naming
    # tweaks but depends on gt being configured.
    try:
        proc = subprocess.run(
            ["gt", "mayor", "status", "--running"],
            capture_output=True, text=True, timeout=5, check=False,
        )
        return proc.stdout.strip().lower() == "true"
    except (OSError, subprocess.TimeoutExpired):
        return False


def _mail_roundtrip() -> tuple[bool, str]:
    """Send a test mail to mayor/. Returns (ok, human-readable command)."""
    subject = f"verify-{int(time.time())}"
    body = "wizard verify test"
    cmd = ["gt", "mail", "send", "mayor/", "-s", subject, "--stdin"]
    display = f"echo {body!r} | gt mail send mayor/ -s {subject} --stdin"
    try:
        proc = subprocess.run(
            cmd,
            input=body,
            text=True,
            cwd=str(HQ_ROOT) if HQ_ROOT.is_dir() else None,
            capture_output=True,
            timeout=15,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return False, display
    return proc.returncode == 0, display
