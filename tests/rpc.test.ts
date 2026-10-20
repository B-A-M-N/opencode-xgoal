/**
 * Phase 05 — server RPC surface for the TUI companion.
 *
 * The gate: replacement must be a generation-checked server transition, so a
 * confirmation dialog rendered against generation N cannot clobber generation
 * N+1. The dialog collects intent only.
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GoalController } from "../src/controller/controller.ts";
import { goalRpcDefinition, goalRpcHandlers } from "../src/rpc.ts";

let dir: string;
let controller: GoalController;
let handlers: ReturnType<typeof goalRpcHandlers>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "xgoal-rpc-"));
  controller = new GoalController({ dbPath: join(dir, "goals.db") });
  handlers = goalRpcHandlers(controller);
});

afterEach(() => {
  try {
    controller.close();
  } catch {
    /* closed */
  }
  rmSync(dir, { recursive: true, force: true });
});

describe("rpc definition", () => {
  test("declares the methods the TUI depends on", () => {
    const methods = Object.keys(goalRpcDefinition.methods);
    expect(methods).toContain("goal.status");
    expect(methods).toContain("goal.replace");
    expect(methods).toContain("goal.pause");
    expect(methods).toContain("goal.resume");
    expect(methods).toContain("goal.history");
  });

  test("replace requires an expectedGeneration", () => {
    const input = goalRpcDefinition.methods["goal.replace"].input as unknown as {
      required?: readonly string[];
    };
    expect(input.required).toContain("expectedGeneration");
  });
});

describe("goal.status", () => {
  test("reports no goal for an empty session", async () => {
    const res = await handlers["goal.status"]({ sessionID: "ses_a" });
    expect(res.goal).toBeNull();
  });

  test("reports the current goal with its generation and criteria", async () => {
    const start = controller.startOrDescribe("ses_a", "build the thing");
    if (!("created" in start)) throw new Error("expected a new goal");
    const goal = start.created;
    controller.store.addCriterion(goal.id, "it works");
    const res = await handlers["goal.status"]({ sessionID: "ses_a" });
    expect(res.goal?.generation).toBe(1);
    expect(res.goal?.objective).toBe("build the thing");
    expect(res.goal?.status).toBe("active");
    expect(res.goal?.criteria).toHaveLength(1);
  });

  test("a malformed call does not throw", async () => {
    const res = await handlers["goal.status"]({} as never);
    expect(res.goal).toBeNull();
  });
});

describe("goal.replace is generation-checked", () => {
  test("replaces when the generation matches", async () => {
    controller.startOrDescribe("ses_a", "original");
    const res = await handlers["goal.replace"]({
      sessionID: "ses_a",
      objective: "replacement",
      expectedGeneration: 1,
    });
    expect(res.error).toBeUndefined();
    expect(res.goal?.generation).toBe(2);
    expect(res.goal?.objective).toBe("replacement");
  });

  test("REFUSES a stale confirmation rather than clobbering a newer goal", async () => {
    controller.startOrDescribe("ses_a", "one");
    // A dialog was rendered against generation 1...
    // ...but by the time it was confirmed, generation 2 already exists.
    controller.replace("ses_a", "two");

    const res = await handlers["goal.replace"]({
      sessionID: "ses_a",
      objective: "three",
      expectedGeneration: 1,
    });

    expect(res.error).toBeDefined();
    expect(res.error).toContain("stale replacement");
    // The newer goal survived untouched.
    expect(controller.status("ses_a")?.objective).toBe("two");
    expect(controller.status("ses_a")?.generation).toBe(2);
  });

  test("a missing expectedGeneration is rejected", async () => {
    controller.startOrDescribe("ses_a", "one");
    const res = await handlers["goal.replace"]({
      sessionID: "ses_a",
      objective: "two",
    } as never);
    expect(res.error).toContain("expectedGeneration");
    expect(controller.status("ses_a")?.objective).toBe("one");
  });

  test("replace creates a goal when none exists", async () => {
    const res = await handlers["goal.replace"]({
      sessionID: "ses_a",
      objective: "first",
      expectedGeneration: 1,
    });
    expect(res.error).toBeUndefined();
    expect(res.goal?.generation).toBe(1);
  });

  test("history is preserved across replacements", async () => {
    controller.startOrDescribe("ses_a", "one");
    await handlers["goal.replace"]({ sessionID: "ses_a", objective: "two", expectedGeneration: 1 });
    await handlers["goal.replace"]({ sessionID: "ses_a", objective: "three", expectedGeneration: 2 });

    const res = await handlers["goal.history"]({ sessionID: "ses_a" });
    expect(res.goals).toHaveLength(3);
    expect(res.goals.map((g) => g?.generation)).toEqual([3, 2, 1]);
    // Superseded goals are retained, not deleted.
    expect(res.goals.filter((g) => g?.status === "superseded")).toHaveLength(2);
  });
});

describe("pause and resume", () => {
  test("pause then resume round-trips", async () => {
    controller.startOrDescribe("ses_a", "x");
    const paused = await handlers["goal.pause"]({ sessionID: "ses_a" });
    expect(paused.goal?.status).toBe("paused");
    const resumed = await handlers["goal.resume"]({ sessionID: "ses_a" });
    expect(resumed.goal?.status).toBe("active");
  });

  test("pausing with no goal reports an error rather than throwing", async () => {
    const res = await handlers["goal.pause"]({ sessionID: "ses_a" });
    expect(res.goal).toBeNull();
    expect((res as { error?: string }).error).toBeDefined();
  });
});

describe("RPC output must be JSON-serializable", () => {
  // Regression: `undefined` is not a JSON value. The RPC output schema rejected
  // it, so a goal.replace that had ALREADY mutated state returned
  // `rpc.invalid_output: Expected JSON value at ["goal"]["reason"]` to the
  // caller. A fresh goal has no `reason`, so this hit every first replacement.
  test("a freshly created goal serializes without undefined fields", async () => {
    const res = await handlers["goal.replace"]({
      sessionID: "ses_a",
      objective: "fresh objective",
      expectedGeneration: 1,
    });
    expect(res.error).toBeUndefined();
    // No property may be undefined, or the RPC output schema will reject it.
    const flat = JSON.parse(JSON.stringify(res.goal));
    for (const [k, v] of Object.entries(flat)) {
      expect(v).not.toBeUndefined();
      expect(k).toBeTruthy();
    }
    expect(flat.reason).toBeNull();
    expect(flat.tokensUsed).toBeNull();
    expect(flat.tokenBudget).toBeNull();
  });

  test("status output for a fresh goal is JSON-clean too", async () => {
    controller.startOrDescribe("ses_a", "objective");
    const res = await handlers["goal.status"]({ sessionID: "ses_a" });
    const flat = JSON.parse(JSON.stringify(res.goal));
    expect(flat.reason).toBeNull();
    expect(flat.tokensUsed).toBeNull();
  });

  test("a round-trip through JSON preserves every field", async () => {
    const created = await handlers["goal.replace"]({
      sessionID: "ses_a",
      objective: "obj",
      expectedGeneration: 1,
    });
    const round = JSON.parse(JSON.stringify(created.goal));
    expect(round.objective).toBe("obj");
    expect(round.generation).toBe(1);
    expect(round.status).toBe("active");
    expect(Array.isArray(round.criteria)).toBe(true);
  });
});

describe("headless parity", () => {
  test("every TUI action has a headless RPC equivalent", async () => {
    // A client with no dialog can still do everything the TUI does.
    controller.startOrDescribe("ses_a", "one");
    const r1 = await handlers["goal.replace"]({
      sessionID: "ses_a",
      objective: "two",
      expectedGeneration: 1,
    });
    expect(r1.goal?.generation).toBe(2);
    expect((await handlers["goal.pause"]({ sessionID: "ses_a" })).goal?.status).toBe("paused");
    expect((await handlers["goal.resume"]({ sessionID: "ses_a" })).goal?.status).toBe("active");
    expect((await handlers["goal.status"]({ sessionID: "ses_a" })).goal?.objective).toBe("two");
    expect((await handlers["goal.history"]({ sessionID: "ses_a" })).goals).toHaveLength(2);
  });

  test("two sessions are addressable independently over RPC", async () => {
    controller.startOrDescribe("ses_a", "goal A");
    controller.startOrDescribe("ses_b", "goal B");
    expect((await handlers["goal.status"]({ sessionID: "ses_a" })).goal?.objective).toBe("goal A");
    expect((await handlers["goal.status"]({ sessionID: "ses_b" })).goal?.objective).toBe("goal B");
    await handlers["goal.pause"]({ sessionID: "ses_a" });
    expect((await handlers["goal.status"]({ sessionID: "ses_b" })).goal?.status).toBe("active");
  });
});
