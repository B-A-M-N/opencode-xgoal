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
  };
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
   */
  private tx<T>(fn: () => T): T {
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

  byID(id: string): Goal | undefined {
    const row = this.db.query<GoalRow, [string]>(`SELECT * FROM goals WHERE id = ?`).get(id);
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
      const generation = 1;
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

  addCriterion(goalID: string, text: string): void {
    const goal = this.byID(goalID);
    if (!goal) throw new GoalConflictError(`unknown goal ${goalID}`);
    if (!isNonTerminal(goal.status)) {
      throw new TransitionRejectedError(`cannot add criteria to terminal goal ${goalID}`);
    }
    this.tx(() => {
      this.db
        .query(
          `INSERT INTO goal_criteria (id, goal_id, generation, text, met, created_at_ms)
           VALUES (?, ?, ?, ?, 0, ?)`,
        )
        .run(newID("crit"), goalID, goal.generation, text, Date.now());
    });
  }

  addEvidence(input: {
    goalID: string;
    criterionID?: string;
    kind: string;
    ref: string;
    detail?: string;
  }): void {
    const goal = this.byID(input.goalID);
    if (!goal) throw new GoalConflictError(`unknown goal ${input.goalID}`);
    this.tx(() => {
      this.db
        .query(
          `INSERT INTO goal_evidence (id, goal_id, generation, criterion_id, kind, ref, detail, at_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          newID("ev"),
          input.goalID,
          goal.generation,
          input.criterionID ?? null,
          input.kind,
          input.ref,
          input.detail ?? null,
          Date.now(),
        );
    });
  }

  listCriteria(goalID: string): { id: string; text: string; met: boolean }[] {
    return this.db
      .query<{ id: string; text: string; met: number }, [string]>(
        `SELECT id, text, met FROM goal_criteria WHERE goal_id = ? ORDER BY created_at_ms ASC`,
      )
      .all(goalID)
      .map((r) => ({ id: r.id, text: r.text, met: r.met === 1 }));
  }

  listEvidence(goalID: string): { id: string; criterionID?: string; kind: string; ref: string }[] {
    return this.db
      .query<
        { id: string; criterion_id: string | null; kind: string; ref: string },
        [string]
      >(`SELECT id, criterion_id, kind, ref FROM goal_evidence WHERE goal_id = ? ORDER BY at_ms ASC`)
      .all(goalID)
      .map((r) => ({
        id: r.id,
        criterionID: r.criterion_id ?? undefined,
        kind: r.kind,
        ref: r.ref,
      }));
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
}
