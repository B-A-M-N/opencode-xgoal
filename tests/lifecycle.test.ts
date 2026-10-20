/**
 * Phase 02 — durable goal state and lifecycle.
 *
 * Covers the ten required scenarios plus the five behaviours that must be
 * demonstrated with evidence rather than asserted.
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GoalStore, GoalConflictError, TransitionRejectedError } from "../src/controller/store.ts";
import { canTransition, isNonTerminal } from "../src/controller/state.ts";

let dir: string;
let dbPath: string;
let store: GoalStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "xgoal-"));
  dbPath = join(dir, "goals.db");
  store = new GoalStore(dbPath);
});

afterEach(() => {
  try {
    store.close();
  } catch {
    /* already closed by the test */
  }
  rmSync(dir, { recursive: true, force: true });
});

describe("goal creation", () => {
  test("creates an active goal with generation 1", () => {
    const goal = store.create({ sessionID: "ses_a", objective: "fix the auth regression" });
    expect(goal.status).toBe("active");
    expect(goal.generation).toBe(1);
    expect(goal.version).toBe(0);
    expect(store.current("ses_a")?.id).toBe(goal.id);
  });

  test("rejects an empty objective", () => {
    expect(() => store.create({ sessionID: "ses_a", objective: "   " })).toThrow(
      TransitionRejectedError,
    );
  });

  test("concurrent creation in the same session: exactly one wins", () => {
    // Two independent connections to the same database, as two plugin instances
    // would be. The partial unique index is what makes this safe.
    const other = new GoalStore(dbPath);
    try {
      const first = store.create({ sessionID: "ses_a", objective: "goal one" });
      expect(() => other.create({ sessionID: "ses_a", objective: "goal two" })).toThrow(
        GoalConflictError,
      );
      expect(store.current("ses_a")?.id).toBe(first.id);
      expect(store.history("ses_a")).toHaveLength(1);
    } finally {
      other.close();
    }
  });

  test("two sessions operate independently and cannot contaminate each other", () => {
    const a = store.create({ sessionID: "ses_a", objective: "goal A" });
    const b = store.create({ sessionID: "ses_b", objective: "goal B" });

    expect(a.id).not.toBe(b.id);
    expect(store.current("ses_a")?.objective).toBe("goal A");
    expect(store.current("ses_b")?.objective).toBe("goal B");

    // Mutating A must not touch B.
    store.transition({ goalID: a.id, generation: 1, to: "paused", actor: "user" });
    expect(store.current("ses_a")?.status).toBe("paused");
    expect(store.current("ses_b")?.status).toBe("active");

    // Replacing A must not disturb B.
    const a2 = store.replace({
      sessionID: "ses_a",
      expectedGeneration: 1,
      objective: "goal A v2",
    });
    expect(a2.generation).toBe(2);
    expect(store.current("ses_b")?.id).toBe(b.id);
    expect(store.current("ses_b")?.status).toBe("active");
  });
});

describe("replacement and generation fencing", () => {
  test("replacement supersedes the old goal and bumps the generation", () => {
    const first = store.create({ sessionID: "ses_a", objective: "original" });
    const second = store.replace({
      sessionID: "ses_a",
      expectedGeneration: 1,
      objective: "replacement",
    });

    expect(second.generation).toBe(2);
    expect(second.objective).toBe("replacement");
    expect(second.status).toBe("active");

    const old = store.byID(first.id)!;
    expect(old.status).toBe("superseded");
    expect(old.supersededBy).toBe(second.id);
    expect(store.current("ses_a")?.id).toBe(second.id);
  });

  test("replacement while verification is pending supersedes cleanly", () => {
    const first = store.create({ sessionID: "ses_a", objective: "original" });
    store.transition({
      goalID: first.id,
      generation: 1,
      to: "verifying",
      actor: "model",
      reason: "claims done",
    });
    expect(store.current("ses_a")?.status).toBe("verifying");

    const second = store.replace({
      sessionID: "ses_a",
      expectedGeneration: 1,
      objective: "replacement",
    });
    expect(store.byID(first.id)!.status).toBe("superseded");
    expect(store.current("ses_a")?.id).toBe(second.id);
  });

  test("stale replacement is refused", () => {
    store.create({ sessionID: "ses_a", objective: "one" });
    store.replace({ sessionID: "ses_a", expectedGeneration: 1, objective: "two" });
    expect(() =>
      store.replace({ sessionID: "ses_a", expectedGeneration: 1, objective: "three" }),
    ).toThrow(GoalConflictError);
    expect(store.current("ses_a")?.objective).toBe("two");
  });

  test("a late callback from a superseded generation cannot affect its replacement", () => {
    const first = store.create({ sessionID: "ses_a", objective: "original" });
    const second = store.replace({
      sessionID: "ses_a",
      expectedGeneration: 1,
      objective: "replacement",
    });

    // Every shape of late callback from the old goal/generation.
    const attempts = [
      () => store.transition({ goalID: first.id, generation: 1, to: "active", actor: "controller" }),
      () => store.transition({ goalID: second.id, generation: 1, to: "complete", actor: "controller" }),
      () => store.recordRound({ goalID: first.id, generation: 1, classification: "progress" }),
      () => store.recordRound({ goalID: second.id, generation: 1, classification: "complete" }),
    ];
    for (const attempt of attempts) {
      expect(attempt).toThrow(GoalConflictError);
    }

    // The replacement is untouched and still active.
    const now = store.byID(second.id)!;
    expect(now.status).toBe("active");
    expect(now.generation).toBe(2);
    expect(now.rounds).toBe(0);
  });
});

describe("lifecycle transitions", () => {
  test("invalid transitions are rejected, not coerced", () => {
    const goal = store.create({ sessionID: "ses_a", objective: "x" });
    // active -> complete is not reachable directly; completion must be verified.
    expect(() =>
      store.transition({ goalID: goal.id, generation: 1, to: "complete", actor: "controller" }),
    ).toThrow(TransitionRejectedError);
    expect(store.current("ses_a")?.status).toBe("active");
  });

  test("the model cannot clear a budget limit", () => {
    const goal = store.create({ sessionID: "ses_a", objective: "x", tokenBudget: 10 });
    store.transition({ goalID: goal.id, generation: 1, to: "budgetLimited", actor: "controller" });
    expect(() =>
      store.transition({ goalID: goal.id, generation: 1, to: "active", actor: "model" }),
    ).toThrow(TransitionRejectedError);
    // An explicit user resume is allowed.
    const resumed = store.transition({
      goalID: goal.id,
      generation: 1,
      to: "active",
      actor: "user",
    });
    expect(resumed.status).toBe("active");
  });

  test("completion is only reachable through verification, by the controller", () => {
    const goal = store.create({ sessionID: "ses_a", objective: "x" });
    store.transition({ goalID: goal.id, generation: 1, to: "verifying", actor: "model" });
    // The model may propose but not commit completion.
    expect(() =>
      store.transition({ goalID: goal.id, generation: 1, to: "complete", actor: "model" }),
    ).toThrow(TransitionRejectedError);
    const done = store.transition({
      goalID: goal.id,
      generation: 1,
      to: "complete",
      actor: "controller",
      reason: "all criteria verified against current evidence",
    });
    expect(done.status).toBe("complete");
    expect(done.completedAtMs).toBeDefined();
  });

  test("failed verification returns the goal to active rather than completing it", () => {
    const goal = store.create({ sessionID: "ses_a", objective: "x" });
    store.transition({ goalID: goal.id, generation: 1, to: "verifying", actor: "model" });
    const back = store.transition({
      goalID: goal.id,
      generation: 1,
      to: "active",
      actor: "controller",
      reason: "verification failed: no evidence for criterion 2",
    });
    expect(back.status).toBe("active");
    expect(back.reason).toContain("verification failed");
  });

  test("terminal goals cannot be revived", () => {
    const goal = store.create({ sessionID: "ses_a", objective: "x" });
    store.transition({ goalID: goal.id, generation: 1, to: "verifying", actor: "model" });
    store.transition({ goalID: goal.id, generation: 1, to: "complete", actor: "controller" });
    // Reported as a fencing conflict: the goal is no longer drivable at all,
    // which is a different failure from "that transition is not allowed".
    expect(() =>
      store.transition({ goalID: goal.id, generation: 1, to: "active", actor: "user" }),
    ).toThrow(GoalConflictError);
    expect(store.byID(goal.id)!.status).toBe("complete");
  });

  test("a goal cannot be completed merely because its plan says everything is done", () => {
    const goal = store.create({ sessionID: "ses_a", objective: "fix all bugs in the subsystem" });
    store.addCriterion(goal.id, "bug 1 fixed");
    store.addCriterion(goal.id, "bug 2 fixed");
    store.addCriterion(goal.id, "regression suite passes");

    // The model asserts the plan is complete, with no evidence attached.
    store.transition({ goalID: goal.id, generation: 1, to: "verifying", actor: "model" });

    // Verification must be able to see that criteria carry no evidence, and the
    // store must not treat "criteria exist" as "criteria are satisfied".
    const criteria = store.listCriteria(goal.id);
    expect(criteria).toHaveLength(3);
    expect(criteria.every((c) => !c.met)).toBe(true);
    const evidence = store.listEvidence(goal.id);
    expect(evidence).toHaveLength(0);

    // With no evidence, the controller sends it back to work.
    const back = store.transition({
      goalID: goal.id,
      generation: 1,
      to: "active",
      actor: "controller",
      reason: "verification failed: no evidence submitted",
    });
    expect(back.status).toBe("active");
    expect(back.completedAtMs).toBeUndefined();
  });

  test("a nonblocking workflow choice cannot force blocked or stalled", () => {
    const goal = store.create({ sessionID: "ses_a", objective: "build the replacement" });

    // The model asks "should I push the checkpoint or continue?" — a workflow
    // preference, not a blocker. It must not be able to park the goal.
    store.recordRound({
      goalID: goal.id,
      generation: 1,
      classification: "progress",
      detail: "phase 01 committed; asked whether to publish",
    });

    const after = store.byID(goal.id)!;
    expect(after.status).toBe("active");
    expect(after.noProgressRounds).toBe(0);
    expect(after.repeatedBlockerRounds).toBe(0);
    expect(isNonTerminal(after.status)).toBe(true);
  });
});

describe("round accounting", () => {
  test("counts no-progress rounds and resets on progress", () => {
    const goal = store.create({ sessionID: "ses_a", objective: "x" });
    let g = store.recordRound({ goalID: goal.id, generation: 1, classification: "noProgress" });
    expect(g.noProgressRounds).toBe(1);
    g = store.recordRound({ goalID: goal.id, generation: 1, classification: "noProgress" });
    expect(g.noProgressRounds).toBe(2);
    g = store.recordRound({ goalID: goal.id, generation: 1, classification: "progress" });
    expect(g.noProgressRounds).toBe(0);
    expect(g.rounds).toBe(3);
  });

  test("a verified wait is neither progress nor no-progress", () => {
    const goal = store.create({ sessionID: "ses_a", objective: "x" });
    store.recordRound({ goalID: goal.id, generation: 1, classification: "noProgress" });
    const g = store.recordRound({
      goalID: goal.id,
      generation: 1,
      classification: "verifiedWait",
    });
    // Waiting on a live job must not accumulate toward a stall.
    expect(g.noProgressRounds).toBe(0);
    expect(g.status).toBe("active");
  });

  test("accumulates token usage", () => {
    const goal = store.create({ sessionID: "ses_a", objective: "x", tokenBudget: 1000 });
    store.recordRound({ goalID: goal.id, generation: 1, classification: "progress", tokensUsed: 120 });
    const g = store.recordRound({
      goalID: goal.id,
      generation: 1,
      classification: "progress",
      tokensUsed: 80,
    });
    expect(g.tokensUsed).toBe(200);
    expect(g.tokenBudget).toBe(1000);
  });
});

describe("idempotency and concurrency", () => {
  test("repeated no-op updates are harmless and do not bump the version", () => {
    const goal = store.create({ sessionID: "ses_a", objective: "x" });
    const before = store.byID(goal.id)!;
    for (let i = 0; i < 5; i++) {
      store.transition({ goalID: goal.id, generation: 1, to: "active", actor: "controller" });
    }
    const after = store.byID(goal.id)!;
    expect(after.version).toBe(before.version);
    expect(after.status).toBe("active");
    // The no-ops are still auditable.
    expect(store.events(goal.id).filter((e) => e.kind === "noop")).toHaveLength(5);
  });

  test("optimistic version conflict is detected", () => {
    const goal = store.create({ sessionID: "ses_a", objective: "x" });
    store.transition({ goalID: goal.id, generation: 1, to: "paused", actor: "user" });
    expect(() =>
      store.transition({
        goalID: goal.id,
        generation: 1,
        to: "active",
        actor: "user",
        expectedVersion: 0,
      }),
    ).toThrow(GoalConflictError);
  });

  test("the write lock serialises competing transitions", () => {
    const goal = store.create({ sessionID: "ses_a", objective: "x" });
    const other = new GoalStore(dbPath);
    try {
      const a = store.byID(goal.id)!;
      const b = other.byID(goal.id)!;
      expect(a.version).toBe(b.version);

      // First writer wins and bumps the version.
      store.transition({ goalID: goal.id, generation: 1, to: "paused", actor: "user" });
      expect(store.byID(goal.id)!.version).toBe(a.version + 1);

      // Second writer, holding a stale view, is fenced by the version check
      // rather than silently overwriting.
      expect(() =>
        other.transition({
          goalID: goal.id,
          generation: 1,
          to: "active",
          actor: "user",
          expectedVersion: b.version,
        }),
      ).toThrow(GoalConflictError);

      // And the loser's write did not land.
      expect(store.current("ses_a")?.status).toBe("paused");
    } finally {
      other.close();
    }
  });
});

describe("durability and restart", () => {
  test("goal state survives a process restart", () => {
    const goal = store.create({ sessionID: "ses_a", objective: "durable objective" });
    store.addCriterion(goal.id, "criterion one");
    store.recordRound({ goalID: goal.id, generation: 1, classification: "progress", tokensUsed: 50 });
    store.transition({ goalID: goal.id, generation: 1, to: "paused", actor: "user" });
    store.close();

    // Fresh process, fresh handle on the same file.
    const reopened = new GoalStore(dbPath);
    try {
      const restored = reopened.current("ses_a")!;
      expect(restored.id).toBe(goal.id);
      expect(restored.objective).toBe("durable objective");
      expect(restored.status).toBe("paused");
      expect(restored.rounds).toBe(1);
      expect(restored.tokensUsed).toBe(50);
      expect(reopened.listCriteria(goal.id)).toHaveLength(1);
      expect(reopened.events(goal.id).length).toBeGreaterThan(0);
    } finally {
      reopened.close();
    }
    // Reopen so afterEach has a live handle.
    store = new GoalStore(dbPath);
  });

  test("a goal interrupted mid-verification is recovered to active on restart", () => {
    const goal = store.create({ sessionID: "ses_a", objective: "x" });
    store.transition({ goalID: goal.id, generation: 1, to: "verifying", actor: "model" });
    store.close();

    const reopened = new GoalStore(dbPath);
    try {
      expect(reopened.current("ses_a")?.status).toBe("verifying");
      const repaired = reopened.reconcileAfterRestart();
      expect(repaired).toHaveLength(1);
      expect(repaired[0].status).toBe("active");
      expect(reopened.current("ses_a")?.status).toBe("active");
      // Reconciliation is itself idempotent.
      expect(reopened.reconcileAfterRestart()).toHaveLength(0);
    } finally {
      reopened.close();
    }
    store = new GoalStore(dbPath);
  });

  test("restart does not resurrect superseded goals", () => {
    const first = store.create({ sessionID: "ses_a", objective: "one" });
    const second = store.replace({ sessionID: "ses_a", expectedGeneration: 1, objective: "two" });
    store.close();

    const reopened = new GoalStore(dbPath);
    try {
      expect(reopened.reconcileAfterRestart()).toHaveLength(0);
      expect(reopened.current("ses_a")?.id).toBe(second.id);
      expect(reopened.byID(first.id)!.status).toBe("superseded");
    } finally {
      reopened.close();
    }
    store = new GoalStore(dbPath);
  });
});

describe("audit trail", () => {
  test("every lifecycle change is recorded in order", () => {
    const goal = store.create({ sessionID: "ses_a", objective: "x" });
    store.transition({ goalID: goal.id, generation: 1, to: "paused", actor: "user" });
    store.transition({ goalID: goal.id, generation: 1, to: "active", actor: "user" });
    store.recordRound({ goalID: goal.id, generation: 1, classification: "progress" });

    const kinds = store.events(goal.id).map((e) => e.kind);
    expect(kinds).toEqual(["created", "status", "status", "round"]);
    const statuses = store
      .events(goal.id)
      .filter((e) => e.kind === "status")
      .map((e) => `${e.fromStatus}->${e.toStatus}`);
    expect(statuses).toEqual(["active->paused", "paused->active"]);
  });

  test("history retains superseded goals rather than deleting them", () => {
    store.create({ sessionID: "ses_a", objective: "one" });
    store.replace({ sessionID: "ses_a", expectedGeneration: 1, objective: "two" });
    store.replace({ sessionID: "ses_a", expectedGeneration: 2, objective: "three" });

    const history = store.history("ses_a");
    expect(history).toHaveLength(3);
    expect(history.map((g) => g.status)).toEqual(["active", "superseded", "superseded"]);
    expect(history.map((g) => g.generation)).toEqual([3, 2, 1]);
  });
});

describe("transition table invariants", () => {
  test("no terminal status has outgoing transitions", () => {
    for (const terminal of ["complete", "superseded"] as const) {
      expect(canTransition({ from: terminal, to: "active", actor: "user" }).ok).toBe(false);
    }
  });

  test("only the controller can commit completion", () => {
    for (const actor of ["model", "user"] as const) {
      const check = canTransition({ from: "verifying", to: "complete", actor });
      expect(check.ok).toBe(false);
    }
    expect(canTransition({ from: "verifying", to: "complete", actor: "controller" }).ok).toBe(true);
  });
});
