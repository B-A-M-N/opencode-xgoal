/**
 * OpenCode-XGoal — plugin entry.
 *
 * A session-native Goal Controller for OpenCode 2. The controller owns goal
 * status, continuation and completion; the model proposes, it does not decide.
 *
 * Load-shape constraints (observed, see README):
 *   - must export a plain `{ id, setup }` object
 *   - must not import bare specifiers (this file is bundled to ./index.js)
 *   - the entry must sit at the package root (`main: "index.js"`)
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { GoalController } from "./controller/controller.ts";

const LOG = process.env.XGOAL_HARNESS_LOG ?? "";

type Evidence = Record<string, unknown> & { event: string };

/** Structured evidence trail. Only active when XGOAL_HARNESS_LOG is set. */
function record(entry: Evidence): void {
  if (!LOG) return;
  try {
    mkdirSync(dirname(LOG), { recursive: true });
    appendFileSync(LOG, JSON.stringify({ ts: Date.now(), ...entry }) + "\n");
  } catch {
    // Evidence logging must never break the host.
  }
}

function dbPath(): string {
  if (process.env.XGOAL_DB) return process.env.XGOAL_DB;
  const dataHome = process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
  return join(dataHome, "opencode-xgoal", "goals.db");
}

/** JSON Schema object input, as required by the V2 tool API. */
function obj(
  properties: Record<string, unknown>,
  required: string[] = [],
): Record<string, unknown> {
  return { type: "object", properties, required, additionalProperties: false };
}

const str = { type: "string" } as const;
const strArray = { type: "array", items: { type: "string" } } as const;
const num = { type: "number" } as const;

export default {
  id: "opencode-xgoal",

  async setup(ctx: any) {
    const abort = new AbortController();
    let controller: GoalController | undefined;
    let startupError: string | undefined;

    try {
      mkdirSync(dirname(dbPath()), { recursive: true });
      controller = new GoalController({ dbPath: dbPath() });
      const repaired = controller.reconcileStartup();
      record({ event: "controller.ready", dbPath: dbPath(), reconciled: repaired.length });
    } catch (error) {
      startupError = String(error);
      record({ event: "controller.failed", error: startupError });
    }

    record({
      event: "setup.begin",
      pluginId: "opencode-xgoal",
      domains: Object.keys(ctx ?? {}).sort(),
      sessionMethods: typeof ctx?.session === "object" ? Object.keys(ctx.session).sort() : [],
      controllerReady: controller !== undefined,
    });

    // ---------------------------------------------------------------- tools
    try {
      await ctx.tool.transform((editor: any) => {
        editor.add({
          id: "goal_get",
          description:
            "Report the current goal for this session, including status, generation, round counts and unmet criteria.",
          input: obj({}),
          async execute(_input: any, toolCtx: any) {
            if (!controller) return { content: `goal controller unavailable: ${startupError}` };
            const goal = controller.get(toolCtx?.sessionID);
            if (!goal) return { content: "No active goal for this session." };
            const criteria = controller.store.listCriteria(goal.id);
            return {
              content: JSON.stringify(
                {
                  id: goal.id,
                  generation: goal.generation,
                  objective: goal.objective,
                  status: goal.status,
                  rounds: goal.rounds,
                  noProgressRounds: goal.noProgressRounds,
                  tokensUsed: goal.tokensUsed ?? null,
                  tokenBudget: goal.tokenBudget ?? null,
                  criteria,
                },
                null,
                2,
              ),
              metadata: { goalID: goal.id, generation: goal.generation, status: goal.status },
            };
          },
        });

        editor.add({
          id: "goal_checkpoint",
          description:
            "Record progress toward the current goal without changing its status. Use for completed work, or for investigation that materially narrows the problem.",
          input: obj(
            {
              summary: str,
              evidence_refs: strArray,
              goal_id: str,
              generation: num,
            },
            ["summary"],
          ),
          async execute(input: any, toolCtx: any) {
            if (!controller) return { content: `goal controller unavailable: ${startupError}` };
            const out = controller.checkpoint(toolCtx?.sessionID, {
              summary: String(input?.summary ?? ""),
              evidenceRefs: input?.evidence_refs,
              goalID: input?.goal_id,
              generation: input?.generation,
            });
            if (!out.recorded) return { content: `Checkpoint not recorded: ${out.rejected}` };
            return {
              content: `Checkpoint recorded. Goal is ${out.goal?.status}.`,
              metadata: { status: out.goal?.status, rounds: out.goal?.rounds },
            };
          },
        });

        editor.add({
          id: "goal_propose_complete",
          description:
            "Propose that the goal's original objective has been fully achieved. This moves the goal to verification; it does not complete it. The controller decides completion.",
          input: obj({ summary: str, evidence_refs: strArray, goal_id: str, generation: num }, [
            "summary",
          ]),
          async execute(input: any, toolCtx: any) {
            if (!controller) return { content: `goal controller unavailable: ${startupError}` };
            const out = controller.proposeComplete(toolCtx?.sessionID, {
              summary: String(input?.summary ?? ""),
              evidenceRefs: input?.evidence_refs,
              goalID: input?.goal_id,
              generation: input?.generation,
            });
            if (out.rejected) return { content: `Completion proposal rejected: ${out.rejected}` };
            return {
              content:
                "Completion proposed. The goal is now under verification; it is not yet complete. Continue only if the controller returns it to active.",
              metadata: { status: out.goal?.status },
            };
          },
        });

        editor.add({
          id: "goal_report_blocked",
          description:
            "Report that the goal cannot proceed. Only use this for a genuine external dependency: missing credentials, permissions, or required information. A workflow preference, an optional decision, or a choice between reasonable next steps is NOT a blocker — continue working instead.",
          input: obj(
            {
              reason: str,
              evidence_refs: strArray,
              external_dependency: { type: "boolean" },
              goal_id: str,
              generation: num,
            },
            ["reason"],
          ),
          async execute(input: any, toolCtx: any) {
            if (!controller) return { content: `goal controller unavailable: ${startupError}` };
            const out = controller.reportBlocked(toolCtx?.sessionID, {
              reason: String(input?.reason ?? ""),
              evidenceRefs: input?.evidence_refs,
              externalDependency: input?.external_dependency === true,
              goalID: input?.goal_id,
              generation: input?.generation,
            });
            if (out.rejected) return { content: `Blocker report rejected: ${out.rejected}` };
            if (!out.accepted) {
              return {
                content:
                  "Blocker not accepted: no concrete external dependency was identified. The goal remains active — take the next useful action.",
                metadata: { confirmations: out.confirmations, status: out.goal?.status },
              };
            }
            return {
              content: "Blocker accepted. The goal is now blocked pending user action.",
              metadata: { status: out.goal?.status },
            };
          },
        });
      });
      record({ event: "tools.registered", ok: true });
    } catch (error) {
      record({ event: "tools.registered", ok: false, error: String(error) });
    }

    // -------------------------------------------------------------- command
    try {
      await ctx.command.transform((editor: any) => {
        editor.add({
          name: "goal",
          description: "Set, replace, inspect or control the session goal",
          async execute(invocation: any) {
            const sessionID = invocation?.sessionID;
            const raw = String(invocation?.prompt?.text ?? "").trim();
            if (!controller) return;

            const [verb, ...rest] = raw.split(/\s+/);
            const arg = rest.join(" ").trim();
            const reply = (text: string) =>
              record({ event: "command.reply", sessionID, text: text.slice(0, 200) });

            try {
              if (!verb) {
                const goal = controller.status(sessionID);
                reply(
                  goal
                    ? `Goal ${goal.generation}: [${goal.status}] ${goal.objective} (rounds ${goal.rounds})`
                    : "No active goal. Use /goal <objective>.",
                );
                return;
              }
              if (verb === "status") {
                const goal = controller.status(sessionID);
                reply(goal ? `[${goal.status}] ${goal.objective}` : "No active goal.");
                return;
              }
              if (verb === "history") {
                const history = controller.history(sessionID);
                reply(
                  history.length
                    ? history.map((g) => `gen ${g.generation} [${g.status}] ${g.objective}`).join("\n")
                    : "No goal history.",
                );
                return;
              }
              if (verb === "pause") {
                reply(`Paused: ${controller.pause(sessionID).status}`);
                return;
              }
              if (verb === "resume") {
                reply(`Resumed: ${controller.resume(sessionID).status}`);
                return;
              }
              if (verb === "replace") {
                if (!arg) return reply("Usage: /goal replace <objective>");
                const goal = controller.replace(sessionID, arg);
                reply(`Replaced. Generation ${goal.generation} is now active.`);
                return;
              }

              // `/goal <objective>` — start, or report that replacement is needed.
              const objective = raw;
              const out = controller.startOrDescribe(sessionID, objective);
              if ("existing" in out) {
                reply(
                  `A goal is already active (generation ${out.existing.generation}): ${out.existing.objective}\nUse /goal replace <objective> to supersede it.`,
                );
              } else {
                reply(`Goal created (generation ${out.created.generation}).`);
              }
            } catch (error) {
              reply(`Goal command failed: ${String(error)}`);
            }
          },
        });
      });
      record({ event: "command.registered", ok: true });
    } catch (error) {
      record({ event: "command.registered", ok: false, error: String(error) });
    }

    // ------------------------------------------- goal context injection
    // Concise objective + completion contract, only while a goal is active.
    try {
      await ctx.session.hook("context", async (event: any) => {
        if (!controller) return;
        const goal = controller.status(event?.sessionID);
        record({
          event: "session.context",
          sessionID: event?.sessionID,
          agent: event?.agent,
          hasGoal: Boolean(goal),
          status: goal?.status,
        });
        if (!goal || goal.status !== "active") return;
        if (!Array.isArray(event?.system)) return;
        const unmet = controller.store
          .listCriteria(goal.id)
          .filter((c) => !c.met)
          .map((c) => `- ${c.text}`);
        event.system.push({
          type: "text",
          text: [
            `Active goal (generation ${goal.generation}): ${goal.objective}`,
            "",
            "Completion contract:",
            "- The original objective is authoritative.",
            "- Inspect current evidence before claiming success.",
            "- If unfinished, take the next useful action.",
            "- A workflow preference or optional choice is not a blocker.",
            "- Propose completion only when the objective is actually satisfied.",
            unmet.length ? `\nOutstanding criteria:\n${unmet.join("\n")}` : "",
          ]
            .filter(Boolean)
            .join("\n"),
        });
      });
      record({ event: "session.hook.context", ok: true });
    } catch (error) {
      record({ event: "session.hook.context", ok: false, error: String(error) });
    }

    // ------------------------------------------------------ compaction
    try {
      await ctx.session.hook("compaction", async (event: any) => {
        if (!controller) return;
        const goal = controller.status(event?.sessionID);
        record({ event: "session.compaction", sessionID: event?.sessionID, status: goal?.status });
      });
      record({ event: "session.hook.compaction", ok: true });
    } catch (error) {
      record({ event: "session.hook.compaction", ok: false, error: String(error) });
    }

    // ------------------------------------------------- tool observations
    try {
      await ctx.tool.hook("execute.after", async (event: any) => {
        record({
          event: "tool.execute.after",
          tool: event?.tool,
          sessionID: event?.sessionID,
          status: event?.status,
        });
      });
      record({ event: "tool.hook.execute.after", ok: true });
    } catch (error) {
      record({ event: "tool.hook.execute.after", ok: false, error: String(error) });
    }

    // ------------------------------------------------------ event stream
    const eventsSeen = new Set<string>();
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: abort.signal })) {
          const type = String((event as { type?: unknown })?.type ?? "unknown");
          eventsSeen.add(type);
          record({ event: "event", type, total: eventsSeen.size });
        }
      } catch (error) {
        record({ event: "event.stream.error", error: String(error) });
      }
    })();

    record({ event: "setup.complete" });

    return async () => {
      abort.abort();
      try {
        controller?.close();
      } catch {
        /* closing twice is harmless */
      }
      record({ event: "cleanup", eventsObserved: eventsSeen.size });
    };
  },
};
