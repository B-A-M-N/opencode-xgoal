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
  /**
   * Is an execution for this session observably still running? A verified wait
   * — not a guess — used so a turn spent waiting on a real background job is
   * not scored as an unproductive round.
   */
  liveWait?(input: { sessionID: string }): boolean;
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
    /** Verifiable evidence only — checkpoint refs are not observations. */
    evidenceCount: number;
    /** Verifiable evidence captured during this round specifically. */
    evidenceDelta: number;
    /**
     * Observations captured this round whose fingerprint was never seen
     * before (audit-4 #9). Repetition of an earlier observation — the same
     * command, same result — does not count. This, not `evidenceDelta`, is
     * the honest progress signal.
     */
    newObservations: number;
    /** Is a background execution for this session still running? */
    liveWait: boolean;
  }) => { classification: "progress" | "verifiedWait" | "noProgress" | "blocked"; detail?: string };
  /**
   * How long a durable wait on a still-running background execution may last
   * before the goal is re-evaluated and parked with an actionable reason
   * (audit-4 #4). A safety net for stale liveness observations, mirroring the
   * transport's staleness TTL — not a polling interval.
   */
  maxVerifiedWaitMs?: number;
  /**
   * Next-reconciliation interval persisted with a durable wait. The sweep,
   * not this value, drives actual rechecks; this is the scheduling contract.
   */
  waitRecheckMs?: number;
}

const DEFAULT_CLASSIFY = ({
  evidenceDelta,
  newObservations,
  liveWait,
}: {
  evidenceDelta: number;
  newObservations: number;
  liveWait: boolean;
}): { classification: "progress" | "verifiedWait" | "noProgress"; detail?: string } => {
  // Progress requires a NEW observation, not merely another evidence row
  // (audit-4 #9): running `pwd` every round adds rows that all share one
  // fingerprint and must never reset the stall counter. A failed test that
  // appears for the first time, or a different investigation command, IS a
  // new observation and counts.
  if (newObservations > 0) {
    return { classification: "progress", detail: `${newObservations} new observation(s)` };
  }
  // Rows were added, but every one of them repeats a known observation:
  // bookkeeping noise, not progress.
  if (evidenceDelta > 0) {
    return {
      classification: "noProgress",
      detail: `${evidenceDelta} evidence row(s), all repeats of known observations`,
    };
  }
  // No new evidence, but an execution is observably still running: waiting on
  // it is a verified wait, not an unproductive turn, so it must not accumulate
  // toward a stall.
  if (liveWait) {
    return {
      classification: "verifiedWait",
      detail: "no new evidence, but a background execution is still running",
    };
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
  | { action: "reconcile"; roundID: string; status: string }
  /**
   * Durable wait (audit-4 #4): the goal is parked on an observable background
   * execution. No continuation is minted; the sweep rechecks without tokens
   * and wakes the goal when the awaited work is no longer running.
   */
  | { action: "waiting"; roundID: string; status: string; reason: string; recheckMs: number };

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
  private readonly maxVerifiedWaitMs: number;
  private readonly waitRecheckMs: number;
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
    // Deliberately SHORTER than the transport's 15-minute liveness staleness
    // TTL: the transport TTL runs from when the busy reference started, which
    // is typically before the goal's wait did. With the driver bound at 10
    // minutes, an unconfirmable wait deterministically reaches the parked
    // "waiting exceeded" branch instead of being woken by the TTL expiring
    // first (which would mint continuations against a possibly stale
    // liveness observation). Both are safety nets, not polling intervals.
    this.maxVerifiedWaitMs = options.maxVerifiedWaitMs ?? 10 * 60_000;
    // The recheck cadence must sit INSIDE the wait bound: enterWait refreshes
    // wait_recheck_ms on every wake-or-expiry cycle while preserving the
    // original wait start, so a recheck horizon at or beyond the bound would
    // let each cycle re-arm the not-due window and defer the parked state
    // indefinitely. Clamping keeps the invariant recheckMs < maxVerifiedWaitMs.
    this.waitRecheckMs = Math.min(options.waitRecheckMs ?? 30_000, Math.max(this.maxVerifiedWaitMs - 1, 0));
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
      // Durable wait (audit-4 #4): a wait is a scheduling decision, not a
      // continuation. Recheck the awaited work here — a transport probe, no
      // model tokens — and only wake the goal when the wait is over.
      const wait = this.store.activeWait(goal.id);
      if (wait) {
        const outcome = await this.recheckWait(goal, wait);
        if (outcome.action !== "reconcile") return outcome;
      }
    }

    const decision = this.reserve(sessionID);
    if (decision.action !== "dispatch") return decision.outcome;

    return this.dispatch(decision.round, sessionID);
  }

  /**
   * Recheck a durable wait (audit-4 #4) without consuming model tokens.
   *
   * While the awaited execution is observably still running and the wait is
   * within its bound, the goal is left alone — no continuation is minted. When
   * the work completes or fails, the wait clears and the goal wakes with a
   * fresh continuation. When the wait exceeds its bound, the goal is parked
   * with an actionable reason instead of being re-driven blindly.
   */
  private async recheckWait(
    goal: Goal,
    wait: { reason: string; startedMs: number; recheckMs: number },
  ): Promise<DriveOutcome> {
    const running = this.transport.liveWait?.({ sessionID: goal.sessionID }) ?? false;
    const waitedMs = Math.max(0, Date.now() - wait.startedMs);

    if (running && waitedMs < this.maxVerifiedWaitMs) {
      return {
        action: "waiting",
        roundID: "",
        status: goal.status,
        reason: wait.reason,
        recheckMs: wait.recheckMs,
      };
    }

    // Either the awaited work is no longer running, or the wait exceeded its
    // bound. Both retire the wait.
    this.store.clearWait(goal.id);

    if (running) {
      // Still running beyond the bound: the liveness observation may be stale,
      // or the job is very long. Either way, more blind waiting is wrong.
      // Park the goal with an actionable reason; the user decides.
      const parked = this.store.transition({
        goalID: goal.id,
        generation: goal.generation,
        to: "stalled",
        actor: "controller",
        reason: `waiting on background execution exceeded ${Math.round(
          this.maxVerifiedWaitMs / 1000,
        )}s: ${wait.reason}`,
      });
      return { action: "limited", status: parked.status };
    }

    // The awaited work completed, failed, or is no longer observable. Wake the
    // goal: the recheck itself consumed no tokens, the wake is a normal
    // continuation.
    const decision = this.reserve(goal.sessionID);
    if (decision.action !== "dispatch") return decision.outcome;
    return this.dispatch(decision.round, goal.sessionID);
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
    // Re-check the world immediately before submitting: replacement or a pause
    // may have happened while we were reserving. Only an active goal may admit
    // a continuation — paused, blocked, verifying, stalled or budget-limited
    // goals must not have new work pushed into the session.
    const goal = this.store.byID(round.goalID);
    if (!goal || goal.generation !== round.generation || goal.status !== "active") {
      const detail = goal
        ? `goal moved to generation ${goal.generation} / status ${goal.status}`
        : "goal no longer exists";
      // No submission was attempted, so this is not a delivery failure.
      this.store.markRoundFailed(round.id, `abandoned before admission: ${detail}`, {
        parkGoal: false,
      });
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
        // Bind the continuation message to its generation the moment it is
        // admitted. The synthetic message carries this inbox ID, so any
        // assistant message that follows it in the transcript is attributable
        // to this execution by position — independent of wall-clock order
        // between overlapping generations.
        this.store.rememberMessageGeneration(
          sessionID,
          round.inboxID,
          round.generation,
          Date.now(),
        );
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
    // Durable waits (audit-4 #4): goals parked on a background execution have
    // no outstanding round, so the loop above never sees them. Each wait
    // carries its persisted next-reconciliation time: only waits that have
    // fallen due are re-probed here, on the persisted contract rather than
    // the sweep's own cadence. (The awaited work completing still wakes the
    // goal early through the event-driven drive() path.)
    for (const waiting of this.store.goalsWithActiveWaits()) {
      const goal = this.store.byID(waiting.goalID);
      if (!goal || goal.status !== "active") {
        this.store.clearWait(waiting.goalID);
        continue;
      }
      const wait = this.store.activeWait(waiting.goalID);
      if (!wait) continue;
      // Recheck when the persisted next reconciliation time has fallen due.
      // The 15-minute staleness TTL in the transport bounds how long a stale
      // liveness observation can hold the goal, so a long sweep interval
      // delays rechecks but cannot strand one past its own bound.
      if (Date.now() - wait.startedMs < wait.recheckMs) {
        out.push({
          action: "waiting",
          roundID: "",
          status: goal.status,
          reason: wait.reason,
          recheckMs: wait.recheckMs - (Date.now() - wait.startedMs),
        });
        continue;
      }
      try {
        out.push(await this.recheckWait(goal, wait));
      } catch (error) {
        // One goal's conflict (replaced/transitioned concurrently) must not
        // abort the recheck of the others; the next sweep reconciles it.
        out.push({ action: "idle", reason: `wait recheck deferred: ${String(error)}` });
      }
    }
    // A terminal delivery failure is deliberately NOT cleared here. Sweeping is
    // automatic; recovering a definitively rejected goal must not be. Without
    // this, every periodic sweep would erase the block the retry limit set and
    // a permanent HTTP 400 would mint continuations forever. Recovery happens
    // only through `controller.resume()`, an explicit user/model action that
    // re-requests dispatch after the underlying condition may have changed.
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
      // The goal itself moved on; a failure attributable to supersession is not
      // a delivery failure of the goal that now exists.
      this.store.markRoundFailed(round.id, detail, { parkGoal: false });
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
        // Verifiable evidence only: checkpoint refs are model-annotated
        // pointers, and counting them would let a model manufacture "progress"
        // by narrating instead of working. Blocker reports are model-annotated
        // claims for the same reason.
        const verifiable = this.store
          .listEvidence(goal.id)
          .filter((e) => e.kind !== "ref" && e.kind !== "blocker-ref");
        const evidenceCount = verifiable.length;
        const evidenceDelta = Math.max(0, evidenceCount - round.evidenceBaseline);
        const newObservations = this.store.countNewFingerprintEvidence(goal.id, round.preparedAtMs);
        const liveWait = this.transport.liveWait?.({ sessionID: goal.sessionID }) ?? false;
        const verdict = this.classify({ goal, round, evidenceCount, evidenceDelta, newObservations, liveWait });
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
        // Audit-4 #4: a verified wait is a scheduling decision, not a
        // continuation trigger. Record what is awaited and when it will be
        // rechecked, and stop spending model turns — the sweep rechecks the
        // wait without tokens and wakes the goal when the work completes.
        if (verdict.classification === "verifiedWait") {
          const reason = verdict.detail ?? "background execution still running";
          this.store.enterWait({
            goalID: after.id,
            generation: after.generation,
            reason,
            recheckMs: this.waitRecheckMs,
          });
          return {
            action: "waiting",
            roundID: round.id,
            status: after.status,
            reason,
            recheckMs: this.waitRecheckMs,
          };
        }
        // A productive round retires any lingering wait: whatever was awaited
        // is no longer the scheduling question.
        this.store.clearWait(after.id);
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
