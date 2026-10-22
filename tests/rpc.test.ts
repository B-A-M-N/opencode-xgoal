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
import { GoalCoordinator } from "../src/controller/coordinator.ts";
import { GoalVerifier } from "../src/controller/verification.ts";
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
    expect(methods).toContain("goal.create");
    expect(methods).toContain("goal.health");
    expect(methods).toContain("goal.budget");
  });

  test("replace requires an expectedGeneration", () => {
    const input = goalRpcDefinition.methods["goal.replace"].input as unknown as {
      required?: readonly string[];
    };
    expect(input.required).toContain("expectedGeneration");
  });
});

describe("goal.status", () => {
  // The parity harness caught this failure mode: the store's optional row
  // fields (`spec`, `covers`) are `undefined` when absent, and the RPC output
  // schema rejects `undefined` — turning a successful goal.create mutation
  // into `RpcInternalError: Expected JSON value at ["goal"]["criteria"]` while
  // the goal itself was created and driven.
  function assertJSONValues(value: unknown, path = "$"): void {
    if (value === undefined) {
      throw new Error(`undefined at ${path} — not a JSON value; the RPC output schema rejects it`);
    }
    if (Array.isArray(value)) {
      value.forEach((v, i) => assertJSONValues(v, `${path}[${i}]`));
    } else if (value && typeof value === "object") {
      for (const [k, v] of Object.entries(value)) assertJSONValues(v, `${path}.${k}`);
    }
  }

  test("every wire field is a JSON value; absent spec/covers serialize as null", async () => {
    const start = controller.startOrDescribe(
      "ses_a",
      "Create a file called a.txt containing exactly: alpha and run the integration suite",
    );
    if (!("created" in start)) throw new Error("expected a new goal");
    const goal = start.created;
    const objectiveID = controller.store
      .listCriteria(goal.id)
      .find((c) => c.spec?.type === "objective")?.id;
    if (!objectiveID) throw new Error("expected an objective-level criterion");
    controller.store.addCriterion(
      goal.id,
      "sub requirement: the suite exits zero",
      { type: "test", command: "bun test" },
      "model",
      [objectiveID!],
    );
    const res = await handlers["goal.status"]({ sessionID: "ses_a" });
    expect(() => assertJSONValues(res)).not.toThrow();
    const criteria = res.goal!.criteria;
    expect(criteria.length).toBeGreaterThanOrEqual(2);
    expect(criteria.every((c) => c.covers === null || Array.isArray(c.covers))).toBe(true);
    expect(criteria.every((c) => c.spec !== undefined)).toBe(true);
    expect(criteria.find((c) => c.text.includes("suite exits zero"))?.covers).toEqual([
      objectiveID,
    ]);
  });

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
    // `/goal` establishes criteria automatically; the explicit one is additive.
    expect(res.goal?.criteria.length).toBeGreaterThanOrEqual(1);
    expect(res.goal?.criteria.some((c: any) => c.text === "it works")).toBe(true);
  });

  test("reports the latest terminal goal, not 'no goal'", async () => {
    const start = controller.startOrDescribe("ses_a", "finished work");
    if (!("created" in start)) throw new Error("expected a new goal");
    controller.store.transition({
      goalID: start.created.id,
      generation: start.created.generation,
      to: "superseded",
      actor: "user",
    });
    const res = await handlers["goal.status"]({ sessionID: "ses_a" });
    expect(res.goal?.status).toBe("superseded");
    expect(res.goal?.objective).toBe("finished work");
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

describe("mutations schedule execution (audit defect 7)", () => {
  function withCoordinator() {
    const driven: string[] = [];
    const coordinator = new GoalCoordinator(controller, () => ({
      async drive(sessionID: string) {
        driven.push(sessionID);
        return { action: "admitted" as const, roundID: "round_test", inboxID: "msg_test" };
      },
    }));
    return { coordinator, driven, handlers: goalRpcHandlers(controller, coordinator) };
  }

  test("goal.create creates the goal AND drives it", async () => {
    const { driven, handlers: h } = withCoordinator();
    const res = await h["goal.create"]({ sessionID: "ses_a", objective: "do the work" });
    expect(res.goal?.status).toBe("active");
    expect(res.error).toBeUndefined();
    expect(driven).toEqual(["ses_a"]);
  });

  test("goal.create refuses to silently supersede an existing goal", async () => {
    const { driven, handlers: h } = withCoordinator();
    await h["goal.create"]({ sessionID: "ses_a", objective: "first" });
    const res = await h["goal.create"]({ sessionID: "ses_a", objective: "second" });
    expect(res.error).toContain("already active");
    expect(controller.status("ses_a")?.objective).toBe("first");
    // No second dispatch for a mutation that did not happen.
    expect(driven).toHaveLength(1);
  });

  test("goal.replace drives the new generation", async () => {
    const { driven, handlers: h } = withCoordinator();
    await h["goal.create"]({ sessionID: "ses_a", objective: "first" });
    const res = await h["goal.replace"]({
      sessionID: "ses_a",
      objective: "second",
      expectedGeneration: 1,
    });
    expect(res.error).toBeUndefined();
    expect(res.goal?.generation).toBe(2);
    expect(driven).toHaveLength(2);
  });

  test("goal.resume drives; goal.pause does not", async () => {
    const { driven, handlers: h } = withCoordinator();
    await h["goal.create"]({ sessionID: "ses_a", objective: "x" });
    await h["goal.pause"]({ sessionID: "ses_a" });
    expect(driven).toHaveLength(1);
    const resumed = await h["goal.resume"]({ sessionID: "ses_a" });
    expect(resumed.goal?.status).toBe("active");
    expect(driven).toHaveLength(2);
  });

  test("a dispatch throw is surfaced through the coordinator hook", async () => {
    const errors: string[] = [];
    const coordinator = new GoalCoordinator(
      controller,
      () => ({
        async drive(sessionID: string): Promise<never> {
          throw new Error(`boom:${sessionID}`);
        },
      }),
      {
        onDriveError: (sessionID, error) => errors.push(`${sessionID}:${String(error)}`),
      },
    );
    const h = goalRpcHandlers(controller, coordinator);
    const res = await h["goal.create"]({ sessionID: "ses_a", objective: "x" });
    // The mutation still stands; the failure is observable instead of silent.
    expect(res.goal?.status).toBe("active");
    expect(errors).toEqual(["ses_a:Error: boom:ses_a"]);
  });

  test("goal.health names an active goal that nothing is driving", async () => {
    const { handlers: h } = withCoordinator();
    controller.startOrDescribe("ses_a", "x");
    const res = await h["goal.health"]({ sessionID: "ses_a" });
    expect(res.health.ok).toBe(false);
    expect((res.health.problems as string[]).join(" ")).toContain("nothing is driving it");
  });
});

// Audit P2-8: a terminal goal must not present as "current". The TUI renders
// its replacement confirmation against `current`, and used to see the finished
// goal there — triggering a pointless confirmation for work already done.
describe("goal.status separates current from latest", () => {
  test("a completed goal is latest but never current", async () => {
    const start = controller.startOrDescribe("ses_a", "done work");
    if (!("created" in start)) throw new Error("expected a new goal");
    const goal = start.created;
    controller.store.transition({
      goalID: goal.id,
      generation: goal.generation,
      to: "verifying",
      actor: "model",
      reason: "proposed",
    });
    controller.commitComplete(goal.id, goal.generation, "verified");

    const res = await handlers["goal.status"]({ sessionID: "ses_a" });
    expect(res.current).toBeNull();
    expect(res.latest?.status).toBe("complete");
    // `goal` remains an alias of `latest` for existing consumers.
    expect(res.goal).toEqual(res.latest);
  });

  test("an active goal is both current and latest", async () => {
    controller.startOrDescribe("ses_a", "in progress");
    const res = await handlers["goal.status"]({ sessionID: "ses_a" });
    expect(res.current?.status).toBe("active");
    expect(res.latest?.generation).toBe(res.current?.generation);
  });

  test("after a replacement both point at the new generation", async () => {
    controller.startOrDescribe("ses_a", "one");
    controller.replace("ses_a", "two");
    const res = await handlers["goal.status"]({ sessionID: "ses_a" });
    expect(res.current?.generation).toBe(2);
    expect(res.latest?.generation).toBe(2);
  });
});

// Audit P0-2/P2-8: user acceptance is a first-class USER action with a
// headless RPC path, and it finishes a verifying goal when acceptance is the
// only thing missing.
describe("goal.accept", () => {
  test("records acceptance for the active goal", async () => {
    controller.startOrDescribe("ses_a", "make it good");
    const res = await handlers["goal.accept"]({ sessionID: "ses_a", note: "looks right" });
    expect(res.error).toBeUndefined();
    expect(res.goal?.status).toBe("active");
    const goal = controller.status("ses_a");
    expect(controller.store.userAcceptance(goal!.id)?.note).toBe("looks right");
  });

  test("acceptance with no goal is an error, not an exception", async () => {
    const res = await handlers["goal.accept"]({ sessionID: "ses_a" });
    expect(res.goal).toBeNull();
    expect(res.error).toBeDefined();
  });

  test("REGRESSION: a confirmation fenced to a replaced generation is rejected, not applied to the replacement", async () => {
    const start = controller.startOrDescribe("ses_a", "the objective the user reviewed");
    if (!("created" in start)) throw new Error("expected a new goal");
    const reviewed = start.created;

    // The user decides to accept; meanwhile another client replaces the goal.
    // The confirmation arrives targeting what the user SAW.
    controller.replace("ses_a", "a different objective from another client", reviewed.generation);
    const current = controller.status("ses_a")!;
    expect(current.generation).toBe(reviewed.generation + 1);

    const res = await handlers["goal.accept"]({
      sessionID: "ses_a",
      goalID: reviewed.id,
      expectedGeneration: reviewed.generation,
    });
    expect(res.goal).toBeNull();
    expect(res.error).toContain("stale confirmation");
    // The replacement was NOT accepted in the user's name.
    expect(controller.store.userAcceptance(current.id)).toBeUndefined();
    // The fenced confirmation against the still-current goal still works.
    const ok = await handlers["goal.accept"]({
      sessionID: "ses_a",
      goalID: current.id,
      expectedGeneration: current.generation,
    });
    expect(ok.error).toBeUndefined();
    expect(controller.store.userAcceptance(current.id)?.note).toBeUndefined();
  });

  test("a missing sessionID is rejected", async () => {
    const res = await handlers["goal.accept"]({} as never);
    expect(res.error).toContain("sessionID");
  });

  test("acceptance completes a verifying goal when acceptance was the only gap", async () => {
    const start = controller.startOrDescribe("ses_a", "make it good");
    if (!("created" in start)) throw new Error("expected a new goal");
    const goal = start.created;
    // Machine evidence exists so the evidence floor is met; the objective-level
    // remainder is what acceptance resolves.
    controller.store.addEvidence({
      goalID: goal.id,
      kind: "command",
      ref: "ls",
      detail: "exit 0",
      exitCode: 0,
    });
    controller.store.transition({
      goalID: goal.id,
      generation: goal.generation,
      to: "verifying",
      actor: "model",
      reason: "proposed",
    });

    const verifier = new GoalVerifier(controller.store, {
      validate: async () => ({ valid: true, reason: "ok" }),
    });
    const h = goalRpcHandlers(controller, undefined, verifier);
    const res = await h["goal.accept"]({ sessionID: "ses_a", note: "ship it" });
    expect(res.error).toBeUndefined();
    expect(res.goal?.status).toBe("complete");
  });

  test("acceptance does not complete a goal with unmet machine criteria", async () => {
    const start = controller.startOrDescribe(
      "ses_a",
      "Create a file called a.txt containing exactly: alpha.",
    );
    if (!("created" in start)) throw new Error("expected a new goal");
    const goal = start.created;
    controller.store.addEvidence({
      goalID: goal.id,
      kind: "command",
      ref: "ls",
      detail: "exit 0",
      exitCode: 0,
    });
    controller.store.transition({
      goalID: goal.id,
      generation: goal.generation,
      to: "verifying",
      actor: "model",
      reason: "proposed",
    });

    // The file requirement is genuinely unmet: acceptance of the objective
    // cannot paper over a concrete machine-checkable spec.
    const verifier = new GoalVerifier(controller.store, {
      validate: async () => ({ valid: true, reason: "ok" }),
      checkSpec: async () => ({ valid: false, reason: "file absent" }),
    });
    const h = goalRpcHandlers(controller, undefined, verifier);
    const res = await h["goal.accept"]({ sessionID: "ses_a" });
    expect(res.error).toContain("unmet");
    expect(controller.status("ses_a")?.status).toBe("active");
  });
});
