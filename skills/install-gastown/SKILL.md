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

### 2. Ask the user for a BotFather token

This is one of the few places you stop for the user.

Say something like: *"Open Telegram, message @BotFather, run `/newbot`, pick a name, and paste the token it hands back. Format is `digits:letters-and-dashes`."*

When they paste it, validate it matches `^\d{6,}:[A-Za-z0-9_-]{20,}$`. If not, ask for it again.

Write it to `.env` in place:
```bash
sed -i 's|^GT_BOT_TOKEN=.*|GT_BOT_TOKEN='"$TOKEN"'|' .env
```
(or append if the key is missing). Do NOT paste the token into the user's terminal unmasked — pass it via an environment variable in your bash command.

**Operator chat id is auto-detected** — the entrypoint polls Telegram's `getUpdates` on first boot and fills `OPERATOR_TELEGRAM_CHAT_ID` the first time the user messages the bot. You do not need to ask for it.

### 3. Build the image

Run `docker compose build`. This takes 3–8 minutes on a first build; show the user the progress stream. If the build fails, read the tail of the output and tell the user what broke — do not barrel on to the next step.

### 4. Bring up the stack

Run `docker compose up -d`. The default CMD is `daemon`, so this starts Dolt → auto-detects operator chat id → installs the HQ → starts gt-bot → launches Deacon + Mayor. No extra shells required.

### 5. Tail the startup logs until gt-bot is waiting

Run `docker compose logs -f gastown` in the foreground and watch for the line:

> `Auto-detecting operator chat id — open Telegram and message your bot within 90s.`

As soon as you see it, break out of `logs -f` (`Ctrl+C` inside the tool) and tell the user:

> "The bot is listening. Open Telegram, find the bot you just created, and send it any message (for example: `hello mayor`)."

Then re-attach to logs and watch for `Detected operator chat id: <id>. Writing to .env.` — that confirms their message was captured.

If the 90s window expires before the user messages the bot (you'll see the "No message received within 90s" warning), ask the user to message the bot, then run `docker compose restart gastown` and repeat step 5.

### 6. Wait for Mayor to come up

Still watching the logs, look for `Mayor is up (tmux session 'hq-mayor')`. That takes another 10–20 seconds after the HQ install.

### 7. Verify

Run `docker compose exec gastown gt-wizard verify`. Read each ✓ and ✗ aloud. All REQUIRED checks must be green — including HQ present, Mayor session, and the end-to-end `gt mail send` round-trip. If anything is red, do not declare success. Investigate it.

### 8. End-to-end confirmation

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
- **"Dolt port 3307 in use"** — the host has Gas Town already running. Try `gt dolt stop` on the host. If that is unacceptable (the host Gas Town must stay up), edit `DOLT_PORT` in `.env` and the published port in `docker-compose.yml`, then rebuild.
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
