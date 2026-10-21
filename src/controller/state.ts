/**
 * OpenCode-XGoal — goal state model and lifecycle transition rules.
 *
 * The controller owns goal status. The model may *propose* transitions; it may
 * not commit system-controlled ones. This mirrors Codex, where the model has
 * `update_goal` but cannot freely resume a budget-limited goal or override a
 * status the host set.
 *
 * Every transition names the actors permitted to make it. Anything not in the
 * table is invalid and must be rejected rather than coerced.
 */

export type GoalStatus =
  | "active"
  | "paused"
  | "verifying"
  | "complete"
  | "blocked"
  | "stalled"
  | "budgetLimited"
  | "usageLimited"
  | "superseded";

/** Statuses from which no further automatic work happens. */
export const TERMINAL_STATUSES: readonly GoalStatus[] = ["complete", "superseded"];

/** Statuses that occupy the session's single "current goal" slot. */
export const NON_TERMINAL_STATUSES: readonly GoalStatus[] = [
  "active",
  "paused",
  "verifying",
  "blocked",
  "stalled",
  "budgetLimited",
  "usageLimited",
];

export const ALL_STATUSES: readonly GoalStatus[] = [
  ...NON_TERMINAL_STATUSES,
  ...TERMINAL_STATUSES,
];

/**
 * Who is asking for a transition.
 *
 * - `model`      the agent, via a goal tool call
 * - `controller` the plugin itself, from observed evidence
 * - `user`       an explicit human action (/goal pause, resume, replace)
 */
export type Actor = "model" | "controller" | "user";

const ALL: readonly Actor[] = ["model", "controller", "user"];

/**
 * Allowed transitions. A missing entry is a rejected transition.
 *
 * Notable deliberate restrictions:
 * - `budgetLimited`/`usageLimited` cannot be cleared by the model; only an
 *   explicit user resume or a controller supersede. A model must not be able to
 *   talk its way out of a resource limit.
 * - `complete` is reachable only from `verifying`, and only by the controller.
 *   The model proposes completion; it does not commit it.
 * - Nothing transitions out of `complete` or `superseded`. Replacement creates a
 *   new generation rather than reviving a terminal goal.
 */
export const TRANSITIONS: Record<GoalStatus, Partial<Record<GoalStatus, readonly Actor[]>>> = {
  active: {
    paused: ["user", "controller"],
    verifying: ["model", "controller"],
    blocked: ["model", "controller"],
    stalled: ["controller"],
    budgetLimited: ["controller"],
    usageLimited: ["controller"],
    superseded: ["user", "controller"],
  },
  paused: {
    active: ["user", "controller"],
    superseded: ["user", "controller"],
  },
  verifying: {
    // Verification failed: the goal returns to work, it does not complete.
    active: ["controller"],
    complete: ["controller"],
    blocked: ["controller"],
    superseded: ["user", "controller"],
  },
  blocked: {
    active: ["user", "controller"],
    superseded: ["user", "controller"],
  },
  stalled: {
    active: ["user", "controller"],
    superseded: ["user", "controller"],
  },
  budgetLimited: {
    // Explicit user resume only. The model cannot clear a resource limit.
    active: ["user"],
    superseded: ["user", "controller"],
  },
  usageLimited: {
    active: ["user"],
    superseded: ["user", "controller"],
  },
  complete: {},
  superseded: {},
};

export interface TransitionRequest {
  from: GoalStatus;
  to: GoalStatus;
  actor: Actor;
}

export type TransitionCheck =
  | { ok: true }
  | { ok: false; reason: string };

export function canTransition({ from, to, actor }: TransitionRequest): TransitionCheck {
  if (from === to) {
    // Idempotent no-op. Allowed so repeated updates are harmless, but it must
    // not be treated as a state change by callers.
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
      reason: `transition ${from} -> ${to} is not permitted for actor "${actor}" (allowed: ${actors.join(", ")})`,
    };
  }
  return { ok: true };
}

export function isTerminal(status: GoalStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

export function isNonTerminal(status: GoalStatus): boolean {
  return NON_TERMINAL_STATUSES.includes(status);
}

/**
 * Classification of a settled round, per the design's progress model.
 *
 * `verifiedWait` exists so a live background job does not spin the controller
 * into new rounds, and `noProgress` is deliberately separate from `blocked` so
 * that "the model asked an optional workflow question" is never scored as a
 * genuine blocker.
 */
export type RoundClassification =
  | "progress"
  | "verifiedWait"
  | "noProgress"
  | "blocked"
  | "complete";

export interface Goal {
  id: string;
  sessionID: string;
  generation: number;
  objective: string;
  status: GoalStatus;
  reason?: string;
  rounds: number;
  noProgressRounds: number;
  repeatedBlockerRounds: number;
  tokensUsed?: number;
  tokenBudget?: number;
  /** Optimistic concurrency token. Every mutation increments it. */
  version: number;
  createdAtMs: number;
  updatedAtMs: number;
  completedAtMs?: number;
  supersededBy?: string;
  /** Revision of the evidence snapshot the last verification checked. */
  verificationRevision: number;
  /** Hash of the criteria+evidence snapshot the last verification checked. */
  verificationSnapshot?: string;
  /** True when a continuation submission terminally failed and dispatch is stopped. */
  deliveryFailed: boolean;
  /**
   * How this goal is permitted to reach completion (audit #1). A `machine` goal
   * needs only machine-checkable proofs; `audited` requires a scoped,
   * controller-recorded objective audit; `userAcceptance` requires explicit
   * user acceptance of the objective-level remainder.
   */
  completionPolicy: "machine" | "audited" | "userAcceptance";
  /** Revision of the user's objective; audits are scoped to a revision. */
  objectiveRevision: number;
}
