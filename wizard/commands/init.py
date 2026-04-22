"""`gt-wizard init` — top-level onboarding flow.

Runs the other primitives in the right order: ensure .env, collect tokens,
sanity-check prerequisites, and tell the user how to start Mayor / TeleTalk /
Crow. Safe to re-run — each step is idempotent.
"""

from __future__ import annotations

import argparse

from lib import ui
from lib.env import EnvFile

from . import setup_telegram, start, verify

NAME = "init"
HELP = "Run the full onboarding flow (idempotent — safe to re-run)."


def register(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "--non-interactive",
        action="store_true",
        help="Fail instead of prompting when a required value is missing.",
    )


def run(args: argparse.Namespace) -> int:
    ui.header("Gas Town starter kit — install")

    ui.info(
        "This flow will: collect your Telegram bot tokens, verify Claude auth, "
        "and explain how to start Mayor / TeleTalk / Crow."
    )

    env = EnvFile.load()

    _collect_anthropic(env, non_interactive=args.non_interactive)
    _collect_git_identity(env, non_interactive=args.non_interactive)
    env.save()

    # Delegate Telegram to the dedicated primitive so the skill can also call
    # it directly without going through `init`.
    telegram_args = argparse.Namespace(non_interactive=args.non_interactive)
    setup_telegram.run(telegram_args)

    verify_args = argparse.Namespace()
    rc = verify.run(verify_args)
    if rc != 0:
        ui.warn("Verification found issues — fix them before running `start`.")
        return rc

    ui.header("Next steps")
    ui.info("Run `gt-wizard start` to launch Mayor, TeleTalk, and Crow.")
    ui.info("Or, inside Claude Code, continue the conversation with the install-gastown skill.")
    return 0


def _collect_anthropic(env: EnvFile, non_interactive: bool) -> None:
    ui.header("Claude auth")

    current = env.get("ANTHROPIC_API_KEY") or ""
    if current:
        ui.success("ANTHROPIC_API_KEY is set (you will be billed per token).")
        return

    ui.info(
        "No ANTHROPIC_API_KEY in .env — you'll use `claude login` from the host. "
        "This is the right default for Claude Pro / Max subscribers."
    )
    if non_interactive:
        return

    if ui.confirm("Set an ANTHROPIC_API_KEY instead?", default=False):
        key = ui.prompt("ANTHROPIC_API_KEY", secret=True)
        env.set("ANTHROPIC_API_KEY", key)
        ui.success("ANTHROPIC_API_KEY saved.")


def _collect_git_identity(env: EnvFile, non_interactive: bool) -> None:
    ui.header("Git identity")

    name = env.get("GIT_USER_NAME") or ""
    email = env.get("GIT_USER_EMAIL") or ""

    if name and email:
        ui.success(f"Git identity already set: {name} <{email}>")
        return

    if non_interactive:
        ui.warn("GIT_USER_NAME / GIT_USER_EMAIL missing — set them in .env before running agents.")
        return

    name = name or ui.prompt("Your name (for git commits)")
    email = email or ui.prompt("Your email (for git commits)")
    env.set("GIT_USER_NAME", name)
    env.set("GIT_USER_EMAIL", email)
    ui.success("Git identity saved.")
