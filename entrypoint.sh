#!/usr/bin/env bash
# Gas Town Starter Kit — container entrypoint.
#
# Modes (chosen by the first argument, default "wizard"):
#   wizard   Interactive onboarding. Detects first-run, copies .env.example if
#            needed, starts Dolt, hands off to the CLI wizard.
#   daemon   Non-interactive. Starts Dolt and tails logs. Used by
#            `docker compose up -d` when the user wants a long-lived stack.
#   shell    Drop to bash without any automatic setup. Useful for debugging.
#
# Fail loudly rather than limping along with a half-working stack.

set -euo pipefail

MODE="${1:-wizard}"
GASTOWN_HOME="${GASTOWN_HOME:-/gastown}"
DOLT_PORT="${DOLT_PORT:-3307}"
DOLT_DATA_DIR="${GASTOWN_HOME}/.dolt-data"
DOLT_LOG="${GASTOWN_HOME}/logs/dolt.log"
DOLT_PID="${GASTOWN_HOME}/logs/dolt.pid"
ENV_FILE="${GASTOWN_HOME}/.env"
GT_BOT_DIR="${GASTOWN_HOME}/bot"
GT_BOT_LOG="${GASTOWN_HOME}/logs/gt-bot.log"
GT_BOT_PID="${GASTOWN_HOME}/logs/gt-bot.pid"

log()  { printf '\033[36m[gastown]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[gastown]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[31m[gastown]\033[0m %s\n' "$*" >&2; exit 1; }

ensure_dirs() {
    mkdir -p "${DOLT_DATA_DIR}" "${GASTOWN_HOME}/logs" "${GASTOWN_HOME}/repos"
}

ensure_env_file() {
    if [[ ! -f "${ENV_FILE}" ]]; then
        log "First run — copying .env.example to .env."
        cp "${GASTOWN_HOME}/.env.example" "${ENV_FILE}"
    fi
}

sync_skills_to_host() {
    # The user's host ~/.claude is bind-mounted at ~gastown/.claude. We copy
    # skills/install-gastown into it so the host `claude` CLI sees the skill
    # when the user runs /install-gastown from the cloned repo directory.
    #
    # Sentinel file ensures we only sync on first run or when the user explicitly
    # deletes the sentinel to force a re-sync. Avoids trampling user-edited skills.
    local host_claude="/home/gastown/.claude"
    local skills_src="${GASTOWN_HOME}/skills/install-gastown"
    local skills_dst="${host_claude}/skills/install-gastown"
    local sentinel="${skills_dst}/.gastown-synced"

    if [[ ! -d "${skills_src}" ]]; then
        return 0
    fi
    if [[ ! -d "${host_claude}" ]]; then
        warn "Host ~/.claude not mounted — skipping skill sync."
        return 0
    fi
    if [[ -f "${sentinel}" ]]; then
        return 0
    fi

    log "Mirroring install-gastown skill into host ~/.claude/skills/."
    mkdir -p "${skills_dst}"
    cp -f "${skills_src}/SKILL.md" "${skills_dst}/SKILL.md"
    : >"${sentinel}"
}

start_dolt() {
    if [[ -f "${DOLT_PID}" ]] && kill -0 "$(cat "${DOLT_PID}")" 2>/dev/null; then
        log "Dolt already running (pid $(cat "${DOLT_PID}"))."
        return 0
    fi

    log "Starting Dolt on port ${DOLT_PORT}..."
    cd "${DOLT_DATA_DIR}"
    # Dolt's multi-db server. Matches the gt town setup on the host.
    nohup dolt sql-server \
        --host=0.0.0.0 \
        --port="${DOLT_PORT}" \
        --data-dir="${DOLT_DATA_DIR}" \
        >"${DOLT_LOG}" 2>&1 &
    echo $! >"${DOLT_PID}"
    cd "${GASTOWN_HOME}"

    # Give dolt a moment to bind the port before the wizard tries to use it.
    for _ in {1..20}; do
        if (exec 3<>"/dev/tcp/127.0.0.1/${DOLT_PORT}") 2>/dev/null; then
            exec 3<&-; exec 3>&-
            log "Dolt is up."
            return 0
        fi
        sleep 0.25
    done
    die "Dolt did not start in time — check ${DOLT_LOG}"
}

stop_dolt() {
    if [[ -f "${DOLT_PID}" ]]; then
        local pid; pid="$(cat "${DOLT_PID}")"
        if kill -0 "${pid}" 2>/dev/null; then
            log "Stopping Dolt (pid ${pid})..."
            kill "${pid}" 2>/dev/null || true
            wait "${pid}" 2>/dev/null || true
        fi
        rm -f "${DOLT_PID}"
    fi
}

# gt-bot is optional. Starts only if a Telegram bot token is configured.
# If permissions table is empty and OPERATOR_TELEGRAM_CHAT_ID is set, seed
# the operator as admin so the bot comes up functional on first run.
start_gt_bot() {
    local token="${GT_BOT_TOKEN:-${TELEGRAM_BOT_TOKEN:-}}"
    if [[ -z "${token}" ]]; then
        log "gt-bot: no GT_BOT_TOKEN set — skipping (set one in .env to enable)."
        return 0
    fi
    if [[ ! -d "${GT_BOT_DIR}" ]]; then
        warn "gt-bot: ${GT_BOT_DIR} missing — skipping."
        return 0
    fi

    log "gt-bot: initializing Dolt schema..."
    if ! (cd "${GT_BOT_DIR}" && GT_BOT_TOKEN="${token}" node bin/gt-bot init); then
        warn "gt-bot: init failed — skipping start."
        return 0
    fi

    # Seed the operator chat as admin if permissions table is empty.
    if [[ -n "${OPERATOR_TELEGRAM_CHAT_ID:-}" ]]; then
        local count
        count="$(cd "${GT_BOT_DIR}" && node bin/gt-bot perms list 2>/dev/null | grep -c '^[0-9]' || true)"
        if [[ "${count}" == "0" ]]; then
            log "gt-bot: seeding operator chat ${OPERATOR_TELEGRAM_CHAT_ID} as admin."
            (cd "${GT_BOT_DIR}" && node bin/gt-bot perms add "${OPERATOR_TELEGRAM_CHAT_ID}" --role admin --label "operator") || \
                warn "gt-bot: operator seed failed (continuing)."
        fi
    fi

    log "gt-bot: starting on port ${GT_BOT_PORT:-3335}..."
    (cd "${GT_BOT_DIR}" && nohup env GT_BOT_TOKEN="${token}" node bin/gt-bot start \
        >"${GT_BOT_LOG}" 2>&1 &
    echo $! >"${GT_BOT_PID}")
}

stop_gt_bot() {
    if [[ -f "${GT_BOT_PID}" ]]; then
        local pid; pid="$(cat "${GT_BOT_PID}")"
        if kill -0 "${pid}" 2>/dev/null; then
            log "Stopping gt-bot (pid ${pid})..."
            kill "${pid}" 2>/dev/null || true
            wait "${pid}" 2>/dev/null || true
        fi
        rm -f "${GT_BOT_PID}"
    fi
}

trap 'stop_gt_bot; stop_dolt' EXIT

case "${MODE}" in
    wizard)
        ensure_dirs
        ensure_env_file
        sync_skills_to_host
        start_dolt
        start_gt_bot
        log "Launching wizard — run \`gt-wizard --help\` for individual commands."
        exec "${GASTOWN_HOME}/wizard/gt-wizard" init
        ;;
    daemon)
        ensure_dirs
        ensure_env_file
        sync_skills_to_host
        start_dolt
        start_gt_bot
        log "Daemon mode — tailing Dolt + gt-bot logs. Ctrl+C to exit."
        exec tail -F "${DOLT_LOG}" "${GT_BOT_LOG}" 2>/dev/null || exec tail -F "${DOLT_LOG}"
        ;;
    shell)
        ensure_dirs
        exec bash -l
        ;;
    *)
        die "Unknown mode: ${MODE}. Use: wizard | daemon | shell"
        ;;
esac
