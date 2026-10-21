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
import { normalizedCommand, type CriterionSpec } from "./criteria.ts";
import { existsSync } from "node:fs";
import { snapshotHash } from "./store.ts";
import { hashFile, resolveWorkspacePath, sessionWorkspace } from "./workspace.ts";

export { hashFile, resolveWorkspacePath } from "./workspace.ts";

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
  validate(evidence: CapturedEvidence, workspace: string): Promise<EvidenceValidation>;
  /**
   * Independently check a criterion's machine spec against the world. This is
   * what stops an unrelated successful command from satisfying a requirement
   * about file content: the check does not consult the evidence at all.
   */
  checkSpec?(
    criterion: { text: string; spec?: CriterionSpec },
    workspace: string,
  ): Promise<EvidenceValidation>;
  /**
   * The workspace the session is actually operating in. Relative paths observed
   * from tool calls must resolve there, not against the plugin process's cwd.
   */
  workspaceFor?(sessionID: string): Promise<string | undefined>;
}

export interface VerificationResult {
  verdict: "complete" | "incomplete";
  /** Specific conditions that are not satisfied. */
  unmet: string[];
  reason: string;
  /** Per-criterion proof of how each was (or was not) established. */
  proofs?: CriterionProof[];
  /** Hash of the criteria+evidence snapshot this verification checked. */
  snapshot?: string;
  /**
   * Evidence that no longer validates, annotated per criterion. Stale
   * history never drives the verdict by itself (finding 7): a criterion
   * proven by a currently-valid alternative is complete regardless.
   */
  staleEvidence?: string[];
}

/** Proof that a single criterion was established. */
export interface CriterionProof {
  criterionID: string;
  evidenceIDs: string[];
  validatorID: string;
  verdict: "pass" | "fail" | "unknown";
  detail: string;
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
    workspace?: string;
  }): CapturedEvidence | undefined {
    const args = (input.args ?? {}) as Record<string, unknown>;
    const now = Date.now();
    const workspace = input.workspace ?? sessionWorkspace();

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
        exitCode,
        workspace,
      });
      return evidence;
    }

    // A file write is evidence that something changed, but not that it is
    // correct — the verifier must not treat existence as proof of content.
    if (input.status === "completed" && /write|edit|patch|create/.test(input.tool)) {
      const path = String(args.filePath ?? args.file_path ?? args.path ?? "").trim();
      if (!path) return undefined;
      // Hash what was written so later verification can detect staleness.
      const resolved = resolveWorkspacePath(path, workspace);
      const hash = hashFile(resolved);
      const evidence: CapturedEvidence = { kind: "file", ref: path, hash, atMs: now };
      this.store.addEvidence({
        goalID: input.goalID,
        kind: "file",
        ref: path,
        detail: "observed write",
        hash,
        workspace,
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
      exitCode: e.exitCode,
      hash: e.hash,
      workspace: e.workspace,
      atMs: Date.now(),
      criterionID: e.criterionID,
    }));
  }
}

function extractExitCode(result: unknown): number | undefined {
  if (!result) return undefined;
  const r = result as Record<string, unknown>;
  const asNumber = (value: unknown): number | undefined => {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && /^-?\d+$/.test(value.trim())) return Number(value.trim());
    return undefined;
  };
  const metadata = (r.metadata ?? {}) as Record<string, unknown>;
  for (const candidate of [
    r.exitCode,
    r.exit_code,
    r.code,
    r.exit,
    r.statusCode,
    metadata.exitCode,
    metadata.exit_code,
    metadata.exit,
    metadata.code,
  ]) {
    const n = asNumber(candidate);
    if (n !== undefined) return n;
  }
  // Some tools only surface the status in their textual result.
  const content = r.content;
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .map((part) =>
              typeof part === "string"
                ? part
                : (part as { text?: unknown })?.text ?? "",
            )
            .join("\n")
        : typeof r.output === "string"
          ? r.output
          : "";
  const match = /\bexit(?:\s+code)?\s*[:=]?\s*(-?\d+)\b/i.exec(text);
  return match ? Number(match[1]) : undefined;
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
   * Each criterion is proven one of two ways:
   *  - a machine spec is re-checked against the world, independent of the
   *    evidence the model claims; or
   *  - evidence explicitly bound to the criterion currently validates.
   *
   * There is no "general coverage" fallback: unrelated evidence can never
   * satisfy a criterion.
   */
  async verify(goalID: string): Promise<VerificationResult> {
    const goal = this.store.byID(goalID);
    if (!goal) return { verdict: "incomplete", unmet: [], reason: "unknown goal" };
    // Verification attempt fence: the proofs this run produces describe the
    // goal as it existed at this version. If the goal is replaced, paused, or
    // otherwise transitioned while asynchronous validation is running, the
    // store discards the result instead of letting a stale verifier overwrite
    // the superseded goal's records (finding 10).
    const attempt = { generation: goal.generation, version: goal.version };

    const criteria = this.store.listCriteria(goalID);
    const evidence = this.store.listEvidence(goalID);
    const workspace = (await this.validator.workspaceFor?.(goal.sessionID)) ?? "";
    const unmet: string[] = [];
    const proofs: CriterionProof[] = [];

    // 1. A goal with no criteria cannot be verified: the controller will not
    //    accept a bare assertion that an objective is met.
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
    //
    //    The gate is per criterion, not global: a goal with criteria that have
    //    an independent proof path (a file spec re-checked against the world,
    //    or an objective resolvable by user acceptance) is evaluated
    //    criterion-by-criterion even when nothing was captured — user
    //    acceptance of an otherwise-unresolved objective must not be refused
    //    wholesale for lack of command rows. The early refusal remains for
    //    goals whose criteria all depend on bound evidence.
    const verifiable = evidence.filter((e) => e.kind !== "ref");
    const hasIndependentProofPath = criteria.some(
      (c) => c.spec?.type === "file" || c.spec?.type === "objective",
    );
    if (verifiable.length === 0 && !hasIndependentProofPath) {
      return {
        verdict: "incomplete",
        unmet: ["no machine-verifiable evidence submitted"],
        reason:
          "completion requires evidence the controller observed (a command that ran, a file that changed); a model statement is not evidence",
      };
    }

    // 3. Only evidence bound to a criterion is load-bearing. An exploratory
    //    `ls` that the model happened to run is not a completion claim, and an
    //    unbound command without an exit status must not make the objective
    //    "incomplete" by itself. Validity is judged per criterion inside the
    //    proof loop below (finding 7): stale evidence stays in the audit
    //    trail and can contribute to an unmet annotation, but it can never
    //    defeat an independently valid, newer proof of the same criterion.
    const invalid = new Set<string>();
    const staleNotes: string[] = [];
    const validateItem = async (
      criterion: { id: string; text: string },
      item: (typeof evidence)[number],
    ): Promise<boolean> => {
      const validation = await this.validator.validate(
        {
          kind: item.kind as EvidenceKind,
          ref: item.ref,
          exitCode: item.exitCode,
          hash: item.hash,
          atMs: Date.now(),
          criterionID: item.criterionID,
        },
        workspace,
      );
      if (validation.valid) return true;
      if (!invalid.has(item.id)) {
        invalid.add(item.id);
        staleNotes.push(`evidence no longer valid: ${item.ref} (${item.id}, ${validation.reason})`);
      }
      return false;
    };
    const validBound = (criterion: { id: string }) =>
      verifiable.filter((e) => e.criterionID === criterion.id && !invalid.has(e.id));

    // 4. Prove each criterion under its own contract (finding 6). A
    //    criterion passes when at least one complete proof set validates:
    //    alternatives (independent proof mechanisms) satisfy separately,
    //    never by pooling rows across mechanisms. Invalid historical
    //    evidence is annotated, not disqualifying, when a newer valid proof
    //    exists (finding 7).
    for (const criterion of criteria) {
      let bound = validBound(criterion);

      const proof = async (
        validatorID: string,
        verdict: "pass" | "fail" | "unknown",
        detail: string,
        evidenceIDs = bound.map((e) => e.id),
      ): Promise<CriterionProof> => ({ criterionID: criterion.id, evidenceIDs, validatorID, verdict, detail });

      if (criterion.spec?.type === "file" && this.validator.checkSpec) {
        // Proof alternative 1: the independent machine check — the spec, not
        // the model's claim. Proof alternative 2: bound, currently-valid file
        // evidence (a captured write whose hash still validates).
        const check = await this.validator.checkSpec(criterion, workspace);
        if (check.valid) {
          proofs.push(await proof("spec.file", "pass", check.reason));
          continue;
        }
        // Validate this criterion's own bound evidence before conceding.
        for (const item of verifiable.filter((e) => e.criterionID === criterion.id)) {
          await validateItem(criterion, item);
        }
        bound = validBound(criterion);
        if (bound.length > 0) {
          proofs.push(
            await proof(
              "spec.file",
              "pass",
              `${check.reason}; but ${bound.length} bound file evidence item(s) still validate`,
            ),
          );
          continue;
        }
        proofs.push(await proof("spec.file", "fail", check.reason));
        unmet.push(`criterion not satisfied: ${criterion.text} (${check.reason})`);
        continue;
      }

      if (criterion.spec?.type === "command" || criterion.spec?.type === "test") {
        // A command criterion is proven by a bound run of the required
        // command itself — matched by the explicit normalization policy —
        // that actually exited with the expected status. A successful
        // unrelated command proves nothing about this requirement.
        const expected = criterion.spec.type === "test" ? 0 : (criterion.spec.expectExit ?? 0);
        const required = normalizedCommand(criterion.spec.command);
        // Validate only this criterion's bound runs: invalid history here
        // cannot defeat a newer valid run of the same command.
        for (const item of verifiable.filter(
          (e) => e.criterionID === criterion.id && (e.kind === "command" || e.kind === "test"),
        )) {
          await validateItem(criterion, item);
        }
        bound = validBound(criterion);
        const proofRuns = bound.filter(
          (e) =>
            (e.kind === "command" || e.kind === "test") &&
            e.exitCode === expected &&
            normalizedCommand(e.ref) === required,
        );
        if (proofRuns.length === 0) {
          const ran = bound.filter((e) => e.kind === "command" || e.kind === "test");
          proofs.push(
            await proof(
              "spec.command",
              "fail",
              ran.some((e) => e.exitCode === expected)
                ? `${ran.length} bound run(s) exited ${expected}, but none was the required command`
                : `no bound command/test evidence exited ${expected}`,
            ),
          );
          unmet.push(
            `criterion not evidenced: ${criterion.text} (a run of "${criterion.spec.command}" exiting ${expected} was not observed)`,
          );
        } else {
          proofs.push(
            await proof(
              "spec.command",
              "pass",
              `${proofRuns.length} bound run(s) of the required command exited ${expected}`,
              proofRuns.map((e) => e.id),
            ),
          );
        }
        continue;
      }

      if (criterion.spec?.type === "objective") {
        // An objective-level criterion is the part of the goal that cannot be
        // decomposed into a machine-checkable requirement. Ordinary evidence
        // cannot prove it: a passing test or a real file change is equally
        // consistent with a partial job. It resolves only when the user
        // explicitly accepts this generation of the objective.
        const acceptance = this.store.userAcceptance(goal.id);
        if (acceptance && acceptance.generation === goal.generation) {
          proofs.push(await proof("user-acceptance", "pass", acceptance.note
            ? `user accepted the objective: ${acceptance.note}`
            : "user accepted the objective"));
          continue;
        }
        proofs.push(await proof(
          "objective-acceptance",
          "unknown",
          "broad objective; cannot establish completeness from ordinary evidence — needs concrete sub-criteria or explicit user acceptance",
        ));
        unmet.push(
          `criterion unresolved: ${criterion.text} — register concrete machine-checkable criteria with goal_add_criterion, or ask the user to run /goal accept`,
        );
        continue;
      }

      // No spec: a manual criterion still requires explicitly bound, valid,
      // machine-verifiable evidence. Stale history is annotated but a valid
      // newer item still proves it.
      for (const item of verifiable.filter((e) => e.criterionID === criterion.id)) {
        await validateItem(criterion, item);
      }
      bound = validBound(criterion);
      if (bound.length === 0) {
        proofs.push(await proof("bound-evidence", "fail", "no bound, currently-valid evidence"));
        unmet.push(`criterion not evidenced: ${criterion.text}`);
      } else {
        proofs.push(await proof("bound-evidence", "pass", `${bound.length} bound evidence item(s)`));
      }
    }

    // Stale evidence remains in the audit trail: it annotates why older proof
    // attempts stopped counting, but a criterion proven by an independent,
    // currently-valid alternative is complete regardless (finding 7). It is
    // reported in its own field and only joins `unmet` when the verdict is
    // already incomplete, so the model still sees why older evidence stopped
    // counting.
    const staleEvidence = staleNotes;
    if (unmet.length > 0) {
      // The verdict is already incomplete on real grounds; annotating why
      // older evidence stopped counting helps the model retry correctly.
      unmet.push(...staleEvidence);
    }

    // The snapshot hash is the store's canonical rule (snapshotHash): this
    // verifier records its decision against exactly the rows it read, and
    // completeGoal re-hashes the current rows to reject a stale decision.
    // The attempt fence is checked at commit: a goal superseded mid-verify
    // does not accept this run's proofs; its criterion readouts stay
    // untouched.
    const snapshot = snapshotHash(criteria, evidence);
    const recorded = this.store.recordProofs(goalID, proofs, snapshot, attempt);
    if (!recorded) {
      return {
        verdict: "incomplete",
        unmet: [
          ...unmet,
          "verification discarded: the goal changed state while validation was running",
        ],
        reason:
          "the goal was replaced or transitioned during verification; the proofs described a superseded goal",
        proofs,
        snapshot,
        staleEvidence: staleEvidence.length > 0 ? staleEvidence : undefined,
      };
    }

    if (unmet.length > 0) {
      return {
        verdict: "incomplete",
        unmet,
        reason: `${unmet.length} condition(s) unsatisfied against current evidence`,
        proofs,
        snapshot,
        staleEvidence: staleEvidence.length > 0 ? staleEvidence : undefined,
      };
    }
    return {
      verdict: "complete",
      unmet: [],
      reason:
        verifiable.length === 0
          ? `objective satisfied: ${criteria.length} criteria established by independent checks and user acceptance`
          : `objective satisfied: ${criteria.length} criteria covered by ${verifiable.length} validated evidence item(s)`,
      proofs,
      snapshot,
      staleEvidence: staleEvidence.length > 0 ? staleEvidence : undefined,
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
