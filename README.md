# OpenCode-XGoal

A session-native **Goal Controller** for OpenCode 2, reproducing Codex's Goal
behavioural contract — persistent objective, host-controlled continuation,
evidence-gated completion — using OpenCode 2's supported plugin interfaces.

Status: **Phase 01 (V2 compatibility and lifecycle harness) complete.**
The controller itself is not implemented yet; see [Roadmap](#roadmap).

---

## Phase 01 findings — observed on the tested environment

Everything below was observed by running a real plugin against a real OpenCode 2
build (`opencode v2.0.31` standalone), not by reading type signatures. These are
**observed behaviours of this environment**, not asserted universal properties of
OpenCode 2 — later releases may differ, and each should be re-checked against a
pinned build rather than assumed.

Two of these contradict the obvious reading of the API and both cost real time
to discover, so they are recorded first.

### 1. The V2 plugin API is `@opencode/plugin`, not `@opencode-ai/plugin`

V2 plugins are a plain default export:

```js
export default {
  id: "opencode-xgoal",
  async setup(ctx) { /* ... */ },
};
```

`@opencode-ai/plugin` (the `Hooks` interface with `chat.message`,
`tool.execute.before`, `experimental.*`) is the **V1** API. It does not apply.
Notably, `experimental.text.complete` has **no V2 equivalent** — there is no
text-mutating hook at all, so any design that relies on rewriting the model's
final answer is not implementable here.

### 2. Plugin entries must NOT import anything from `node_modules`

This is the single most expensive finding. A plugin that imports a bare
specifier (including `@opencode/plugin` itself) **fails to load, silently** —
no error, no warning, no log line. The plugin is simply absent.

- A zero-import plugin loads and runs.
- The same plugin with `import { Plugin } from "@opencode/plugin"` never runs.

OpenCode loads plugin entries in its own runtime where bare specifiers do not
resolve. Always ship a **bundled, self-contained** entry.

### 3. The entry file must be at the package root

`main` must point at a file in the package root. `main: "index.js"` loads;
`main: "dist/index.js"` **does not load, silently**.

This is why a plugin declared in config can be present and yet never run.
`~/.config/opencode/plugins/sandbox` is declared in `opencode.json` but uses
`main: "dist/index.js"` and therefore never loads — it does not appear in
`opencode plugin list`.

### 4. How plugins are actually discovered

- Discovery directories are `<config>/plugins/` and `~/.opencode/plugins/`.
- A plugin is a **directory** in one of those. A file path is rejected with
  `configured plugin path must be a directory`.
- `plugins` in `cli.json` is an **enable/filter** list, not a load list.
  `"*"` enables everything discovered; `"-name"` disables.
- A non-existent path produces `failed to load plugin`; a broken module does not.

### 5. The V2 `ctx` surface (verified live, 26 domains)

```
agent aisdk app command credential event experimental generate integration
location mcp model options permission plugin provider reference rpc session
shell skill storage tool vcs websearch worktree
```

`ctx.session` methods, verified live:

```
command compact context create generate get hook interrupt move
prompt remove switchAgent switchModel synthetic update wait
```

### 6. The hooks the controller depends on all exist and fire

| Hook | Verified behaviour |
|---|---|
| `ctx.command.transform(e => e.add({name, description, execute}))` | registers `/goal` |
| `ctx.session.hook("context", fn)` | fires per model call; `system[]` is injectable |
| `ctx.session.hook("compaction", fn)` | fires on compaction |
| `ctx.tool.hook("execute.after", fn)` | fires per tool result, with status |
| `ctx.event.subscribe({signal})` | async iterable; 34 event types observed |
| `ctx.storage` | `get/set/remove/scan` round-trip works |

`context` hook observed payload: `agent="build"`, `systemParts=4`,
`messageCount=1`, `toolCount=12`.

### 7. The event stream supports the intended continuation design

The design requires durable, idempotent continuation rather than a
fire-and-forget prompt. The event stream provides exactly that:

```
session.inbox.enqueued        durable admission of a synthetic message
session.inbox.delivered       delivery confirmation
session.execution.started     round lifecycle: running
session.execution.succeeded   round lifecycle: settled
session.tool.called / .success
session.usage.updated         token accounting
```

Combined with `SessionInbox.Delivery = "steer" | "queue"` and a caller-supplied
`id: Session.Message.ID` (with `Session.Message.ID.fromEvent()` for
deterministic derivation), this gives a native outbox with ID reuse — no
hand-rolled queue needed.

### 8. `ctx.storage` is not transactional

It is a plain key/value store (`get/set/remove/scan`). It has no compare-and-swap.
Single-writer coordination and generation checks must use SQLite transactions,
not `storage`.

---

## Harness

`src/index.ts` is the Phase 01 harness. It registers every surface the
controller will need and appends one JSON line per event to
`$XGOAL_HARNESS_LOG`, so that a *missing* line is itself the finding.

```bash
bun run build     # emits ./index.js at the package root (required — see #3)
```

Load it by placing the package in a discovery directory:

```bash
ln -s "$PWD" ~/.config/opencode/plugins/opencode-xgoal
```

Verify against a real server:

```bash
XGOAL_HARNESS_LOG=/tmp/xgoal.log \
  XDG_CONFIG_HOME=<isolated-config> opencode2 --standalone --prompt "pong"
cat /tmp/xgoal.log
```

`XDG_CONFIG_HOME` isolates config, skills and AGENTS.md, but note that
`opencode plugin list` reports the *running service's* plugins, so it is not a
valid isolation check — read the harness log instead.

---

## Roadmap

Phase 01 is done. Remaining phases, in the order the design requires:

1. **Goal state and lifecycle** — persistent goals, immutable objective,
   generation IDs, single-active-goal enforcement, archive/history.
2. **Native continuation driver** — prepared/admitted/settled rounds via the
   native inbox, ID reuse on retry, event reconciliation, restart recovery.
3. **Verification and loop protection** — completion proposal, evidence
   validation, blocker auditing, progress classification, usage accounting.
4. **TUI and replacement** — RPC bridge, confirmation dialog, status indicator.
5. **Parity evaluation** — identical tasks against Codex `/goal` and this
   controller; measure verified completion rate and premature-stop rate.

Design constraints carried forward from the review (deliberate, non-obvious):

- The **objective is immutable; the plan is adaptive.** Do not freeze a
  model-generated unit list — for goals like "find and fix all bugs in this
  subsystem" the required units are not knowable up front.
- **Completion is objective-level verification**, not "all units ticked".
- **Do not rewrite model output** and **do not inject via tool descriptions.**
  Use the dedicated goal-context channel (`session.hook("context")`).
- **Progress includes investigation and verified waits**, not just file changes.
- Count **completed, evaluated rounds** separately from delivery failures.
- A plugin that launches duplicate turns is worse than one that stops early —
  exactly-once admission and restart reconciliation come before verification
  sophistication.
