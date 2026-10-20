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
import type { Goal } from "./controller/state.ts";

export const RPC_ID = "local.opencode-xgoal";

const str = { type: "string" } as const;
const num = { type: "number" } as const;

/** Wire shape. Kept flat so the TUI can render it without extra logic. */
export interface GoalWire {
  id: string;
  generation: number;
  objective: string;
  status: string;
  reason?: string;
  rounds: number;
  noProgressRounds: number;
  tokensUsed?: number;
  tokenBudget?: number;
  criteria: { id: string; text: string; met: boolean }[];
}

function wire(controller: GoalController, goal: Goal | undefined): GoalWire | null {
  if (!goal) return null;
  return {
    id: goal.id,
    generation: goal.generation,
    objective: goal.objective,
    status: goal.status,
    reason: goal.reason,
    rounds: goal.rounds,
    noProgressRounds: goal.noProgressRounds,
    tokensUsed: goal.tokensUsed,
    tokenBudget: goal.tokenBudget,
    criteria: controller.store.listCriteria(goal.id),
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
      output: { type: "object", properties: { goal: goalOrNull } },
    },
    "goal.history": {
      input: { type: "object", properties: { sessionID: str }, required: ["sessionID"] },
      output: {
        type: "object",
        properties: { goals: { type: "array", items: { type: "object" } } },
      },
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
      output: { type: "object", properties: { goal: goalOrNull } },
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
 * Build the RPC handlers for a controller.
 *
 * Every method is defensive: RPC handlers run on the server, so a malformed
 * input must produce an error result rather than an exception that kills the
 * port.
 */
export function goalRpcHandlers(controller: GoalController) {
  return {
    "goal.status": async (input: { sessionID?: string }) => {
      if (!input?.sessionID) return { goal: null };
      return { goal: wire(controller, controller.status(input.sessionID)) };
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
        // against generation N must not replace generation N+1.
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
        return { goal: wire(controller, controller.resume(input.sessionID)) };
      } catch (error) {
        return { goal: null, error: String(error) };
      }
    },
  };
}
