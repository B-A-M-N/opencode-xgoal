# OpenCode-XGoal

A session-native **Goal Controller** for OpenCode 2, reproducing Codex's Goal
behavioural contract — persistent objective, host-controlled continuation,
evidence-gated completion — using OpenCode 2's supported plugin interfaces.

Status: **working controller.** A user sets a goal once; the plugin drives the
session through as many native turns as the objective needs and completes only
after the controller verifies the result against evidence it observed. The live
acceptance harness passes 17/17 checks, including a second goal immediately
after a completed one and a generation-checked replacement.

```bash
bun run build     # required: the package entry is ./index.js
bun test          # 226 unit/integration tests
bash scripts/parity.sh   # live activation acceptance (real server + model)
```

---

## What it does

- **Persistent objective.** A goal survives turns, compaction, restarts, and the
  model's own opinion that it is finished.
- **Host-controlled continuation.** After each native turn settles, the driver
  reconciles the round from the session's own inbox and transcript, classifies
  what happened, and either continues, stalls, or asks the controller to verify.
  The model cannot start or stop the loop.
- **Evidence-gated completion.** `goal_propose_complete` starts verification; it
  does not complete the goal. Criteria are derived from the objective at creation
  and are checked independently (file content, command exit status, explicitly
  bound evidence). A model statement is never evidence. A broad objective-level
  remainder is deliberately *not* provable by ordinary evidence — equally
  consistent with a partial job — and resolves only through concrete
  sub-criteria or explicit user acceptance (`/goal accept`).
- **Exactly-once admission.** A round is reserved before submission, carries a
  caller-supplied inbox id, and is reconciled rather than re-sent. Duplicate
  `session.execution.succeeded` events do not double-count.
- **Generation fencing.** Every model-facing mutation carries `goalID` and
  `generation`. A late tool call from a superseded goal is rejected instead of
  contaminating its replacement. Completion is committed atomically against the
  verification snapshot the verifier checked.
- **One mutation path.** The `/goal` command, the TUI, and the server RPC all go
  through `GoalCoordinator`, so creating, replacing, or resuming a goal schedules
  native execution instead of leaving an active goal with nothing driving it.

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

## Installing

The package entry must be at the package root and must not import bare
specifiers (see findings #2 and #3). Build first, then symlink the package into a
plugin discovery directory:

```bash
bun run build
ln -s "$PWD" ~/.config/opencode/plugins/opencode-xgoal
```

The TUI companion is exported as `opencode-xgoal/tui` (`./tui.js`). The server
plugin and the TUI share the RPC contract in `src/rpc.ts`.

### Commands

`/goal <objective>` sets a goal and starts work. With a goal already active, the
TUI asks for confirmation and then performs a generation-checked replace; it
never silently supersedes work.

```
/goal <objective>        set a goal and begin
/goal status             show the latest goal (including a completed one)
/goal replace <obj>      supersede the current goal (fails its outstanding rounds)
/goal accept [note]      explicitly accept the objective-level remainder
/goal pause | resume     stop / restart dispatch
/goal budget <n> | off   set or clear the token ceiling
/goal health             structured diagnostics
```

`/goal pause` stops dispatch only; it never changes the objective or the
evidence. A goal parked by a permanent delivery failure (repeated transport
rejection) is *not* resumed by a sweep — only an explicit `/goal resume`
re-requests dispatch.

The same operations are available over RPC:

```
goal.create   goal.status   goal.history   goal.replace
goal.pause    goal.resume   goal.budget    goal.health
goal.accept
```

`goal.status` reports `{ current, latest, goal }`: `current` is the nonterminal
goal in progress (what a replacement confirmation must be rendered against —
a completed goal is never "current"), `latest` is the most recent goal
including a terminal one, and `goal` is kept as an alias of `latest` for
existing consumers.

### Goal tools exposed to the model

`goal_get`, `goal_checkpoint`, `goal_add_criterion`,
`goal_supersede_criterion`, `goal_propose_complete`, `goal_report_blocked`.

`goal_get` returns the criteria *and* the evidence the controller has captured,
so the model can bind evidence to a criterion by id or ref. File criteria with a
machine spec are re-checked independently; other criteria require explicitly
bound, currently valid evidence. Command/test criteria additionally require the
bound evidence to be a run of the *required command* itself (matched under an
explicit whitespace-normalization policy — not shell canonicalization) with the
expected exit status.

`goal_add_criterion` is additive and idempotent (an identical normalized
requirement returns the existing criterion) and fenced like every other tool. It
cannot create an objective-type criterion — accepting the objective is the
user's verdict, not the model's. `goal_supersede_criterion` retires a
model-added criterion investigation proved wrong; the row is kept for the audit
trail. Requirements extracted from the user's objective — numbered items
included — carry user authority: the model cannot retire them, and may propose
only a replacement that provably preserves the original obligation (a stricter
content requirement on the same path, or the identical command); anything else
must go to the user (`/goal replace`). Exact-content requirements are parsed
into byte-exact `equals` specs: "containing exactly: success" demands the file
be `success`, not merely contain it — quoting is how punctuation or whitespace
is made material. User acceptance alone resolves a goal whose only criterion is
objective-level acceptance; it never waives explicit file requirements.

---

## Acceptance harness

`scripts/parity.sh` is the replacement for the old parity script. The old one
wrote controller rows directly and then prompted the model itself, which proved
only that the model could do the task. The new one proves the plugin drives it:

1. start an isolated server, workspace and database in a temporary directory
   (`${TMPDIR:-/tmp}`), outside the checkout;
2. create a session and run one trivial warm-up turn (the only prompt);
3. create the goal through the public `goal.create` RPC and **send no further
   prompt**;
4. poll the goal to verified completion, then check the files on disk;
5. create a second goal in the same session and prove it gets the next
   generation and is driven;
6. replace an active goal and prove the new generation is driven while a stale
   confirmation is refused.

It fails loudly on any timeout or wrong artifact. `scripts/p6-convergence.sh` is
kept as a thin entry point to the same harness.

```bash
bash scripts/parity.sh
# Results: 17 passed, 0 failed
```

The harness uses `XGOAL_ACCEPT_KEEP=1` to keep its workspace and logs for
inspection. It never touches the user's database or sessions.

---

## Verification

```bash
bun test          # 226 unit/integration tests, 637 assertions
bun run typecheck # clean
bash scripts/parity.sh  # 17/17 live acceptance checks
```

The live acceptance run on the tested environment:

| Check | Evidence |
| --- | --- |
| goal created with derived criteria | two file specs parsed from one objective |
| creation scheduled native execution | `goal.create` returned `drive.action = admitted` |
| goal reached verified completion | status `complete`, 4 validated evidence items |
| artifacts match the objective | `a.txt` = `alpha`, `b.txt` = `bravo` |
| criteria readout agrees with proofs | every criterion marked `met` |
| post-completion goal gets next generation | generation 2, `admitted` |
| post-completion goal completes | `two.txt` = `two`, status `complete` |
| replacement drives generation 2 | generation 2, `admitted`, `new.txt` = `new` |
| stale replacement refused | `expectedGeneration: 1` rejected after gen 2 |

The harness sends no prompt after `goal.create`; the only prior message is a
one-line warm-up that makes the plugin load for the session.

Harness notes, learned the hard way:

- Use an isolated `XDG_CONFIG_HOME` and a fixed port. The standalone server
  prints a generated password; the harness parses it from the server output.
- Do **not** use `set -e`. A non-zero exit from a probe helper aborts the run
  and silently skips later scenarios.
- A headless `run` invocation does not dispatch slash commands. The harness
  therefore exercises `goal.create` over the same RPC the TUI uses, which is the
  authoritative path anyway.
- The event stream is a cache. After a restart it is empty; the probe reads the
  session's inbox and transcript, not the in-memory observer.

---

## Architecture

```
src/
  index.ts                  server plugin: command, tools, hooks, RPC, driver
  tui.tsx                   TUI companion: /goal, dialog, RPC
  rpc.ts                    shared RPC definition + handlers
  controller/
    state.ts                Goal, statuses, transition table
    store.ts                SQLite: goals, rounds, evidence, criteria, proofs
    controller.ts           authority split, generation fencing, verification
    criteria.ts             CriterionSpec + objective → criteria derivation
    driver.ts               reserve → submit → settle → classify → continue
    transport.ts            native inbox transport + authoritative probe
    verification.ts         evidence capture, per-criterion proofs, snapshot
    coordinator.ts          one mutation path: create/replace/resume → drive
```

Rules that are deliberate, not accidental:

- Generation is `MAX(generation)+1` over *all* goals in the session, allocated
  inside `BEGIN IMMEDIATE`.
- A round is reserved before submission. Admission is not execution; only
  settlement from authoritative state counts.
- `goal_checkpoint` is an annotation, not a round. It cannot manufacture
  progress.
- Completion is `verifying → complete` by the controller only, in one
  transaction guarded by generation and the verification snapshot.
- Blocker acceptance counts distinct rounds with the same normalized reason.
  Repeating a preference is not a blocker.
- Round classification compares the *verifiable* evidence count at settlement
  with the baseline captured at preparation. Checkpoint refs are model-annotated
  pointers and never count as observations, so narrating via `goal_checkpoint`
  cannot keep a goal alive. Text-only turns are `noProgress`; a turn waiting on
  an observably running execution is `verifiedWait` and does not accumulate
  toward a stall. One conservative bound: a busy execution observed for longer
  than 15 minutes is treated as stale, and the turn counts as `noProgress` —
  the goal is asked rather than assumed to still be waiting.
- Tool-call ownership is attributed by **transcript position**: the nearest
  preceding continuation (bound to its generation at admission) claims a
  message, and a foreign human prompt stops the walk. Timestamp attribution
  survives only for sessions with exactly one generation, where it cannot
  misattribute.
- Completion freshness is **recomputed**, not trusted: `completeGoal` re-hashes
  the current criteria+evidence and refuses a commit whose verified snapshot no
  longer matches the world.

### Where the evidence lives

`~/.local/share/opencode-xgoal/goals.db` by default (`XGOAL_DB` overrides it).
The database is the source of truth; the event stream and the in-memory observer
are caches.

**Legacy goal files are not this plugin.** The `.opencode/goals/*.json` files in
this repository (e.g. `072e0449f40574c72e13daf765e2441b.json`) belong to an
older file-based goal plugin, not to OpenCode-XGoal. They are left untouched on
purpose: this plugin never reads or writes them, and they are not authoritative
for any controller state here.

### What is not proven

The acceptance harness covers short, machine-checkable objectives. It does not
prove long-horizon goals like "find and fix all bugs in this subsystem", where
the required units are not knowable up front. The design constraint stands: do
not freeze a model-generated unit list.

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

### Defects found by the audit and live testing

The first live run exposed the real gap: `/goal` created a row, but nothing
drove the session. The audit fixes are now in the tree:

1. **Generation allocation** — `MAX(generation)` over the session, inside
   `BEGIN IMMEDIATE`, so a completed goal does not cause generation reuse.
2. **One reconciliation path** — settlement and recovery share the same
   reconcile path; duplicate `session.execution.succeeded` events are
   idempotent.
3. **Criteria at creation** — ordinary `/goal` derives machine-checkable
   criteria; the acceptance test starts from a fresh DB.
4. **Explicit proofs** — no `coveredByGeneral`; command/test evidence requires
   exit 0, file evidence is hash-checked, and paths resolve against the session
   workspace. Only bound evidence is load-bearing.
5. **Authoritative probe** — after a restart the probe reads the session inbox
   and transcript, not only the in-memory observer; correlation uses
   `metadata.inboxID`.
6. **V2 TUI APIs** — `Plugin.define`, `context.keymap.layer`,
   `context.ui.dialog.confirm`, `context.ui.toast.show`,
   `context.client.rpc(RpcDefinition)`.
7. **One dispatch path** — `GoalCoordinator` creates/replaces/resumes state and
   schedules native execution; the command, TUI, and RPC all use it.

A second independent audit then found subtler gaps; all are fixed with
regression tests:

8. **No permanent-failure redrive (P0)** — the periodic sweep no longer clears
   the terminal delivery-failure park, so a permanently rejected transport
   cannot mint fresh continuations forever; recovery is `/goal resume` only.
   Dispatch re-checks the goal is still `active` immediately before admission.
9. **Objective-level completion is a user verdict (P0)** — ordinary evidence
   can no longer prove a broad objective, and the criteria derivation no longer
   silently truncates at 8 items. `/goal accept` / `goal.accept` records
   acceptance for the current generation (never carried across a replace) and
   finishes a verifying goal when acceptance was the only gap.
10. **Execution-ownership fencing (P1)** — tool calls are attributed by
    transcript position rather than wall-clock overlap, with a fail-closed
    `selectToolRef` when neither a message identity nor a complete goal
    reference exists; continuations are bound to their generation at admission.
11. **Criterion refinement (P1)** — `goal_add_criterion` (idempotent, no
    objective-type specs from the model) and `goal_supersede_criterion`
    (user-source requirements are protected) are registered with the same
    fencing as every other tool.
12. **Honest progress classification (P1)** — only non-`ref` evidence counts
    toward the stall threshold, and an observably running execution classifies
    as `verifiedWait` instead of accumulating `noProgress`.
13. **Settlement correlation (P1)** — the probe bounds its scan at the first
    foreign human prompt, so a terminal assistant answering an interleaved
    human turn is never scored as settlement of the round; session workspace
    caches are invalidated on session lifecycle events.
14. **Atomic supersession (P1)** — replacing a goal fails its outstanding
    rounds in the same transaction, and completion recomputes the
    criteria+evidence snapshot so a stale verification cannot commit (P2).

A third independent audit then found verification-correctness gaps; the
verification package is fixed with regression tests:

15. **Per-criterion proof contracts (P1)** — the verifier no longer demands a
    global nonempty evidence list before looking at criteria: file specs are
    re-checked against the filesystem, objective criteria resolve by
    generation-fenced user acceptance, command/test criteria by a bound run of
    the required command itself, and manual criteria by their own bound,
    currently-valid evidence. Unresolved criteria stay `unknown`, never
    silently satisfied, and acceptance never waives an unrelated explicit
    requirement.
16. **Valid newer proofs defeat stale history (P1)** — evidence validity is
    judged per criterion during proof evaluation. A criterion passes when a
    complete proof set validates; older invalid evidence (an earlier file
    revision, a failed test run before the fix) stays in the audit trail —
    reported as `staleEvidence` — without making the verdict incomplete, while
    a genuinely required dependency whose only evidence went stale still fails.
17. **Fenced verification attempts (P1)** — `recordProofs` carries the
    generation+version the verifier read; if the goal is replaced or
    transitioned while asynchronous validation runs, the proofs are discarded
    instead of overwriting the superseded goal's criterion readouts. Point-in-
    time external file checks are acknowledged: completion re-reads the
    snapshot, and the verifier result records what was checked and when.

Additional fixes: generation fencing on every model tool, per-round blocker
claims, checkpoint-as-annotation, round evidence baselines, `unknown → admitted`
transitions, atomic completion against the verification snapshot, startup and
sweep driving of active goals, session usage accounting, and a health RPC.

The earlier RPC `undefined` bug is also fixed: absent fields are coerced to
`null` before the output schema validates, so `goal.replace` no longer mutates
state and then fails serialization.
