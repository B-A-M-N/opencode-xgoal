var __defProp = Object.defineProperty;
var __returnValue = (v) => v;
function __exportSetter(name, newValue) {
  this[name] = __returnValue.bind(null, newValue);
}
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, {
      get: all[name],
      enumerable: true,
      configurable: true,
      set: __exportSetter.bind(all, name)
    });
};

// node_modules/@opencode/plugin/dist/tui/plugin.js
var exports_plugin = {};
__export(exports_plugin, {
  define: () => define
});
function define(plugin) {
  return plugin;
}
// node_modules/solid-js/dist/server.js
var $PROXY = Symbol("solid-proxy");
var $TRACK = Symbol("solid-track");
var $DEVCOMP = Symbol("solid-dev-component");
var ERROR = Symbol("error");
function castError(err) {
  if (err instanceof Error)
    return err;
  return new Error(typeof err === "string" ? err : "Unknown error", {
    cause: err
  });
}
function handleError(err, owner = Owner) {
  const fns = owner && owner.context && owner.context[ERROR];
  const error = castError(err);
  if (!fns)
    throw error;
  try {
    for (const f of fns)
      f(error);
  } catch (e) {
    handleError(e, owner && owner.owner || null);
  }
}
var Owner = null;
function createOwner() {
  const o = {
    owner: Owner,
    context: Owner ? Owner.context : null,
    owned: null,
    cleanups: null
  };
  if (Owner) {
    if (!Owner.owned)
      Owner.owned = [o];
    else
      Owner.owned.push(o);
  }
  return o;
}
function createMemo(fn, value) {
  Owner = createOwner();
  let v;
  try {
    v = fn(value);
  } catch (err) {
    handleError(err);
  } finally {
    Owner = Owner.owner;
  }
  return () => v;
}
function createContext(defaultValue) {
  const id = Symbol("context");
  return {
    id,
    Provider: createProvider(id),
    defaultValue
  };
}
function children(fn) {
  const memo = createMemo(() => resolveChildren(fn()));
  memo.toArray = () => {
    const c = memo();
    return Array.isArray(c) ? c : c != null ? [c] : [];
  };
  return memo;
}
function resolveChildren(children2) {
  if (typeof children2 === "function" && !children2.length)
    return resolveChildren(children2());
  if (Array.isArray(children2)) {
    const results = [];
    for (let i = 0;i < children2.length; i++) {
      const result = resolveChildren(children2[i]);
      Array.isArray(result) ? results.push.apply(results, result) : results.push(result);
    }
    return results;
  }
  return children2;
}
function createProvider(id) {
  return function provider(props) {
    return createMemo(() => {
      Owner.context = {
        ...Owner.context,
        [id]: props.value
      };
      return children(() => props.children);
    });
  };
}
var SuspenseContext = createContext();

// node_modules/@opencode/plugin/dist/tui/solid.js
var PluginContext = createContext();
// src/rpc.ts
var RPC_ID = "local.opencode-xgoal";
var str = { type: "string" };
var num = { type: "number" };
var goalOrNull = {
  anyOf: [{ type: "object" }, { type: "null" }]
};
var goalRpcDefinition = {
  id: RPC_ID,
  methods: {
    "goal.status": {
      input: { type: "object", properties: { sessionID: str }, required: ["sessionID"] },
      output: {
        type: "object",
        properties: { current: goalOrNull, latest: goalOrNull, goal: goalOrNull }
      }
    },
    "goal.history": {
      input: { type: "object", properties: { sessionID: str }, required: ["sessionID"] },
      output: {
        type: "object",
        properties: { goals: { type: "array", items: { type: "object" } } }
      }
    },
    "goal.create": {
      input: {
        type: "object",
        properties: { sessionID: str, objective: str },
        required: ["sessionID", "objective"]
      },
      output: { type: "object", properties: { goal: goalOrNull, error: str, drive: { type: "object" } } }
    },
    "goal.replace": {
      input: {
        type: "object",
        properties: {
          sessionID: str,
          objective: str,
          expectedGeneration: num
        },
        required: ["sessionID", "objective", "expectedGeneration"]
      },
      output: { type: "object", properties: { goal: goalOrNull, error: str } }
    },
    "goal.pause": {
      input: { type: "object", properties: { sessionID: str }, required: ["sessionID"] },
      output: { type: "object", properties: { goal: goalOrNull } }
    },
    "goal.resume": {
      input: { type: "object", properties: { sessionID: str }, required: ["sessionID"] },
      output: { type: "object", properties: { goal: goalOrNull, error: str } }
    },
    "goal.accept": {
      input: {
        type: "object",
        properties: {
          sessionID: str,
          note: str,
          goalID: str,
          expectedGeneration: num
        },
        required: ["sessionID"]
      },
      output: { type: "object", properties: { goal: goalOrNull, error: str } }
    },
    "goal.health": {
      input: { type: "object", properties: { sessionID: str }, required: ["sessionID"] },
      output: { type: "object", properties: { health: { type: "object" } } }
    },
    "goal.budget": {
      input: {
        type: "object",
        properties: { sessionID: str, budget: num },
        required: ["sessionID"]
      },
      output: { type: "object", properties: { goal: goalOrNull, error: str } }
    }
  },
  events: {
    "goal.changed": {
      schema: {
        type: "object",
        properties: { sessionID: str, status: str, generation: num }
      }
    }
  }
};

// src/tui.tsx
function describeDrive(outcome) {
  if (!outcome)
    return "the server did not report a dispatch";
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
function describeError(error) {
  if (error instanceof Error)
    return error.message;
  if (typeof error === "string")
    return error;
  if (error && typeof error === "object") {
    const value = error;
    if (typeof value.message === "string")
      return value.message;
    if (typeof value.data === "string")
      return value.data;
    try {
      return JSON.stringify(error) ?? Object.prototype.toString.call(error);
    } catch {
      return Object.prototype.toString.call(error);
    }
  }
  return String(error);
}
function createGoalCommand(host) {
  const { rpc, dialogConfirm, notify } = host;
  const currentSessionID = host.currentSessionID;
  const statusText = (current, latest) => {
    const budget = (goal) => goal.tokenBudget === null ? `${goal.tokensUsed ?? 0} tokens` : `${goal.tokensUsed ?? 0}/${goal.tokenBudget} tokens`;
    if (!current && latest) {
      return [
        `[${latest.status}] generation ${latest.generation}: ${latest.objective}`,
        `rounds ${latest.rounds}, ${budget(latest)}`,
        `No goal in progress. Use /goal <objective> to start the next one.`
      ].join(`
`);
    }
    if (!current)
      return "No active goal. Use /goal <objective>.";
    return [
      `[${current.status}] generation ${current.generation}: ${current.objective}`,
      `rounds ${current.rounds}, no-progress ${current.noProgressRounds}, ${budget(current)}`,
      ...current.status === "verifying" ? [`Machine verification is blocked; run /goal accept to record acceptance.`] : []
    ].join(`
`);
  };
  const replaceGoal = async (sessionID, objective, expectedGeneration) => {
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
      notify(`Could not set the goal: ${res.error}`, "error", sessionID);
      return;
    }
    notify(`Goal set (generation ${res.goal?.generation ?? "?"}). ${describeDrive(res.drive)}.`, "success", sessionID);
  };
  const createGoal = async (sessionID, objective) => {
    const res = await rpc["goal.create"]({ sessionID, objective });
    if (res.error) {
      notify(`Could not create the goal: ${res.error}`, "error", sessionID);
      return;
    }
    notify(`Goal created (generation ${res.goal?.generation ?? "?"}). ${describeDrive(res.drive)}.`, "success", sessionID);
  };
  const runGoal = async (raw) => {
    const text = String(raw ?? "").trim();
    const [verb, ...rest] = text.split(/\s+/);
    const arg = rest.join(" ").trim();
    let sessionID = currentSessionID();
    const sessionlessVerb = new Set(["status", "pause", "resume", "replace", "budget", "accept", "health"]);
    if (!sessionID && text && !sessionlessVerb.has(verb.toLowerCase())) {
      sessionID = await host.createSession?.();
    }
    if (!sessionID) {
      notify("Open a session before using /goal.", "warning");
      return;
    }
    if (!text || verb === "status") {
      const res = await rpc["goal.status"]({ sessionID });
      notify(statusText(res.current, res.latest), "info", sessionID);
      return;
    }
    if (verb === "pause" || verb === "resume") {
      const res = verb === "pause" ? await rpc["goal.pause"]({ sessionID }) : await rpc["goal.resume"]({ sessionID });
      if (res.error) {
        notify(`Could not ${verb} the goal: ${res.error}`, "error", sessionID);
        return;
      }
      const suffix = verb === "resume" ? ` ${describeDrive(res.drive)}.` : "";
      notify(verb === "pause" ? "Goal paused." : `Goal resumed: ${res.goal?.status ?? "active"}.${suffix}`, "success", sessionID);
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
        notify(current.tokenBudget === null ? `Tokens: ${current.tokensUsed ?? 0} (no budget set)` : `Tokens: ${current.tokensUsed ?? 0} / ${current.tokenBudget}`, "info", sessionID);
        return;
      }
      if (/^(off|none|clear)$/i.test(arg)) {
        const res2 = await rpc["goal.budget"]({ sessionID });
        notify(res2.error ? `Could not clear the budget: ${res2.error}` : "Token budget cleared.", res2.error ? "error" : "success", sessionID);
        return;
      }
      const n = Number(arg);
      if (!Number.isFinite(n) || n <= 0) {
        notify("Usage: /goal budget <positive number> | off", "error", sessionID);
        return;
      }
      const res = await rpc["goal.budget"]({ sessionID, budget: Math.floor(n) });
      notify(res.error ? `Could not set the budget: ${res.error}` : `Token budget set to ${Math.floor(n)}.`, res.error ? "error" : "success", sessionID);
      return;
    }
    if (verb === "accept") {
      const seen = (await rpc["goal.status"]({ sessionID })).current;
      const res = await rpc["goal.accept"]({
        sessionID,
        note: arg || undefined,
        goalID: seen?.id,
        expectedGeneration: seen?.generation
      });
      if (res.error && /stale confirmation/i.test(res.error)) {
        const now = (await rpc["goal.status"]({ sessionID })).current;
        notify(`Acceptance rejected: the goal changed while confirming. ` + `The current objective (generation ${now?.generation ?? "?"}) needs fresh review: ${now?.objective ?? "none"}.`, "warning", sessionID);
        return;
      }
      notify(res.error ? `Could not record acceptance: ${res.error}` : "Acceptance recorded for the current generation.", res.error ? "error" : "success", sessionID);
      return;
    }
    if (verb === "health") {
      const res = await rpc["goal.health"]({ sessionID });
      notify(JSON.stringify(res.health, null, 2), res.health?.ok === false ? "warning" : "info", sessionID);
      return;
    }
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
        "Set a new goal?"
      ].join(`
`),
      label: { confirm: "Replace", cancel: "Keep" }
    });
    if (confirmed !== true) {
      notify("Kept the current goal.", "info", sessionID);
      return;
    }
    await replaceGoal(sessionID, text, existing.generation);
  };
  return { runGoal };
}
var tui_default = exports_plugin.define({
  id: "opencode-xgoal-tui",
  async setup(context) {
    const rpcClient = context.client.rpc(goalRpcDefinition);
    const rpcLocation = context.location ?? context.data.location.default();
    const rpc = Object.fromEntries(Object.keys(goalRpcDefinition.methods).map((name) => [
      name,
      (input) => rpcClient[name](input, { location: rpcLocation })
    ]));
    const currentSessionID = () => {
      try {
        const route = context.ui.router.current();
        if (route.type === "session")
          return route.sessionID;
      } catch {}
      try {
        const activeTab = context.data.tabs.list().find((tab) => tab.active);
        if (activeTab)
          return activeTab.sessionID;
      } catch {}
      try {
        return context.ui.panel.current()?.sessionID;
      } catch {
        return;
      }
    };
    const { runGoal } = createGoalCommand({
      rpc,
      currentSessionID,
      createSession: async () => {
        const location = context.location ?? context.data.location.default();
        const session = await context.client.session.create({ location });
        context.ui.router.navigate({ type: "session", sessionID: session.id });
        return session.id;
      },
      dialogConfirm: (input) => context.ui.dialog.confirm(input),
      notify: (message, variant = "info", sessionID) => {
        try {
          context.ui.toast.show({ title: "OpenCode-XGoal", message, variant, sessionID });
        } catch {}
      }
    });
    const notify = (message, variant = "info", sessionID) => {
      try {
        context.ui.toast.show({ title: "OpenCode-XGoal", message, variant, sessionID });
      } catch {}
    };
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
          run: async (input) => {
            try {
              await runGoal(String(input ?? ""));
            } catch (error) {
              notify(`Goal command failed: ${describeError(error)}`, "error", currentSessionID());
            }
          }
        }
      ]
    }));
    return async () => {};
  }
});
export {
  tui_default as default,
  createGoalCommand
};
