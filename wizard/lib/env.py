"""Read / write the starter-kit `.env` file.

The format is `KEY=VALUE`, one per line, with `#` line-comments preserved on
round-trip. We do not use python-dotenv because the wizard must run in a slim
container image with no pip wheels — only stdlib.
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass
from pathlib import Path

ENV_PATH = Path(os.environ.get("GASTOWN_HOME", "/gastown")) / ".env"
ENV_EXAMPLE_PATH = Path(os.environ.get("GASTOWN_HOME", "/gastown")) / ".env.example"

_ASSIGN_RE = re.compile(r"^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$")


@dataclass
class EnvFile:
    """A `.env` file preserved as a list of lines so comments survive edits."""

    path: Path
    lines: list[str]

    @classmethod
    def load(cls, path: Path | None = None) -> "EnvFile":
        p = path or ENV_PATH
        if not p.exists():
            # Seed from the example so comments are present on first edit.
            if ENV_EXAMPLE_PATH.exists():
                p.write_text(ENV_EXAMPLE_PATH.read_text())
            else:
                p.write_text("")
        return cls(path=p, lines=p.read_text().splitlines())

    def get(self, key: str) -> str | None:
        for line in self.lines:
            m = _ASSIGN_RE.match(line)
            if m and m.group(1) == key:
                return _unquote(m.group(2).strip())
        return None

    def set(self, key: str, value: str) -> None:
        """Replace an existing KEY= line, or append one if missing."""
        value_literal = _quote_if_needed(value)
        for i, line in enumerate(self.lines):
            m = _ASSIGN_RE.match(line)
            if m and m.group(1) == key:
                self.lines[i] = f"{key}={value_literal}"
                return
        self.lines.append(f"{key}={value_literal}")

    def save(self) -> None:
        text = "\n".join(self.lines)
        if not text.endswith("\n"):
            text += "\n"
        self.path.write_text(text)


def _quote_if_needed(value: str) -> str:
    if value == "":
        return ""
    if any(c.isspace() for c in value) or any(c in value for c in '"#\\'):
        escaped = value.replace("\\", "\\\\").replace('"', '\\"')
        return f'"{escaped}"'
    return value


def _unquote(raw: str) -> str:
    raw = raw.strip()
    if len(raw) >= 2 and raw[0] == raw[-1] and raw[0] in ('"', "'"):
        inner = raw[1:-1]
        if raw[0] == '"':
            return inner.replace('\\"', '"').replace("\\\\", "\\")
        return inner
    return raw
