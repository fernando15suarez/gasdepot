#!/usr/bin/env bash
# Smoke test: default install path with NO Telegram bot configured.
#
# What this verifies (the goal of bead ga-pg8): a fresh user who runs the
# wizard non-interactively with no GT_BOT_TOKEN lands in a working
# Mayor + Dolt container, and gt-bot is NOT running. This is the new
# default route through the funnel after the opt-in change.
#
# Run from the repo root:
#
#   bash test/smoke-no-bot.sh
#
# Exit codes: 0 = pass, non-zero = fail (with a diagnostic on stderr).
#
# Implementation notes:
#   - Uses a dedicated `docker compose --project-name smoke-no-bot` so this
#     does not collide with an operator's running prod gastown stack.
#   - Writes a throwaway .env into a temp dir and points compose at it via
#     --env-file, so the operator's real .env is never touched.
#   - Tears down the smoke project (containers + volumes) on exit.

set -euo pipefail

log()  { printf '[smoke-no-bot] %s\n' "$*"; }
fail() { printf '[smoke-no-bot] FAIL: %s\n' "$*" >&2; exit 1; }

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/.." && pwd)"
COMPOSE="$REPO_ROOT/docker-compose.yml"

[ -f "$COMPOSE" ] || fail "docker-compose.yml not found at $COMPOSE"

command -v docker >/dev/null || fail "docker CLI missing on host."
docker info >/dev/null 2>&1 || fail "docker daemon unreachable."

PROJECT="smoke-no-bot"
TMPDIR="$(mktemp -d -t smoke-no-bot.XXXXXX)"
trap 'cleanup' EXIT
cleanup() {
    log "tearing down (project=$PROJECT)..."
    ( cd "$REPO_ROOT" && \
      docker compose --project-name "$PROJECT" --env-file "$TMPDIR/.env" \
        -f "$COMPOSE" down -v 2>/dev/null ) || true
    rm -rf "$TMPDIR"
}

# Throwaway env file. NO GT_BOT_TOKEN. Other knobs left at defaults.
cat >"$TMPDIR/.env" <<'EOF'
ANTHROPIC_API_KEY=
GT_BOT_TOKEN=
TELETALK_BOT_TOKEN=
CROW_BOT_TOKEN=
OPERATOR_TELEGRAM_CHAT_ID=
COMPOSE_FILE=
COMPOSE_PROFILES=
GASTOWN_CONTAINER_NAME=smoke-no-bot
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

log "bringing up stack with no GT_BOT_TOKEN..."
( cd "$REPO_ROOT" && \
  docker compose --project-name "$PROJECT" --env-file "$TMPDIR/.env" \
    -f "$COMPOSE" up -d )

CONTAINER="smoke-no-bot"

# Wait for the container to settle. Boot is typically 30-60s.
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

# Give the entrypoint a chance to log its skip line for gt-bot. The
# entrypoint runs gt-bot setup early in start_gt_bot(), so 20s is plenty.
log "waiting 20s for entrypoint to reach gt-bot stage..."
sleep 20

log "asserting gt-bot process is NOT running..."
if docker exec "$CONTAINER" pgrep -af 'gt-bot start' >/dev/null 2>&1; then
    docker exec "$CONTAINER" pgrep -af 'gt-bot start' >&2 || true
    fail "found a 'gt-bot start' process inside '$CONTAINER'; expected none."
fi

log "asserting gt-bot.log either is absent or last line says 'no GT_BOT_TOKEN'..."
log_path="/gastown/logs/gt-bot.log"
if docker exec "$CONTAINER" test -f "$log_path"; then
    last_line="$(docker exec "$CONTAINER" tail -n 1 "$log_path" 2>/dev/null || true)"
    if ! printf '%s' "$last_line" | grep -q 'no GT_BOT_TOKEN'; then
        # The entrypoint logs the skip via log() in entrypoint.sh, which
        # writes to the container's main log stream, not gt-bot.log. So an
        # existing gt-bot.log without the skip line is also acceptable as
        # long as the main entrypoint output contains the skip line.
        if ! docker compose --project-name "$PROJECT" \
              --env-file "$TMPDIR/.env" -f "$COMPOSE" logs gastown 2>/dev/null \
              | grep -q 'gt-bot: no GT_BOT_TOKEN set'; then
            fail "expected 'gt-bot: no GT_BOT_TOKEN set' in entrypoint logs but did not find it."
        fi
    fi
else
    # No gt-bot.log at all — confirm via main entrypoint log that the skip
    # path actually ran.
    if ! docker compose --project-name "$PROJECT" \
          --env-file "$TMPDIR/.env" -f "$COMPOSE" logs gastown 2>/dev/null \
          | grep -q 'gt-bot: no GT_BOT_TOKEN set'; then
        fail "expected 'gt-bot: no GT_BOT_TOKEN set' in entrypoint logs but did not find it."
    fi
fi

log "PASS"
