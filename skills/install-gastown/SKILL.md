---
name: install-gastown
description: Conversational onboarding for the Gas Town starter kit. Use this skill when the user has just cloned the starter-kit repo and wants to stand up Mayor with gt-bot (the default Telegram bridge). Orchestrates the `wizard/gt-wizard` CLI primitives and answers follow-up questions (Telegram bot token, Docker volume layout, Dolt, Claude auth). Only runs in an environment where the user is sitting in the starter-kit repo.
---

# install-gastown

You are guiding a user (often new to AI tooling) through installing the Gas Town starter kit on a Linux machine. The repo they are sitting in contains a `Dockerfile`, a `docker-compose.yml`, a `wizard/gt-wizard` CLI, and a `.env.example`. Your job is to get them from a cold clone to a running stack where Mayor can receive Telegram messages via **gt-bot** (the default, bundled bridge) and talk back.

## Before you start

- Check that the user is actually in the starter-kit repo: `README.md` should mention "Gas Town Starter Kit" and `wizard/gt-wizard` should be present.
- Check that Docker and `claude` are on their host: `docker --version`, `which claude`. If either is missing, stop and link them to the prerequisites section of the top-level `README.md`. Do not try to install Docker for them — it requires sudo and host-specific steps.
- Check they've run `claude login` on the host. Look for a non-empty `~/.claude/` with session files. If missing, have them run `claude login` in a separate terminal and come back.

## The flow (happy path)

Do these one at a time. After each step, wait for the user to confirm it worked before moving on. If they hit an error, diagnose it before advancing — do not barrel through failures.

1. **Copy `.env.example` to `.env`.** The entrypoint does this automatically on first run, but if you're helping them configure *before* starting the container, run: `cp .env.example .env`.

2. **Collect the gt-bot Telegram token.** Walk them through creating **one** Telegram bot with @BotFather — this is gt-bot, Gas Town's default bridge. Paste the token into `GT_BOT_TOKEN` in `.env` (the wizard will prompt for it). If they ask "what's a Telegram bot token?", explain: it's the string BotFather hands back after `/newbot`, formatted like `123456789:ABCdefGHIjklMNOpqrSTUvwxYZ1234567890`. It authenticates the bot with Telegram's API.
   **No need to look up their chat ID manually.** After they paste the token, the wizard prompts them to send any message to their new bot on Telegram — the wizard polls the Telegram API and auto-fills `OPERATOR_TELEGRAM_CHAT_ID` from that message. The entrypoint seeds this chat as gt-bot's first admin row on boot. If the wizard times out (no message within ~90s), it falls back to manual entry (message `@userinfobot`).

   **Optional add-ons.** TeleTalk (`TELETALK_BOT_TOKEN`) and Crow (`CROW_BOT_TOKEN`) are no longer required. If the user wants the richer conversational relay (TeleTalk) or the legacy ops bridge (Crow), they can create extra bots with @BotFather and drop those tokens in later — gt-bot alone is enough to complete install.

3. **Build the container.** On the host: `docker compose build`. This installs the pinned toolchain, bakes in the wizard, and pre-installs gt-bot's Node deps. Expect 3–8 minutes on a first build.

4. **Start the stack.** `docker compose up -d`. The entrypoint starts Dolt, runs the gt-bot wizard + daemon automatically (because `GT_BOT_TOKEN` is set in `.env`), and seeds `OPERATOR_TELEGRAM_CHAT_ID` as the first admin if the permissions table is empty. That is it — one command and gt-bot is already listening. No extra shell needed for the bot.

5. **Run the wizard interactively (optional).** `docker compose exec gastown gt-wizard init`. The entrypoint already did the heavy lifting, but running the wizard by hand is useful if the user skipped `.env` entry and wants to be walked through it, or to re-run `verify`.

6. **Start Mayor.** `docker compose exec gastown gt-wizard start` prints the commands. In the single-bot happy path, the user only needs one shell: the Mayor shell. TeleTalk and Crow commands are printed too but labelled optional — the user exec's in for those only if they filled in `TELETALK_BOT_TOKEN` or `CROW_BOT_TOKEN`.

7. **Verify end-to-end.** Have the user open Telegram, find their gt-bot, and DM it with something like **"hello mayor"**. gt-bot forwards it as `gt mail` + `gt nudge` to Mayor; Mayor should pick it up and respond via `POST /send` back through gt-bot. If that round-trip works, install is complete.

## Common snags (with fixes)

- **"Docker can't access ~/.claude"** — the volume mount is read-write but the host directory permissions may block root-in-container. Have the user check `ls -la ~/.claude` and confirm the owner matches their host user.
- **"Dolt port 3307 in use"** — they likely have a host-level Gas Town install already running. Either stop the host Dolt (`gt dolt stop`) or change `DOLT_PORT` in `.env` and the published port in `docker-compose.yml`.
- **"gt-bot not responding"** — check `docker compose logs gastown | grep gt-bot`. If it says "no `GT_BOT_TOKEN` set" (or similar), the user forgot to fill in the token in `.env`. Fix the `.env`, then `docker compose up -d` again — the entrypoint will pick up the new token.
- **"Permissions empty error on start"** — gt-bot refuses to start with zero rows in `gt_bot.permissions`. The entrypoint auto-seeds from `OPERATOR_TELEGRAM_CHAT_ID` on first run, but only if that variable is actually set. Either set it in `.env` and restart the container, or add the row by hand: `docker compose exec gastown /gastown/bot/bin/gt-bot perms add <chat_id> --role admin`.
- **"Telegram bot doesn't respond" (non-gt-bot)** — if they're using the optional TeleTalk or Crow path, confirm `OPERATOR_TELEGRAM_CHAT_ID` matches the user's own chat ID (not the bot's ID). Verify with `docker compose logs gastown | tail -50`.
- **"`claude login` lost after rebuild"** — they removed the `~/.claude` volume mount or mounted the wrong path. Check `docker-compose.yml`.
- **"wizard says ANTHROPIC_API_KEY is better"** — it isn't, for Claude Pro / Max subscribers. Push them toward `claude login`. Per-token billing is only the right call for users who don't have a subscription.

## Don't do for them

- Don't try to start Docker Engine, install Claude Code, or fix host system packages — those are prereqs the user owns.
- Don't `docker compose build` yourself unless they ask — it's slow and you'll blow through their session tokens.
- Don't edit `.env` directly. Use `gt-wizard setup-telegram` so validation runs.

## After install

Suggest the user's first move: "ask Mayor, over gt-bot, to create a small rig of your choice." For example: *"make a rig called notes, file a bead to sketch the idea, and route it to a polecat."* No example rig is pre-scaffolded — the user invents their first one. Point them at `docs/first-rig.md` for the deeper walkthrough.

## If things are clearly broken

If the user says the install is stuck, run `docker compose exec gastown gt-wizard verify` and read its output to them verbatim. Each check names the fix. Do not guess — the verifier is the source of truth.

Escalate to `docs/troubleshooting.md` for anything beyond the "common snags" list.
