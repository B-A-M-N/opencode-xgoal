/**
 * Phase 04 — completion verification and progress classification.
 *
 * The gate: incomplete goals must remain active when actionable work exists,
 * and completed goals must stop only after verification.
 *
 * Includes the required regression for the Phase 01 scenario, where the legacy
 * plugin declared a goal unachievable because the agent asked whether to publish
 * a checkpoint or continue.
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GoalStore } from "../src/controller/store.ts";
import {
  EvidenceLedger,
  GoalVerifier,
  classifyRound,
  classifyRoundFromText,
  looksLikeWorkflowQuestion,
  type EvidenceValidator,
} from "../src/controller/verification.ts";
import { GoalController } from "../src/controller/controller.ts";

let dir: string;
let store: GoalStore;
let controller: GoalController;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "xgoal-ver-"));
  store = new GoalStore(join(dir, "goals.db"));
  controller = new GoalController({ dbPath: join(dir, "goals.db") });
});

afterEach(() => {
  try {
    store.close();
  } catch {
    /* closed */
  }
  try {
    controller.close();
  } catch {
    /* closed */
  }
  rmSync(dir, { recursive: true, force: true });
});

/** A validator whose verdict each test can steer. */
function validator(valid = true, reason = "ok"): EvidenceValidator {
  return { validate: async () => ({ valid, reason }) };
}

/** The current goal's fencing reference, as a model tool call must supply. */
function ref(sessionID = "ses_a"): { goalID: string; generation: number } {
  const goal = controller.status(sessionID);
  if (!goal) throw new Error(`no current goal for ${sessionID}`);
  return { goalID: goal.id, generation: goal.generation };
}

describe("completion requires objective-level evidence", () => {
  test("an objective with no criteria cannot be verified complete", async () => {
    const goal = store.create({ sessionID: "ses_a", objective: "fix everything" });
    const verifier = new GoalVerifier(store, validator());
    const result = await verifier.verify(goal.id);
    expect(result.verdict).toBe("incomplete");
    expect(result.unmet[0]).toContain("no acceptance criteria");
  });

  test("a model's assertion with no captured evidence is not proof", async () => {
    const goal = store.create({ sessionID: "ses_a", objective: "fix everything" });
    store.addCriterion(goal.id, "the regression is fixed");
    // The model submits only an unverifiable reference.
    store.addEvidence({ goalID: goal.id, kind: "ref", ref: "I checked it, it works" });

    const verifier = new GoalVerifier(store, validator());
    const result = await verifier.verify(goal.id);
    expect(result.verdict).toBe("incomplete");
    expect(result.unmet[0]).toContain("no machine-verifiable evidence");
  });

  test("a passing test suite alone does not complete an unevidenced criterion", async () => {
    const goal = store.create({ sessionID: "ses_a", objective: "fix all bugs in the subsystem" });
    store.addCriterion(goal.id, "bug one fixed");
    store.addCriterion(goal.id, "bug two fixed");
    // One test command ran, but it evidences neither specific bug.
    store.addEvidence({ goalID: goal.id, kind: "test", ref: "bun test", detail: "exit 0" });

    const verifier = new GoalVerifier(store, validator());
    const result = await verifier.verify(goal.id);
    expect(result.verdict).toBe("incomplete");
    expect(result.unmet.some((u) => u.includes("criterion not evidenced"))).toBe(true);
  });

  test("evidence that no longer validates blocks completion", async () => {
    const goal = store.create({ sessionID: "ses_a", objective: "x" });
    const criterionID = store.addCriterion(goal.id, "the file exists");
    // Only bound evidence is load-bearing; bind it so the stale check applies.
    store.addEvidence({
      goalID: goal.id,
      criterionID,
      kind: "file",
      ref: "src/thing.ts",
    });

    const stale = new GoalVerifier(store, validator(false, "file no longer present"));
    const result = await stale.verify(goal.id);
    expect(result.verdict).toBe("incomplete");
    expect(result.unmet.some((u) => u.includes("no longer valid"))).toBe(true);
  });

  test("criteria covered by validating evidence verify complete", async () => {
    const goal = store.create({ sessionID: "ses_a", objective: "x" });
    const criterionID = store.addCriterion(goal.id, "the regression is fixed");
    // Evidence must be bound to the criterion it proves, and must record a
    // successful exit status.
    store.addEvidence({
      goalID: goal.id,
      criterionID,
      kind: "test",
      ref: "bun test",
      detail: "exit 0",
      exitCode: 0,
    });

    const verifier = new GoalVerifier(store, validator());
    const result = await verifier.verify(goal.id);
    expect(result.verdict).toBe("complete");
    expect(result.unmet).toHaveLength(0);
    // The criterion readout must agree with the proof that was just recorded.
    expect(store.listCriteria(goal.id)[0].met).toBe(true);
  });

  // Audit defect 4: an unrelated successful command must not satisfy a
  // criterion about something else.
  test("an unrelated successful command cannot satisfy a criterion", async () => {
    const goal = store.create({ sessionID: "ses_a", objective: "x" });
    const criterionID = store.addCriterion(goal.id, "config.yaml contains retries: 3");
    // A perfectly successful command that proves nothing about the criterion.
    store.addEvidence({
      goalID: goal.id,
      kind: "command",
      ref: "pwd",
      detail: "exit 0",
      exitCode: 0,
    });

    const verifier = new GoalVerifier(store, validator());
    const result = await verifier.verify(goal.id);
    expect(result.verdict).toBe("incomplete");
    expect(result.unmet.some((u) => u.includes("criterion not evidenced"))).toBe(true);
    // The criterion was never bound, so its id is unused.
    expect(criterionID).toBeTruthy();
  });

  // Audit defect 4: a relative file path belongs to the session's workspace,
  // not to whatever cwd the plugin host happens to have.
  test("relative file checks resolve against the session workspace", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "xgoal-workspace-"));
    try {
      writeFileSync(join(workspace, "notes.txt"), "ok\n");
      const goal = store.create({ sessionID: "ses_ws", objective: "write notes.txt" });
      const criterionID = store.addCriterion(goal.id, "notes.txt contains ok", {
        type: "file",
        path: "notes.txt",
        contains: "ok",
      });
      store.addEvidence({
        goalID: goal.id,
        criterionID,
        kind: "file",
        ref: "notes.txt",
      });

      const seen: string[] = [];
      const verifier = new GoalVerifier(store, {
        workspaceFor: async (sessionID) => {
          expect(sessionID).toBe("ses_ws");
          return workspace;
        },
        validate: async (_evidence, sessionWorkspace) => {
          seen.push(`validate:${sessionWorkspace}`);
          return { valid: true, reason: "file present" };
        },
        checkSpec: async (_criterion, sessionWorkspace) => {
          seen.push(`checkSpec:${sessionWorkspace}`);
          return { valid: true, reason: "content matches" };
        },
      });

      const result = await verifier.verify(goal.id);
      expect(result.verdict).toBe("complete");
      expect(seen).toContain(`checkSpec:${workspace}`);
      // The spec check alone carried the proof, so the bound evidence was
      // never consulted for this criterion.
      expect(seen).not.toContain(`validate:${workspace}`);
      // A spec-driven pass carries no evidence ids: the filesystem, not a
      // captured write, established the content.
      expect(result.proofs?.find((p) => p.validatorID === "spec.file")?.evidenceIDs).toEqual([]);

      // When the independent check definitively fails, a bound file capture
      // cannot override it — but the stale-evidence annotation still receives
      // the session workspace, and the failure names the spec's reason.
      seen.length = 0;
      const goal2 = store.create({ sessionID: "ses_ws2", objective: "write notes.txt" });
      store.addCriterion(goal2.id, "notes.txt contains ok", {
        type: "file",
        path: "notes.txt",
        contains: "ok",
      });
      store.addEvidence({
        goalID: goal2.id,
        criterionID: store.listCriteria(goal2.id)[0].id,
        kind: "file",
        ref: "notes.txt",
      });
      const failing = new GoalVerifier(store, {
        workspaceFor: async () => workspace,
        validate: async (_evidence, sessionWorkspace) => {
          seen.push(`validate:${sessionWorkspace}`);
          return { valid: true, reason: "file present" };
        },
        checkSpec: async () => ({ valid: false, reason: "content does not match the spec" }),
      });
      const result2 = await failing.verify(goal2.id);
      expect(result2.verdict).toBe("incomplete");
      expect(seen).toContain(`validate:${workspace}`);
      expect(result2.unmet.some((u) => u.includes("content does not match the spec"))).toBe(true);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});

describe("evidence capture is machine-observed", () => {
  test("a completed shell command is captured as evidence", () => {
    const goal = store.create({ sessionID: "ses_a", objective: "x" });
    const ledger = new EvidenceLedger(store);
    const captured = ledger.capture({
      goalID: goal.id,
      tool: "shell",
      status: "completed",
      args: { command: "bun test" },
      result: { exitCode: 0 },
    });
    expect(captured?.kind).toBe("test");
    expect(captured?.exitCode).toBe(0);
    expect(store.listEvidence(goal.id)).toHaveLength(1);
  });

  test("a failed command is not captured as success evidence", () => {
    const goal = store.create({ sessionID: "ses_a", objective: "x" });
    const ledger = new EvidenceLedger(store);
    const captured = ledger.capture({
      goalID: goal.id,
      tool: "shell",
      status: "error",
      args: { command: "bun test" },
    });
    expect(captured).toBeUndefined();
    expect(store.listEvidence(goal.id)).toHaveLength(0);
  });

  test("a file write is captured, but only as a change, not as correctness", () => {
    const goal = store.create({ sessionID: "ses_a", objective: "x" });
    const ledger = new EvidenceLedger(store);
    const captured = ledger.capture({
      goalID: goal.id,
      tool: "write",
      status: "completed",
      args: { filePath: "src/controller/verification.ts" },
    });
    expect(captured?.kind).toBe("file");
  });
});

describe("progress classification", () => {
  test("investigation that narrows the problem counts as progress", () => {
    // No state changed, but the round produced new information.
    const c = classifyRound({
      changedState: false,
      newInformation: true,
      liveWait: false,
      reportedBlocker: false,
      externalDependency: false,
    });
    expect(c).toBe("progress");
  });

  test("a live background job is a verified wait, not no-progress", () => {
    const c = classifyRound({
      changedState: false,
      newInformation: false,
      liveWait: true,
      reportedBlocker: false,
      externalDependency: false,
    });
    expect(c).toBe("verifiedWait");
  });

  test("a workflow preference is at worst no-progress, never blocked", () => {
    const c = classifyRound({
      changedState: false,
      newInformation: false,
      liveWait: false,
      reportedBlocker: true, // the model claimed it was blocked
      externalDependency: false, // but named no external dependency
    });
    expect(c).toBe("noProgress");
    expect(c).not.toBe("blocked");
  });

  test("only a concrete external dependency yields blocked", () => {
    const c = classifyRound({
      changedState: false,
      newInformation: false,
      liveWait: false,
      reportedBlocker: true,
      externalDependency: true,
    });
    expect(c).toBe("blocked");
  });

  test("workflow questions are recognised as such", () => {
    expect(
      looksLikeWorkflowQuestion(
        "Phase 01 is complete and committed, but waiting for the user's decision on whether to push",
      ),
    ).toBe(true);
    expect(looksLikeWorkflowQuestion("should I proceed to phase 02?")).toBe(true);
    expect(looksLikeWorkflowQuestion("cannot proceed: production API credential is missing")).toBe(
      false,
    );
  });
});

describe("REGRESSION: the Phase 01 false blocker", () => {
  test("a milestone-plus-workflow-question keeps the goal active and working", () => {
    controller.startOrDescribe("ses_a", "produce a working replacement /goal plugin");
    controller.checkpoint("ses_a", { ...ref(), summary: "phase 01 complete and committed" });

    // The exact text the legacy plugin scored as "goal unachievable".
    const text =
      "Phase 01 is complete and committed, but the agent is waiting for the user's decision on whether to push the baseline or continue to Phase 02.";

    // 1. The text is recognised as a workflow preference.
    expect(looksLikeWorkflowQuestion(text)).toBe(true);

    // 2. Classification refuses to call it a blocker.
    const classification = classifyRoundFromText(text, {
      changedState: false,
      newInformation: false,
      liveWait: false,
    });
    expect(classification).toBe("noProgress");
    expect(classification).not.toBe("blocked");

    // 3. A blocker report for it is refused outright.
    const report = controller.reportBlocked("ses_a", { ...ref(), reason: text });
    expect(report.accepted).toBe(false);

    // 4. The goal remains active and drivable.
    const goal = controller.status("ses_a")!;
    expect(goal.status).toBe("active");
    expect(goal.status).not.toBe("blocked");
    expect(goal.status).not.toBe("stalled");
    expect(goal.noProgressRounds).toBe(0);
  });

  test("the objective is not limited to the completed milestone", () => {
    controller.startOrDescribe("ses_a", "produce a fully functional replacement /goal plugin");
    controller.checkpoint("ses_a", { ...ref(), summary: "phase 01 done" });
    // Phase 01 finishing must not complete the objective.
    const goal = controller.status("ses_a")!;
    expect(goal.status).toBe("active");
    expect(goal.objective).toContain("fully functional replacement");
  });
});

describe("completion cannot be self-declared", () => {
  test("propose then verify: only verified evidence completes the goal", async () => {
    const goal = store.create({ sessionID: "ses_a", objective: "x" });
    const criterionID = store.addCriterion(goal.id, "the regression is fixed");
    store.transition({ goalID: goal.id, generation: 1, to: "verifying", actor: "model" });

    const verifier = new GoalVerifier(store, validator());
    const first = await verifier.verify(goal.id);
    expect(first.verdict).toBe("incomplete");

    // The controller rejects and returns it to work.
    const back = store.transition({
      goalID: goal.id,
      generation: 1,
      to: "active",
      actor: "controller",
      reason: first.reason,
    });
    expect(back.status).toBe("active");

    // Evidence arrives and is explicitly bound to the criterion, then
    // verification passes.
    store.addEvidence({ goalID: goal.id, kind: "test", ref: "bun test", detail: "exit 0" });
    const evidence = store.listEvidence(goal.id).find((e) => e.ref === "bun test")!;
    store.bindEvidence(criterionID, [evidence.id]);
    store.transition({ goalID: goal.id, generation: 1, to: "verifying", actor: "model" });
    const second = await verifier.verify(goal.id);
    expect(second.verdict).toBe("complete");
    const done = store.transition({
      goalID: goal.id,
      generation: 1,
      to: "complete",
      actor: "controller",
      reason: second.reason,
    });
    expect(done.status).toBe("complete");
  });
});

// Audit-3 #6: each criterion is evaluated under its own proof contract; a
// global nonempty-evidence demand must not refuse a goal whose criteria have
// other legitimate verification mechanisms.
describe("per-criterion proof contracts", () => {
  test("user acceptance alone resolves a goal whose only criterion is objective-level", async () => {
    const goal = store.create({ sessionID: "ses_a", objective: "explore and summarize" });
    store.addCriterion(goal.id, "achieved: explore and summarize", { type: "objective" });
    // No evidence rows at all — the old verifier refused here with
    // "no machine-verifiable evidence submitted" before even looking.
    controller.acceptObjective("ses_a", "read the summary; good");

    const verifier = new GoalVerifier(store, validator(false, "nothing to validate"));
    const result = await verifier.verify(goal.id);
    expect(result.verdict).toBe("complete");
    expect(result.unmet).toHaveLength(0);
  });

  test("acceptance does not waive an explicit file requirement", async () => {
    const goal = store.create({ sessionID: "ses_a", objective: "explore and write notes" });
    store.addCriterion(goal.id, "achieved: explore and write notes", { type: "objective" });
    store.addCriterion(goal.id, "notes.txt exists", {
      type: "file",
      path: "notes.txt",
    });
    controller.acceptObjective("ses_a");

    const verifier = new GoalVerifier(store, {
      validate: async () => ({ valid: false, reason: "nothing to validate" }),
      checkSpec: async (criterion) =>
        criterion.spec?.type === "file" && existsSync(join(dir, criterion.spec.path))
          ? { valid: true, reason: "exists" }
          : { valid: false, reason: "file not found" },
    });
    const result = await verifier.verify(goal.id);
    expect(result.verdict).toBe("incomplete");
    expect(result.unmet.some((u) => u.includes("notes.txt"))).toBe(true);
  });

  test("unresolved criteria are unknown, never silently satisfied", async () => {
    const goal = store.create({ sessionID: "ses_a", objective: "broad objective" });
    store.addCriterion(goal.id, "achieved: broad objective", { type: "objective" });

    const verifier = new GoalVerifier(store, validator());
    const result = await verifier.verify(goal.id);
    expect(result.verdict).toBe("incomplete");
    const objectiveProof = result.proofs?.find((p) => p.validatorID === "objective-acceptance");
    expect(objectiveProof?.verdict).toBe("unknown");
  });
});

// Audit-3 #7: a criterion passes when a complete, currently-valid proof set
// validates. Older invalid evidence stays in the audit trail without
// defeating an independently valid newer proof; alternatives are evaluated
// separately from dependencies.
describe("valid alternative proofs survive stale history", () => {
  test("two file revisions: stale first-write evidence does not defeat the newer capture", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "xgoal-rev-"));
    try {
      const goal = store.create({ sessionID: "ses_a", objective: "write the report" });
      const criterionID = store.addCriterion(goal.id, "report.md is written", {
        type: "file",
        path: "report.md",
      });
      // First write, then a second write that supersedes it. Evidence hashes
      // captured at write time; the first is stale afterward.
      writeFileSync(join(workspace, "report.md"), "draft");
      store.addEvidence({
        goalID: goal.id,
        criterionID,
        kind: "file",
        ref: "report.md",
        hash: "stale-hash",
      });
      writeFileSync(join(workspace, "report.md"), "final");
      store.addEvidence({
        goalID: goal.id,
        criterionID,
        kind: "file",
        ref: "report.md",
        hash: "final-hash",
      });
      const first = store.listEvidence(goal.id).find((e) => e.hash === "stale-hash")!;
      const second = store.listEvidence(goal.id).find((e) => e.hash === "final-hash")!;
      // The validator confirms only the current content's hash.
      const staleFirst = new GoalVerifier(store, {
        workspaceFor: async () => workspace,
        validate: async (e) =>
          e.hash === "final-hash"
            ? { valid: true, reason: "current" }
            : { valid: false, reason: "file changed since capture" },
      });
      const staleResult = await staleFirst.verify(goal.id);
      expect(staleResult.verdict).toBe("incomplete");
      expect(staleResult.unmet.some((u) => u.includes("cannot be independently checked"))).toBe(true);
      expect(staleResult.staleEvidence?.some((u) => u.includes(first.id))).toBe(true);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("two file revisions: the independent check reads current content and stale history is irrelevant", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "xgoal-rev2-"));
    try {
      const goal = store.create({ sessionID: "ses_a", objective: "write the report" });
      store.addCriterion(goal.id, "report.md says final", {
        type: "file",
        path: "report.md",
        equals: "final",
      });
      // First write captured, then a second write supersedes it.
      writeFileSync(join(workspace, "report.md"), "draft");
      store.addEvidence({
        goalID: goal.id,
        kind: "file",
        ref: "report.md",
        hash: "stale-hash",
      });
      writeFileSync(join(workspace, "report.md"), "final");
      store.addEvidence({
        goalID: goal.id,
        kind: "file",
        ref: "report.md",
        hash: "final-hash",
      });
      // The evidence validator rejects everything: on the spec-driven pass
      // path it must never be consulted, so stale history cannot taint the
      // verdict in either direction.
      const verifier = new GoalVerifier(store, {
        workspaceFor: async () => workspace,
        validate: async () => ({ valid: false, reason: "validator must not be consulted" }),
        checkSpec: async (_criterion, sessionWorkspace) =>
          readFileSync(join(sessionWorkspace, "report.md"), "utf8") === "final"
            ? { valid: true, reason: "content matches the spec" }
            : { valid: false, reason: "content does not match the spec" },
      });
      const result = await verifier.verify(goal.id);
      expect(result.verdict).toBe("complete");
      expect(result.unmet).toHaveLength(0);
      expect(result.staleEvidence).toBeUndefined();
      expect(result.proofs?.find((p) => p.validatorID === "spec.file")?.evidenceIDs).toEqual([]);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("a file spec is proven only by the independent check, never by bound evidence", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "xgoal-spec-"));
    try {
      // The file contains content that does NOT match the equals spec, and
      // the model binds its own write evidence whose hash matches the file.
      // The old fallback accepted this; the spec check must be final.
      writeFileSync(join(workspace, "out.txt"), "success but unfinished");
      const goal = store.create({ sessionID: "ses_a", objective: "write out.txt" });
      const criterionID = store.addCriterion(goal.id, "out.txt must be exactly: success", {
        type: "file",
        path: "out.txt",
        equals: "success",
      });
      store.addEvidence({
        goalID: goal.id,
        criterionID,
        kind: "file",
        ref: "out.txt",
        hash: "hash-of-nonconforming-content",
      });
      // An unrelated successful command bound to the same criterion must not
      // rescue it either.
      store.addEvidence({
        goalID: goal.id,
        criterionID,
        kind: "command",
        ref: "echo ok",
        detail: "exit 0",
        exitCode: 0,
      });
      const verifier = new GoalVerifier(store, {
        workspaceFor: async () => workspace,
        validate: async () => ({ valid: true, reason: "valid" }),
        checkSpec: async (_criterion, sessionWorkspace) => {
          const content = readFileSync(join(sessionWorkspace, "out.txt"), "utf8");
          return content === "success"
            ? { valid: true, reason: "matches" }
            : { valid: false, reason: "extra bytes after the required content" };
        },
      });
      const result = await verifier.verify(goal.id);
      expect(result.verdict).toBe("incomplete");
      expect(result.unmet.some((u) => u.includes("extra bytes"))).toBe(true);
      // The failing proof is not dressed up as a pass by valid bound evidence.
      expect(result.proofs?.find((p) => p.criterionID === criterionID)?.verdict).toBe("fail");

      // The mirror case: an unrelated successful command cannot rescue a
      // deleted file whose criterion carries only that command evidence.
      rmSync(join(workspace, "out.txt"));
      const goal2 = store.create({ sessionID: "ses_b", objective: "write out.txt" });
      const criterion2 = store.addCriterion(goal2.id, "out.txt exists", {
        type: "file",
        path: "out.txt",
      });
      store.addEvidence({
        goalID: goal2.id,
        criterionID: criterion2,
        kind: "command",
        ref: "echo ok",
        detail: "exit 0",
        exitCode: 0,
      });
      const rescued = new GoalVerifier(store, {
        workspaceFor: async () => workspace,
        validate: async () => ({ valid: true, reason: "valid" }),
        checkSpec: async () => ({ valid: false, reason: "file not found: out.txt" }),
      });
      const result2 = await rescued.verify(goal2.id);
      expect(result2.verdict).toBe("incomplete");
      expect(result2.unmet.some((u) => u.includes("file not found"))).toBe(true);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("repeated passing tests and a failed-then-fixed run both prove the criterion", async () => {
    const goal = store.create({ sessionID: "ses_a", objective: "fix the bug" });
    const criterionID = store.addCriterion(goal.id, "the regression is fixed", {
      type: "test",
      command: "bun test",
    });
    store.addEvidence({
      goalID: goal.id,
      criterionID,
      kind: "test",
      ref: "bun test",
      detail: "exit 1",
      exitCode: 1,
    });
    store.addEvidence({
      goalID: goal.id,
      criterionID,
      kind: "test",
      ref: "bun test",
      detail: "exit 0",
      exitCode: 0,
    });
    store.addEvidence({
      goalID: goal.id,
      criterionID,
      kind: "test",
      ref: "bun test",
      detail: "exit 0 (repeat run)",
      exitCode: 0,
    });

    const verifier = new GoalVerifier(store, validator());
    const result = await verifier.verify(goal.id);
    expect(result.verdict).toBe("complete");
    // Only the passing runs carry the proof; the failed run is history.
    const proof = result.proofs?.find((p) => p.criterionID === criterionID);
    expect(proof?.verdict).toBe("pass");
    const failedRun = store.listEvidence(goal.id).find((e) => e.exitCode === 1)!;
    expect(proof?.evidenceIDs).toHaveLength(2);
    expect(proof?.evidenceIDs).not.toContain(failedRun.id);
  });

  test("a genuinely required dependency whose evidence goes stale keeps the criterion unmet", async () => {
    const goal = store.create({ sessionID: "ses_a", objective: "deploy with the token" });
    const criterionID = store.addCriterion(goal.id, "the deploy token is verified");
    store.addEvidence({
      goalID: goal.id,
      criterionID,
      kind: "command",
      ref: "deployctl whoami",
      detail: "exit 0",
      exitCode: 0,
    });
    // Single proof set: its only member went stale, so the criterion fails.
    const verifier = new GoalVerifier(store, validator(false, "token expired"));
    const result = await verifier.verify(goal.id);
    expect(result.verdict).toBe("incomplete");
    expect(result.unmet.some((u) => u.includes("no longer valid"))).toBe(true);
  });
});

// Audit-3 #10: a verifier that ran before a replacement must not mutate the
// superseded goal's proof records or criterion readouts.
describe("verification attempts are fenced against replacement", () => {
  test("a stale verifier discards its proofs when the goal is replaced mid-verify", async () => {
    const goal = store.create({ sessionID: "ses_a", objective: "v1 objective" });
    const criterionID = store.addCriterion(goal.id, "the regression is fixed", undefined, "user");
    store.addEvidence({
      goalID: goal.id,
      criterionID,
      kind: "test",
      ref: "bun test",
      detail: "exit 0",
      exitCode: 0,
    });
    store.transition({
      goalID: goal.id,
      generation: goal.generation,
      to: "verifying",
      actor: "model",
      reason: "proposing",
    });

    // The validator is delayed; the goal is replaced while it runs.
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const verifier = new GoalVerifier(store, {
      validate: async () => {
        await gate;
        return { valid: true, reason: "ok" };
      },
    });
    const pending = verifier.verify(goal.id);

    store.replace({
      sessionID: "ses_a",
      expectedGeneration: goal.generation,
      objective: "v2 objective",
    });
    release();
    const result = await pending;

    expect(result.verdict).toBe("incomplete");
    expect(result.unmet.some((u) => u.includes("verification discarded"))).toBe(true);
    // The superseded goal's records are untouched: no proof rows, no met flag.
    expect(store.listProofs(goal.id)).toHaveLength(0);
    expect(store.listCriteria(goal.id).find((c) => c.id === criterionID)!.met).toBe(false);
    // The replacement was not contaminated either.
    const current = store.current("ses_a")!;
    expect(current.generation).toBe(goal.generation + 1);
    expect(store.listProofs(current.id)).toHaveLength(0);
  });
});

// Audit P0-2: the objective-level fallback used to be proven by any bound
// passing test or file change — equally consistent with a partial job. It now
// resolves only through explicit USER acceptance (or decomposition into
// concrete sub-criteria); ordinary evidence can never establish it.
describe("objective-level criteria require user acceptance", () => {
  test("passing evidence cannot prove a broad objective on its own", async () => {
    const goal = store.create({
      sessionID: "ses_a",
      objective: "make the config handling better",
    });
    const criterionID = store.addCriterion(
      goal.id,
      "The requirement is achieved: make the config handling better",
      { type: "objective" },
    );
    // Machine-observed evidence exists — and is even bound to the criterion.
    store.addEvidence({
      goalID: goal.id,
      criterionID,
      kind: "test",
      ref: "bun test",
      detail: "exit 0",
      exitCode: 0,
    });

    const verifier = new GoalVerifier(store, validator());
    const result = await verifier.verify(goal.id);
    expect(result.verdict).toBe("incomplete");
    expect(result.unmet.some((u) => u.includes("criterion unresolved"))).toBe(true);
    // The unmet message must name both real resolution paths.
    expect(result.unmet.some((u) => u.includes("goal_add_criterion"))).toBe(true);
    expect(result.unmet.some((u) => u.includes("/goal accept"))).toBe(true);
    // The criterion was NOT marked met by the passing evidence.
    expect(store.listCriteria(goal.id)[0].met).toBe(false);
  });

  test("explicit user acceptance resolves the objective-level criterion", async () => {
    const goal = store.create({
      sessionID: "ses_a",
      objective: "make the config handling better",
    });
    const criterionID = store.addCriterion(goal.id, "achieved: config handling", {
      type: "objective",
    });
    store.addEvidence({
      goalID: goal.id,
      criterionID,
      kind: "command",
      ref: "bun run lint",
      detail: "exit 0",
      exitCode: 0,
    });

    const verifier = new GoalVerifier(store, validator());
    expect((await verifier.verify(goal.id)).verdict).toBe("incomplete");

    // A USER action, recorded for the current generation of the objective.
    controller.acceptObjective("ses_a", "reviewed the diff; good enough");

    const result = await verifier.verify(goal.id);
    expect(result.verdict).toBe("complete");
    expect(result.unmet).toHaveLength(0);
    expect(store.listCriteria(goal.id)[0].met).toBe(true);
    expect(store.userAcceptance(goal.id)?.note).toBe("reviewed the diff; good enough");
  });

  test("acceptance does not carry over to a replacement objective", async () => {
    const first = store.create({ sessionID: "ses_a", objective: "ship v1" });
    store.addCriterion(first.id, "achieved: ship v1", { type: "objective" });
    store.addEvidence({
      goalID: first.id,
      kind: "command",
      ref: "ls",
      detail: "exit 0",
      exitCode: 0,
    });
    controller.acceptObjective("ses_a");
    const verifier = new GoalVerifier(store, validator());
    expect((await verifier.verify(first.id)).verdict).toBe("complete");

    // Replacing the objective requires accepting the new ask afresh.
    const second = store.replace({
      sessionID: "ses_a",
      expectedGeneration: first.generation,
      objective: "ship v2",
    });
    store.addCriterion(second.id, "achieved: ship v2", { type: "objective" });
    store.addEvidence({
      goalID: second.id,
      kind: "command",
      ref: "ls",
      detail: "exit 0",
      exitCode: 0,
    });

    const result = await verifier.verify(second.id);
    expect(result.verdict).toBe("incomplete");
    expect(result.unmet.some((u) => u.includes("criterion unresolved"))).toBe(true);
    expect(store.userAcceptance(second.id)).toBeUndefined();
  });
});

// Audit-4 #1 (P0): an open-ended engineering objective must be able to reach
// verified completion hands-off, without `/goal accept`, while never completing
// over a known, actionable requirement. Completion is defined operationally:
// every confirmed requirement is independently proven and the objective-level
// remainder is covered by those proofs. `indeterminate` is the honest verdict
// when no bounded scope was ever established.
describe("audited completion policy", () => {
  /** A controller-created goal, so the policy is derived exactly as production does. */
  function auditedGoal(objective: string) {
    const result = controller.startOrDescribe("ses_a", objective);
    if (!("created" in result)) throw new Error("expected a new goal");
    return result.created;
  }

  test("an open-ended repair objective derives the audited policy", () => {
    const goal = auditedGoal("Audit the repository and fix any critical bugs found.");
    expect(goal.completionPolicy).toBe("audited");
  });

  test("a machine-checkable objective derives the machine policy", () => {
    const goal = auditedGoal("Create a file called notes.txt containing exactly: done.");
    expect(goal.completionPolicy).toBe("machine");
  });

  test("no confirmed requirement is indeterminate, never satisfied", async () => {
    const goal = auditedGoal("Audit the repository and fix any critical bugs found.");
    const verifier = new GoalVerifier(store, validator());
    const result = await verifier.verify(goal.id);

    expect(result.verdict).toBe("incomplete");
    expect(result.unmet.some((u) => u.includes("indeterminate"))).toBe(true);
    const assessment = store.objectiveAssessment(goal.id);
    expect(assessment?.verdict).toBe("indeterminate");
    expect(assessment?.unresolvedRequirements.length).toBeGreaterThan(0);
    // The model cannot mark the objective met by asserting it.
    expect(store.listCriteria(goal.id).find((c) => c.spec?.type === "objective")?.met).toBe(false);
  });

  test("confirmed, proven requirements complete the goal without acceptance", async () => {
    const goal = auditedGoal("Audit the repository and fix any critical bugs found.");
    const objectiveID = store.listCriteria(goal.id).find((c) => c.spec?.type === "objective")!.id;

    // The model discovered two concrete requirements during investigation and
    // declared each one as coverage for the objective remainder.
    const bugOne = store.addCriterion(
      goal.id,
      "bug one: the parser drops the last token",
      { type: "test", command: "bun test tests/parser.test.ts" },
      "model",
      [objectiveID],
    );
    const bugTwo = store.addCriterion(
      goal.id,
      "bug two: the writer truncates large files",
      { type: "file", path: "tests/writer.test.ts" },
      "model",
      [objectiveID],
    );
    store.addEvidence({
      goalID: goal.id,
      criterionID: bugOne,
      kind: "test",
      ref: "bun test tests/parser.test.ts",
      detail: "exit 0",
      exitCode: 0,
    });

    const verifier = new GoalVerifier(store, {
      validate: async () => ({ valid: true, reason: "still present" }),
      checkSpec: async () => ({ valid: true, reason: "regression test present" }),
    });
    const result = await verifier.verify(goal.id);

    // Hands-off: no user acceptance row exists.
    expect(store.userAcceptance(goal.id)).toBeUndefined();
    expect(result.verdict).toBe("complete");
    expect(result.unmet).toHaveLength(0);
    const assessment = store.objectiveAssessment(goal.id);
    expect(assessment?.verdict).toBe("satisfied");
    expect(assessment?.unresolvedRequirements).toEqual([]);
    expect(assessment?.coveredRequirements.length).toBe(2);
    expect(assessment?.generation).toBe(goal.generation);
    // The objective proof came from the audit, not from acceptance.
    expect(result.proofs?.find((p) => p.criterionID === objectiveID)?.validatorID).toBe(
      "objective-audit",
    );
    expect(store.listCriteria(goal.id).find((c) => c.id === objectiveID)?.met).toBe(true);
  });

  test("a known, actionable defect keeps an audited goal incomplete", async () => {
    const goal = auditedGoal("Audit the repository and fix any critical bugs found.");
    const objectiveID = store.listCriteria(goal.id).find((c) => c.spec?.type === "objective")!.id;
    store.addCriterion(
      goal.id,
      "bug one: the parser drops the last token",
      { type: "test", command: "bun test tests/parser.test.ts" },
      "model",
      [objectiveID],
    );
    // The defect was discovered but never fixed: no passing run exists.
    store.addEvidence({
      goalID: goal.id,
      kind: "test",
      ref: "bun test tests/parser.test.ts",
      detail: "exit 1",
      exitCode: 1,
    });

    const verifier = new GoalVerifier(store, validator());
    const result = await verifier.verify(goal.id);

    expect(result.verdict).toBe("incomplete");
    expect(result.unmet.some((u) => u.includes("parser drops the last token"))).toBe(true);
    const assessment = store.objectiveAssessment(goal.id);
    expect(assessment?.verdict).toBe("incomplete");
    expect(assessment?.unresolvedRequirements.some((r) => r.includes("parser"))).toBe(true);
  });

  test("a superseded objective cannot reuse the previous generation's assessment", async () => {
    const first = auditedGoal("Audit the repository and fix any critical bugs found.");
    const firstObjective = store.listCriteria(first.id).find((c) => c.spec?.type === "objective")!.id;
    store.addCriterion(
      first.id,
      "the only bug",
      { type: "file", path: "fixed.txt" },
      "model",
      [firstObjective],
    );
    const verifier = new GoalVerifier(store, {
      validate: async () => ({ valid: true, reason: "present" }),
      checkSpec: async () => ({ valid: true, reason: "present" }),
    });
    expect((await verifier.verify(first.id)).verdict).toBe("complete");
    expect(store.objectiveAssessment(first.id)?.verdict).toBe("satisfied");

    const second = controller.replace("ses_a", "Audit the module and fix any critical bugs found.");
    expect(second.generation).toBe(first.generation + 1);
    const result = await verifier.verify(second.id);
    expect(result.verdict).toBe("incomplete");
    expect(store.objectiveAssessment(second.id)?.generation).toBe(second.generation);
    expect(store.objectiveAssessment(second.id)?.verdict).toBe("indeterminate");
  });

  test("repeated objective additions cannot be covered by a criterion the model added to itself", () => {
    const goal = auditedGoal("Audit the repository and fix any critical bugs found.");
    const objectiveID = store.listCriteria(goal.id).find((c) => c.spec?.type === "objective")!.id;
    // Coverage may only name an objective-level requirement, never a concrete
    // row the model just created.
    const concrete = store.addCriterion(goal.id, "the only bug", { type: "file", path: "a.txt" }, "model");
    expect(() =>
      store.addCriterion(goal.id, "bootstrap", { type: "file", path: "b.txt" }, "model", [concrete]),
    ).toThrow(/not an objective-level requirement/);
    expect(() =>
      store.addCriterion(goal.id, "unknown", { type: "file", path: "c.txt" }, "model", ["crit_missing"]),
    ).toThrow(/unknown criterion/);
    expect(objectiveID).toBeTruthy();
  });
});

// Audit P2: a completion commit must be rejected when the criteria or
// evidence changed AFTER the verification decision — the verdict describes a
// world that no longer exists, so freshness is recomputed, not trusted.
describe("completion commits only the snapshot that was verified", () => {
  test("a stale verification cannot complete a goal whose evidence changed", async () => {
    const goal = store.create({ sessionID: "ses_a", objective: "ship v1" });
    const criterionID = store.addCriterion(goal.id, "the regression is fixed");
    store.addEvidence({
      goalID: goal.id,
      criterionID,
      kind: "test",
      ref: "bun test",
      detail: "exit 0",
      exitCode: 0,
    });
    store.transition({
      goalID: goal.id,
      generation: goal.generation,
      to: "verifying",
      actor: "model",
      reason: "model proposed completion",
    });

    const verifier = new GoalVerifier(store, validator());
    const result = await verifier.verify(goal.id);
    expect(result.verdict).toBe("complete");

    // The world changes after the decision: a new requirement appears.
    store.addCriterion(goal.id, "the docs mention the flag");

    // The old decision must not commit.
    expect(() =>
      controller.commitComplete(goal.id, goal.generation, result.reason, result.snapshot),
    ).toThrow(/stale/i);
    expect(store.byID(goal.id)!.status).toBe("verifying");

    // Re-verification sees the changed world and stays honest.
    const second = await verifier.verify(goal.id);
    expect(second.verdict).toBe("incomplete");

    // Satisfy the new requirement, re-verify, and the commit goes through.
    const docCriterion = store
      .listCriteria(goal.id)
      .find((c) => c.text === "the docs mention the flag")!;
    store.addEvidence({
      goalID: goal.id,
      criterionID: docCriterion.id,
      kind: "command",
      ref: "grep flag docs.md",
      detail: "exit 0",
      exitCode: 0,
    });
    const third = await verifier.verify(goal.id);
    expect(third.verdict).toBe("complete");
    const done = controller.commitComplete(goal.id, goal.generation, third.reason, third.snapshot);
    expect(done.status).toBe("complete");
  });

  test("removing a requirement also invalidates the old decision", async () => {
    const goal = store.create({ sessionID: "ses_a", objective: "ship v2" });
    const satisfiable = store.addCriterion(goal.id, "the suite is green");
    store.addEvidence({
      goalID: goal.id,
      criterionID: satisfiable,
      kind: "test",
      ref: "bun test",
      detail: "exit 0",
      exitCode: 0,
    });
    // A requirement that will be retired during investigation.
    const doomed = store.addCriterion(
      goal.id,
      "config.yaml contains retries: 3",
      { type: "file", path: "config.yaml", contains: "retries: 3" },
      "derived",
    );
    store.transition({
      goalID: goal.id,
      generation: goal.generation,
      to: "verifying",
      actor: "model",
      reason: "model proposed completion",
    });

    const verifier = new GoalVerifier(store, validator());
    const first = await verifier.verify(goal.id);
    expect(first.verdict).toBe("incomplete");

    // The requirement is superseded: fewer criteria than the verdict checked.
    store.supersedeCriterion(doomed, "requirement dropped during investigation");

    expect(() =>
      controller.commitComplete(goal.id, goal.generation, first.reason, first.snapshot),
    ).toThrow(/stale/i);

    const second = await verifier.verify(goal.id);
    expect(second.verdict).toBe("complete");
    const done = controller.commitComplete(goal.id, goal.generation, second.reason, second.snapshot);
    expect(done.status).toBe("complete");
  });
});

// Audit-3 #2: a command criterion must verify the command that ran, not just
// that something bound to the criterion exited with the expected status.
describe("command criteria verify the command that ran", () => {
  test("an unrelated successful command cannot satisfy a command criterion", async () => {
    const goal = store.create({ sessionID: "ses_a", objective: "keep the suite green" });
    const criterionID = store.addCriterion(goal.id, "the suite is green", {
      type: "test",
      command: "bun test",
    });
    store.addEvidence({
      goalID: goal.id,
      criterionID,
      kind: "command",
      ref: "echo ok",
      detail: "exit 0",
      exitCode: 0,
    });

    const verifier = new GoalVerifier(store, validator());
    const result = await verifier.verify(goal.id);
    expect(result.verdict).toBe("incomplete");
    expect(result.unmet.some((u) => u.includes("bun test"))).toBe(true);
  });

  test("a run of the required command with the expected exit proves it", async () => {
    const goal = store.create({ sessionID: "ses_a", objective: "keep the suite green" });
    const criterionID = store.addCriterion(goal.id, "the suite is green", {
      type: "test",
      command: "bun test",
    });
    store.addEvidence({
      goalID: goal.id,
      criterionID,
      kind: "test",
      ref: "bun test",
      detail: "exit 0",
      exitCode: 0,
    });

    const verifier = new GoalVerifier(store, validator());
    const result = await verifier.verify(goal.id);
    expect(result.verdict).toBe("complete");
  });

  test("the required command with an unexpected exit does not prove it", async () => {
    const goal = store.create({ sessionID: "ses_a", objective: "keep the suite green" });
    const criterionID = store.addCriterion(goal.id, "the suite is green", {
      type: "test",
      command: "bun test",
    });
    store.addEvidence({
      goalID: goal.id,
      criterionID,
      kind: "test",
      ref: "bun test",
      detail: "exit 1",
      exitCode: 1,
    });

    const verifier = new GoalVerifier(store, validator());
    const result = await verifier.verify(goal.id);
    expect(result.verdict).toBe("incomplete");
  });

  test("command identity is matched under the explicit whitespace policy", async () => {
    const goal = store.create({ sessionID: "ses_a", objective: "lint is clean" });
    const criterionID = store.addCriterion(goal.id, "lint passes", {
      type: "command",
      command: "bun run lint",
    });
    store.addEvidence({
      goalID: goal.id,
      criterionID,
      kind: "command",
      ref: "bun  run\tlint",
      detail: "exit 0",
      exitCode: 0,
    });

    const verifier = new GoalVerifier(store, validator());
    expect((await verifier.verify(goal.id)).verdict).toBe("complete");

    // A different command composition is a different command, however it
    // exited — no shell-string canonicalization.
    const other = store.addCriterion(goal.id, "typed lint passes", {
      type: "command",
      command: "cd src && bun run lint",
    });
    store.addEvidence({
      goalID: goal.id,
      criterionID: other,
      kind: "command",
      ref: "bun run lint",
      detail: "exit 0",
      exitCode: 0,
    });
    expect((await verifier.verify(goal.id)).verdict).toBe("incomplete");
  });
});
