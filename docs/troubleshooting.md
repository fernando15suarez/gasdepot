# Troubleshooting

Things that tend to go wrong with the starter kit, in rough order of "most common first". When in doubt, run `docker compose exec gastown gt-wizard verify` first — its output names the fix for the problems it can detect.

## Install-time

### `docker compose build` fails at "cloning upstream TeleTalk/Crow"

The build clones `https://github.com/fernando15suarez/teletalk.git` and `https://github.com/fernando15suarez/crow.git`. If your host has no network, or corporate DNS blocks GitHub, the build bombs here.

**Fix:** check your network, then retry. If you're behind a proxy, pass it through: `docker compose build --build-arg HTTP_PROXY=... --build-arg HTTPS_PROXY=...`.

### "`claude login` doesn't carry into the container"

Happens when:
- You ran `claude login` *after* starting the container — the bind-mount was empty at start.
- Your host `~/.claude` is owned by a uid other than 1000.

**Fix:** stop the container (`docker compose down`), confirm `ls -la ~/.claude` shows content owned by you, then `docker compose up -d`.

### "wizard refused to write `.env`"

The wizard only writes `.env` when one doesn't already exist, or when you explicitly re-run a primitive (e.g. `setup-telegram` with "replace existing?" confirmed). If it says "Value is required." and exits, you probably hit Ctrl-C on a prompt.

**Fix:** re-run `docker compose exec gastown gt-wizard init` and answer all prompts.

## Runtime

### TeleTalk bot doesn't respond to my DM

Most common causes:
1. `OPERATOR_TELEGRAM_CHAT_ID` is wrong. Message `@userinfobot` on Telegram — that's the *user* ID you should paste, not the bot's ID.
2. The TeleTalk process is not actually running. Inside the container: `pgrep -af teletalk` should show the process. If not, re-run the command from `gt-wizard start`.
3. The bot token was rotated on the Telegram side but not in `.env`. Re-run `gt-wizard setup-telegram`.

### Mayor sends "dispatching..." but no polecat ever appears

Mayor and Dolt are both up, but Claude Code sessions aren't spawning. Likely causes:
- Claude auth is broken (subscription expired, `claude login` token expired).
- The `claude` binary inside the container can't find its config.

**Diagnose:**

```bash
docker compose exec gastown bash -c 'claude --print "say hello"'
```

If that fails, your Claude auth is the problem. Re-run `claude login` on the host and restart the container.

### `gt dolt status` shows high latency or "orphan count" > 0

The host-level gt docs (`/home/nando/gt/CLAUDE.md`) cover this — it's identical inside the container.

```bash
docker compose exec gastown gt dolt status
docker compose exec gastown gt dolt cleanup
```

Do **not** `rm -rf /gastown/.dolt-data` — always use `gt dolt cleanup`.

### Dolt hangs / "connection refused"

**Before restarting Dolt, collect diagnostics.** Dolt hangs are hard to reproduce and a blind restart destroys evidence.

```bash
# 1. Capture goroutine dump (safe — does not kill the process)
docker compose exec gastown bash -c 'kill -QUIT $(cat /gastown/logs/dolt.pid)'

# 2. Capture status while it's still misbehaving
docker compose exec gastown gt dolt status 2>&1 > /tmp/dolt-hang.log

# 3. File a bead with the log attached
bd q "dolt hang: $(date) — see /tmp/dolt-hang.log"

# 4. Only THEN restart.
docker compose restart gastown
```

### `bd` errors with "migration 0028 failed" / `gt patrol new` blocked

Upstream bug in `bd`: migration 28's `DOLT_COMMIT` returns *nothing to commit*
on a freshly-created rig DB, and `bd` treats that as a hard failure. Upstream
fix is on the beads `main` branch (PR #3365) but not in any tagged release
yet, so `bd 1.0.2` and earlier all hit it.

**Workaround.** Pre-seed `schema_migrations` for versions 28–32 so `bd` thinks
they already ran. Safe and idempotent — if the rows already exist the INSERT
errors out and the DB is untouched. From the host (or `docker compose exec
gastown bash`):

```bash
DBNAME=<rig-db-name>   # e.g. portfolio, mp, hq, racecadence, beads, ...
dolt --host 127.0.0.1 --port 3307 --user root --password "" --no-tls \
     --use-db "$DBNAME" sql -q "
  SET @@autocommit=0;
  INSERT INTO schema_migrations (version, applied_at) VALUES
    (28, NOW()), (29, NOW()), (30, NOW()), (31, NOW()), (32, NOW());
  CALL DOLT_ADD('schema_migrations');
  CALL DOLT_COMMIT('-m', 'mark migrations 28-32');
"
```

Then re-run `bd status` (should be clean) and retry whatever command was
blocked (`gt patrol new`, `gt rig add`, etc.). If you run `gt rig add` on
multiple rigs, apply the workaround to each rig's DB.

**Scope check:** `SELECT MAX(version) FROM schema_migrations` per rig DB.
Values below 28 mean you need the workaround; 28+ means you don't. The
`beads_global` DB uses a different migrator — 27 there is fine.

### `gt mail send` fails with "failed to deliver" right after `gt rig add`

Related to the previous entry, but a different blast radius. After
`gt rig add <newrig>`, gt registers a route in
`/gastown/repos/hq/.beads/routes.jsonl` (e.g. `{"prefix":"ra-","path":"racecadence/mayor/rig"}`)
pointing at the new rig's beads. `gt mail` appears to consult every route
during dispatch — so if the new rig's DB is still broken on migration 28
(or otherwise unopenable), even unrelated `gt mail send mayor/` calls
fail with `failed to initialize schema: migration 0028_local_state_dolt_ignore.up.sql failed`.

You'll see it most often as the gt-bot Telegram bridge replying
"Failed to deliver message to Gas Town."

**Two ways to clear it:**

1. *Repair the rig DB* (preferred — see the migration-28 entry above).
   Once `bd status` works in the rig, the route stops being a poison pill.

2. *Temporarily remove the route* if you don't need to address mail to
   that rig yet:

   ```bash
   sed -i.bak '/"prefix":"ra-"/d' /gastown/repos/hq/.beads/routes.jsonl
   ```

   Replace `ra-` with whichever prefix the new rig got. Restore from
   `routes.jsonl.bak` once the rig DB is repaired.

Tracked upstream as a `gt`-side bug: mail routing should tolerate a
failing rig (log a warning, not abort the whole send).

## "I want to throw it all away and start over"

```bash
docker compose down
docker volume rm gastown-dolt-data gastown-repos gastown-logs
rm .env
docker compose build --no-cache
docker compose up -d
docker compose exec gastown gt-wizard init
```

This wipes all beads, rig repos, mail, and identity history. Your host `~/.claude` is untouched.

## Reporting a new issue

This repo has its own beads DB. Inside the container:

```bash
bd q "Short description of what went wrong"
```

Or open a GitHub issue on the starter-kit repo if you'd rather use GitHub. Include:
- Output of `docker compose exec gastown gt-wizard verify`.
- Output of `docker compose exec gastown gt doctor`.
- Relevant lines from `docker compose logs gastown --tail 200`.
