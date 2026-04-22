# Your first rig

A rig is a Gas Town workspace that groups related work together. After the starter kit install completes, you have **Mayor** running but no rigs yet — Mayor is ready to spawn one when you ask.

This guide walks you through creating a tiny rig (`notes`) end-to-end so you see the whole loop: Telegram → Mayor → bead → polecat → commit → merge.

## Prerequisites

- The [install flow](install-gastown-skill.md) completed successfully.
- `docker compose exec gastown gt-wizard verify` prints `All checks passed.`.
- TeleTalk and Crow bots are running (the `gt-wizard start` output showed you how).
- You've DM'd the TeleTalk bot from the Telegram account whose chat ID is in `.env` under `OPERATOR_TELEGRAM_CHAT_ID`.

## Ask Mayor to create it

DM the TeleTalk bot:

> Hey Mayor, create a new rig called `notes`. Its job is to be a scratch space for markdown notes. File a bead to add a `hello.md` with the text "hello world" and dispatch it to a polecat.

Mayor will:

1. Register `notes` in the gt rig registry (`rigs.json`).
2. Create an empty `notes` git repo under `/gastown/repos/notes`.
3. Open a bead in the `notes` beads DB describing the `hello.md` task.
4. Sling the bead to a fresh polecat worktree (Claude Code session).

Crow will DM you status updates as each step completes. This usually takes a minute or two.

## Watch the polecat work

The polecat session shows up in `gt agents` inside the container:

```bash
docker compose exec gastown gt agents
```

You'll see a session named something like `notes/polecats/<name>`. You can tail its activity with:

```bash
docker compose exec gastown gt feed --rig notes
```

The polecat clones `notes`, creates a branch, writes `hello.md`, commits, and runs `gt done` to submit to the merge queue. Mayor picks up the merge signal and Crow tells you it landed.

## Verify in git

Back on the host, the notes repo lives in the named Docker volume. Pop in to look at it:

```bash
docker compose exec gastown bash -c 'cd /gastown/repos/notes && git log --oneline'
```

You should see the polecat's commit on `main` with a sensible message.

## Iterate

Now you have a rig you own. Good next asks for Mayor:

- "Add a bead to `notes` for setting up a daily journal template."
- "Spawn two polecats in parallel — one for a `recipes.md` file, one for `books.md`."
- "Switch `notes` to track issues with a different bead prefix."

## What to do if it got stuck

- No response from Mayor after 2+ minutes → check `docker compose logs gastown | tail -100`. Mayor logs its deliberations; the issue is usually a Telegram allow-list mismatch or a malformed `OPERATOR_TELEGRAM_CHAT_ID`.
- Bead was filed but no polecat spawned → Mayor may have slung the work but the polecat's container process failed to start. `gt orphans` lists lost polecat work and lets you re-dispatch.
- Polecat committed locally but nothing landed on `main` → the merge queue (Refinery) isn't running in the starter kit MVP; commits go to `main` directly on `gt done`. If you don't see them, check `gt trail` for the polecat's recent activity.

See [`troubleshooting.md`](troubleshooting.md) for the wider set of known issues.
