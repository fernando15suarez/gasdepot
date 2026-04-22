# gt-bot

Telegram bridge for Gas Town, bundled with gasdepot.

- **Inbound**: authorized Telegram text messages become `gt mail` to `mayor/`
  and a live `gt nudge` for immediate delivery.
- **Outbound**: `POST /send` on port 3335 sends a message to a specific chat or
  all admin chats.

Permissions live in a dedicated Dolt database `gt_bot` (table `permissions`).
The only secret — `TELEGRAM_BOT_TOKEN` (or `GT_BOT_TOKEN`) — is read from the
environment or `.env`.

## When running inside the gasdepot container

gasdepot ships gt-bot pre-installed and starts it for you. The moment-to-moment
workflow is different from a host install — most commands below you will never
type yourself:

- **Token source.** `GT_BOT_TOKEN` is read from `/gastown/.env` (mounted into
  the container as `.env`). There is no separate `bot/.env` — put the token in
  the top-level `.env` next to `TELETALK_BOT_TOKEN` and `CROW_BOT_TOKEN`.
- **Dolt.** Dolt runs inside the same container at `127.0.0.1:3307`,
  auto-started by `entrypoint.sh`. You do not need to run `gt dolt start`.
- **Starting the bot.** gt-bot **auto-starts** from `entrypoint.sh` whenever
  `GT_BOT_TOKEN` (or `TELEGRAM_BOT_TOKEN`) is set — the entrypoint runs
  `node bin/gt-bot init`, seeds `OPERATOR_TELEGRAM_CHAT_ID` as the first admin
  if the permissions table is empty, and then launches the daemon. **You do
  not run `node bin/gt-bot start` yourself.**
- **Managing permissions.** Exec into the container:

  ```bash
  docker compose exec gastown /gastown/bot/bin/gt-bot perms list
  docker compose exec gastown /gastown/bot/bin/gt-bot perms add <chat_id> --role admin
  docker compose exec gastown /gastown/bot/bin/gt-bot perms remove <chat_id>
  ```

- **Reloading permissions without restarting the bot.** Inside the container:
  `kill -HUP $(pgrep -f 'node.*gt-bot/bot.js')`.

If you are running gt-bot standalone on a host (outside gasdepot), keep reading
— the rest of this README covers that path.

## Requirements

- Node.js 18+
- A running Dolt server at `127.0.0.1:$GT_DOLT_PORT` (default 3307). Start it
  with `gt dolt start`.
- The `gt` CLI on PATH (for inbound mail/nudge forwarding).

## Install

```bash
cd gasdepot/bot
npm install
cp .env.example .env
# edit .env and paste your TELEGRAM_BOT_TOKEN
```

## Initialize the Dolt schema

```bash
node bin/gt-bot init
```

This creates `gt_bot` database and the `permissions` table. Safe to re-run.

## Manage permissions

gt-bot refuses to start until at least one permission row exists.

```bash
# add an admin chat (get chat_id by messaging the bot then checking Telegram's API,
# or use a tool like @userinfobot on Telegram)
node bin/gt-bot perms add 123456789 --role admin --label "Fernando primary"

# add a scoped user chat (only sees mail for specific rigs)
node bin/gt-bot perms add 987654321 --role user --rigs mealpal,portfolio --label "mealpal watcher"

# list
node bin/gt-bot perms list

# remove
node bin/gt-bot perms remove 123456789
```

Fields:

| column     | type                          | notes                                        |
|------------|-------------------------------|----------------------------------------------|
| chat_id    | VARCHAR(32) PK                | Telegram chat id as a string                  |
| role       | ENUM('admin','user')          | admins receive default `/send` broadcasts     |
| rigs       | TEXT (csv or `*`)             | rigs this chat may see mail for (v0: metadata only) |
| label      | VARCHAR(255)                  | free-form human label                         |
| created_at | TIMESTAMP                     | auto                                          |

## Start the bot

```bash
node bin/gt-bot start
```

Logs to stdout. The HTTP API binds to `0.0.0.0:3335` by default; override with
`GT_BOT_PORT` in `.env`.

## HTTP API

### `POST /send`

```bash
curl -s -X POST http://localhost:3335/send \
  -H 'Content-Type: application/json' \
  -d '{"message":"hello from mayor"}'
```

Body fields:

- `message` (required): text to send.
- `chat` (optional): specific chat id. Must exist in `permissions`.

If `chat` is omitted, the message is broadcast to every row where
`role = 'admin'`.

Response:

```json
{ "ok": true, "delivered": [{ "chat": "123", "ok": true }] }
```

### `GET /health`

```bash
curl -s http://localhost:3335/health
```

## Coexistence with crow

Crow (at `~/gt/crow/`) runs on port **3333**, teletalk's bot uses **3334**, and gt-bot uses **3335**.
They can run side-by-side on the same machine. Nothing in gt-bot reads from,
writes to, or depends on crow's config or directory. Migrate at your own pace.

## Live-reload permissions

Send `SIGHUP` to the bot to re-load permissions from Dolt without restarting:

```bash
kill -HUP $(pgrep -f 'node.*gt-bot/bot.js')
```

## systemd unit (template)

Save to `/etc/systemd/system/gt-bot.service`, then `systemctl daemon-reload &&
systemctl enable --now gt-bot`.

```ini
[Unit]
Description=gt-bot Telegram bridge for Gas Town
After=network.target

[Service]
Type=simple
User=nando
WorkingDirectory=/home/nando/gt/gasdepot/bot
EnvironmentFile=/home/nando/gt/gasdepot/bot/.env
ExecStart=/usr/bin/node /home/nando/gt/gasdepot/bot/bin/gt-bot start
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Replace `nando` and the paths to match your install. Ensure `node`, `gt`, and
the Dolt server are reachable from the unit's environment (you may need to set
`PATH` in `[Service]` or via the `EnvironmentFile`).

## v0 scope / non-goals

Shipped:

- text-only inbound (no voice, no files)
- `POST /send` outbound
- chat permissions + role (`admin`/`user`) in Dolt
- SIGHUP permissions reload

Not shipped (follow-up beads):

- `/handoff`, `/kill`, `/sigint` commands
- file upload handling (`InputFile` / `/sendfile`)
- `.events.jsonl` lifecycle watching
- mail inbox polling fallback (requires `gt nudge` to be reachable)
- Dolt-based non-secret config (port, intervals)

## Troubleshooting

- **"gt-bot refuses to start: no rows in gt_bot.permissions"** — run
  `node bin/gt-bot perms add <chat_id> --role admin`.
- **ECONNREFUSED 127.0.0.1:3307** — Dolt server is not running. Run
  `gt dolt start`, confirm with `gt dolt status`.
- **"database not found: gt_bot"** — `node bin/gt-bot init` hasn't been run.
- **Bot starts but messages from Telegram are ignored** — the sender's
  `chat_id` is not in `permissions`. Add it, then `kill -HUP <pid>` or restart.
- **`gt mail send` errors on inbound** — the `gt` CLI is not on PATH for the
  bot's process. For systemd, set `PATH` explicitly.
