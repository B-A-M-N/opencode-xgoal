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
import { createHash } from "node:crypto";
import {
  type Actor,
  type Goal,
  type GoalStatus,
  canTransition,
  isNonTerminal,
  isTerminal,
} from "./state.ts";
import { preservesObligation, type CriterionInput, type CriterionSpec } from "./criteria.ts";

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
  -- How this goal is permitted to reach completion (audit #1): machine,
  -- audited, or userAcceptance. Decided at creation from the objective text
  -- and its derived criteria; never changed by the model.
  completion_policy        TEXT NOT NULL DEFAULT 'userAcceptance',
  -- Revision of the immutable objective text. Assessments are scoped to it so
  -- a stale assessment can never certify a different requirement set.
  objective_revision       INTEGER NOT NULL DEFAULT 1,
  -- Set when a continuation submission terminally failed. While set, the
  -- driver refuses to dispatch until recovery clears it, so a terminal
  -- delivery failure cannot be circumvented by minting a fresh continuation.
  delivery_failed          INTEGER NOT NULL DEFAULT 0,
  -- Durable wait state (audit-4 #4): set when a settled round classified
  -- verifiedWait. While set, the driver reconciles the wait without model
  -- tokens instead of minting another continuation.
  wait_started_ms          INTEGER,
  wait_reason              TEXT,
  wait_recheck_ms          INTEGER,
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
  -- Who established the criterion: the user's objective (including
  -- requirements the controller extracted from it), an explicit user
  -- addition, or a model refinement. User-authoritative rows are never
  -- removed to pass verification. Historical "derived" rows are normalized
  -- to "user" by migrate() on open.
  source      TEXT NOT NULL DEFAULT 'user',
  met         INTEGER NOT NULL DEFAULT 0,
  -- A derived/model criterion that investigation proved wrong is superseded,
  -- not deleted: the row stays for the audit trail but no longer gates
  -- verification. User-source criteria cannot be superseded by the model.
  superseded  INTEGER NOT NULL DEFAULT 0,
  -- JSON array of objective-level criterion IDs this concrete requirement was
  -- registered to satisfy (audit #1). Only a proven concrete requirement can
  -- discharge an objective-level remainder under the audited policy, so the
  -- model must name the coverage instead of asserting the objective is met.
  covers      TEXT,
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
  at_ms       INTEGER NOT NULL,
  -- Stable fingerprint of the observation (audit-4 #9): kind + normalized
  -- observation + result status. Identical observations share a fingerprint,
  -- so repeating the same command cannot manufacture round progress.
  fingerprint TEXT
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
-- evidence_sig (audit-4 #8) is the normalized reason PLUS the timestamp of the
-- freshest observed backing evidence: a confirmation only counts when the
-- controller has observed something NEW since every earlier confirmation of
-- the same dependency. Repeating the same string, or citing any subset of
-- already-seen evidence, adds nothing.
CREATE TABLE IF NOT EXISTS goal_blocker_claims (
  id           TEXT PRIMARY KEY,
  goal_id      TEXT NOT NULL,
  generation   INTEGER NOT NULL,
  round_number INTEGER NOT NULL,
  reason       TEXT NOT NULL,
  evidence_sig TEXT,
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

-- Execution-scoped usage ledger (audit-4 #3).
--
-- One row per (execution, event) observation. The observation identity is the
-- event envelope's id (opencode 2 events carry a unique EventID); when the
-- envelope has no id, the (executionID, token totals, at-second) tuple is the
-- fallback identity. The unique index makes a replayed or delayed delivery a
-- no-op instead of a second charge.
--
-- attribution: 'execution' — a message/execution id resolved the observation
-- to a (goal, generation) pair through the durable message-generation map, so
-- a late event from generation 1 charges generation 1 (or nothing, if that
-- goal is terminal) and never the replacement. 'current' — no execution
-- identity was available, so the observation was charged to the goal that was
-- current when the event ARRIVED. 'unassigned' — the execution's goal could
-- not be established; usage is recorded but charged to no goal rather than
-- silently accruing to whatever happens to be current (audit-4 #3).
CREATE TABLE IF NOT EXISTS goal_usage_observations (
  id            TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL,
  execution_id  TEXT,
  goal_id       TEXT,
  generation    INTEGER,
  attribution   TEXT NOT NULL,
  input_tokens  INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  reasoning_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens  INTEGER NOT NULL,
  at_ms         INTEGER NOT NULL,
  -- Deduplication identity: the event envelope's id when present, else the
  -- execution+totals+second tuple. Unique per session, so a replayed or
  -- delayed delivery inserts nothing instead of charging twice.
  observation_key TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS goal_usage_observation_identity
  ON goal_usage_observations (session_id, observation_key);
CREATE INDEX IF NOT EXISTS goal_usage_session ON goal_usage_observations (session_id);

-- Verification attempt records (audit-4 #10).
--
-- One row per verification run, with the goal generation + version it claims
-- to describe. recordProofs rejects a proof batch whose attempt id is not the
-- current open attempt for the goal, so a verifier delayed past a replacement
-- can neither overwrite newer proof results nor resurrect its own stale ones.
CREATE TABLE IF NOT EXISTS goal_verification_attempts (
  id          TEXT PRIMARY KEY,
  goal_id     TEXT NOT NULL,
  generation  INTEGER NOT NULL,
  version     INTEGER NOT NULL,
  status      TEXT NOT NULL,
  started_at_ms INTEGER NOT NULL,
  finished_at_ms INTEGER
);
CREATE INDEX IF NOT EXISTS goal_verification_attempts_goal
  ON goal_verification_attempts (goal_id, started_at_ms);

-- Explicit user acceptance of an objective-level criterion.
--
-- A broad objective ("fix the flaky tests", "clean up the config handling")
-- cannot be machine-proven from ordinary evidence: any passing test or file
-- change is consistent with a partial job. Rather than pretend completeness is
-- established, the verifier leaves such criteria unresolved until the user
-- either accepts the objective explicitly (this table, generation-fenced) or
-- the model registers concrete machine-checkable sub-criteria.
CREATE TABLE IF NOT EXISTS goal_acceptances (
  goal_id     TEXT PRIMARY KEY,
  generation  INTEGER NOT NULL,
  note        TEXT,
  at_ms       INTEGER NOT NULL
);

-- Controller-computed objective-level assessments (audit #1, audited policy).
--
-- Audited goals define completion operationally: the objective is
-- open-ended, so completion means every confirmed requirement discovered
-- within the audited scope is independently verified, and no known,
-- actionable requirement remains unresolved. The controller records the
-- assessment it computed from the per-criterion proofs; the model cannot write
-- this row and cannot declare its own verdict.
--
-- This is NOT a claim that no undiscovered bugs exist. The recorded scope is
-- the honest boundary: what the final bounded review covered, and what it did
-- not. Scope that cannot be bounded yields indeterminate, not satisfied.
CREATE TABLE IF NOT EXISTS goal_objective_assessments (
  goal_id                TEXT PRIMARY KEY,
  generation             INTEGER NOT NULL,
  objective_revision     INTEGER NOT NULL,
  verdict                TEXT NOT NULL,
  scope                  TEXT NOT NULL,
  covered_requirements   TEXT NOT NULL,
  unresolved_requirements TEXT NOT NULL,
  evidence_ids           TEXT NOT NULL,
  note                   TEXT,
  at_ms                  INTEGER NOT NULL
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
  completion_policy: string;
  objective_revision: number;
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
    completionPolicy: (row.completion_policy ?? "userAcceptance") as Goal["completionPolicy"],
    objectiveRevision: row.objective_revision ?? 1,
  };
}

/** Normalize a blocker reason so trivial rewording still counts as the same blocker. */
function normalizeBlockerReason(reason: string): string {
  return reason.trim().toLowerCase().replace(/\s+/g, " ").replace(/[.!]+$/g, "");
}

/**
 * Stable fingerprint of a machine-observed piece of evidence (audit-4 #9).
 *
 * Two observations with the same fingerprint carry the same information: the
 * same command run again with the same exit status, or the same file content
 * written again. Only a NEW fingerprint can count as round progress, so a
 * model cannot stall-proof a goal by repeating `pwd`.
 *
 * Deliberately computed from persisted fields only (kind, ref, exitCode, hash)
 * so existing rows are backfillable in the migration. The observation is
 * normalized the same way command identity is normalized for verification.
 * Model-annotated pointers (`ref`, `blocker-ref`) get no fingerprint — they
 * are never observations and never progress.
 */
export function evidenceFingerprint(input: {
  kind: string;
  ref: string;
  exitCode?: number;
  hash?: string;
}): string | undefined {
  if (input.kind === "ref" || input.kind === "blocker-ref") return undefined;
  const observation = input.ref.trim().toLowerCase().replace(/\s+/g, " ");
  // File evidence: same path with different content is a different observation;
  // the content hash IS the result. Command-like evidence: the result status.
  const result = input.hash !== undefined ? String(input.hash) : String(input.exitCode ?? "");
  return `${input.kind}::${observation}::${result}`;
}

let counter = 0;
function newID(prefix: string): string {
  counter += 1;
  return `${prefix}_${Date.now().toString(36)}_${counter.toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 10)}`;
}

/**
 * Canonical hash of a criteria + evidence snapshot.
 *
 * The single authoritative hashing rule for verification freshness: the
 * verifier hashes exactly the rows it read, and `completeGoal` re-hashes the
 * current rows to prove the world did not change in between. Exported as a
 * pure function so both sides share one implementation without a DB round-trip
 * in the verifier's hot path.
 */
export function snapshotHash(
  criteria: { id: string; text: string; spec?: CriterionSpec }[],
  evidence: {
    id: string;
    kind: string;
    ref: string;
    exitCode?: number;
    hash?: string;
    criterionID?: string;
  }[],
): string {
  const canonical = JSON.stringify({
    criteria: criteria.map((c) => [c.id, c.text, c.spec ?? null]),
    evidence: evidence.map((e) => [
      e.id,
      e.kind,
      e.ref,
      e.exitCode ?? null,
      e.hash ?? null,
      e.criterionID ?? null,
    ]),
  });
  return createHash("sha256").update(canonical).digest("hex").slice(0, 32);
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
    this.migrate();
  }

  /**
   * Guarded, idempotent migrations for databases created by older versions.
   *
   * `CREATE TABLE IF NOT EXISTS` never alters an existing table, so columns
   * added to the canonical schema must also be added here when missing.
   */
  private migrate(): void {
    const columns = this.db
      .query<{ name: string }, []>(`PRAGMA table_info(goal_criteria)`)
      .all()
      .map((row) => row.name);
    if (!columns.includes("superseded")) {
      this.db.exec(`ALTER TABLE goal_criteria ADD COLUMN superseded INTEGER NOT NULL DEFAULT 0`);
    }
    // Coverage links (audit #1): which objective-level criterion a concrete
    // requirement was registered to satisfy.
    if (!columns.includes("covers")) {
      this.db.exec(`ALTER TABLE goal_criteria ADD COLUMN covers TEXT`);
    }
    // Completion policy (audit #1). Older rows default to userAcceptance: a
    // goal created before the policy existed must not silently gain a weaker
    // (or stronger) completion rule. Backfill `machine` only where every
    // non-superseded criterion is machine-checkable.
    const goalColumns = this.db
      .query<{ name: string }, []>(`PRAGMA table_info(goals)`)
      .all()
      .map((row) => row.name);
    if (!goalColumns.includes("completion_policy")) {
      this.db.exec(
        `ALTER TABLE goals ADD COLUMN completion_policy TEXT NOT NULL DEFAULT 'userAcceptance'`,
      );
    }
    if (!goalColumns.includes("objective_revision")) {
      this.db.exec(
        `ALTER TABLE goals ADD COLUMN objective_revision INTEGER NOT NULL DEFAULT 1`,
      );
    }
    this.db
      .query(
        `UPDATE goals SET completion_policy = 'machine'
          WHERE completion_policy = 'userAcceptance'
            AND status IN ('active', 'verifying', 'paused')
            AND EXISTS (SELECT 1 FROM goal_criteria c WHERE c.goal_id = goals.id AND c.superseded = 0)
            AND NOT EXISTS (
              SELECT 1 FROM goal_criteria c
               WHERE c.goal_id = goals.id AND c.superseded = 0
                 AND (c.spec IS NULL OR json_extract(c.spec, '$.type') = 'objective')
            )`,
      )
      .run();
    // Authority normalization: rows stored as "derived" were all extracted
    // from the user's objective by the controller (model-added rows are
    // "model"). Their origin is the user's, so they carry the user's
    // authority — including protection from model supersession.
    this.db
      .query(`UPDATE goal_criteria SET source = 'user' WHERE source = 'derived'`)
      .run();
    // Evidence fingerprints (audit-4 #9). Backfill existing rows from the
    // persisted fields the fingerprint is defined over, so historical
    // repetitions still deduplicate.
    const evidenceColumns = this.db
      .query<{ name: string }, []>(`PRAGMA table_info(goal_evidence)`)
      .all()
      .map((row) => row.name);
    if (!evidenceColumns.includes("fingerprint")) {
      this.db.exec(`ALTER TABLE goal_evidence ADD COLUMN fingerprint TEXT`);
      const rows = this.db
        .query<{ id: string; kind: string; ref: string; exit_code: number | null; hash: string | null }, []>(
          `SELECT id, kind, ref, exit_code, hash FROM goal_evidence`,
        )
        .all();
      const update = this.db.query(`UPDATE goal_evidence SET fingerprint = ? WHERE id = ?`);
      this.tx(() => {
        for (const row of rows) {
          update.run(
            evidenceFingerprint({
              kind: row.kind,
              ref: row.ref,
              exitCode: row.exit_code ?? undefined,
              hash: row.hash ?? undefined,
            }) ?? null,
            row.id,
          );
        }
      });
    }
    // Blocker-claim independence signatures (audit-4 #8). Older rows recorded
    // the reason alone; their signature is the normalized reason, which keeps
    // their confirmation counting consistent with the new rule.
    const claimColumns = this.db
      .query<{ name: string }, []>(`PRAGMA table_info(goal_blocker_claims)`)
      .all()
      .map((row) => row.name);
    if (!claimColumns.includes("evidence_sig")) {
      this.db.exec(`ALTER TABLE goal_blocker_claims ADD COLUMN evidence_sig TEXT`);
      // Legacy rows predate observed-backing signatures: normalize their
      // reason so like-for-like dedup still works among themselves. They can
      // never pair with post-migration signatures (which carry a backing
      // timestamp), so old and new claims never merge — conservative, an
      // undercount, never a manufactured confirmation.
      const claimRows = this.db
        .query<{ id: string; reason: string }, []>(`SELECT id, reason FROM goal_blocker_claims`)
        .all();
      const updateClaim = this.db.query(`UPDATE goal_blocker_claims SET evidence_sig = ? WHERE id = ?`);
      this.tx(() => {
        for (const claim of claimRows) {
          updateClaim.run(normalizeBlockerReason(claim.reason), claim.id);
        }
      });
    }
    // Durable wait state (audit-4 #4): what the goal is waiting on, since when,
    // and when the next reconciliation is due.
    if (!goalColumns.includes("wait_started_ms")) {
      this.db.exec(`ALTER TABLE goals ADD COLUMN wait_started_ms INTEGER`);
    }
    if (!goalColumns.includes("wait_reason")) {
      this.db.exec(`ALTER TABLE goals ADD COLUMN wait_reason TEXT`);
    }
    if (!goalColumns.includes("wait_recheck_ms")) {
      this.db.exec(`ALTER TABLE goals ADD COLUMN wait_recheck_ms INTEGER`);
    }
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

  /**
   * Audit trail for a stale admission (audit-4 #11): the driver recorded that
   * a continuation for THIS goal generation was admitted to the session after
   * the goal left active scheduling. The event documents why a foreign
   * continuation may appear in the session transcript and whether it was
   * cancelled.
   */
  recordAdmissionStale(goalID: string, generation: number, detail: string): void {
    this.appendEvent(goalID, generation, "admission.stale", {
      actor: "controller",
      detail,
    });
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
    completionPolicy?: Goal["completionPolicy"];
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
             completion_policy, created_at_ms, updated_at_ms)
           VALUES (?, ?, ?, ?, 'active', 0, 0, 0, ?, 0, ?, ?, ?)`,
        )
        .run(
          id,
          input.sessionID,
          generation,
          input.objective.trim(),
          input.tokenBudget ?? null,
          input.completionPolicy ?? "userAcceptance",
          now,
          now,
        );
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
    completionPolicy?: Goal["completionPolicy"];
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
          `UPDATE goals SET status='superseded', superseded_by=?, updated_at_ms=?, version=version+1,
                   wait_started_ms=NULL, wait_reason=NULL, wait_recheck_ms=NULL
           WHERE id=? AND version=?`,
        )
        .run(newIDValue, now, existing.id, existing.version);

      this.appendEvent(existing.id, existing.generation, "superseded", {
        fromStatus: existing.status,
        toStatus: "superseded",
        actor: input.actor ?? "user",
        detail: input.reason ?? `replaced by ${newIDValue}`,
      });

      // Fail the superseded goal's outstanding round in the SAME transaction.
      // Its continuation belongs to an objective that no longer exists; leaving
      // it outstanding would keep it in the recovery sweep until the next
      // reconcile and risk classifying a late settlement against a superseded
      // objective. This is a supersession, not a delivery failure of the
      // replacement — so it never parks anything.
      const stale = this.outstandingRound(existing.id);
      if (stale) {
        this.markRoundFailed(stale.id, `superseded by ${newIDValue}`, { parkGoal: false });
      }

      // Retire the superseded goal's open verification attempts (audit-4 #10):
      // their verifier describes a goal that no longer exists.
      this.db
        .query(
          `UPDATE goal_verification_attempts SET status = 'abandoned', finished_at_ms = ?
            WHERE goal_id = ? AND status = 'open'`,
        )
        .run(now, existing.id);

      this.db
        .query(
          `INSERT INTO goals (id, session_id, generation, objective, status, rounds,
             no_progress_rounds, repeated_blocker_rounds, token_budget, version,
             completion_policy, created_at_ms, updated_at_ms)
           VALUES (?, ?, ?, ?, 'active', 0, 0, 0, ?, 0, ?, ?, ?)`,
        )
        .run(
          newIDValue,
          input.sessionID,
          nextGeneration,
          input.objective.trim(),
          input.tokenBudget ?? existing.tokenBudget ?? null,
          input.completionPolicy ?? "userAcceptance",
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
                 completed_at_ms=COALESCE(?, completed_at_ms),
                 -- A status change retires any durable wait: waiting belongs
                 -- to the active scheduling state, not to the goal's history.
                 wait_started_ms=NULL, wait_reason=NULL, wait_recheck_ms=NULL
           WHERE id=? AND version=?`,
        )
        .run(input.to, input.reason ?? null, now, completedAt, goal.id, goal.version);

      if (updated.changes !== 1) {
        throw new GoalConflictError(`compare-and-swap failed for ${goal.id}`);
      }

      // A status change retires any open verification attempt (audit-4 #10):
      // a verifier that opened its attempt before a pause/active flip must
      // find its attempt closed and discard its results, exactly as it would
      // across a replacement.
      this.db
        .query(
          `UPDATE goal_verification_attempts SET status = 'abandoned', finished_at_ms = ?
            WHERE goal_id = ? AND status = 'open'`,
        )
        .run(now, goal.id);

      this.appendEvent(goal.id, goal.generation, "status", {
        fromStatus: goal.status,
        toStatus: input.to,
        actor: input.actor,
        detail: input.reason,
      });

      return this.byID(goal.id)!;
    });
  }

  /**
   * Enter a durable wait (audit-4 #4): a settled round was classified
   * `verifiedWait`, so the goal is parked on a real, observable background
   * execution. The driver rechecks the wait without model tokens and wakes the
   * goal when the awaited work is no longer running.
   *
   * Generation-fenced and idempotent: re-entering while waiting refreshes the
   * record. Only an active goal can wait.
   */
  enterWait(input: {
    goalID: string;
    generation: number;
    reason: string;
    recheckMs: number;
  }): void {
    this.tx(() => {
      const goal = this.byID(input.goalID);
      if (!goal || goal.generation !== input.generation) return;
      if (goal.status !== "active") return;
      this.db
        .query(
          `UPDATE goals SET wait_started_ms = COALESCE(wait_started_ms, ?), wait_reason = ?, wait_recheck_ms = ?, updated_at_ms = ?
            WHERE id = ? AND generation = ? AND status = 'active'`,
        )
        .run(Date.now(), input.reason.slice(0, 300), input.recheckMs, Date.now(), input.goalID, input.generation);
    });
  }

  /** Clear a durable wait. Idempotent. */
  clearWait(goalID: string): void {
    this.tx(() => {
      this.db
        .query(
          `UPDATE goals SET wait_started_ms = NULL, wait_reason = NULL, wait_recheck_ms = NULL, updated_at_ms = ?
            WHERE id = ? AND wait_started_ms IS NOT NULL`,
        )
        .run(Date.now(), goalID);
    });
  }

  /** The goal's durable wait, if one is set. */
  activeWait(goalID: string): { reason: string; startedMs: number; recheckMs: number } | undefined {
    const row = this.db
      .query<{ wait_started_ms: number | null; wait_reason: string | null; wait_recheck_ms: number | null }, [string]>(
        `SELECT wait_started_ms, wait_reason, wait_recheck_ms FROM goals WHERE id = ?`,
      )
      .get(goalID);
    if (!row || row.wait_started_ms === null) return undefined;
    return {
      reason: row.wait_reason ?? "background execution still running",
      startedMs: row.wait_started_ms,
      recheckMs: row.wait_recheck_ms ?? 30_000,
    };
  }

  /** Goals with a durable wait set, for the recovery sweep. */
  goalsWithActiveWaits(): { goalID: string; sessionID: string }[] {
    return this.db
      .query<{ id: string; session_id: string }, []>(
        `SELECT id, session_id FROM goals WHERE wait_started_ms IS NOT NULL AND status = 'active'`,
      )
      .all()
      .map((r) => ({ goalID: r.id, sessionID: r.session_id }));
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
    covers?: string[],
  ): string {
    const id = newID("crit");
    this.db
      .query(
        `INSERT INTO goal_criteria (id, goal_id, generation, text, spec, source, met, covers, created_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      )
      .run(
        id,
        goalID,
        generation,
        input.text.trim(),
        input.spec ? JSON.stringify(input.spec) : null,
        input.source ?? "user",
        covers && covers.length > 0 ? JSON.stringify(covers) : null,
        atMs,
      );
    return id;
  }

  /**
   * Add an acceptance criterion. Returns its id so evidence can be bound.
   *
   * Additive and idempotent: adding a criterion whose normalized text already
   * exists for this goal returns the existing id rather than creating a
   * duplicate. The model may not create an objective-type criterion — that
   * verdict is the user's to give, via acceptance.
   */
  addCriterion(
    goalID: string,
    text: string,
    spec?: CriterionSpec,
    source: "user" | "model" | "derived" = "user",
    covers?: string[],
  ): string {
    const goal = this.byID(goalID);
    if (!goal) throw new GoalConflictError(`unknown goal ${goalID}`);
    if (!isNonTerminal(goal.status)) {
      throw new TransitionRejectedError(`cannot add criteria to terminal goal ${goalID}`);
    }
    const normalized = text.trim().toLowerCase().replace(/\s+/g, " ");
    if (source === "model" && spec?.type === "objective") {
      throw new TransitionRejectedError(
        "the model cannot establish an objective-type criterion; only the user can accept the objective",
      );
    }
    const covered = covers && covers.length > 0 ? [...new Set(covers)] : undefined;
    if (covered) {
      // Coverage links are claims about *this* goal's objective-level
      // requirements. They are validated here so a link can never point at
      // another goal, a missing row, or a criterion the model itself created
      // (a model row must not bootstrap authority by covering itself).
      const existing = this.listCriteria(goalID);
      for (const id of covered) {
        const target = existing.find((c) => c.id === id);
        if (!target) {
          throw new TransitionRejectedError(`unknown criterion ${id} in covers`);
        }
        if (target.spec?.type !== "objective") {
          throw new TransitionRejectedError(
            `criterion ${id} is not an objective-level requirement; covers may only name the objective remainder`,
          );
        }
      }
    }
    let id = "";
    this.tx(() => {
      const existingRows = this.db
        .query<{ id: string; text: string }, [string]>(
          `SELECT id, text FROM goal_criteria WHERE goal_id = ? AND superseded = 0`,
        )
        .all(goalID);
      const existing = existingRows.find(
        (r) => r.text.trim().toLowerCase().replace(/\s+/g, " ") === normalized,
      );
      if (existing) {
        // Idempotent re-registration can still contribute coverage: the same
        // concrete requirement may be the model's evidence for two objective
        // requirements. Merge rather than replace.
        if (covered) this.mergeCoverage(existing.id, covered);
        id = existing.id;
        return;
      }
      id = this.insertCriterion(goalID, goal.generation, { text, spec, source }, Date.now(), covered);
    });
    return id;
  }

  /** Union new coverage links into an existing criterion row. */
  private mergeCoverage(criterionID: string, covers: string[]): void {
    const row = this.db
      .query<{ covers: string | null }, [string]>(`SELECT covers FROM goal_criteria WHERE id = ?`)
      .get(criterionID);
    if (!row) return;
    const merged = new Set<string>([...(row.covers ? (JSON.parse(row.covers) as string[]) : []), ...covers]);
    this.db
      .query(`UPDATE goal_criteria SET covers = ? WHERE id = ?`)
      .run(JSON.stringify([...merged]), criterionID);
  }

  /**
   * Supersede a criterion that investigation proved wrong.
   *
   * The row is retained for the audit trail but stops gating verification.
   * Explicit user requirements are never freely supersedeable: removing one
   * to pass verification is exactly the failure this ledger exists to
   * prevent. The model's only route is a proposed replacement that provably
   * preserves the original obligation (`preservesObligation`); anything
   * weaker — or a requirement whose preservation cannot be established
   * mechanically — is refused and must go to the user.
   */
  supersedeCriterion(
    criterionID: string,
    reason: string,
    replacement?: { text: string; spec?: CriterionSpec },
  ): void {
    this.tx(() => {
      const row = this.db
        .query<{
          goal_id: string;
          generation: number;
          source: string;
          spec: string | null;
          superseded: number;
        }, [string]>(
          `SELECT goal_id, generation, source, spec, superseded FROM goal_criteria WHERE id = ?`,
        )
        .get(criterionID);
      if (!row) throw new GoalConflictError(`unknown criterion ${criterionID}`);
      if (row.source === "user") {
        if (!replacement) {
          throw new TransitionRejectedError(
            "an explicit user requirement cannot be superseded; it must be satisfied, or the user must replace the objective",
          );
        }
        const oldSpec: CriterionSpec | undefined = row.spec ? JSON.parse(row.spec) : undefined;
        if (!preservesObligation(oldSpec, replacement.spec)) {
          throw new TransitionRejectedError(
            "the proposed replacement does not preserve the original obligation; ask the user to authorize the change",
          );
        }
        if (row.superseded === 1) return; // idempotent
        this.db
          .query(`UPDATE goal_criteria SET superseded = 1, met = 0 WHERE id = ?`)
          .run(criterionID);
        this.insertCriterion(
          row.goal_id,
          row.generation,
          { text: replacement.text, spec: replacement.spec, source: "user" },
          Date.now(),
        );
        this.appendEvent(row.goal_id, row.generation, "criterion-superseded", {
          actor: "controller",
          detail: `model-proposed replacement preserved the obligation: ${reason.slice(0, 240)}`,
        });
        return;
      }
      if (row.superseded === 1) return; // idempotent
      this.db
        .query(`UPDATE goal_criteria SET superseded = 1, met = 0 WHERE id = ?`)
        .run(criterionID);
      this.appendEvent(row.goal_id, row.generation, "criterion-superseded", {
        actor: "model",
        detail: reason.slice(0, 300),
      });
    });
  }

  /**
   * Record explicit user acceptance of the objective-level remainder.
   *
   * Acceptance is generation-fenced: it applies to the goal generation that
   * existed when the user accepted. Replacement mints a new generation, so a
   * new objective always requires fresh acceptance.
   */
  recordUserAcceptance(goalID: string, generation: number, note?: string): void {
    this.tx(() => {
      const goal = this.byID(goalID);
      if (!goal) throw new GoalConflictError(`unknown goal ${goalID}`);
      if (goal.generation !== generation) {
        throw new GoalConflictError(
          `stale generation: goal ${goalID} is generation ${goal.generation}, acceptance claimed ${generation}`,
        );
      }
      this.db
        .query(
          `INSERT INTO goal_acceptances (goal_id, generation, note, at_ms)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(goal_id) DO UPDATE SET generation=excluded.generation,
             note=excluded.note, at_ms=excluded.at_ms`,
        )
        .run(goalID, generation, note ?? null, Date.now());
      this.appendEvent(goalID, generation, "accepted", {
        actor: "user",
        detail: note ?? "user accepted the objective",
      });
    });
  }

  /** The acceptance recorded for a goal, if any. */
  userAcceptance(goalID: string): { generation: number; note?: string; atMs: number } | undefined {
    const row = this.db
      .query<{ generation: number; note: string | null; at_ms: number }, [string]>(
        `SELECT generation, note, at_ms FROM goal_acceptances WHERE goal_id = ?`,
      )
      .get(goalID);
    if (!row) return undefined;
    return { generation: row.generation, note: row.note ?? undefined, atMs: row.at_ms };
  }

  /** The latest objective-level assessment recorded for a goal, if any. */
  objectiveAssessment(goalID: string):
    | {
        generation: number;
        objectiveRevision: number;
        verdict: "satisfied" | "incomplete" | "indeterminate";
        scope: string;
        coveredRequirements: string[];
        unresolvedRequirements: string[];
        evidenceIDs: string[];
        note?: string;
        atMs: number;
      }
    | undefined {
    const row = this.db
      .query<
        {
          generation: number;
          objective_revision: number;
          verdict: string;
          scope: string;
          covered_requirements: string;
          unresolved_requirements: string;
          evidence_ids: string;
          note: string | null;
          at_ms: number;
        },
        [string]
      >(
        `SELECT generation, objective_revision, verdict, scope, covered_requirements,
                unresolved_requirements, evidence_ids, note, at_ms
           FROM goal_objective_assessments WHERE goal_id = ?`,
      )
      .get(goalID);
    if (!row) return undefined;
    return {
      generation: row.generation,
      objectiveRevision: row.objective_revision,
      verdict: row.verdict as "satisfied" | "incomplete" | "indeterminate",
      scope: row.scope,
      coveredRequirements: JSON.parse(row.covered_requirements) as string[],
      unresolvedRequirements: JSON.parse(row.unresolved_requirements) as string[],
      evidenceIDs: JSON.parse(row.evidence_ids) as string[],
      note: row.note ?? undefined,
      atMs: row.at_ms,
    };
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
          `INSERT INTO goal_evidence (id, goal_id, generation, criterion_id, kind, ref, detail, exit_code, hash, workspace, at_ms, fingerprint)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          evidenceFingerprint({
            kind: input.kind,
            ref: input.ref,
            exitCode: input.exitCode,
            hash: input.hash,
          }) ?? null,
        );
    });
  }

  /** Active criteria. Superseded ones are retained in the table for the audit
   *  trail but no longer gate verification, so they are not listed. */
  listCriteria(goalID: string): {
    id: string;
    text: string;
    met: boolean;
    spec?: CriterionSpec;
    source: string;
    covers?: string[];
  }[] {
    return this.db
      .query<
        { id: string; text: string; met: number; spec: string | null; source: string; covers: string | null },
        [string]
      >(
        `SELECT id, text, met, spec, source, covers FROM goal_criteria
          WHERE goal_id = ? AND superseded = 0 ORDER BY created_at_ms ASC`,
      )
      .all(goalID)
      .map((r) => ({
        id: r.id,
        text: r.text,
        met: r.met === 1,
        spec: r.spec ? (JSON.parse(r.spec) as CriterionSpec) : undefined,
        source: r.source,
        covers: r.covers ? (JSON.parse(r.covers) as string[]) : undefined,
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
   * How many observations captured since `sinceMs` are genuinely NEW (audit-4
   * #9): their fingerprint does not appear on any strictly earlier evidence
   * row for the goal, and they are not model-annotated pointers.
   *
   * This is the round-level progress signal: ten identical `pwd` rows count as
   * ONE observation (the first), while three different investigation commands
   * count as three. Within a single round, the second occurrence of an
   * observation is also not new — repetition inside one turn cannot buy
   * progress either.
   */
  countNewFingerprintEvidence(
    goalID: string,
    sinceMs: number,
    excludeKinds: readonly string[] = ["ref", "blocker-ref"],
  ): number {
    const placeholders = excludeKinds.map(() => "?").join(", ");
    const row = this.db
      .query<{ n: number }, [string, number, ...string[]]>(
        `SELECT COUNT(*) AS n FROM goal_evidence e
          WHERE e.goal_id = ? AND e.at_ms >= ?
            AND e.fingerprint IS NOT NULL
            AND e.kind NOT IN (${placeholders})
            AND NOT EXISTS (
              SELECT 1 FROM goal_evidence p
               WHERE p.goal_id = e.goal_id
                 AND p.fingerprint = e.fingerprint
                 AND p.kind NOT IN (${placeholders})
                 AND (p.at_ms < e.at_ms OR (p.at_ms = e.at_ms AND p.id < e.id))
            )`,
      )
      .get(goalID, sinceMs, ...excludeKinds, ...excludeKinds)!;
    return row.n;
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

  /**
   * Close a verification attempt as abandoned (idempotent). Used when a proof
   * batch is discarded — or when a verifier exits early, before producing a
   * batch — so the attempt ledger never shows an open run that will never
   * record anything.
   */
  abandonVerificationAttempt(attemptID: string): void {
    this.abandonAttempt(attemptID);
  }

  /**
   * Close a verification attempt as abandoned (idempotent). Used when a proof
   * batch is discarded so the attempt ledger never shows a lingering open run
   * that will never record anything.
   */
  private abandonAttempt(attemptID: string): void {
    if (!attemptID) return;
    this.db
      .query(
        `UPDATE goal_verification_attempts SET status = 'abandoned', finished_at_ms = ?
          WHERE id = ? AND status = 'open'`,
      )
      .run(Date.now(), attemptID);
  }

  /**
   * Open a verification attempt record (audit-4 #10).
   *
   * The attempt captures the goal generation + version the verifier is about
   * to describe. `recordProofs` refuses any proof batch whose attempt is not
   * still the goal's open attempt, so a verifier delayed past another
   * verification run (or past any goal transition) can neither overwrite
   * newer proof results nor resurrect its own.
   */
  beginVerificationAttempt(goalID: string, expected: { generation: number; version: number }): string {
    return this.tx(() => {
      const goal = this.byID(goalID);
      if (!goal) throw new GoalConflictError(`unknown goal ${goalID}`);
      if (goal.generation !== expected.generation || goal.version !== expected.version) {
        throw new GoalConflictError(
          `goal ${goalID} changed before the verification attempt was opened (generation ${goal.generation}, version ${goal.version})`,
        );
      }
      const id = newID("vatt");
      this.db
        .query(
          `INSERT INTO goal_verification_attempts (id, goal_id, generation, version, status, started_at_ms)
           VALUES (?, ?, ?, ?, 'open', ?)`,
        )
        .run(id, goalID, expected.generation, expected.version, Date.now());
      return id;
    });
  }

  /**
   * Persist the proofs a verification attempt produced, atomically.
   *
   * The write is fenced TWICE: by the verification attempt id — the attempt
   * must still be the goal's open attempt, so a delayed verifier that raced a
   * newer run is discarded — and by generation + version: if the goal changed
   * state while validation was running, the proofs are discarded and the
   * caller learns its decision described a world that no longer exists.
   * Criterion readouts are only ever updated by a verifier that observed the
   * current goal through the attempt it opened.
   *
   * Returns true when the proofs were recorded; false when discarded.
   */
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
    attempt?: { generation: number; version: number; attemptID: string },
    assessment?: {
      objectiveRevision: number;
      verdict: "satisfied" | "incomplete" | "indeterminate";
      scope: string;
      coveredRequirements: string[];
      unresolvedRequirements: string[];
      evidenceIDs: string[];
      note?: string;
    },
  ): boolean {
    return this.tx(() => {
      const goal = this.byID(goalID);
      if (!goal) throw new GoalConflictError(`unknown goal ${goalID}`);
      if (attempt && (goal.generation !== attempt.generation || goal.version !== attempt.version)) {
        // Stale verification: the goal was replaced or transitioned mid-run.
        // No proof rows, no criterion readout changes, no revision bump. The
        // dead attempt is closed so the record reflects reality.
        this.abandonAttempt(attempt.attemptID);
        return false;
      }
      if (attempt) {
        // Attempt fence: the caller's attempt must still be the goal's open
        // attempt. A newer run (or a transition away from `verifying`) has
        // already superseded it — its results must not overwrite newer ones.
        const open = this.db
          .query<{ id: string }, [string]>(
            `SELECT id FROM goal_verification_attempts
              WHERE goal_id = ? AND status = 'open'
              ORDER BY started_at_ms DESC, id DESC LIMIT 1`,
          )
          .get(goalID);
        if (!open || open.id !== attempt.attemptID) {
          this.abandonAttempt(attempt.attemptID);
          return false;
        }
      }
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
      if (assessment) {
        // The objective-level assessment is written in the same fenced
        // transaction as the proofs it was computed from: a stale attempt can
        // never persist an assessment against a superseded goal.
        this.db
          .query(
            `INSERT INTO goal_objective_assessments
               (goal_id, generation, objective_revision, verdict, scope,
                covered_requirements, unresolved_requirements, evidence_ids, note, at_ms)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(goal_id) DO UPDATE SET generation=excluded.generation,
               objective_revision=excluded.objective_revision, verdict=excluded.verdict,
               scope=excluded.scope, covered_requirements=excluded.covered_requirements,
               unresolved_requirements=excluded.unresolved_requirements,
               evidence_ids=excluded.evidence_ids, note=excluded.note, at_ms=excluded.at_ms`,
          )
          .run(
            goalID,
            goal.generation,
            assessment.objectiveRevision,
            assessment.verdict,
            assessment.scope,
            JSON.stringify(assessment.coveredRequirements),
            JSON.stringify(assessment.unresolvedRequirements),
            JSON.stringify(assessment.evidenceIDs),
            assessment.note ?? null,
            now,
          );
        this.appendEvent(goalID, goal.generation, "assessed", {
          actor: "controller",
          detail: `${assessment.verdict}: ${assessment.unresolvedRequirements.length} unresolved requirement(s)`,
        });
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
      // The attempt has produced its durable result: close it so it can never
      // fence in a second, later proof batch (audit-4 #10).
      if (attempt) {
        this.db
          .query(
            `UPDATE goal_verification_attempts SET status = 'recorded', finished_at_ms = ?
              WHERE id = ? AND status = 'open'`,
          )
          .run(now, attempt.attemptID);
      }
      return true;
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
   * Record a blocker claim for the reporting round and return how many
   * independent confirmations the claim has (audit-4 #8).
   *
   * The round number is derived from the goal's settled-round counter, so two
   * calls in the same turn map to the same round and count once.
   *
   * Independence is anchored to OBSERVED backing, not to strings or citation
   * sets: the claim's signature is the normalized reason plus the timestamp of
   * the freshest captured observation matching the claimed refs, and a claim
   * only confirms when that observation was captured AFTER the previous
   * counted confirmation was recorded. Repeating the reason, citing the same
   * evidence, citing a different SUBSET of already-seen evidence, or GROWING
   * the citation set over already-observed rows adds nothing — only evidence
   * the controller observed since the last confirmation can corroborate. A
   * claim with no observed backing at all records with a NULL signature and
   * can never count as a confirmation — an assertion is not evidence.
   */
  recordBlockerClaim(input: {
    goalID: string;
    generation: number;
    roundNumber: number;
    reason: string;
    /** Evidence refs the claim is backed by, as claimed. */
    evidenceKeys?: string[];
  }): number {
    return this.tx(() => {
      const normalized = normalizeBlockerReason(input.reason);
      const keys = [...new Set(input.evidenceKeys ?? []).values()].map((k) => k.trim()).filter(Boolean).sort();
      let sig: string | null = null;
      if (keys.length > 0) {
        // Freshest machine-observed backing for the claimed refs. Refs may be
        // evidence row ids or the observed command/path text; either way only
        // real observations count, and the claim's own blocker-ref rows do not.
        const placeholders = keys.map(() => "?").join(", ");
        const backing = this.db
          .query<{ m: number | null }, [string, ...string[]]>(
            `SELECT MAX(at_ms) AS m FROM goal_evidence
              WHERE goal_id = ? AND (id IN (${placeholders}) OR ref IN (${placeholders}))
                AND kind NOT IN ('ref', 'blocker-ref')`,
          )
          .get(input.goalID, ...keys, ...keys);
        if (backing?.m) {
          sig = `${normalized}::${backing.m}`;
        }
      }
      this.db
        .query(
          `INSERT INTO goal_blocker_claims (id, goal_id, generation, round_number, reason, evidence_sig, at_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(newID("blk"), input.goalID, input.generation, input.roundNumber, normalized, sig, Date.now());
      return this.blockerConfirmations(input.goalID, input.generation, input.reason);
    });
  }

  /**
   * Number of distinct independent confirmations of the same unresolved
   * dependency: distinct reporting rounds whose backing observation was
   * captured AFTER the previous counted confirmation was recorded (audit-4
   * #8). Repeating strings, re-citing subsets of seen evidence, or growing
   * the citation set over already-observed rows is not corroboration; only
   * evidence the controller observed since the last confirmation counts.
   */
  blockerConfirmations(goalID: string, generation: number, reason: string): number {
    const normalized = normalizeBlockerReason(reason);
    const claims = this.db
      .query<{ round_number: number; evidence_sig: string | null; at_ms: number }, [string, number, string]>(
        `SELECT round_number, evidence_sig, at_ms FROM goal_blocker_claims
          WHERE goal_id = ? AND generation = ? AND reason = ?
          ORDER BY round_number ASC, id ASC`,
      )
      .all(goalID, generation, normalized);
    // Walk the claims in reporting order. A claim confirms the dependency
    // only when its backing observation is strictly newer than the moment
    // the previous counted confirmation was RECORDED — i.e. something new
    // was actually observed between the two confirmations. Comparing
    // against the prior claim's recording time (not its backing timestamp)
    // also kills the growing-citation climb: re-citing older evidence that
    // happens to be fresher than the previous claim's backing is not a new
    // observation. Count distinct reporting rounds.
    let observedThrough = Number.NEGATIVE_INFINITY;
    const countedRounds = new Set<number>();
    let legacyCounted = false;
    for (const claim of claims) {
      if (!claim.evidence_sig) continue;
      const sep = claim.evidence_sig.lastIndexOf("::");
      const ts = sep >= 0 ? Number(claim.evidence_sig.slice(sep + 2)) : Number.NaN;
      if (!Number.isFinite(ts)) {
        // Legacy (pre-migration) reason-only signature: it carries no observed
        // backing, so it counts once for its first reporting round and its
        // repeats never confirm. It does not advance the freshness bar.
        if (!legacyCounted) {
          legacyCounted = true;
          countedRounds.add(claim.round_number);
        }
        continue;
      }
      if (ts <= observedThrough) continue;
      observedThrough = claim.at_ms;
      countedRounds.add(claim.round_number);
    }
    return countedRounds.size;
  }

  /**
   * Charge session-level usage to goals (audit-4 #3).
   *
   * One durable observation per (execution, event) identity. Cumulative
   * billing uses the session high-water mark, persisted as
   * MAX(previous, observed): a delayed event carrying a LOWER total never
   * lowers the baseline, so replaying the later event afterwards cannot
   * charge the same tokens again. Only the positive increment over the
   * high-water mark is ever charged.
   *
   * Attribution is execution-scoped: when the caller supplies a message or
   * execution id, the observation is resolved through the durable
   * message-generation map and charged to THAT goal generation (or left
   * unassigned when the execution predates every current goal or its goal is
   * terminal). Without an execution identity, the observation charges the
   * goal that was current when the event arrived. Unknown attribution stays
   * unassigned — it never silently accrues to the current goal.
   *
   * Token fields are disjoint per opencode 2 semantics (tokens.output is
   * visible output with reasoning excluded), so the total is their sum.
   * The caller may instead pass `total` directly (an explicit
   * tokens.total from the payload), which is honored verbatim.
   */
  recordUsageObservation(input: {
    sessionID: string;
    /** Event envelope id — the primary dedup identity when present. */
    eventID?: string;
    /** The execution/message that produced the usage, for generation-scoped attribution. */
    messageID?: string;
    inputTokens?: number;
    outputTokens?: number;
    reasoningTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    total?: number;
    atMs?: number;
  }): {
    goal?: Goal;
    delta: number;
    duplicate: boolean;
    attribution: "execution" | "current" | "unassigned";
  } {
    const atMs = input.atMs ?? Date.now();
    // Per-field sanitation: a garbage value (NaN, Infinity) becomes 0 instead
    // of poisoning the whole observation — the valid components still bill.
    const safeTokens = (value: number | undefined): number => {
      const n = Number(value ?? 0);
      return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
    };
    const components = {
      input: safeTokens(input.inputTokens),
      output: safeTokens(input.outputTokens),
      reasoning: safeTokens(input.reasoningTokens),
      cacheRead: safeTokens(input.cacheReadTokens),
      cacheWrite: safeTokens(input.cacheWriteTokens),
    };
    const observedTotal =
      input.total !== undefined
        ? safeTokens(input.total)
        : components.input + components.output + components.reasoning + components.cacheRead + components.cacheWrite;
    const observationKey =
      input.eventID && input.eventID.trim()
        ? `evt:${input.eventID.trim()}`
        : `exe:${input.messageID ?? ""}:${observedTotal}:${Math.floor(atMs / 1000)}`;

    return this.tx(() => {
      // Dedup first: a replayed event is a no-op, never a second charge.
      const existing = this.db
        .query<{ attribution: string }, [string, string]>(
          `SELECT attribution FROM goal_usage_observations WHERE session_id = ? AND observation_key = ?`,
        )
        .get(input.sessionID, observationKey);
      if (existing) {
        const goal = this.current(input.sessionID) ?? undefined;
        return {
          goal,
          delta: 0,
          duplicate: true,
          attribution: existing.attribution as "execution" | "current" | "unassigned",
        };
      }

      // Execution-scoped attribution: resolve the producing message to the
      // (goal, generation) it actually belonged to.
      let attributedGoal: Goal | undefined;
      let attribution: "execution" | "current" | "unassigned" = "unassigned";
      let goalID: string | null = null;
      let generation: number | null = null;
      if (input.messageID) {
        const g = this.resolveMessageGeneration(input.sessionID, input.messageID);
        if (g !== undefined) {
          // The execution identity resolved: the usage belongs to generation
          // g, full stop. If that goal is terminal (superseded/completed), the
          // usage is recorded UNASSIGNED — falling back to the current goal
          // here is precisely the misattribution audit-4 #3 forbids.
          const historical = this.byGeneration(input.sessionID, g);
          generation = g;
          if (historical && isNonTerminal(historical.status)) {
            attributedGoal = historical;
            goalID = historical.id;
            attribution = "execution";
          }
        }
      }
      if (!attributedGoal && !input.messageID) {
        // No execution identity at all: the observation charges the goal that
        // was current when the event arrived.
        const current = this.current(input.sessionID);
        if (current && isNonTerminal(current.status)) {
          attributedGoal = current;
          goalID = current.id;
          generation = current.generation;
          attribution = "current";
        }
      }

      this.db
        .query(
          `INSERT INTO goal_usage_observations
             (id, session_id, execution_id, goal_id, generation, attribution,
              input_tokens, output_tokens, reasoning_tokens, cache_read_tokens,
              cache_write_tokens, total_tokens, at_ms, observation_key)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          newID("usage"),
          input.sessionID,
          input.messageID ?? null,
          goalID,
          generation,
          attribution,
          components.input,
          components.output,
          components.reasoning,
          components.cacheRead,
          components.cacheWrite,
          observedTotal,
          atMs,
          observationKey,
        );

      // Monotonic session high-water mark: MAX(previous, observed). A delayed
      // lower total must not lower the baseline, or replaying the later,
      // higher event would double-bill the difference.
      const previous = this.db
        .query<{ total_tokens: number }, [string]>(
          `SELECT total_tokens FROM session_usage WHERE session_id = ?`,
        )
        .get(input.sessionID)?.total_tokens ?? 0;
      const highWater = Math.max(previous, observedTotal);
      const delta = Math.max(0, highWater - previous);
      this.db
        .query(
          `INSERT INTO session_usage (session_id, total_tokens, updated_at_ms)
           VALUES (?, ?, ?)
           ON CONFLICT(session_id) DO UPDATE SET
             total_tokens = MAX(session_usage.total_tokens, excluded.total_tokens),
             updated_at_ms = excluded.updated_at_ms`,
        )
        .run(input.sessionID, highWater, Date.now());

      if (delta > 0 && attributedGoal) {
        this.db
          .query(`UPDATE goals SET tokens_used = COALESCE(tokens_used, 0) + ?, updated_at_ms = ? WHERE id = ?`)
          .run(delta, Date.now(), attributedGoal.id);
      }
      return { goal: attributedGoal, delta, duplicate: false, attribution };
    });
  }

  /**
   * Legacy cumulative entry point: charge the running session total to the
   * current goal. Kept for callers that have no event identity. New callers
   * should use recordUsageObservation, which adds observation dedup and
   * execution-scoped attribution.
   */
  recordSessionUsage(sessionID: string, totalTokens: number): {
    goal?: Goal;
    delta: number;
  } {
    const result = this.recordUsageObservation({ sessionID, total: totalTokens });
    return { goal: result.goal, delta: result.delta };
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
      // Snapshot how much VERIFIABLE evidence already exists, so settlement
      // can tell whether this round produced any verified work at all.
      // Checkpoint refs are model-annotated pointers, not observations: a
      // model that emits ten goal_checkpoint calls without doing anything must
      // not earn ten "progress" verdicts.
      const baseline = this.db
        .query<{ n: number }, [string]>(
          `SELECT COUNT(*) AS n FROM goal_evidence WHERE goal_id = ? AND kind NOT IN ('ref', 'blocker-ref')`,
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
   *
   * `parkGoal: false` is for rounds abandoned BEFORE any submission was
   * attempted (the goal was replaced or paused between reserve and dispatch).
   * No delivery was attempted there, so recording a delivery failure would be a
   * lie — and since nothing clears that flag automatically, it would wrongly
   * require a recovery step the user never caused.
   */
  markRoundFailed(
    roundID: string,
    detail: string,
    options: { parkGoal?: boolean } = {},
  ): GoalRound {
    const parkGoal = options.parkGoal ?? true;
    return this.tx(() => {
      const round = this.roundByID(roundID);
      if (!round) throw new GoalConflictError(`unknown round ${roundID}`);
      this.db
        .query(`UPDATE goal_rounds SET status='failed', detail=?, settled_at_ms=? WHERE id=?`)
        .run(detail, Date.now(), roundID);
      const goal = this.byID(round.goalID);
      if (goal && parkGoal) {
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
   * Canonical hash of the criteria + evidence snapshot a verification checks.
   *
   * ONE implementation, owned by the store: the verifier records its result
   * against this hash, and `completeGoal` recomputes it from the CURRENT world
   * to prove nothing changed between the verification decision and the commit.
   */
  snapshotOf(goalID: string): string {
    return snapshotHash(this.listCriteria(goalID), this.listEvidence(goalID));
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
      if (input.snapshot !== undefined) {
        // Freshness, recomputed from the CURRENT criteria and evidence rather
        // than trusted from the record: a verifier that ran before a late
        // checkpoint, criterion change or evidence mutation must not be able
        // to commit a decision the world has since contradicted.
        const current = this.snapshotOf(input.goalID);
        if (current !== input.snapshot) {
          throw new GoalConflictError(
            `verification is stale: the criteria or evidence changed after the verifier checked ` +
              `${input.snapshot} (now ${current}); re-verify before completing`,
          );
        }
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

  /**
   * How many goal generations this session has ever had.
   *
   * Timestamp attribution is only sound when the answer is 1: with several
   * generations their execution lifetimes may overlap, so wall-clock order
   * cannot decide which generation produced a message.
   */
  generationCount(sessionID: string): number {
    const row = this.db
      .query<{ n: number }, [string]>(`SELECT COUNT(*) AS n FROM goals WHERE session_id = ?`)
      .get(sessionID);
    return row?.n ?? 0;
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
