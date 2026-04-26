# Default Mayor memories

`mayor-default-memories.json` at the repo root holds a small set of behaviors gasDepot seeds into Mayor's memory store on first init. The wizard reads this file at the end of `gt-wizard start` (right after Mayor's tmux session comes up) and runs `gt remember --key "<key>" "<body>"` for each entry.

The current seeds:

- **`polecat-first`** — when to push implementation work to a polecat vs. handle it inline in Mayor.
- **`ack-every-telegram-message`** — Mayor must immediately ack inbound Telegram messages via the gt-bot HTTP endpoint before doing tool work.

## How the seed runs

- **One-shot.** A sentinel file at `<HQ>/.gasdepot-memories-seeded` records that the seed has run. Subsequent `gt-wizard start` calls skip seeding so we don't spam Mayor's memory file on every container restart.
- **Idempotent.** `gt remember --key X "..."` overwrites the value at `X` rather than duplicating it, so even if the sentinel is removed and the seed re-runs, Mayor's memory file stays clean.
- **Non-fatal.** If a single `gt remember` call fails, the wizard logs a warning and continues. If `gt` isn't on PATH (e.g. running outside the container), the seed step is skipped with a hint and the rest of `start` proceeds normally.

## Editing the seeds

Add or remove entries in `mayor-default-memories.json`:

```json
{
  "memories": [
    { "key": "<short-slug>", "body": "<one-paragraph behavior guidance>" }
  ]
}
```

Keep entries to high-level *behavior* — when to do what, how to talk to the operator, what tools to reach for first. Don't fold per-user secrets, environment-specific paths, or rules already covered by `CLAUDE.md` into the seed file.

To re-seed after editing, delete the sentinel and re-run `gt-wizard start`:

```bash
docker compose exec gastown rm /gastown/repos/hq/.gasdepot-memories-seeded
docker compose exec gastown gt-wizard start
```

## Adding ad-hoc memories

You don't need to touch the seed file to give Mayor more context. Any time, from inside the container:

```bash
docker compose exec gastown gt remember --key my-rule "<body>"
```

Mayor picks up the new memory on its next prompt cycle. Use this for evolving behaviors that aren't yet stable enough to live in the default seed file.
