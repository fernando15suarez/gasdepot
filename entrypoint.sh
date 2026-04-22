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
GT_START_LOG="${GASTOWN_HOME}/logs/gt-start.log"
GT_START_PID="${GASTOWN_HOME}/logs/gt-start.pid"
MAYOR_SESSION="hq-mayor"
MAYOR_WAIT_SECONDS="${MAYOR_WAIT_SECONDS:-30}"

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

# Create (or refresh) the Gas Town HQ at /gastown so `gt mail send mayor/`
# and friends have a workspace to operate in. Idempotent via `--force` —
# which re-runs install in an existing HQ without clobbering town.json or
# rigs.json, so this is safe on every boot.
ensure_hq() {
    if [[ -f "${GASTOWN_HOME}/CLAUDE.md" ]]; then
        log "HQ already installed at ${GASTOWN_HOME}."
        return 0
    fi

    log "Installing Gas Town HQ at ${GASTOWN_HOME}..."
    if ! gt install "${GASTOWN_HOME}" \
            --name gastown \
            --dolt-port "${DOLT_PORT}" \
            --force; then
        die "gt install failed — see output above. The stack will not be usable until this is fixed."
    fi

    if [[ ! -f "${GASTOWN_HOME}/CLAUDE.md" ]]; then
        die "gt install returned 0 but ${GASTOWN_HOME}/CLAUDE.md is missing."
    fi
    log "HQ ready."
}

# Launch Deacon + Mayor via `gt start`, in the background so tmux sessions
# spawn and we can tail the daemon's logs alongside Dolt/gt-bot. We wait
# briefly for the Mayor tmux session to show up — if it doesn't, we warn
# rather than die, so the daemon stays up and the user can investigate.
start_mayor() {
    if tmux has-session -t "${MAYOR_SESSION}" 2>/dev/null; then
        log "Mayor session '${MAYOR_SESSION}' already running."
        return 0
    fi

    log "Launching Deacon + Mayor via gt start..."
    (
        cd "${GASTOWN_HOME}"
        nohup gt start >"${GT_START_LOG}" 2>&1 &
        echo $! >"${GT_START_PID}"
    )

    local waited=0
    while (( waited < MAYOR_WAIT_SECONDS )); do
        if tmux has-session -t "${MAYOR_SESSION}" 2>/dev/null; then
            log "Mayor is up (tmux session '${MAYOR_SESSION}')."
            return 0
        fi
        sleep 1
        waited=$(( waited + 1 ))
    done

    warn "Mayor session '${MAYOR_SESSION}' did not appear within ${MAYOR_WAIT_SECONDS}s."
    warn "Check ${GT_START_LOG} and run \`gt-wizard verify\` once it settles."
}

# Graceful shutdown: prefer `gt shutdown` so polecats + worktrees are cleaned
# up properly. Fall back to killing the `gt start` pid and any Mayor tmux
# session directly if shutdown isn't available or times out.
stop_mayor() {
    if command -v gt >/dev/null 2>&1 && [[ -f "${GASTOWN_HOME}/CLAUDE.md" ]]; then
        log "Stopping Gas Town (gt shutdown)..."
        (cd "${GASTOWN_HOME}" && gt shutdown --yes) 2>/dev/null || \
            warn "gt shutdown failed — falling back to direct kill."
    fi

    if [[ -f "${GT_START_PID}" ]]; then
        local pid; pid="$(cat "${GT_START_PID}")"
        if kill -0 "${pid}" 2>/dev/null; then
            kill "${pid}" 2>/dev/null || true
        fi
        rm -f "${GT_START_PID}"
    fi

    if tmux has-session -t "${MAYOR_SESSION}" 2>/dev/null; then
        tmux kill-session -t "${MAYOR_SESSION}" 2>/dev/null || true
    fi
}

trap 'stop_mayor; stop_gt_bot; stop_dolt' EXIT

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
        # Order matters:
        #   1. Dolt — everything else needs it.
        #   2. ensure_hq — `gt install` stamps the workspace on Dolt and must
        #      come before Mayor tries to read it. Depends on Dolt only.
        #   3. gt-bot — needs Dolt for its own gt_bot DB, does NOT need HQ.
        #   4. Mayor — needs HQ to exist; is the thing gt-bot mails into.
        start_dolt
        ensure_hq
        start_gt_bot
        start_mayor
        log "Daemon mode — tailing Dolt + gt-bot + gt-start logs. Ctrl+C to exit."
        touch "${DOLT_LOG}" "${GT_BOT_LOG}" "${GT_START_LOG}"
        exec tail -F "${DOLT_LOG}" "${GT_BOT_LOG}" "${GT_START_LOG}"
        ;;
    shell)
        ensure_dirs
        exec bash -l
        ;;
    *)
        die "Unknown mode: ${MODE}. Use: wizard | daemon | shell"
        ;;
esac
