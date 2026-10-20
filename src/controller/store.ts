/**
 * OpenCode-XGoal — durable goal store.
 *
 * Correctness properties this file is responsible for:
 *
 *  1. One authoritative current goal per session, enforced by a partial unique
 *     index rather than by application logic alone.
 *  2. Generation fencing. Every mutation names the generation it believes is
 *     current; a stale generation is rejected, so a late callback from a
 *     superseded goal cannot mutate its replacement.
 *  3. Optimistic concurrency. Every row carries a `version`; mutations are
 *     compare-and-swap on it, so two writers cannot both win.
 *  4. Atomicity. All multi-step mutations run inside BEGIN IMMEDIATE, which
 *     takes the write lock up front and avoids upgrade deadlocks.
 *
 * `ctx.storage` is deliberately NOT used: it is a plain key/value store with no
 * compare-and-swap, so it cannot provide (2) or (3).
 */
import { Database } from "bun:sqlite";
import {
  type Actor,
  type Goal,
  type GoalStatus,
  canTransition,
  isNonTerminal,
  isTerminal,
} from "./state.ts";
import type { CriterionInput, CriterionSpec } from "./criteria.ts";

export interface GoalEvent {
  seq: number;
  goalID: string;
  generation: number;
  kind: string;
  fromStatus?: GoalStatus;
  toStatus?: GoalStatus;
  actor?: Actor;
  detail?: string;
  atMs: number;
}

export class GoalConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoalConflictError";
  }
}

export class TransitionRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransitionRejectedError";
  }
}

const SCHEMA = `
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
  -- Verification is only valid for the goal and evidence snapshot it actually
  -- checked. A stale verifier must not be able to complete a goal whose
  -- evidence changed underneath it.
  verification_revision    INTEGER NOT NULL DEFAULT 0,
  verification_snapshot    TEXT,
  -- Set when a continuation submission terminally failed. While set, the
  -- driver refuses to dispatch until recovery clears it, so a terminal
  -- delivery failure cannot be circumvented by minting a fresh continuation.
  delivery_failed          INTEGER NOT NULL DEFAULT 0,
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
  -- Optional machine-checkable spec (JSON). A criterion with a spec is
  -- verified independently of any evidence the model claims; a criterion
  -- without one still requires explicitly bound evidence.
  spec        TEXT,
  -- Who established the criterion: derived from the objective, an explicit
  -- user requirement, or a model refinement. Never removed to pass
  -- verification.
  source      TEXT NOT NULL DEFAULT 'derived',
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
  -- Persisted so validation can be real rather than trusting the capture:
  -- command/test/runtime must record the observed exit status, and file
  -- evidence records a content hash so staleness is detectable. The workspace
  -- is the session workspace the path resolved against at capture time, so a
  -- relative path can never be re-checked against the plugin's own cwd.
  exit_code   INTEGER,
  hash        TEXT,
  workspace   TEXT,
  at_ms       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS goal_evidence_goal ON goal_evidence (goal_id);
CREATE INDEX IF NOT EXISTS goal_evidence_criterion ON goal_evidence (criterion_id);

-- Per-criterion verification proofs. One row per criterion per verification
-- attempt, so an accepted proof can never be silently reused for a different
-- evidence snapshot.
CREATE TABLE IF NOT EXISTS goal_criterion_proofs (
  id            TEXT PRIMARY KEY,
  goal_id       TEXT NOT NULL,
  generation    INTEGER NOT NULL,
  criterion_id  TEXT NOT NULL,
  evidence_ids  TEXT NOT NULL,
  validator_id  TEXT NOT NULL,
  verdict       TEXT NOT NULL,
  detail        TEXT,
  created_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS goal_proofs_goal ON goal_criterion_proofs (goal_id);

-- Durable association between an assistant message and the goal generation
-- that produced it. This is what lets a tool call be fenced to the generation
-- it actually belongs to, instead of being resolved from whatever goal is
-- current when the callback arrives.
CREATE TABLE IF NOT EXISTS goal_message_generations (
  session_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  at_ms      INTEGER NOT NULL,
  PRIMARY KEY (session_id, message_id)
);

-- Blocker claims, one per reporting round. A model can call the blocker tool
-- many times in one turn; only distinct rounds count as confirmations, so
-- repetition inside a single execution cannot manufacture a blocker.
CREATE TABLE IF NOT EXISTS goal_blocker_claims (
  id           TEXT PRIMARY KEY,
  goal_id      TEXT NOT NULL,
  generation   INTEGER NOT NULL,
  round_number INTEGER NOT NULL,
  reason       TEXT NOT NULL,
  at_ms        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS goal_blocker_goal ON goal_blocker_claims (goal_id);

-- Last observed session-level token total. Usage events report a session
-- running total, not a per-goal delta, so we persist the total and charge the
-- difference to whatever goal is active. Without this the goal's budget is
-- never driven by real usage.
CREATE TABLE IF NOT EXISTS session_usage (
  session_id  TEXT PRIMARY KEY,
  total_tokens INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

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
  -- Number of evidence rows for the goal when this round was prepared. The
  -- delta at settlement is what distinguishes a round that produced verified
  -- work from one that merely emitted text: a no-evidence round is not progress.
  evidence_baseline INTEGER NOT NULL DEFAULT 0,
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

interface GoalRow {
  id: string;
  session_id: string;
  generation: number;
  objective: string;
  status: string;
  reason: string | null;
  rounds: number;
  no_progress_rounds: number;
  repeated_blocker_rounds: number;
  tokens_used: number | null;
  token_budget: number | null;
  version: number;
  created_at_ms: number;
  updated_at_ms: number;
  completed_at_ms: number | null;
  superseded_by: string | null;
  verification_revision: number;
  verification_snapshot: string | null;
  delivery_failed: number;
}

function toGoal(row: GoalRow): Goal {
  return {
    id: row.id,
    sessionID: row.session_id,
    generation: row.generation,
    objective: row.objective,
    status: row.status as GoalStatus,
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
    supersededBy: row.superseded_by ?? undefined,
    verificationRevision: row.verification_revision,
    verificationSnapshot: row.verification_snapshot ?? undefined,
    deliveryFailed: row.delivery_failed === 1,
  };
}

/** Normalize a blocker reason so trivial rewording still counts as the same blocker. */
function normalizeBlockerReason(reason: string): string {
  return reason.trim().toLowerCase().replace(/\s+/g, " ").replace(/[.!]+$/g, "");
}

let counter = 0;
function newID(prefix: string): string {
  counter += 1;
  return `${prefix}_${Date.now().toString(36)}_${counter.toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 10)}`;
}

export class GoalStore {
  readonly db: Database;
  /** Transaction nesting depth; lets compound ops join an open transaction. */
  private depth = 0;

  constructor(path: string) {
    this.db = new Database(path, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  /**
   * Run `fn` inside an IMMEDIATE transaction. Takes the write lock up front so
   * two concurrent writers serialise instead of deadlocking on upgrade.
   *
   * Reentrant: a nested call joins the enclosing transaction rather than
   * issuing a second BEGIN (which SQLite rejects). This is what lets a compound
   * operation compose transactional primitives atomically.
   */
  private tx<T>(fn: () => T): T {
    if (this.depth > 0) return fn();
    this.depth += 1;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* rollback failure must not mask the original error */
      }
      throw error;
    } finally {
      this.depth -= 1;
    }
  }

  private appendEvent(
    goalID: string,
    generation: number,
    kind: string,
    extra: Partial<Pick<GoalEvent, "fromStatus" | "toStatus" | "actor" | "detail">> = {},
  ): void {
    this.db
      .query(
        `INSERT INTO goal_events (goal_id, generation, kind, from_status, to_status, actor, detail, at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        goalID,
        generation,
        kind,
        extra.fromStatus ?? null,
        extra.toStatus ?? null,
        extra.actor ?? null,
        extra.detail ?? null,
        Date.now(),
      );
  }

  // ---------------------------------------------------------------- reads

  current(sessionID: string): Goal | undefined {
    const row = this.db
      .query<GoalRow, [string]>(
        `SELECT * FROM goals WHERE session_id = ? AND status NOT IN ('complete','superseded') LIMIT 1`,
      )
      .get(sessionID);
    return row ? toGoal(row) : undefined;
  }

  /** The newest goal in the session, including a completed one. */
  latest(sessionID: string): Goal | undefined {
    const row = this.db
      .query<GoalRow, [string]>(
        `SELECT * FROM goals WHERE session_id = ? ORDER BY generation DESC LIMIT 1`,
      )
      .get(sessionID);
    return row ? toGoal(row) : undefined;
  }

  byID(id: string): Goal | undefined {
    const row = this.db.query<GoalRow, [string]>(`SELECT * FROM goals WHERE id = ?`).get(id);
    return row ? toGoal(row) : undefined;
  }

  /** Look up a specific generation of a session's goal history. */
  byGeneration(sessionID: string, generation: number): Goal | undefined {
    const row = this.db
      .query<GoalRow, [string, number]>(
        `SELECT * FROM goals WHERE session_id = ? AND generation = ?`,
      )
      .get(sessionID, generation);
    return row ? toGoal(row) : undefined;
  }

  history(sessionID: string): Goal[] {
    return this.db
      .query<GoalRow, [string]>(
        `SELECT * FROM goals WHERE session_id = ? ORDER BY generation DESC`,
      )
      .all(sessionID)
      .map(toGoal);
  }

  /** Every non-terminal goal, across all sessions. Used by startup recovery. */
  activeGoals(): Goal[] {
    return this.db
      .query<GoalRow, []>(
        `SELECT * FROM goals WHERE status NOT IN ('complete','superseded') ORDER BY created_at_ms ASC`,
      )
      .all()
      .map(toGoal);
  }

  events(goalID: string): GoalEvent[] {
    return this.db
      .query<
        {
          seq: number;
          goal_id: string;
          generation: number;
          kind: string;
          from_status: string | null;
          to_status: string | null;
          actor: string | null;
          detail: string | null;
          at_ms: number;
        },
        [string]
      >(`SELECT * FROM goal_events WHERE goal_id = ? ORDER BY seq ASC`)
      .all(goalID)
      .map((r) => ({
        seq: r.seq,
        goalID: r.goal_id,
        generation: r.generation,
        kind: r.kind,
        fromStatus: (r.from_status ?? undefined) as GoalStatus | undefined,
        toStatus: (r.to_status ?? undefined) as GoalStatus | undefined,
        actor: (r.actor ?? undefined) as Actor | undefined,
        detail: r.detail ?? undefined,
        atMs: r.at_ms,
      }));
  }

  // --------------------------------------------------------------- writes

  /**
   * Create the first goal for a session, or fail if a non-terminal goal exists.
   * Callers wanting replacement semantics must use `replace`.
   */
  create(input: {
    sessionID: string;
    objective: string;
    tokenBudget?: number;
    actor?: Actor;
    criteria?: CriterionInput[];
  }): Goal {
    if (!input.objective || !input.objective.trim()) {
      throw new TransitionRejectedError("objective must not be empty");
    }
    return this.tx(() => {
      const existing = this.current(input.sessionID);
      if (existing) {
        throw new GoalConflictError(
          `session ${input.sessionID} already has a current goal (${existing.id}, generation ${existing.generation}, status ${existing.status}); use replace()`,
        );
      }
      const now = Date.now();
      const id = newID("goal");
      // Allocate monotonically from ALL historical goals in this session, not
      // just the current one. After a completed goal, `current()` returns null,
      // so a hardcoded 1 would collide with the finished goal's
      // (session_id, 1) uniqueness constraint.
      const nextGen = this.db
        .query<{ next_generation: number }, [string]>(
          `SELECT COALESCE(MAX(generation), 0) + 1 AS next_generation
           FROM goals WHERE session_id = ?`,
        )
        .get(input.sessionID)!.next_generation;
      const generation = nextGen;
      this.db
        .query(
          `INSERT INTO goals (id, session_id, generation, objective, status, rounds,
             no_progress_rounds, repeated_blocker_rounds, token_budget, version,
             created_at_ms, updated_at_ms)
           VALUES (?, ?, ?, ?, 'active', 0, 0, 0, ?, 0, ?, ?)`,
        )
        .run(id, input.sessionID, generation, input.objective.trim(), input.tokenBudget ?? null, now, now);
      this.appendEvent(id, generation, "created", {
        toStatus: "active",
        actor: input.actor ?? "user",
        detail: input.objective.trim().slice(0, 200),
      });
      for (const criterion of input.criteria ?? []) {
        this.insertCriterion(id, generation, criterion, now);
      }
      return this.byID(id)!;
    });
  }

  /**
   * Atomically supersede the current goal and create its replacement.
   *
   * `expectedGeneration` is the caller's belief about what is current. If the
   * world moved on, this throws rather than clobbering a newer goal.
   */
  replace(input: {
    sessionID: string;
    expectedGeneration: number;
    objective: string;
    tokenBudget?: number;
    actor?: Actor;
    reason?: string;
    criteria?: CriterionInput[];
  }): Goal {
    if (!input.objective || !input.objective.trim()) {
      throw new TransitionRejectedError("objective must not be empty");
    }
    return this.tx(() => {
      const existing = this.current(input.sessionID);
      if (!existing) {
        throw new GoalConflictError(`session ${input.sessionID} has no current goal to replace`);
      }
      if (existing.generation !== input.expectedGeneration) {
        throw new GoalConflictError(
          `stale replacement: expected generation ${input.expectedGeneration}, found ${existing.generation}`,
        );
      }
      const now = Date.now();
      const newIDValue = newID("goal");
      const nextGeneration = existing.generation + 1;

      this.db
        .query(
          `UPDATE goals SET status='superseded', superseded_by=?, updated_at_ms=?, version=version+1
           WHERE id=? AND version=?`,
        )
        .run(newIDValue, now, existing.id, existing.version);

      this.appendEvent(existing.id, existing.generation, "superseded", {
        fromStatus: existing.status,
        toStatus: "superseded",
        actor: input.actor ?? "user",
        detail: input.reason ?? `replaced by ${newIDValue}`,
      });

      this.db
        .query(
          `INSERT INTO goals (id, session_id, generation, objective, status, rounds,
             no_progress_rounds, repeated_blocker_rounds, token_budget, version,
             created_at_ms, updated_at_ms)
           VALUES (?, ?, ?, ?, 'active', 0, 0, 0, ?, 0, ?, ?)`,
        )
        .run(
          newIDValue,
          input.sessionID,
          nextGeneration,
          input.objective.trim(),
          input.tokenBudget ?? existing.tokenBudget ?? null,
          now,
          now,
        );

      this.appendEvent(newIDValue, nextGeneration, "created", {
        toStatus: "active",
        actor: input.actor ?? "user",
        detail: `replaces ${existing.id} (generation ${existing.generation})`,
      });

      for (const criterion of input.criteria ?? []) {
        this.insertCriterion(newIDValue, nextGeneration, criterion, now);
      }

      return this.byID(newIDValue)!;
    });
  }

  /**
   * Validated, generation-fenced, compare-and-swap status change.
   *
   * Rejects when: the goal is unknown, the generation is stale (late callback
   * from a superseded goal), the optimistic version moved, or the transition is
   * not permitted for the given actor.
   */
  transition(input: {
    goalID: string;
    generation: number;
    to: GoalStatus;
    actor: Actor;
    reason?: string;
    expectedVersion?: number;
  }): Goal {
    return this.tx(() => {
      const goal = this.byID(input.goalID);
      if (!goal) {
        throw new GoalConflictError(`unknown goal ${input.goalID}`);
      }
      if (goal.generation !== input.generation) {
        throw new GoalConflictError(
          `stale generation: goal ${input.goalID} is generation ${goal.generation}, callback claimed ${input.generation}`,
        );
      }
      // Fencing: a terminal goal is not drivable. Report this as a conflict
      // rather than a transition error so callers can tell "the world moved on"
      // apart from "that move is not allowed".
      if (isTerminal(goal.status)) {
        throw new GoalConflictError(
          `goal ${input.goalID} is terminal (${goal.status}); refusing to drive it`,
        );
      }
      if (input.expectedVersion !== undefined && goal.version !== input.expectedVersion) {
        throw new GoalConflictError(
          `optimistic version conflict on ${input.goalID}: expected ${input.expectedVersion}, found ${goal.version}`,
        );
      }
      const check = canTransition({ from: goal.status, to: input.to, actor: input.actor });
      if (!check.ok) {
        throw new TransitionRejectedError(check.reason);
      }
      if (goal.status === input.to) {
        // Idempotent no-op: record it, but do not bump version or touch status.
        this.appendEvent(goal.id, goal.generation, "noop", {
          fromStatus: goal.status,
          toStatus: input.to,
          actor: input.actor,
          detail: input.reason,
        });
        return goal;
      }

      const now = Date.now();
      const completedAt = input.to === "complete" ? now : null;
      const updated = this.db
        .query(
          `UPDATE goals
             SET status=?, reason=?, updated_at_ms=?, version=version+1,
                 completed_at_ms=COALESCE(?, completed_at_ms)
           WHERE id=? AND version=?`,
        )
        .run(input.to, input.reason ?? null, now, completedAt, goal.id, goal.version);

      if (updated.changes !== 1) {
        throw new GoalConflictError(`compare-and-swap failed for ${goal.id}`);
      }

      this.appendEvent(goal.id, goal.generation, "status", {
        fromStatus: goal.status,
        toStatus: input.to,
        actor: input.actor,
        detail: input.reason,
      });

      return this.byID(goal.id)!;
    });
  }

  /** Record a settled round's outcome. */
  recordRound(input: {
    goalID: string;
    generation: number;
    classification: "progress" | "verifiedWait" | "noProgress" | "blocked" | "complete";
    tokensUsed?: number;
    detail?: string;
  }): Goal {
    return this.tx(() => {
      const goal = this.byID(input.goalID);
      if (!goal) throw new GoalConflictError(`unknown goal ${input.goalID}`);
      if (goal.generation !== input.generation) {
        throw new GoalConflictError(
          `stale generation: ${input.goalID} is generation ${goal.generation}, round claimed ${input.generation}`,
        );
      }
      // A superseded or completed goal must not accumulate rounds: a late
      // callback that matches the generation but targets a dead goal is still
      // a fenced write.
      if (isTerminal(goal.status)) {
        throw new GoalConflictError(
          `goal ${input.goalID} is terminal (${goal.status}); refusing to record a round against it`,
        );
      }
      const noProgress =
        input.classification === "noProgress" ? goal.noProgressRounds + 1 : 0;
      const blocker =
        input.classification === "blocked" ? goal.repeatedBlockerRounds + 1 : 0;
      const now = Date.now();
      const tokens =
        input.tokensUsed === undefined
          ? goal.tokensUsed ?? null
          : (goal.tokensUsed ?? 0) + input.tokensUsed;

      this.db
        .query(
          `UPDATE goals
             SET rounds = rounds + 1,
                 no_progress_rounds = ?,
                 repeated_blocker_rounds = ?,
                 tokens_used = ?,
                 updated_at_ms = ?,
                 version = version + 1
           WHERE id = ? AND version = ?`,
        )
        .run(noProgress, blocker, tokens, now, goal.id, goal.version);

      this.appendEvent(goal.id, goal.generation, "round", {
        actor: "controller",
        detail: `${input.classification}${input.detail ? `: ${input.detail}` : ""}`,
      });
      return this.byID(goal.id)!;
    });
  }

  /** Insert a criterion row. Must run inside a transaction. */
  private insertCriterion(
    goalID: string,
    generation: number,
    input: CriterionInput,
    atMs: number,
  ): string {
    const id = newID("crit");
    this.db
      .query(
        `INSERT INTO goal_criteria (id, goal_id, generation, text, spec, source, met, created_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?)`,
      )
      .run(
        id,
        goalID,
        generation,
        input.text.trim(),
        input.spec ? JSON.stringify(input.spec) : null,
        input.source ?? "user",
        atMs,
      );
    return id;
  }

  /** Add an acceptance criterion. Returns its id so evidence can be bound. */
  addCriterion(
    goalID: string,
    text: string,
    spec?: CriterionSpec,
    source: "user" | "model" = "user",
  ): string {
    const goal = this.byID(goalID);
    if (!goal) throw new GoalConflictError(`unknown goal ${goalID}`);
    if (!isNonTerminal(goal.status)) {
      throw new TransitionRejectedError(`cannot add criteria to terminal goal ${goalID}`);
    }
    let id = "";
    this.tx(() => {
      id = this.insertCriterion(goalID, goal.generation, { text, spec, source }, Date.now());
    });
    return id;
  }

  addEvidence(input: {
    goalID: string;
    criterionID?: string;
    kind: string;
    ref: string;
    detail?: string;
    /** Observed exit status, for command/test/runtime evidence. */
    exitCode?: number;
    /** Content hash, for file evidence. */
    hash?: string;
    /** Workspace the path resolved against at capture time. */
    workspace?: string;
  }): void {
    const goal = this.byID(input.goalID);
    if (!goal) throw new GoalConflictError(`unknown goal ${input.goalID}`);
    this.tx(() => {
      this.db
        .query(
          `INSERT INTO goal_evidence (id, goal_id, generation, criterion_id, kind, ref, detail, exit_code, hash, workspace, at_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          newID("ev"),
          input.goalID,
          goal.generation,
          input.criterionID ?? null,
          input.kind,
          input.ref,
          input.detail ?? null,
          input.exitCode ?? null,
          input.hash ?? null,
          input.workspace ?? null,
          Date.now(),
        );
    });
  }

  listCriteria(goalID: string): {
    id: string;
    text: string;
    met: boolean;
    spec?: CriterionSpec;
    source: string;
  }[] {
    return this.db
      .query<
        { id: string; text: string; met: number; spec: string | null; source: string },
        [string]
      >(
        `SELECT id, text, met, spec, source FROM goal_criteria WHERE goal_id = ? ORDER BY created_at_ms ASC`,
      )
      .all(goalID)
      .map((r) => ({
        id: r.id,
        text: r.text,
        met: r.met === 1,
        spec: r.spec ? (JSON.parse(r.spec) as CriterionSpec) : undefined,
        source: r.source,
      }));
  }

  listEvidence(goalID: string): {
    id: string;
    criterionID?: string;
    kind: string;
    ref: string;
    exitCode?: number;
    hash?: string;
    workspace?: string;
  }[] {
    return this.db
      .query<
        {
          id: string;
          criterion_id: string | null;
          kind: string;
          ref: string;
          exit_code: number | null;
          hash: string | null;
          workspace: string | null;
        },
        [string]
      >(
        `SELECT id, criterion_id, kind, ref, exit_code, hash, workspace
           FROM goal_evidence WHERE goal_id = ? ORDER BY at_ms ASC`,
      )
      .all(goalID)
      .map((r) => ({
        id: r.id,
        criterionID: r.criterion_id ?? undefined,
        kind: r.kind,
        ref: r.ref,
        exitCode: r.exit_code ?? undefined,
        hash: r.hash ?? undefined,
        workspace: r.workspace ?? undefined,
      }));
  }

  /**
   * Bind specific captured evidence to a criterion. The evidence must already
   * exist for this goal; binding is explicit so unrelated evidence cannot be
   * counted against a criterion.
   */
  bindEvidence(criterionID: string, evidenceIDs: string[]): number {
    return this.tx(() => {
      const criterion = this.db
        .query<{ id: string; goal_id: string }, [string]>(
          `SELECT id, goal_id FROM goal_criteria WHERE id = ?`,
        )
        .get(criterionID);
      if (!criterion) throw new GoalConflictError(`unknown criterion ${criterionID}`);
      let bound = 0;
      for (const evidenceID of evidenceIDs) {
        const updated = this.db
          .query(
            `UPDATE goal_evidence SET criterion_id = ?
              WHERE id = ? AND goal_id = ?`,
          )
          .run(criterionID, evidenceID, criterion.goal_id);
        bound += updated.changes;
      }
      return bound;
    });
  }

  /** Persist the proofs a verification attempt produced, atomically. */
  recordProofs(
    goalID: string,
    proofs: {
      criterionID: string;
      evidenceIDs: string[];
      validatorID: string;
      verdict: "pass" | "fail" | "unknown";
      detail: string;
    }[],
    snapshot: string,
  ): void {
    this.tx(() => {
      const goal = this.byID(goalID);
      if (!goal) throw new GoalConflictError(`unknown goal ${goalID}`);
      const now = Date.now();
      for (const proof of proofs) {
        this.db
          .query(
            `INSERT INTO goal_criterion_proofs
               (id, goal_id, generation, criterion_id, evidence_ids, validator_id, verdict, detail, created_at_ms)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            newID("proof"),
            goalID,
            goal.generation,
            proof.criterionID,
            JSON.stringify(proof.evidenceIDs),
            proof.validatorID,
            proof.verdict,
            proof.detail,
            now,
          );
        // Keep the criterion's own readout consistent with the proof that was
        // just recorded. A complete goal with `met: false` criteria is a lie.
        this.db
          .query(`UPDATE goal_criteria SET met = ? WHERE id = ? AND goal_id = ?`)
          .run(proof.verdict === "pass" ? 1 : 0, proof.criterionID, goalID);
      }
      this.db
        .query(
          `UPDATE goals
              SET verification_revision = verification_revision + 1,
                  verification_snapshot = ?,
                  updated_at_ms = ?,
                  version = version + 1
            WHERE id = ? AND version = ?`,
        )
        .run(snapshot, now, goalID, goal.version);
    });
  }

  listProofs(goalID: string): {
    id: string;
    criterionID: string;
    evidenceIDs: string[];
    validatorID: string;
    verdict: string;
    detail?: string;
  }[] {
    return this.db
      .query<
        {
          id: string;
          criterion_id: string;
          evidence_ids: string;
          validator_id: string;
          verdict: string;
          detail: string | null;
        },
        [string]
      >(
        `SELECT id, criterion_id, evidence_ids, validator_id, verdict, detail
           FROM goal_criterion_proofs WHERE goal_id = ? ORDER BY created_at_ms ASC`,
      )
      .all(goalID)
      .map((r) => ({
        id: r.id,
        criterionID: r.criterion_id,
        evidenceIDs: JSON.parse(r.evidence_ids) as string[],
        validatorID: r.validator_id,
        verdict: r.verdict,
        detail: r.detail ?? undefined,
      }));
  }

  // ------------------------------------------------- message -> generation

  /**
   * Remember which goal generation an assistant message belongs to. Called from
   * the tool hook using the message's own timestamp, so a message produced by a
   * superseded goal is never re-attributed to its replacement.
   */
  rememberMessageGeneration(sessionID: string, messageID: string, generation: number, atMs: number): void {
    this.tx(() => {
      this.db
        .query(
          `INSERT INTO goal_message_generations (session_id, message_id, generation, at_ms)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(session_id, message_id) DO NOTHING`,
        )
        .run(sessionID, messageID, generation, atMs);
    });
  }

  resolveMessageGeneration(sessionID: string, messageID: string): number | undefined {
    const row = this.db
      .query<{ generation: number }, [string, string]>(
        `SELECT generation FROM goal_message_generations WHERE session_id = ? AND message_id = ?`,
      )
      .get(sessionID, messageID);
    return row?.generation;
  }

  /**
   * Record a blocker claim for the reporting round and return how many distinct
   * rounds have reported an equivalent blocker.
   *
   * The round number is derived from the goal's settled-round counter, so two
   * calls in the same turn map to the same round and count once. Only a later,
   * independently evaluated round can raise the confirmation count.
   */
  recordBlockerClaim(input: {
    goalID: string;
    generation: number;
    roundNumber: number;
    reason: string;
  }): number {
    return this.tx(() => {
      const normalized = normalizeBlockerReason(input.reason);
      this.db
        .query(
          `INSERT INTO goal_blocker_claims (id, goal_id, generation, round_number, reason, at_ms)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(newID("blk"), input.goalID, input.generation, input.roundNumber, normalized, Date.now());
      const row = this.db
        .query<{ n: number }, [string, number, string]>(
          `SELECT COUNT(DISTINCT round_number) AS n
             FROM goal_blocker_claims
            WHERE goal_id = ? AND generation = ? AND reason = ?`,
        )
        .get(input.goalID, input.generation, normalized)!;
      return row.n;
    });
  }

  /** Number of distinct rounds that reported the same blocker. */
  blockerConfirmations(goalID: string, generation: number, reason: string): number {
    const row = this.db
      .query<{ n: number }, [string, number, string]>(
        `SELECT COUNT(DISTINCT round_number) AS n
           FROM goal_blocker_claims
          WHERE goal_id = ? AND generation = ? AND reason = ?`,
      )
      .get(goalID, generation, normalizeBlockerReason(reason))!;
    return row.n;
  }

  /**
   * Charge session usage to the current goal.
   *
   * `totalTokens` is the session's running total from `session.usage.updated`.
   * The delta against the previously observed total is added to the active
   * goal. Replaying the same event is therefore a no-op, not double billing.
   */
  recordSessionUsage(sessionID: string, totalTokens: number): {
    goal?: Goal;
    delta: number;
  } {
    return this.tx(() => {
      const previous = this.db
        .query<{ total_tokens: number }, [string]>(
          `SELECT total_tokens FROM session_usage WHERE session_id = ?`,
        )
        .get(sessionID)?.total_tokens ?? 0;
      const delta = Math.max(0, Math.floor(totalTokens) - previous);
      this.db
        .query(
          `INSERT INTO session_usage (session_id, total_tokens, updated_at_ms)
           VALUES (?, ?, ?)
           ON CONFLICT(session_id) DO UPDATE SET
             total_tokens = excluded.total_tokens,
             updated_at_ms = excluded.updated_at_ms`,
        )
        .run(sessionID, Math.floor(totalTokens), Date.now());

      const current = this.current(sessionID);
      if (!delta || !current || !isNonTerminal(current.status)) {
        return { goal: current, delta };
      }
      this.db
        .query(`UPDATE goals SET tokens_used = COALESCE(tokens_used, 0) + ?, updated_at_ms = ? WHERE id = ?`)
        .run(delta, Date.now(), current.id);
      return { goal: this.byID(current.id), delta };
    });
  }

  /** Set or clear a goal's token ceiling. */
  setTokenBudget(goalID: string, budget: number | undefined): Goal {
    return this.tx(() => {
      this.db
        .query(`UPDATE goals SET token_budget = ?, updated_at_ms = ? WHERE id = ?`)
        .run(budget === undefined ? null : Math.floor(budget), Date.now(), goalID);
      const goal = this.byID(goalID);
      if (!goal) throw new GoalConflictError(`unknown goal ${goalID}`);
      return goal;
    });
  }

  /**
   * Restart reconciliation: any goal left mid-verification when the process died
   * is returned to `active` so it is not stranded in a status no actor will
   * resolve. Returns the goals it repaired.
   */
  reconcileAfterRestart(): Goal[] {
    return this.tx(() => {
      const stranded = this.db
        .query<GoalRow, []>(`SELECT * FROM goals WHERE status = 'verifying'`)
        .all()
        .map(toGoal);
      const repaired: Goal[] = [];
      for (const goal of stranded) {
        this.db
          .query(
            `UPDATE goals SET status='active', reason=?, updated_at_ms=?, version=version+1
             WHERE id=? AND version=?`,
          )
          .run("resumed after restart: verification was interrupted", Date.now(), goal.id, goal.version);
        this.appendEvent(goal.id, goal.generation, "restart-reconcile", {
          fromStatus: "verifying",
          toStatus: "active",
          actor: "controller",
        });
        repaired.push(this.byID(goal.id)!);
      }
      return repaired;
    });
  }

  // ------------------------------------------------------ continuation ledger

  /**
   * Reserve a continuation attempt. Runs in a transaction, and the partial
   * unique index guarantees at most one outstanding round per goal, so two
   * concurrent triggers cannot both reserve.
   *
   * The caller supplies `inboxID`; it must persist it BEFORE submitting so that
   * a retry after a timeout reuses the same OpenCode message ID.
   */
  prepareRound(input: {
    goalID: string;
    generation: number;
    inboxID: string;
  }): GoalRound {
    return this.tx(() => {
      const goal = this.byID(input.goalID);
      if (!goal) throw new GoalConflictError(`unknown goal ${input.goalID}`);
      if (goal.generation !== input.generation) {
        throw new GoalConflictError(
          `stale generation: ${input.goalID} is generation ${goal.generation}, round claimed ${input.generation}`,
        );
      }
      if (isTerminal(goal.status)) {
        throw new GoalConflictError(`goal ${input.goalID} is terminal (${goal.status})`);
      }
      const existing = this.outstandingRound(input.goalID);
      if (existing) {
        throw new GoalConflictError(
          `goal ${input.goalID} already has an outstanding round (${existing.id}, ${existing.status})`,
        );
      }
      const id = newID("round");
      const now = Date.now();
      // Snapshot how much evidence already exists, so settlement can tell
      // whether this round produced any verified work at all.
      const baseline = this.db
        .query<{ n: number }, [string]>(
          `SELECT COUNT(*) AS n FROM goal_evidence WHERE goal_id = ?`,
        )
        .get(input.goalID)!.n;
      this.db
        .query(
          `INSERT INTO goal_rounds
             (id, goal_id, generation, inbox_id, status, attempts, evidence_baseline, prepared_at_ms)
           VALUES (?, ?, ?, ?, 'prepared', 1, ?, ?)`,
        )
        .run(id, input.goalID, input.generation, input.inboxID, baseline, now);
      this.appendEvent(input.goalID, input.generation, "round-prepared", {
        actor: "controller",
        detail: input.inboxID,
      });
      return this.roundByID(id)!;
    });
  }

  roundByID(id: string): GoalRound | undefined {
    const r = this.db.query<RoundRow, [string]>(`SELECT * FROM goal_rounds WHERE id = ?`).get(id);
    return r ? toRound(r) : undefined;
  }

  roundByInboxID(inboxID: string): GoalRound | undefined {
    const r = this.db
      .query<RoundRow, [string]>(`SELECT * FROM goal_rounds WHERE inbox_id = ?`)
      .get(inboxID);
    return r ? toRound(r) : undefined;
  }

  /** The single in-flight round for a goal, if any. */
  outstandingRound(goalID: string): GoalRound | undefined {
    const r = this.db
      .query<RoundRow, [string]>(
        `SELECT * FROM goal_rounds
          WHERE goal_id = ? AND status IN ('prepared','admitted','running','unknown')
          LIMIT 1`,
      )
      .get(goalID);
    return r ? toRound(r) : undefined;
  }

  /** Every round that needs reconciliation, across all goals. */
  outstandingRounds(): GoalRound[] {
    return this.db
      .query<RoundRow, []>(
        `SELECT * FROM goal_rounds
          WHERE status IN ('prepared','admitted','running','unknown')
          ORDER BY prepared_at_ms ASC`,
      )
      .all()
      .map(toRound);
  }

  roundsFor(goalID: string): GoalRound[] {
    return this.db
      .query<RoundRow, [string]>(
        `SELECT * FROM goal_rounds WHERE goal_id = ? ORDER BY prepared_at_ms ASC`,
      )
      .all(goalID)
      .map(toRound);
  }

  /** Record that the session accepted the message. NOT proof it ran. */
  markRoundAdmitted(roundID: string): GoalRound {
    return this.tx(() => {
      const round = this.roundByID(roundID);
      if (!round) throw new GoalConflictError(`unknown round ${roundID}`);
      // A retry that succeeds may follow an `unknown` submission, so both
      // `prepared` and `unknown` are valid predecessors of `admitted`.
      const updated = this.db
        .query(
          `UPDATE goal_rounds SET status='admitted', admitted_at_ms=?
            WHERE id=? AND status IN ('prepared','unknown')`,
        )
        .run(Date.now(), roundID);
      if (updated.changes !== 1) {
        throw new GoalConflictError(
          `cannot admit round ${roundID}: expected prepared/unknown, found ${round.status}`,
        );
      }
      this.appendEvent(round.goalID, round.generation, "round-admitted", {
        actor: "controller",
        detail: round.inboxID,
      });
      return this.roundByID(roundID)!;
    });
  }

  markRoundRunning(roundID: string): GoalRound {
    return this.tx(() => {
      const round = this.roundByID(roundID);
      if (!round) throw new GoalConflictError(`unknown round ${roundID}`);
      this.db
        .query(`UPDATE goal_rounds SET status='running' WHERE id=? AND status IN ('prepared','admitted','unknown')`)
        .run(roundID);
      this.appendEvent(round.goalID, round.generation, "round-running", { actor: "controller" });
      return this.roundByID(roundID)!;
    });
  }

  /**
   * Submission outcome ambiguous. The round stays outstanding so the reconciler
   * retries it, and the inbox ID is preserved so the retry is idempotent.
   */
  markRoundUnknown(roundID: string, detail: string): GoalRound {
    return this.tx(() => {
      const round = this.roundByID(roundID);
      if (!round) throw new GoalConflictError(`unknown round ${roundID}`);
      this.db
        .query(
          `UPDATE goal_rounds SET status='unknown', attempts=attempts+1, detail=? WHERE id=?`,
        )
        .run(detail, roundID);
      this.appendEvent(round.goalID, round.generation, "round-unknown", {
        actor: "controller",
        detail,
      });
      return this.roundByID(roundID)!;
    });
  }

  /**
   * Submission definitively rejected. This is an admission failure, not a model
   * failure, so it must not be counted as a round — but it must also stop
   * automatic dispatch until recovery, or a later event would mint a fresh
   * continuation and circumvent the retry limit.
   */
  markRoundFailed(roundID: string, detail: string): GoalRound {
    return this.tx(() => {
      const round = this.roundByID(roundID);
      if (!round) throw new GoalConflictError(`unknown round ${roundID}`);
      this.db
        .query(`UPDATE goal_rounds SET status='failed', detail=?, settled_at_ms=? WHERE id=?`)
        .run(detail, Date.now(), roundID);
      const goal = this.byID(round.goalID);
      if (goal) {
        this.db
          .query(
            `UPDATE goals SET delivery_failed=1, updated_at_ms=?, version=version+1
              WHERE id=? AND version=?`,
          )
          .run(Date.now(), goal.id, goal.version);
      }
      this.appendEvent(round.goalID, round.generation, "round-failed", {
        actor: "controller",
        detail,
      });
      return this.roundByID(roundID)!;
    });
  }

  /** Clear a terminal delivery failure, so automatic dispatch may resume. */
  clearDeliveryFailure(goalID: string): Goal | undefined {
    return this.tx(() => {
      const goal = this.byID(goalID);
      if (!goal) return undefined;
      if (!goal.deliveryFailed) return goal;
      this.db
        .query(
          `UPDATE goals SET delivery_failed=0, updated_at_ms=?, version=version+1
            WHERE id=? AND version=?`,
        )
        .run(Date.now(), goal.id, goal.version);
      this.appendEvent(goal.id, goal.generation, "delivery-recovered", {
        actor: "controller",
        detail: "terminal delivery failure cleared",
      });
      return this.byID(goal.id)!;
    });
  }

  /** Evaluate a settled round. Clears it from the outstanding set. */
  settleRound(input: {
    roundID: string;
    classification: "progress" | "verifiedWait" | "noProgress" | "blocked" | "complete";
    detail?: string;
  }): GoalRound {
    return this.tx(() => {
      const round = this.roundByID(input.roundID);
      if (!round) throw new GoalConflictError(`unknown round ${input.roundID}`);
      // Idempotent: a duplicate terminal-execution event must not settle the
      // round twice or append a second event.
      if (round.status === "settled") return round;
      this.db
        .query(
          `UPDATE goal_rounds SET status='settled', classification=?, detail=?, settled_at_ms=? WHERE id=?`,
        )
        .run(input.classification, input.detail ?? null, Date.now(), input.roundID);
      this.appendEvent(round.goalID, round.generation, "round-settled", {
        actor: "controller",
        detail: `${input.classification}${input.detail ? `: ${input.detail}` : ""}`,
      });
      return this.roundByID(input.roundID)!;
    });
  }

  /**
   * Settle a round and record its outcome in a single transaction.
   *
   * Split across two transactions, a crash between them leaves the round
   * settled but uncounted (or counted but still outstanding). One writer is
   * also what makes a duplicate terminal event harmless.
   */
  settleAndRecord(input: {
    roundID: string;
    classification: "progress" | "verifiedWait" | "noProgress" | "blocked" | "complete";
    detail?: string;
    tokensUsed?: number;
  }): { round: GoalRound; goal?: Goal } {
    return this.tx(() => {
      const before = this.roundByID(input.roundID);
      if (!before) throw new GoalConflictError(`unknown round ${input.roundID}`);
      // Already settled: a duplicate terminal event must not count the round
      // a second time.
      if (before.status === "settled") return { round: before };
      this.settleRound(input);
      const goal = this.recordRound({
        goalID: before.goalID,
        generation: before.generation,
        classification: input.classification,
        detail: input.detail,
        tokensUsed: input.tokensUsed,
      });
      return { round: this.roundByID(input.roundID)!, goal };
    });
  }

  /**
   * Atomically settle any in-flight round and move a verified goal to
   * `complete`, guarded by generation and the verification snapshot.
   *
   * Split across transactions, a crash between settling the round and the
   * status change leaves a settled round against a still-verifying goal, and a
   * stale verifier could complete a goal whose evidence changed. One writer is
   * what makes both impossible.
   */
  completeGoal(input: {
    goalID: string;
    generation: number;
    reason: string;
    snapshot?: string;
    settleClassification: "complete";
  }): Goal {
    return this.tx(() => {
      const goal = this.byID(input.goalID);
      if (!goal) throw new GoalConflictError(`unknown goal ${input.goalID}`);
      if (goal.generation !== input.generation) {
        throw new GoalConflictError(
          `stale generation: ${input.goalID} is generation ${goal.generation}, completion claimed ${input.generation}`,
        );
      }
      if (goal.status !== "verifying") {
        throw new TransitionRejectedError(
          `cannot complete goal ${input.goalID} from status ${goal.status}; verification is required first`,
        );
      }
      if (input.snapshot !== undefined && goal.verificationSnapshot !== input.snapshot) {
        throw new GoalConflictError(
          `verification snapshot mismatch: the verifier checked ${goal.verificationSnapshot ?? "none"}, ` +
            `this completion claims ${input.snapshot}`,
        );
      }
      const outstanding = this.outstandingRound(input.goalID);
      if (outstanding) {
        this.settleRound({
          roundID: outstanding.id,
          classification: input.settleClassification,
          detail: input.reason,
        });
        this.recordRound({
          goalID: input.goalID,
          generation: input.generation,
          classification: input.settleClassification,
          detail: input.reason,
        });
      }
      return this.transition({
        goalID: input.goalID,
        generation: input.generation,
        to: "complete",
        actor: "controller",
        reason: input.reason,
      });
    });
  }

  /**
   * The generation of the goal that was current at a point in time. Used to
   * fence a model tool call to the generation that actually produced the
   * assistant message carrying it, rather than to whatever is current now.
   */
  generationAt(sessionID: string, atMs: number): number | undefined {
    const row = this.db
      .query<{ generation: number }, [string, number]>(
        `SELECT generation FROM goals
          WHERE session_id = ? AND created_at_ms <= ?
          ORDER BY created_at_ms DESC LIMIT 1`,
      )
      .get(sessionID, atMs);
    return row?.generation;
  }
}

export interface GoalRound {
  id: string;
  goalID: string;
  generation: number;
  inboxID: string;
  status: "prepared" | "admitted" | "running" | "settled" | "unknown" | "failed";
  classification?: "progress" | "verifiedWait" | "noProgress" | "blocked" | "complete";
  attempts: number;
  /** Evidence count for the goal when the round was prepared. */
  evidenceBaseline: number;
  detail?: string;
  preparedAtMs: number;
  admittedAtMs?: number;
  settledAtMs?: number;
}

interface RoundRow {
  id: string;
  goal_id: string;
  generation: number;
  inbox_id: string;
  status: string;
  classification: string | null;
  attempts: number;
  detail: string | null;
  evidence_baseline: number;
  prepared_at_ms: number;
  admitted_at_ms: number | null;
  settled_at_ms: number | null;
}

function toRound(r: RoundRow): GoalRound {
  return {
    id: r.id,
    goalID: r.goal_id,
    generation: r.generation,
    inboxID: r.inbox_id,
    status: r.status as GoalRound["status"],
    classification: (r.classification ?? undefined) as GoalRound["classification"],
    attempts: r.attempts,
    evidenceBaseline: r.evidence_baseline,
    detail: r.detail ?? undefined,
    preparedAtMs: r.prepared_at_ms,
    admittedAtMs: r.admitted_at_ms ?? undefined,
    settledAtMs: r.settled_at_ms ?? undefined,
  };
}
