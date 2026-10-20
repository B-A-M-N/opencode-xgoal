/**
 * Audit P1-3 — execution ownership fencing.
 *
 * A tool call belongs to the goal generation that actually produced the
 * assistant message carrying it. Attribution is by transcript position: the
 * nearest preceding continuation claims the message, and a foreign human
 * prompt stops the walk. Timestamp attribution is not authoritative when
 * several generations may have overlapping execution lifetimes — which the
 * same-millisecond tests exercise directly.
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attributeMessageGeneration } from "../src/controller/calls.ts";
import type { TranscriptMessage } from "../src/controller/calls.ts";
import { GoalStore } from "../src/controller/store.ts";
import {
  GoalDriver,
  type ContinuationTransport,
  type ProbeResult,
  type SubmitResult,
} from "../src/controller/driver.ts";

/** Build a transcript where continuations are recognisable anchors. */
function transcript(spec: Array<[id: string, type: string]>): TranscriptMessage[] {
  return spec.map(([id, type]) => ({ id, type }));
}

describe("attributeMessageGeneration", () => {
  test("the nearest preceding continuation claims the message", () => {
    const messages = transcript([
      ["msg_xgoal_a", "user"],
      ["asst_1", "assistant"],
      ["asst_2", "assistant"],
    ]);
    const gen = attributeMessageGeneration(messages, "asst_2", (m) =>
      m.id === "msg_xgoal_a" ? 1 : undefined,
    );
    expect(gen).toBe(1);
  });

  test("a later continuation wins over an earlier one", () => {
    const messages = transcript([
      ["msg_xgoal_a", "user"],
      ["asst_1", "assistant"],
      ["msg_xgoal_b", "user"],
      ["asst_2", "assistant"],
    ]);
    const gen = attributeMessageGeneration(messages, "asst_2", (m) =>
      m.id === "msg_xgoal_a" ? 1 : m.id === "msg_xgoal_b" ? 2 : undefined,
    );
    expect(gen).toBe(2);
  });

  // The core race: a foreign human prompt between the continuation and the
  // assistant message starts a NEW turn. Work after it belongs to the human
  // turn, not to the goal execution that ended before the prompt.
  test("a foreign user prompt stops the walk", () => {
    const messages = transcript([
      ["msg_xgoal_a", "user"],
      ["asst_1", "assistant"],
      ["human_1", "user"],
      ["asst_2", "assistant"],
    ]);
    const gen = attributeMessageGeneration(messages, "asst_2", (m) =>
      m.id === "msg_xgoal_a" ? 1 : undefined,
    );
    expect(gen).toBeUndefined();
  });

  test("an assistant message answering a human prompt directly is unattributed", () => {
    const messages = transcript([
      ["human_1", "user"],
      ["asst_1", "assistant"],
    ]);
    const gen = attributeMessageGeneration(messages, "asst_1", () => undefined);
    expect(gen).toBeUndefined();
  });

  test("an unknown message is unattributed, not guessed", () => {
    const messages = transcript([
      ["msg_xgoal_a", "user"],
      ["asst_1", "assistant"],
    ]);
    const gen = attributeMessageGeneration(messages, "missing", (m) =>
      m.id === "msg_xgoal_a" ? 1 : undefined,
    );
    expect(gen).toBeUndefined();
  });
});

// ------------------------------------------------------------ store + driver

let dir: string;
let store: GoalStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "xgoal-call-"));
  store = new GoalStore(join(dir, "goals.db"));
});

afterEach(() => {
  try {
    store.close();
  } catch {
    /* closed */
  }
  rmSync(dir, { recursive: true, force: true });
});

/** A transport that admits everything and records the submissions. */
class FakeTransport implements ContinuationTransport {
  submitted: { sessionID: string; inboxID: string }[] = [];
  submitResult: SubmitResult = { ok: true };
  probeResult: ProbeResult = "unknown";
  async submit(input: {
    sessionID: string;
    inboxID: string;
    text: string;
    metadata: Record<string, unknown>;
  }): Promise<SubmitResult> {
    this.submitted.push(input);
    return this.submitResult;
  }
  async probe(): Promise<ProbeResult> {
    return this.probeResult;
  }
}

describe("continuations are bound to their generation at admission", () => {
  test("the admitted inbox ID resolves to the round's generation", async () => {
    const transport = new FakeTransport();
    const driver = new GoalDriver(store, transport);
    const goal = store.create({ sessionID: "ses_a", objective: "build the thing" });

    const out = await driver.drive("ses_a");
    expect(out.action).toBe("admitted");
    const inboxID = transport.submitted[0].inboxID;
    expect(store.resolveMessageGeneration("ses_a", inboxID)).toBe(goal.generation);
  });

  test("an admitted continuation of a superseded goal stays fenced to its own generation", async () => {
    const transport = new FakeTransport();
    const driver = new GoalDriver(store, transport);
    const first = store.create({ sessionID: "ses_a", objective: "first" });
    await driver.drive("ses_a");
    const firstInbox = transport.submitted[0].inboxID;

    // Replace while the first execution is still admitted (in flight).
    store.replace({
      sessionID: "ses_a",
      expectedGeneration: first.generation,
      objective: "second",
    });

    // The late continuation is still attributed to generation 1, so its tool
    // calls are rejected by generation fencing rather than contaminating
    // generation 2.
    expect(store.resolveMessageGeneration("ses_a", firstInbox)).toBe(1);
  });
});

describe("timestamp attribution is ambiguous across generations", () => {
  test("creation-time order does not decide generation ownership", () => {
    const now = Date.now();
    const g1 = store.create({ sessionID: "ses_b", objective: "one" });
    const g2 = store.replace({
      sessionID: "ses_b",
      expectedGeneration: g1.generation,
      objective: "two",
    });
    // The replacement's creation timestamp lands before the goal it
    // superseded — possible with clock adjustments, same-millisecond
    // granularity, or writes from separate processes. Wall-clock order now
    // claims a message produced after the replacement belongs to the
    // SUPERSEDED generation: exactly the misattribution that
    // transcript-position fencing exists to prevent, and why the timestamp
    // fallback is disabled as soon as a session has more than one generation.
    store.db
      .query(`UPDATE goals SET created_at_ms = ? WHERE id = ?`)
      .run(now, g1.id);
    store.db
      .query(`UPDATE goals SET created_at_ms = ? WHERE id = ?`)
      .run(now - 1, g2.id);

    expect(store.generationAt("ses_b", now)).toBe(1);
    expect(store.generationCount("ses_b")).toBe(2);
  });

  test("a single-generation session still resolves by timestamp", () => {
    const goal = store.create({ sessionID: "ses_c", objective: "one" });
    expect(store.generationCount("ses_c")).toBe(1);
    expect(store.generationAt("ses_c", Date.now() + 1000)).toBe(goal.generation);
  });
});
