"""`gt-wizard start` — launch Mayor, TeleTalk, and Crow.

v0 strategy: rather than fork/exec these processes ourselves (they each have
their own lifecycle and logging expectations), we print the exact commands
the user (or the Claude skill) should run in separate shells. This keeps the
wizard understandable and avoids half-baked process supervision.

Follow-ups in hq-1xb track moving to a proper supervisor (`supervisord`,
`systemd`, or a small Python orchestrator) once the primitives are stable.
"""

from __future__ import annotations

import argparse

from lib import ui

NAME = "start"
HELP = "Print the commands to launch Mayor, TeleTalk, and Crow."


def register(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "--target",
        choices=["all", "mayor", "teletalk", "crow"],
        default="all",
        help="Which agent to print launch instructions for.",
    )


def run(args: argparse.Namespace) -> int:
    ui.header("Launching Gas Town")

    ui.info(
        "Each agent runs as a Claude Code session driven by `gt`. Open a "
        "separate tmux pane / terminal for each, or use `gt sling` to have "
        "Mayor spawn them."
    )

    if args.target in ("all", "mayor"):
        _print_mayor()
    if args.target in ("all", "teletalk"):
        _print_teletalk()
    if args.target in ("all", "crow"):
        _print_crow()

    ui.header("After Mayor is up")
    ui.info(
        "Send Mayor its first instruction over TeleTalk — for example, "
        '`"create a new rig called hello and file a bead to say hi"`. Mayor '
        "will route the work to a fresh polecat and you should see it land in "
        "the beads feed on the host."
    )

    return 0


def _print_mayor() -> None:
    ui.header("Mayor")
    print(
        """
    # In a dedicated shell inside the container:
    gt sling mayor
    """
    )


def _print_teletalk() -> None:
    ui.header("TeleTalk")
    print(
        """
    # Vendored source lives at /opt/teletalk. The wizard writes its .env
    # automatically — see `gt-wizard setup-telegram` to rotate tokens.
    cd /opt/teletalk
    pnpm install --frozen-lockfile  # first run only
    pnpm start
    """
    )


def _print_crow() -> None:
    ui.header("Crow")
    print(
        """
    # Vendored source lives at /opt/crow. Similar shape to TeleTalk.
    cd /opt/crow
    pnpm install --frozen-lockfile  # first run only
    pnpm start
    """
    )
