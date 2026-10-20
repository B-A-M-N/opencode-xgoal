/**
 * Goal reference selection for model-facing tool calls.
 *
 * A tool call belongs to the goal generation that produced the assistant
 * message carrying it. The message identity is authoritative. Model-supplied
 * `goal_id`/`generation` fields are only a fallback for hosts that do not expose
 * a message ID at all: if an identity exists but cannot be attributed to a
 * generation, the call is rejected rather than allowed to name the current goal.
 */
export interface ToolRef {
  goalID?: string;
  generation?: number;
}

export type ToolRefChoice = { ok: true; ref: ToolRef } | { ok: false; reason: string };

export function selectToolRef(
  resolved: ToolRef,
  input: { goal_id?: string; generation?: number } | undefined,
  messageID: string | undefined,
): ToolRefChoice {
  if (resolved.goalID && resolved.generation !== undefined) {
    return { ok: true, ref: resolved };
  }
  if (messageID) {
    return {
      ok: false,
      reason:
        "this call could not be attributed to a goal generation from its message; call goal_get and retry from the current turn",
    };
  }
  return { ok: true, ref: { goalID: input?.goal_id, generation: input?.generation } };
}
