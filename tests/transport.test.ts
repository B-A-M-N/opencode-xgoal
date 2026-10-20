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

// Audit P1-6: settlement correlation. A human prompt interleaved after our
// continuation starts a NEW turn — a terminal assistant answering the human
// must never be scored as settlement of our round.
describe("settlement is bounded by the first foreign prompt", () => {
  test("a terminal assistant answering an interleaved human prompt is not settlement", async () => {
    const t = transport({
      inbox: [],
      messages: [
        { id: "msg_1", type: "synthetic" },
        { id: "asst_1", type: "assistant", finish: "tool-calls" },
        // The human interrupts; the session answers the human.
        { id: "human_1", type: "user" },
        { id: "asst_2", type: "assistant", finish: "stop" },
        { id: "idle_1", type: "idle" },
      ],
    });
    // Our round's own execution never observed a finish before the human
    // interjection: the outcome is not proven either way.
    expect(await t.probe({ sessionID: "ses_a", round: round() })).toBe("unknown");
  });

  test("a finish before the interleaved prompt still settles", async () => {
    const t = transport({
      inbox: [],
      messages: [
        { id: "msg_1", type: "synthetic" },
        // Our turn finished BEFORE the human spoke.
        { id: "asst_1", type: "assistant", finish: "stop" },
        { id: "human_1", type: "user" },
        { id: "asst_2", type: "assistant", finish: "stop" },
      ],
    });
    expect(await t.probe({ sessionID: "ses_a", round: round() })).toBe("settled");
  });

  test("an idle marker after the foreign prompt does not settle our round", async () => {
    const t = transport({
      inbox: [],
      messages: [
        { id: "msg_1", type: "synthetic" },
        { id: "asst_1", type: "assistant", finish: "tool-calls" },
        { id: "human_1", type: "user" },
        { id: "idle_1", type: "idle" },
      ],
    });
    expect(await t.probe({ sessionID: "ses_a", round: round() })).toBe("unknown");
  });
});

describe("live execution liveness", () => {
  test("running executions are tracked per session", () => {
    const observer = new RoundObserver();
    expect(observer.isBusy("ses_a")).toBe(false);
    observer.observe({ type: "session.execution.started", data: { sessionID: "ses_a" } });
    expect(observer.isBusy("ses_a")).toBe(true);
    expect(observer.isBusy("ses_b")).toBe(false);
    observer.observe({ type: "session.execution.succeeded", data: { sessionID: "ses_a" } });
    expect(observer.isBusy("ses_a")).toBe(false);
  });

  test("a completion for one session never releases another", () => {
    const observer = new RoundObserver();
    observer.observe({ type: "session.execution.started", data: { sessionID: "ses_a" } });
    observer.observe({ type: "session.execution.started", data: { sessionID: "ses_b" } });
    observer.observe({ type: "session.execution.failed", data: { sessionID: "ses_a" } });
    expect(observer.isBusy("ses_a")).toBe(false);
    expect(observer.isBusy("ses_b")).toBe(true);
  });

  test("SessionTransport.liveWait reflects the observer", () => {
    const observer = new RoundObserver();
    const t = new SessionTransport({ observer, send: async () => {} });
    expect(t.liveWait({ sessionID: "ses_a" })).toBe(false);
    observer.observe({ type: "session.execution.started", data: { sessionID: "ses_a" } });
    expect(t.liveWait({ sessionID: "ses_a" })).toBe(true);
  });

  // Audit P2 follow-up: a completion event that never arrives (dropped stream,
  // plugin reload) must not leak the busy reference — otherwise every future
  // round classifies as verifiedWait and the goal can never stall.
  test("transcript settlement releases a reference whose completion event was lost", () => {
    const observer = new RoundObserver();
    observer.observe({
      type: "session.execution.started",
      data: { sessionID: "ses_a", messageID: "msg_xgoal_x" },
    });
    expect(observer.isBusy("ses_a")).toBe(true);
    // No succeeded/failed event ever arrives. Settlement of the round from the
    // transcript is authoritative and releases the reference.
    observer.forget("msg_xgoal_x");
    expect(observer.isBusy("ses_a")).toBe(false);
  });

  test("duplicate started events do not double-count", () => {
    const observer = new RoundObserver();
    const started = {
      type: "session.execution.started",
      data: { sessionID: "ses_a", messageID: "msg_xgoal_y" },
    };
    observer.observe(started);
    observer.observe(started);
    observer.observe({
      type: "session.execution.succeeded",
      data: { sessionID: "ses_a", messageID: "msg_xgoal_y" },
    });
    // One release must fully clear the duplicated starts.
    expect(observer.isBusy("ses_a")).toBe(false);
  });
});
