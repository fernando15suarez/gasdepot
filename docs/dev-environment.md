# Dev / staging container

`docker-compose.yml` boots one container — the prod `gastown` — and that container is the only Telegram bridge between you and Mayor. Every change you ship to the bot, the Dockerfile, or the entrypoint puts that bridge at risk for the duration of the rebuild. Dev shrinks that risk to zero.

`docker-compose.dev.yml` boots a parallel `gastown-dev` container with its own Dolt, its own repos, its own logs, and its own Telegram bot. You iterate against dev; prod stays untouched until you decide to merge.

## What you get

| | Prod (`gastown`) | Dev (`gastown-dev`) |
| --- | --- | --- |
| Container name | `gastown` | `gastown-dev` |
| Compose file | `docker-compose.yml` | `docker-compose.dev.yml` |
| Dolt host port | `3307` | `3309` |
| gt-bot host port | `3335` | `3336` |
| Dolt volume | `gastown-dolt-data` | `gastown-dev-dolt-data` |
| Repos volume | `gastown-repos` | `gastown-dev-repos` |
| Logs volume | `gastown-logs` | `gastown-dev-logs` |
| Bot token env | `GT_BOT_TOKEN` | `GT_BOT_TOKEN_DEV` |

The two containers share `~/.claude` (your Claude auth) and `OPERATOR_TELEGRAM_CHAT_ID` (you). Everything else is isolated.

## One-time setup

1. **Create a second Telegram bot.** Open a chat with [@BotFather](https://t.me/BotFather) and `/newbot`. Pick a distinct display name like `gasDepotDev` so you can tell prod and dev replies apart in your chat. Copy the token.

2. **Add the token to `.env`:**

   ```bash
   # in your starter-kit clone
   grep -q '^GT_BOT_TOKEN_DEV=' .env \
       && sed -i "s|^GT_BOT_TOKEN_DEV=.*|GT_BOT_TOKEN_DEV=<paste-token>|" .env \
       || echo "GT_BOT_TOKEN_DEV=<paste-token>" >> .env
   ```

3. **DM the dev bot once** so Telegram links your operator chat ID to it. Send any message; the dev container's auto-detect will see it on first boot if `OPERATOR_TELEGRAM_CHAT_ID` isn't already in `.env` (it is, after prod onboarding — so this is just to teach Telegram which chat to deliver replies to).

## Daily flow: iterate on dev, merge to prod

```bash
# Start (or rebuild) dev. Prod keeps running untouched.
docker compose -f docker-compose.dev.yml up -d --build

# Tail dev logs.
docker compose -f docker-compose.dev.yml logs -f gastown-dev

# Exec into dev (e.g. for `gt mail inbox` or `bd ready`).
docker compose -f docker-compose.dev.yml exec gastown-dev bash

# DM the dev bot on Telegram. Confirm the new feature works end-to-end.
# Reply will come from "gasDepotDev" (or whatever name you gave it).

# Happy with the change? Merge the PR, then bump prod:
docker compose build
docker compose up -d

# Tear down dev when you're not using it (volumes survive):
docker compose -f docker-compose.dev.yml down

# Wipe dev state (drop the dev Dolt + repos volumes too):
docker compose -f docker-compose.dev.yml down -v
```

`docker compose down` on the dev compose only stops `gastown-dev`. Prod's container, volumes, and ports are untouched.

## Checking out a feature branch in the dev container

The dev container's `/gastown/repos` is a fresh, isolated volume — it has no clones the first time you boot. Either let `gt-wizard` populate it the same way it did for prod, or `git clone` directly inside the container against your starter-kit repo's branch:

```bash
docker compose -f docker-compose.dev.yml exec gastown-dev bash
# then, inside the container:
cd /gastown/repos
git clone -b <branch> https://github.com/<you>/gasdepot starter-kit-dev
```

For changes to the starter kit *itself* (Dockerfile, entrypoint, bot/), the rebuild is the test — `--build` on the dev compose pulls in your in-progress code, since the build context is `.`.

## Things that intentionally are NOT shared

- **Dolt data.** Dev has its own beads, its own mail, its own identity history. Wiping dev never touches prod's data plane.
- **Cloned repos.** A botched `git reset --hard` in dev's `/gastown/repos` cannot corrupt prod's clones.
- **Logs.** `docker compose logs gastown-dev` shows only dev. Same for the named log volume.
- **Telegram bot.** Two tokens, two webhooks. If you typo a Mayor reply path and start spamming, only dev's bot fires.

## Things that are shared (by design)

- `~/.claude` — both containers reuse your Claude auth. Re-logging on the host updates both.
- `OPERATOR_TELEGRAM_CHAT_ID` — both bots only accept messages from you. The chat ID lives in `.env`, which is bind-mounted into both.
- `ANTHROPIC_API_KEY` (if set) — same key, two parallel mayors. If you're worried about parallel agent cost, set tighter rate limits on your key, or unset it for dev to fall back to `claude login`.

## Troubleshooting

- **"Port is already allocated"** — something else on your host already binds 3309 or 3336. Edit the host-side port in `docker-compose.dev.yml` (the left side of `"3309:3307"`) and restart.
- **"GT_BOT_TOKEN is required"** — `GT_BOT_TOKEN_DEV` is empty. The dev container falls back to no token, the entrypoint logs `gt-bot: no GT_BOT_TOKEN set — skipping`, and Mayor boots without a Telegram bridge. Set the token in `.env` and `docker compose -f docker-compose.dev.yml up -d` again.
- **Dev bot replies in the wrong window / silence** — verify in @BotFather that you're talking to the dev bot, not prod. The display name shown in your Telegram chat list is the source of truth.
- **`docker compose down` killed prod by mistake** — you ran `docker compose down` (no `-f`) which targets `docker-compose.yml`. Use `docker compose -f docker-compose.dev.yml down` to scope to dev.
