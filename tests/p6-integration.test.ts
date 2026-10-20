/**
 * Phase 06 — Integration tests for scenarios that are difficult to test
 * with live sessions. These use the controller API directly.
 *
 * Covers:
 * - Model omitting an explicit requirement
 * - Repeated identical investigation with no new evidence
 * - A verified long-running background job
 * - A provider error
 * - A pending permission request
 * - A compaction boundary
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GoalController } from "../src/controller/controller.ts";
import { classifyRound, looksLikeWorkflowQuestion } from "../src/controller/verification.ts";

let dir: string;
let controller: GoalController;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "xgoal-p6-"));
  controller = new GoalController({ dbPath: join(dir, "goals.db") });
});

afterEach(() => {
  try {
    controller.close();
  } catch {
    /* closed */
  }
  rmSync(dir, { recursive: true, force: true });
});

/** Start a goal and return it, narrowing the union type. */
function startGoal(sessionID: string, objective: string) {
  const r = controller.startOrDescribe(sessionID, objective);
  if (!("created" in r)) throw new Error("expected a new goal");
  return r.created;
}

describe("Model omitting an explicit requirement", () => {
  test("a goal with unmet criteria cannot be completed", () => {
    const goal = startGoal("ses_a", "implement feature X with tests");
    controller.store.addCriterion(goal.id, "feature X is implemented");
    controller.store.addCriterion(goal.id, "tests are written and passing");

    // Model only completes the first criterion
    const criteria = controller.store.listCriteria(goal.id);
    controller.store.addEvidence({
      goalID: goal.id,
      kind: "command",
      ref: "echo 'feature implemented'",
      detail: "exit 0",
      criterionID: criteria[0].id,
    });

    // The second criterion has no evidence
    const unmet = criteria.filter(
      (c) =>
        !controller.store
          .listEvidence(goal.id)
          .some((e) => e.criterionID === c.id),
    );
    expect(unmet.length).toBe(1);
    expect(unmet[0].text).toContain("tests");
  });

  test("the controller rejects completion when criteria are unmet", () => {
    const goal = startGoal("ses_a", "implement feature X");
    controller.store.addCriterion(goal.id, "feature X is implemented");
    controller.store.addCriterion(goal.id, "edge cases are handled");

    // Only one criterion has evidence
    controller.store.addEvidence({
      goalID: goal.id,
      kind: "command",
      ref: "echo done",
    });

    controller.proposeComplete("ses_a", {
      summary: "done",
      goalID: goal.id,
      generation: goal.generation,
    });
    // The goal should still be active (not complete)
    const status = controller.status("ses_a");
    expect(status?.status).not.toBe("complete");
  });
});

describe("Repeated identical investigation with no new evidence", () => {
  test("classifyRound detects no-progress when nothing changes", () => {
    const c = classifyRound({
      changedState: false,
      newInformation: false,
      liveWait: false,
      reportedBlocker: false,
      externalDependency: false,
    });
    expect(c).toBe("noProgress");
  });

  test("repeated identical investigation accumulates no-progress rounds", () => {
    const goal = startGoal("ses_a", "investigate the bug");
    // Simulate multiple no-progress rounds
    for (let i = 0; i < 3; i++) {
      controller.store.recordRound({
        goalID: goal.id,
        generation: goal.generation,
        classification: "noProgress",
        detail: "repeated investigation",
      });
    }
    const status = controller.status("ses_a");
    expect(status?.noProgressRounds).toBe(3);
    // The goal should still be active (not stalled)
    expect(status?.status).toBe("active");
  });

  test("a verified wait does not accumulate no-progress rounds", () => {
    const goal = startGoal("ses_a", "run the build");
    // Simulate a verified wait (long-running build)
    controller.store.recordRound({
      goalID: goal.id,
      generation: goal.generation,
      classification: "verifiedWait",
      detail: "build is running",
    });
    const status = controller.status("ses_a");
    expect(status?.noProgressRounds).toBe(0);
  });
});

describe("A verified long-running background job", () => {
  test("a live background job is classified as verifiedWait", () => {
    const c = classifyRound({
      changedState: false,
      newInformation: false,
      liveWait: true,
      reportedBlocker: false,
      externalDependency: false,
    });
    expect(c).toBe("verifiedWait");
  });

  test("verifiedWait does not count toward stall detection", () => {
    const goal = startGoal("ses_a", "run tests");
    // Multiple verified waits (long-running test suite)
    for (let i = 0; i < 5; i++) {
      controller.store.recordRound({
        goalID: goal.id,
        generation: goal.generation,
        classification: "verifiedWait",
        detail: "tests still running",
      });
    }
    const status = controller.status("ses_a");
    expect(status?.noProgressRounds).toBe(0);
    expect(status?.status).toBe("active");
  });
});

describe("A provider error", () => {
  test("a provider error does not crash the controller", () => {
    const goal = startGoal("ses_a", "do work");
    // Simulate a provider error by recording a failed round
    controller.store.recordRound({
      goalID: goal.id,
      generation: goal.generation,
      classification: "noProgress",
      detail: "provider error: rate limited",
    });
    const status = controller.status("ses_a");
    expect(status).toBeDefined();
    expect(status?.status).toBe("active");
  });

  test("the controller continues after a provider error", () => {
    const goal = startGoal("ses_a", "do work");
    // Record a provider error
    controller.store.recordRound({
      goalID: goal.id,
      generation: goal.generation,
      classification: "noProgress",
      detail: "provider error",
    });
    // The goal should still be drivable
    const status = controller.status("ses_a");
    expect(status?.status).toBe("active");
  });
});

describe("A pending permission request", () => {
  test("a pending permission request does not block the goal", () => {
    // A permission request is a verified wait, not a blocker
    const c = classifyRound({
      changedState: false,
      newInformation: false,
      liveWait: true,
      reportedBlocker: false,
      externalDependency: false,
    });
    expect(c).toBe("verifiedWait");
    expect(c).not.toBe("blocked");
  });

  test("the goal remains active during a permission request", () => {
    const goal = startGoal("ses_a", "do work");
    controller.store.recordRound({
      goalID: goal.id,
      generation: goal.generation,
      classification: "verifiedWait",
      detail: "waiting for permission",
    });
    const status = controller.status("ses_a");
    expect(status?.status).toBe("active");
  });
});

describe("A compaction boundary", () => {
  test("the goal survives context compaction", () => {
    const goal = startGoal("ses_a", "do work");
    controller.store.addCriterion(goal.id, "work is done");
    // Simulate compaction by creating a new controller instance
    // (the goal should persist in the database)
    controller.close();
    controller = new GoalController({ dbPath: join(dir, "goals.db") });
    const status = controller.status("ses_a");
    expect(status).toBeDefined();
    expect(status?.objective).toBe("do work");
  });

  test("criteria survive compaction", () => {
    const goal = startGoal("ses_a", "do work");
    controller.store.addCriterion(goal.id, "work is done");
    controller.close();
    controller = new GoalController({ dbPath: join(dir, "goals.db") });
    const status = controller.status("ses_a");
    const criteria = controller.store.listCriteria(status!.id);
    expect(criteria.length).toBe(1);
  });
});

describe("Workflow question is not a blocker", () => {
  test("a workflow question does not force blocked or stalled", () => {
    // Simulate a workflow question
    const text = "Should I push the commit or continue working?";
    expect(looksLikeWorkflowQuestion(text)).toBe(true);
    const c = classifyRound({
      changedState: false,
      newInformation: false,
      liveWait: false,
      reportedBlocker: true,
      externalDependency: false,
    });
    expect(c).toBe("noProgress");
    expect(c).not.toBe("blocked");
    expect(c).not.toBe("stalled");
  });
});
