"""`gt-wizard add-bot` — opt into the gt-bot Telegram bridge after install.

Thin wrapper around `setup-telegram`. Lets users who installed without the
bot enable it later without re-running the whole `init` flow. After token
entry the user must restart the container so the entrypoint picks up the
new GT_BOT_TOKEN and starts gt-bot.
"""

from __future__ import annotations

import argparse

from lib import ui

from . import setup_telegram

NAME = "add-bot"
HELP = "Enable the gt-bot Telegram bridge on an existing install."


def register(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "--non-interactive",
        action="store_true",
        help="Fail instead of prompting when a required value is missing.",
    )


def run(args: argparse.Namespace) -> int:
    ui.header("Add gt-bot")
    ui.info(
        "This will collect a Telegram bot token (and operator chat id) and "
        "save them to .env. gt-bot will not start until you restart the "
        "container."
    )

    rc = setup_telegram.run(args)
    if rc != 0:
        return rc

    ui.header("Restart the container")
    ui.info(
        "Run the following on the host so the entrypoint picks up the new "
        "GT_BOT_TOKEN and launches gt-bot:"
    )
    ui.info("    docker compose restart gastown")
    return 0
