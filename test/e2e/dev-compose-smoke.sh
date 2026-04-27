#!/usr/bin/env bash
# Smoke test: bring up the dev container from inside the running prod
# (Mayor) container and assert the host-driven bind mounts resolved as
# regular paths on the host filesystem — not as the empty-directory
# placeholder the docker daemon silently creates when a bind source path
# does not exist on the host.
#
# Run this from a shell inside the prod gastown container, NOT from the
# operator's host shell. (From the host the in-container env-var path
# would be inactive and the test wouldn't exercise the fix.)
#
#   docker exec -it gastown bash
#   bash /gastown/test/e2e/dev-compose-smoke.sh
#
# Pre-reqs:
#   - prod gastown image was built with the GASTOWN_HOST_CLAUDE /
#     GASTOWN_HOST_ENV environment exports in place (see docker-compose.yml).
#     Old images won't have them; rebuild prod first.
#   - the docker socket bind mount and docker CLI are present (ga-bbq).
#
# Exit codes: 0 = pass, non-zero = fail (with a diagnostic on stderr).

set -euo pipefail

log() { printf '[smoke] %s\n' "$*"; }
fail() { printf '[smoke] FAIL: %s\n' "$*" >&2; exit 1; }

# Resolve the starter-kit checkout path. Inside the prod container the
# repo is cloned under /gastown/repos/hq/gasdepot — but tests run out of
# the worktree so default to the script's parent-of-parent directory.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
DEV_COMPOSE="$REPO_ROOT/docker-compose.dev.yml"

[ -f "$DEV_COMPOSE" ] || fail "docker-compose.dev.yml not found at $DEV_COMPOSE"

# We expect to be running inside the prod gastown container, where
# GASTOWN_HOST_CLAUDE and GASTOWN_HOST_ENV were exported by the prod
# compose. Without them the dev container would still fall back to the
# in-container ${HOME}/.claude and ./.env paths, which is exactly the
# bug we're guarding against.
if [ -z "${GASTOWN_HOST_ENV:-}" ]; then
    fail "GASTOWN_HOST_ENV not set in env. Are you running inside prod gastown rebuilt with the env-export change?"
fi
if [ -z "${GASTOWN_HOST_CLAUDE:-}" ]; then
    fail "GASTOWN_HOST_CLAUDE not set in env. Same cause as above."
fi
log "GASTOWN_HOST_ENV=$GASTOWN_HOST_ENV"
log "GASTOWN_HOST_CLAUDE=$GASTOWN_HOST_CLAUDE"

command -v docker >/dev/null || fail "docker CLI missing inside the prod container."
docker version >/dev/null 2>&1 || fail "docker daemon unreachable from inside prod container (socket mount + GID?)."

cleanup() {
    log "tearing down dev container..."
    docker compose -f "$DEV_COMPOSE" down 2>/dev/null || true
}
trap cleanup EXIT

log "bringing up gastown-dev via $DEV_COMPOSE ..."
( cd "$REPO_ROOT" && docker compose -f "$DEV_COMPOSE" up -d --build )

# The dev container starts running its entrypoint immediately. Give it a
# few seconds to settle so the bind mount is observable, then probe.
for i in $(seq 1 30); do
    if docker exec gastown-dev true 2>/dev/null; then break; fi
    sleep 1
done
docker exec gastown-dev true 2>/dev/null || fail "gastown-dev never became exec-able."

log "asserting /gastown/.env is a regular file (not a dir placeholder)..."
if ! docker exec gastown-dev test -f /gastown/.env; then
    docker exec gastown-dev ls -la /gastown/.env >&2 || true
    fail "/gastown/.env inside gastown-dev is not a regular file. The bind source did not resolve to the host .env."
fi

log "asserting /home/gastown/.claude is a directory..."
if ! docker exec gastown-dev test -d /home/gastown/.claude; then
    docker exec gastown-dev ls -la /home/gastown/.claude >&2 || true
    fail "/home/gastown/.claude inside gastown-dev is not a directory."
fi

log "asserting host .env content is visible inside dev..."
if ! docker exec gastown-dev grep -q '^GT_BOT_TOKEN_DEV=' /gastown/.env; then
    log "WARN: GT_BOT_TOKEN_DEV line not found in /gastown/.env. The mount worked, but the host .env may not have a dev token configured."
fi

log "PASS"
