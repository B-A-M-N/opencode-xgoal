#!/usr/bin/env bash
# OpenCode-XGoal — live activation acceptance harness.
#
# The gate this proves:
#
#   A user sets a goal once. The plugin then drives the session through as many
#   native turns as the objective needs, and the controller verifies completion
#   against observed evidence. No further human prompt is sent.
#
# Everything here goes through the public surfaces a user or the TUI uses:
# the session API and the plugin's server RPC. The harness never writes a goal
# row directly and never prompts the model after creating the goal.
#
# It uses an isolated server, workspace and database in a temporary directory,
# so it cannot disturb the user's real sessions.
#
# Usage:
#   bash scripts/parity.sh
#
# Env:
#   OPENCODE_BIN          opencode 2 executable (default: /home/bamn/.opencode/bin/opencode2)
#   XGOAL_TEST_CONFIG     isolated XDG_CONFIG_HOME containing the model config
#   XGOAL_ACCEPT_PORT     server port (default: 43299)
#   XGOAL_ACCEPT_TIMEOUT  seconds per goal (default: 420)
#   XGOAL_ACCEPT_KEEP=1   keep the workspace and logs after the run
set -uo pipefail

export PATH="/home/bamn/.bun/bin:$PATH"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OC="${OPENCODE_BIN:-/home/bamn/.opencode/bin/opencode2}"
TC="${XGOAL_TEST_CONFIG:-/home/bamn/.hermes/cache/scratch/xgoal-testcfg}"
PORT="${XGOAL_ACCEPT_PORT:-43299}"
HOST="127.0.0.1"
TIMEOUT="${XGOAL_ACCEPT_TIMEOUT:-420}"
KEEP="${XGOAL_ACCEPT_KEEP:-0}"

DIR="$(mktemp -d "${TMPDIR:-/tmp}/xgoal-accept.XXXXXX")" || exit 1
WS="$DIR/work"
DB="$DIR/goals.db"
LOG="$DIR/harness.log"
SERVER_OUT="$DIR/server.out"
mkdir -p "$WS"

PASS=0
FAIL=0
SERVER_PID=""

# Kill the server and everything it spawned. A model turn can outlive the
# server's own SIGTERM, and an orphaned turn will keep writing into the
# workspace (or, worse, the repository) after the harness believes it is done.
kill_tree() {
  local signal="$1" pid="$2" child
  for child in $(pgrep -P "$pid" 2>/dev/null); do
    kill_tree "$signal" "$child"
  done
  kill "-$signal" "$pid" 2>/dev/null || true
}

cleanup() {
  if [ -n "$SERVER_PID" ]; then
    kill_tree TERM "$SERVER_PID"
    for _ in $(seq 1 20); do
      kill -0 "$SERVER_PID" 2>/dev/null || break
      sleep 0.25
    done
    kill_tree KILL "$SERVER_PID"
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  if [ "$KEEP" = "1" ]; then
    echo "kept: $DIR"
  else
    rm -rf "$DIR"
  fi
}
trap cleanup EXIT

report() {
  local name="$1" status="$2" detail="${3:-}"
  if [ "$status" = "PASS" ]; then
    PASS=$((PASS + 1))
    echo "  PASS  $name"
  else
    FAIL=$((FAIL + 1))
    echo "  FAIL  $name${detail:+ — $detail}"
  fi
}

# Parse a JSON field from stdin. The RPC envelope is {"output": {...}}.
json() {
  python3 -c '
import json, sys
path = sys.argv[1].split(".")
try:
    value = json.load(sys.stdin)
except Exception:
    print("")
    raise SystemExit(0)
for key in path:
    if isinstance(value, dict):
        value = value.get(key)
    else:
        value = None
        break
print("" if value is None else value)
' "$1"
}

rpc() {
  local method="$1" body="$2"
  curl -s -m 30 -u "opencode:$PW" -X POST \
    "http://$HOST:$PORT/api/rpc/local.opencode-xgoal/$method" \
    -H 'content-type: application/json' \
    -d "{\"input\":$body}"
}

session_get() {
  curl -s -m 30 -u "opencode:$PW" "http://$HOST:$PORT/api/session/$1"
}

# Create a session and run one trivial turn so the plugin loads for it.
# This is the only human-equivalent prompt; everything after `goal.create`
# is driven by the plugin.
open_session() {
  local title="$1"
  local sid
  sid=$(curl -s -m 30 -u "opencode:$PW" -X POST "http://$HOST:$PORT/api/session" \
    -H 'content-type: application/json' \
    -d "{\"title\":\"$title\"}" | json data.id)
  if [ -z "$sid" ]; then
    echo ""
    return
  fi
  curl -s -m 30 -u "opencode:$PW" -X POST \
    "http://$HOST:$PORT/api/session/$sid/synthetic" \
    -H 'content-type: application/json' \
    -d "{\"id\":\"msg_warmup_${sid}\",\"text\":\"Reply with exactly: ready. Do not use any tools.\",\"delivery\":\"queue\"}" >/dev/null
  # Wait until the plugin has registered its RPC for this session.
  local i
  for i in $(seq 1 90); do
    if rpc goal.status "{\"sessionID\":\"$sid\"}" | grep -q '"output"'; then
      echo "$sid"
      return
    fi
    sleep 1
  done
  echo ""
}

goal_field() {
  # goal_field <sessionID> <field>
  rpc goal.status "{\"sessionID\":\"$1\"}" | json "output.goal.$2"
}

wait_complete() {
  local sid="$1" label="$2"
  local started now status
  started=$(date +%s)
  while :; do
    status=$(goal_field "$sid" status)
    if [ "$status" = "complete" ]; then
      return 0
    fi
    # A superseded/cancelled goal can never complete; fail fast.
    case "$status" in
      superseded|stalled|blocked|budgetLimited|usageLimited)
        echo "  ($label stopped in status: $status)"
        return 1
        ;;
    esac
    now=$(date +%s)
    if [ $((now - started)) -ge "$TIMEOUT" ]; then
      echo "  ($label timed out in status: ${status:-<none>})"
      return 1
    fi
    sleep 2
  done
}

# ---------------------------------------------------------------------------
echo "OpenCode-XGoal acceptance harness"
echo "workspace: $WS"
echo ""

echo "Building the plugin..."
( cd "$ROOT" && bun run build >/dev/null 2>&1 ) || {
  echo "build failed"
  exit 1
}

echo "Starting an isolated OpenCode 2 server..."
# `exec` matters: without it, $! is the wrapping subshell, and killing it leaves
# the real server (and any model turn) running as an orphan.
(
  cd "$WS" || exit 1
  exec env XDG_CONFIG_HOME="$TC" \
    XGOAL_DB="$DB" \
    XGOAL_WORKSPACE="$WS" \
    XGOAL_HARNESS_LOG="$LOG" \
    XGOAL_SWEEP_MS=5000 \
    "$OC" serve --hostname "$HOST" --port "$PORT" --log-level warn >"$SERVER_OUT" 2>&1
) &
SERVER_PID=$!

PW=""
for _ in $(seq 1 120); do
  PW=$(grep -m1 '^server password ' "$SERVER_OUT" 2>/dev/null | awk '{print $3}')
  [ -n "$PW" ] && break
  sleep 0.5
done
if [ -z "$PW" ]; then
  echo "server did not start; see $SERVER_OUT"
  exit 1
fi

# ---------------------------------------------------------------------------
echo ""
echo "Scenario 1: /goal <objective> is driven to verified completion"
SID=$(open_session "acceptance-1")
if [ -z "$SID" ]; then
  report "session established" FAIL "could not create a session or load the plugin"
else
  report "session established" PASS

  RESP=$(rpc goal.create "{\"sessionID\":\"$SID\",\"objective\":\"Create a file called a.txt containing exactly: alpha. Create a file called b.txt containing exactly: bravo. When both files exist with exactly that content, propose completion.\"}")
  GEN=$(echo "$RESP" | json output.goal.generation)
  STATUS=$(echo "$RESP" | json output.goal.status)
  ACTION=$(echo "$RESP" | json output.drive.action)

  if [ "$STATUS" = "active" ] && [ "$GEN" = "1" ]; then
    report "goal created with derived criteria" PASS
  else
    report "goal created with derived criteria" FAIL "status=$STATUS generation=$GEN response=$RESP"
  fi
  if [ "$ACTION" = "admitted" ]; then
    report "creation scheduled native execution" PASS
  else
    report "creation scheduled native execution" FAIL "drive=$ACTION"
  fi

  # No prompt is sent from here on. The plugin owns the loop.
  if wait_complete "$SID" "goal 1"; then
    report "goal 1 reached verified completion" PASS
  else
    report "goal 1 reached verified completion" FAIL "status=$(goal_field "$SID" status)"
  fi

  A_OK=0; B_OK=0
  [ "$(cat "$WS/a.txt" 2>/dev/null)" = "alpha" ] && A_OK=1
  [ "$(cat "$WS/b.txt" 2>/dev/null)" = "bravo" ] && B_OK=1
  if [ "$A_OK" = "1" ] && [ "$B_OK" = "1" ]; then
    report "artifacts match the objective" PASS
  else
    report "artifacts match the objective" FAIL "a.txt='$(cat "$WS/a.txt" 2>/dev/null)' b.txt='$(cat "$WS/b.txt" 2>/dev/null)'"
  fi

  MET=$(rpc goal.status "{\"sessionID\":\"$SID\"}" | python3 -c '
import json,sys
d=json.load(sys.stdin)
g=(d.get("output") or {}).get("goal") or {}
cs=g.get("criteria") or []
print("yes" if cs and all(c.get("met") for c in cs) else "no")
')
  if [ "$MET" = "yes" ]; then
    report "criteria readout agrees with the proof" PASS
  else
    report "criteria readout agrees with the proof" FAIL "not every criterion is marked met"
  fi
fi

# ---------------------------------------------------------------------------
echo ""
echo "Scenario 2: a completed goal can be followed immediately by another"
SID2=$(open_session "acceptance-2")
if [ -z "$SID2" ]; then
  report "second session established" FAIL "could not create a session or load the plugin"
else
  report "second session established" PASS

  # First goal for this session.
  rpc goal.create "{\"sessionID\":\"$SID2\",\"objective\":\"Create a file called one.txt containing exactly: one. When it exists, propose completion.\"}" >/dev/null
  if wait_complete "$SID2" "goal 2a"; then
    report "preceding goal completed" PASS
  else
    report "preceding goal completed" FAIL "status=$(goal_field "$SID2" status)"
  fi

  # Immediately create a new goal in the same session. It must get the next
  # generation (not reuse generation 1) and must actually be driven.
  RESP2=$(rpc goal.create "{\"sessionID\":\"$SID2\",\"objective\":\"Create a file called two.txt containing exactly: two. When it exists, propose completion.\"}")
  GEN2=$(echo "$RESP2" | json output.goal.generation)
  ACTION2=$(echo "$RESP2" | json output.drive.action)
  if [ "$GEN2" = "2" ]; then
    report "post-completion goal gets the next generation" PASS
  else
    report "post-completion goal gets the next generation" FAIL "generation=$GEN2"
  fi
  if [ "$ACTION2" = "admitted" ]; then
    report "post-completion goal is driven immediately" PASS
  else
    report "post-completion goal is driven immediately" FAIL "drive=$ACTION2"
  fi
  if wait_complete "$SID2" "goal 2b"; then
    report "second goal reached verified completion" PASS
  else
    report "second goal reached verified completion" FAIL "status=$(goal_field "$SID2" status)"
  fi
  if [ "$(cat "$WS/two.txt" 2>/dev/null)" = "two" ]; then
    report "second goal's artifact is correct" PASS
  else
    report "second goal's artifact is correct" FAIL "two.txt='$(cat "$WS/two.txt" 2>/dev/null)'"
  fi
fi

# ---------------------------------------------------------------------------
echo ""
echo "Scenario 3: replacement is generation-checked and drives the new goal"
SID3=$(open_session "acceptance-3")
if [ -z "$SID3" ]; then
  report "replacement session established" FAIL "could not create a session or load the plugin"
else
  report "replacement session established" PASS

  rpc goal.create "{\"sessionID\":\"$SID3\",\"objective\":\"Create a file called old.txt containing exactly: old. When it exists, propose completion.\"}" >/dev/null
  # Replace while generation 1 is active. The stale confirmation (still naming
  # generation 1) must be refused after the replacement.
  RESP=$(rpc goal.replace "{\"sessionID\":\"$SID3\",\"objective\":\"Create a file called new.txt containing exactly: new. When it exists, propose completion.\",\"expectedGeneration\":1}")
  GEN3=$(echo "$RESP" | json output.goal.generation)
  ACTION3=$(echo "$RESP" | json output.drive.action)
  STALE=$(rpc goal.replace "{\"sessionID\":\"$SID3\",\"objective\":\"Create a file called stale.txt containing exactly: stale.\",\"expectedGeneration\":1}" | json output.error)

  if [ "$GEN3" = "2" ] && [ "$ACTION3" = "admitted" ]; then
    report "replacement creates and drives generation 2" PASS
  else
    report "replacement creates and drives generation 2" FAIL "generation=$GEN3 drive=$ACTION3"
  fi
  if [ -n "$STALE" ]; then
    report "a stale replacement is refused" PASS
  else
    report "a stale replacement is refused" FAIL "stale replacement was accepted"
  fi
  if wait_complete "$SID3" "goal 3"; then
    report "replacement goal reached verified completion" PASS
  else
    report "replacement goal reached verified completion" FAIL "status=$(goal_field "$SID3" status)"
  fi
  if [ "$(cat "$WS/new.txt" 2>/dev/null)" = "new" ]; then
    report "replacement goal's artifact is correct" PASS
  else
    report "replacement goal's artifact is correct" FAIL "new.txt='$(cat "$WS/new.txt" 2>/dev/null)'"
  fi
fi

# ---------------------------------------------------------------------------
echo ""
echo "============================================"
echo " Results: $PASS passed, $FAIL failed"
echo "============================================"
[ "$FAIL" -eq 0 ]
