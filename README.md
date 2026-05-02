# gasDepot

A Dockerized onboarding rig for [Gas Town](https://github.com/gastownhall/gastown), the multi agent AI workspace framework. Clone this repo, open it in Claude Code, and in a few minutes you'll have **Mayor** running against your own Claude auth. The default install is Mayor + Dolt only; you drive Mayor from inside Claude Code via remote control. **gt-bot** (Telegram bridge), **TeleTalk**, and **Crow** are available as opt in add ons for users who want a chat surface.

> **Status:** v0 MVP. Linux-only. Single-container topology. See [`docs/troubleshooting.md`](docs/troubleshooting.md) for known rough edges.

## Quickstart (no Claude)

If you don't have Claude Code yet (or just want the fastest path), run the installer script:

```bash
git clone https://github.com/fernando15suarez/gasdepot
cd gasdepot
./install.sh
```

`install.sh` checks for Docker, builds the image, brings up the stack, and drops you into `gt-wizard` for Claude auth and (optionally) Telegram token entry. Re-running it is safe; the wizard is idempotent. You'll need a Claude auth (subscription or API key). A Telegram bot token is only required if you want the gt-bot bridge; the wizard prompts you and defaults to skipping it.

## Three-step quickstart (with Claude Code)

1. **Install the prerequisites** on your host (see below).
2. **Clone this repo** and `cd` into it.
3. **Open it in Claude Code** and run `/install-gasDepot`.

```bash
git clone <this-repo-url> gasdepot
cd gasdepot
claude   # then, inside Claude Code, run: /install-gasDepot
```

The `/install-gasDepot` skill walks you through the rest: wiring up Claude auth and booting Mayor. It also asks whether you want the gt-bot Telegram bridge; saying no skips BotFather entirely. When `docker compose up -d` finishes, Dolt, the HQ (at `/gastown`), and Mayor are all already running, and gt-bot only joins them if you opted in. `gt-wizard start` is idempotent and safe to re-run. You can also drive the underlying CLI directly: `./wizard/gt-wizard init`.

## Prerequisites (install on your host, not in the container)

Linux is required for v0. The installer will refuse to run on macOS or Windows — patches welcome.

- **Docker** (Engine 24+) and **docker compose** — [install guide](https://docs.docker.com/engine/install/)
- **Claude Code** — [install guide](https://docs.claude.com/en/docs/claude-code). Run `claude login` on the host *before* onboarding. The installer mounts your host's `~/.claude/` into the container so the session inherits your auth; you do not need to log in again inside Docker.
- **Anthropic key (optional)** — only needed if you prefer `ANTHROPIC_API_KEY` over `claude login`. Claude Pro / Max subscribers should stick with `claude login` so they're not pushed into per-token billing.
- **Telegram bot token (optional)** — only needed if you want **gt-bot**, the Gas Town Telegram bridge. The default install skips Telegram entirely; you drive Mayor from Claude Code via remote control instead. If you do want gt-bot, create a bot via [@BotFather](https://core.telegram.org/bots/tutorial); the wizard prompts you for the token. TeleTalk and Crow tokens are also optional, for the richer conversational relay or the legacy ops bridge.

## What you get

After onboarding completes:

- **Mayor** — the town's coordinator agent. Listens for dispatch, routes work, talks back via beads mail. Boots automatically from `entrypoint.sh` (daemon mode) once the HQ is installed; `gt-wizard start` runs `gt install` + `gt start` for anyone driving the wizard manually.
- **HQ at `/gastown`** — the Gas Town workspace root inside the container, stamped by `gt install` on first boot. Contains `CLAUDE.md`, `mayor/`, and `.beads/`. Required for `gt mail send mayor/` and friends to work.
- **gt-bot** *(optional)* — the Gas Town Telegram bridge. Forwards authorized Telegram DMs to Mayor as `gt mail` + `gt nudge`, and posts Mayor's replies back to you. Only runs if `GT_BOT_TOKEN` is set; otherwise the entrypoint skips it cleanly.
- **TeleTalk** *(optional)* — a Telegram bot that relays richer conversational chat to/from Claude agents. Only runs if `TELETALK_BOT_TOKEN` is set.
- **Crow** *(optional)* — a Telegram bot for operational / status notifications. Only runs if `CROW_BOT_TOKEN` is set.
- **Dolt server** — the data plane for beads (issues, mail, identity, work history).
- **Beads DB** — Mayor's queue for the work you hand it.
- **A running container** named `gastown` with the toolchain pinned to known-good versions.
- **Optional dev/staging container** — `docker-compose.dev.yml` boots a parallel `gastown-dev` container with its own Dolt, repos, logs, and Telegram bot, so you can iterate on the starter kit without putting prod's bridge at risk. See [`docs/dev-environment.md`](docs/dev-environment.md).
- **Mayor default memories** — a small set of behavior guidelines (when to push work to a polecat, how to ack Telegram messages) seeded into Mayor's memory store on first init from [`mayor-default-memories.json`](mayor-default-memories.json). See [`docs/default-memories.md`](docs/default-memories.md).

Your first move after install is to talk to Mayor and ask it to spawn your first rig. From Claude Code, drive Mayor via the remote control feature; if you opted into gt-bot, you can also DM the bot on Telegram. No example rig is pre scaffolded; you create the work you care about.

## Compose overlays — opting into heavier features

The default install boots Mayor + Dolt with local voice transcription baked in (the ~75MB ggml model lazy-downloads on the first voice DM and is cached on a persisted volume). gt-bot is opt in via `GT_BOT_TOKEN`. One overlay is available:

| Overlay | What it adds | Trust note |
| --- | --- | --- |
| `docker-compose.docker-host.yml` | Installs the docker CLI inside the container, bind-mounts `/var/run/docker.sock`, and bind-mounts the host's gasDepot checkout at the same path on both sides. Lets Mayor (and downstream user projects you build) drive the host docker daemon AND run `docker compose` against the host's gasdepot project. | **Effective root-on-host.** Read [`docs/docker-access.md`](docs/docker-access.md) before enabling. Single-operator only. |

Stack it with the standard `-f` flag (left-to-right merge — base file first):

```bash
# Default
docker compose up -d

# With docker-host access (pin the host's docker GID so the bind mount works)
docker compose -f docker-compose.yml -f docker-compose.docker-host.yml \
  build --build-arg DOCKER_GID=$(stat -c '%g' /var/run/docker.sock)
docker compose -f docker-compose.yml -f docker-compose.docker-host.yml up -d
```

To make plain `docker compose up` pick up the overlay without the `-f` flag every time, set `COMPOSE_FILE` in `.env`:

```bash
# .env — colon-separated, base file first
COMPOSE_FILE=docker-compose.yml:docker-compose.docker-host.yml
```

`gt-wizard init` walks you through this choice and writes `COMPOSE_FILE` for you.

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
| `.env.example` | Template for Anthropic key and Telegram tokens (all optional: `GT_BOT_TOKEN` enables the gt-bot bridge, `GT_BOT_TOKEN_DEV` is for the dev container, TeleTalk/Crow are also opt in). Copy to `.env` |
| `bot/` | gt-bot, the bundled Telegram bridge (started by `entrypoint.sh` only when `GT_BOT_TOKEN` is set) |
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
