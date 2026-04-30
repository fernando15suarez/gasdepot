#!/usr/bin/env bash
# Smoke test the teleTalk lifecycle helpers in entrypoint.sh.
#
# Goal: regression coverage so the next image rebuild can't silently
# break teleTalk startup. We verify the bash logic of start_teletalk
# and stop_teletalk in isolation — no docker, no real telegram, no
# network. Pure bash + a no-op node child process for the happy path.
#
# Scenarios:
#   A) TELETALK_BOT_TOKEN unset/empty -> start_teletalk returns 0,
#      writes the "no TELETALK_BOT_TOKEN set" log line, and never
#      creates a pidfile.
#   B) Token set + a fake bot.js + node_modules stub at TELETALK_DIR
#      -> start_teletalk launches the child, writes the pidfile, and
#      stop_teletalk kills the child + removes the pidfile.
#
# Usage: bash test/e2e/teletalk-smoke.sh
# Exit:  0 = pass, non-zero = fail (with diagnostic on stderr).

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
ENTRYPOINT="$REPO_ROOT/entrypoint.sh"

log()  { printf '[teletalk-smoke] %s\n' "$*"; }
fail() { printf '[teletalk-smoke] FAIL: %s\n' "$*" >&2; exit 1; }

[ -f "$ENTRYPOINT" ] || fail "entrypoint.sh not found at $ENTRYPOINT"
command -v node >/dev/null || fail "node is required for the fake teleTalk child"

TMP="$(mktemp -d)"
PID_TO_KILL=""
cleanup() {
    if [[ -n "$PID_TO_KILL" ]] && kill -0 "$PID_TO_KILL" 2>/dev/null; then
        kill "$PID_TO_KILL" 2>/dev/null || true
    fi
    rm -rf "$TMP"
}
trap cleanup EXIT

# Extract just start_teletalk + stop_teletalk into a sourceable lib.
# We can't `source entrypoint.sh` directly: it has top-level traps and
# an `exec` in `case "${MODE}"` that would run on import. Slicing each
# function out by `^name() ... ^}` keeps the test independent of the
# rest of the file. Stub out log/warn so the functions don't depend on
# the colour-prefixed helpers defined elsewhere in entrypoint.sh.
extract_fn() {
    local name="$1" out="$2"
    sed -n "/^${name}()/,/^}$/p" "$ENTRYPOINT" > "$out"
    [ -s "$out" ] || fail "could not extract ${name} from $ENTRYPOINT"
}

LIB="$TMP/teletalk-fns.sh"
extract_fn start_teletalk "$TMP/start.fn"
extract_fn stop_teletalk  "$TMP/stop.fn"
{
    echo 'log()  { printf "[stub-log] %s\n" "$*"; }'
    echo 'warn() { printf "[stub-warn] %s\n" "$*" >&2; }'
    cat "$TMP/start.fn"
    cat "$TMP/stop.fn"
} > "$LIB"

# ---------------------------------------------------------------------
# Scenario A — disabled when token empty
# ---------------------------------------------------------------------
log "Scenario A: TELETALK_BOT_TOKEN empty -> skip path"

A_OUT="$TMP/scenarioA.out"
A_LOG="$TMP/scenarioA.tt.log"
A_PID="$TMP/scenarioA.tt.pid"
(
    unset TELETALK_BOT_TOKEN
    export TELETALK_DIR="$TMP/teletalk-A-missing"
    export TELETALK_LOG="$A_LOG"
    export TELETALK_PID="$A_PID"
    source "$LIB"
    start_teletalk
) > "$A_OUT" 2>&1 || fail "Scenario A: start_teletalk returned non-zero"

grep -q 'no TELETALK_BOT_TOKEN set' "$A_OUT" \
    || fail "Scenario A: expected 'no TELETALK_BOT_TOKEN set' in output, got: $(cat "$A_OUT")"
[ ! -e "$A_PID" ] || fail "Scenario A: pidfile $A_PID should not have been created"
[ ! -e "$A_LOG" ] || fail "Scenario A: log file $A_LOG should not have been created"

log "Scenario A: PASS"

# ---------------------------------------------------------------------
# Scenario B — happy path with a fake token + fake bot.js
# ---------------------------------------------------------------------
log "Scenario B: token set + fake bot.js -> start, then stop"

FAKE_DIR="$TMP/teletalk-B"
mkdir -p "$FAKE_DIR/node_modules"
# A trivial no-op bot: idle until killed. start_teletalk redirects the
# child's stdout+stderr into TELETALK_LOG, so the boot line below is
# how we confirm the child actually executed.
cat >"$FAKE_DIR/bot.js" <<'JS'
process.stdout.write('fake teletalk: up\n');
setInterval(() => {}, 1000);
JS

B_OUT="$TMP/scenarioB.out"
B_LOG="$TMP/scenarioB.tt.log"
B_PID="$TMP/scenarioB.tt.pid"
(
    export TELETALK_BOT_TOKEN=fake-1234
    export OPERATOR_TELEGRAM_CHAT_ID=999
    export TELETALK_DIR="$FAKE_DIR"
    export TELETALK_LOG="$B_LOG"
    export TELETALK_PID="$B_PID"
    source "$LIB"
    start_teletalk
) > "$B_OUT" 2>&1 || fail "Scenario B: start_teletalk returned non-zero. Output: $(cat "$B_OUT")"

grep -q 'teletalk: starting' "$B_OUT" \
    || fail "Scenario B: expected 'teletalk: starting' in output, got: $(cat "$B_OUT")"

# The child writes its pidfile from inside a backgrounded subshell, so
# poll briefly instead of assuming it's there the instant start returns.
for _ in $(seq 1 40); do
    [ -s "$B_PID" ] && break
    sleep 0.1
done
[ -s "$B_PID" ] || fail "Scenario B: pidfile $B_PID was not written"
PID_TO_KILL="$(cat "$B_PID")"
[[ "$PID_TO_KILL" =~ ^[0-9]+$ ]] || fail "Scenario B: pidfile contained non-numeric: $PID_TO_KILL"
kill -0 "$PID_TO_KILL" 2>/dev/null || fail "Scenario B: pid $PID_TO_KILL not alive after start"

# Wait for the child to actually flush its boot line into the log file.
for _ in $(seq 1 40); do
    [ -s "$B_LOG" ] && break
    sleep 0.1
done
grep -q 'fake teletalk: up' "$B_LOG" \
    || fail "Scenario B: log $B_LOG missing child's boot line. Contents: $(cat "$B_LOG" 2>/dev/null || echo '<empty>')"

# Now exercise stop_teletalk and confirm it cleans up.
(
    export TELETALK_PID="$B_PID"
    source "$LIB"
    stop_teletalk
) > "$TMP/scenarioB.stop.out" 2>&1 || fail "Scenario B: stop_teletalk returned non-zero"

# The kill is async-ish; give the kernel a beat to reap.
for _ in $(seq 1 20); do
    kill -0 "$PID_TO_KILL" 2>/dev/null || break
    sleep 0.1
done
if kill -0 "$PID_TO_KILL" 2>/dev/null; then
    fail "Scenario B: pid $PID_TO_KILL still alive after stop_teletalk"
fi
[ ! -e "$B_PID" ] || fail "Scenario B: pidfile $B_PID should be removed"
PID_TO_KILL=""

log "Scenario B: PASS"

log "PASS"
