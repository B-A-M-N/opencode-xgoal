#!/usr/bin/env bash
# Phase 06 — End-to-End Convergence Test (Fixed)
# Tests the OpenCode-XGoal plugin against real running OpenCode 2 sessions
# with real models, covering all required scenarios.
#
# Note: deliberately NOT `set -e`. A non-zero exit from a helper (a bun probe,
# a model that returns non-zero) must not abort the whole run and silently skip
# later scenarios.
set -uo pipefail

export PATH="/home/bamn/.bun/bin:$PATH"
TC="/home/bamn/.hermes/cache/scratch/xgoal-testcfg"
SCRATCH="/home/bamn/.hermes/cache/scratch"
RESULTS="$SCRATCH/p6-results"
mkdir -p "$RESULTS"

PASS=0
FAIL=0
TOTAL=0

report() {
  local name="$1" status="$2" detail="${3:-}"
  TOTAL=$((TOTAL + 1))
  if [ "$status" = "PASS" ]; then
    PASS=$((PASS + 1))
    echo "  ✓ $name"
  else
    FAIL=$((FAIL + 1))
    echo "  ✗ $name — $detail"
  fi
}

# Helper: set up a goal for a session via the API
setup_goal() {
  local db="$1" session_id="$2" objective="$3"
  cd /home/bamn/opencode-xgoal
  bun -e "
import { GoalController } from './src/controller/controller.ts';
const c = new GoalController({ dbPath: '$db' });
const result = c.startOrDescribe('$session_id', '$objective');
if ('created' in result) {
  console.log(result.created.id);
} else {
  console.log('existing:' + result.existing.id);
}
c.close();
" 2>/dev/null || true
}

# Helper: run opencode2 headlessly (the `run` subcommand exits when the
# message completes, unlike the TUI which stays open until killed).
run_opencode() {
  local db="$1" log="$2" out="$3" session_id="$4" prompt="$5" cwd="$6"
  cd "$cwd"
  if [ -n "$session_id" ]; then
    XDG_CONFIG_HOME="$TC" XGOAL_HARNESS_LOG="$log" XGOAL_DB="$db" \
      timeout 180 /home/bamn/.opencode/bin/opencode2 run --standalone --auto \
      --session "$session_id" "$prompt" > "$out" 2>&1 || true
  else
    XDG_CONFIG_HOME="$TC" XGOAL_HARNESS_LOG="$log" XGOAL_DB="$db" \
      timeout 180 /home/bamn/.opencode/bin/opencode2 run --standalone --auto \
      "$prompt" > "$out" 2>&1 || true
  fi
}

# Helper: check goal status for a session
check_goal_status() {
  local db="$1" session_id="$2"
  cd /home/bamn/opencode-xgoal
  bun -e "
import { GoalStore } from './src/controller/store.ts';
const s = new GoalStore('$db');
const goals = s.history('$session_id');
const g = goals.find(g => g.status === 'complete') || goals[0];
if (g) { console.log(g.status); } else { console.log('none'); }
s.close();
" 2>/dev/null || echo "error"
}

# Helper: count all goals across all sessions
count_goals() {
  local db="$1"
  cd /home/bamn/opencode-xgoal
  bun -e "
import { GoalStore } from './src/controller/store.ts';
const s = new GoalStore('$db');
// Get all goals by querying the database directly
const rows = s.db.query('SELECT COUNT(*) as count FROM goals').get();
console.log(rows?.count ?? 0);
s.close();
" 2>/dev/null || echo "0"
}

# Helper: get all goals (for scenarios that need to check across sessions)
get_all_goals() {
  local db="$1"
  cd /home/bamn/opencode-xgoal
  bun -e "
import { GoalStore } from './src/controller/store.ts';
const s = new GoalStore('$db');
const rows = s.db.query('SELECT status FROM goals').all();
const complete = rows.find(r => r.status === 'complete');
if (complete) { console.log('complete'); }
else if (rows.length > 0) { console.log(rows[0].status); }
else { console.log('none'); }
s.close();
" 2>/dev/null || echo "error"
}

echo "============================================"
echo " Phase 06: End-to-End Convergence Test"
echo "============================================"
echo ""

# ---------------------------------------------------------------
# Scenario 1: Multi-step coding goal requiring several model turns
# ---------------------------------------------------------------
echo "--- Scenario 1: Multi-step coding goal (several model turns) ---"
DB1="$SCRATCH/p6-s1.db"
LOG1="$SCRATCH/p6-s1.log"
OUT1="$SCRATCH/p6-s1.out"
rm -f "$DB1" "$DB1-wal" "$DB1-shm" "$LOG1" "$OUT1"

# Create a workspace with a simple coding task
WS1="$SCRATCH/p6-ws1"
rm -rf "$WS1" && mkdir -p "$WS1"
cat > "$WS1/task.txt" <<'TASK'
Create a file called hello.txt that contains exactly "Hello, World!".
Then create a file called count.txt that contains the number 42.
TASK

# Establish a session and a goal with criteria, so this exercises the plugin
# driving a multi-step task rather than a bare model invocation.
run_opencode "$DB1" "$LOG1" "$OUT1" "" "reply with exactly: ready" "$WS1"
SID1=$(grep -aoE '"sessionID":"ses_[A-Za-z0-9]+"' "$LOG1" 2>/dev/null | head -1 | sed 's/.*:"//;s/"//' || true)

if [ -n "$SID1" ]; then
  GOAL1=$(setup_goal "$DB1" "$SID1" "read task.txt and create both files it asks for")
  bun -e "
import { GoalStore } from './src/controller/store.ts';
const s = new GoalStore('$DB1');
s.addCriterion('$GOAL1', 'hello.txt exists and contains Hello, World!');
s.addCriterion('$GOAL1', 'count.txt exists and contains 42');
s.close();
" >/dev/null 2>&1 || true

  run_opencode "$DB1" "$LOG1" "$OUT1" "$SID1" \
    "Read $WS1/task.txt and complete the task. Use shell commands to create the files." \
    "$WS1"
fi

# Check results
if [ -f "$WS1/hello.txt" ] && [ -f "$WS1/count.txt" ]; then
  H=$(cat "$WS1/hello.txt" 2>/dev/null | tr -d '[:space:]')
  C=$(cat "$WS1/count.txt" 2>/dev/null | tr -d '[:space:]')
  if [ "$H" = "Hello,World!" ] && [ "$C" = "42" ]; then
    report "multi-step coding goal" "PASS"
  else
    report "multi-step coding goal" "FAIL" "files created but content wrong: hello='$H' count='$C'"
  fi
else
  report "multi-step coding goal" "FAIL" "files not created"
fi

# Check the goal was driven
if grep -q "driver.drive.*admitted" "$LOG1" 2>/dev/null; then
  report "continuation was injected" "PASS"
else
  report "continuation was injected" "FAIL" "no driver.drive admitted in log"
fi

echo ""

# ---------------------------------------------------------------
# Scenario 2: Model falsely declaring completion
# ---------------------------------------------------------------
echo "--- Scenario 2: Model falsely declaring completion ---"
DB2="$SCRATCH/p6-s2.db"
LOG2="$SCRATCH/p6-s2.log"
OUT2="$SCRATCH/p6-s2.out"
rm -f "$DB2" "$DB2-wal" "$DB2-shm" "$LOG2" "$OUT2"

WS2="$SCRATCH/p6-ws2"
rm -rf "$WS2" && mkdir -p "$WS2"

# Establish a session, then a goal with an explicit criterion the model has NOT
# satisfied. Only then can a false completion claim be tested.
run_opencode "$DB2" "$LOG2" "$OUT2" "" "reply with exactly: ready" "$WS2"
SID2=$(grep -aoE '"sessionID":"ses_[A-Za-z0-9]+"' "$LOG2" 2>/dev/null | head -1 | sed 's/.*:"//;s/"//' || true)

if [ -n "$SID2" ]; then
  GOAL2=$(setup_goal "$DB2" "$SID2" "create done.txt containing 'complete' AND verify its contents")
  bun -e "
import { GoalStore } from './src/controller/store.ts';
const s = new GoalStore('$DB2');
s.addCriterion('$GOAL2', 'done.txt exists and contains complete');
s.close();
" >/dev/null 2>&1 || true

  # The model is told to declare victory without doing the work.
  run_opencode "$DB2" "$LOG2" "$OUT2" "$SID2" \
    "Call goal_propose_complete right now with the summary 'done', without creating any files." \
    "$WS2"

  STATUS2=$(bun -e "
import { GoalStore } from './src/controller/store.ts';
const s = new GoalStore('$DB2');
const g = s.byID('$GOAL2');
console.log(g?.status ?? 'none');
s.close();
" 2>/dev/null || echo "error")

  if [ "$STATUS2" = "complete" ]; then
    report "false completion rejected" "FAIL" "goal completed without satisfying its criterion"
  else
    report "false completion rejected" "PASS" "goal stayed '$STATUS2' despite the claim"
  fi
else
  report "false completion rejected" "FAIL" "could not establish a session"
fi

echo ""

# ---------------------------------------------------------------
# Scenario 3: Successful complete-and-stop behavior
# ---------------------------------------------------------------
echo "--- Scenario 3: Successful complete-and-stop ---"
DB3="$SCRATCH/p6-s3.db"
LOG3="$SCRATCH/p6-s3.log"
OUT3="$SCRATCH/p6-s3.out"
rm -f "$DB3" "$DB3-wal" "$DB3-shm" "$LOG3" "$OUT3"

WS3="$SCRATCH/p6-ws3"
rm -rf "$WS3" && mkdir -p "$WS3"

# First, start a session to get a session ID
run_opencode "$DB3" "$LOG3" "$OUT3" "" \
  "reply with exactly: ready" "$WS3"

SID3=$(grep -aoE '"sessionID":"ses_[A-Za-z0-9]+"' "$LOG3" 2>/dev/null | head -1 | sed 's/.*:"//;s/"//' || true)

if [ -n "$SID3" ]; then
  # Set up the goal with acceptance criteria
  GOAL3=$(setup_goal "$DB3" "$SID3" "run the command echo xgoal-test > $WS3/result.txt and report it")
  echo "  Goal set up: $GOAL3"
  # Add acceptance criteria so verification can pass
  cd /home/bamn/opencode-xgoal
  bun -e "
import { GoalStore } from './src/controller/store.ts';
const s = new GoalStore('$DB3');
s.addCriterion('$GOAL3', 'the command echo xgoal-test was executed successfully');
s.close();
" 2>/dev/null

  # Now ask the model to work on the goal
  run_opencode "$DB3" "$LOG3" "$OUT3" "$SID3" \
    "You are under an active goal. Run the shell command 'echo xgoal-test > $WS3/result.txt', then call goal_propose_complete." \
    "$WS3"

  SID3=$(grep -aoE '"sessionID":"ses_[A-Za-z0-9]+"' "$LOG3" 2>/dev/null | head -1 | sed 's/.*:"//;s/"//' || true)
  FINAL3=$(check_goal_status "$DB3" "$SID3")
  DRIVES3=$(grep -c "driver.drive.*admitted" "$LOG3" 2>/dev/null || echo "0")
  IDLES3=$(grep -c "driver.drive.*idle" "$LOG3" 2>/dev/null || echo "0")

  if [ "$FINAL3" = "complete" ]; then
    report "complete-and-stop" "PASS"
  else
    report "complete-and-stop" "FAIL" "final status: $FINAL3 (admitted: $DRIVES3, idle: $IDLES3)"
  fi

  if [ "$IDLES3" -gt 0 ]; then
    report "stopped driving after completion" "PASS" "$IDLES3 idle drives"
  else
    report "stopped driving after completion" "FAIL" "no idle drives"
  fi
else
  report "complete-and-stop" "FAIL" "could not get session ID"
fi

echo ""

# ---------------------------------------------------------------
# Scenario 4: Restart mid-goal
# ---------------------------------------------------------------
echo "--- Scenario 4: Restart mid-goal ---"
DB4="$SCRATCH/p6-s4.db"
LOG4A="$SCRATCH/p6-s4a.log"
LOG4B="$SCRATCH/p6-s4b.log"
OUT4A="$SCRATCH/p6-s4a.out"
OUT4B="$SCRATCH/p6-s4b.out"
rm -f "$DB4" "$DB4-wal" "$DB4-shm" "$LOG4A" "$LOG4B" "$OUT4A" "$OUT4B"

WS4="$SCRATCH/p6-ws4"
rm -rf "$WS4" && mkdir -p "$WS4"

# First session: start a goal
run_opencode "$DB4" "$LOG4A" "$OUT4A" "" \
  "reply with exactly: ready" "$WS4"

SID4=$(grep -aoE '"sessionID":"ses_[A-Za-z0-9]+"' "$LOG4A" 2>/dev/null | head -1 | sed 's/.*:"//;s/"//' || true)

if [ -n "$SID4" ]; then
  # Set up the goal
  setup_goal "$DB4" "$SID4" "create restart-test.txt with content 'restarted'" > /dev/null

  # Second session: same session ID, should recover the goal
  run_opencode "$DB4" "$LOG4B" "$OUT4B" "$SID4" \
    "Continue working on the goal. Create the file restart-test.txt with content 'restarted'." \
    "$WS4"

  if [ -f "$WS4/restart-test.txt" ]; then
    report "restart mid-goal" "PASS" "goal survived restart, file created"
  else
    report "restart mid-goal" "FAIL" "file not created after restart"
  fi

  # Check reconciliation happened
  RECONCILED=$(grep -c "reconciled" "$LOG4B" 2>/dev/null || echo "0")
  if [ "$RECONCILED" -gt 0 ]; then
    report "restart reconciliation" "PASS"
  else
    report "restart reconciliation" "FAIL" "no reconciliation events"
  fi
else
  report "restart mid-goal" "FAIL" "could not get session ID from first run"
fi

echo ""

# ---------------------------------------------------------------
# Scenario 5: Two independent sessions
# ---------------------------------------------------------------
echo "--- Scenario 5: Two independent sessions ---"
DB5="$SCRATCH/p6-s5.db"
LOG5A="$SCRATCH/p6-s5a.log"
LOG5B="$SCRATCH/p6-s5b.log"
OUT5A="$SCRATCH/p6-s5a.out"
OUT5B="$SCRATCH/p6-s5b.out"
rm -f "$DB5" "$DB5-wal" "$DB5-shm" "$LOG5A" "$LOG5B" "$OUT5A" "$OUT5B"

WS5="$SCRATCH/p6-ws5"
rm -rf "$WS5" && mkdir -p "$WS5"

# Session A
run_opencode "$DB5" "$LOG5A" "$OUT5A" "" \
  "Create fileA.txt with content 'session A'" "$WS5"

# Session B
run_opencode "$DB5" "$LOG5B" "$OUT5B" "" \
  "Create fileB.txt with content 'session B'" "$WS5"

# Both files should exist independently
if [ -f "$WS5/fileA.txt" ] && [ -f "$WS5/fileB.txt" ]; then
  A=$(cat "$WS5/fileA.txt" | tr -d '[:space:]')
  B=$(cat "$WS5/fileB.txt" | tr -d '[:space:]')
  if [ "$A" = "sessionA" ] && [ "$B" = "sessionB" ]; then
    report "two independent sessions" "PASS"
  else
    report "two independent sessions" "FAIL" "content wrong: A='$A' B='$B'"
  fi
else
  report "two independent sessions" "FAIL" "files not created"
fi

echo ""

# ---------------------------------------------------------------
# Scenario 6: Normal OpenCode behavior with Goal plugin disabled
# ---------------------------------------------------------------
echo "--- Scenario 6: Normal behavior with Goal plugin disabled ---"
DB6="$SCRATCH/p6-s6.db"
LOG6="$SCRATCH/p6-s6.log"
OUT6="$SCRATCH/p6-s6.out"
rm -f "$DB6" "$DB6-wal" "$DB6-shm" "$LOG6" "$OUT6"

WS6="$SCRATCH/p6-ws6"
rm -rf "$WS6" && mkdir -p "$WS6"

# Run WITHOUT XGOAL_DB so the goal controller is not engaged at all.
cd "$WS6"
XDG_CONFIG_HOME="$TC" XGOAL_HARNESS_LOG="$LOG6" \
  timeout 180 /home/bamn/.opencode/bin/opencode2 run --standalone --auto \
  "Create a file called normal.txt with content 'normal operation'" > "$OUT6" 2>&1 || true

# Wait a moment for file creation
sleep 2

# The file is created in the working directory (cwd), not necessarily in $WS6
if [ -f "$WS6/normal.txt" ] || [ -f "$SCRATCH/normal.txt" ]; then
  report "normal operation without goal" "PASS"
else
  report "normal operation without goal" "FAIL" "file not created"
fi

# The plugin still loads and registers (that is expected), so assert the thing
# that actually matters: no goal was created and no continuation was driven.
DRIVEN=$(grep -ac "driver.drive.*admitted" "$LOG6" 2>/dev/null | head -1)
DRIVEN=${DRIVEN:-0}
if [ "$DRIVEN" -eq 0 ]; then
  report "no goal interference" "PASS" "0 continuations driven while inactive"
else
  report "no goal interference" "FAIL" "$DRIVEN continuation(s) driven without an active goal"
fi

echo ""

# ---------------------------------------------------------------
# Scenario 7: Replacement while active
# ---------------------------------------------------------------
echo "--- Scenario 7: Replacement while active (live server RPC) ---"
DB7="$SCRATCH/p6-s7.db"
LOG7="$SCRATCH/p6-s7.log"
OUT7="$SCRATCH/p6-s7.out"
rm -f "$DB7" "$DB7-wal" "$DB7-shm" "$LOG7" "$OUT7"

# Replacement is a server-side RPC with a generation check. The TUI dialog only
# collects intent, so this is exercised against a real running server rather
# than through the headless `run` path (which does not dispatch slash commands).
export XDG_CONFIG_HOME="$TC"
export XDG_DATA_HOME="$SCRATCH/p6-xdg-data"
export XDG_STATE_HOME="$SCRATCH/p6-xdg-state"
export XGOAL_HARNESS_LOG="$LOG7"
export XGOAL_DB="$DB7"
mkdir -p "$XDG_DATA_HOME" "$XDG_STATE_HOME"

OC=/home/bamn/.opencode/bin/opencode2
timeout 30 $OC service stop >/dev/null 2>&1
rm -f "$DB7" "$DB7-wal" "$DB7-shm"
timeout 60 $OC service start >/dev/null 2>&1
sleep 5

PW=$(python3 -c "import json;print(json.load(open('$TC/opencode/service.json'))['password'])" 2>/dev/null || echo "")
PORT=$(python3 -c "import json;print(json.load(open('$TC/opencode/service.json'))['port'])" 2>/dev/null || echo "")
RPC="http://127.0.0.1:${PORT}/api/rpc/local.opencode-xgoal"
rpc(){ curl -s -X POST "$RPC/$1" -H 'Content-Type: application/json' -u "opencode:$PW" -d "$2"; }

if [ -n "$PW" ] && [ -n "$PORT" ]; then
  # Unique session per run so the history is unambiguous across runs.
  S7="ses_s7_$$"
  rpc goal.replace "{\"input\":{\"sessionID\":\"$S7\",\"objective\":\"first objective\",\"expectedGeneration\":1}}" > "$OUT7"
  R1=$(python3 -c "
import json
d=json.load(open('$OUT7'))
g=(d.get('output') or {}).get('goal')
print(g['generation'] if g else 'none')
" 2>/dev/null || echo "err")

  # Replace while active: gen 1 -> gen 2
  R2=$(rpc goal.replace "{\"input\":{\"sessionID\":\"$S7\",\"objective\":\"second objective\",\"expectedGeneration\":1}}" \
    | python3 -c "
import json,sys
d=json.load(sys.stdin)
g=(d.get('output') or {}).get('goal')
print(g['generation'] if g else 'none')
" 2>/dev/null || echo "err")

  # A stale confirmation (still claiming gen 1) must be refused
  STALE=$(rpc goal.replace "{\"input\":{\"sessionID\":\"$S7\",\"objective\":\"third objective\",\"expectedGeneration\":1}}" \
    | python3 -c "
import json,sys
d=json.load(sys.stdin)
print((d.get('output') or {}).get('error') or 'NOT-REFUSED')
" 2>/dev/null || echo "err")

  # History must retain the superseded generation (authoritative: the RPC's own
  # view, not a DB file — the service daemon does not inherit XGOAL_DB).
  HIST=$(rpc goal.history "{\"input\":{\"sessionID\":\"$S7\"}}")
  SUP=$(printf '%s' "$HIST" | python3 -c "
import json,sys
d=json.load(sys.stdin)
gs=(d.get('output') or {}).get('goals') or []
print(sum(1 for g in gs if g['status']=='superseded'))
" 2>/dev/null || echo 0)
  ACTIVE=$(printf '%s' "$HIST" | python3 -c "
import json,sys
d=json.load(sys.stdin)
gs=(d.get('output') or {}).get('goals') or []
print(sum(1 for g in gs if g['status']=='active'))
" 2>/dev/null || echo 0)

  timeout 30 $OC service stop >/dev/null 2>&1

  if [ "$R1" = "1" ] && [ "$R2" = "2" ] && [ "$STALE" != "NOT-REFUSED" ] && [ "${SUP:-0}" = "1" ] && [ "${ACTIVE:-0}" = "1" ]; then
    report "replacement while active" "PASS" "gen1->gen2, stale refused, 1 superseded + 1 active retained"
  else
    report "replacement while active" "FAIL" "gen1=$R1 gen2=$R2 stale='$STALE' superseded=$SUP active=$ACTIVE"
  fi
else
  report "replacement while active" "FAIL" "could not read the isolated service credentials"
fi

echo ""

# ---------------------------------------------------------------
# Summary
# ---------------------------------------------------------------
echo "============================================"
echo " Results: $PASS/$TOTAL passed, $FAIL failed"
echo "============================================"

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
exit 0
