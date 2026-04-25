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
DOLT_PORT="${DOLT_PORT:-${GT_DOLT_PORT:-3307}}"
# Mirror DOLT_PORT to GT_DOLT_PORT so gt-bot (which reads GT_DOLT_PORT)
# and the rest of the stack stay in lockstep when the operator overrode
# either name in .env.
export GT_DOLT_PORT="${DOLT_PORT}"
export DOLT_PORT
DOLT_DATA_DIR="${GASTOWN_HOME}/.dolt-data"
# HQ lives inside /gastown/repos so it survives rebuilds via the
# `gastown-repos` named volume. /gastown itself is NOT persisted, so
# installing the HQ directly at GASTOWN_HOME would evaporate on every
# `docker compose up --build`.
HQ_ROOT="${GT_TOWN_ROOT:-${GASTOWN_HOME}/repos/hq}"
# Export so every child process (gt install, gt start, gt-bot) sees it.
export GT_TOWN_ROOT="${HQ_ROOT}"
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

# `gt install` calls into Dolt to initialize identity metadata, and Dolt
# refuses to make commits unless user.name + user.email are configured.
# The .env file carries GIT_USER_NAME / GIT_USER_EMAIL for exactly this;
# we push them into Dolt's global config unconditionally on every boot
# (idempotent — `dolt config --global --add` overwrites without error).
# Fallbacks cover the case where the user never filled those in so gt
# install still gets SOMETHING to commit as.
ensure_dolt_identity() {
    local name="${GIT_USER_NAME:-gastown}"
    local email="${GIT_USER_EMAIL:-gastown@localhost}"
    log "Configuring Dolt identity (${name} <${email}>)."
    dolt config --global --add user.name "${name}"  >/dev/null 2>&1 || true
    dolt config --global --add user.email "${email}" >/dev/null 2>&1 || true
}

# /var/run/docker.sock is bind-mounted from the host (see docker-compose.yml).
# Inside the container the file's GID is whatever the host assigned to its
# docker group, which is rarely the same number as our build-time DOCKER_GID.
# When they don't match, gastown can't talk to the daemon and `docker compose`
# fails with a confusing EACCES. Detect that here and tell the operator how
# to fix it (rebuild with --build-arg DOCKER_GID=...). The mount itself is
# optional — silently no-op if the operator opted out.
check_docker_access() {
    local sock=/var/run/docker.sock
    if [[ ! -S "${sock}" ]]; then
        log "docker socket not mounted — skipping daemon access check."
        return 0
    fi
    if docker version --format '{{.Server.Version}}' >/dev/null 2>&1; then
        log "docker socket reachable (daemon: $(docker version --format '{{.Server.Version}}' 2>/dev/null))."
        return 0
    fi
    local sock_gid container_gid
    sock_gid="$(stat -c '%g' "${sock}" 2>/dev/null || echo unknown)"
    container_gid="$(getent group docker | cut -d: -f3 || echo unknown)"
    warn "docker socket mounted but unreachable (sock GID=${sock_gid}, in-container docker group GID=${container_gid})."
    warn "Rebuild with: docker compose build --build-arg DOCKER_GID=${sock_gid}"
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

    # `gt-bot init` creates the gt_bot DB + permissions table. If the
    # Dolt identity isn't set, it can silently succeed but never commit
    # the schema — leaving a phantom DB that disappears on the next
    # server restart. Retry up to 3 times, and verify the permissions
    # table is present before declaring init done.
    log "gt-bot: initializing Dolt schema..."
    local attempt=0
    while (( attempt < 3 )); do
        attempt=$(( attempt + 1 ))
        if (cd "${GT_BOT_DIR}" && GT_BOT_TOKEN="${token}" node bin/gt-bot init) \
           && _gt_bot_has_permissions_table; then
            log "gt-bot: schema verified."
            break
        fi
        warn "gt-bot: init attempt ${attempt} did not leave a usable permissions table — retrying."
        sleep 2
    done
    if ! _gt_bot_has_permissions_table; then
        warn "gt-bot: permissions table still missing after 3 attempts — skipping start."
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

# If the user set GT_BOT_TOKEN but not OPERATOR_TELEGRAM_CHAT_ID, poll
# Telegram's getUpdates so the first message they send to the bot auto-
# fills the chat id in .env. Needed because default CMD is `daemon`, so
# the interactive wizard (which also offers this) may never be run.
# Stdlib-only: curl + jq, both apt-installed in the Dockerfile.
auto_detect_operator_chat_id() {
    local token="${GT_BOT_TOKEN:-${TELEGRAM_BOT_TOKEN:-}}"
    if [[ -z "${token}" ]]; then
        return 0
    fi
    if [[ -n "${OPERATOR_TELEGRAM_CHAT_ID:-}" ]]; then
        return 0
    fi

    log "Auto-detecting operator chat id — open Telegram and message your bot within 90s."
    log "(The first message I see from any user becomes OPERATOR_TELEGRAM_CHAT_ID.)"

    local base_url="https://api.telegram.org/bot${token}"
    local baseline_resp
    baseline_resp=$(curl -fsS --max-time 10 "${base_url}/getUpdates?offset=-1" 2>/dev/null || true)
    if [[ -z "${baseline_resp}" ]] || [[ "$(echo "${baseline_resp}" | jq -r '.ok // false')" != "true" ]]; then
        warn "Could not reach Telegram (bad token or no network). Skipping auto-detect."
        return 0
    fi
    local offset
    offset=$(( $(echo "${baseline_resp}" | jq -r '(.result | map(.update_id) | max) // 0') + 1 ))

    local deadline
    deadline=$(( $(date +%s) + 90 ))
    while (( $(date +%s) < deadline )); do
        local remaining=$(( deadline - $(date +%s) ))
        local poll_s=$(( remaining < 25 ? remaining : 25 ))
        (( poll_s < 1 )) && poll_s=1

        local resp
        resp=$(curl -fsS --max-time $(( poll_s + 10 )) \
                    "${base_url}/getUpdates?offset=${offset}&timeout=${poll_s}" 2>/dev/null || true)
        if [[ -z "${resp}" ]]; then
            sleep 1
            continue
        fi

        local chat_id
        chat_id=$(echo "${resp}" | jq -r '
            .result[]? | (.message, .edited_message, .channel_post)?
            | select(. != null) | .chat.id' | head -n 1)
        if [[ -n "${chat_id}" && "${chat_id}" != "null" ]]; then
            log "Detected operator chat id: ${chat_id}. Writing to ${ENV_FILE}."
            # Append only if the key is not already present (paranoid idempotency).
            if ! grep -qE '^\s*OPERATOR_TELEGRAM_CHAT_ID\s*=' "${ENV_FILE}"; then
                printf '\nOPERATOR_TELEGRAM_CHAT_ID=%s\n' "${chat_id}" >> "${ENV_FILE}"
            else
                # Replace existing empty value in-place.
                sed -i "s|^\(\s*OPERATOR_TELEGRAM_CHAT_ID\s*=\).*|\1${chat_id}|" "${ENV_FILE}"
            fi
            export OPERATOR_TELEGRAM_CHAT_ID="${chat_id}"
            return 0
        fi

        # Advance the offset so we don't reprocess what we just peeked at.
        local max_seen
        max_seen=$(echo "${resp}" | jq -r '(.result | map(.update_id) | max) // empty')
        if [[ -n "${max_seen}" ]]; then
            offset=$(( max_seen + 1 ))
        fi
    done

    warn "No message received within 90s. Set OPERATOR_TELEGRAM_CHAT_ID manually in ${ENV_FILE} and restart the container."
}

# Confirm the gt_bot.permissions table is actually queryable via the same
# TCP path the bot uses. Mirrors verify.py's _gt_bot_db_exists check.
_gt_bot_has_permissions_table() {
    (cd "${GT_BOT_DIR}" && node -e "
        const mysql = require('mysql2/promise');
        (async () => {
            try {
                const c = await mysql.createConnection({
                    host:'127.0.0.1',port:${DOLT_PORT},user:'root',password:'',database:'gt_bot'
                });
                const [rows] = await c.query(\"SHOW TABLES LIKE 'permissions'\");
                await c.end();
                process.exit(rows.length ? 0 : 1);
            } catch (e) { process.exit(1); }
        })();" >/dev/null 2>&1)
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

# Create (or refresh) the Gas Town HQ at HQ_ROOT so `gt mail send mayor/`
# and friends have a workspace to operate in. Idempotent via `--force` —
# which re-runs install in an existing HQ without clobbering town.json or
# rigs.json, so this is safe on every boot. HQ_ROOT sits inside
# /gastown/repos so the `gastown-repos` named volume persists it across
# `docker compose up --build`.
ensure_hq() {
    mkdir -p "${HQ_ROOT}"
    if [[ -f "${HQ_ROOT}/CLAUDE.md" ]]; then
        log "HQ already installed at ${HQ_ROOT}."
        return 0
    fi

    log "Installing Gas Town HQ at ${HQ_ROOT}..."
    if ! gt install "${HQ_ROOT}" \
            --name gastown \
            --dolt-port "${DOLT_PORT}" \
            --force; then
        die "gt install failed — see output above. The stack will not be usable until this is fixed."
    fi

    if [[ ! -f "${HQ_ROOT}/CLAUDE.md" ]]; then
        die "gt install returned 0 but ${HQ_ROOT}/CLAUDE.md is missing."
    fi
    log "HQ ready at ${HQ_ROOT}."
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
        cd "${HQ_ROOT}"
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
        ensure_dolt_identity
        check_docker_access
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
        ensure_dolt_identity
        check_docker_access
        auto_detect_operator_chat_id
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
