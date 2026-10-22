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
 *   - `/goal <objective>` with no current (nonterminal) goal starts immediately
 *   - with a goal in progress, show a confirmation (a completed goal is
 *     history: it never triggers "Replace goal?")
 *   - default selection is Replace; Enter confirms; Escape cancels
 *   - pause/resume/budget/accept/health are available without a second command
 */
import { Plugin } from "@opencode/plugin/tui";
import { goalRpcDefinition, type GoalWire } from "./rpc.ts";

/** The RPC surface this companion uses, inferred from the shared definition. */
export interface GoalRpc {
  "goal.status": (input: {
    sessionID: string;
  }) => Promise<{ current: GoalWire | null; latest: GoalWire | null }>;
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
  "goal.accept": (input: {
    sessionID: string;
    note?: string;
    goalID?: string;
    expectedGeneration?: number;
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
    case "stale":
      return `stale admission cancelled: ${outcome.detail}`;
    case "limited":
      return `not dispatched: goal is ${outcome.status}`;
    case "waiting":
      return `waiting on a background execution: ${outcome.reason}`;
    case "idle":
      return `not dispatched: ${outcome.reason}`;
    default:
      return `dispatch: ${String(outcome.action)}`;
  }
}

/**
 * Build the `/goal` command handler against an injected host surface.
 *
 * Extracted from the plugin's `setup` so the keyboard-flow contract — Enter
 * confirms the replacement, Escape keeps the current goal, a confirmation
 * rendered against generation N can never clobber N+1 (it is fenced and the
 * UI refreshes on rejection) — is testable without a live TUI. The live
 * interactive qualification (scripts/qualify.sh) covers the real keymap.
 */
export function createGoalCommand(host: {
  rpc: GoalRpc;
  /** Resolve the session the user is currently viewing. */
  currentSessionID: () => string | undefined;
  /** The host dialog: Enter resolves true, Escape resolves false/undefined. */
  dialogConfirm: (input: { title: string; message: string; label: { confirm: string; cancel: string } }) => Promise<boolean | undefined>;
  notify: (message: string, variant?: "info" | "success" | "warning" | "error", sessionID?: string) => void;
}) {
  const { rpc, dialogConfirm, notify } = host;

  const currentSessionID = host.currentSessionID;

    const statusText = (
      current: GoalWire | null,
      latest: GoalWire | null,
    ): string => {
      // A completed goal is history, not an obstacle: say so and point at how
      // to start the next one instead of implying a goal is still active.
      const budget = (goal: GoalWire) =>
        goal.tokenBudget === null
          ? `${goal.tokensUsed ?? 0} tokens`
          : `${goal.tokensUsed ?? 0}/${goal.tokenBudget} tokens`;
      if (!current && latest) {
        return [
          `[${latest.status}] generation ${latest.generation}: ${latest.objective}`,
          `rounds ${latest.rounds}, ${budget(latest)}`,
          `No goal in progress. Use /goal <objective> to start the next one.`,
        ].join("\n");
      }
      if (!current) return "No active goal. Use /goal <objective>.";
      return [
        `[${current.status}] generation ${current.generation}: ${current.objective}`,
        `rounds ${current.rounds}, no-progress ${current.noProgressRounds}, ${budget(current)}`,
        ...(current.status === "verifying"
          ? [`Machine verification is blocked; run /goal accept to record acceptance.`]
          : []),
      ].join("\n");
    };

    const replaceGoal = async (
      sessionID: string,
      objective: string,
      expectedGeneration?: number,
    ) => {
      let expected = expectedGeneration;
      if (expected === undefined) {
        const current = (await rpc["goal.status"]({ sessionID })).current;
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
        notify(statusText(res.current, res.latest), "info", sessionID);
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
        const current = (await rpc["goal.status"]({ sessionID })).current;
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

      if (verb === "accept") {
        // Capture the goal the user is confirming (audit-4 #12): the fencing
        // pair must describe what the user SAW, so a replacement between the
        // user's decision and the RPC round-trip is rejected instead of
        // silently accepting the replacement's objective. On rejection the
        // current goal is fetched so the UI shows what actually needs review.
        const seen = (await rpc["goal.status"]({ sessionID })).current;
        const res = await rpc["goal.accept"]({
          sessionID,
          note: arg || undefined,
          goalID: seen?.id,
          expectedGeneration: seen?.generation,
        });
        if (res.error && /stale confirmation/i.test(res.error)) {
          const now = (await rpc["goal.status"]({ sessionID })).current;
          notify(
            `Acceptance rejected: the goal changed while confirming. ` +
              `The current objective (generation ${now?.generation ?? "?"}) needs fresh review: ${now?.objective ?? "none"}.`,
            "warning",
            sessionID,
          );
          return;
        }
        notify(
          res.error ? `Could not record acceptance: ${res.error}` : "Acceptance recorded for the current generation.",
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
      // Only a goal in progress can be replaced; a completed one is history.
      const existing = (await rpc["goal.status"]({ sessionID })).current;
      if (!existing) {
        await createGoal(sessionID, text);
        return;
      }

      const confirmed = await dialogConfirm({
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

    return { runGoal };
  };

export default Plugin.define({
  id: "opencode-xgoal-tui",

  async setup(context: Plugin.Context) {
    const rpc = context.client.rpc(goalRpcDefinition) as unknown as GoalRpc;
    const { runGoal } = createGoalCommand({
      rpc,
      currentSessionID: () => {
        const route = context.ui.router.current();
        return route.type === "session" ? route.sessionID : undefined;
      },
      dialogConfirm: (input) => context.ui.dialog.confirm(input),
      notify: (message, variant = "info", sessionID) => {
        try {
          context.ui.toast.show({ title: "OpenCode-XGoal", message, variant, sessionID });
        } catch {
          /* toasts are advisory */
        }
      },
    });
    const currentSessionID = () => {
      const route = context.ui.router.current();
      return route.type === "session" ? route.sessionID : undefined;
    };
    const notify = (message: string, variant: "info" | "success" | "warning" | "error" = "info", sessionID?: string) => {
      try {
        context.ui.toast.show({ title: "OpenCode-XGoal", message, variant, sessionID });
      } catch {
        /* toasts are advisory */
      }
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
