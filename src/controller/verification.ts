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
import type { CriterionSpec } from "./criteria.ts";
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { isAbsolute, resolve } from "node:path";

/** Resolve a captured path against the session workspace, never the cwd. */
export function resolveWorkspacePath(ref: string, workspace: string): string {
  if (isAbsolute(ref)) return ref;
  const base = workspace && workspace.length > 0 ? workspace : process.cwd();
  return resolve(base, ref);
}

/** The workspace the current session is operating in, if known. */
function sessionWorkspace(): string {
  return String(process.env.XGOAL_WORKSPACE ?? process.env.PWD ?? "");
}

/** Content hash, so file evidence can be checked for staleness. */
export function hashFile(path: string): string {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex").slice(0, 32);
  } catch {
    return "";
  }
}

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
  /**
   * Independently check a criterion's machine spec against the world. This is
   * what stops an unrelated successful command from satisfying a requirement
   * about file content: the check does not consult the evidence at all.
   */
  checkSpec?(criterion: { text: string; spec?: CriterionSpec }): Promise<EvidenceValidation>;
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
}

/** Proof that a single criterion was established. */
export interface CriterionProof {
  criterionID: string;
  evidenceIDs: string[];
  validatorID: string;
  verdict: "pass" | "fail" | "unknown";
  detail: string;
}

/** Evidence kinds that can prove an objective-level criterion. A bare command
 *  is deliberately excluded: `pwd` exits zero but proves nothing. */
const OBJECTIVE_PROOF_KINDS = new Set<EvidenceKind>(["test", "file"]);

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

/** Hash the criteria + evidence snapshot a verification will check. */
function snapshotOf(
  criteria: { id: string; text: string; spec?: CriterionSpec }[],
  evidence: { id: string; kind: string; ref: string; exitCode?: number; hash?: string; criterionID?: string }[],
): string {
  const canonical = JSON.stringify({
    criteria: criteria.map((c) => [c.id, c.text, c.spec ?? null]),
    evidence: evidence.map((e) => [e.id, e.kind, e.ref, e.exitCode ?? null, e.hash ?? null, e.criterionID ?? null]),
  });
  return createHash("sha256").update(canonical).digest("hex").slice(0, 32);
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

    const criteria = this.store.listCriteria(goalID);
    const evidence = this.store.listEvidence(goalID);
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
    const verifiable = evidence.filter((e) => e.kind !== "ref");
    if (verifiable.length === 0) {
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
    //    "incomplete" by itself. Validate what a criterion actually relies on.
    const boundIDs = new Set<string>();
    for (const criterion of criteria) {
      for (const item of verifiable) {
        if (item.criterionID === criterion.id) boundIDs.add(item.id);
      }
    }
    const invalid = new Set<string>();
    for (const item of verifiable) {
      if (!boundIDs.has(item.id)) continue;
      const validation = await this.validator.validate({
        kind: item.kind as EvidenceKind,
        ref: item.ref,
        exitCode: item.exitCode,
        hash: item.hash,
        atMs: Date.now(),
        criterionID: item.criterionID,
      });
      if (!validation.valid) {
        invalid.add(item.id);
        unmet.push(`evidence no longer valid: ${item.ref} (${validation.reason})`);
      }
    }

    // 4. Prove each criterion explicitly.
    for (const criterion of criteria) {
      const bound = evidence.filter(
        (e) => e.criterionID === criterion.id && !invalid.has(e.id) && e.kind !== "ref",
      );
      const evidenceIDs = bound.map((e) => e.id);

      if (criterion.spec?.type === "file" && this.validator.checkSpec) {
        // Independent machine check: the spec, not the model's claim.
        const check = await this.validator.checkSpec(criterion);
        proofs.push({
          criterionID: criterion.id,
          evidenceIDs,
          validatorID: "spec.file",
          verdict: check.valid ? "pass" : "fail",
          detail: check.reason,
        });
        if (!check.valid) unmet.push(`criterion not satisfied: ${criterion.text} (${check.reason})`);
        continue;
      }

      if (criterion.spec?.type === "command" || criterion.spec?.type === "test") {
        // A command criterion is proven by a bound command/test execution that
        // actually exited with the expected status.
        const expected = criterion.spec.type === "test" ? 0 : (criterion.spec.expectExit ?? 0);
        const proof = bound.filter(
          (e) => (e.kind === "command" || e.kind === "test") && e.exitCode === expected,
        );
        if (proof.length === 0) {
          proofs.push({
            criterionID: criterion.id,
            evidenceIDs: [],
            validatorID: "spec.command",
            verdict: "fail",
            detail: `no bound command/test evidence exited ${expected}`,
          });
          unmet.push(
            `criterion not evidenced: ${criterion.text} (no bound command/test exited ${expected})`,
          );
        } else {
          proofs.push({
            criterionID: criterion.id,
            evidenceIDs: proof.map((e) => e.id),
            validatorID: "spec.command",
            verdict: "pass",
            detail: `${proof.length} bound run(s) exited ${expected}`,
          });
        }
        continue;
      }

      if (criterion.spec?.type === "objective") {
        // An objective-level criterion needs explicitly bound evidence of a
        // passing test or a real file change. A bare command is not proof.
        const proof = bound.filter((e) => OBJECTIVE_PROOF_KINDS.has(e.kind as EvidenceKind));
        if (proof.length === 0) {
          proofs.push({
            criterionID: criterion.id,
            evidenceIDs: [],
            validatorID: "objective-evidence",
            verdict: "fail",
            detail: "no bound passing test or file change",
          });
          unmet.push(`criterion not evidenced: ${criterion.text} (no bound passing test or file change)`);
        } else {
          proofs.push({
            criterionID: criterion.id,
            evidenceIDs: proof.map((e) => e.id),
            validatorID: "objective-evidence",
            verdict: "pass",
            detail: `${proof.length} bound test/file evidence item(s)`,
          });
        }
        continue;
      }

      // No spec: a manual criterion still requires explicitly bound, valid,
      // machine-verifiable evidence.
      if (bound.length === 0) {
        proofs.push({
          criterionID: criterion.id,
          evidenceIDs: [],
          validatorID: "bound-evidence",
          verdict: "fail",
          detail: "no bound, currently-valid evidence",
        });
        unmet.push(`criterion not evidenced: ${criterion.text}`);
      } else {
        proofs.push({
          criterionID: criterion.id,
          evidenceIDs,
          validatorID: "bound-evidence",
          verdict: "pass",
          detail: `${bound.length} bound evidence item(s)`,
        });
      }
    }

    const snapshot = snapshotOf(criteria, evidence);
    this.store.recordProofs(goalID, proofs, snapshot);

    if (unmet.length > 0) {
      return {
        verdict: "incomplete",
        unmet,
        reason: `${unmet.length} condition(s) unsatisfied against current evidence`,
        proofs,
        snapshot,
      };
    }
    return {
      verdict: "complete",
      unmet: [],
      reason: `objective satisfied: ${criteria.length} criteria covered by ${verifiable.length} validated evidence item(s)`,
      proofs,
      snapshot,
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
