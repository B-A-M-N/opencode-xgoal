/**
 * OpenCode-XGoal — controller operations on top of the durable store.
 *
 * This is the layer the plugin and the model talk to. It encodes the authority
 * split: the model may propose, the controller decides, the user may command.
 *
 * Deliberately absent here: any notion that "the plan is finished" implies the
 * goal is finished. Completion requires the controller to run verification
 * against current evidence (Phase 04); until then `proposeComplete` only moves
 * the goal to `verifying`.
 */
import { GoalStore, GoalConflictError } from "./store.ts";
import { type Actor, type Goal, type GoalStatus, isNonTerminal } from "./state.ts";

export interface ControllerOptions {
  /** Path to the SQLite database. */
  dbPath: string;
  /** Consecutive unproductive rounds before the controller stalls the goal. */
  maxNoProgressRounds?: number;
  /** Repeated blocker confirmations before a blocker is accepted as genuine. */
  minBlockerConfirmations?: number;
}

export interface BlockedReport {
  reason: string;
  evidenceRefs?: string[];
  /** Did the model identify a concrete external dependency? */
  externalDependency?: boolean;
  /** Optional goal reference the caller believed it was acting on. */
  goalID?: string;
  generation?: number;
}

/**
 * A caller-supplied reference to the goal it believes is current. Every
 * model-facing operation accepts one so that a late callback from a superseded
 * goal is refused rather than silently applied to its replacement.
 */
export interface GoalRef {
  goalID?: string;
  generation?: number;
}

type TargetResult =
  | { ok: true; goal: Goal }
  | { ok: false; rejected: string };

export class GoalController {
  readonly store: GoalStore;
  private readonly maxNoProgressRounds: number;
  private readonly minBlockerConfirmations: number;

  constructor(options: ControllerOptions) {
    this.store = new GoalStore(options.dbPath);
    this.maxNoProgressRounds = options.maxNoProgressRounds ?? 3;
    this.minBlockerConfirmations = options.minBlockerConfirmations ?? 2;
  }

  close(): void {
    this.store.close();
  }

  /** Called once on plugin startup. */
  reconcileStartup(): Goal[] {
    return this.store.reconcileAfterRestart();
  }

  // ------------------------------------------------------- user commands

  /** `/goal <objective>` — start, or report that a replacement is required. */
  startOrDescribe(sessionID: string, objective: string): { created: Goal } | { existing: Goal } {
    const existing = this.store.current(sessionID);
    if (existing) return { existing };
    return { created: this.store.create({ sessionID, objective, actor: "user" }) };
  }

  /** `/goal replace <objective>` — explicit replacement, generation-fenced. */
  replace(sessionID: string, objective: string, expectedGeneration?: number): Goal {
    const existing = this.store.current(sessionID);
    if (!existing) {
      return this.store.create({ sessionID, objective, actor: "user" });
    }
    return this.store.replace({
      sessionID,
      expectedGeneration: expectedGeneration ?? existing.generation,
      objective,
      actor: "user",
    });
  }

  pause(sessionID: string): Goal {
    const goal = this.requireCurrent(sessionID);
    return this.store.transition({
      goalID: goal.id,
      generation: goal.generation,
      to: "paused",
      actor: "user",
    });
  }

  resume(sessionID: string): Goal {
    const goal = this.requireCurrent(sessionID);
    return this.store.transition({
      goalID: goal.id,
      generation: goal.generation,
      to: "active",
      actor: "user",
      reason: "resumed by user",
    });
  }

  status(sessionID: string): Goal | undefined {
    return this.store.current(sessionID);
  }

  history(sessionID: string): Goal[] {
    return this.store.history(sessionID);
  }

  // ------------------------------------------------------ model-facing tools

  get(sessionID: string): Goal | undefined {
    return this.store.current(sessionID);
  }

  /** `goal_checkpoint` — record progress without changing status. */
  checkpoint(
    sessionID: string,
    input: { summary: string; evidenceRefs?: string[] } & GoalRef,
  ): { recorded: boolean; goal?: Goal; rejected?: string } {
    const target = this.resolveTarget(sessionID, input);
    if (!target.ok) return { recorded: false, rejected: target.rejected };
    const goal = target.goal;
    for (const ref of input.evidenceRefs ?? []) {
      this.store.addEvidence({ goalID: goal.id, kind: "ref", ref, detail: input.summary });
    }
    const updated = this.store.recordRound({
      goalID: goal.id,
      generation: goal.generation,
      classification: "progress",
      detail: input.summary.slice(0, 300),
    });
    return { recorded: true, goal: updated };
  }

  /**
   * `goal_propose_complete` — the model proposes; it does not commit.
   *
   * This only moves the goal to `verifying`. The transition table makes
   * `verifying -> complete` reachable by the controller alone, so a model
   * cannot declare its own success.
   */
  proposeComplete(
    sessionID: string,
    input: { summary: string; evidenceRefs?: string[] } & GoalRef,
  ): { goal?: Goal; rejected?: string } {
    const target = this.resolveTarget(sessionID, input);
    if (!target.ok) return { rejected: target.rejected };
    const goal = target.goal;

    for (const ref of input.evidenceRefs ?? []) {
      this.store.addEvidence({ goalID: goal.id, kind: "ref", ref, detail: input.summary });
    }
    const updated = this.store.transition({
      goalID: goal.id,
      generation: goal.generation,
      to: "verifying",
      actor: "model",
      reason: input.summary.slice(0, 300),
    });
    return { goal: updated };
  }

  /**
   * `goal_report_blocked` — a claim of blockage, not an accepted blocker.
   *
   * A single report does not park the goal. The controller requires repeated
   * confirmations before treating a blocker as genuine, so that a model asking
   * an optional workflow question cannot force the goal into `blocked`.
   */
  reportBlocked(
    sessionID: string,
    report: BlockedReport,
  ): { goal?: Goal; accepted: boolean; confirmations: number; rejected?: string } {
    const target = this.resolveTarget(sessionID, report);
    if (!target.ok) {
      return { accepted: false, confirmations: 0, rejected: target.rejected };
    }
    const goal = target.goal;

    for (const ref of report.evidenceRefs ?? []) {
      this.store.addEvidence({ goalID: goal.id, kind: "blocker-ref", ref, detail: report.reason });
    }

    // Count the report first, then decide. One report is not enough unless the
    // model identified a concrete external dependency.
    const counted = this.store.recordRound({
      goalID: goal.id,
      generation: goal.generation,
      classification: "blocked",
      detail: report.reason.slice(0, 300),
    });
    const confirmations = counted.repeatedBlockerRounds;

    const genuine =
      report.externalDependency === true || confirmations >= this.minBlockerConfirmations;
    if (!genuine) {
      // Stay active; the goal keeps making progress rather than parking.
      return { goal: counted, accepted: false, confirmations };
    }

    const blocked = this.store.transition({
      goalID: goal.id,
      generation: goal.generation,
      to: "blocked",
      actor: "controller",
      reason: report.reason.slice(0, 300),
    });
    return { goal: blocked, accepted: true, confirmations };
  }

  // --------------------------------------------------------- controller ops

  /** Record a settled round and apply the stall policy. */
  classifyRound(
    sessionID: string,
    classification: "progress" | "verifiedWait" | "noProgress",
    detail?: string,
    tokensUsed?: number,
  ): Goal | undefined {
    const goal = this.store.current(sessionID);
    if (!goal || !isNonTerminal(goal.status)) return goal;
    const updated = this.store.recordRound({
      goalID: goal.id,
      generation: goal.generation,
      classification,
      detail,
      tokensUsed,
    });
    if (
      classification === "noProgress" &&
      updated.noProgressRounds >= this.maxNoProgressRounds &&
      updated.status === "active"
    ) {
      return this.store.transition({
        goalID: updated.id,
        generation: updated.generation,
        to: "stalled",
        actor: "controller",
        reason: `${updated.noProgressRounds} consecutive rounds without progress`,
      });
    }
    return updated;
  }

  /** Apply resource limits observed by the controller. */
  enforceBudget(sessionID: string): Goal | undefined {
    const goal = this.store.current(sessionID);
    if (!goal || goal.status !== "active") return goal;
    if (goal.tokenBudget !== undefined && (goal.tokensUsed ?? 0) >= goal.tokenBudget) {
      return this.store.transition({
        goalID: goal.id,
        generation: goal.generation,
        to: "budgetLimited",
        actor: "controller",
        reason: `token budget reached (${goal.tokensUsed}/${goal.tokenBudget})`,
      });
    }
    return goal;
  }

  /** Controller-only completion, callable after verification has passed. */
  commitComplete(goalID: string, generation: number, reason: string): Goal {
    // Settle any in-flight round as `complete` BEFORE the goal becomes terminal.
    // Otherwise the round stays outstanding, and reconciliation later marks it
    // failed — recording a spurious failure against a goal that succeeded.
    const outstanding = this.store.outstandingRound(goalID);
    if (outstanding) {
      try {
        this.store.settleRound({
          roundID: outstanding.id,
          classification: "complete",
          detail: reason,
        });
        this.store.recordRound({
          goalID,
          generation,
          classification: "complete",
          detail: reason,
        });
      } catch {
        // A round that cannot be settled must not block completion.
      }
    }
    return this.store.transition({
      goalID,
      generation,
      to: "complete",
      actor: "controller",
      reason,
    });
  }

  /** Controller-only rejection of a completion claim. */
  rejectCompletion(sessionID: string, reason: string): Goal | undefined {
    const goal = this.store.current(sessionID);
    if (!goal || goal.status !== "verifying") return goal;
    return this.store.transition({
      goalID: goal.id,
      generation: goal.generation,
      to: "active",
      actor: "controller",
      reason,
    });
  }

  private requireCurrent(sessionID: string): Goal {
    const goal = this.store.current(sessionID);
    if (!goal) throw new GoalConflictError(`session ${sessionID} has no current goal`);
    return goal;
  }

  /**
   * Resolve the goal a model-facing call is aimed at, refusing stale references.
   *
   * Without this, a callback from a superseded goal that happens to match the
   * session would be applied to its replacement. Fencing on both goal ID and
   * generation is what makes replacement safe.
   */
  private resolveTarget(sessionID: string, ref?: GoalRef): TargetResult {
    const current = this.store.current(sessionID);
    if (!current) return { ok: false, rejected: "no active goal for this session" };
    if (!isNonTerminal(current.status)) {
      return { ok: false, rejected: `goal is ${current.status}` };
    }
    if (ref?.goalID !== undefined && ref.goalID !== current.id) {
      return {
        ok: false,
        rejected: `stale goal reference: ${ref.goalID} is not the current goal (${current.id})`,
      };
    }
    if (ref?.generation !== undefined && ref.generation !== current.generation) {
      return {
        ok: false,
        rejected: `stale generation: callback claimed ${ref.generation}, current is ${current.generation}`,
      };
    }
    return { ok: true, goal: current };
  }
}

export { GoalConflictError } from "./store.ts";
export type { Goal, GoalStatus, Actor };
