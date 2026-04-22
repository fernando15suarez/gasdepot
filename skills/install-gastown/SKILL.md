---
name: install-gastown
description: Autonomous installer for the Gas Town starter kit. Use this skill when the user has just cloned the starter-kit repo and wants to stand up Mayor with gt-bot (the default Telegram bridge). Runs the wizard and docker commands on the user's behalf; only pauses for inputs the user must supply (BotFather token, Telegram message to confirm the round-trip). Only runs in an environment where the user is sitting in the starter-kit repo.
---

# install-gastown

You are installing the Gas Town starter kit for the user. You are NOT a tutorial — do not print shell commands and wait for the user to type them. **Run them yourself via the Bash tool.** Only stop for the handful of inputs the user uniquely owns (pasting a BotFather token, confirming a Telegram round-trip).

Tone: short and task-oriented. Narrate what you are about to do in one sentence, run it, summarize the result. If something fails, diagnose and retry before surfacing the error to the user.

## Preflight (all silent unless something is wrong)

Run each check; stop with a clear remediation if any fails.

- Confirm you are in the starter-kit repo: `test -f Dockerfile && test -f docker-compose.yml && test -f wizard/gt-wizard`. If missing, tell the user to `cd` to their gasdepot clone.
- `docker --version` and `which claude` succeed. If Docker is missing, link the user to the prerequisites section of the top-level README.md — do not try to install Docker.
- `ls ~/.claude` has session files. If missing, tell the user to run `claude login` in another terminal and wait for them to come back.

## The flow

Do these in order. Do NOT ask the user to run any of these themselves.

### 1. Prepare `.env`

Run `cp -n .env.example .env` (no-clobber). Check whether `GT_BOT_TOKEN` is already set:
```bash
grep -E '^GT_BOT_TOKEN=.+' .env
```
If it is populated, skip to step 3.

### 2. Collect the BotFather token AND the operator chat id

Two user interactions here — the rest of step 2 you do yourself.

**2a. Token.** Say: *"Open Telegram, message @BotFather, run `/newbot`, pick a name, and paste the token it hands back. Format is `digits:letters-and-dashes`."*

When they paste it, validate against `^\d{6,}:[A-Za-z0-9_-]{20,}$`. If not, ask again.

Write it to `.env` — pass the token via an env var, NEVER echo it unmasked:
```bash
TOKEN='<token>' && \
  grep -q '^GT_BOT_TOKEN=' .env \
    && sed -i "s|^GT_BOT_TOKEN=.*|GT_BOT_TOKEN=${TOKEN}|" .env \
    || echo "GT_BOT_TOKEN=${TOKEN}" >> .env
```

**2b. Tell the user to message the bot.** Say: *"Now open Telegram, find the bot you just created (the username BotFather gave you), and send it ANY message — `hello` is fine. Let me know when you've sent it."*

Wait for the user to confirm (e.g. they say "sent", "done", "ok").

**2c. You pull their chat id from Telegram's getUpdates.** Run:
```bash
TOKEN=$(grep '^GT_BOT_TOKEN=' .env | cut -d= -f2-) && \
  curl -fsSL "https://api.telegram.org/bot${TOKEN}/getUpdates" \
    | jq -r '[.result[] | (.message, .edited_message, .channel_post)? | select(.!=null) | .chat.id] | last // empty'
```

That prints the chat id of the most recent message sent to the bot. If it's empty:
- Telegram's getUpdates window may have rolled over (updates expire after 24h or when a webhook is set). Have them send another message and re-run.
- If still empty after a second try, check that the token is valid: `curl -fsS "https://api.telegram.org/bot${TOKEN}/getMe"` should return `"ok":true`.

Once you have a numeric chat id (usually 8+ digits, may be negative for groups), write it to `.env`:
```bash
CHAT_ID='<id>' && \
  grep -q '^OPERATOR_TELEGRAM_CHAT_ID=' .env \
    && sed -i "s|^OPERATOR_TELEGRAM_CHAT_ID=.*|OPERATOR_TELEGRAM_CHAT_ID=${CHAT_ID}|" .env \
    || echo "OPERATOR_TELEGRAM_CHAT_ID=${CHAT_ID}" >> .env
```

Tell the user: *"Got it. Your operator chat id is `<id>`. Building the container now."*

### 3. Build the image

Run `docker compose build`. This takes 3–8 minutes on a first build; show the user the progress stream. If the build fails, read the tail of the output and tell the user what broke — do not barrel on to the next step.

### 4. Bring up the stack

Run `docker compose up -d`. Default CMD is `daemon`, which starts Dolt → configures Dolt identity → installs the HQ → starts gt-bot → launches Deacon + Mayor. `OPERATOR_TELEGRAM_CHAT_ID` is already in `.env` from step 2c, so the entrypoint seeds the bot's admin row on first boot.

### 5. Wait for Mayor to come up

Tail the logs and watch for the boot milestones. One easy way:
```bash
timeout 90 docker compose logs -f gastown | sed -n '/Mayor is up/q; p'
```
That exits as soon as the line `Mayor is up (tmux session 'hq-mayor')` shows (or after 90s). Total boot time is typically 30–60s after `up -d`.

If the 90s timeout expires without `Mayor is up`, pull the tail and explain what's wrong:
```bash
docker compose logs --tail=200 gastown
```
Look for errors from `ensure_hq`, `start_gt_bot`, or `start_mayor`. Common culprits: stale Dolt volume (nuke with `docker compose down -v` then rebuild), dolt identity not configured (should be handled by `ensure_dolt_identity`, but check), or port 3307 conflict on the host.

### 6. Verify

Run `docker compose exec gastown gt-wizard verify`. Read each ✓ and ✗ aloud. All REQUIRED checks must be green — including HQ present, Mayor session, and the end-to-end `gt mail send` round-trip. If anything is red, do not declare success. Investigate it.

### 7. End-to-end confirmation

This is the other place you stop for the user.

Tell them: *"Send one more message to the bot on Telegram now — Mayor should reply. Let me know what you see."*

If Mayor replies: install is complete. Give them the short "What now" list below.

If Mayor does NOT reply within ~30 seconds, do NOT declare success. Collect diagnostics:
- `docker compose exec gastown tail -n 100 /gastown/logs/gt-bot.log`
- `docker compose exec gastown tail -n 100 /gastown/logs/gt-start.log`
- `docker compose exec gastown gt agents`

Read them and explain what you see. Fix it or escalate.

## What now (post-install)

Once Mayor has round-tripped a message, share:

- **Send follow-ups on Telegram.** The bot forwards every authorized message to Mayor.
- **Inspect the state.** `docker compose exec gastown gt agents` lists live sessions. `docker compose exec gastown gt dolt status` shows the data plane.
- **Open a shell.** `docker compose exec gastown bash` drops into the container as the `gastown` user.
- **Next: build a rig.** Suggest "ask Mayor on Telegram to create a rig for <project>". No example rig is pre-scaffolded.

## Common snags (diagnose, do not delegate)

You handle these — do not ask the user to run the fix command.

- **"Docker cannot access ~/.claude"** — the volume mount is read-write but host perms block root-in-container. `ls -la ~/.claude`; if it is owner-restricted, `chmod -R u+rwx,g+rx ~/.claude`.
- **"Dolt port 3307 in use"** — the host has something bound to 3307. If Gas Town is running on the host, try `gt dolt stop`. If the bound process wasn't started by `gt dolt start` (e.g. a stray `dolt sql-server` daemon), `gt dolt stop` won't find it — use `pgrep -a dolt` to locate it and `kill <pid>` directly. If you need the host Dolt to stay up, edit `DOLT_PORT` in `.env` and the published port in `docker-compose.yml`, then rebuild.
- **"gt-bot refuses to start: no rows in gt_bot.permissions"** — the auto-detect didn't catch a message in the 90s window. `docker compose logs gastown | tail -30` will confirm. Restart the container and ask the user to DM the bot the moment you see the auto-detect prompt. Last resort: `docker compose exec gastown /gastown/bot/bin/gt-bot perms add <chat_id> --role admin`.
- **"`gt mail send` fails with 'not in a Gas Town workspace'"** — HQ missing. `docker compose exec gastown gt-wizard install` stamps it.
- **"bot receives messages but Mayor never responds"** — Mayor not up. `docker compose exec gastown gt-wizard start` and re-verify. If it still won't boot, read `/gastown/logs/gt-start.log`.
- **"`claude login` lost after rebuild"** — the ~/.claude bind mount was removed. Check `docker-compose.yml`.
- **"wizard says ANTHROPIC_API_KEY is better"** — it isn't, for Claude Pro / Max subscribers. Point them at `claude login`.

## Don't do for them

- Don't install Docker Engine, Claude Code, or system packages on the host. Those are prereqs the user owns.
- Don't edit `.env` by hand outside of `sed` replacements to a single key at a time.
- Don't run `docker compose down -v` unless the user explicitly asks — it nukes their beads DB.

## If stuck

Run `docker compose exec gastown gt-wizard verify` and read its output to the user verbatim. Each check names the fix. Then pull the relevant log tail. If that is not enough, point them at `docs/troubleshooting.md`.

## After install

Suggest: *"Ask Mayor, on Telegram, to create a small rig of your choice."* Point them at `docs/first-rig.md` for the deeper walkthrough.
