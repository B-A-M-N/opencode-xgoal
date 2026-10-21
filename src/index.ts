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
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { GoalController } from "./controller/controller.ts";
import { attributeMessageGeneration, selectToolRef } from "./controller/calls.ts";
import { GoalCoordinator } from "./controller/coordinator.ts";
import { GoalDriver } from "./controller/driver.ts";
import { RoundObserver, SessionTransport } from "./controller/transport.ts";
import { hashFile, resolveWorkspacePath, sessionWorkspace } from "./controller/workspace.ts";
import {
  EvidenceLedger,
  GoalVerifier,
  type EvidenceValidator,
} from "./controller/verification.ts";
import { goalRpcDefinition, goalRpcHandlers } from "./rpc.ts";

const LOG = process.env.XGOAL_HARNESS_LOG ?? "";

/** Human-readable dispatch outcome for command replies and the TUI. */
function describeDrive(outcome: any): string {
  if (!outcome) return "dispatch unavailable (no driver connected)";
  switch (outcome.action) {
    case "admitted":
      return `execution scheduled (${outcome.inboxID}).`;
    case "reconcile":
      return `an outstanding round is still ${outcome.status}.`;
    case "unknown":
      return "dispatch outcome unknown; the recovery sweep will reconcile it.";
    case "failed":
      return `dispatch failed: ${outcome.detail}.`;
    case "abandoned":
      return `dispatch abandoned: ${outcome.detail}.`;
    case "limited":
      return `not dispatched: goal is ${outcome.status}.`;
    case "idle":
      return `not dispatched: ${outcome.reason}.`;
    default:
      return `dispatch: ${String(outcome.action)}.`;
  }
}

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

/**
 * Extract the session id from an event.
 *
 * Session lifecycle events carry it at `data.sessionID`; some others use
 * `properties`. Checked in order rather than assumed, because guessing wrong
 * silently skips every drive.
 */
function sessionIDOf(event: unknown): string | undefined {
  const e = event as
    | { data?: { sessionID?: string }; properties?: { sessionID?: string }; sessionID?: string }
    | undefined;
  return e?.data?.sessionID ?? e?.properties?.sessionID ?? e?.sessionID;
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

    // ------------------------------------------------- continuation driver
    const observer = new RoundObserver();
    let driver: GoalDriver | undefined;
    let coordinator: GoalCoordinator | undefined;
    let ledger: EvidenceLedger | undefined;
    let verifier: GoalVerifier | undefined;
    let sweep: ReturnType<typeof setInterval> | undefined;

    // A session can be opened in a subdirectory of the project. Relative paths
    // observed from its tool calls belong to that directory, not to whatever cwd
    // the plugin host happens to have. Cache per session; a move is rare and the
    // next process rebuilds the cache.
    const sessionWorkspaces = new Map<string, string>();
    const resolveSessionWorkspace = async (sessionID: string | undefined): Promise<string> => {
      if (sessionID) {
        const cached = sessionWorkspaces.get(sessionID);
        if (cached) return cached;
      }
      if (sessionID) {
        try {
          const session = await ctx.session.get({ sessionID } as never);
          const directory = (session as { location?: { directory?: unknown } } | undefined)
            ?.location?.directory;
          if (typeof directory === "string" && directory.length > 0) {
            sessionWorkspaces.set(sessionID, directory);
            return directory;
          }
        } catch {
          // Older host or a session that has gone away: fall back below.
        }
      }
      return sessionWorkspace();
    };

    if (controller) {
      const transport = new SessionTransport({
        observer,
        send: async ({ sessionID, inboxID, text, metadata }) => {
          // Native session inbox with a caller-supplied id. The id is what makes
          // a retry idempotent: the session can deduplicate a re-sent message.
          await ctx.session.synthetic({
            sessionID,
            id: inboxID,
            text,
            metadata,
            delivery: "queue",
          });
        },
        // Authoritative state for reconciliation. The event stream is a cache;
        // the session's own inbox and transcript decide what actually happened.
        fetchState: async ({ sessionID }) => {
          const messages = await ctx.session.context({ sessionID });
          let inbox: Array<{ id: string }> = [];
          try {
            const api = ctx.session?.inbox;
            if (typeof api?.list === "function") {
              inbox = await api.list({ sessionID });
            }
          } catch {
            // The inbox may not be exposed on this surface; the transcript is
            // still authoritative enough to prove delivery and settlement.
          }
          return {
            inbox: (inbox ?? []).map((item: any) => ({ id: item.id })),
            messages: (messages as any[]).map((message: any) => ({
              id: message.id,
              type: message.type,
              metadata: message.metadata,
              time: message.time,
              finish: message.finish,
            })),
          };
        },
      });
      driver = new GoalDriver(controller.store, transport);

      // One authoritative mutation path. The command, the RPC surface and the
      // TUI all use this, so creating/replacing/resuming a goal schedules the
      // native execution instead of leaving an active goal with no driver.
      coordinator = new GoalCoordinator(controller, () => driver, {
        onDriveError: (sessionID, error) =>
          record({ event: "coordinator.drive.error", sessionID, error: String(error) }),
      });

      // Evidence is captured from observed tool executions only. A model's
      // prose never reaches this ledger.
      ledger = new EvidenceLedger(controller.store);
      verifier = new GoalVerifier(controller.store, {
        async workspaceFor(sessionID) {
          return resolveSessionWorkspace(sessionID);
        },
        async validate(evidence, workspace) {
          // File evidence must still exist AND still match the content hash
          // captured when it was observed. Existence alone is not proof, and a
          // relative path must resolve against the session workspace, never the
          // plugin process's own cwd.
          if (evidence.kind === "file") {
            const resolved = resolveWorkspacePath(evidence.ref, workspace);
            try {
              if (!existsSync(resolved)) {
                return { valid: false, reason: `file not found: ${evidence.ref}` };
              }
              if (evidence.hash !== undefined) {
                const actual = hashFile(resolved);
                if (actual !== evidence.hash) {
                  return {
                    valid: false,
                    reason: `file changed since it was observed: ${evidence.ref}`,
                  };
                }
              }
              return { valid: true, reason: "file present and unchanged" };
            } catch {
              return { valid: false, reason: "file could not be checked" };
            }
          }
          // Command/test/runtime evidence is only proof if the observed exit
          // status was zero. A command that merely ran proves nothing.
          if (
            evidence.kind === "command" ||
            evidence.kind === "test" ||
            evidence.kind === "runtime"
          ) {
            if (evidence.exitCode === undefined) {
              return {
                valid: false,
                reason: "no observed exit status recorded; cannot confirm success",
              };
            }
            return evidence.exitCode === 0
              ? { valid: true, reason: `exited ${evidence.exitCode}` }
              : { valid: false, reason: `exited ${evidence.exitCode}` };
          }
          // A bare reference is a model-provided pointer, never proof.
          return { valid: false, reason: "unverifiable reference" };
        },
        async checkSpec(criterion, workspace) {
          // Only file specs are checked here. Command/test specs are proven by
          // bound evidence of a run that actually exited with the expected
          // status; we never re-execute arbitrary commands during verification.
          if (criterion.spec?.type !== "file") {
            return { valid: false, reason: "no independent check for this spec" };
          }
          const spec = criterion.spec;
          const resolved = resolveWorkspacePath(spec.path, workspace);
          try {
            if (!existsSync(resolved)) {
              return { valid: false, reason: `file not found: ${spec.path}` };
            }
            if (spec.equals !== undefined || spec.contains !== undefined) {
              const content = readFileSync(resolved, "utf8");
              if (spec.equals !== undefined && content !== spec.equals) {
                return {
                  valid: false,
                  reason: `${spec.path} does not exactly match the required content`,
                };
              }
              if (spec.contains !== undefined && !content.includes(spec.contains)) {
                return {
                  valid: false,
                  reason: `${spec.path} does not contain ${JSON.stringify(spec.contains)}`,
                };
              }
            }
            return { valid: true, reason: `${spec.path} matches the required content` };
          } catch (error) {
            return { valid: false, reason: `file could not be checked: ${String(error)}` };
          }
        },
      } satisfies EvidenceValidator);

      // Startup recovery sweep: adopt or clean up whatever was in flight when
      // the previous process died. Driven by the ledger, not by events.
      //
      // Recovery is not just bookkeeping: an active goal with no outstanding
      // round has no execution driving it, so it must be dispatched again or
      // the goal silently dies with the process that created it.
      const driveAll = async () => {
        const goals = controller?.store.activeGoals() ?? [];
        const outcomes: string[] = [];
        for (const goal of goals) {
          if (goal.status !== "active") continue;
          try {
            const outcome = await driver!.drive(goal.sessionID);
            outcomes.push(`${goal.id}:${outcome.action}`);
          } catch (error) {
            record({
              event: "driver.drive.error",
              goalID: goal.id,
              error: String(error),
            });
          }
        }
        return outcomes;
      };

      void driver
        .reconcile()
        .then(async (outcomes) => {
          record({ event: "driver.reconciled", count: outcomes.length });
          const driven = await driveAll();
          record({ event: "driver.resumed", outcomes: driven });
        })
        .catch((error) => record({ event: "driver.reconcile.error", error: String(error) }));

      // Periodic sweep. A missed event must not strand a goal, so recovery does
      // not depend on the stream being healthy.
      const sweepMs = Number(process.env.XGOAL_SWEEP_MS ?? "20000");
      sweep = setInterval(() => {
        void driver
          ?.reconcile()
          .then(() => driveAll())
          .catch((error) => record({ event: "driver.sweep.error", error: String(error) }));
      }, sweepMs);
      // Do not hold the process open just for the sweep.
      (sweep as unknown as { unref?: () => void })?.unref?.();
    }

    record({
      event: "setup.begin",
      pluginId: "opencode-xgoal",
      domains: Object.keys(ctx ?? {}).sort(),
      sessionMethods: typeof ctx?.session === "object" ? Object.keys(ctx.session).sort() : [],
      controllerReady: controller !== undefined,
    });

    // ------------------------------------------------- call fencing
    /**
     * Resolve which goal generation produced an assistant message.
     *
     * A tool call belongs to the generation that produced the message carrying
     * it — not to whatever goal happens to be current when the callback runs.
     *
     * Attribution is by transcript position: walking backward from the
     * message, the nearest preceding continuation (bound to its generation at
     * admission) claims it, and a foreign human prompt stops the walk. This
     * holds even when several generations have overlapping execution
     * lifetimes, which wall-clock order cannot decide. The timestamp rule
     * survives only as a compatibility fallback for sessions with exactly one
     * generation, where it cannot misattribute. The durable mapping is cached,
     * so a delayed call from a superseded execution stays fenced to its own
     * generation and is rejected by the controller instead of contaminating
     * its replacement.
     */
    async function resolveMessageRef(
      sessionID: string | undefined,
      messageID: string | undefined,
    ): Promise<{ goalID?: string; generation?: number }> {
      if (!controller || !sessionID || !messageID) return {};
      const store = controller.store;
      const cached = store.resolveMessageGeneration(sessionID, messageID);
      if (cached !== undefined) {
        const goal = store.byGeneration(sessionID, cached);
        return goal ? { goalID: goal.id, generation: cached } : {};
      }

      let messages: unknown[] = [];
      try {
        messages = (await ctx.session.context({ sessionID })) as unknown[];
      } catch (error) {
        record({ event: "call.resolve.error", sessionID, messageID, error: String(error) });
      }
      const list = messages as Array<{
        id?: string;
        type?: string;
        metadata?: Record<string, unknown>;
        time?: { created?: number };
      }>;

      // A message belongs to a goal execution if it is one of our
      // continuations (durably bound at admission) or carries any other
      // recorded generation.
      const generationOf = (message: { id?: string }): number | undefined => {
        const id = message.id;
        if (!id) return undefined;
        const mapped = store.resolveMessageGeneration(sessionID, id);
        if (mapped !== undefined) return mapped;
        return store.roundByInboxID(id)?.generation;
      };

      let generation = attributeMessageGeneration(
        list.map((m) => ({ id: m.id ?? "", type: m.type, metadata: m.metadata })),
        messageID,
        generationOf,
      );
      if (generation !== undefined) {
        store.rememberMessageGeneration(sessionID, messageID, generation, Date.now());
        const goal = store.byGeneration(sessionID, generation);
        return goal ? { goalID: goal.id, generation } : {};
      }

      // Compatibility fallback: timestamp attribution, but only when the
      // session has exactly one generation. With several, overlapping
      // execution lifetimes make wall-clock order ambiguous, so attribution
      // fails closed instead of guessing.
      if (store.generationCount(sessionID) !== 1) return {};
      const self = list.find((m) => m.id === messageID);
      const atMs = typeof self?.time?.created === "number" ? self.time.created : undefined;
      if (atMs === undefined) return {};
      generation = store.generationAt(sessionID, atMs);
      if (generation === undefined) return {};
      store.rememberMessageGeneration(sessionID, messageID, generation, atMs);
      const goal = store.byGeneration(sessionID, generation);
      return goal ? { goalID: goal.id, generation } : {};
    }

    // ---------------------------------------------------------------- tools
    try {
      await ctx.tool.transform((editor: any) => {
        editor.add({
          name: "goal_get",
          description:
            "Report the current goal for this session, including status, generation, round counts and unmet criteria.",
          input: obj({}),
          async execute(_input: any, toolCtx: any) {
            if (!controller) return { content: `goal controller unavailable: ${startupError}` };
            const goal = controller.get(toolCtx?.sessionID);
            if (!goal) return { content: "No active goal for this session." };
            const criteria = controller.store.listCriteria(goal.id);
            // Expose captured evidence so the model can bind it to criteria.
            // Without this it can only re-assert completion and be rejected.
            const evidence = controller.store.listEvidence(goal.id).map((item) => ({
              id: item.id,
              kind: item.kind,
              ref: item.ref,
              exitCode: item.exitCode ?? null,
              hash: item.hash ?? null,
              criterionID: item.criterionID ?? null,
            }));
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
                  evidence,
                },
                null,
                2,
              ),
              metadata: { goalID: goal.id, generation: goal.generation, status: goal.status },
            };
          },
        });

        editor.add({
          name: "goal_checkpoint",
          description:
            "Record progress toward the current goal without changing its status. Use for completed work, or for investigation that materially narrows the problem. Optionally bind evidence to a criterion.",
          input: obj(
            {
              summary: str,
              evidence_refs: strArray,
              criterion_id: str,
              goal_id: str,
              generation: num,
            },
            ["summary"],
          ),
          async execute(input: any, toolCtx: any) {
            if (!controller) return { content: `goal controller unavailable: ${startupError}` };
            const ref = await resolveMessageRef(toolCtx?.sessionID, toolCtx?.messageID);
            const target = selectToolRef(ref, input, toolCtx?.messageID);
            if (!target.ok) return { content: `Goal call rejected: ${target.reason}` };
            const out = controller.checkpoint(toolCtx?.sessionID, {
              summary: String(input?.summary ?? ""),
              evidenceRefs: input?.evidence_refs,
              criterionID: input?.criterion_id,
              goalID: target.ref.goalID,
              generation: target.ref.generation,
            });
            if (!out.recorded) return { content: `Checkpoint not recorded: ${out.rejected}` };
            return {
              content: `Checkpoint recorded. Goal is ${out.goal?.status}.`,
              metadata: { status: out.goal?.status, rounds: out.goal?.rounds },
            };
          },
        });

        editor.add({
          name: "goal_add_criterion",
          description:
            "Refine the acceptance criteria during investigation: register a concrete, machine-checkable requirement the work must satisfy. Additive and idempotent — adding a requirement that already exists returns the existing criterion. Objective-type specs are refused: only the user can accept the objective itself.",
          input: obj(
            {
              text: str,
              spec: {
                type: "object",
                properties: {
                  type: {
                    type: "string",
                    enum: ["file", "command", "test", "manual"],
                  },
                  path: { type: "string" },
                  equals: { type: "string" },
                  contains: { type: "string" },
                  command: { type: "string" },
                  expectExit: num,
                },
                additionalProperties: false,
              },
              goal_id: str,
              generation: num,
            },
            ["text"],
          ),
          async execute(input: any, toolCtx: any) {
            if (!controller) return { content: `goal controller unavailable: ${startupError}` };
            const ref = await resolveMessageRef(toolCtx?.sessionID, toolCtx?.messageID);
            const target = selectToolRef(ref, input, toolCtx?.messageID);
            if (!target.ok) return { content: `Goal call rejected: ${target.reason}` };
            const rawSpec = input?.spec;
            let spec: Record<string, unknown> | undefined;
            if (rawSpec && typeof rawSpec === "object") {
              const parsed: Record<string, unknown> = { ...rawSpec };
              if (parsed.type === "file" && typeof parsed.path !== "string") {
                return { content: "Criterion rejected: a file spec requires path." };
              }
              if (
                (parsed.type === "command" || parsed.type === "test") &&
                typeof parsed.command !== "string"
              ) {
                return { content: "Criterion rejected: a command/test spec requires command." };
              }
              spec = parsed;
            }
            const out = controller.addCriterion(toolCtx?.sessionID, {
              text: String(input?.text ?? ""),
              spec: spec as any,
              goalID: target.ref.goalID,
              generation: target.ref.generation,
            });
            if (out.rejected) return { content: `Criterion rejected: ${out.rejected}` };
            return {
              content: `Criterion registered: ${out.criterionID}`,
              metadata: { criterionID: out.criterionID },
            };
          },
        });

        editor.add({
          name: "goal_supersede_criterion",
          description:
            "Retire a model-added criterion that investigation proved wrong; it no longer gates verification. Requirements that came from the user's objective cannot be retired — you may propose a replacement only when it provably preserves the original obligation (e.g. a stricter content requirement on the same file path); otherwise ask the user to run /goal replace.",
          input: obj(
            {
              criterion_id: str,
              reason: str,
              replacement: {
                type: "object",
                properties: {
                  text: { type: "string" },
                  spec: {
                    type: "object",
                    properties: {
                      type: {
                        type: "string",
                        enum: ["file", "command", "test", "manual"],
                      },
                      path: { type: "string" },
                      equals: { type: "string" },
                      contains: { type: "string" },
                      command: { type: "string" },
                      expectExit: num,
                    },
                    additionalProperties: false,
                  },
                },
                required: ["text"],
                additionalProperties: false,
              },
              goal_id: str,
              generation: num,
            },
            ["criterion_id", "reason"],
          ),
          async execute(input: any, toolCtx: any) {
            if (!controller) return { content: `goal controller unavailable: ${startupError}` };
            const ref = await resolveMessageRef(toolCtx?.sessionID, toolCtx?.messageID);
            const target = selectToolRef(ref, input, toolCtx?.messageID);
            if (!target.ok) return { content: `Goal call rejected: ${target.reason}` };
            let replacement: { text: string; spec?: Record<string, unknown> } | undefined;
            if (input?.replacement && typeof input.replacement === "object") {
              replacement = { text: String(input.replacement.text ?? "") };
              const rawSpec = input.replacement.spec;
              if (rawSpec && typeof rawSpec === "object") {
                const parsed: Record<string, unknown> = { ...rawSpec };
                if (parsed.type === "file" && typeof parsed.path !== "string") {
                  return { content: "Replacement rejected: a file spec requires path." };
                }
                if (
                  (parsed.type === "command" || parsed.type === "test") &&
                  typeof parsed.command !== "string"
                ) {
                  return { content: "Replacement rejected: a command/test spec requires command." };
                }
                replacement.spec = parsed;
              }
            }
            const out = controller.supersedeCriterion(toolCtx?.sessionID, {
              criterion_id: String(input?.criterion_id ?? ""),
              reason: String(input?.reason ?? ""),
              replacement: replacement as any,
              goalID: target.ref.goalID,
              generation: target.ref.generation,
            });
            if (out.rejected) return { content: `Supersede rejected: ${out.rejected}` };
            return { content: "Criterion superseded; it no longer gates verification." };
          },
        });

        editor.add({
          name: "goal_propose_complete",
          description:
            "Propose that the goal's original objective has been fully achieved. This moves the goal to verification; it does not complete it. The controller decides completion. File criteria with a machine-checkable spec are re-checked independently; other criteria require explicitly bound evidence. Call goal_get first and pass criteria: [{criterion_id, evidence_refs}], where evidence_refs are evidence IDs or refs from goal_get.",
          input: obj(
            {
              summary: str,
              evidence_refs: strArray,
              criteria: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    criterion_id: { type: "string" },
                    evidence_refs: { type: "array", items: { type: "string" } },
                  },
                  required: ["criterion_id"],
                  additionalProperties: false,
                },
              },
              goal_id: str,
              generation: num,
            },
            ["summary"],
          ),
          async execute(input: any, toolCtx: any) {
            if (!controller) return { content: `goal controller unavailable: ${startupError}` };
            const sessionID = toolCtx?.sessionID;
            const ref = await resolveMessageRef(sessionID, toolCtx?.messageID);
            const target = selectToolRef(ref, input, toolCtx?.messageID);
            if (!target.ok) return { content: `Goal call rejected: ${target.reason}` };
            const out = controller.proposeComplete(sessionID, {
              summary: String(input?.summary ?? ""),
              evidenceRefs: input?.evidence_refs,
              criteria: Array.isArray(input?.criteria)
                ? input.criteria.map((c: any) => ({
                    criterionID: String(c?.criterion_id ?? ""),
                    evidenceRefs: Array.isArray(c?.evidence_refs) ? c.evidence_refs : [],
                  }))
                : undefined,
              goalID: target.ref.goalID,
              generation: target.ref.generation,
            });
            if (out.rejected) return { content: `Completion proposal rejected: ${out.rejected}` };

            // The model proposed; the controller decides. Verify against current
            // evidence and only then commit completion.
            const goal = controller.status(sessionID);
            if (!goal || !verifier) {
              return {
                content: "Completion proposed and pending verification.",
                metadata: { status: goal?.status },
              };
            }

            const result = await verifier.verify(goal.id);
            if (result.verdict === "complete") {
              const done = controller.commitComplete(
                goal.id,
                goal.generation,
                result.reason,
                result.snapshot,
              );
              record({ event: "completion.verified", goalID: goal.id, reason: result.reason });
              return {
                content: `Completion verified and the goal is now complete. ${result.reason}`,
                metadata: { status: done.status },
              };
            }

            // Not verified: return the goal to work with the specific gaps, so
            // the model knows exactly what is still required.
            const back = controller.rejectCompletion(goal.id, goal.generation, result.reason);
            record({
              event: "completion.rejected",
              goalID: goal.id,
              unmet: result.unmet,
              reason: result.reason,
            });
            return {
              content: [
                "Completion NOT verified. The goal remains active.",
                `Reason: ${result.reason}`,
                result.unmet.length ? `Unsatisfied conditions:\n${result.unmet.map((u) => `- ${u}`).join("\n")}` : "",
                "Address these and continue working.",
              ]
                .filter(Boolean)
                .join("\n"),
              metadata: { status: back?.status, unmet: result.unmet },
            };
          },
        });

        editor.add({
          name: "goal_report_blocked",
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
            const ref = await resolveMessageRef(toolCtx?.sessionID, toolCtx?.messageID);
            const target = selectToolRef(ref, input, toolCtx?.messageID);
            if (!target.ok) return { content: `Goal call rejected: ${target.reason}` };
            const out = controller.reportBlocked(toolCtx?.sessionID, {
              reason: String(input?.reason ?? ""),
              evidenceRefs: input?.evidence_refs,
              externalDependency: input?.external_dependency === true,
              goalID: target.ref.goalID,
              generation: target.ref.generation,
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

    // ---------------------------------------------------------------- rpc
    // The TUI companion talks to the controller through this surface. The
    // generation check lives here, on the server, so a confirmation rendered
    // against generation N cannot replace generation N+1.
    try {
      if (controller && ctx.rpc?.register) {
        await ctx.rpc.register(
          goalRpcDefinition as never,
          goalRpcHandlers(controller, coordinator, verifier) as never,
        );
        record({ event: "rpc.registered", ok: true });
      } else {
        record({ event: "rpc.registered", ok: false, reason: "rpc domain unavailable" });
      }
    } catch (error) {
      record({ event: "rpc.registered", ok: false, error: String(error) });
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
                reply(`Paused: ${(coordinator ?? controller).pause(sessionID).status}`);
                return;
              }
              if (verb === "resume") {
                if (coordinator) {
                  const result = await coordinator.resume(sessionID);
                  reply(`Resumed: ${result.goal.status}. ${describeDrive(result.drive)}`);
                } else {
                  reply(`Resumed: ${controller.resume(sessionID).status}`);
                }
                return;
              }
              if (verb === "accept") {
                // Explicit user acceptance of the objective-level remainder.
                // A USER action only; the model cannot accept its own goal.
                const accepted = controller.acceptObjective(sessionID, arg || undefined);
                // If completion was waiting on exactly this, finish the job
                // now rather than leaving the user to re-trigger the model.
                if (accepted.status === "verifying" && verifier) {
                  const result = await verifier.verify(accepted.id);
                  if (result.verdict === "complete") {
                    const done = controller.commitComplete(
                      accepted.id,
                      accepted.generation,
                      result.reason,
                      result.snapshot,
                    );
                    record({ event: "completion.verified", goalID: accepted.id, reason: result.reason });
                    return reply(`Acceptance recorded. Completion verified: ${done.status}`);
                  }
                  controller.rejectCompletion(accepted.id, accepted.generation, result.reason);
                  return reply(
                    `Acceptance recorded, but completion is still unmet: ${result.unmet.join("; ")}`,
                  );
                }
                reply("Acceptance recorded for the current generation.");
                return;
              }
              if (verb === "replace") {
                if (!arg) return reply("Usage: /goal replace <objective>");
                const result = coordinator
                  ? await coordinator.replace(sessionID, arg)
                  : { goal: controller.replace(sessionID, arg) };
                reply(
                  `Replaced. Generation ${result.goal.generation} is now active. ${describeDrive(result.drive)}`,
                );
                return;
              }
              if (verb === "budget") {
                const goal = controller.status(sessionID);
                if (!goal) return reply("No active goal.");
                const used = goal.tokensUsed ?? 0;
                if (!arg) {
                  reply(
                    `Tokens: ${used}${goal.tokenBudget !== undefined ? ` / ${goal.tokenBudget}` : " (no budget set)"}`,
                  );
                  return;
                }
                if (/^(off|none|clear)$/i.test(arg)) {
                  controller.setBudget(sessionID, undefined);
                  return reply("Token budget cleared.");
                }
                // `/goal budget <n>` sets the ceiling; the controller enforces it.
                const n = Number(arg);
                if (!Number.isFinite(n) || n <= 0) return reply("Usage: /goal budget <positive number>");
                controller.setBudget(sessionID, Math.floor(n));
                reply(`Budget set to ${Math.floor(n)} tokens (used ${used}).`);
                return;
              }

              // `/goal <objective>` — start, or report that replacement is needed.
              const objective = raw;
              if (coordinator) {
                const result = await coordinator.start(sessionID, objective);
                if (result.existing) {
                  reply(
                    `A goal is already active (generation ${result.existing.generation}): ${result.existing.objective}\nUse /goal replace <objective> to supersede it.`,
                  );
                } else {
                  reply(
                    `Goal created (generation ${result.created!.generation}). ${describeDrive(result.drive)}`,
                  );
                }
                return;
              }
              const out = controller.startOrDescribe(sessionID, objective);
              if ("existing" in out) {
                reply(
                  `A goal is already active (generation ${out.existing.generation}): ${out.existing.objective}\nUse /goal replace <objective> to supersede it.`,
                );
              } else {
                reply(`Goal created (generation ${out.created.generation}); no driver is connected.`);
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
        const sessionID = sessionIDOf(event);
        record({
          event: "tool.execute.after",
          tool: event?.tool,
          sessionID,
          status: event?.status,
        });
        if (process.env.XGOAL_DEBUG_TOOLS === "1") {
          const result = (event?.result ?? null) as Record<string, unknown> | null;
          record({
            event: "tool.result.shape",
            tool: event?.tool,
            eventKeys: event && typeof event === "object" ? Object.keys(event) : [],
            resultKeys: result && typeof result === "object" ? Object.keys(result) : [],
            metadata: result?.metadata ?? null,
            content:
              typeof result?.content === "string" ? result.content.slice(0, 200) : undefined,
          });
        }

        // Capture evidence only for goals that are actually active, and only
        // from executions the controller observed. This is what makes evidence
        // machine-verifiable rather than model-asserted. The goal is resolved
        // from the message that produced the call, so a delayed execution from
        // a superseded goal cannot contaminate its replacement.
        if (!controller || !ledger || !sessionID) return;
        const ref = await resolveMessageRef(sessionID, event?.messageID);
        const goal = ref.goalID ? controller.store.byID(ref.goalID) : undefined;
        if (!goal || goal.status !== "active") return;
        const current = controller.status(sessionID);
        if (!current || current.id !== goal.id || current.generation !== goal.generation) return;
        try {
          const captured = ledger.capture({
            goalID: goal.id,
            tool: String(event?.tool ?? ""),
            status: event?.status === "completed" ? "completed" : "error",
            args: event?.input ?? event?.args,
            result: event?.result,
            workspace: await resolveSessionWorkspace(sessionID),
          });
          if (captured) {
            record({
              event: "evidence.captured",
              goalID: goal.id,
              kind: captured.kind,
              ref: captured.ref.slice(0, 120),
              exitCode: captured.exitCode ?? null,
            });
          }
        } catch (error) {
          record({ event: "evidence.capture.error", error: String(error) });
        }
      });
      record({ event: "tool.hook.execute.after", ok: true });
    } catch (error) {
      record({ event: "tool.hook.execute.after", ok: false, error: String(error) });
    }

    // ------------------------------------------------------ event stream
    // Events are wake-up signals only. The ledger is authoritative, so a missed
    // event degrades to "the next sweep catches it" rather than a stuck goal.
    const eventsSeen = new Set<string>();
    const IDLE_SIGNALS = new Set([
      "session.execution.succeeded",
      "session.execution.failed",
      "session.inbox.delivered",
    ]);
    let lastDrive = 0;
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: abort.signal })) {
          const type = String((event as { type?: unknown })?.type ?? "unknown");
          eventsSeen.add(type);
          observer.observe(event);
          record({ event: "event", type, total: eventsSeen.size });

          // A session can be moved to a different working directory (or
          // deleted) while the plugin is running. The cached workspace would
          // then send file-criterion checks to the wrong directory — silently
          // verifying against the old location. Invalidate on any session
          // lifecycle event; the next check re-resolves.
          if (type.startsWith("session.")) {
            const evtSession = String(
              (event as any)?.data?.sessionID ?? (event as any)?.properties?.sessionID ?? "",
            );
            if (
              evtSession &&
              (type === "session.updated" ||
                type === "session.moved" ||
                type === "session.deleted" ||
                type === "session.renamed")
            ) {
              sessionWorkspaces.delete(evtSession);
            }
          }

          // Session usage is a running total; charge the delta to the active
          // goal so the budget ceiling is driven by real usage rather than
          // staying at zero forever.
          if (controller && type === "session.usage.updated") {
            const data = (event as any)?.data;
            const usageSession = data?.sessionID;
            const tokens = data?.tokens;
            if (usageSession && tokens) {
              const total =
                Number(tokens.input ?? 0) +
                Number(tokens.output ?? 0) +
                Number(tokens.reasoning ?? 0) +
                Number(tokens.cache?.read ?? 0) +
                Number(tokens.cache?.write ?? 0);
              try {
                const goal = controller.recordUsage(usageSession, total);
                record({
                  event: "usage.recorded",
                  sessionID: usageSession,
                  tokensUsed: goal?.tokensUsed ?? null,
                  tokenBudget: goal?.tokenBudget ?? null,
                });
              } catch (error) {
                record({ event: "usage.record.error", error: String(error) });
              }
            }
          }

          if (!driver || !IDLE_SIGNALS.has(type)) continue;
          // Debounce: a burst of signals should produce one drive, not several.
          const now = Date.now();
          if (now - lastDrive < 500) continue;
          lastDrive = now;
          // The session id lives at data.sessionID on these events.
          const sessionID = sessionIDOf(event);
          if (!sessionID) continue;
          try {
            const outcome = await driver.drive(sessionID);
            record({ event: "driver.drive", sessionID, outcome: outcome.action });
          } catch (error) {
            record({ event: "driver.drive.error", sessionID, error: String(error) });
          }
        }
      } catch (error) {
        record({ event: "event.stream.error", error: String(error) });
      }
    })();

    record({ event: "setup.complete" });

    return async () => {
      abort.abort();
      if (sweep) clearInterval(sweep);
      try {
        controller?.close();
      } catch {
        /* closing twice is harmless */
      }
      record({ event: "cleanup", eventsObserved: eventsSeen.size });
    };
  },
};
