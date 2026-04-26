#!/usr/bin/env bash
# gasDepot — no-Claude installer.
#
# Builds the image, brings up the stack, and drops the user into the
# wizard for token entry. Mirrors the steps the `install-gasDepot` Claude
# skill performs, so users without Claude Code can still onboard.
#
# Usage:
#   ./install.sh

set -euo pipefail

# --- pretty-print helpers ---------------------------------------------------

if [ -t 1 ]; then
    BOLD=$'\033[1m'
    DIM=$'\033[2m'
    RED=$'\033[31m'
    YELLOW=$'\033[33m'
    GREEN=$'\033[32m'
    RESET=$'\033[0m'
else
    BOLD=""
    DIM=""
    RED=""
    YELLOW=""
    GREEN=""
    RESET=""
fi

step() { printf '\n%s==> %s%s\n' "${BOLD}" "$1" "${RESET}"; }
info() { printf '%s%s%s\n' "${DIM}" "$1" "${RESET}"; }
warn() { printf '%s[warn] %s%s\n' "${YELLOW}" "$1" "${RESET}" >&2; }
err()  { printf '%s[error] %s%s\n' "${RED}" "$1" "${RESET}" >&2; }
ok()   { printf '%s%s%s\n' "${GREEN}" "$1" "${RESET}"; }

# --- SIGINT handling --------------------------------------------------------
#
# A half-built image is recoverable (rerun ./install.sh), but we want to be
# loud about it rather than silently leaving the user wondering what state
# the stack is in.

on_interrupt() {
    printf '\n'
    warn "Interrupted. The stack may be partially built or running."
    warn "Rerun ./install.sh to resume, or 'docker compose down' to clean up."
    exit 130
}
trap on_interrupt INT

# --- compose command detection ---------------------------------------------
#
# Modern Docker ships `docker compose` (v2 plugin); older installs use the
# standalone `docker-compose` binary. Pick whichever is available.

COMPOSE=""
if docker compose version >/dev/null 2>&1; then
    COMPOSE="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
    COMPOSE="docker-compose"
fi

# --- prerequisite checks ---------------------------------------------------

step "Checking prerequisites"

missing=0
if ! command -v docker >/dev/null 2>&1; then
    err "docker is not on PATH."
    err "Install Docker first: https://docs.docker.com/get-docker/"
    missing=1
fi
if [ -z "${COMPOSE}" ]; then
    err "docker compose (v2 plugin) or docker-compose (standalone) is required."
    err "Install Docker Desktop or the compose plugin: https://docs.docker.com/get-docker/"
    missing=1
fi
if [ "${missing}" -ne 0 ]; then
    exit 1
fi

if ! docker info >/dev/null 2>&1; then
    err "docker is installed but the daemon is not reachable."
    err "Start Docker Desktop or 'sudo systemctl start docker' and retry."
    exit 1
fi

case "$(uname -s 2>/dev/null || echo unknown)" in
    MINGW*|MSYS*|CYGWIN*)
        warn "Detected Windows shell. v0 is Linux-only; this script may not work."
        warn "See docs/troubleshooting.md for the Windows status. install.ps1 is planned."
        ;;
esac

ok "docker + ${COMPOSE} present."

# --- .env bootstrap --------------------------------------------------------
#
# docker-compose.yml bind-mounts ./.env into the container, so the file must
# exist on the host before `up` runs. The wizard fills in tokens later.

if [ ! -f .env ]; then
    if [ -f .env.example ]; then
        cp .env.example .env
        info "Created .env from .env.example. The wizard will fill in tokens."
    else
        err ".env.example is missing — are you running this from the repo root?"
        exit 1
    fi
fi

# --- build & up ------------------------------------------------------------

step "Building image"
${COMPOSE} build

step "Starting stack"
${COMPOSE} up -d

# Give the container a moment to finish its boot sequence (Dolt warmup,
# entrypoint setup) before we exec into it. A quick `exec true` confirms
# the container is actually accepting commands.
info "Waiting for container to be ready..."
sleep 3
ready=0
for _ in 1 2 3 4 5 6 7 8 9 10; do
    if ${COMPOSE} exec -T gastown true >/dev/null 2>&1; then
        ready=1
        break
    fi
    sleep 2
done
if [ "${ready}" -ne 1 ]; then
    err "Container did not become ready in time."
    err "Check '${COMPOSE} logs gastown' for details."
    exit 1
fi
ok "Stack is up."

# --- launch wizard ---------------------------------------------------------

step "Launching wizard"
info "The wizard walks you through Telegram + Claude token entry."
info "Re-run any time with: ${COMPOSE} exec -it gastown gt-wizard init"

exec ${COMPOSE} exec -it gastown gt-wizard init
