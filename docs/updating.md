# Updating the starter kit

Fernando ships new tools, wizard improvements, and occasional fixes on `main`. The goal is that a `git pull` + rebuild picks them up without you losing any of your work — rigs, beads, Claude config, `.env`, and bot state all live on named Docker volumes.

## The happy path

```bash
cd <your-gastown-starter-clone>
git pull --rebase
docker compose build
docker compose up -d
docker compose exec gastown gt-wizard verify
```

The verifier will tell you if something regressed. If it says `All checks passed.`, you're done — your Mayor / TeleTalk / Crow processes restart automatically because the container restart propagated to them.

## Back up Dolt before risky updates

The data plane for beads, mail, and identity lives in Dolt. It's the single most important piece of state in your Gas Town install, and it's on a named volume (`gastown-dolt-data`). Back it up before updates that touch the data plane (watch the release notes / changelog).

```bash
docker compose exec gastown \
    dolt sql -q "CALL DOLT_BACKUP('add', 'pre-update', 'file:///gastown/.dolt-backups/pre-update-$(date +%Y%m%d-%H%M)')"
```

To restore:

```bash
docker compose exec gastown \
    dolt sql -q "CALL DOLT_BACKUP('restore', 'file:///gastown/.dolt-backups/pre-update-<timestamp>', 'hq')"
```

(Replace `hq` with the specific database name you want to restore.)

Because the starter kit is single-container, **restarting Dolt means restarting everything**. Plan backup/restore during a quiet moment — Mayor won't dispatch work while the stack is down.

## What's preserved across rebuilds

| Volume | Contains |
| --- | --- |
| `gastown-dolt-data` | All beads DBs, mail, identity history |
| `gastown-repos` | Cloned rig repos (your code) |
| `gastown-logs` | Mayor / TeleTalk / Crow logs (rotated) |
| Host `~/.claude` (bind-mount) | Your Claude auth and session history |
| Host `./.env` (bind-mount) | Telegram tokens, config |

What *doesn't* survive a rebuild: anything written directly into `/gastown/` outside the mounted paths above. If you find yourself putting state there, move it into a volume first.

## Rolling back

If an update broke something you can't quickly fix:

```bash
# See recent starter-kit versions.
git log --oneline -20

# Go back to the previous working SHA.
git checkout <sha>
docker compose build
docker compose up -d
```

Your data survives. The container just runs an older image.

## Changing pinned tool versions

Tool pins live in the `ARG` block at the top of `Dockerfile`. Bump them there, commit, and `docker compose build`. Example:

```Dockerfile
ARG DOLT_VERSION=1.86.1  # -> 1.87.0 when a new release is tested
ARG BD_VERSION=1.0.2     # -> 1.0.3
```

Do not bump multiple pins in a single commit without testing — if something breaks, you want to know which version caused it.

## When the starter kit itself moves

If Fernando tags a new "major" starter kit release (e.g. v1 → v2) with breaking changes, a migration note in the release body will tell you what manual steps are required. The defaults favor "no manual steps" — if you see one, it's exceptional.
