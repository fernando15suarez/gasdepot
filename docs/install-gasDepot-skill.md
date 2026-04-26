# The install-gasDepot skill

The `/install-gasDepot` slash-command is a [Claude Code skill](https://docs.claude.com/en/docs/claude-code/skills). The source lives at [`skills/install-gasDepot/SKILL.md`](../skills/install-gasDepot/SKILL.md) at the root of this repo.

## Why a plain path (not `.claude/skills/`) in the repo

This starter kit is authored inside a Gas Town polecat worktree. That worktree has a local `.gitignore` rule for `.claude/`, and Claude Code's `--dangerously-skip-permissions` mode has a hardcoded exception that blocks automated writes under `.claude/skills/` — so the polecat building this kit cannot commit files at the canonical skill path. Storing the skill at `skills/install-gasDepot/SKILL.md` sidesteps both issues and keeps the source editable.

## How it reaches the user's Claude Code session

There are two places a Claude Code session will look for the `install-gasDepot` skill:

1. **Inside the container** — the `Dockerfile` copies `skills/install-gasDepot/SKILL.md` into `/gastown/.claude/skills/install-gasDepot/SKILL.md` during the build. If the user runs `claude` *inside* the container (via `docker compose exec gastown claude`), they'll see `/install-gasDepot` in their skill list.

2. **On the user's host** — the `entrypoint.sh` mirrors the same file into `~/.claude/skills/install-gasDepot/SKILL.md` on the host (via the mounted Claude config volume) the first time the container starts. This is what lets users run `/install-gasDepot` from their host Claude Code session in the cloned repo directory.

## Editing the skill

Edit `skills/install-gasDepot/SKILL.md` directly. After changing it, either rebuild the image (`docker compose build`) or re-run the entrypoint's first-run sync (delete `~/.claude/skills/install-gasDepot/.gastown-synced` and re-up the container).

## Testing the skill manually

If you've made local edits and want to test before committing:

```bash
# Copy the edited skill into your host Claude config.
mkdir -p ~/.claude/skills/install-gasDepot
cp skills/install-gasDepot/SKILL.md ~/.claude/skills/install-gasDepot/SKILL.md

# Then invoke it in Claude Code:
claude
# (inside Claude Code)
# > /install-gasDepot
```
