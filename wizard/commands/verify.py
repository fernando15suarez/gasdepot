"""`gt-wizard verify` — sanity checks before starting agents.

Catches the most common "stuck at install" problems:
  - `.env` exists and has the keys we expect
  - Telegram tokens are shaped right
  - Claude credentials are mounted and non-empty
  - Dolt server is reachable on the configured port
"""

from __future__ import annotations

import argparse
import os
import re
import socket
from pathlib import Path

from lib import ui
from lib.env import EnvFile

NAME = "verify"
HELP = "Run health checks and report missing / bad configuration."

_TOKEN_RE = re.compile(r"^\d{6,}:[A-Za-z0-9_-]{20,}$")
_CHAT_ID_RE = re.compile(r"^-?\d+$")

REQUIRED_KEYS = {
    "TELETALK_BOT_TOKEN": ("Telegram token for TeleTalk", _TOKEN_RE),
    "CROW_BOT_TOKEN": ("Telegram token for Crow", _TOKEN_RE),
    "OPERATOR_TELEGRAM_CHAT_ID": ("Your Telegram chat ID", _CHAT_ID_RE),
}


def register(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--quiet", action="store_true", help="Only print failures.")


def run(args: argparse.Namespace) -> int:
    ui.header("Verification")
    failures = 0

    env = EnvFile.load()
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

    dolt_port = int(os.environ.get("DOLT_PORT", "3307"))
    if _port_open("127.0.0.1", dolt_port):
        if not args.quiet:
            ui.success(f"Dolt reachable on port {dolt_port}.")
    else:
        ui.error(
            f"Dolt is not reachable on 127.0.0.1:{dolt_port}. Start the container "
            "(`docker compose up -d`) or re-run the entrypoint."
        )
        failures += 1

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
