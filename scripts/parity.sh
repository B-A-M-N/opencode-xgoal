#!/usr/bin/env bash
# Codex /goal  vs  OpenCode-XGoal — behavioural parity harness
#
# Runs identical, machine-checkable multi-requirement tasks through both
# controllers and measures the thing that actually matters to the user:
#
#   1. requirement completion rate — how many of the task's explicit
#      requirements were actually satisfied (not claimed)
#   2. premature-stop rate — runs that stopped while requirements remained
#   3. turns — model invocations per run
#
# Success is judged ONLY by reading the resulting files. Nothing either model
# says is treated as evidence.
#
# Usage: bash scripts/parity.sh [runs_per_task]
set -uo pipefail

RUNS="${1:-1}"
export PATH="/home/bamn/.bun/bin:$PATH"
S=/home/bamn/.hermes/cache/scratch
TC="$S/xgoal-testcfg"
CODEX=/home/bamn/.local/bin/codex
OC=/home/bamn/.opencode/bin/opencode2
OUT="$S/parity-results"
rm -rf "$OUT" && mkdir -p "$OUT"

# --------------------------------------------------------------------------
# Tasks. Each is a prompt plus a machine-checkable requirement list.
# Deliberately multi-requirement: partial completion is the failure mode.
# --------------------------------------------------------------------------

task_prompt() {
  case "$1" in
    t1) cat <<'P'
Complete ALL of the following, then stop:
1. Create a file called a.txt containing exactly: alpha
2. Create a file called b.txt containing exactly: bravo
3. Create a file called c.txt containing exactly: charlie
P
      ;;
    t2) cat <<'P'
Complete ALL of the following, then stop:
1. Create src/ containing a file mod.js that exports a function named add
2. Create src/mod.test.js that imports add and calls it
3. Create README.md containing the word Installation
4. Create a file .gitignore containing node_modules
P
      ;;
    t3) cat <<'P'
Complete ALL of the following, then stop:
1. Create data/ and inside it three files: one.txt, two.txt, three.txt
2. Each must contain its own number as a word (one, two, three)
3. Create a summary.txt listing all three filenames
P
      ;;
  esac
}

# Count satisfied requirements by inspecting the filesystem. Echoes "met/total".
task_score() {
  local t="$1" w="$2" met=0 total=0
  chk() { total=$((total+1)); if eval "$1"; then met=$((met+1)); fi; }
  case "$t" in
    t1)
      chk "[ \"\$(tr -d '[:space:]' < '$w/a.txt' 2>/dev/null)\" = alpha ]"
      chk "[ \"\$(tr -d '[:space:]' < '$w/b.txt' 2>/dev/null)\" = bravo ]"
      chk "[ \"\$(tr -d '[:space:]' < '$w/c.txt' 2>/dev/null)\" = charlie ]"
      ;;
    t2)
      chk "[ -f '$w/src/mod.js' ] && grep -q 'add' '$w/src/mod.js'"
      chk "[ -f '$w/src/mod.test.js' ] && grep -q 'add' '$w/src/mod.test.js'"
      chk "[ -f '$w/README.md' ] && grep -qi 'installation' '$w/README.md'"
      chk "[ -f '$w/.gitignore' ] && grep -q 'node_modules' '$w/.gitignore'"
      ;;
    t3)
      chk "[ -f '$w/data/one.txt' ] && grep -qi 'one' '$w/data/one.txt'"
      chk "[ -f '$w/data/two.txt' ] && grep -qi 'two' '$w/data/two.txt'"
      chk "[ -f '$w/data/three.txt' ] && grep -qi 'three' '$w/data/three.txt'"
      chk "[ -f '$w/summary.txt' ] && grep -q 'one.txt' '$w/summary.txt' && grep -q 'three.txt' '$w/summary.txt'"
      ;;
  esac
  echo "$met/$total"
}

# Count model turns from the Codex transcript (each "codex" block = one turn).
codex_turns() {
  local n
  n=$(grep -c '^codex$' "$1" 2>/dev/null | head -1)
  echo "${n:-0}"
}
# OpenCode-XGoal turns: driver admissions + the initial prompt.
oc_turns() {
  local n
  n=$(grep -ac 'driver.drive.*admitted' "$1" 2>/dev/null | head -1)
  echo $(( ${n:-0} + 1 ))
}

run_codex() {
  local t="$1" w="$2" log="$3"
  rm -rf "$w" && mkdir -p "$w"
  ( cd "$w" && timeout 300 "$CODEX" exec --skip-git-repo-check -C "$w" \
      -c 'sandbox_mode="workspace-write"' \
      -c 'approval_policy="never"' \
      "$(task_prompt "$t")" ) > "$log" 2>&1 || true
}

run_xgoal() {
  local t="$1" w="$2" log="$3" db="$4"
  rm -rf "$w" && mkdir -p "$w"
  rm -f "$db" "$db-wal" "$db-shm" "$log"

  # Establish a session, then place the task under an active goal with the
  # task's requirements as criteria — otherwise this measures a bare
  # single-turn completion, not goal-driven behaviour.
  ( cd "$w" && XDG_CONFIG_HOME="$TC" XGOAL_HARNESS_LOG="$log" XGOAL_DB="$db" \
      timeout 120 "$OC" run --standalone --auto "reply with exactly: ready" ) \
      > "$w/.oc-init" 2>&1 || true

  local sid goal
  sid=$(grep -aoE '"sessionID":"ses_[A-Za-z0-9]+"' "$log" 2>/dev/null | head -1 | sed 's/.*:"//;s/"//')
  if [ -n "$sid" ]; then
    goal=$(cd /home/bamn/opencode-xgoal && bun -e "
import { GoalController } from './src/controller/controller.ts';
const c = new GoalController({ dbPath: '$db' });
const r = c.startOrDescribe('$sid', 'satisfy every numbered requirement in the task');
const g = ('created' in r) ? r.created : r.existing;
const reqs = { t1: ['a.txt contains alpha','b.txt contains bravo','c.txt contains charlie'],
               t2: ['src/mod.js exports add','src/mod.test.js imports add','README.md mentions Installation','.gitignore contains node_modules'],
               t3: ['data/one.txt','data/two.txt','data/three.txt','summary.txt lists the files'] }['$t'] || [];
for (const x of reqs) c.store.addCriterion(g.id, x);
console.log(g.id);
c.close();
" 2>/dev/null)
  fi

  ( cd "$w" && XDG_CONFIG_HOME="$TC" XGOAL_HARNESS_LOG="$log" XGOAL_DB="$db" \
      timeout 300 "$OC" run --standalone --auto --session "$sid" "$(task_prompt "$t")" ) \
      > "$w/.oc-out" 2>&1 || true
}

echo "================================================================"
echo " Codex /goal  vs  OpenCode-XGoal — parity harness (${RUNS} run/task)"
echo "================================================================"
echo ""

TOTAL_C=0; TOTAL_C_MET=0; TOTAL_C_REQ=0; C_PREMATURE=0; C_TURNS=0; C_RUNS=0
TOTAL_X=0; TOTAL_X_MET=0; TOTAL_X_REQ=0; X_PREMATURE=0; X_TURNS=0; X_RUNS=0

for t in t1 t2 t3; do
  for i in $(seq 1 "$RUNS"); do
    echo "--- $t run $i ---"

    # Codex /goal
    CW="$OUT/$t-codex-$i"; CLOG="$OUT/$t-codex-$i.log"
    run_codex "$t" "$CW" "$CLOG"
    CS=$(task_score "$t" "$CW")
    CMET=${CS%%/*}; CREQ=${CS##*/}
    CT=$(codex_turns "$CLOG")
    TOTAL_C=$((TOTAL_C+1)); TOTAL_C_MET=$((TOTAL_C_MET+CMET)); TOTAL_C_REQ=$((TOTAL_C_REQ+CREQ))
    C_TURNS=$((C_TURNS+CT)); C_RUNS=$((C_RUNS+1))
    [ "$CMET" -lt "$CREQ" ] && C_PREMATURE=$((C_PREMATURE+1))
    echo "  codex   : $CS requirements, $CT turns"

    # OpenCode-XGoal
    XW="$OUT/$t-xgoal-$i"; XLOG="$OUT/$t-xgoal-$i.harness.log"; XDB="$OUT/$t-xgoal-$i.db"
    run_xgoal "$t" "$XW" "$XLOG" "$XDB"
    XS=$(task_score "$t" "$XW")
    XMET=${XS%%/*}; XREQ=${XS##*/}
    XT=$(oc_turns "$XLOG")
    TOTAL_X=$((TOTAL_X+1)); TOTAL_X_MET=$((TOTAL_X_MET+XMET)); TOTAL_X_REQ=$((TOTAL_X_REQ+XREQ))
    X_TURNS=$((X_TURNS+XT)); X_RUNS=$((X_RUNS+1))
    [ "$XMET" -lt "$XREQ" ] && X_PREMATURE=$((X_PREMATURE+1))
    echo "  xgoal   : $XS requirements, $XT turns"
    echo ""
  done
done

pct() { [ "$2" -eq 0 ] && echo "n/a" || awk -v a="$1" -v b="$2" 'BEGIN{printf "%.1f%%", 100*a/b}'; }

echo "================================================================"
echo " RESULTS"
echo "================================================================"
printf "%-28s %14s %14s\n" "" "Codex /goal" "OpenCode-XGoal"
printf "%-28s %14s %14s\n" "requirement completion" \
  "$(pct $TOTAL_C_MET $TOTAL_C_REQ) ($TOTAL_C_MET/$TOTAL_C_REQ)" \
  "$(pct $TOTAL_X_MET $TOTAL_X_REQ) ($TOTAL_X_MET/$TOTAL_X_REQ)"
printf "%-28s %14s %14s\n" "premature stops" \
  "$(pct $C_PREMATURE $C_RUNS) ($C_PREMATURE/$C_RUNS)" \
  "$(pct $X_PREMATURE $X_RUNS) ($X_PREMATURE/$X_RUNS)"
printf "%-28s %14s %14s\n" "mean turns/run" \
  "$(awk -v t="$C_TURNS" -v r="$C_RUNS" 'BEGIN{printf "%.1f", r?t/r:0}')" \
  "$(awk -v t="$X_TURNS" -v r="$X_RUNS" 'BEGIN{printf "%.1f", r?t/r:0}')"
echo ""
echo "Raw artifacts: $OUT"
