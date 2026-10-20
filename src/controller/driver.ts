/**
 * OpenCode-XGoal — continuation driver.
 *
 * Owns the exactly-once admission problem. The invariants:
 *
 *  1. A continuation attempt is RESERVED in a transaction before anything is
 *     submitted, and the reserved inbox ID is persisted first. A crash between
 *     reserve and submit therefore leaves a recoverable `prepared` round rather
 *     than a lost continuation.
 *  2. The inbox ID is generated once and NEVER regenerated. A timeout means the
 *     outcome is unknown, not that the attempt failed — so we retry the SAME id
 *     and let the session deduplicate it. Minting a fresh id on timeout is the
 *     classic way to double-submit.
 *  3. Admission is not execution. `admitted` only means the session accepted the
 *     message. Only an observed round outcome settles it.
 *  4. No database lock is ever held across a transport call. Each store method
 *     opens and closes its own transaction; the transport is called outside them.
 *  5. At most one outstanding round per goal, enforced by a partial unique index,
 *     so two concurrent triggers cannot both dispatch.
 *
 * Events are wake-up signals only. `reconcile()` is authoritative and is driven
 * by the ledger, so a missed event cannot strand a goal.
 */
import {
  GoalConflictError,
  type GoalRound,
  type GoalStore,
} from "./store.ts";
import { type Goal, isNonTerminal, isTerminal } from "./state.ts";

/** Result of trying to hand a continuation to the session. */
export type SubmitResult =
  | { ok: true }
  /** Definitively rejected: the message will never run. Not a model failure. */
  | { ok: false; retryable: false; error: string }
  /** Ambiguous: timeout, lost response, transport error. Retry the SAME id. */
  | { ok: false; retryable: true; error: string };

/**
 * What we can observe about a round from the session side.
 *
 * `notDelivered` is the only state that justifies re-submitting, and even then
 * with the original inbox ID.
 */
export type ProbeResult = "notDelivered" | "running" | "settled" | "unknown";

export interface ContinuationTransport {
  submit(input: {
    sessionID: string;
    inboxID: string;
    text: string;
    metadata: Record<string, unknown>;
  }): Promise<SubmitResult>;
  probe(input: { sessionID: string; round: GoalRound }): Promise<ProbeResult>;
}

export interface DriverOptions {
  /** Max consecutive unproductive settled rounds before stalling. */
  maxNoProgressRounds?: number;
  /** Max times a single round may be re-submitted before it is failed. */
  maxRoundAttempts?: number;
  /** Render the continuation text for a goal. */
  renderContinuation?: (goal: Goal) => string;
  /**
   * Classify a settled round. Called exactly once per round, from the same
   * transaction that settles it. Supply this from the plugin so the classifier
   * sees real tool observations rather than a guess.
   */
  classify?: (input: {
    goal: Goal;
    round: GoalRound;
    evidenceCount: number;
    /** Evidence captured during this round specifically. */
    evidenceDelta: number;
  }) => { classification: "progress" | "verifiedWait" | "noProgress" | "blocked"; detail?: string };
}

const DEFAULT_CLASSIFY = ({
  evidenceDelta,
}: {
  evidenceDelta: number;
}): { classification: "progress" | "noProgress"; detail?: string } => {
  // A turn that produced no new machine-verifiable evidence is not progress,
  // even if the model wrote a paragraph. This is what makes the stall policy
  // meaningful instead of letting an active model reset the counter forever.
  if (evidenceDelta > 0) {
    return { classification: "progress", detail: `${evidenceDelta} new evidence item(s)` };
  }
  return { classification: "noProgress", detail: "no new evidence captured this round" };
};

export type DriveOutcome =
  | { action: "idle"; reason: string }
  | { action: "limited"; status: string }
  | { action: "admitted"; roundID: string; inboxID: string }
  | { action: "unknown"; roundID: string; inboxID: string; detail: string }
  | { action: "failed"; roundID: string; inboxID: string; detail: string }
  | { action: "abandoned"; roundID: string; detail: string }
  | { action: "reconcile"; roundID: string; status: string };

let seq = 0;

/**
 * Mint a stable OpenCode message ID for a continuation.
 *
 * Deterministic shape, unique per call. Once persisted this value is never
 * recomputed for the same attempt.
 */
export function newInboxID(): string {
  seq += 1;
  const rand = Math.random().toString(36).slice(2, 10);
  return `msg_xgoal_${Date.now().toString(36)}${seq.toString(36)}${rand}`;
}

const DEFAULT_CONTINUATION = (goal: Goal): string =>
  [
    "Continue working toward the active goal.",
    "",
    `Objective: ${goal.objective}`,
    "",
    "Inspect the current state before acting. Take the next useful action.",
    "A workflow preference, an optional decision, or a choice between reasonable",
    "next steps is not a blocker — choose and continue. If the objective is",
    "genuinely satisfied, propose completion with evidence.",
  ].join("\n");

export class GoalDriver {
  private readonly store: GoalStore;
  private readonly transport: ContinuationTransport;
  private readonly maxNoProgressRounds: number;
  private readonly maxRoundAttempts: number;
  private readonly render: (goal: Goal) => string;
  private readonly classify: NonNullable<DriverOptions["classify"]>;

  constructor(
    store: GoalStore,
    transport: ContinuationTransport,
    options: DriverOptions = {},
  ) {
    this.store = store;
    this.transport = transport;
    this.maxNoProgressRounds = options.maxNoProgressRounds ?? 3;
    this.maxRoundAttempts = options.maxRoundAttempts ?? 5;
    this.render = options.renderContinuation ?? DEFAULT_CONTINUATION;
    this.classify = options.classify ?? DEFAULT_CLASSIFY;
  }

  /**
   * Decide whether another turn is warranted, reserve it, and dispatch it.
   *
   * The decision and reservation happen inside the store's transaction; the
   * transport call happens strictly outside it.
   */
  async drive(sessionID: string): Promise<DriveOutcome> {
    // Reconcile any in-flight round first. If it has settled, this settles it,
    // records its outcome, and (inside reconcileRound) submits the next
    // continuation. Only a round left outstanding falls through to reserve().
    const goal = this.store.current(sessionID);
    if (goal && goal.status === "active") {
      const outstanding = this.store.outstandingRound(goal.id);
      if (outstanding) {
        const outcome = await this.reconcileRound(outstanding);
        if (outcome.action !== "reconcile") return outcome;
      }
    }

    const decision = this.reserve(sessionID);
    if (decision.action !== "dispatch") return decision.outcome;

    return this.dispatch(decision.round, sessionID);
  }

  /** Reserve phase. Pure store work; no I/O. */
  private reserve(
    sessionID: string,
  ): { action: "dispatch"; round: GoalRound } | { action: "done"; outcome: DriveOutcome } {
    const goal = this.store.current(sessionID);
    if (!goal) return { action: "done", outcome: { action: "idle", reason: "no goal" } };
    if (goal.status !== "active") {
      return {
        action: "done",
        outcome: { action: "idle", reason: `goal status is ${goal.status}` },
      };
    }

    // A round already in flight: reconcile it, never start a second.
    const outstanding = this.store.outstandingRound(goal.id);
    if (outstanding) {
      return {
        action: "done",
        outcome: { action: "reconcile", roundID: outstanding.id, status: outstanding.status },
      };
    }

    // A terminal delivery failure stops automatic dispatch until recovery.
    // Without this, a later execution event would mint a fresh continuation and
    // circumvent the retry limit.
    if (goal.deliveryFailed) {
      return {
        action: "done",
        outcome: { action: "idle", reason: "delivery failed; awaiting recovery" },
      };
    }

    // Resource limit: the controller decides, not the model.
    if (goal.tokenBudget !== undefined && (goal.tokensUsed ?? 0) >= goal.tokenBudget) {
      const limited = this.store.transition({
        goalID: goal.id,
        generation: goal.generation,
        to: "budgetLimited",
        actor: "controller",
        reason: `token budget reached (${goal.tokensUsed}/${goal.tokenBudget})`,
      });
      return { action: "done", outcome: { action: "limited", status: limited.status } };
    }

    // Reserve BEFORE submitting, so a crash here is recoverable.
    const inboxID = newInboxID();
    const round = this.store.prepareRound({
      goalID: goal.id,
      generation: goal.generation,
      inboxID,
    });
    return { action: "dispatch", round };
  }

  /** Dispatch phase. Transport I/O happens here, outside any transaction. */
  private async dispatch(round: GoalRound, sessionID: string): Promise<DriveOutcome> {
    // Re-check the world immediately before submitting: replacement may have
    // happened while we were reserving.
    const goal = this.store.byID(round.goalID);
    if (!goal || goal.generation !== round.generation || isTerminal(goal.status)) {
      const detail = goal
        ? `goal moved to generation ${goal.generation} / ${goal.status}`
        : "goal no longer exists";
      this.store.markRoundFailed(round.id, `abandoned before admission: ${detail}`);
      return { action: "abandoned", roundID: round.id, detail };
    }

    try {
      const result = await this.transport.submit({
        sessionID,
        // Always the reserved id. Never a fresh one.
        inboxID: round.inboxID,
        text: this.render(goal),
        metadata: {
          goalID: goal.id,
          generation: goal.generation,
          roundID: round.id,
          inboxID: round.inboxID,
        },
      });

      if (result.ok) {
        // Admission only. Execution is observed separately.
        this.store.markRoundAdmitted(round.id);
        return { action: "admitted", roundID: round.id, inboxID: round.inboxID };
      }
      if (result.retryable) {
        this.store.markRoundUnknown(round.id, result.error);
        return {
          action: "unknown",
          roundID: round.id,
          inboxID: round.inboxID,
          detail: result.error,
        };
      }
      this.store.markRoundFailed(round.id, result.error);
      return {
        action: "failed",
        roundID: round.id,
        inboxID: round.inboxID,
        detail: result.error,
      };
    } catch (error) {
      // An exception is ambiguous, not a definitive rejection.
      const detail = String(error);
      this.store.markRoundUnknown(round.id, detail);
      return { action: "unknown", roundID: round.id, inboxID: round.inboxID, detail };
    }
  }

  /**
   * Reconcile every outstanding round against reality.
   *
   * This is the recovery sweep: run on startup, after a stream reconnect, and
   * periodically. It is driven by the ledger rather than by events, so a missed
   * event cannot strand a goal.
   */
  async reconcile(): Promise<DriveOutcome[]> {
    const out: DriveOutcome[] = [];
    for (const round of this.store.outstandingRounds()) {
      out.push(await this.reconcileRound(round));
    }
    // Startup recovery: a goal whose continuation terminally failed and which
    // now has no outstanding round is allowed to dispatch again. This is the
    // "recovery" path that clears the delivery block.
    for (const goal of this.store.activeGoals()) {
      if (goal.deliveryFailed && !this.store.outstandingRound(goal.id)) {
        this.store.clearDeliveryFailure(goal.id);
      }
    }
    return out;
  }

  private async reconcileRound(round: GoalRound): Promise<DriveOutcome> {
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

    // Give up on a round that has been retried too many times, rather than
    // spinning forever. This is an admission problem, not a model problem.
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

      case "settled": {
        // The round has actually finished. Settle it exactly once, classify it,
        // and then continue the loop if the goal still has work.
        const evidenceCount = this.store.listEvidence(goal.id).length;
        const evidenceDelta = Math.max(0, evidenceCount - round.evidenceBaseline);
        const verdict = this.classify({ goal, round, evidenceCount, evidenceDelta });
        const settledGoal = this.settleRound({
          roundID: round.id,
          classification: verdict.classification,
          detail: verdict.detail,
        });
        const settledStatus = settledGoal?.status ?? round.status;
        // A stalled or terminal goal must not be re-driven.
        const after = this.store.byID(goal.id);
        if (!after || !isNonTerminal(after.status)) {
          return { action: "reconcile", roundID: round.id, status: settledStatus };
        }
        // Recheck generation: the goal may have been replaced while settling.
        if (after.generation !== round.generation) {
          return { action: "reconcile", roundID: round.id, status: settledStatus };
        }
        // Apply the stall policy. The store records the round; the decision to
        // park the goal is the controller's, so it lives here.
        const stalled =
          verdict.classification === "noProgress" &&
          after.noProgressRounds >= this.maxNoProgressRounds &&
          after.status === "active";
        if (stalled) {
          const parked = this.store.transition({
            goalID: after.id,
            generation: after.generation,
            to: "stalled",
            actor: "controller",
            reason: `${after.noProgressRounds} consecutive rounds without progress`,
          });
          return { action: "reconcile", roundID: round.id, status: parked.status };
        }
        const next = this.reserve(after.sessionID);
        if (next.action === "dispatch") return this.dispatch(next.round, after.sessionID);
        return next.outcome;
      }

      case "notDelivered": {
        // Safe to retry, and only with the original id.
        try {
          this.store.markRoundUnknown(round.id, "not delivered; retrying with original id");
        } catch {
          /* ignore */
        }
        const retry = this.store.roundByID(round.id)!;
        return this.dispatch(retry, goal.sessionID);
      }

      case "unknown":
      default:
        // Leave it outstanding; the next sweep re-probes.
        return { action: "reconcile", roundID: round.id, status: round.status };
    }
  }

  /**
   * Settle a round and apply the stall policy.
   *
   * Kept separate from dispatch so an admission failure can never be mistaken
   * for a no-progress round.
   */
  settleRound(input: {
    roundID: string;
    classification: "progress" | "verifiedWait" | "noProgress" | "blocked" | "complete";
    detail?: string;
    tokensUsed?: number;
  }): Goal | undefined {
    const round = this.store.roundByID(input.roundID);
    if (!round) throw new GoalConflictError(`unknown round ${input.roundID}`);
    // Settle and record in ONE transaction, and idempotently. A duplicate
    // terminal-execution event must not increment the round counter twice.
    const { goal } = this.store.settleAndRecord({
      roundID: input.roundID,
      classification: input.classification,
      detail: input.detail,
      tokensUsed: input.tokensUsed,
    });
    return goal;
  }

  /** Consecutive unproductive rounds needed before a goal is stalled. */
  get stallThreshold(): number {
    return this.maxNoProgressRounds;
  }
}
