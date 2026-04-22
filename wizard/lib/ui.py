"""Minimal terminal UI helpers — prompts, colors, status lines.

Intentionally stdlib-only. No click/rich/prompt_toolkit.
"""

from __future__ import annotations

import os
import sys

_USE_COLOR = sys.stdout.isatty() and os.environ.get("NO_COLOR") is None

_CSI = {
    "reset": "\033[0m",
    "bold": "\033[1m",
    "dim": "\033[2m",
    "red": "\033[31m",
    "green": "\033[32m",
    "yellow": "\033[33m",
    "cyan": "\033[36m",
}


def _color(code: str, text: str) -> str:
    if not _USE_COLOR:
        return text
    return f"{_CSI[code]}{text}{_CSI['reset']}"


def info(msg: str) -> None:
    print(_color("cyan", "▸ ") + msg)


def success(msg: str) -> None:
    print(_color("green", "✓ ") + msg)


def warn(msg: str) -> None:
    print(_color("yellow", "! ") + msg)


def error(msg: str) -> None:
    print(_color("red", "✗ ") + msg, file=sys.stderr)


def header(msg: str) -> None:
    bar = "─" * max(10, len(msg) + 4)
    print()
    print(_color("bold", bar))
    print(_color("bold", f"  {msg}"))
    print(_color("bold", bar))


def prompt(label: str, default: str | None = None, secret: bool = False) -> str:
    """Read a value from the user. Returns `default` if they press enter."""
    default_hint = f" [{default}]" if default else ""
    while True:
        suffix = f"{label}{default_hint}: "
        if secret:
            import getpass
            raw = getpass.getpass(suffix)
        else:
            raw = input(suffix)
        value = raw.strip() or (default or "")
        if value:
            return value
        warn("Value is required.")


def confirm(label: str, default: bool = True) -> bool:
    default_hint = "Y/n" if default else "y/N"
    while True:
        ans = input(f"{label} [{default_hint}]: ").strip().lower()
        if ans == "":
            return default
        if ans in ("y", "yes"):
            return True
        if ans in ("n", "no"):
            return False
        warn("Please answer y or n.")
