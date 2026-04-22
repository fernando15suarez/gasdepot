"""`gt-wizard update` — guide the user through a safe update cycle.

We don't actually execute `docker compose build` from inside the container —
that would require Docker-in-Docker. Instead we print the host-side commands
and call out the one thing people forget: dump Dolt before rebuilding if a
recent change touches the data plane.
"""

from __future__ import annotations

import argparse

from lib import ui

NAME = "update"
HELP = "Print a safe host-side update procedure, including Dolt backup."


def register(parser: argparse.ArgumentParser) -> None:  # noqa: ARG001
    pass


def run(_args: argparse.Namespace) -> int:
    ui.header("Updating the starter kit")

    ui.info(
        "Run these on the host, not in the container. The commands assume "
        "you're sitting in the cloned starter-kit repo."
    )

    print(
        """
    # 1. Back up Dolt before a potentially risky update.
    docker compose exec gastown \\
        dolt sql -q "CALL DOLT_BACKUP('add', 'pre-update', 'file://.dolt-backups/pre-update')"

    # 2. Pull the latest starter-kit changes.
    git pull --rebase

    # 3. Rebuild. Named volumes (dolt-data, repos, logs, claude) are preserved.
    docker compose build
    docker compose up -d

    # 4. Verify the stack came back up cleanly.
    docker compose exec gastown gt-wizard verify
    """
    )

    ui.info(
        "If something regressed, roll back with `git checkout <prev-sha>` and "
        "`docker compose build && docker compose up -d`. Your data survives."
    )
    return 0
