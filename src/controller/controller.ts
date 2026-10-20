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
import {
  deriveCriteria as deriveCriterionInputs,
  type CriterionInput,
  type CriterionSpec,
} from "./criteria.ts";

export interface ControllerOptions {
  /** Path to the SQLite database. */
  dbPath: string;
  /** Consecutive unproductive rounds before the controller stalls the goal. */
  maxNoProgressRounds?: number;
  /** Repeated blocker confirmations before a blocker is accepted as genuine. */
  minBlockerConfirmations?: number;
  /**
   * Derive preliminary acceptance criteria from a freshly stated objective.
   *
   * Ordinary `/goal <objective>` must not start with zero criteria, or
   * verification can never pass. The default extractor parses concrete file
   * requirements into independently checkable specs and falls back to an
   * objective-level criterion. Criteria can be refined later, but the original
   * objective stays immutable.
   */
  deriveCriteria?: (objective: string) => CriterionInput[];
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
  private readonly deriveCriteria: (objective: string) => CriterionInput[];

  constructor(options: ControllerOptions) {
    this.store = new GoalStore(options.dbPath);
    this.maxNoProgressRounds = options.maxNoProgressRounds ?? 3;
    this.minBlockerConfirmations = options.minBlockerConfirmations ?? 2;
    this.deriveCriteria = options.deriveCriteria ?? deriveCriterionInputs;
  }

  close(): void {
    this.store.close();
  }

  /** Called once on plugin startup. */
  reconcileStartup(): Goal[] {
    return this.store.reconcileAfterRestart();
  }

  /**
   * Establish the acceptance criteria for a goal.
   *
   * Criteria are created inside the goal's creation transaction so a goal can
   * never exist with no criteria — which would make verification unsatisfiable.
   */
  private criteriaFor(objective: string): CriterionInput[] {
    return this.deriveCriteria(objective);
  }

  // ------------------------------------------------------- user commands

  /** `/goal <objective>` — start, or report that a replacement is required. */
  startOrDescribe(sessionID: string, objective: string): { created: Goal } | { existing: Goal } {
    const existing = this.store.current(sessionID);
    if (existing) return { existing };
    const goal = this.store.create({
      sessionID,
      objective,
      actor: "user",
      criteria: this.criteriaFor(objective),
    });
    return { created: goal };
  }

  /** `/goal replace <objective>` — explicit replacement, generation-fenced. */
  replace(sessionID: string, objective: string, expectedGeneration?: number): Goal {
    const existing = this.store.current(sessionID);
    const criteria = this.criteriaFor(objective);
    if (!existing) {
      return this.store.create({ sessionID, objective, actor: "user", criteria });
    }
    return this.store.replace({
      sessionID,
      expectedGeneration: expectedGeneration ?? existing.generation,
      objective,
      actor: "user",
      criteria,
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
    const resumed = this.store.transition({
      goalID: goal.id,
      generation: goal.generation,
      to: "active",
      actor: "user",
      reason: "resumed by user",
    });
    // An explicit user resume is the decision that clears a terminal delivery
    // failure, so automatic dispatch may resume.
    if (resumed.deliveryFailed) this.store.clearDeliveryFailure(resumed.id);
    return this.store.byID(resumed.id) ?? resumed;
  }

  /**
   * `/goal accept [note]` — explicit user acceptance of the objective.
   *
   * This is the resolution for the part of a goal that cannot be machine-proven
   * (an `{ type: "objective" }` criterion). It is a USER action only: a model
   * that could accept its own objective would defeat the entire verification
   * gate. Acceptance is generation-fenced, so replacing the goal requires
   * accepting the new objective afresh.
   */
  acceptObjective(sessionID: string, note?: string): Goal {
    const goal = this.requireCurrent(sessionID);
    this.store.recordUserAcceptance(goal.id, goal.generation, note);
    return this.store.byID(goal.id) ?? goal;
  }

  status(sessionID: string): Goal | undefined {
    return this.store.current(sessionID);
  }

  /** The latest goal, including a completed one. For status readouts. */
  latest(sessionID: string): Goal | undefined {
    return this.store.latest(sessionID);
  }

  /**
   * Record session-level token usage against the active goal.
   *
   * The driver enforces the ceiling at reserve time, so accounting only has to
   * be durable and monotonic; it never grants permission to continue.
   */
  recordUsage(sessionID: string, totalTokens: number): Goal | undefined {
    return this.store.recordSessionUsage(sessionID, totalTokens).goal;
  }

  /** `/goal budget <n>` — set the ceiling through the store, not raw SQL. */
  setBudget(sessionID: string, budget: number | undefined): Goal {
    const goal = this.requireCurrent(sessionID);
    return this.store.setTokenBudget(goal.id, budget);
  }

  /**
   * Structured health for the TUI and for operators.
   *
   * The acceptance gate is "set a goal and watch it finish". When it does not,
   * this is what says why: an undriven goal, a stuck round, a delivery failure,
   * or unmet criteria with no evidence.
   */
  health(sessionID: string): Record<string, unknown> {
    const goal = this.store.latest(sessionID);
    if (!goal) return { ok: true, goal: null };
    const criteria = this.store.listCriteria(goal.id);
    const evidence = this.store.listEvidence(goal.id);
    const round = this.store.outstandingRound(goal.id);
    const rounds = this.store.roundsFor(goal.id);
    const last = rounds[rounds.length - 1];
    const stuckMs = round ? Date.now() - round.preparedAtMs : 0;
    const problems: string[] = [];
    if (goal.status === "active" && !round) {
      problems.push("active goal has no outstanding round: nothing is driving it");
    }
    if (goal.deliveryFailed) {
      problems.push("continuation delivery failed; automatic dispatch is halted");
    }
    if (round && round.attempts > 3) {
      problems.push(`round ${round.id} has ${round.attempts} submission attempts`);
    }
    if (round && stuckMs > 5 * 60_000) {
      problems.push(`round ${round.id} has been outstanding for ${Math.round(stuckMs / 1000)}s`);
    }
    if (goal.status === "verifying") {
      const unmet = criteria.filter((criterion) => !criterion.met);
      if (unmet.length) problems.push(`${unmet.length} unmet criterion/criteria during verification`);
    }
    return {
      ok: problems.length === 0,
      goal: {
        id: goal.id,
        generation: goal.generation,
        status: goal.status,
        objective: goal.objective,
      },
      drive: {
        outstandingRound: round
          ? { id: round.id, status: round.status, attempts: round.attempts, ageMs: stuckMs }
          : null,
        lastRound: last ? { id: last.id, status: last.status, classification: last.classification ?? null } : null,
        deliveryFailed: goal.deliveryFailed,
        rounds: goal.rounds,
        noProgressRounds: goal.noProgressRounds,
      },
      usage: {
        tokensUsed: goal.tokensUsed ?? 0,
        tokenBudget: goal.tokenBudget ?? null,
      },
      verification: {
        criteria: criteria.map((criterion) => ({
          id: criterion.id,
          text: criterion.text,
          met: criterion.met,
          source: criterion.source,
        })),
        evidenceCount: evidence.length,
        verificationRevision: goal.verificationRevision,
      },
      problems,
    };
  }

  history(sessionID: string): Goal[] {
    return this.store.history(sessionID);
  }

  // ------------------------------------------------------ model-facing tools

  get(sessionID: string): Goal | undefined {
    return this.store.current(sessionID);
  }

  /**
   * Bind captured evidence to a criterion by evidence ID or by reference
   * (command string or file path). Binding is explicit, so unrelated evidence
   * cannot be counted against a criterion.
   *
   * A model sees relative paths in its own tool calls, while captured file
   * evidence stores the resolved absolute path. Accepting a unique basename or
   * path suffix avoids forcing the model to discover the workspace root, while
   * refusing an ambiguous match prevents accidental cross-binding.
   */
  bindCriterionEvidence(goalID: string, criterionID: string, refs: string[]): number {
    const evidence = this.store.listEvidence(goalID);
    const chosen = new Set<string>();
    for (const ref of refs) {
      const byID = evidence.find((e) => e.id === ref);
      if (byID) {
        chosen.add(byID.id);
        continue;
      }
      const exact = evidence.filter((e) => e.ref === ref);
      if (exact.length > 0) {
        for (const e of exact) chosen.add(e.id);
        continue;
      }
      const candidate =
        ref.includes("/") || ref.includes("\\")
          ? evidence.filter((e) => e.ref.endsWith(ref) || e.ref.endsWith(`/${ref}`))
          : evidence.filter((e) => e.kind === "file" && e.ref.split("/").pop() === ref);
      // Only bind when every candidate points at the same reference; two
      // different files with the same basename are ambiguous.
      if (candidate.length > 0 && new Set(candidate.map((e) => e.ref)).size === 1) {
        for (const e of candidate) chosen.add(e.id);
      }
    }
    if (chosen.size === 0) return 0;
    return this.store.bindEvidence(criterionID, [...chosen]);
  }

  /** Resolve a criterion by ID or by a unique exact text. */
  private resolveCriterion(goalID: string, identifier: string): string | undefined {
    const criteria = this.store.listCriteria(goalID);
    if (criteria.some((criterion) => criterion.id === identifier)) return identifier;
    const byText = criteria.filter((criterion) => criterion.text === identifier);
    return byText.length === 1 ? byText[0].id : undefined;
  }

  /**
   * `goal_checkpoint` — an evidence annotation, not a progress round.
   *
   * A checkpoint used to record a synthetic "progress" round, so a model could
   * call it repeatedly to reset no-progress accounting without doing anything.
   * It now only attaches evidence; the round counter advances once, when the
   * real execution settles.
   */
  checkpoint(
    sessionID: string,
    input: { summary: string; evidenceRefs?: string[]; criterionID?: string } & GoalRef,
  ): { recorded: boolean; goal?: Goal; rejected?: string } {
    const target = this.resolveTarget(sessionID, input);
    if (!target.ok) return { recorded: false, rejected: target.rejected };
    const goal = target.goal;
    for (const ref of input.evidenceRefs ?? []) {
      this.store.addEvidence({
        goalID: goal.id,
        criterionID: input.criterionID,
        kind: "ref",
        ref,
        detail: input.summary,
      });
    }
    // Evidence annotation only. No round is manufactured here.
    return { recorded: true, goal: this.store.byID(goal.id) };
  }

  /**
   * `goal_add_criterion` — refine the acceptance criteria during investigation.
   *
   * Criteria are additive and generation-fenced. The original objective is
   * never rewritten, and an explicit requirement may not be removed to pass
   * verification.
   */
  addCriterion(
    sessionID: string,
    input: { text: string; spec?: CriterionSpec } & GoalRef,
  ): { criterionID?: string; rejected?: string } {
    const target = this.resolveTarget(sessionID, input);
    if (!target.ok) return { rejected: target.rejected };
    try {
      const criterionID = this.store.addCriterion(
        target.goal.id,
        input.text,
        input.spec,
        "model",
      );
      return { criterionID };
    } catch (error) {
      return { rejected: String(error) };
    }
  }

  /**
   * `goal_supersede_criterion` — retire a derived criterion investigation
   * proved wrong.
   *
   * Only derived/model criteria are retireable; an explicit user requirement
   * must be satisfied, not explained away. The row is retained for the audit
   * trail.
   */
  supersedeCriterion(
    sessionID: string,
    input: { criterion_id: string; reason: string } & GoalRef,
  ): { superseded?: boolean; rejected?: string } {
    const target = this.resolveTarget(sessionID, input);
    if (!target.ok) return { rejected: target.rejected };
    const criterionID = this.resolveCriterion(target.goal.id, input.criterion_id);
    if (!criterionID) {
      return { rejected: `criterion ${input.criterion_id} does not exist on this goal` };
    }
    try {
      this.store.supersedeCriterion(criterionID, input.reason);
      return { superseded: true };
    } catch (error) {
      return { rejected: String(error) };
    }
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
    input: {
      summary: string;
      evidenceRefs?: string[];
      criteria?: { criterionID: string; evidenceRefs: string[] }[];
    } & GoalRef,
  ): { goal?: Goal; rejected?: string } {
    const target = this.resolveTarget(sessionID, input);
    if (!target.ok) return { rejected: target.rejected };
    const goal = target.goal;

    for (const ref of input.evidenceRefs ?? []) {
      this.store.addEvidence({ goalID: goal.id, kind: "ref", ref, detail: input.summary });
    }
    for (const binding of input.criteria ?? []) {
      // The model may pass either the criterion ID (preferred) or its exact
      // text. Text is accepted only when it identifies one criterion, so an
      // ambiguous label cannot bind evidence to the wrong requirement.
      const criterionID = this.resolveCriterion(goal.id, binding.criterionID);
      if (criterionID) this.bindCriterionEvidence(goal.id, criterionID, binding.evidenceRefs);
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
   * A single report does not park the goal, and a model asserting
   * `externalDependency: true` is not self-authenticating. The controller counts
   * *distinct reporting rounds* with an equivalent unresolved blocker, so
   * repeating the tool call inside one turn cannot manufacture a blocker.
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

    // The reporting round is the next unsettled round. Multiple calls in this
    // turn share it, so they count once; a later round increments it.
    const roundNumber = goal.rounds + 1;
    const confirmations = this.store.recordBlockerClaim({
      goalID: goal.id,
      generation: goal.generation,
      roundNumber,
      reason: report.reason,
    });

    // `externalDependency` is recorded as a claim but never trusted as proof.
    const genuine = confirmations >= this.minBlockerConfirmations;
    if (!genuine) {
      // Stay active; the goal keeps making progress rather than parking.
      return {
        goal: this.store.byID(goal.id),
        accepted: false,
        confirmations,
      };
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
    classification: "progress" | "verifiedWait" | "noProgress" | "blocked",
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

  /**
   * Controller-only completion, callable after verification has passed.
   *
   * The in-flight round settlement and the final status transition happen in
   * ONE transaction, guarded by the goal generation and the verification
   * snapshot the verifier actually checked. A stale verifier that returns a
   * result for an older evidence snapshot cannot complete the goal.
   */
  commitComplete(
    goalID: string,
    generation: number,
    reason: string,
    snapshot?: string,
  ): Goal {
    return this.store.completeGoal({
      goalID,
      generation,
      reason,
      snapshot,
      settleClassification: "complete",
    });
  }

  /** Controller-only rejection of a completion claim, generation-fenced. */
  rejectCompletion(goalID: string, generation: number, reason: string): Goal | undefined {
    const goal = this.store.byID(goalID);
    if (!goal || goal.status !== "verifying") return goal;
    if (goal.generation !== generation) return goal;
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
   * The goal ID and generation must be supplied and must match the current
   * goal. A call that names a superseded goal or generation is rejected rather
   * than applied to whatever happens to be current. A call that names neither
   * is also rejected: the controller never infers a generation from
   * `store.current()` at execution time, because that is exactly how a delayed
   * callback from a superseded execution gets attributed to its replacement.
   */
  private resolveTarget(sessionID: string, ref?: GoalRef): TargetResult {
    const current = this.store.current(sessionID);
    if (!current) return { ok: false, rejected: "no active goal for this session" };
    if (!isNonTerminal(current.status)) {
      return { ok: false, rejected: `goal is ${current.status}` };
    }
    if (!ref?.goalID) {
      return {
        ok: false,
        rejected: `unresolved goal reference: the tool call must name the current goal (${current.id})`,
      };
    }
    if (ref.goalID !== current.id) {
      return {
        ok: false,
        rejected: `stale goal reference: ${ref.goalID} is not the current goal (${current.id})`,
      };
    }
    if (ref.generation === undefined) {
      return {
        ok: false,
        rejected: `unresolved generation: the tool call must name generation ${current.generation}`,
      };
    }
    if (ref.generation !== current.generation) {
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
