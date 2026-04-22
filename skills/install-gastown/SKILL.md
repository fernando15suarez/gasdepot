---
name: install-gastown
description: Conversational onboarding for the Gas Town starter kit. Use this skill when the user has just cloned the starter-kit repo and wants to stand up Mayor, TeleTalk, and Crow. Orchestrates the `wizard/gt-wizard` CLI primitives and answers follow-up questions (Telegram bot tokens, Docker volume layout, Dolt, Claude auth). Only runs in an environment where the user is sitting in the starter-kit repo.
---

# install-gastown

You are guiding a user (often new to AI tooling) through installing the Gas Town starter kit on a Linux machine. The repo they are sitting in contains a `Dockerfile`, a `docker-compose.yml`, a `wizard/gt-wizard` CLI, and a `.env.example`. Your job is to get them from a cold clone to a running stack where Mayor can dispatch work to polecats that talk back via TeleTalk.

## Before you start

- Check that the user is actually in the starter-kit repo: `README.md` should mention "Gas Town Starter Kit" and `wizard/gt-wizard` should be present.
- Check that Docker and `claude` are on their host: `docker --version`, `which claude`. If either is missing, stop and link them to the prerequisites section of the top-level `README.md`. Do not try to install Docker for them — it requires sudo and host-specific steps.
- Check they've run `claude login` on the host. Look for a non-empty `~/.claude/` with session files. If missing, have them run `claude login` in a separate terminal and come back.

## The flow (happy path)

Do these one at a time. After each step, wait for the user to confirm it worked before moving on. If they hit an error, diagnose it before advancing — do not barrel through failures.

1. **Copy `.env.example` to `.env`.** The entrypoint does this automatically on first run, but if you're helping them configure *before* starting the container, run: `cp .env.example .env`.

2. **Collect Telegram bot tokens.** Walk them through creating two bots with @BotFather on Telegram:
   - One bot for TeleTalk (the conversational relay).
   - One bot for Crow (ops / status notifications).
   If they ask "what's a Telegram bot token?", explain: it's the string BotFather hands back after `/newbot`, formatted like `123456789:ABCdefGHIjklMNOpqrSTUvwxYZ1234567890`. It authenticates the bot with Telegram's API.
   They also need their own Telegram chat ID — tell them to message `@userinfobot` on Telegram to find it.

3. **Build the container.** On the host: `docker compose build`. This clones TeleTalk and Crow from upstream, installs the pinned toolchain, and bakes the wizard in. Expect 3–8 minutes on a first build.

4. **Start the stack.** `docker compose up -d`. This starts Dolt inside the container. The wizard itself does not run at this point — it runs interactively when the user `exec`s in.

5. **Run the wizard interactively.** `docker compose exec gastown gt-wizard init`. This reads `.env`, fills in anything missing, saves Telegram tokens, and runs `verify`. If they already filled in `.env` by hand, the wizard detects that and fast-paths.

6. **Start the agents.** `docker compose exec gastown gt-wizard start` prints the three commands the user needs to run — one for Mayor, one for TeleTalk, one for Crow. They should open three shells (or three tmux panes inside the container) and run one each.

7. **Verify end-to-end.** Have the user DM the TeleTalk bot on Telegram with something like "hello mayor". Mayor should pick it up over beads mail and respond. If that round-trip works, install is complete.

## Common snags (with fixes)

- **"Docker can't access ~/.claude"** — the volume mount is read-write but the host directory permissions may block root-in-container. Have the user check `ls -la ~/.claude` and confirm the owner matches their host user.
- **"Dolt port 3307 in use"** — they likely have a host-level Gas Town install already running. Either stop the host Dolt (`gt dolt stop`) or change `DOLT_PORT` in `.env` and the published port in `docker-compose.yml`.
- **"Telegram bot doesn't respond"** — the bot process is running but the chat isn't allow-listed. Confirm `OPERATOR_TELEGRAM_CHAT_ID` matches the user's own chat ID (not the bot's ID). Verify with `docker compose logs gastown | tail -50`.
- **"`claude login` lost after rebuild"** — they removed the `~/.claude` volume mount or mounted the wrong path. Check `docker-compose.yml`.
- **"wizard says ANTHROPIC_API_KEY is better"** — it isn't, for Claude Pro / Max subscribers. Push them toward `claude login`. Per-token billing is only the right call for users who don't have a subscription.

## Don't do for them

- Don't try to start Docker Engine, install Claude Code, or fix host system packages — those are prereqs the user owns.
- Don't `docker compose build` yourself unless they ask — it's slow and you'll blow through their session tokens.
- Don't edit `.env` directly. Use `gt-wizard setup-telegram` so validation runs.

## After install

Suggest the user's first move: "ask Mayor, over TeleTalk, to create a small rig of your choice." For example: *"make a rig called notes, file a bead to sketch the idea, and route it to a polecat."* No example rig is pre-scaffolded — the user invents their first one. Point them at `docs/first-rig.md` for the deeper walkthrough.

## If things are clearly broken

If the user says the install is stuck, run `docker compose exec gastown gt-wizard verify` and read its output to them verbatim. Each check names the fix. Do not guess — the verifier is the source of truth.

Escalate to `docs/troubleshooting.md` for anything beyond the "common snags" list.
