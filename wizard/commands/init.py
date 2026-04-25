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

# Compose-file overlay catalog. Keep in lockstep with the docker-compose.*.yml
# files at the repo root — adding an overlay here without the matching file is
# a foot-gun (docker compose will fail to start).
_BASE_COMPOSE = "docker-compose.yml"
_OVERLAY_VOICE = "docker-compose.voice.yml"
_OVERLAY_DOCKER_HOST = "docker-compose.docker-host.yml"


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

    # Reload — setup_telegram wrote to .env, and _collect_overlays wants to
    # see those values when computing the next prompt set.
    env = EnvFile.load()
    _collect_overlays(env, non_interactive=args.non_interactive)
    env.save()

    verify_args = argparse.Namespace(quiet=False, skip_mail=False)
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


def _collect_overlays(env: EnvFile, non_interactive: bool) -> None:
    """Ask which compose overlays to enable and persist via COMPOSE_FILE.

    The lightweight default (docker-compose.yml only) gives the user gt-bot
    Telegram + Mayor with no extra trust expansion. The two opt-ins are:

      voice         → adds whisper-cli + ffmpeg to the runtime image so the
                      bot can transcribe Telegram voice notes. Rebuild
                      required (build arg INSTALL_VOICE=1).
      docker-host   → bind-mounts /var/run/docker.sock so the container can
                      drive the host docker daemon. Effective root-on-host;
                      see docs/docker-access.md.

    Both default to NO so the trust expansion is always a deliberate choice.
    The result is written to COMPOSE_FILE in .env so the next `docker compose
    up` picks it up automatically.
    """
    ui.header("Compose overlays (optional)")

    current_compose_file = env.get("COMPOSE_FILE") or ""
    voice_default = _OVERLAY_VOICE in current_compose_file
    docker_default = _OVERLAY_DOCKER_HOST in current_compose_file

    if non_interactive:
        # Don't change anything in non-interactive mode. The user can re-run
        # `gt-wizard init` interactively to flip these.
        if current_compose_file:
            ui.info(f"COMPOSE_FILE left unchanged: {current_compose_file}")
        else:
            ui.info("Lightweight default (no overlays). Re-run interactively to enable voice / docker.")
        return

    ui.info(
        "Gas Town defaults to a lightweight stack (gt-bot + Mayor only). The "
        "two opt-ins below pull in heavier features. Default is NO for both."
    )

    enable_voice = ui.confirm(
        "Enable voice transcription? (bakes whisper-cli + ffmpeg into the image)",
        default=voice_default,
    )
    enable_docker = ui.confirm(
        "Enable docker access from inside the container? "
        "(bind-mounts /var/run/docker.sock — see docs/docker-access.md)",
        default=docker_default,
    )

    overlays: list[str] = [_BASE_COMPOSE]
    if enable_docker:
        overlays.append(_OVERLAY_DOCKER_HOST)
    if enable_voice:
        overlays.append(_OVERLAY_VOICE)

    if len(overlays) == 1:
        # No overlays selected — leave COMPOSE_FILE unset so docker compose
        # falls back to the lightweight default. If it was previously set,
        # blank it out so the user actually drops the overlay.
        if current_compose_file:
            env.set("COMPOSE_FILE", "")
            ui.success("Overlays disabled — COMPOSE_FILE cleared in .env.")
        else:
            ui.success("Lightweight default — no overlays enabled.")
        _print_apply_hint(overlays_changed=bool(current_compose_file))
        return

    new_compose_file = ":".join(overlays)
    if new_compose_file == current_compose_file:
        ui.success(f"COMPOSE_FILE unchanged: {new_compose_file}")
        _print_apply_hint(overlays_changed=False)
        return

    env.set("COMPOSE_FILE", new_compose_file)
    ui.success(f"COMPOSE_FILE set: {new_compose_file}")
    _print_apply_hint(overlays_changed=True)


def _print_apply_hint(overlays_changed: bool) -> None:
    """Tell the user how to roll the running container onto the new overlays.

    The wizard runs INSIDE the container, so we can't restart ourselves —
    the operator has to bounce the stack from the host. The build flag is
    only needed when overlays *changed*; otherwise the existing image is
    fine.
    """
    if overlays_changed:
        ui.info(
            "Overlays changed. From the host, apply them with:\n"
            "  docker compose down\n"
            "  docker compose up -d --build"
        )
