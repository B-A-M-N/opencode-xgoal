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
import { mkdtempSync, rmSync } from "node:fs";
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
    store.addCriterion(goal.id, "the file exists");
    store.addEvidence({ goalID: goal.id, kind: "file", ref: "src/thing.ts" });

    const stale = new GoalVerifier(store, validator(false, "file no longer present"));
    const result = await stale.verify(goal.id);
    expect(result.verdict).toBe("incomplete");
    expect(result.unmet.some((u) => u.includes("no longer valid"))).toBe(true);
  });

  test("criteria covered by validating evidence verify complete", async () => {
    const goal = store.create({ sessionID: "ses_a", objective: "x" });
    store.addCriterion(goal.id, "the regression is fixed");
    store.addEvidence({ goalID: goal.id, kind: "test", ref: "bun test", detail: "exit 0" });

    const verifier = new GoalVerifier(store, validator());
    const result = await verifier.verify(goal.id);
    expect(result.verdict).toBe("complete");
    expect(result.unmet).toHaveLength(0);
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
    controller.checkpoint("ses_a", { summary: "phase 01 complete and committed" });

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
    const report = controller.reportBlocked("ses_a", { reason: text });
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
    controller.checkpoint("ses_a", { summary: "phase 01 done" });
    // Phase 01 finishing must not complete the objective.
    const goal = controller.status("ses_a")!;
    expect(goal.status).toBe("active");
    expect(goal.objective).toContain("fully functional replacement");
  });
});

describe("completion cannot be self-declared", () => {
  test("propose then verify: only verified evidence completes the goal", async () => {
    const goal = store.create({ sessionID: "ses_a", objective: "x" });
    store.addCriterion(goal.id, "the regression is fixed");
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

    // Evidence arrives, then verification passes.
    store.addEvidence({ goalID: goal.id, kind: "test", ref: "bun test", detail: "exit 0" });
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
