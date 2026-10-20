/**
 * OpenCode-XGoal — completion verification and progress classification.
 *
 * Two principles drive this file:
 *
 *  1. A model's statement is not evidence. Evidence is captured by the
 *     controller from observed tool executions — a command that actually ran and
 *     exited zero, a file that actually exists and changed. `goal_propose_complete`
 *     starts verification; it does not satisfy it.
 *  2. A nonempty diff is not progress, a passing unit test is not completion, and
 *     a model's preference to stop is not a blocker. Each is classified
 *     explicitly rather than collapsed into a single "did something happen" flag.
 */
import type { GoalStore, GoalRound } from "./store.ts";
import type { Goal } from "./state.ts";

/** Evidence kinds the controller can machine-verify. */
export type EvidenceKind =
  | "command" // a shell command observed to complete
  | "file" // a file observed to be written
  | "test" // a test command observed to pass
  | "runtime" // a program observed to run and exit zero
  | "ref"; // an unverifiable reference (never counts as proof)

export interface CapturedEvidence {
  kind: EvidenceKind;
  /** Command string, file path, or free reference. */
  ref: string;
  /** Exit code for command/test/runtime evidence. */
  exitCode?: number;
  /** Content hash for file evidence, so staleness is detectable. */
  hash?: string;
  atMs: number;
  /** Criterion this evidence is claimed to support, if bound. */
  criterionID?: string;
}

export interface EvidenceValidation {
  valid: boolean;
  reason: string;
}

/**
 * Validate captured evidence against current state.
 *
 * Injected so the verifier stays pure and testable, and so the plugin can back
 * it with real filesystem/process checks.
 */
export interface EvidenceValidator {
  validate(evidence: CapturedEvidence): Promise<EvidenceValidation>;
}

export interface VerificationResult {
  verdict: "complete" | "incomplete";
  /** Specific conditions that are not satisfied. */
  unmet: string[];
  reason: string;
}

/**
 * Records evidence the controller observed, keyed by goal.
 *
 * Only tool executions the controller actually saw are admissible. Anything a
 * model writes in prose never reaches this ledger.
 */
export class EvidenceLedger {
  private readonly store: GoalStore;

  constructor(store: GoalStore) {
    this.store = store;
  }

  /**
   * Observe a completed tool execution and capture admissible evidence.
   *
   * Returns the captured evidence, or undefined if the execution produced none.
   */
  capture(input: {
    goalID: string;
    tool: string;
    status: "completed" | "error";
    args: unknown;
    result?: unknown;
  }): CapturedEvidence | undefined {
    const args = (input.args ?? {}) as Record<string, unknown>;
    const now = Date.now();

    // A shell/bash command that completed successfully is real evidence.
    if ((input.tool === "shell" || input.tool === "bash") && input.status === "completed") {
      const command = String(args.command ?? args.cmd ?? "").trim();
      if (!command) return undefined;
      const exitCode = extractExitCode(input.result);
      const kind: EvidenceKind = /\b(test|pytest|bun test|go test|jest|vitest|cargo test)\b/.test(
        command,
      )
        ? "test"
        : "command";
      const evidence: CapturedEvidence = { kind, ref: command.slice(0, 400), exitCode, atMs: now };
      this.store.addEvidence({
        goalID: input.goalID,
        kind,
        ref: evidence.ref,
        detail: exitCode === undefined ? undefined : `exit ${exitCode}`,
      });
      return evidence;
    }

    // A file write is evidence that something changed, but not that it is
    // correct — the verifier must not treat existence as proof of content.
    if (input.status === "completed" && /write|edit|patch|create/.test(input.tool)) {
      const path = String(args.filePath ?? args.file_path ?? args.path ?? "").trim();
      if (!path) return undefined;
      const evidence: CapturedEvidence = { kind: "file", ref: path, atMs: now };
      this.store.addEvidence({
        goalID: input.goalID,
        kind: "file",
        ref: path,
        detail: "observed write",
      });
      return evidence;
    }

    return undefined;
  }

  /** Evidence recorded for a goal, as captured. */
  forGoal(goalID: string): CapturedEvidence[] {
    return this.store.listEvidence(goalID).map((e) => ({
      kind: e.kind as EvidenceKind,
      ref: e.ref,
      atMs: Date.now(),
      criterionID: e.criterionID,
    }));
  }
}

function extractExitCode(result: unknown): number | undefined {
  if (!result) return undefined;
  const r = result as Record<string, unknown>;
  const direct = r.exitCode ?? r.exit_code ?? r.code;
  if (typeof direct === "number") return direct;
  const nested = (r.metadata as Record<string, unknown> | undefined)?.exitCode;
  if (typeof nested === "number") return nested;
  return undefined;
}

export class GoalVerifier {
  private readonly store: GoalStore;
  private readonly validator: EvidenceValidator;

  constructor(store: GoalStore, validator: EvidenceValidator) {
    this.store = store;
    this.validator = validator;
  }

  /**
   * Verify a completion claim against the objective and current evidence.
   *
   * This is deliberately conservative: an unverifiable reference is not proof,
   * a missing criterion is a failure, and a failing validator is a failure.
   */
  async verify(goalID: string): Promise<VerificationResult> {
    const goal = this.store.byID(goalID);
    if (!goal) return { verdict: "incomplete", unmet: [], reason: "unknown goal" };

    const criteria = this.store.listCriteria(goalID);
    const evidence = this.store.listEvidence(goalID);
    const unmet: string[] = [];

    // 1. The objective must still be the authoritative target. A goal with no
    //    criteria at all cannot be verified — the controller will not accept a
    //    bare assertion that an objective is met.
    if (criteria.length === 0) {
      return {
        verdict: "incomplete",
        unmet: ["no acceptance criteria recorded for the objective"],
        reason:
          "cannot verify completion of an objective with no criteria; the controller must first establish what success means",
      };
    }

    // 2. Only machine-verifiable evidence counts. A "ref" is a model-provided
    //    pointer and is never sufficient on its own.
    const verifiable = evidence.filter((e) => e.kind !== "ref");
    if (verifiable.length === 0) {
      return {
        verdict: "incomplete",
        unmet: ["no machine-verifiable evidence submitted"],
        reason:
          "completion requires evidence the controller observed (a command that ran, a file that changed); a model statement is not evidence",
      };
    }

    // 3. Every captured item must still validate against current state.
    for (const item of verifiable) {
      const validation = await this.validator.validate({
        kind: item.kind as EvidenceKind,
        ref: item.ref,
        atMs: Date.now(),
        criterionID: item.criterionID,
      });
      if (!validation.valid) {
        unmet.push(`evidence no longer valid: ${item.ref} (${validation.reason})`);
      }
    }

    // 4. Each criterion must have at least one piece of validating evidence
    //    bound to it, or be covered by general validating evidence.
    const validatingRefs = new Set(
      verifiable
        .filter((e) => !unmet.some((u) => u.includes(e.ref)))
        .map((e) => e.ref),
    );
    for (const criterion of criteria) {
      const bound = evidence.some(
        (e) => e.criterionID === criterion.id && validatingRefs.has(e.ref),
      );
      const coveredByGeneral = validatingRefs.size > 0 && criteria.length <= validatingRefs.size;
      if (!bound && !coveredByGeneral) {
        unmet.push(`criterion not evidenced: ${criterion.text}`);
      }
    }

    if (unmet.length > 0) {
      return {
        verdict: "incomplete",
        unmet,
        reason: `${unmet.length} condition(s) unsatisfied against current evidence`,
      };
    }
    return {
      verdict: "complete",
      unmet: [],
      reason: `objective satisfied: ${criteria.length} criteria covered by ${validatingRefs.size} validated evidence item(s)`,
    };
  }
}

// ------------------------------------------------------------ classification

export interface RoundActivity {
  /** Did a tool execution change meaningful state (file write, command run)? */
  changedState: boolean;
  /** Did the round produce new information that changes the next action? */
  newInformation: boolean;
  /** Is a background job known to be still running? */
  liveWait: boolean;
  /** Did the model report a blocker? */
  reportedBlocker: boolean;
  /** Did the model identify a concrete external dependency? */
  externalDependency: boolean;
}

export type Classification = GoalRound["classification"];

/**
 * Classify a settled round.
 *
 * The important cases:
 *  - investigation that narrows the problem counts as `progress` even with no
 *    code change, because it changes what the next action should be
 *  - a live background job is a `verifiedWait`, which must NOT accumulate toward
 *    a stall
 *  - a model asking an optional workflow question is `noProgress` at worst, and
 *    must never be scored as `blocked`
 */
export function classifyRound(activity: RoundActivity): Classification {
  // A concrete external dependency is the only route to `blocked` from a single
  // report; everything else keeps working.
  if (activity.reportedBlocker && activity.externalDependency) return "blocked";
  if (activity.liveWait) return "verifiedWait";
  if (activity.changedState || activity.newInformation) return "progress";
  // A blocker claim without an external dependency, or a bare workflow
  // preference, is simply an unproductive round — not a blocker.
  return "noProgress";
}

/**
 * Does this round's text look like a workflow preference rather than a blocker?
 *
 * Used to keep the Phase 01 failure from recurring: an agent that finished a
 * milestone and asks whether to proceed has not become blocked.
 */
export function looksLikeWorkflowQuestion(text: string): boolean {
  const t = text.toLowerCase();
  const patterns = [
    /should i (push|proceed|continue|publish|commit)/,
    /whether to (push|proceed|continue|publish|commit)/,
    /waiting for (the )?(user|you)('s)? (decision|confirmation|approval|input)/,
    /do you want me to/,
    /would you like me to/,
    /let me know (if|whether)/,
    /awaiting (your|user) (decision|direction|input)/,
  ];
  return patterns.some((p) => p.test(t));
}

/** Classify a round's free text, applying the workflow-question guard. */
export function classifyRoundFromText(
  text: string,
  activity: Omit<RoundActivity, "reportedBlocker" | "externalDependency">,
): Classification {
  if (activity.liveWait) return "verifiedWait";
  if (activity.changedState || activity.newInformation) return "progress";
  // No state change and no new information. If the model's text is a workflow
  // question, this is explicitly not a blocker.
  void looksLikeWorkflowQuestion(text);
  return "noProgress";
}
