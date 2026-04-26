"""`gt-wizard start` — install the HQ (if needed) and launch Mayor + Deacon.

Previously this command only *printed* commands for the user to run in three
shells. After end-user testing we learned that was too easy to miss: the
skill would declare success while Mayor was never actually started. Now we
actually run `gt install` and `gt start` on the user's behalf, then wait for
the Mayor tmux session to come up before returning.

TeleTalk and Crow, when enabled, still run as separate containers / processes
(see docs/first-rig.md). This command only owns the in-container Mayor +
Deacon startup path.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import time
from pathlib import Path

from lib import ui

from . import install as cmd_install

NAME = "start"
HELP = "Install the HQ if missing, then launch Deacon + Mayor."

MAYOR_SESSION = "hq-mayor"
MAYOR_WAIT_SECONDS = 30

# Repo root holds the seed file; wizard lives one level down.
_REPO_ROOT = Path(__file__).resolve().parents[2]
MEMORY_SEED_FILE = _REPO_ROOT / "mayor-default-memories.json"
MEMORY_SEED_SENTINEL = ".gasdepot-memories-seeded"


def _default_hq_path() -> str:
    explicit = os.environ.get("GT_TOWN_ROOT")
    if explicit:
        return explicit
    home = os.environ.get("GASTOWN_HOME", "/gastown")
    return str(Path(home) / "repos" / "hq")


def register(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "--path",
        default=_default_hq_path(),
        help="HQ path (default: $GT_TOWN_ROOT, else $GASTOWN_HOME/repos/hq).",
    )
    parser.add_argument(
        "--all",
        action="store_true",
        help="Pass --all to `gt start` (also starts Witnesses + Refineries).",
    )


def run(args: argparse.Namespace) -> int:
    ui.header("Starting Gas Town")

    hq = Path(args.path)
    claude_md = hq / "CLAUDE.md"

    if not claude_md.is_file():
        ui.info(f"No HQ at {hq} — running `gt-wizard install` first.")
        install_args = argparse.Namespace(
            path=str(hq),
            name="gastown",
            dolt_port=os.environ.get("DOLT_PORT", "3307"),
        )
        rc = cmd_install.run(install_args)
        if rc != 0:
            ui.error("HQ install failed — cannot start Mayor.")
            return rc
    else:
        ui.success(f"HQ detected at {hq}.")

    cmd = ["gt", "start"]
    if args.all:
        cmd.append("--all")

    ui.info(f"Running (cwd={hq}): " + " ".join(cmd))
    try:
        proc = subprocess.run(cmd, cwd=str(hq), check=False)
    except FileNotFoundError:
        ui.error("`gt` is not on PATH.")
        return 1

    if proc.returncode != 0:
        ui.error(f"`gt start` exited with code {proc.returncode}.")
        return proc.returncode

    if not _wait_for_mayor(MAYOR_WAIT_SECONDS):
        ui.warn(
            f"Mayor tmux session `{MAYOR_SESSION}` did not appear within "
            f"{MAYOR_WAIT_SECONDS}s. Check `gt agents list` and "
            f"`docker compose logs gastown`."
        )
        return 1

    ui.success(f"Mayor is up (tmux session `{MAYOR_SESSION}`).")

    _seed_default_memories(hq)

    ui.header("Next steps")
    ui.info("• `docker compose exec gastown gt agents` — list live agent sessions.")
    ui.info("• `docker compose exec gastown gt-wizard verify` — end-to-end health check.")
    ui.info("• DM gt-bot on Telegram with `hello mayor` — confirm the round trip.")
    ui.info("• `docker compose exec gastown bash` — drop into a shell inside the HQ.")
    return 0


def _seed_default_memories(hq: Path) -> None:
    """Seed Mayor's memory store from `mayor-default-memories.json` once.

    One-shot at first init: a sentinel under the HQ records that we've run.
    Failures of individual `gt remember` calls are logged and skipped — we
    never fail the wizard for memory seeding.
    """
    sentinel = hq / MEMORY_SEED_SENTINEL
    if sentinel.exists():
        return

    if not MEMORY_SEED_FILE.is_file():
        ui.info(f"No memory seed file at {MEMORY_SEED_FILE} — skipping default memories.")
        return

    if shutil.which("gt") is None:
        ui.warn(
            "`gt` not on PATH — skipping default-memory seed. "
            f"Run later via: gt remember --key <k> \"<body>\" (entries in {MEMORY_SEED_FILE.name})."
        )
        return

    try:
        data = json.loads(MEMORY_SEED_FILE.read_text())
        entries = data.get("memories", [])
    except (OSError, json.JSONDecodeError) as exc:
        ui.warn(f"Could not read {MEMORY_SEED_FILE}: {exc} — skipping default memories.")
        return

    seeded = 0
    for entry in entries:
        key = entry.get("key")
        body = entry.get("body")
        if not key or not body:
            ui.warn(f"Skipping malformed memory entry: {entry!r}")
            continue
        try:
            proc = subprocess.run(
                ["gt", "remember", "--key", key, body],
                cwd=str(hq),
                capture_output=True,
                text=True,
                check=False,
            )
        except OSError as exc:
            ui.warn(f"`gt remember --key {key}` failed: {exc}")
            continue
        if proc.returncode != 0:
            ui.warn(
                f"`gt remember --key {key}` exited {proc.returncode}: "
                f"{(proc.stderr or proc.stdout).strip()}"
            )
            continue
        ui.info(f"seeded memory: {key}")
        seeded += 1

    # Only stamp the sentinel if at least one seed succeeded — otherwise we
    # want a future run to retry (e.g. `gt` came online after this attempt).
    if seeded:
        try:
            sentinel.touch()
        except OSError as exc:
            ui.warn(f"Could not write {sentinel}: {exc} — memories may reseed next run.")


def _wait_for_mayor(timeout: int) -> bool:
    """Poll `tmux has-session -t hq-mayor` until it succeeds or we time out."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            rc = subprocess.run(
                ["tmux", "has-session", "-t", MAYOR_SESSION],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                check=False,
            ).returncode
        except FileNotFoundError:
            # No tmux — fall back to asking gt.
            try:
                out = subprocess.run(
                    ["gt", "mayor", "status", "--running"],
                    capture_output=True, text=True, check=False,
                )
                if out.stdout.strip().lower() == "true":
                    return True
            except FileNotFoundError:
                return False
        else:
            if rc == 0:
                return True
        time.sleep(1)
    return False
