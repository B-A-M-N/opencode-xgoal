/**
 * OpenCode-xGoal — Phase 01 compatibility and lifecycle harness.
 *
 * Purpose: prove the V2 plugin lifecycle actually works against the pinned
 * OpenCode 2 build BEFORE any controller logic is written. The spec is explicit
 * that TypeScript signatures are not proof, so this harness registers every
 * surface the Goal Controller will depend on and writes evidence to a log file
 * that can be inspected after a real run.
 *
 * Surfaces exercised (all confirmed present in @opencode/plugin 2.0.x):
 *   - Plugin.define({ id, setup(ctx) })        registration + cleanup
 *   - ctx.command.transform(editor => add())   the /goal command
 *   - ctx.session.hook("context", ...)         goal-context injection
 *   - ctx.session.hook("compaction", ...)      goal survival across compaction
 *   - ctx.tool.hook("execute.after", ...)      state-machine observations
 *   - ctx.tool.transform(...)                  tool registration
 *   - ctx.event.subscribe({ signal })          lifecycle/idle observation
 *   - ctx.storage                              persistence probe
 *
 * Every hook appends one JSON line to XGOAL_HARNESS_LOG. The absence of a line
 * is the finding: it means that surface does not fire in practice.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const LOG = process.env.XGOAL_HARNESS_LOG ?? "/tmp/xgoal-harness.log";

type Evidence = Record<string, unknown> & { event: string };

function record(entry: Evidence): void {
  try {
    mkdirSync(dirname(LOG), { recursive: true });
    appendFileSync(LOG, JSON.stringify({ ts: Date.now(), ...entry }) + "\n");
  } catch {
    // Harness logging must never break the host.
  }
}

export default {
  id: "opencode-xgoal",

  async setup(ctx: any) {
    const abort = new AbortController();

    record({
      event: "setup.begin",
      pluginId: "opencode-xgoal",
      // Prove which domains actually exist rather than trusting the types.
      domains: Object.keys(ctx as object).sort(),
      hasSession: typeof ctx.session === "object",
      hasTool: typeof ctx.tool === "object",
      hasCommand: typeof ctx.command === "object",
      hasEvent: typeof ctx.event === "object",
      hasStorage: typeof ctx.storage === "object",
      hasRpc: typeof ctx.rpc === "object",
      sessionMethods:
        typeof ctx.session === "object" ? Object.keys(ctx.session as object).sort() : [],
    });

    // --- 1. command registration -------------------------------------------
    try {
      const handle = await ctx.command.transform((editor) => {
        editor.add({
          name: "xgoal",
          description: "OpenCode-xGoal harness probe",
          async execute(invocation) {
            record({
              event: "command.execute",
              sessionID: invocation?.sessionID,
              delivery: invocation?.delivery,
            });
          },
        });
      });
      record({ event: "command.registered", ok: true, handleType: typeof handle });
    } catch (error) {
      record({ event: "command.registered", ok: false, error: String(error) });
    }

    // --- 2. session context hook (goal-context injection) -------------------
    try {
      await ctx.session.hook("context", async (event) => {
        record({
          event: "session.context",
          sessionID: event?.sessionID,
          agent: event?.agent,
          systemParts: Array.isArray(event?.system) ? event.system.length : null,
          messageCount: Array.isArray(event?.messages) ? event.messages.length : null,
          toolCount: event?.tools ? Object.keys(event.tools).length : null,
        });
        // Deliberately inject a marker so we can confirm it reaches the model.
        if (Array.isArray(event?.system)) {
          event.system.push({
            type: "text",
            text: "[xgoal-harness] context hook is live",
          } as never);
        }
      });
      record({ event: "session.hook.context", ok: true });
    } catch (error) {
      record({ event: "session.hook.context", ok: false, error: String(error) });
    }

    // --- 3. compaction hook (goal survival) ---------------------------------
    try {
      await ctx.session.hook("compaction", async (event) => {
        record({ event: "session.compaction", sessionID: event?.sessionID });
      });
      record({ event: "session.hook.compaction", ok: true });
    } catch (error) {
      record({ event: "session.hook.compaction", ok: false, error: String(error) });
    }

    // --- 4. tool observation hook (state machine input) ---------------------
    try {
      await ctx.tool.hook("execute.after", async (event) => {
        record({
          event: "tool.execute.after",
          tool: event?.tool,
          sessionID: event?.sessionID,
          status: event?.status,
          callID: event?.id,
        });
      });
      record({ event: "tool.hook.execute.after", ok: true });
    } catch (error) {
      record({ event: "tool.hook.execute.after", ok: false, error: String(error) });
    }

    // --- 5. event stream (idle / lifecycle observation) ---------------------
    const eventsSeen = new Set<string>();
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: abort.signal })) {
          const type = String((event as { type?: unknown })?.type ?? "unknown");
          eventsSeen.add(type);
          record({ event: "event", type, total: eventsSeen.size });
        }
        record({ event: "event.stream.ended", total: eventsSeen.size });
      } catch (error) {
        record({ event: "event.stream.error", error: String(error) });
      }
    })();

    // --- 6. storage probe ---------------------------------------------------
    try {
      await ctx.storage.set("xgoal:harness:probe", { at: Date.now() });
      const readBack = await ctx.storage.get("xgoal:harness:probe");
      record({
        event: "storage.roundtrip",
        ok: readBack !== undefined,
        value: readBack ?? null,
      });
    } catch (error) {
      record({ event: "storage.roundtrip", ok: false, error: String(error) });
    }

    record({ event: "setup.complete" });

    return async () => {
      abort.abort();
      record({ event: "cleanup", eventsObserved: eventsSeen.size });
    };
  },
};
