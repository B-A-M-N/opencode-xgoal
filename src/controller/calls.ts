/**
 * Goal reference selection for model-facing tool calls.
 *
 * A tool call belongs to the goal generation that produced the assistant
 * message carrying it. The message identity is authoritative. Model-supplied
 * `goal_id`/`generation` fields are only a fallback for hosts that do not expose
 * a message ID at all: if an identity exists but cannot be attributed to a
 * generation, the call is rejected rather than allowed to name the current goal.
 *
 * When a host exposes neither a message identity nor a complete goal reference,
 * the call fails closed. There is no path that mutates "whatever goal is
 * current", because that is exactly how a delayed callback from a superseded
 * execution contaminates its replacement.
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
  // Host without message identity: only a COMPLETE model-supplied reference is
  // admissible. An incomplete one is refused rather than topped up from
  // whatever goal happens to be current.
  if (input?.goal_id && input.generation !== undefined) {
    return { ok: true, ref: { goalID: input.goal_id, generation: input.generation } };
  }
  return {
    ok: false,
    reason:
      "this call carries neither a resolvable message identity nor a complete goal reference (goal_id and generation); call goal_get and retry",
  };
}

/** The minimal transcript view execution-ownership attribution needs. */
export interface TranscriptMessage {
  id: string;
  type?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Attribute a message to a goal execution by transcript position.
 *
 * Walks backward from the target message to the nearest preceding message that
 * belongs to a goal execution — a continuation we dispatched, or any message
 * with a durable recorded generation — and returns that generation. The walk
 * stops at a foreign user message: work that follows a human prompt belongs to
 * that human turn, so an assistant message produced after an interleaved
 * human prompt is never re-attributed to a continuation that preceded it.
 *
 * This is deliberately pure: the store lookups are injected, so the ordering
 * rule itself can be tested against synthetic transcripts. Timestamp
 * attribution is not used here at all — when several generations may have
 * overlapping execution lifetimes, wall-clock order cannot decide ownership.
 */
export function attributeMessageGeneration(
  messages: TranscriptMessage[],
  messageID: string,
  generationOf: (message: TranscriptMessage) => number | undefined,
): number | undefined {
  const index = messages.findIndex((m) => m?.id === messageID);
  if (index === -1) return undefined;
  for (let i = index - 1; i >= 0; i--) {
    const message = messages[i];
    if (!message) continue;
    const generation = generationOf(message);
    if (generation !== undefined) return generation;
    // A human turn severs attribution to anything before it.
    if (message.type === "user") return undefined;
  }
  return undefined;
}
