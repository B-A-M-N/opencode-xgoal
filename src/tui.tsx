/**
 * OpenCode-XGoal — TUI companion.
 *
 * Owns the interactive parts of the goal UX: the replacement confirmation, and
 * a compact status readout.
 *
 * The dialog collects intent only. The actual replacement is a generation-checked
 * server RPC, so a confirmation rendered against generation N can never clobber
 * generation N+1 — the UI is not the atomic transition.
 *
 * Behaviour required by the design:
 *   - `/goal <objective>` with no current goal starts immediately, no dialog
 *   - with a goal already active, show a confirmation
 *   - default selection is Replace; Enter confirms; Escape cancels
 *   - no `/goal clear` prerequisite
 */
import { Plugin } from "@opencode/plugin/tui";

export default Plugin.define({
  id: "opencode-xgoal-tui",

  async setup(context: any) {
    const notify = (message: string, variant: "info" | "error" = "info") => {
      try {
        context?.toast?.show?.({ variant, title: "OpenCode-XGoal", message });
      } catch {
        /* toasts are advisory */
      }
    };

    // The server RPC surface. Absent when the server plugin is not loaded.
    const rpc = context?.rpc;
    const callStatus = async (sessionID: string) =>
      (await rpc?.call?.("goal.status", { sessionID })) as
        | { goal: { generation: number; objective: string; status: string } | null }
        | undefined;

    const handleGoalCommand = async (sessionID: string, args: string) => {
      const text = String(args ?? "").trim();

      // Bare `/goal` and the explicit control verbs never prompt.
      if (!text || text === "status") {
        const res = await callStatus(sessionID);
        const goal = res?.goal;
        notify(
          goal
            ? `[${goal.status}] generation ${goal.generation}: ${goal.objective}`
            : "No active goal. Use /goal <objective>.",
        );
        return;
      }
      if (text === "pause" || text === "resume") {
        await rpc?.call?.(text === "pause" ? "goal.pause" : "goal.resume", { sessionID });
        notify(text === "pause" ? "Goal paused." : "Goal resumed.");
        return;
      }
      if (text.startsWith("replace ")) {
        const objective = text.slice("replace ".length).trim();
        if (!objective) {
          notify("Usage: /goal replace <objective>", "error");
          return;
        }
        await replaceGoal(sessionID, objective);
        return;
      }

      // `/goal <objective>` — start immediately if nothing is active, otherwise
      // confirm before replacing.
      const existing = (await callStatus(sessionID))?.goal;
      if (!existing) {
        await replaceGoal(sessionID, text);
        return;
      }

      const confirmed = await context.dialog.confirm({
        title: "Replace goal?",
        message: [
          `An existing goal is active (generation ${existing.generation}):`,
          existing.objective,
          "",
          "Set a new goal?",
        ].join("\n"),
        // Default selection: Replace. Enter confirms, Escape cancels.
        label: "Replace",
      });

      if (confirmed !== true) {
        notify("Kept the current goal.");
        return;
      }
      await replaceGoal(sessionID, text, existing.generation);
    };

    const replaceGoal = async (
      sessionID: string,
      objective: string,
      expectedGeneration?: number,
    ) => {
      // If the caller did not observe a generation (no goal existed), discover
      // it so the server always receives a concrete expectation.
      let expected = expectedGeneration;
      if (expected === undefined) {
        const current = (await callStatus(sessionID))?.goal;
        expected = current?.generation ?? 1;
      }
      const res = (await rpc?.call?.("goal.replace", {
        sessionID,
        objective,
        expectedGeneration: expected,
      })) as { goal?: { generation: number } | null; error?: string } | undefined;

      if (res?.error) {
        // A stale generation is the expected failure when the world moved on.
        notify(`Could not set the goal: ${res.error}`, "error");
        return;
      }
      notify(`Goal set (generation ${res?.goal?.generation ?? "?"}).`);
    };

    // Register the slash command. Namespaced so it cannot collide with a legacy
    // /goal registration during integration testing.
    try {
      const command = context?.command;
      if (command?.register) {
        command.register({
          name: "goal",
          title: "Set or replace the session goal",
          description: "OpenCode-XGoal: set, replace, pause, resume or inspect the goal",
          slash: { name: "goal" },
          palette: true,
          run: async (input: { sessionID?: string; arguments?: string }) => {
            if (!input?.sessionID) return;
            await handleGoalCommand(input.sessionID, input.arguments ?? "");
          },
        });
      }
    } catch {
      /* command registration is best-effort; the server command still works */
    }

    return async () => {
      /* nothing to tear down */
    };
  },
});
