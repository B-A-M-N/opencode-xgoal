/**
 * OpenCode-XGoal — TUI companion (OpenCode 2 APIs).
 *
 * The dialog collects intent only. Every mutation is a generation-checked
 * server RPC, so a confirmation rendered against generation N can never clobber
 * generation N+1. The server's coordinator also schedules native execution, so
 * setting a goal from the TUI actually starts work — it does not merely write a
 * row and hope the model continues.
 *
 * Behaviour:
 *   - `/goal <objective>` with no current goal starts immediately, no dialog
 *   - with a goal already active, show a confirmation
 *   - default selection is Replace; Enter confirms; Escape cancels
 *   - pause/resume/budget/health are available without a second command
 */
import { Plugin } from "@opencode/plugin/tui";
import { goalRpcDefinition, type GoalWire } from "./rpc.ts";

/** The RPC surface this companion uses, inferred from the shared definition. */
interface GoalRpc {
  "goal.status": (input: { sessionID: string }) => Promise<{ goal: GoalWire | null }>;
  "goal.create": (input: {
    sessionID: string;
    objective: string;
  }) => Promise<{ goal: GoalWire | null; error?: string; drive?: unknown }>;
  "goal.replace": (input: {
    sessionID: string;
    objective: string;
    expectedGeneration: number;
  }) => Promise<{ goal: GoalWire | null; error?: string; drive?: unknown }>;
  "goal.pause": (input: { sessionID: string }) => Promise<{ goal: GoalWire | null; error?: string }>;
  "goal.resume": (input: { sessionID: string }) => Promise<{
    goal: GoalWire | null;
    error?: string;
    drive?: unknown;
  }>;
  "goal.budget": (input: {
    sessionID: string;
    budget?: number;
  }) => Promise<{ goal: GoalWire | null; error?: string }>;
  "goal.health": (input: { sessionID: string }) => Promise<{ health: Record<string, unknown> }>;
}

/** Human-readable dispatch outcome, matching the server's DriveOutcome. */
function describeDrive(outcome: any): string {
  if (!outcome) return "the server did not report a dispatch";
  switch (outcome.action) {
    case "admitted":
      return "execution scheduled";
    case "reconcile":
      return `an outstanding round is still ${outcome.status}`;
    case "unknown":
      return "dispatch outcome unknown; the recovery sweep will reconcile it";
    case "failed":
      return `dispatch failed: ${outcome.detail}`;
    case "abandoned":
      return `dispatch abandoned: ${outcome.detail}`;
    case "limited":
      return `not dispatched: goal is ${outcome.status}`;
    case "idle":
      return `not dispatched: ${outcome.reason}`;
    default:
      return `dispatch: ${String(outcome.action)}`;
  }
}

export default Plugin.define({
  id: "opencode-xgoal-tui",

  async setup(context: Plugin.Context) {
    const rpc = context.client.rpc(goalRpcDefinition) as unknown as GoalRpc;

    const currentSessionID = (): string | undefined => {
      const route = context.ui.router.current();
      return route.type === "session" ? route.sessionID : undefined;
    };

    const notify = (
      message: string,
      variant: "info" | "success" | "warning" | "error" = "info",
      sessionID?: string,
    ) => {
      try {
        context.ui.toast.show({ title: "OpenCode-XGoal", message, variant, sessionID });
      } catch {
        /* toasts are advisory */
      }
    };

    const statusText = (goal: GoalWire | null): string => {
      if (!goal) return "No active goal. Use /goal <objective>.";
      const budget =
        goal.tokenBudget === null
          ? `${goal.tokensUsed ?? 0} tokens`
          : `${goal.tokensUsed ?? 0}/${goal.tokenBudget} tokens`;
      return [
        `[${goal.status}] generation ${goal.generation}: ${goal.objective}`,
        `rounds ${goal.rounds}, no-progress ${goal.noProgressRounds}, ${budget}`,
      ].join("\n");
    };

    const replaceGoal = async (
      sessionID: string,
      objective: string,
      expectedGeneration?: number,
    ) => {
      let expected = expectedGeneration;
      if (expected === undefined) {
        const current = (await rpc["goal.status"]({ sessionID })).goal;
        if (!current) {
          await createGoal(sessionID, objective);
          return;
        }
        expected = current.generation;
      }
      const res = await rpc["goal.replace"]({ sessionID, objective, expectedGeneration: expected });
      if (res.error) {
        // A stale generation is the expected failure when the world moved on.
        notify(`Could not set the goal: ${res.error}`, "error", sessionID);
        return;
      }
      notify(
        `Goal set (generation ${res.goal?.generation ?? "?"}). ${describeDrive(res.drive)}.`,
        "success",
        sessionID,
      );
    };

    const createGoal = async (sessionID: string, objective: string) => {
      const res = await rpc["goal.create"]({ sessionID, objective });
      if (res.error) {
        notify(`Could not create the goal: ${res.error}`, "error", sessionID);
        return;
      }
      notify(
        `Goal created (generation ${res.goal?.generation ?? "?"}). ${describeDrive(res.drive)}.`,
        "success",
        sessionID,
      );
    };

    const runGoal = async (raw: string) => {
      const sessionID = currentSessionID();
      if (!sessionID) {
        notify("Open a session before using /goal.", "warning");
        return;
      }

      const text = String(raw ?? "").trim();
      const [verb, ...rest] = text.split(/\s+/);
      const arg = rest.join(" ").trim();

      // Bare `/goal` and the explicit control verbs never prompt.
      if (!text || verb === "status") {
        const res = await rpc["goal.status"]({ sessionID });
        notify(statusText(res.goal), "info", sessionID);
        return;
      }

      if (verb === "pause" || verb === "resume") {
        const res =
          verb === "pause"
            ? await rpc["goal.pause"]({ sessionID })
            : await rpc["goal.resume"]({ sessionID });
        if (res.error) {
          notify(`Could not ${verb} the goal: ${res.error}`, "error", sessionID);
          return;
        }
        const suffix = verb === "resume" ? ` ${describeDrive((res as any).drive)}.` : "";
        notify(
          verb === "pause" ? "Goal paused." : `Goal resumed: ${res.goal?.status ?? "active"}.${suffix}`,
          "success",
          sessionID,
        );
        return;
      }

      if (verb === "replace") {
        if (!arg) {
          notify("Usage: /goal replace <objective>", "error", sessionID);
          return;
        }
        await replaceGoal(sessionID, arg);
        return;
      }

      if (verb === "budget") {
        const current = (await rpc["goal.status"]({ sessionID })).goal;
        if (!current) {
          notify("No active goal.", "warning", sessionID);
          return;
        }
        if (!arg) {
          notify(
            current.tokenBudget === null
              ? `Tokens: ${current.tokensUsed ?? 0} (no budget set)`
              : `Tokens: ${current.tokensUsed ?? 0} / ${current.tokenBudget}`,
            "info",
            sessionID,
          );
          return;
        }
        if (/^(off|none|clear)$/i.test(arg)) {
          const res = await rpc["goal.budget"]({ sessionID });
          notify(res.error ? `Could not clear the budget: ${res.error}` : "Token budget cleared.", res.error ? "error" : "success", sessionID);
          return;
        }
        const n = Number(arg);
        if (!Number.isFinite(n) || n <= 0) {
          notify("Usage: /goal budget <positive number> | off", "error", sessionID);
          return;
        }
        const res = await rpc["goal.budget"]({ sessionID, budget: Math.floor(n) });
        notify(
          res.error ? `Could not set the budget: ${res.error}` : `Token budget set to ${Math.floor(n)}.`,
          res.error ? "error" : "success",
          sessionID,
        );
        return;
      }

      if (verb === "health") {
        const res = await rpc["goal.health"]({ sessionID });
        notify(JSON.stringify(res.health, null, 2), res.health?.ok === false ? "warning" : "info", sessionID);
        return;
      }

      // `/goal <objective>` — start immediately if nothing is active, otherwise
      // confirm before replacing.
      const existing = (await rpc["goal.status"]({ sessionID })).goal;
      if (!existing) {
        await createGoal(sessionID, text);
        return;
      }

      const confirmed = await context.ui.dialog.confirm({
        title: "Replace goal?",
        message: [
          `An existing goal is active (generation ${existing.generation}):`,
          existing.objective,
          "",
          "Set a new goal?",
        ].join("\n"),
        // Default selection: Replace. Enter confirms, Escape cancels.
        label: { confirm: "Replace", cancel: "Keep" },
      });

      if (confirmed !== true) {
        notify("Kept the current goal.", "info", sessionID);
        return;
      }
      await replaceGoal(sessionID, text, existing.generation);
    };

    // Slash completion and palette entry. `arguments: true` keeps `/goal` in
    // the prompt and passes the raw argument text to `run`.
    context.keymap.layer(() => ({
      priority: 100,
      commands: [
        {
          id: "opencode-xgoal.goal",
          title: "Goal",
          description: "Set, replace, pause, resume, budget or inspect the session goal",
          group: "OpenCode-XGoal",
          slash: { name: "goal", arguments: true },
          palette: true,
          run: async (input?: string) => {
            try {
              await runGoal(String(input ?? ""));
            } catch (error) {
              notify(`Goal command failed: ${String(error)}`, "error", currentSessionID());
            }
          },
        },
      ],
    }));

    return async () => {
      /* the keymap layer is removed when the plugin deactivates */
    };
  },
});
