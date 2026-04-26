# gasDepot

A Dockerized onboarding rig for [Gas Town](https://github.com/gastownhall/gastown) — the multi-agent AI workspace framework. Clone this repo, open it in Claude Code, and in a few minutes you'll have **Mayor** running against your own Claude auth, with **gt-bot** bridging Mayor to Telegram. **TeleTalk** and **Crow** remain available as optional add-ons.

> **Status:** v0 MVP. Linux-only. Single-container topology. See [`docs/troubleshooting.md`](docs/troubleshooting.md) for known rough edges.

## Quickstart (no Claude)

If you don't have Claude Code yet (or just want the fastest path), run the installer script:

```bash
git clone https://github.com/fernando15suarez/gasdepot
cd gasdepot
./install.sh
```

`install.sh` checks for Docker, builds the image, brings up the stack, and drops you into `gt-wizard` for Telegram + Claude token entry. Re-running it is safe — the wizard is idempotent. You'll still need a Claude auth (subscription or API key) and at least one Telegram bot token; the wizard explains how to get them.

## Three-step quickstart (with Claude Code)

1. **Install the prerequisites** on your host (see below).
2. **Clone this repo** and `cd` into it.
3. **Open it in Claude Code** and run `/install-gasDepot`.

```bash
git clone <this-repo-url> gasdepot
cd gasdepot
claude   # then, inside Claude Code, run: /install-gasDepot
```

The `/install-gasDepot` skill walks you through the rest — creating a single Telegram bot for gt-bot, wiring up Claude auth, and booting Mayor. When `docker compose up -d` finishes, Dolt, gt-bot, the HQ (at `/gastown`), and Mayor are all already running; `gt-wizard start` is idempotent and safe to re-run. You can also drive the underlying CLI directly: `./wizard/gt-wizard init`.

## Prerequisites (install on your host, not in the container)

Linux is required for v0. The installer will refuse to run on macOS or Windows — patches welcome.

- **Docker** (Engine 24+) and **docker compose** — [install guide](https://docs.docker.com/engine/install/)
- **Claude Code** — [install guide](https://docs.claude.com/en/docs/claude-code). Run `claude login` on the host *before* onboarding. The installer mounts your host's `~/.claude/` into the container so the session inherits your auth; you do not need to log in again inside Docker.
- **Anthropic key (optional)** — only needed if you prefer `ANTHROPIC_API_KEY` over `claude login`. Claude Pro / Max subscribers should stick with `claude login` so they're not pushed into per-token billing.
- **Telegram bot token (x1 required)** — one bot for **gt-bot**, Gas Town's default Telegram bridge. [How to create a bot with @BotFather](https://core.telegram.org/bots/tutorial). The wizard explains this step in detail. TeleTalk and Crow tokens are optional add-ons — create them later if you want the richer conversational relay or the legacy ops bridge.

## What you get

After onboarding completes:

- **Mayor** — the town's coordinator agent. Listens for dispatch, routes work, talks back via beads mail. Boots automatically from `entrypoint.sh` (daemon mode) once the HQ is installed; `gt-wizard start` runs `gt install` + `gt start` for anyone driving the wizard manually.
- **HQ at `/gastown`** — the Gas Town workspace root inside the container, stamped by `gt install` on first boot. Contains `CLAUDE.md`, `mayor/`, and `.beads/`. Required for `gt mail send mayor/` and friends to work.
- **gt-bot** — Gas Town's default Telegram bridge. Forwards authorized Telegram DMs to Mayor as `gt mail` + `gt nudge`, and posts Mayor's replies back to you. Starts automatically from `entrypoint.sh`.
- **TeleTalk** *(optional)* — a Telegram bot that relays richer conversational chat to/from Claude agents. Only runs if `TELETALK_BOT_TOKEN` is set.
- **Crow** *(optional)* — a Telegram bot for operational / status notifications. Only runs if `CROW_BOT_TOKEN` is set.
- **Dolt server** — the data plane for beads (issues, mail, identity, work history).
- **Beads DB** — Mayor's queue for the work you hand it.
- **A running container** named `gastown` with the toolchain pinned to known-good versions.
- **Optional dev/staging container** — `docker-compose.dev.yml` boots a parallel `gastown-dev` container with its own Dolt, repos, logs, and Telegram bot, so you can iterate on the starter kit without putting prod's bridge at risk. See [`docs/dev-environment.md`](docs/dev-environment.md).

Your first move after install is to DM gt-bot on Telegram and ask Mayor to spawn your first rig. No example rig is pre-scaffolded — you create the work you care about.

## Updating

Fernando ships new tools and wizard improvements on the `main` branch. To pull them into your running setup:

```bash
git pull
docker compose build
docker compose up -d
```

Your Dolt data, Claude config, `.env`, and user repos live on named volumes and survive rebuilds. See [`docs/updating.md`](docs/updating.md) for the full story, including Dolt backup before risky updates.

## What lives where

| Path | Purpose |
| --- | --- |
| `Dockerfile` | Image definition — pinned `node`, `python`, `git`, `bd`, `dolt`, `claude`, `gt` |
| `entrypoint.sh` | Detects first-run vs. rebuilds; hands off to the wizard or to a running shell |
| `docker-compose.yml` | Single-service compose — defines volumes, env wiring, ports |
| `docker-compose.dev.yml` | Optional second compose — boots a parallel `gastown-dev` container for iteration (see [`docs/dev-environment.md`](docs/dev-environment.md)) |
| `.env.example` | Template for Telegram tokens (`GT_BOT_TOKEN` required; `GT_BOT_TOKEN_DEV` for the dev container; TeleTalk/Crow optional) and Anthropic key (copy to `.env`) |
| `bot/` | gt-bot — bundled Telegram bridge (auto-started by `entrypoint.sh`) |
| `wizard/` | CLI primitives — idempotent scripts the skill orchestrates |
| `.claude/skills/install-gasDepot/` | The conversational onboarding skill |
| `docs/` | Short guides — first rig, updating, troubleshooting |
| `.beads/` | This repo's own beads DB — track starter-kit bugs here |

## Reporting issues

This repo has its own beads DB. From inside the container (or on the host with `bd` installed):

```bash
bd q "Short description of the thing that went wrong"
```

Or file a GitHub issue if you prefer.

## License

MIT (pending — add LICENSE file before first public tag).
