/**
 * OpenCode-XGoal — server RPC contract for the TUI companion.
 *
 * Replacement goes through this surface rather than through the dialog, because
 * the dialog is a UI affordance, not an atomic transition. The dialog collects
 * intent; `goal.replace` performs the generation-checked transition on the
 * server, where the concurrency control lives.
 *
 * Plain JSON Schema is used for inputs and outputs, as the V2 RPC accepts
 * (`PortableValueSchema = StandardSchemaV1 | JsonSchema.JsonSchema`).
 */
import type { GoalController } from "./controller/controller.ts";
import type { GoalCoordinator } from "./controller/coordinator.ts";
import type { Goal } from "./controller/state.ts";
import type { CriterionSpec } from "./controller/criteria.ts";

export const RPC_ID = "local.opencode-xgoal";

const str = { type: "string" } as const;
const num = { type: "number" } as const;

/** Wire shape. Kept flat so the TUI can render it without extra logic. */
export interface GoalWire {
  id: string;
  generation: number;
  objective: string;
  status: string;
  reason: string | null;
  rounds: number;
  noProgressRounds: number;
  tokensUsed: number | null;
  tokenBudget: number | null;
  criteria: CriterionWire[];
}

/**
 * Wire shape of one criterion. Store rows carry optional fields (`spec`,
 * `covers`) whose absent value is `undefined` — not a JSON value — so each is
 * coerced to `null` here. An uncoerced `undefined` is rejected by the RPC
 * output schema, which would turn a successful mutation into a serialization
 * error reported to the caller.
 */
export interface CriterionWire {
  id: string;
  text: string;
  met: boolean;
  spec: Record<string, unknown> | null;
  source: string;
  covers: string[] | null;
}

function criterionWire(row: {
  id: string;
  text: string;
  met: boolean;
  spec?: CriterionSpec;
  source: string;
  covers?: string[];
}): CriterionWire {
  return {
    id: row.id,
    text: row.text,
    met: row.met,
    spec: (row.spec as Record<string, unknown> | undefined) ?? null,
    source: row.source,
    covers: row.covers ?? null,
  };
}

function wire(controller: GoalController, goal: Goal | undefined): GoalWire | null {
  if (!goal) return null;
  // Every field must be a JSON value. `undefined` is not, and the RPC output
  // schema rejects it — which would turn a successful mutation into a
  // serialization error reported to the caller. Coerce to null.
  return {
    id: goal.id,
    generation: goal.generation,
    objective: goal.objective,
    status: goal.status,
    reason: goal.reason ?? null,
    rounds: goal.rounds,
    noProgressRounds: goal.noProgressRounds,
    tokensUsed: goal.tokensUsed ?? null,
    tokenBudget: goal.tokenBudget ?? null,
    criteria: controller.store.listCriteria(goal.id).map(criterionWire),
  };
}

const goalOrNull = {
  anyOf: [{ type: "object" }, { type: "null" }],
} as const;

/**
 * The portable RPC definition.
 *
 * `expectedGeneration` is required on replace: the caller must state which goal
 * it believes is current, so a stale confirmation cannot clobber a newer goal.
 */
export const goalRpcDefinition = {
  id: RPC_ID,
  methods: {
    "goal.status": {
      input: { type: "object", properties: { sessionID: str }, required: ["sessionID"] },
      output: {
        type: "object",
        properties: { current: goalOrNull, latest: goalOrNull, goal: goalOrNull },
      },
    },
    "goal.history": {
      input: { type: "object", properties: { sessionID: str }, required: ["sessionID"] },
      output: {
        type: "object",
        properties: { goals: { type: "array", items: { type: "object" } } },
      },
    },
    "goal.create": {
      input: {
        type: "object",
        properties: { sessionID: str, objective: str },
        required: ["sessionID", "objective"],
      },
      output: { type: "object", properties: { goal: goalOrNull, error: str, drive: { type: "object" } } },
    },
    "goal.replace": {
      input: {
        type: "object",
        properties: {
          sessionID: str,
          objective: str,
          expectedGeneration: num,
        },
        required: ["sessionID", "objective", "expectedGeneration"],
      },
      output: { type: "object", properties: { goal: goalOrNull, error: str } },
    },
    "goal.pause": {
      input: { type: "object", properties: { sessionID: str }, required: ["sessionID"] },
      output: { type: "object", properties: { goal: goalOrNull } },
    },
    "goal.resume": {
      input: { type: "object", properties: { sessionID: str }, required: ["sessionID"] },
      output: { type: "object", properties: { goal: goalOrNull, error: str } },
    },
    "goal.accept": {
      input: {
        type: "object",
        properties: {
          sessionID: str,
          note: str,
          // Generation fencing (audit-4 #12): the goal the user confirmed.
          // A stale pair is rejected instead of silently accepting whatever
          // replacement is current by arrival time.
          goalID: str,
          expectedGeneration: num,
        },
        required: ["sessionID"],
      },
      output: { type: "object", properties: { goal: goalOrNull, error: str } },
    },
    "goal.health": {
      input: { type: "object", properties: { sessionID: str }, required: ["sessionID"] },
      output: { type: "object", properties: { health: { type: "object" } } },
    },
    "goal.budget": {
      input: {
        type: "object",
        properties: { sessionID: str, budget: num },
        required: ["sessionID"],
      },
      output: { type: "object", properties: { goal: goalOrNull, error: str } },
    },
  },
  events: {
    "goal.changed": {
      schema: {
        type: "object",
        properties: { sessionID: str, status: str, generation: num },
      },
    },
  },
} as const;

/**
 * The subset of the verifier the RPC surface needs. Kept structural so this
 * module does not depend on the verification internals.
 */
export interface AcceptanceVerifier {
  verify(goalID: string): Promise<{
    verdict: "complete" | "incomplete";
    reason: string;
    unmet: string[];
    snapshot?: string;
  }>;
}

/**
 * Build the RPC handlers for a controller.
 *
 * Every method is defensive: RPC handlers run on the server, so a malformed
 * input must produce an error result rather than an exception that kills the
 * port.
 */
export function goalRpcHandlers(
  controller: GoalController,
  coordinator?: GoalCoordinator,
  verifier?: AcceptanceVerifier,
) {
  return {
    "goal.status": async (input: { sessionID?: string }) => {
      if (!input?.sessionID) return { current: null, latest: null, goal: null };
      // `current` is the goal in progress (nonterminal) — what a replacement
      // confirmation must be rendered against. `latest` is the most recent
      // goal including a completed one, for status readouts. `goal` is kept as
      // an alias of `latest` for existing consumers.
      const latest = wire(controller, controller.latest(input.sessionID));
      const current = wire(controller, controller.status(input.sessionID));
      return { current, latest, goal: latest };
    },

    "goal.history": async (input: { sessionID?: string }) => {
      if (!input?.sessionID) return { goals: [] };
      return {
        goals: controller
          .history(input.sessionID)
          .map((g) => wire(controller, g))
          .filter(Boolean),
      };
    },

    "goal.create": async (input: { sessionID?: string; objective?: string }) => {
      const { sessionID, objective } = input ?? {};
      if (!sessionID || !objective) {
        return { goal: null, error: "sessionID and objective are required" };
      }
      try {
        if (coordinator) {
          const result = await coordinator.start(sessionID, objective);
          const goal = result.created ?? result.existing;
          if (result.existing) {
            return {
              goal: wire(controller, result.existing),
              error: `a goal is already active (generation ${result.existing.generation}); replace it explicitly`,
            };
          }
          return { goal: wire(controller, goal), drive: result.drive ?? null };
        }
        const out = controller.startOrDescribe(sessionID, objective);
        return { goal: wire(controller, "created" in out ? out.created : out.existing) };
      } catch (error) {
        return { goal: null, error: String(error) };
      }
    },

    "goal.replace": async (input: {
      sessionID?: string;
      objective?: string;
      expectedGeneration?: number;
    }) => {
      const { sessionID, objective, expectedGeneration } = input ?? {};
      if (!sessionID || !objective || typeof expectedGeneration !== "number") {
        return { goal: null, error: "sessionID, objective and expectedGeneration are required" };
      }
      try {
        // The generation check is the whole point: a confirmation rendered
        // against generation N must not replace generation N+1. The coordinator
        // then schedules the new generation so it actually executes.
        if (coordinator) {
          const result = await coordinator.replace(sessionID, objective, expectedGeneration);
          return { goal: wire(controller, result.goal), drive: result.drive ?? null };
        }
        const goal = controller.replace(sessionID, objective, expectedGeneration);
        return { goal: wire(controller, goal) };
      } catch (error) {
        return { goal: null, error: String(error) };
      }
    },

    "goal.pause": async (input: { sessionID?: string }) => {
      if (!input?.sessionID) return { goal: null };
      try {
        return { goal: wire(controller, controller.pause(input.sessionID)) };
      } catch (error) {
        return { goal: null, error: String(error) };
      }
    },

    "goal.resume": async (input: { sessionID?: string }) => {
      if (!input?.sessionID) return { goal: null };
      try {
        if (coordinator) {
          const result = await coordinator.resume(input.sessionID);
          return { goal: wire(controller, result.goal), drive: result.drive ?? null };
        }
        return { goal: wire(controller, controller.resume(input.sessionID)) };
      } catch (error) {
        return { goal: null, error: String(error) };
      }
    },

    "goal.accept": async (input: {
      sessionID?: string;
      note?: string;
      goalID?: string;
      expectedGeneration?: number;
    }) => {
      if (!input?.sessionID) return { goal: null, error: "sessionID is required" };
      try {
        // A USER action only: it records explicit acceptance of the
        // objective-level remainder that cannot be machine-proven. If
        // completion was waiting on exactly this, finish it now rather than
        // leaving the user to re-trigger the model.
        const expected =
          input.goalID && typeof input.expectedGeneration === "number"
            ? { goalID: input.goalID, generation: input.expectedGeneration }
            : undefined;
        const accepted = controller.acceptObjective(input.sessionID, input.note, expected);
        if (accepted.status === "verifying" && verifier) {
          const result = await verifier.verify(accepted.id);
          if (result.verdict === "complete") {
            const done = controller.commitComplete(
              accepted.id,
              accepted.generation,
              result.reason,
              result.snapshot,
            );
            return { goal: wire(controller, done) };
          }
          controller.rejectCompletion(accepted.id, accepted.generation, result.reason);
          return {
            goal: wire(controller, controller.status(input.sessionID)),
            error: `acceptance recorded, but completion is still unmet: ${result.unmet.join("; ")}`,
          };
        }
        return { goal: wire(controller, accepted) };
      } catch (error) {
        return { goal: null, error: String(error) };
      }
    },

    "goal.health": async (input: { sessionID?: string }) => {
      if (!input?.sessionID) return { health: { ok: false, error: "sessionID is required" } };
      try {
        return { health: controller.health(input.sessionID) };
      } catch (error) {
        return { health: { ok: false, error: String(error) } };
      }
    },

    "goal.budget": async (input: { sessionID?: string; budget?: number }) => {
      if (!input?.sessionID) return { goal: null, error: "sessionID is required" };
      try {
        const budget =
          typeof input.budget === "number" && Number.isFinite(input.budget) && input.budget > 0
            ? Math.floor(input.budget)
            : undefined;
        return { goal: wire(controller, controller.setBudget(input.sessionID, budget)) };
      } catch (error) {
        return { goal: null, error: String(error) };
      }
    },
  };
}
