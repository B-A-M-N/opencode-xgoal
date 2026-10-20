// src/index.ts
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
var LOG = process.env.XGOAL_HARNESS_LOG ?? "/tmp/xgoal-harness.log";
function record(entry) {
  try {
    mkdirSync(dirname(LOG), { recursive: true });
    appendFileSync(LOG, JSON.stringify({ ts: Date.now(), ...entry }) + `
`);
  } catch {}
}
var src_default = {
  id: "opencode-xgoal",
  async setup(ctx) {
    const abort = new AbortController;
    record({
      event: "setup.begin",
      pluginId: "opencode-xgoal",
      domains: Object.keys(ctx).sort(),
      hasSession: typeof ctx.session === "object",
      hasTool: typeof ctx.tool === "object",
      hasCommand: typeof ctx.command === "object",
      hasEvent: typeof ctx.event === "object",
      hasStorage: typeof ctx.storage === "object",
      hasRpc: typeof ctx.rpc === "object",
      sessionMethods: typeof ctx.session === "object" ? Object.keys(ctx.session).sort() : []
    });
    try {
      const handle = await ctx.command.transform((editor) => {
        editor.add({
          name: "xgoal",
          description: "OpenCode-xGoal harness probe",
          async execute(invocation) {
            record({
              event: "command.execute",
              sessionID: invocation?.sessionID,
              delivery: invocation?.delivery
            });
          }
        });
      });
      record({ event: "command.registered", ok: true, handleType: typeof handle });
    } catch (error) {
      record({ event: "command.registered", ok: false, error: String(error) });
    }
    try {
      await ctx.session.hook("context", async (event) => {
        record({
          event: "session.context",
          sessionID: event?.sessionID,
          agent: event?.agent,
          systemParts: Array.isArray(event?.system) ? event.system.length : null,
          messageCount: Array.isArray(event?.messages) ? event.messages.length : null,
          toolCount: event?.tools ? Object.keys(event.tools).length : null
        });
        if (Array.isArray(event?.system)) {
          event.system.push({
            type: "text",
            text: "[xgoal-harness] context hook is live"
          });
        }
      });
      record({ event: "session.hook.context", ok: true });
    } catch (error) {
      record({ event: "session.hook.context", ok: false, error: String(error) });
    }
    try {
      await ctx.session.hook("compaction", async (event) => {
        record({ event: "session.compaction", sessionID: event?.sessionID });
      });
      record({ event: "session.hook.compaction", ok: true });
    } catch (error) {
      record({ event: "session.hook.compaction", ok: false, error: String(error) });
    }
    try {
      await ctx.tool.hook("execute.after", async (event) => {
        record({
          event: "tool.execute.after",
          tool: event?.tool,
          sessionID: event?.sessionID,
          status: event?.status,
          callID: event?.id
        });
      });
      record({ event: "tool.hook.execute.after", ok: true });
    } catch (error) {
      record({ event: "tool.hook.execute.after", ok: false, error: String(error) });
    }
    const eventsSeen = new Set;
    (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: abort.signal })) {
          const type = String(event?.type ?? "unknown");
          eventsSeen.add(type);
          record({ event: "event", type, total: eventsSeen.size });
        }
        record({ event: "event.stream.ended", total: eventsSeen.size });
      } catch (error) {
        record({ event: "event.stream.error", error: String(error) });
      }
    })();
    try {
      await ctx.storage.set("xgoal:harness:probe", { at: Date.now() });
      const readBack = await ctx.storage.get("xgoal:harness:probe");
      record({
        event: "storage.roundtrip",
        ok: readBack !== undefined,
        value: readBack ?? null
      });
    } catch (error) {
      record({ event: "storage.roundtrip", ok: false, error: String(error) });
    }
    record({ event: "setup.complete" });
    return async () => {
      abort.abort();
      record({ event: "cleanup", eventsObserved: eventsSeen.size });
    };
  }
};
export {
  src_default as default
};
