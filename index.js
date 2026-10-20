// src/index.ts
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

// src/controller/store.ts
import { Database } from "bun:sqlite";

// src/controller/state.ts
var TERMINAL_STATUSES = ["complete", "superseded"];
var NON_TERMINAL_STATUSES = [
  "active",
  "paused",
  "verifying",
  "blocked",
  "stalled",
  "budgetLimited",
  "usageLimited"
];
var ALL_STATUSES = [
  ...NON_TERMINAL_STATUSES,
  ...TERMINAL_STATUSES
];
var TRANSITIONS = {
  active: {
    paused: ["user", "controller"],
    verifying: ["model", "controller"],
    blocked: ["model", "controller"],
    stalled: ["controller"],
    budgetLimited: ["controller"],
    usageLimited: ["controller"],
    superseded: ["user", "controller"]
  },
  paused: {
    active: ["user", "controller"],
    superseded: ["user", "controller"]
  },
  verifying: {
    active: ["controller"],
    complete: ["controller"],
    blocked: ["controller"],
    superseded: ["user", "controller"]
  },
  blocked: {
    active: ["user", "controller"],
    superseded: ["user", "controller"]
  },
  stalled: {
    active: ["user", "controller"],
    superseded: ["user", "controller"]
  },
  budgetLimited: {
    active: ["user"],
    superseded: ["user", "controller"]
  },
  usageLimited: {
    active: ["user"],
    superseded: ["user", "controller"]
  },
  complete: {},
  superseded: {}
};
function canTransition({ from, to, actor }) {
  if (from === to) {
    return { ok: true };
  }
  const targets = TRANSITIONS[from];
  if (!targets) {
    return { ok: false, reason: `unknown source status: ${from}` };
  }
  const actors = targets[to];
  if (!actors) {
    return { ok: false, reason: `illegal transition ${from} -> ${to}` };
  }
  if (!actors.includes(actor)) {
    return {
      ok: false,
      reason: `transition ${from} -> ${to} is not permitted for actor "${actor}" (allowed: ${actors.join(", ")})`
    };
  }
  return { ok: true };
}
function isTerminal(status) {
  return TERMINAL_STATUSES.includes(status);
}
function isNonTerminal(status) {
  return NON_TERMINAL_STATUSES.includes(status);
}

// src/controller/store.ts
class GoalConflictError extends Error {
  constructor(message) {
    super(message);
    this.name = "GoalConflictError";
  }
}

class TransitionRejectedError extends Error {
  constructor(message) {
    super(message);
    this.name = "TransitionRejectedError";
  }
}
var SCHEMA = `
CREATE TABLE IF NOT EXISTS goals (
  id                       TEXT PRIMARY KEY,
  session_id               TEXT NOT NULL,
  generation               INTEGER NOT NULL,
  objective                TEXT NOT NULL,
  status                   TEXT NOT NULL,
  reason                   TEXT,
  rounds                   INTEGER NOT NULL DEFAULT 0,
  no_progress_rounds       INTEGER NOT NULL DEFAULT 0,
  repeated_blocker_rounds  INTEGER NOT NULL DEFAULT 0,
  tokens_used              INTEGER,
  token_budget             INTEGER,
  version                  INTEGER NOT NULL DEFAULT 0,
  created_at_ms            INTEGER NOT NULL,
  updated_at_ms            INTEGER NOT NULL,
  completed_at_ms          INTEGER,
  superseded_by            TEXT,
  UNIQUE (session_id, generation)
);

-- (1) At most one non-terminal goal per session. Terminal rows (complete,
-- superseded) are excluded so history accumulates freely.
CREATE UNIQUE INDEX IF NOT EXISTS goals_one_current_per_session
  ON goals (session_id)
  WHERE status NOT IN ('complete', 'superseded');

CREATE TABLE IF NOT EXISTS goal_events (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,
  goal_id     TEXT NOT NULL,
  generation  INTEGER NOT NULL,
  kind        TEXT NOT NULL,
  from_status TEXT,
  to_status   TEXT,
  actor       TEXT,
  detail      TEXT,
  at_ms       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS goal_events_goal ON goal_events (goal_id, seq);

CREATE TABLE IF NOT EXISTS goal_criteria (
  id          TEXT PRIMARY KEY,
  goal_id     TEXT NOT NULL,
  generation  INTEGER NOT NULL,
  text        TEXT NOT NULL,
  met         INTEGER NOT NULL DEFAULT 0,
  created_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS goal_criteria_goal ON goal_criteria (goal_id);

CREATE TABLE IF NOT EXISTS goal_evidence (
  id          TEXT PRIMARY KEY,
  goal_id     TEXT NOT NULL,
  generation  INTEGER NOT NULL,
  criterion_id TEXT,
  kind        TEXT NOT NULL,
  ref         TEXT NOT NULL,
  detail      TEXT,
  at_ms       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS goal_evidence_goal ON goal_evidence (goal_id);

-- Continuation ledger. One row per continuation attempt.
--
-- inbox_id is the OpenCode message ID we reserve BEFORE submitting, and it is
-- UNIQUE. That uniqueness is the idempotency guarantee: a retry after a timeout
-- reuses the same id, so the session can deduplicate it and we can never admit
-- the same continuation twice.
--
-- status tracks the attempt's real lifecycle, not our hopes:
--   prepared  reserved, not yet submitted
--   admitted  the session accepted the message (NOT proof it ran)
--   running   execution observed to have started
--   settled   a round outcome was evaluated
--   unknown   submission outcome ambiguous (timeout / lost response)
--   failed    submission definitively rejected
CREATE TABLE IF NOT EXISTS goal_rounds (
  id             TEXT PRIMARY KEY,
  goal_id        TEXT NOT NULL,
  generation     INTEGER NOT NULL,
  inbox_id       TEXT NOT NULL UNIQUE,
  status         TEXT NOT NULL,
  classification TEXT,
  attempts       INTEGER NOT NULL DEFAULT 1,
  detail         TEXT,
  prepared_at_ms INTEGER NOT NULL,
  admitted_at_ms INTEGER,
  settled_at_ms  INTEGER
);
CREATE INDEX IF NOT EXISTS goal_rounds_goal ON goal_rounds (goal_id, prepared_at_ms);
-- At most one in-flight round per goal.
CREATE UNIQUE INDEX IF NOT EXISTS goal_rounds_one_outstanding
  ON goal_rounds (goal_id)
  WHERE status IN ('prepared', 'admitted', 'running', 'unknown');
`;
function toGoal(row) {
  return {
    id: row.id,
    sessionID: row.session_id,
    generation: row.generation,
    objective: row.objective,
    status: row.status,
    reason: row.reason ?? undefined,
    rounds: row.rounds,
    noProgressRounds: row.no_progress_rounds,
    repeatedBlockerRounds: row.repeated_blocker_rounds,
    tokensUsed: row.tokens_used ?? undefined,
    tokenBudget: row.token_budget ?? undefined,
    version: row.version,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
    completedAtMs: row.completed_at_ms ?? undefined,
    supersededBy: row.superseded_by ?? undefined
  };
}
var counter = 0;
function newID(prefix) {
  counter += 1;
  return `${prefix}_${Date.now().toString(36)}_${counter.toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

class GoalStore {
  db;
  constructor(path) {
    this.db = new Database(path, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec(SCHEMA);
  }
  close() {
    this.db.close();
  }
  tx(fn) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {}
      throw error;
    }
  }
  appendEvent(goalID, generation, kind, extra = {}) {
    this.db.query(`INSERT INTO goal_events (goal_id, generation, kind, from_status, to_status, actor, detail, at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(goalID, generation, kind, extra.fromStatus ?? null, extra.toStatus ?? null, extra.actor ?? null, extra.detail ?? null, Date.now());
  }
  current(sessionID) {
    const row = this.db.query(`SELECT * FROM goals WHERE session_id = ? AND status NOT IN ('complete','superseded') LIMIT 1`).get(sessionID);
    return row ? toGoal(row) : undefined;
  }
  byID(id) {
    const row = this.db.query(`SELECT * FROM goals WHERE id = ?`).get(id);
    return row ? toGoal(row) : undefined;
  }
  history(sessionID) {
    return this.db.query(`SELECT * FROM goals WHERE session_id = ? ORDER BY generation DESC`).all(sessionID).map(toGoal);
  }
  events(goalID) {
    return this.db.query(`SELECT * FROM goal_events WHERE goal_id = ? ORDER BY seq ASC`).all(goalID).map((r) => ({
      seq: r.seq,
      goalID: r.goal_id,
      generation: r.generation,
      kind: r.kind,
      fromStatus: r.from_status ?? undefined,
      toStatus: r.to_status ?? undefined,
      actor: r.actor ?? undefined,
      detail: r.detail ?? undefined,
      atMs: r.at_ms
    }));
  }
  create(input) {
    if (!input.objective || !input.objective.trim()) {
      throw new TransitionRejectedError("objective must not be empty");
    }
    return this.tx(() => {
      const existing = this.current(input.sessionID);
      if (existing) {
        throw new GoalConflictError(`session ${input.sessionID} already has a current goal (${existing.id}, generation ${existing.generation}, status ${existing.status}); use replace()`);
      }
      const now = Date.now();
      const id = newID("goal");
      const generation = 1;
      this.db.query(`INSERT INTO goals (id, session_id, generation, objective, status, rounds,
             no_progress_rounds, repeated_blocker_rounds, token_budget, version,
             created_at_ms, updated_at_ms)
           VALUES (?, ?, ?, ?, 'active', 0, 0, 0, ?, 0, ?, ?)`).run(id, input.sessionID, generation, input.objective.trim(), input.tokenBudget ?? null, now, now);
      this.appendEvent(id, generation, "created", {
        toStatus: "active",
        actor: input.actor ?? "user",
        detail: input.objective.trim().slice(0, 200)
      });
      return this.byID(id);
    });
  }
  replace(input) {
    if (!input.objective || !input.objective.trim()) {
      throw new TransitionRejectedError("objective must not be empty");
    }
    return this.tx(() => {
      const existing = this.current(input.sessionID);
      if (!existing) {
        throw new GoalConflictError(`session ${input.sessionID} has no current goal to replace`);
      }
      if (existing.generation !== input.expectedGeneration) {
        throw new GoalConflictError(`stale replacement: expected generation ${input.expectedGeneration}, found ${existing.generation}`);
      }
      const now = Date.now();
      const newIDValue = newID("goal");
      const nextGeneration = existing.generation + 1;
      this.db.query(`UPDATE goals SET status='superseded', superseded_by=?, updated_at_ms=?, version=version+1
           WHERE id=? AND version=?`).run(newIDValue, now, existing.id, existing.version);
      this.appendEvent(existing.id, existing.generation, "superseded", {
        fromStatus: existing.status,
        toStatus: "superseded",
        actor: input.actor ?? "user",
        detail: input.reason ?? `replaced by ${newIDValue}`
      });
      this.db.query(`INSERT INTO goals (id, session_id, generation, objective, status, rounds,
             no_progress_rounds, repeated_blocker_rounds, token_budget, version,
             created_at_ms, updated_at_ms)
           VALUES (?, ?, ?, ?, 'active', 0, 0, 0, ?, 0, ?, ?)`).run(newIDValue, input.sessionID, nextGeneration, input.objective.trim(), input.tokenBudget ?? existing.tokenBudget ?? null, now, now);
      this.appendEvent(newIDValue, nextGeneration, "created", {
        toStatus: "active",
        actor: input.actor ?? "user",
        detail: `replaces ${existing.id} (generation ${existing.generation})`
      });
      return this.byID(newIDValue);
    });
  }
  transition(input) {
    return this.tx(() => {
      const goal = this.byID(input.goalID);
      if (!goal) {
        throw new GoalConflictError(`unknown goal ${input.goalID}`);
      }
      if (goal.generation !== input.generation) {
        throw new GoalConflictError(`stale generation: goal ${input.goalID} is generation ${goal.generation}, callback claimed ${input.generation}`);
      }
      if (isTerminal(goal.status)) {
        throw new GoalConflictError(`goal ${input.goalID} is terminal (${goal.status}); refusing to drive it`);
      }
      if (input.expectedVersion !== undefined && goal.version !== input.expectedVersion) {
        throw new GoalConflictError(`optimistic version conflict on ${input.goalID}: expected ${input.expectedVersion}, found ${goal.version}`);
      }
      const check = canTransition({ from: goal.status, to: input.to, actor: input.actor });
      if (!check.ok) {
        throw new TransitionRejectedError(check.reason);
      }
      if (goal.status === input.to) {
        this.appendEvent(goal.id, goal.generation, "noop", {
          fromStatus: goal.status,
          toStatus: input.to,
          actor: input.actor,
          detail: input.reason
        });
        return goal;
      }
      const now = Date.now();
      const completedAt = input.to === "complete" ? now : null;
      const updated = this.db.query(`UPDATE goals
             SET status=?, reason=?, updated_at_ms=?, version=version+1,
                 completed_at_ms=COALESCE(?, completed_at_ms)
           WHERE id=? AND version=?`).run(input.to, input.reason ?? null, now, completedAt, goal.id, goal.version);
      if (updated.changes !== 1) {
        throw new GoalConflictError(`compare-and-swap failed for ${goal.id}`);
      }
      this.appendEvent(goal.id, goal.generation, "status", {
        fromStatus: goal.status,
        toStatus: input.to,
        actor: input.actor,
        detail: input.reason
      });
      return this.byID(goal.id);
    });
  }
  recordRound(input) {
    return this.tx(() => {
      const goal = this.byID(input.goalID);
      if (!goal)
        throw new GoalConflictError(`unknown goal ${input.goalID}`);
      if (goal.generation !== input.generation) {
        throw new GoalConflictError(`stale generation: ${input.goalID} is generation ${goal.generation}, round claimed ${input.generation}`);
      }
      if (isTerminal(goal.status)) {
        throw new GoalConflictError(`goal ${input.goalID} is terminal (${goal.status}); refusing to record a round against it`);
      }
      const noProgress = input.classification === "noProgress" ? goal.noProgressRounds + 1 : 0;
      const blocker = input.classification === "blocked" ? goal.repeatedBlockerRounds + 1 : 0;
      const now = Date.now();
      const tokens = input.tokensUsed === undefined ? goal.tokensUsed ?? null : (goal.tokensUsed ?? 0) + input.tokensUsed;
      this.db.query(`UPDATE goals
             SET rounds = rounds + 1,
                 no_progress_rounds = ?,
                 repeated_blocker_rounds = ?,
                 tokens_used = ?,
                 updated_at_ms = ?,
                 version = version + 1
           WHERE id = ? AND version = ?`).run(noProgress, blocker, tokens, now, goal.id, goal.version);
      this.appendEvent(goal.id, goal.generation, "round", {
        actor: "controller",
        detail: `${input.classification}${input.detail ? `: ${input.detail}` : ""}`
      });
      return this.byID(goal.id);
    });
  }
  addCriterion(goalID, text) {
    const goal = this.byID(goalID);
    if (!goal)
      throw new GoalConflictError(`unknown goal ${goalID}`);
    if (!isNonTerminal(goal.status)) {
      throw new TransitionRejectedError(`cannot add criteria to terminal goal ${goalID}`);
    }
    this.tx(() => {
      this.db.query(`INSERT INTO goal_criteria (id, goal_id, generation, text, met, created_at_ms)
           VALUES (?, ?, ?, ?, 0, ?)`).run(newID("crit"), goalID, goal.generation, text, Date.now());
    });
  }
  addEvidence(input) {
    const goal = this.byID(input.goalID);
    if (!goal)
      throw new GoalConflictError(`unknown goal ${input.goalID}`);
    this.tx(() => {
      this.db.query(`INSERT INTO goal_evidence (id, goal_id, generation, criterion_id, kind, ref, detail, at_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(newID("ev"), input.goalID, goal.generation, input.criterionID ?? null, input.kind, input.ref, input.detail ?? null, Date.now());
    });
  }
  listCriteria(goalID) {
    return this.db.query(`SELECT id, text, met FROM goal_criteria WHERE goal_id = ? ORDER BY created_at_ms ASC`).all(goalID).map((r) => ({ id: r.id, text: r.text, met: r.met === 1 }));
  }
  listEvidence(goalID) {
    return this.db.query(`SELECT id, criterion_id, kind, ref FROM goal_evidence WHERE goal_id = ? ORDER BY at_ms ASC`).all(goalID).map((r) => ({
      id: r.id,
      criterionID: r.criterion_id ?? undefined,
      kind: r.kind,
      ref: r.ref
    }));
  }
  reconcileAfterRestart() {
    return this.tx(() => {
      const stranded = this.db.query(`SELECT * FROM goals WHERE status = 'verifying'`).all().map(toGoal);
      const repaired = [];
      for (const goal of stranded) {
        this.db.query(`UPDATE goals SET status='active', reason=?, updated_at_ms=?, version=version+1
             WHERE id=? AND version=?`).run("resumed after restart: verification was interrupted", Date.now(), goal.id, goal.version);
        this.appendEvent(goal.id, goal.generation, "restart-reconcile", {
          fromStatus: "verifying",
          toStatus: "active",
          actor: "controller"
        });
        repaired.push(this.byID(goal.id));
      }
      return repaired;
    });
  }
  prepareRound(input) {
    return this.tx(() => {
      const goal = this.byID(input.goalID);
      if (!goal)
        throw new GoalConflictError(`unknown goal ${input.goalID}`);
      if (goal.generation !== input.generation) {
        throw new GoalConflictError(`stale generation: ${input.goalID} is generation ${goal.generation}, round claimed ${input.generation}`);
      }
      if (isTerminal(goal.status)) {
        throw new GoalConflictError(`goal ${input.goalID} is terminal (${goal.status})`);
      }
      const existing = this.outstandingRound(input.goalID);
      if (existing) {
        throw new GoalConflictError(`goal ${input.goalID} already has an outstanding round (${existing.id}, ${existing.status})`);
      }
      const id = newID("round");
      const now = Date.now();
      this.db.query(`INSERT INTO goal_rounds (id, goal_id, generation, inbox_id, status, attempts, prepared_at_ms)
           VALUES (?, ?, ?, ?, 'prepared', 1, ?)`).run(id, input.goalID, input.generation, input.inboxID, now);
      this.appendEvent(input.goalID, input.generation, "round-prepared", {
        actor: "controller",
        detail: input.inboxID
      });
      return this.roundByID(id);
    });
  }
  roundByID(id) {
    const r = this.db.query(`SELECT * FROM goal_rounds WHERE id = ?`).get(id);
    return r ? toRound(r) : undefined;
  }
  roundByInboxID(inboxID) {
    const r = this.db.query(`SELECT * FROM goal_rounds WHERE inbox_id = ?`).get(inboxID);
    return r ? toRound(r) : undefined;
  }
  outstandingRound(goalID) {
    const r = this.db.query(`SELECT * FROM goal_rounds
          WHERE goal_id = ? AND status IN ('prepared','admitted','running','unknown')
          LIMIT 1`).get(goalID);
    return r ? toRound(r) : undefined;
  }
  outstandingRounds() {
    return this.db.query(`SELECT * FROM goal_rounds
          WHERE status IN ('prepared','admitted','running','unknown')
          ORDER BY prepared_at_ms ASC`).all().map(toRound);
  }
  roundsFor(goalID) {
    return this.db.query(`SELECT * FROM goal_rounds WHERE goal_id = ? ORDER BY prepared_at_ms ASC`).all(goalID).map(toRound);
  }
  markRoundAdmitted(roundID) {
    return this.tx(() => {
      const round = this.roundByID(roundID);
      if (!round)
        throw new GoalConflictError(`unknown round ${roundID}`);
      this.db.query(`UPDATE goal_rounds SET status='admitted', admitted_at_ms=? WHERE id=? AND status='prepared'`).run(Date.now(), roundID);
      this.appendEvent(round.goalID, round.generation, "round-admitted", {
        actor: "controller",
        detail: round.inboxID
      });
      return this.roundByID(roundID);
    });
  }
  markRoundRunning(roundID) {
    return this.tx(() => {
      const round = this.roundByID(roundID);
      if (!round)
        throw new GoalConflictError(`unknown round ${roundID}`);
      this.db.query(`UPDATE goal_rounds SET status='running' WHERE id=? AND status IN ('prepared','admitted','unknown')`).run(roundID);
      this.appendEvent(round.goalID, round.generation, "round-running", { actor: "controller" });
      return this.roundByID(roundID);
    });
  }
  markRoundUnknown(roundID, detail) {
    return this.tx(() => {
      const round = this.roundByID(roundID);
      if (!round)
        throw new GoalConflictError(`unknown round ${roundID}`);
      this.db.query(`UPDATE goal_rounds SET status='unknown', attempts=attempts+1, detail=? WHERE id=?`).run(detail, roundID);
      this.appendEvent(round.goalID, round.generation, "round-unknown", {
        actor: "controller",
        detail
      });
      return this.roundByID(roundID);
    });
  }
  markRoundFailed(roundID, detail) {
    return this.tx(() => {
      const round = this.roundByID(roundID);
      if (!round)
        throw new GoalConflictError(`unknown round ${roundID}`);
      this.db.query(`UPDATE goal_rounds SET status='failed', detail=?, settled_at_ms=? WHERE id=?`).run(detail, Date.now(), roundID);
      this.appendEvent(round.goalID, round.generation, "round-failed", {
        actor: "controller",
        detail
      });
      return this.roundByID(roundID);
    });
  }
  settleRound(input) {
    return this.tx(() => {
      const round = this.roundByID(input.roundID);
      if (!round)
        throw new GoalConflictError(`unknown round ${input.roundID}`);
      this.db.query(`UPDATE goal_rounds SET status='settled', classification=?, detail=?, settled_at_ms=? WHERE id=?`).run(input.classification, input.detail ?? null, Date.now(), input.roundID);
      this.appendEvent(round.goalID, round.generation, "round-settled", {
        actor: "controller",
        detail: `${input.classification}${input.detail ? `: ${input.detail}` : ""}`
      });
      return this.roundByID(input.roundID);
    });
  }
}
function toRound(r) {
  return {
    id: r.id,
    goalID: r.goal_id,
    generation: r.generation,
    inboxID: r.inbox_id,
    status: r.status,
    classification: r.classification ?? undefined,
    attempts: r.attempts,
    detail: r.detail ?? undefined,
    preparedAtMs: r.prepared_at_ms,
    admittedAtMs: r.admitted_at_ms ?? undefined,
    settledAtMs: r.settled_at_ms ?? undefined
  };
}

// src/controller/controller.ts
class GoalController {
  store;
  maxNoProgressRounds;
  minBlockerConfirmations;
  constructor(options) {
    this.store = new GoalStore(options.dbPath);
    this.maxNoProgressRounds = options.maxNoProgressRounds ?? 3;
    this.minBlockerConfirmations = options.minBlockerConfirmations ?? 2;
  }
  close() {
    this.store.close();
  }
  reconcileStartup() {
    return this.store.reconcileAfterRestart();
  }
  startOrDescribe(sessionID, objective) {
    const existing = this.store.current(sessionID);
    if (existing)
      return { existing };
    return { created: this.store.create({ sessionID, objective, actor: "user" }) };
  }
  replace(sessionID, objective, expectedGeneration) {
    const existing = this.store.current(sessionID);
    if (!existing) {
      return this.store.create({ sessionID, objective, actor: "user" });
    }
    return this.store.replace({
      sessionID,
      expectedGeneration: expectedGeneration ?? existing.generation,
      objective,
      actor: "user"
    });
  }
  pause(sessionID) {
    const goal = this.requireCurrent(sessionID);
    return this.store.transition({
      goalID: goal.id,
      generation: goal.generation,
      to: "paused",
      actor: "user"
    });
  }
  resume(sessionID) {
    const goal = this.requireCurrent(sessionID);
    return this.store.transition({
      goalID: goal.id,
      generation: goal.generation,
      to: "active",
      actor: "user",
      reason: "resumed by user"
    });
  }
  status(sessionID) {
    return this.store.current(sessionID);
  }
  history(sessionID) {
    return this.store.history(sessionID);
  }
  get(sessionID) {
    return this.store.current(sessionID);
  }
  checkpoint(sessionID, input) {
    const target = this.resolveTarget(sessionID, input);
    if (!target.ok)
      return { recorded: false, rejected: target.rejected };
    const goal = target.goal;
    for (const ref of input.evidenceRefs ?? []) {
      this.store.addEvidence({ goalID: goal.id, kind: "ref", ref, detail: input.summary });
    }
    const updated = this.store.recordRound({
      goalID: goal.id,
      generation: goal.generation,
      classification: "progress",
      detail: input.summary.slice(0, 300)
    });
    return { recorded: true, goal: updated };
  }
  proposeComplete(sessionID, input) {
    const target = this.resolveTarget(sessionID, input);
    if (!target.ok)
      return { rejected: target.rejected };
    const goal = target.goal;
    for (const ref of input.evidenceRefs ?? []) {
      this.store.addEvidence({ goalID: goal.id, kind: "ref", ref, detail: input.summary });
    }
    const updated = this.store.transition({
      goalID: goal.id,
      generation: goal.generation,
      to: "verifying",
      actor: "model",
      reason: input.summary.slice(0, 300)
    });
    return { goal: updated };
  }
  reportBlocked(sessionID, report) {
    const target = this.resolveTarget(sessionID, report);
    if (!target.ok) {
      return { accepted: false, confirmations: 0, rejected: target.rejected };
    }
    const goal = target.goal;
    for (const ref of report.evidenceRefs ?? []) {
      this.store.addEvidence({ goalID: goal.id, kind: "blocker-ref", ref, detail: report.reason });
    }
    const counted = this.store.recordRound({
      goalID: goal.id,
      generation: goal.generation,
      classification: "blocked",
      detail: report.reason.slice(0, 300)
    });
    const confirmations = counted.repeatedBlockerRounds;
    const genuine = report.externalDependency === true || confirmations >= this.minBlockerConfirmations;
    if (!genuine) {
      return { goal: counted, accepted: false, confirmations };
    }
    const blocked = this.store.transition({
      goalID: goal.id,
      generation: goal.generation,
      to: "blocked",
      actor: "controller",
      reason: report.reason.slice(0, 300)
    });
    return { goal: blocked, accepted: true, confirmations };
  }
  classifyRound(sessionID, classification, detail, tokensUsed) {
    const goal = this.store.current(sessionID);
    if (!goal || !isNonTerminal(goal.status))
      return goal;
    const updated = this.store.recordRound({
      goalID: goal.id,
      generation: goal.generation,
      classification,
      detail,
      tokensUsed
    });
    if (classification === "noProgress" && updated.noProgressRounds >= this.maxNoProgressRounds && updated.status === "active") {
      return this.store.transition({
        goalID: updated.id,
        generation: updated.generation,
        to: "stalled",
        actor: "controller",
        reason: `${updated.noProgressRounds} consecutive rounds without progress`
      });
    }
    return updated;
  }
  enforceBudget(sessionID) {
    const goal = this.store.current(sessionID);
    if (!goal || goal.status !== "active")
      return goal;
    if (goal.tokenBudget !== undefined && (goal.tokensUsed ?? 0) >= goal.tokenBudget) {
      return this.store.transition({
        goalID: goal.id,
        generation: goal.generation,
        to: "budgetLimited",
        actor: "controller",
        reason: `token budget reached (${goal.tokensUsed}/${goal.tokenBudget})`
      });
    }
    return goal;
  }
  commitComplete(goalID, generation, reason) {
    const outstanding = this.store.outstandingRound(goalID);
    if (outstanding) {
      try {
        this.store.settleRound({
          roundID: outstanding.id,
          classification: "complete",
          detail: reason
        });
        this.store.recordRound({
          goalID,
          generation,
          classification: "complete",
          detail: reason
        });
      } catch {}
    }
    return this.store.transition({
      goalID,
      generation,
      to: "complete",
      actor: "controller",
      reason
    });
  }
  rejectCompletion(sessionID, reason) {
    const goal = this.store.current(sessionID);
    if (!goal || goal.status !== "verifying")
      return goal;
    return this.store.transition({
      goalID: goal.id,
      generation: goal.generation,
      to: "active",
      actor: "controller",
      reason
    });
  }
  requireCurrent(sessionID) {
    const goal = this.store.current(sessionID);
    if (!goal)
      throw new GoalConflictError(`session ${sessionID} has no current goal`);
    return goal;
  }
  resolveTarget(sessionID, ref) {
    const current = this.store.current(sessionID);
    if (!current)
      return { ok: false, rejected: "no active goal for this session" };
    if (!isNonTerminal(current.status)) {
      return { ok: false, rejected: `goal is ${current.status}` };
    }
    if (ref?.goalID !== undefined && ref.goalID !== current.id) {
      return {
        ok: false,
        rejected: `stale goal reference: ${ref.goalID} is not the current goal (${current.id})`
      };
    }
    if (ref?.generation !== undefined && ref.generation !== current.generation) {
      return {
        ok: false,
        rejected: `stale generation: callback claimed ${ref.generation}, current is ${current.generation}`
      };
    }
    return { ok: true, goal: current };
  }
}

// src/controller/driver.ts
var seq = 0;
function newInboxID() {
  seq += 1;
  const rand = Math.random().toString(36).slice(2, 10);
  return `msg_xgoal_${Date.now().toString(36)}${seq.toString(36)}${rand}`;
}
var DEFAULT_CONTINUATION = (goal) => [
  "Continue working toward the active goal.",
  "",
  `Objective: ${goal.objective}`,
  "",
  "Inspect the current state before acting. Take the next useful action.",
  "A workflow preference, an optional decision, or a choice between reasonable",
  "next steps is not a blocker — choose and continue. If the objective is",
  "genuinely satisfied, propose completion with evidence."
].join(`
`);

class GoalDriver {
  store;
  transport;
  maxNoProgressRounds;
  maxRoundAttempts;
  render;
  constructor(store, transport, options = {}) {
    this.store = store;
    this.transport = transport;
    this.maxNoProgressRounds = options.maxNoProgressRounds ?? 3;
    this.maxRoundAttempts = options.maxRoundAttempts ?? 5;
    this.render = options.renderContinuation ?? DEFAULT_CONTINUATION;
  }
  async drive(sessionID) {
    const decision = this.reserve(sessionID);
    if (decision.action !== "dispatch")
      return decision.outcome;
    return this.dispatch(decision.round, sessionID);
  }
  reserve(sessionID) {
    const goal = this.store.current(sessionID);
    if (!goal)
      return { action: "done", outcome: { action: "idle", reason: "no goal" } };
    if (goal.status !== "active") {
      return {
        action: "done",
        outcome: { action: "idle", reason: `goal status is ${goal.status}` }
      };
    }
    const outstanding = this.store.outstandingRound(goal.id);
    if (outstanding) {
      return {
        action: "done",
        outcome: { action: "reconcile", roundID: outstanding.id, status: outstanding.status }
      };
    }
    if (goal.tokenBudget !== undefined && (goal.tokensUsed ?? 0) >= goal.tokenBudget) {
      const limited = this.store.transition({
        goalID: goal.id,
        generation: goal.generation,
        to: "budgetLimited",
        actor: "controller",
        reason: `token budget reached (${goal.tokensUsed}/${goal.tokenBudget})`
      });
      return { action: "done", outcome: { action: "limited", status: limited.status } };
    }
    const inboxID = newInboxID();
    const round = this.store.prepareRound({
      goalID: goal.id,
      generation: goal.generation,
      inboxID
    });
    return { action: "dispatch", round };
  }
  async dispatch(round, sessionID) {
    const goal = this.store.byID(round.goalID);
    if (!goal || goal.generation !== round.generation || isTerminal(goal.status)) {
      const detail = goal ? `goal moved to generation ${goal.generation} / ${goal.status}` : "goal no longer exists";
      this.store.markRoundFailed(round.id, `abandoned before admission: ${detail}`);
      return { action: "abandoned", roundID: round.id, detail };
    }
    try {
      const result = await this.transport.submit({
        sessionID,
        inboxID: round.inboxID,
        text: this.render(goal),
        metadata: { goalID: goal.id, generation: goal.generation, roundID: round.id }
      });
      if (result.ok) {
        this.store.markRoundAdmitted(round.id);
        return { action: "admitted", roundID: round.id, inboxID: round.inboxID };
      }
      if (result.retryable) {
        this.store.markRoundUnknown(round.id, result.error);
        return {
          action: "unknown",
          roundID: round.id,
          inboxID: round.inboxID,
          detail: result.error
        };
      }
      this.store.markRoundFailed(round.id, result.error);
      return {
        action: "failed",
        roundID: round.id,
        inboxID: round.inboxID,
        detail: result.error
      };
    } catch (error) {
      const detail = String(error);
      this.store.markRoundUnknown(round.id, detail);
      return { action: "unknown", roundID: round.id, inboxID: round.inboxID, detail };
    }
  }
  async reconcile() {
    const out = [];
    for (const round of this.store.outstandingRounds()) {
      out.push(await this.reconcileRound(round));
    }
    return out;
  }
  async reconcileRound(round) {
    const goal = this.store.byID(round.goalID);
    if (!goal) {
      this.store.markRoundFailed(round.id, "goal vanished");
      return { action: "failed", roundID: round.id, inboxID: round.inboxID, detail: "goal vanished" };
    }
    if (goal.generation !== round.generation || isTerminal(goal.status)) {
      const detail = `superseded (generation ${goal.generation}, status ${goal.status})`;
      this.store.markRoundFailed(round.id, detail);
      return { action: "failed", roundID: round.id, inboxID: round.inboxID, detail };
    }
    if (round.attempts > this.maxRoundAttempts) {
      const detail = `exceeded ${this.maxRoundAttempts} submission attempts`;
      this.store.markRoundFailed(round.id, detail);
      return { action: "failed", roundID: round.id, inboxID: round.inboxID, detail };
    }
    const probe = await this.transport.probe({ sessionID: goal.sessionID, round });
    switch (probe) {
      case "running":
        this.store.markRoundRunning(round.id);
        return { action: "reconcile", roundID: round.id, status: "running" };
      case "settled":
        return { action: "reconcile", roundID: round.id, status: "settled" };
      case "notDelivered": {
        try {
          this.store.markRoundUnknown(round.id, "not delivered; retrying with original id");
        } catch {}
        const retry = this.store.roundByID(round.id);
        return this.dispatch(retry, goal.sessionID);
      }
      case "unknown":
      default:
        return { action: "reconcile", roundID: round.id, status: round.status };
    }
  }
  settleRound(input) {
    const round = this.store.roundByID(input.roundID);
    if (!round)
      throw new GoalConflictError(`unknown round ${input.roundID}`);
    this.store.settleRound({
      roundID: input.roundID,
      classification: input.classification,
      detail: input.detail
    });
    return this.store.recordRound({
      goalID: round.goalID,
      generation: round.generation,
      classification: input.classification,
      detail: input.detail,
      tokensUsed: input.tokensUsed
    });
  }
  get stallThreshold() {
    return this.maxNoProgressRounds;
  }
}

// src/controller/transport.ts
class RoundObserver {
  seen = new Map;
  slot(inboxID) {
    let s = this.seen.get(inboxID);
    if (!s) {
      s = { enqueued: false, delivered: false, running: false, finished: false };
      this.seen.set(inboxID, s);
    }
    return s;
  }
  observe(event) {
    const e = event;
    const type = e?.type;
    if (!type)
      return;
    const d = e?.data ?? {};
    const p = e?.properties ?? {};
    const pick = (k) => d[k] ?? p[k];
    const id = pick("messageID") ?? pick("messageId") ?? pick("message")?.id ?? pick("info")?.id;
    if (!id || !id.startsWith("msg_xgoal_"))
      return;
    const s = this.slot(id);
    switch (type) {
      case "session.inbox.enqueued":
        s.enqueued = true;
        break;
      case "session.inbox.delivered":
        s.enqueued = true;
        s.delivered = true;
        break;
      case "session.execution.started":
        s.delivered = true;
        s.running = true;
        break;
      case "session.execution.succeeded":
      case "session.execution.failed":
        s.finished = true;
        s.running = false;
        break;
      default:
        break;
    }
  }
  probe(inboxID) {
    const s = this.seen.get(inboxID);
    if (!s)
      return "unknown";
    if (s.finished)
      return "settled";
    if (s.running)
      return "running";
    if (s.enqueued || s.delivered)
      return "running";
    return "unknown";
  }
  forget(inboxID) {
    this.seen.delete(inboxID);
  }
}
function classify(error) {
  const message = error instanceof Error ? error.message : String(error);
  const status = error;
  const code = status?.status ?? status?.statusCode;
  if (typeof code === "number" && code >= 400 && code < 500 && code !== 408 && code !== 429) {
    return { ok: false, retryable: false, error: message };
  }
  if (typeof code === "number" && code === 404) {
    return { ok: false, retryable: false, error: message };
  }
  return { ok: false, retryable: true, error: message };
}

class SessionTransport {
  observer;
  send;
  constructor(options) {
    this.observer = options.observer;
    this.send = options.send;
  }
  async submit(input) {
    try {
      await this.send(input);
      return { ok: true };
    } catch (error) {
      return classify(error);
    }
  }
  async probe(input) {
    return this.observer.probe(input.round.inboxID);
  }
}

// src/controller/verification.ts
class EvidenceLedger {
  store;
  constructor(store) {
    this.store = store;
  }
  capture(input) {
    const args = input.args ?? {};
    const now = Date.now();
    if ((input.tool === "shell" || input.tool === "bash") && input.status === "completed") {
      const command = String(args.command ?? args.cmd ?? "").trim();
      if (!command)
        return;
      const exitCode = extractExitCode(input.result);
      const kind = /\b(test|pytest|bun test|go test|jest|vitest|cargo test)\b/.test(command) ? "test" : "command";
      const evidence = { kind, ref: command.slice(0, 400), exitCode, atMs: now };
      this.store.addEvidence({
        goalID: input.goalID,
        kind,
        ref: evidence.ref,
        detail: exitCode === undefined ? undefined : `exit ${exitCode}`
      });
      return evidence;
    }
    if (input.status === "completed" && /write|edit|patch|create/.test(input.tool)) {
      const path = String(args.filePath ?? args.file_path ?? args.path ?? "").trim();
      if (!path)
        return;
      const evidence = { kind: "file", ref: path, atMs: now };
      this.store.addEvidence({
        goalID: input.goalID,
        kind: "file",
        ref: path,
        detail: "observed write"
      });
      return evidence;
    }
    return;
  }
  forGoal(goalID) {
    return this.store.listEvidence(goalID).map((e) => ({
      kind: e.kind,
      ref: e.ref,
      atMs: Date.now(),
      criterionID: e.criterionID
    }));
  }
}
function extractExitCode(result) {
  if (!result)
    return;
  const r = result;
  const direct = r.exitCode ?? r.exit_code ?? r.code;
  if (typeof direct === "number")
    return direct;
  const nested = r.metadata?.exitCode;
  if (typeof nested === "number")
    return nested;
  return;
}

class GoalVerifier {
  store;
  validator;
  constructor(store, validator) {
    this.store = store;
    this.validator = validator;
  }
  async verify(goalID) {
    const goal = this.store.byID(goalID);
    if (!goal)
      return { verdict: "incomplete", unmet: [], reason: "unknown goal" };
    const criteria = this.store.listCriteria(goalID);
    const evidence = this.store.listEvidence(goalID);
    const unmet = [];
    if (criteria.length === 0) {
      return {
        verdict: "incomplete",
        unmet: ["no acceptance criteria recorded for the objective"],
        reason: "cannot verify completion of an objective with no criteria; the controller must first establish what success means"
      };
    }
    const verifiable = evidence.filter((e) => e.kind !== "ref");
    if (verifiable.length === 0) {
      return {
        verdict: "incomplete",
        unmet: ["no machine-verifiable evidence submitted"],
        reason: "completion requires evidence the controller observed (a command that ran, a file that changed); a model statement is not evidence"
      };
    }
    for (const item of verifiable) {
      const validation = await this.validator.validate({
        kind: item.kind,
        ref: item.ref,
        atMs: Date.now(),
        criterionID: item.criterionID
      });
      if (!validation.valid) {
        unmet.push(`evidence no longer valid: ${item.ref} (${validation.reason})`);
      }
    }
    const validatingRefs = new Set(verifiable.filter((e) => !unmet.some((u) => u.includes(e.ref))).map((e) => e.ref));
    for (const criterion of criteria) {
      const bound = evidence.some((e) => e.criterionID === criterion.id && validatingRefs.has(e.ref));
      const coveredByGeneral = validatingRefs.size > 0 && criteria.length <= validatingRefs.size;
      if (!bound && !coveredByGeneral) {
        unmet.push(`criterion not evidenced: ${criterion.text}`);
      }
    }
    if (unmet.length > 0) {
      return {
        verdict: "incomplete",
        unmet,
        reason: `${unmet.length} condition(s) unsatisfied against current evidence`
      };
    }
    return {
      verdict: "complete",
      unmet: [],
      reason: `objective satisfied: ${criteria.length} criteria covered by ${validatingRefs.size} validated evidence item(s)`
    };
  }
}

// src/rpc.ts
var RPC_ID = "local.opencode-xgoal";
var str = { type: "string" };
var num = { type: "number" };
function wire(controller, goal) {
  if (!goal)
    return null;
  return {
    id: goal.id,
    generation: goal.generation,
    objective: goal.objective,
    status: goal.status,
    reason: goal.reason ?? null,
    rounds: goal.rounds,
    noProgressRounds: goal.noProgressRounds,
    tokensUsed: goal.tokensUsed ?? null,
    tokenBudget: goal.tokenBudget ?? null,
    criteria: controller.store.listCriteria(goal.id)
  };
}
var goalOrNull = {
  anyOf: [{ type: "object" }, { type: "null" }]
};
var goalRpcDefinition = {
  id: RPC_ID,
  methods: {
    "goal.status": {
      input: { type: "object", properties: { sessionID: str }, required: ["sessionID"] },
      output: { type: "object", properties: { goal: goalOrNull } }
    },
    "goal.history": {
      input: { type: "object", properties: { sessionID: str }, required: ["sessionID"] },
      output: {
        type: "object",
        properties: { goals: { type: "array", items: { type: "object" } } }
      }
    },
    "goal.replace": {
      input: {
        type: "object",
        properties: {
          sessionID: str,
          objective: str,
          expectedGeneration: num
        },
        required: ["sessionID", "objective", "expectedGeneration"]
      },
      output: { type: "object", properties: { goal: goalOrNull, error: str } }
    },
    "goal.pause": {
      input: { type: "object", properties: { sessionID: str }, required: ["sessionID"] },
      output: { type: "object", properties: { goal: goalOrNull } }
    },
    "goal.resume": {
      input: { type: "object", properties: { sessionID: str }, required: ["sessionID"] },
      output: { type: "object", properties: { goal: goalOrNull } }
    }
  },
  events: {
    "goal.changed": {
      schema: {
        type: "object",
        properties: { sessionID: str, status: str, generation: num }
      }
    }
  }
};
function goalRpcHandlers(controller) {
  return {
    "goal.status": async (input) => {
      if (!input?.sessionID)
        return { goal: null };
      return { goal: wire(controller, controller.status(input.sessionID)) };
    },
    "goal.history": async (input) => {
      if (!input?.sessionID)
        return { goals: [] };
      return {
        goals: controller.history(input.sessionID).map((g) => wire(controller, g)).filter(Boolean)
      };
    },
    "goal.replace": async (input) => {
      const { sessionID, objective, expectedGeneration } = input ?? {};
      if (!sessionID || !objective || typeof expectedGeneration !== "number") {
        return { goal: null, error: "sessionID, objective and expectedGeneration are required" };
      }
      try {
        const goal = controller.replace(sessionID, objective, expectedGeneration);
        return { goal: wire(controller, goal) };
      } catch (error) {
        return { goal: null, error: String(error) };
      }
    },
    "goal.pause": async (input) => {
      if (!input?.sessionID)
        return { goal: null };
      try {
        return { goal: wire(controller, controller.pause(input.sessionID)) };
      } catch (error) {
        return { goal: null, error: String(error) };
      }
    },
    "goal.resume": async (input) => {
      if (!input?.sessionID)
        return { goal: null };
      try {
        return { goal: wire(controller, controller.resume(input.sessionID)) };
      } catch (error) {
        return { goal: null, error: String(error) };
      }
    }
  };
}

// src/index.ts
var LOG = process.env.XGOAL_HARNESS_LOG ?? "";
function record(entry) {
  if (!LOG)
    return;
  try {
    mkdirSync(dirname(LOG), { recursive: true });
    appendFileSync(LOG, JSON.stringify({ ts: Date.now(), ...entry }) + `
`);
  } catch {}
}
function dbPath() {
  if (process.env.XGOAL_DB)
    return process.env.XGOAL_DB;
  const dataHome = process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
  return join(dataHome, "opencode-xgoal", "goals.db");
}
function sessionIDOf(event) {
  const e = event;
  return e?.data?.sessionID ?? e?.properties?.sessionID ?? e?.sessionID;
}
function obj(properties, required = []) {
  return { type: "object", properties, required, additionalProperties: false };
}
var str2 = { type: "string" };
var strArray = { type: "array", items: { type: "string" } };
var num2 = { type: "number" };
var src_default = {
  id: "opencode-xgoal",
  async setup(ctx) {
    const abort = new AbortController;
    let controller;
    let startupError;
    try {
      mkdirSync(dirname(dbPath()), { recursive: true });
      controller = new GoalController({ dbPath: dbPath() });
      const repaired = controller.reconcileStartup();
      record({ event: "controller.ready", dbPath: dbPath(), reconciled: repaired.length });
    } catch (error) {
      startupError = String(error);
      record({ event: "controller.failed", error: startupError });
    }
    const observer = new RoundObserver;
    let driver;
    let ledger;
    let verifier;
    let sweep;
    if (controller) {
      const transport = new SessionTransport({
        observer,
        send: async ({ sessionID, inboxID, text, metadata }) => {
          await ctx.session.synthetic({
            sessionID,
            id: inboxID,
            text,
            metadata,
            delivery: "queue"
          });
        }
      });
      driver = new GoalDriver(controller.store, transport);
      ledger = new EvidenceLedger(controller.store);
      verifier = new GoalVerifier(controller.store, {
        async validate(evidence) {
          if (evidence.kind === "file") {
            try {
              return existsSync(evidence.ref) ? { valid: true, reason: "file present" } : { valid: false, reason: "file not found" };
            } catch {
              return { valid: false, reason: "file could not be checked" };
            }
          }
          if (evidence.kind === "command" || evidence.kind === "test" || evidence.kind === "runtime") {
            return { valid: true, reason: "observed to complete by the controller" };
          }
          return { valid: false, reason: "unverifiable reference" };
        }
      });
      driver.reconcile().then((outcomes) => record({ event: "driver.reconciled", count: outcomes.length })).catch((error) => record({ event: "driver.reconcile.error", error: String(error) }));
      const sweepMs = Number(process.env.XGOAL_SWEEP_MS ?? "20000");
      sweep = setInterval(() => {
        driver?.reconcile().catch((error) => record({ event: "driver.sweep.error", error: String(error) }));
      }, sweepMs);
      sweep?.unref?.();
    }
    record({
      event: "setup.begin",
      pluginId: "opencode-xgoal",
      domains: Object.keys(ctx ?? {}).sort(),
      sessionMethods: typeof ctx?.session === "object" ? Object.keys(ctx.session).sort() : [],
      controllerReady: controller !== undefined
    });
    try {
      await ctx.tool.transform((editor) => {
        editor.add({
          name: "goal_get",
          description: "Report the current goal for this session, including status, generation, round counts and unmet criteria.",
          input: obj({}),
          async execute(_input, toolCtx) {
            if (!controller)
              return { content: `goal controller unavailable: ${startupError}` };
            const goal = controller.get(toolCtx?.sessionID);
            if (!goal)
              return { content: "No active goal for this session." };
            const criteria = controller.store.listCriteria(goal.id);
            return {
              content: JSON.stringify({
                id: goal.id,
                generation: goal.generation,
                objective: goal.objective,
                status: goal.status,
                rounds: goal.rounds,
                noProgressRounds: goal.noProgressRounds,
                tokensUsed: goal.tokensUsed ?? null,
                tokenBudget: goal.tokenBudget ?? null,
                criteria
              }, null, 2),
              metadata: { goalID: goal.id, generation: goal.generation, status: goal.status }
            };
          }
        });
        editor.add({
          name: "goal_checkpoint",
          description: "Record progress toward the current goal without changing its status. Use for completed work, or for investigation that materially narrows the problem.",
          input: obj({
            summary: str2,
            evidence_refs: strArray,
            goal_id: str2,
            generation: num2
          }, ["summary"]),
          async execute(input, toolCtx) {
            if (!controller)
              return { content: `goal controller unavailable: ${startupError}` };
            const out = controller.checkpoint(toolCtx?.sessionID, {
              summary: String(input?.summary ?? ""),
              evidenceRefs: input?.evidence_refs,
              goalID: input?.goal_id,
              generation: input?.generation
            });
            if (!out.recorded)
              return { content: `Checkpoint not recorded: ${out.rejected}` };
            return {
              content: `Checkpoint recorded. Goal is ${out.goal?.status}.`,
              metadata: { status: out.goal?.status, rounds: out.goal?.rounds }
            };
          }
        });
        editor.add({
          name: "goal_propose_complete",
          description: "Propose that the goal's original objective has been fully achieved. This moves the goal to verification; it does not complete it. The controller decides completion.",
          input: obj({ summary: str2, evidence_refs: strArray, goal_id: str2, generation: num2 }, [
            "summary"
          ]),
          async execute(input, toolCtx) {
            if (!controller)
              return { content: `goal controller unavailable: ${startupError}` };
            const sessionID = toolCtx?.sessionID;
            const out = controller.proposeComplete(sessionID, {
              summary: String(input?.summary ?? ""),
              evidenceRefs: input?.evidence_refs,
              goalID: input?.goal_id,
              generation: input?.generation
            });
            if (out.rejected)
              return { content: `Completion proposal rejected: ${out.rejected}` };
            const goal = controller.status(sessionID);
            if (!goal || !verifier) {
              return {
                content: "Completion proposed and pending verification.",
                metadata: { status: goal?.status }
              };
            }
            const result = await verifier.verify(goal.id);
            if (result.verdict === "complete") {
              const done = controller.commitComplete(goal.id, goal.generation, result.reason);
              record({ event: "completion.verified", goalID: goal.id, reason: result.reason });
              return {
                content: `Completion verified and the goal is now complete. ${result.reason}`,
                metadata: { status: done.status }
              };
            }
            const back = controller.rejectCompletion(sessionID, result.reason);
            record({
              event: "completion.rejected",
              goalID: goal.id,
              unmet: result.unmet,
              reason: result.reason
            });
            return {
              content: [
                "Completion NOT verified. The goal remains active.",
                `Reason: ${result.reason}`,
                result.unmet.length ? `Unsatisfied conditions:
${result.unmet.map((u) => `- ${u}`).join(`
`)}` : "",
                "Address these and continue working."
              ].filter(Boolean).join(`
`),
              metadata: { status: back?.status, unmet: result.unmet }
            };
          }
        });
        editor.add({
          name: "goal_report_blocked",
          description: "Report that the goal cannot proceed. Only use this for a genuine external dependency: missing credentials, permissions, or required information. A workflow preference, an optional decision, or a choice between reasonable next steps is NOT a blocker — continue working instead.",
          input: obj({
            reason: str2,
            evidence_refs: strArray,
            external_dependency: { type: "boolean" },
            goal_id: str2,
            generation: num2
          }, ["reason"]),
          async execute(input, toolCtx) {
            if (!controller)
              return { content: `goal controller unavailable: ${startupError}` };
            const out = controller.reportBlocked(toolCtx?.sessionID, {
              reason: String(input?.reason ?? ""),
              evidenceRefs: input?.evidence_refs,
              externalDependency: input?.external_dependency === true,
              goalID: input?.goal_id,
              generation: input?.generation
            });
            if (out.rejected)
              return { content: `Blocker report rejected: ${out.rejected}` };
            if (!out.accepted) {
              return {
                content: "Blocker not accepted: no concrete external dependency was identified. The goal remains active — take the next useful action.",
                metadata: { confirmations: out.confirmations, status: out.goal?.status }
              };
            }
            return {
              content: "Blocker accepted. The goal is now blocked pending user action.",
              metadata: { status: out.goal?.status }
            };
          }
        });
      });
      record({ event: "tools.registered", ok: true });
    } catch (error) {
      record({ event: "tools.registered", ok: false, error: String(error) });
    }
    try {
      if (controller && ctx.rpc?.register) {
        await ctx.rpc.register(goalRpcDefinition, goalRpcHandlers(controller));
        record({ event: "rpc.registered", ok: true });
      } else {
        record({ event: "rpc.registered", ok: false, reason: "rpc domain unavailable" });
      }
    } catch (error) {
      record({ event: "rpc.registered", ok: false, error: String(error) });
    }
    try {
      await ctx.command.transform((editor) => {
        editor.add({
          name: "goal",
          description: "Set, replace, inspect or control the session goal",
          async execute(invocation) {
            const sessionID = invocation?.sessionID;
            const raw = String(invocation?.prompt?.text ?? "").trim();
            if (!controller)
              return;
            const [verb, ...rest] = raw.split(/\s+/);
            const arg = rest.join(" ").trim();
            const reply = (text) => record({ event: "command.reply", sessionID, text: text.slice(0, 200) });
            try {
              if (!verb) {
                const goal = controller.status(sessionID);
                reply(goal ? `Goal ${goal.generation}: [${goal.status}] ${goal.objective} (rounds ${goal.rounds})` : "No active goal. Use /goal <objective>.");
                return;
              }
              if (verb === "status") {
                const goal = controller.status(sessionID);
                reply(goal ? `[${goal.status}] ${goal.objective}` : "No active goal.");
                return;
              }
              if (verb === "history") {
                const history = controller.history(sessionID);
                reply(history.length ? history.map((g) => `gen ${g.generation} [${g.status}] ${g.objective}`).join(`
`) : "No goal history.");
                return;
              }
              if (verb === "pause") {
                reply(`Paused: ${controller.pause(sessionID).status}`);
                return;
              }
              if (verb === "resume") {
                reply(`Resumed: ${controller.resume(sessionID).status}`);
                return;
              }
              if (verb === "replace") {
                if (!arg)
                  return reply("Usage: /goal replace <objective>");
                const goal = controller.replace(sessionID, arg);
                reply(`Replaced. Generation ${goal.generation} is now active.`);
                return;
              }
              if (verb === "budget") {
                const goal = controller.status(sessionID);
                if (!goal)
                  return reply("No active goal.");
                const used = goal.tokensUsed ?? 0;
                if (!arg) {
                  reply(`Tokens: ${used}${goal.tokenBudget !== undefined ? ` / ${goal.tokenBudget}` : " (no budget set)"}`);
                  return;
                }
                const n = Number(arg);
                if (!Number.isFinite(n) || n <= 0)
                  return reply("Usage: /goal budget <positive number>");
                controller.store.db.query("UPDATE goals SET token_budget = ? WHERE id = ?").run(Math.floor(n), goal.id);
                reply(`Budget set to ${Math.floor(n)} tokens (used ${used}).`);
                return;
              }
              const objective = raw;
              const out = controller.startOrDescribe(sessionID, objective);
              if ("existing" in out) {
                reply(`A goal is already active (generation ${out.existing.generation}): ${out.existing.objective}
Use /goal replace <objective> to supersede it.`);
              } else {
                reply(`Goal created (generation ${out.created.generation}).`);
              }
            } catch (error) {
              reply(`Goal command failed: ${String(error)}`);
            }
          }
        });
      });
      record({ event: "command.registered", ok: true });
    } catch (error) {
      record({ event: "command.registered", ok: false, error: String(error) });
    }
    try {
      await ctx.session.hook("context", async (event) => {
        if (!controller)
          return;
        const goal = controller.status(event?.sessionID);
        record({
          event: "session.context",
          sessionID: event?.sessionID,
          agent: event?.agent,
          hasGoal: Boolean(goal),
          status: goal?.status
        });
        if (!goal || goal.status !== "active")
          return;
        if (!Array.isArray(event?.system))
          return;
        const unmet = controller.store.listCriteria(goal.id).filter((c) => !c.met).map((c) => `- ${c.text}`);
        event.system.push({
          type: "text",
          text: [
            `Active goal (generation ${goal.generation}): ${goal.objective}`,
            "",
            "Completion contract:",
            "- The original objective is authoritative.",
            "- Inspect current evidence before claiming success.",
            "- If unfinished, take the next useful action.",
            "- A workflow preference or optional choice is not a blocker.",
            "- Propose completion only when the objective is actually satisfied.",
            unmet.length ? `
Outstanding criteria:
${unmet.join(`
`)}` : ""
          ].filter(Boolean).join(`
`)
        });
      });
      record({ event: "session.hook.context", ok: true });
    } catch (error) {
      record({ event: "session.hook.context", ok: false, error: String(error) });
    }
    try {
      await ctx.session.hook("compaction", async (event) => {
        if (!controller)
          return;
        const goal = controller.status(event?.sessionID);
        record({ event: "session.compaction", sessionID: event?.sessionID, status: goal?.status });
      });
      record({ event: "session.hook.compaction", ok: true });
    } catch (error) {
      record({ event: "session.hook.compaction", ok: false, error: String(error) });
    }
    try {
      await ctx.tool.hook("execute.after", async (event) => {
        const sessionID = sessionIDOf(event);
        record({
          event: "tool.execute.after",
          tool: event?.tool,
          sessionID,
          status: event?.status
        });
        if (!controller || !ledger || !sessionID)
          return;
        const goal = controller.status(sessionID);
        if (!goal || goal.status !== "active")
          return;
        try {
          const captured = ledger.capture({
            goalID: goal.id,
            tool: String(event?.tool ?? ""),
            status: event?.status === "completed" ? "completed" : "error",
            args: event?.input ?? event?.args,
            result: event?.result
          });
          if (captured) {
            record({
              event: "evidence.captured",
              goalID: goal.id,
              kind: captured.kind,
              ref: captured.ref.slice(0, 120),
              exitCode: captured.exitCode ?? null
            });
          }
        } catch (error) {
          record({ event: "evidence.capture.error", error: String(error) });
        }
      });
      record({ event: "tool.hook.execute.after", ok: true });
    } catch (error) {
      record({ event: "tool.hook.execute.after", ok: false, error: String(error) });
    }
    const eventsSeen = new Set;
    const IDLE_SIGNALS = new Set([
      "session.execution.succeeded",
      "session.execution.failed",
      "session.inbox.delivered"
    ]);
    let lastDrive = 0;
    (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: abort.signal })) {
          const type = String(event?.type ?? "unknown");
          eventsSeen.add(type);
          observer.observe(event);
          record({ event: "event", type, total: eventsSeen.size });
          if (!driver || !IDLE_SIGNALS.has(type))
            continue;
          const now = Date.now();
          if (now - lastDrive < 500)
            continue;
          lastDrive = now;
          const sessionID = sessionIDOf(event);
          if (!sessionID)
            continue;
          try {
            const outcome = await driver.drive(sessionID);
            record({ event: "driver.drive", sessionID, outcome: outcome.action });
          } catch (error) {
            record({ event: "driver.drive.error", sessionID, error: String(error) });
          }
        }
      } catch (error) {
        record({ event: "event.stream.error", error: String(error) });
      }
    })();
    record({ event: "setup.complete" });
    return async () => {
      abort.abort();
      if (sweep)
        clearInterval(sweep);
      try {
        controller?.close();
      } catch {}
      record({ event: "cleanup", eventsObserved: eventsSeen.size });
    };
  }
};
export {
  src_default as default
};
