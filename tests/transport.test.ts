/**
 * Phase 06 — authoritative continuation probing.
 *
 * The event stream is a cache. After a restart it is empty, and a missed event
 * must not strand a goal. These tests pin the probe to the session's own inbox
 * and transcript, and pin inbox correlation to metadata rather than to the
 * synthetic message's generated id.
 */
import { describe, expect, test } from "bun:test";
import { RoundObserver, SessionTransport, type SessionState } from "../src/controller/transport.ts";
import type { GoalRound } from "../src/controller/store.ts";

function round(inboxID = "msg_1"): GoalRound {
  return {
    id: "round_1",
    goalID: "goal_1",
    generation: 1,
    inboxID,
    status: "admitted",
    attempts: 1,
    evidenceBaseline: 0,
    preparedAtMs: 0,
  };
}

function transport(state: SessionState) {
  return new SessionTransport({
    observer: new RoundObserver(),
    send: async () => {},
    fetchState: async () => state,
  });
}

describe("authoritative probe", () => {
  test("settles from the transcript after a restart, with an empty observer", async () => {
    const t = transport({
      inbox: [],
      messages: [
        { id: "user_1", type: "user" },
        { id: "msg_1", type: "synthetic" },
        { id: "asst_1", type: "assistant", finish: "stop" },
      ],
    });
    expect(await t.probe({ sessionID: "ses_a", round: round() })).toBe("settled");
  });

  test("a queued inbox item is running, not settled", async () => {
    const t = transport({
      inbox: [{ id: "msg_1" }],
      messages: [{ id: "user_1", type: "user" }],
    });
    expect(await t.probe({ sessionID: "ses_a", round: round() })).toBe("running");
  });

  test("correlates by metadata.inboxID when the message id differs", async () => {
    const t = transport({
      inbox: [],
      messages: [
        { id: "synthetic_generated", type: "synthetic", metadata: { inboxID: "msg_1" } },
        { id: "asst_1", type: "assistant", finish: "stop" },
      ],
    });
    expect(await t.probe({ sessionID: "ses_a", round: round() })).toBe("settled");
  });

  test("tool-calls is not a finish: the turn is still running", async () => {
    const t = transport({
      inbox: [],
      messages: [
        { id: "msg_1", type: "synthetic" },
        { id: "asst_1", type: "assistant", finish: "tool-calls" },
      ],
    });
    expect(await t.probe({ sessionID: "ses_a", round: round() })).toBe("running");
  });

  test("an idle marker settles the turn", async () => {
    const t = transport({
      inbox: [],
      messages: [
        { id: "msg_1", type: "synthetic" },
        { id: "asst_1", type: "assistant", finish: "tool-calls" },
        { id: "idle_1", type: "idle" },
      ],
    });
    expect(await t.probe({ sessionID: "ses_a", round: round() })).toBe("settled");
  });

  test("absent everywhere is unknown, never a silent success", async () => {
    const t = transport({ inbox: [], messages: [] });
    expect(await t.probe({ sessionID: "ses_a", round: round() })).toBe("unknown");
  });

  test("a failed authoritative read degrades to the observer", async () => {
    const t = new SessionTransport({
      observer: new RoundObserver(),
      send: async () => {},
      fetchState: async () => {
        throw new Error("network down");
      },
    });
    expect(await t.probe({ sessionID: "ses_a", round: round() })).toBe("unknown");
  });
});
