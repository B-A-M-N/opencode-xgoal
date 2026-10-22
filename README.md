# OpenCode-XGoal

**Give OpenCode a goal once. Keep it working across turns. Require evidence before calling it done.**

OpenCode-XGoal is a session-native, long-horizon **goal controller for OpenCode 2**. It holds an objective outside the model's conversation, drives follow-up turns through OpenCode's own session APIs, and checks completion against observed evidence rather than accepting the model's final message at face value.

It is a controller, **not** a new model, a replacement agent runtime, or a prompt that just says "continue."

> **Compatibility:** This project targets the OpenCode **2** plugin interfaces. Its recorded live validation used OpenCode 2 **v2.0.31**; compatibility with other releases must be tested, not assumed. This repository is currently a source-built plugin (`private: true` in `package.json`), not a published one-command npm install.

## What you get

- **Persistent goals.** The objective and its criteria live in SQLite, outside the model's context. A goal does not disappear when a single turn ends or the conversation is compacted.
- **Autonomous continuation.** The controller reserves and submits native session turns, reconciles delivery/execution state, and decides when to continue, pause, or investigate a stall. You should not need to keep prompting the model to proceed.
- **Evidence-based completion.** The model can *propose* completion, but the controller verifies supported criteria against file contents, command/test results, and evidence captured from tool executions.
- **Explicit control.** Inspect status, replace a goal, pause or resume dispatch, set a token budget, inspect health, or accept a non-machine-verifiable remainder.
- **Recovery and fencing.** Durable rounds, generation checks, and reconciled admissions reduce duplicate continuation and prevent stale calls from a replaced goal from changing the current goal's records.

**Important limit:** Not every natural-language objective can be proved automatically. Broad or subjective work may require concrete acceptance criteria or an explicit user acceptance. XGoal can verify the evidence it recognizes; it cannot guarantee that an arbitrary task is correct just because a model produced files or passed a test.

## Quick start

### Requirements

- An OpenCode **2** build compatible with the plugin APIs used here.
- [Bun](https://bun.sh/) and Git for building from source.
- An OpenCode model/provider configuration capable of executing tool calls.
- A shell on Linux/macOS for the symlink-based example below.

### 1. Build and install

```bash
git clone https://github.com/B-A-M-N/opencode-xgoal.git
cd opencode-xgoal

bun install
bun run build

mkdir -p "$HOME/.config/opencode/plugins"
ln -s "$PWD" "$HOME/.config/opencode/plugins/opencode-xgoal"
```

The symlink is the *installation*: it places the package directory inside a global plugin-discovery path. The compiled entrypoints **`index.js`** (server plugin) and **`tui.js`** (terminal companion) must exist in the package root after building. If the symlink path already exists, inspect it before replacing it; the `ln -s` command intentionally does not overwrite an existing installation.

If your OpenCode installation uses a different global config directory (for example via `XDG_CONFIG_HOME`), install under **that** config directory's `opencode/plugins/` path instead. Do not assume a symlink into your ordinary home config is visible to an isolated or remotely running server.

### Goal completion notifications

When using `@mohak34/opencode-notifier`, its normal `complete` event means a
single OpenCode turn became idle, which can happen while XGoal is still
delegating or continuing the goal. To notify only when the goal is verified
complete, configure its `complete` event to run the gate script instead of
sending the default completion popup:

```json
{
  "events": {
    "complete": { "sound": false, "notification": false, "command": true, "bell": false }
  },
  "command": {
    "enabled": true,
    "path": "/usr/bin/python3",
    "args": [
      "/path/to/opencode-xgoal/scripts/xgoal-goal-notify.py",
      "{event}", "{sessionID}", "{sessionTitle}"
    ]
  }
}
```

Save this in `~/.config/opencode/opencode-notifier.json`. The script reads the
latest goal for that session from the XGoal database. It suppresses completion
alerts while a goal is active, paused, stalled, or superseded; it sends one
when the goal status is `complete`. Sessions with no XGoal record retain the
ordinary “session finished” alert. Permission and error alerts remain governed
by the notifier's existing settings. The generic completion sound is disabled
for all sessions because the notifier cannot conditionally gate that channel.

### 2. Restart OpenCode and check discovery

Start/restart your OpenCode **2** server and CLI, then check:

```bash
opencode plugin list
```

If your binary is named `opencode2`, substitute that name. Confirm that XGoal appears, then open a session and try:

```text
/goal status
```

The terminal companion provides the `/goal` command and confirmation dialog; it is exported as `opencode-xgoal/tui`. OpenCode 2's plugin loader supports server/TUI entrypoints in the same discovered package. Consult the [OpenCode 2 plugin guide](https://opencode.ai/v2/docs/build/plugins/) and [CLI plugin guide](https://opencode.ai/v2/docs/cli/plugins) if your host uses explicit plugin lists or a nonstandard layout.

**Do not leave another plugin owning `/goal` at the same time.** In particular, disable the legacy `@prevalentware/opencode-goal-plugin` in your OpenCode configuration before treating XGoal as the sole `/goal` handler. XGoal does not disable it automatically or modify its `.opencode/goals/` state.

### 3. Start a goal

For example, in an OpenCode session:

```text
/goal Create a file called a.txt containing exactly: alpha. Create a file called b.txt containing exactly: bravo. Verify both files exist and have the required content.
```

XGoal records the objective, derives supported criteria, and schedules execution. After native rounds settle, the controller checks progress and decides whether another round is needed. The model may call `goal_propose_complete`; **only the controller can commit verified completion**.

Inspect without replacing:

```text
/goal status
/goal health
```

## Commands

| Command | Purpose |
| --- | --- |
| `/goal <objective>` | Create and start a goal. In the TUI, confirms before replacing an active goal. |
| `/goal` or `/goal status` | Show status; the TUI also shows the most recent completed goal. |
| `/goal replace <objective>` | Explicitly supersede the active objective with a new generation. |
| `/goal pause` | Stop **future dispatch**, without deleting the objective or evidence. |
| `/goal resume` | Resume dispatch, including goals parked after delivery failure. |
| `/goal budget <positive-number>` | Set a token ceiling for the active goal. |
| `/goal budget off` | Clear the ceiling. |
| `/goal accept [note]` | Record *user* acceptance of an objective-level remainder. |
| `/goal health` | Inspect structured controller diagnostics. |

The terminal companion uses generation-checked RPC operations. Enter confirms an in-progress goal replacement; Escape keeps the existing goal. A stale confirmation is rejected rather than applied to a newer goal. The server command and TUI are separate host surfaces; some presentation behavior differs.

**Acceptance is not a blanket override.** It can resolve a broad, non-machine-verifiable remainder, but it does **not** waive explicit requirements such as creating a specific file with exact content.

## How completion actually works

```text
User sets objective
        │
        ▼
GoalCoordinator ── stores objective + criteria
        │
        ▼
GoalDriver ── reserves round → submits native inbox message
        │
        ▼
OpenCode model + tools execute
        │
        ▼
Controller reconciles session state and captures evidence
        │
        ├── unfinished with progress → another round
        ├── stalled / blocked / budget-limited → stop and report
        └── proposed complete → independent verification
                                    │
                                    ├── unmet criteria → continue / report
                                    └── all required criteria met → complete
```

The controller, rather than the model, owns transitions. It identifies each goal generation, attributes observations to the originating execution, and checks evidence again at the point of completion. A `goal_checkpoint` is an annotation, **not** proof of progress.

The model-visible tools are `goal_get`, `goal_checkpoint`, `goal_add_criterion`, `goal_supersede_criterion`, `goal_propose_complete`, and `goal_report_blocked`. User-derived requirements cannot simply be deleted by the model, and ordinary final-answer text does not count as evidence.

### Persistence and control

By default, the SQLite database is at:

```text
$XDG_DATA_HOME/opencode-xgoal/goals.db
```

When `XDG_DATA_HOME` is unset, this resolves to `~/.local/share/opencode-xgoal/goals.db`. Override it with `XGOAL_DB=/absolute/path/goals.db`. The controller does not use the legacy plugin's `.opencode/goals/` directory.

`XGOAL_DISABLE=1` makes the server-side XGoal plugin inert (no controller, driver, or registered RPC). This is useful for a control run; it is not an uninstall. A restarted session may still need an explicit `/goal resume` when a permanent delivery error parked the goal.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| XGoal does not show in `opencode plugin list` | Confirm you are on OpenCode **2**, the right config directory is in use, and the discovery entry points to a **directory**, not a file. |
| Plugin appears but `/goal` is missing in the TUI | Confirm `tui.js` exists and your OpenCode CLI actually loads the companion entrypoint. Check CLI/plugin configuration and version compatibility. |
| Plugin appears but nothing executes | Run `/goal health`; check model/provider availability, RPC registration, dispatch status, and permissions. |
| Build output is missing | Run `bun install && bun run build` from the repository root and check for root-level `index.js` and `tui.js`. |
| A different `/goal` command responds | Disable competing goal plugins, especially the legacy `@prevalentware/opencode-goal-plugin`. |
| Goal is stuck or refuses completion | Use `/goal status` and `/goal health`. Check unmet criteria, actual artifacts, command evidence, transport failures, and token limits. |
| Behavior differs on a newer OpenCode release | Verify the server and CLI APIs against that **specific version**. Historic v2.0.31 loader observations are not guaranteed on later builds. |

For technical investigation, set `XGOAL_HARNESS_LOG=/path/to/trace.jsonl` before starting the server to record structured controller events. Treat generated logs as potentially sensitive operational data. See [engineering history](docs/ENGINEERING_HISTORY.md) for the earlier live API findings, audit remediations, and known residual risks.

## Development and validation

```bash
bun install
bun run build
bun run typecheck
bun test
```

For the live acceptance harness:

```bash
# Point to a compatible OpenCode 2 executable and an ISOLATED,
# already-configured model/provider config directory.
export OPENCODE_BIN=/absolute/path/to/opencode2
export XGOAL_TEST_CONFIG=/absolute/path/to/xgoal-test-config

bash scripts/parity.sh
bash scripts/parity.sh --qualify
```

**The live harness is not plug-and-play on a clean checkout.** Its default paths in `scripts/parity.sh` are developer-machine-specific; explicitly set `OPENCODE_BIN` and `XGOAL_TEST_CONFIG`. The test config must contain usable model credentials/configuration and have XGoal discoverable. The harness builds the plugin, launches an isolated OpenCode server/workspace/database, exercises the public RPC surface, and drives a goal **without another user prompt** after creation. `--qualify` adds replacement-race, acceptance-fencing, and disabled-plugin cases. Set `XGOAL_ACCEPT_KEEP=1` to retain the temporary workspace and logs. Inspect harness options in the script before running on a new host.

Prior recorded results in the original README were **282 unit/integration tests (884 assertions)** and **17/17 live acceptance checks**, on the then-tested environment. These are historical reports, **not** a claim that the same tests were rerun for this documentation update.

### Code map

| Location | Responsibility |
| --- | --- |
| `src/index.ts` | Server entrypoint: hooks, tools, commands, RPC registration, event handling |
| `src/tui.tsx` | Terminal `/goal` interface, confirmation flow |
| `src/rpc.ts` | Shared RPC contract |
| `src/controller/coordinator.ts` | Single create/replace/resume coordination path |
| `src/controller/controller.ts` | Goal state, authority, transitions, completion |
| `src/controller/driver.ts` | Round reservation, native submission, reconciliation |
| `src/controller/transport.ts` | Session inbox and execution transport |
| `src/controller/verification.ts` | Captured evidence and verification |
| `src/controller/criteria.ts` | Derived and explicit acceptance criteria |
| `src/controller/store.ts` | SQLite persistence |

For the full OpenCode 2 API reconnaissance, rationale behind the invariants, and detailed audit-findings log, read **[Engineering history](docs/ENGINEERING_HISTORY.md)**. These are preserved as a historical record rather than repeated in the first-time-user guide.

---

## Acknowledgments

This project's development and testing ran on models served by
**[FreeInference.org](https://freeinference.org)** — a free, OpenAI-compatible
inference service for open-source, research, and education, built at Harvard
SEAS's MadSys Lab. Every agent turn across the audit remediation, the
regression suites, and the independent reviewer sessions ran on their
endpoint.

**Disclosure:** this acknowledgment was not requested, directed, or approved
by FreeInference.org, and they have not reviewed this project. The credit is
given for one reason: they provide a vital service for people who may not
otherwise have access to frontier-model inference — researchers, students,
and builders without funding or institutional backing. If you find this
project useful, that is a good reason to support them.
