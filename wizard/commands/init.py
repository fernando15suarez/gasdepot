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
    ui.header("gasDepot — install")

    ui.info(
        "This flow will: collect your Telegram bot tokens, verify Claude auth, "
        "and explain how to start Mayor / TeleTalk / Crow."
    )

    env = EnvFile.load()

    _collect_anthropic(env, non_interactive=args.non_interactive)
    _collect_git_identity(env, non_interactive=args.non_interactive)
    _collect_overlays(env, non_interactive=args.non_interactive)
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
    ui.info("Or, inside Claude Code, continue the conversation with the install-gasDepot skill.")
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


# Overlay compose files. Selected entries are joined with `:` (the docker
# compose convention) and written to .env as COMPOSE_FILE so that plain
# `docker compose up` picks the chosen overlays automatically.
_BASE_COMPOSE = "docker-compose.yml"
_VOICE_OVERLAY = "docker-compose.voice.yml"
_DOCKER_HOST_OVERLAY = "docker-compose.docker-host.yml"


def _collect_overlays(env: EnvFile, non_interactive: bool) -> None:
    ui.header("Optional features")
    ui.info(
        "The default install is lightweight: gt-bot Telegram bridge + Mayor + "
        "Dolt, no docker-socket bind, no local voice transcription. "
        "Two overlays are available — both default to off."
    )

    existing = env.get("COMPOSE_FILE") or ""
    parts = [p for p in existing.split(":") if p]
    has_voice = _VOICE_OVERLAY in parts
    has_docker_host = _DOCKER_HOST_OVERLAY in parts

    if non_interactive:
        if existing:
            ui.success(f"COMPOSE_FILE already set: {existing} — leaving unchanged.")
        else:
            ui.info("COMPOSE_FILE not set — defaulting to lightweight (no overlays).")
        return

    ui.info(
        "Voice transcription bakes ffmpeg + whisper.cpp into the image so "
        "gt-bot transcribes Telegram voice messages locally. ~80-130MB "
        "image growth and ~1-2 min extra build time. The ~75MB ggml model "
        "is lazy-downloaded by gt-bot on the first voice DM."
    )
    want_voice = ui.confirm("Enable voice transcription?", default=has_voice)

    ui.info(
        "Docker-host access bind-mounts /var/run/docker.sock into the "
        "container so Mayor (and downstream user projects) can drive the "
        "host docker daemon. This grants effective root-on-host inside the "
        "container — see docs/docker-access.md before enabling."
    )
    want_docker_host = ui.confirm("Enable docker-host access?", default=has_docker_host)

    overlays = [_BASE_COMPOSE]
    if want_docker_host:
        overlays.append(_DOCKER_HOST_OVERLAY)
    if want_voice:
        overlays.append(_VOICE_OVERLAY)

    if len(overlays) == 1:
        # No overlays chosen. Drop COMPOSE_FILE entirely if it's set so
        # `docker compose up` falls through to the default file lookup.
        if existing:
            env.set("COMPOSE_FILE", "")
            ui.success("COMPOSE_FILE cleared — using lightweight default.")
        else:
            ui.success("Using lightweight default (no overlays).")
        return

    new_value = ":".join(overlays)
    if new_value == existing:
        ui.success(f"COMPOSE_FILE unchanged: {new_value}")
        return

    env.set("COMPOSE_FILE", new_value)
    ui.success(f"COMPOSE_FILE set to: {new_value}")
    ui.info(
        "Rebuild and restart the stack to pick up the new overlays:\n"
        "    docker compose build\n"
        "    docker compose up -d"
    )
