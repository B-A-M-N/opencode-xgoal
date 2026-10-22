/**
 * OpenCode-XGoal — TUI keyboard-flow contract tests (audit-4 #14).
 *
 * The live interactive qualification (scripts/qualify.sh) drives a real TUI.
 * These tests pin the same contract at the unit level, against an injected
 * host surface, so a refactor cannot silently change what a keypress does:
 *
 *   - Enter (confirm: true) on the replace dialog replaces the ACTIVE goal,
 *     fenced to the generation that was on screen when the dialog rendered.
 *   - Escape (confirm: false/undefined) keeps the current goal — no RPC at all.
 *   - `/goal <objective>` with no active goal never shows a dialog.
 *   - a completed goal is history: no dialog, the next /goal starts fresh.
 *   - a stale-fenced replacement is surfaced for fresh review, not swallowed.
 */
import { describe, expect, test } from "bun:test";
import { createGoalCommand, type GoalRpc } from "../src/tui.tsx";
import type { GoalWire } from "../src/rpc.ts";

function goal(partial: Partial<GoalWire>): GoalWire {
  return {
    id: "goal_test",
    generation: 1,
    objective: "existing objective",
    status: "active",
    reason: null,
    rounds: 0,
    noProgressRounds: 0,
    tokensUsed: 0,
    tokenBudget: null,
    criteria: [],
    ...partial,
  };
}

interface Harness {
  replaces: Array<{ sessionID: string; objective: string; expectedGeneration: number }>;
  creates: string[];
  dialogs: Array<{ title: string; message: string }>;
  toasts: Array<{ message: string; variant: string }>;
  /** Resolve the pending dialog with this value (true = Enter, false = Escape). */
  answer: true | false | undefined;
  host: Parameters<typeof createGoalCommand>[0];
  runGoal: (raw: string) => Promise<void>;
}

function makeHarness(options: {
  current?: GoalWire | null;
  latest?: GoalWire | null;
  answer: true | false | undefined;
  /** The generation the server sees when the replace RPC lands. */
  serverGenerationAtReplace?: number;
  /** The session the user is viewing (undefined = no session open). */
  sessionID?: string;
}): Harness {
  const sessionID = "sessionID" in options ? options.sessionID : "ses_tui";
  const h: Harness = {
    replaces: [],
    creates: [],
    dialogs: [],
    toasts: [],
    answer: options.answer,
    host: undefined!,
    runGoal: undefined!,
  };

  const current = options.current === undefined ? goal({}) : options.current;
  let statusCalls = 0;

  const rpc = {
    "goal.status": async () => {
      // The second status read (inside replaceGoal, when the fence is stale)
      // sees the post-replacement world in the stale-scenario harnesses.
      statusCalls++;
      return { current: statusCalls === 1 ? current : (current ?? null), latest: options.latest ?? null };
    },
    "goal.create": async (input: { sessionID: string; objective: string }) => {
      h.creates.push(input.objective);
      return { goal: goal({ generation: 1, objective: input.objective }) };
    },
    "goal.replace": async (input: {
      sessionID: string;
      objective: string;
      expectedGeneration: number;
    }) => {
      h.replaces.push(input);
      const serverGen = options.serverGenerationAtReplace ?? current?.generation ?? 1;
      if (input.expectedGeneration !== serverGen) {
        return {
          goal: null,
          error: `stale generation: goal is generation ${serverGen}, replacement claimed ${input.expectedGeneration}`,
        };
      }
      return { goal: goal({ generation: serverGen + 1, objective: input.objective }), drive: { action: "admitted" } };
    },
    "goal.pause": async () => ({ goal: goal({ status: "paused" }) }),
    "goal.resume": async () => ({ goal: goal({ status: "active" }), drive: { action: "admitted" } }),
    "goal.budget": async () => ({ goal: goal({}) }),
    "goal.accept": async () => ({ goal: goal({}) }),
    "goal.health": async () => ({ health: { ok: true } }),
  } as unknown as GoalRpc;

  h.host = {
    rpc,
    currentSessionID: () => sessionID,
    dialogConfirm: async (input: { title: string; message: string }) => {
      h.dialogs.push({ title: input.title, message: input.message });
      return h.answer;
    },
    notify: (message: string, variant: "info" | "success" | "warning" | "error" = "info") => {
      h.toasts.push({ message, variant });
    },
  };

  const command = createGoalCommand(h.host);
  h.runGoal = (raw) => command.runGoal(raw);
  return h;
}

describe("TUI keyboard flow (audit-4 #14)", () => {
  test("Enter on the replace dialog replaces the goal, fenced to the on-screen generation", async () => {
    const h = makeHarness({ current: goal({ generation: 3, objective: "v1" }), answer: true });
    await h.runGoal("brand new objective");
    expect(h.dialogs).toHaveLength(1);
    expect(h.dialogs[0]!.title).toBe("Replace goal?");
    expect(h.dialogs[0]!.message).toContain("generation 3");
    expect(h.replaces).toEqual([
      { sessionID: "ses_tui", objective: "brand new objective", expectedGeneration: 3 },
    ]);
    expect(h.toasts.some((t) => t.variant === "success")).toBe(true);
  });

  test("Escape keeps the current goal — no replace RPC is sent at all", async () => {
    const h = makeHarness({ current: goal({ generation: 3 }), answer: false });
    await h.runGoal("brand new objective");
    expect(h.dialogs).toHaveLength(1);
    expect(h.replaces).toHaveLength(0);
    expect(h.toasts.some((t) => t.message.includes("Kept the current goal"))).toBe(true);
  });

  test("a dismissed dialog (undefined — Escape outside the dialog) also keeps the goal", async () => {
    const h = makeHarness({ current: goal({}), answer: undefined });
    await h.runGoal("another objective");
    expect(h.replaces).toHaveLength(0);
    expect(h.toasts.some((t) => t.message.includes("Kept the current goal"))).toBe(true);
  });

  test("no active goal: /goal starts immediately — no dialog ever", async () => {
    const h = makeHarness({ current: null, answer: true });
    await h.runGoal("fresh objective");
    expect(h.dialogs).toHaveLength(0);
    expect(h.creates).toEqual(["fresh objective"]);
  });

  test("a completed goal is history: the next /goal starts fresh without a dialog", async () => {
    // status returns current=null (completed goals are not "current"), latest
    // carries the completed record — this must NOT trigger "Replace goal?".
    const h = makeHarness({
      current: null,
      latest: goal({ generation: 1, status: "complete", objective: "the old one" }),
      answer: true,
    });
    await h.runGoal("the next objective");
    expect(h.dialogs).toHaveLength(0);
    expect(h.creates).toEqual(["the next objective"]);
  });

  test("the replace dialog names the objective the user is about to discard", async () => {
    const h = makeHarness({ current: goal({ generation: 2, objective: "ship the parser" }), answer: true });
    await h.runGoal("ship the parser faster");
    expect(h.dialogs[0]!.message).toContain("ship the parser");
  });

  test("a stale-fenced replace (world moved between dialog and Enter) surfaces the error", async () => {
    const h = makeHarness({
      current: goal({ generation: 1 }),
      answer: true,
      // The server is on generation 2 by the time the replace RPC lands.
      serverGenerationAtReplace: 2,
    });
    await h.runGoal("the new objective");
    expect(h.replaces).toHaveLength(1);
    expect(h.replaces[0]!.expectedGeneration).toBe(1);
    expect(h.toasts.some((t) => t.variant === "error" && t.message.includes("stale generation"))).toBe(true);
  });

  test("the accept verb sends the fencing pair captured at action time", async () => {
    const h = makeHarness({ current: goal({ id: "goal_seen", generation: 4 }), answer: true });
    const accepts: Array<Record<string, unknown>> = [];
    (h.host.rpc as unknown as Record<string, unknown>)["goal.accept"] = async (input: any) => {
      accepts.push(input);
      return { goal: goal({}) };
    };
    await h.runGoal("accept nice work");
    expect(accepts).toEqual([{ sessionID: "ses_tui", note: "nice work", goalID: "goal_seen", expectedGeneration: 4 }]);
  });

  test("accept outside any session is refused with a warning, no RPC", async () => {
    const h = makeHarness({ current: null, answer: true, sessionID: undefined });
    const calls: unknown[] = [];
    (h.host.rpc as unknown as Record<string, unknown>)["goal.status"] = async () => {
      calls.push("status");
      return { current: null, latest: null };
    };
    await h.runGoal("status");
    expect(calls).toHaveLength(0);
    expect(h.toasts[0]!.message).toContain("Open a session");
  });
});
