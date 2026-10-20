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
// src/tui.tsx
var tui_default = exports_plugin.define({
  id: "opencode-xgoal-tui",
  async setup(context) {
    const notify = (message, variant = "info") => {
      try {
        context?.toast?.show?.({ variant, title: "OpenCode-XGoal", message });
      } catch {}
    };
    const rpc = context?.rpc;
    const callStatus = async (sessionID) => await rpc?.call?.("goal.status", { sessionID });
    const handleGoalCommand = async (sessionID, args) => {
      const text = String(args ?? "").trim();
      if (!text || text === "status") {
        const res = await callStatus(sessionID);
        const goal = res?.goal;
        notify(goal ? `[${goal.status}] generation ${goal.generation}: ${goal.objective}` : "No active goal. Use /goal <objective>.");
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
          "Set a new goal?"
        ].join(`
`),
        label: "Replace"
      });
      if (confirmed !== true) {
        notify("Kept the current goal.");
        return;
      }
      await replaceGoal(sessionID, text, existing.generation);
    };
    const replaceGoal = async (sessionID, objective, expectedGeneration) => {
      let expected = expectedGeneration;
      if (expected === undefined) {
        const current = (await callStatus(sessionID))?.goal;
        expected = current?.generation ?? 1;
      }
      const res = await rpc?.call?.("goal.replace", {
        sessionID,
        objective,
        expectedGeneration: expected
      });
      if (res?.error) {
        notify(`Could not set the goal: ${res.error}`, "error");
        return;
      }
      notify(`Goal set (generation ${res?.goal?.generation ?? "?"}).`);
    };
    try {
      const command = context?.command;
      if (command?.register) {
        command.register({
          name: "goal",
          title: "Set or replace the session goal",
          description: "OpenCode-XGoal: set, replace, pause, resume or inspect the goal",
          slash: { name: "goal" },
          palette: true,
          run: async (input) => {
            if (!input?.sessionID)
              return;
            await handleGoalCommand(input.sessionID, input.arguments ?? "");
          }
        });
      }
    } catch {}
    return async () => {};
  }
});
export {
  tui_default as default
};
