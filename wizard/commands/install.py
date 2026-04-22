"""`gt-wizard install` — create or re-sync the Gas Town HQ at /gastown.

Thin wrapper around `gt install /gastown --force --name gastown`. Idempotent:
`--force` re-runs in an existing HQ without clobbering `town.json` or
`rigs.json`, so this is safe to call on every container boot.

This primitive exists so the entrypoint, the `/install-gastown` skill, and the
`gt-wizard start` flow can all converge on one place that knows how to bring
up the workspace. Before this existed, `gt-wizard verify` was happily passing
on containers where the HQ had never been created — and therefore `gt mail
send mayor/` fell over with "not in a Gas Town workspace".
"""

from __future__ import annotations

import argparse
import os
import subprocess
from pathlib import Path

from lib import ui

NAME = "install"
HELP = "Create the Gas Town HQ at /gastown (idempotent)."


def register(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "--path",
        default=os.environ.get("GASTOWN_HOME", "/gastown"),
        help="HQ path (default: $GASTOWN_HOME or /gastown).",
    )
    parser.add_argument(
        "--name",
        default="gastown",
        help="Town name passed to `gt install --name` (default: gastown).",
    )
    parser.add_argument(
        "--dolt-port",
        default=os.environ.get("DOLT_PORT", "3307"),
        help="Dolt port passed through to `gt install --dolt-port`.",
    )


def run(args: argparse.Namespace) -> int:
    ui.header("Install HQ")

    hq = Path(args.path)
    claude_md = hq / "CLAUDE.md"

    if claude_md.is_file():
        ui.info(f"HQ already present at {hq} — re-running with --force to refresh.")
    else:
        ui.info(f"No HQ at {hq} yet — creating one.")

    cmd = [
        "gt", "install", str(hq),
        "--force",
        "--name", args.name,
        "--dolt-port", str(args.dolt_port),
    ]
    ui.info("Running: " + " ".join(cmd))

    try:
        proc = subprocess.run(cmd, check=False)
    except FileNotFoundError:
        ui.error("`gt` is not on PATH — is this running inside the starter-kit container?")
        return 1

    if proc.returncode != 0:
        ui.error(f"`gt install` exited with code {proc.returncode}.")
        return proc.returncode

    if not claude_md.is_file():
        ui.error(
            f"`gt install` succeeded but {claude_md} is still missing. "
            "Something is very wrong — check the output above."
        )
        return 1

    ui.success(f"HQ ready at {hq}.")
    return 0
