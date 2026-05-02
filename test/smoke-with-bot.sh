#!/usr/bin/env bash
# Smoke test: opt-in install path with a Telegram bot token configured.
#
# Confirms the legacy path still works after bead ga-pg8 made gt-bot opt
# in: when GT_BOT_TOKEN is set, the entrypoint at LEAST attempts to start
# gt-bot. The token is fake (not a real Telegram bot), so the bot will
# fail to actually connect to Telegram and may not stay running. That is
# fine; this test only asserts the start sequence ran, not that the
# external Telegram service was reachable.
#
# Run from the repo root:
#
#   bash test/smoke-with-bot.sh
#
# Exit codes: 0 = pass, non-zero = fail (with a diagnostic on stderr).
#
# Implementation notes:
#   - Uses `docker compose --project-name smoke-with-bot` so this does not
#     collide with an operator's running prod gastown stack.
#   - Writes a throwaway .env into a temp dir and points compose at it via
#     --env-file, so the operator's real .env is never touched.
#   - Tears down the smoke project (containers + volumes) on exit.

set -euo pipefail

log()  { printf '[smoke-with-bot] %s\n' "$*"; }
fail() { printf '[smoke-with-bot] FAIL: %s\n' "$*" >&2; exit 1; }

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/.." && pwd)"
COMPOSE="$REPO_ROOT/docker-compose.yml"

[ -f "$COMPOSE" ] || fail "docker-compose.yml not found at $COMPOSE"

command -v docker >/dev/null || fail "docker CLI missing on host."
docker info >/dev/null 2>&1 || fail "docker daemon unreachable."

PROJECT="smoke-with-bot"
TMPDIR="$(mktemp -d -t smoke-with-bot.XXXXXX)"
trap 'cleanup' EXIT
cleanup() {
    log "tearing down (project=$PROJECT)..."
    ( cd "$REPO_ROOT" && \
      docker compose --project-name "$PROJECT" --env-file "$TMPDIR/.env" \
        -f "$COMPOSE" down -v 2>/dev/null ) || true
    rm -rf "$TMPDIR"
}

# Throwaway env file. GT_BOT_TOKEN is a fake that matches the wizard's
# format regex (digits:letters/underscores/dashes) so init code paths
# that validate the token format see something well-formed. It will not
# actually authenticate against Telegram; that is intentional.
FAKE_TOKEN="123456789:smoke_with_bot_AAAAAAAAAAAAAAAAAAAA"
cat >"$TMPDIR/.env" <<EOF
ANTHROPIC_API_KEY=
GT_BOT_TOKEN=${FAKE_TOKEN}
TELETALK_BOT_TOKEN=
CROW_BOT_TOKEN=
OPERATOR_TELEGRAM_CHAT_ID=
COMPOSE_FILE=
COMPOSE_PROFILES=
GASTOWN_CONTAINER_NAME=smoke-with-bot
GASTOWN_HOME=/gastown
DOLT_PORT=3307
LOG_LEVEL=info
GT_TOWN_ROOT=/gastown/repos/hq
GIT_USER_NAME=Smoke Test
GIT_USER_EMAIL=smoke@example.invalid
GH_TOKEN=
DASHBOARD_AUTH_TOKEN=
EOF

log "building image fresh..."
( cd "$REPO_ROOT" && \
  docker compose --project-name "$PROJECT" --env-file "$TMPDIR/.env" \
    -f "$COMPOSE" build )

log "bringing up stack with fake GT_BOT_TOKEN..."
( cd "$REPO_ROOT" && \
  docker compose --project-name "$PROJECT" --env-file "$TMPDIR/.env" \
    -f "$COMPOSE" up -d )

CONTAINER="smoke-with-bot"

log "waiting for container to be exec-able..."
for i in $(seq 1 60); do
    if docker exec "$CONTAINER" true 2>/dev/null; then break; fi
    sleep 2
done
docker exec "$CONTAINER" true 2>/dev/null \
    || fail "container '$CONTAINER' never became exec-able."

log "asserting container is running..."
state="$(docker inspect -f '{{.State.Status}}' "$CONTAINER" 2>/dev/null || true)"
[ "$state" = "running" ] \
    || fail "container '$CONTAINER' state is '$state', expected 'running'."

# Give the entrypoint enough time to attempt gt-bot init + start. The
# init does up to 3 retries with sleeps, so allow generous headroom.
log "waiting 60s for entrypoint to reach and exercise gt-bot start sequence..."
sleep 60

log "asserting entrypoint logged that gt-bot start was attempted..."
logs="$( docker compose --project-name "$PROJECT" --env-file "$TMPDIR/.env" \
            -f "$COMPOSE" logs gastown 2>/dev/null || true )"

# Look for either the "starting on port" line (init succeeded, start
# attempted) OR the "initializing Dolt schema" line followed by some
# evidence the path was exercised. If GT_BOT_TOKEN is empty the entry
# point logs "no GT_BOT_TOKEN set" and returns immediately; that line
# MUST be absent here.
if printf '%s' "$logs" | grep -q 'gt-bot: no GT_BOT_TOKEN set'; then
    fail "entrypoint logged 'no GT_BOT_TOKEN set' but token was provided."
fi

if ! printf '%s' "$logs" | grep -qE 'gt-bot: (initializing Dolt schema|starting on port)'; then
    printf '%s\n' "$logs" | tail -n 80 >&2 || true
    fail "expected gt-bot init or start log line, found neither."
fi

log "PASS"
