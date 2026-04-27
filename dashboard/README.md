# rigs-dashboard

Read-only Gas Town status webpage. Lets the operator see at a glance what
their rigs, agents, and beads are doing — answers "is Mayor bricked?"
without having to SSH and run `gt agents`.

## What it shows

- **Town card.** Mayor + Deacon + any town-level agents, with a
  green/yellow/red dot for state and a 12-line tmux pane snapshot.
- **Rig cards.** Per-rig witness / refinery / polecats, same dot scheme,
  current hook bead title, pane snapshot for the running ones.
- **Beads buckets.** `in_progress`, `ready`, recently `closed`.
- Auto-refreshes every 5 seconds via SSE; first paint is server-rendered
  HTML so there is no flash of empty state.
- Fully read-only — no buttons, no POST endpoints.

## How it works

The dashboard runs as a sibling container of `gastown`. State queries shell
out via the host docker socket:

- `docker exec gastown gt status --json` — rig/agent state
- `docker exec gastown bd ready --json` /
  `docker exec gastown bd list --status … --json` — beads
- `docker exec gastown tmux -S … capture-pane -t <session>` — pane content

Nothing is persisted in the dashboard container.

## Opt in

The service is profile-gated in `docker-compose.yml`:

```yaml
rigs-dashboard:
  profiles: ["dashboard"]
  …
```

Default `docker compose up -d` skips it. To enable:

```bash
docker compose --profile dashboard up -d
# or, persistent:
echo 'COMPOSE_PROFILES=dashboard' >> .env
docker compose up -d
```

Then visit `http://localhost:3338` (or `?token=<DASHBOARD_AUTH_TOKEN>` if
you set one in `.env`).

## Auth

Single shared token via `DASHBOARD_AUTH_TOKEN` env var. Pass it as
`?token=<value>` or the `X-Dashboard-Token` header. If the env var is empty,
auth is off — fine for `127.0.0.1`-only deployments, dangerous if you
port-forward.

## Endpoints

| Path             | Description                                        |
|------------------|----------------------------------------------------|
| `/`              | Server-rendered HTML page (initial paint)          |
| `/events`        | SSE stream of `snapshot` events every ~5 s         |
| `/snapshot.json` | One-shot JSON snapshot (debugging)                 |
| `/pane/:agent`   | Plain-text last N lines of a tmux pane             |
| `/healthz`       | Returns `ok` (200), no auth required               |

## Environment

| Var                     | Default                       | Notes                          |
|-------------------------|-------------------------------|--------------------------------|
| `DASHBOARD_PORT`        | `3338`                        | Listen port                    |
| `DASHBOARD_AUTH_TOKEN`  | empty                         | Shared bearer token            |
| `GT_TARGET_CONTAINER`   | `gastown`                     | `docker exec` target           |
| `GT_TARGET_USER`        | `gastown`                     | uid inside the target          |
| `TMUX_SOCKET_PATH`      | `/tmp/tmux-1000/default`      | Path inside the target         |
| `DASHBOARD_POLL_MS`     | `5000`                        | SSE refresh interval           |
