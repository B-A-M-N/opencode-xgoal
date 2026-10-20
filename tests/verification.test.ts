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
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
      expect(seen).toContain(`validate:${workspace}`);
      expect(seen).toContain(`checkSpec:${workspace}`);
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
