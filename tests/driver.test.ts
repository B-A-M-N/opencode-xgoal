/**
 * Phase 03 — native continuation.
 *
 * Fault injection at each stage: before admission, after admission, during
 * execution, and after completion. The gate is that recovery must never
 * duplicate a continuation prompt.
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GoalStore } from "../src/controller/store.ts";
import { GoalController } from "../src/controller/controller.ts";
import {
  GoalDriver,
  newInboxID,
  type ContinuationTransport,
  type ProbeResult,
  type SubmitResult,
} from "../src/controller/driver.ts";

let dir: string;
let dbPath: string;
let store: GoalStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "xgoal-drv-"));
  dbPath = join(dir, "goals.db");
  store = new GoalStore(dbPath);
});

afterEach(() => {
  try {
    store.close();
  } catch {
    /* closed by test */
  }
  rmSync(dir, { recursive: true, force: true });
});

/** A transport whose behaviour each test can steer, recording every call. */
class FakeTransport implements ContinuationTransport {
  submitted: { sessionID: string; inboxID: string; text: string }[] = [];
  probed: string[] = [];
  submitResult: SubmitResult = { ok: true };
  probeResult: ProbeResult = "unknown";
  /** Throw instead of returning, to simulate a transport-level explosion. */
  throwOnSubmit = false;
  /** Reported by liveWait: whether a background execution is still running. */
  liveWaitResult = false;
  /** Runs inside submit, before returning — lets a test inspect DB state. */
  onSubmit?: (inboxID: string) => void;

  async submit(input: {
    sessionID: string;
    inboxID: string;
    text: string;
    metadata: Record<string, unknown>;
  }): Promise<SubmitResult> {
    this.submitted.push(input);
    this.onSubmit?.(input.inboxID);
    if (this.throwOnSubmit) throw new Error("transport exploded");
    return this.submitResult;
  }

  async probe(input: { sessionID: string; round: { id: string } }): Promise<ProbeResult> {
    this.probed.push(input.round.id);
    return this.probeResult;
  }

  liveWait(): boolean {
    return this.liveWaitResult;
  }
}

function setup() {
  const transport = new FakeTransport();
  const driver = new GoalDriver(store, transport);
  const goal = store.create({ sessionID: "ses_a", objective: "build the replacement" });
  return { transport, driver, goal };
}

describe("reserve before submit", () => {
  test("the attempt is persisted before the transport is called", () => {
    const { transport, driver, goal } = setup();

    let roundAtSubmitTime: string | undefined;
    transport.onSubmit = (inboxID) => {
      // At the moment of submission the round must already exist, marked
      // prepared, carrying this exact inbox id.
      const round = store.roundByInboxID(inboxID);
      roundAtSubmitTime = round?.status;
    };

    return driver.drive("ses_a").then(() => {
      expect(roundAtSubmitTime).toBe("prepared");
      expect(store.roundsFor(goal.id)).toHaveLength(1);
    });
  });

  test("a crash between reserve and submit is recoverable, not lost", async () => {
    const { transport, driver, goal } = setup();

    // Simulate the process dying after reserving but before submitting.
    const reserved = store.prepareRound({
      goalID: goal.id,
      generation: goal.generation,
      inboxID: newInboxID(),
    });
    expect(reserved.status).toBe("prepared");
    expect(transport.submitted).toHaveLength(0);

    // The reconciler finds it and dispatches it, reusing the reserved id.
    transport.probeResult = "notDelivered";
    await driver.reconcile();

    expect(transport.submitted).toHaveLength(1);
    expect(transport.submitted[0].inboxID).toBe(reserved.inboxID);
  });
});

describe("idempotency", () => {
  test("a timeout marks the round unknown and retries with the SAME id", async () => {
    const { transport, driver } = setup();

    transport.submitResult = { ok: false, retryable: true, error: "ETIMEDOUT" };
    const first = await driver.drive("ses_a");
    expect(first.action).toBe("unknown");

    const inboxID = transport.submitted[0].inboxID;
    const round = store.roundByInboxID(inboxID)!;
    expect(round.status).toBe("unknown");
    expect(round.attempts).toBe(2);

    // Recovery re-submits. Critically: same id, no new attempt minted.
    transport.probeResult = "notDelivered";
    transport.submitResult = { ok: true };
    await driver.reconcile();

    expect(transport.submitted).toHaveLength(2);
    expect(transport.submitted[1].inboxID).toBe(inboxID);
    // Still exactly one round row: a retry is not a second attempt.
    expect(store.roundsFor(round.goalID)).toHaveLength(1);
  });

  test("a transport exception is ambiguous, not a failure", async () => {
    const { transport, driver } = setup();
    transport.throwOnSubmit = true;
    const out = await driver.drive("ses_a");
    expect(out.action).toBe("unknown");
    expect(store.roundsFor(store.current("ses_a")!.id)[0].status).toBe("unknown");
  });

  test("a definitive rejection is recorded as an admission failure", async () => {
    const { transport, driver, goal } = setup();
    transport.submitResult = { ok: false, retryable: false, error: "400 bad request" };
    const out = await driver.drive("ses_a");
    expect(out.action).toBe("failed");
    const round = store.roundsFor(goal.id)[0];
    expect(round.status).toBe("failed");
    // Crucially: this must NOT be counted as a model no-progress round.
    expect(store.current("ses_a")!.noProgressRounds).toBe(0);
    expect(store.current("ses_a")!.rounds).toBe(0);
  });
});

describe("admission is not execution", () => {
  test("admission leaves the round outstanding until an outcome is observed", async () => {
    const { transport, driver, goal } = setup();
    const out = await driver.drive("ses_a");
    expect(out.action).toBe("admitted");

    const round = store.roundsFor(goal.id)[0];
    expect(round.status).toBe("admitted");
    // Still outstanding: the goal has not advanced just because the message was
    // accepted.
    expect(store.outstandingRound(goal.id)?.id).toBe(round.id);
    expect(store.current("ses_a")!.rounds).toBe(0);
  });

  test("a second drive while a round is outstanding does not submit again", async () => {
    const { transport, driver } = setup();
    await driver.drive("ses_a");
    expect(transport.submitted).toHaveLength(1);

    const second = await driver.drive("ses_a");
    expect(second.action).toBe("reconcile");
    // The gate: no duplicate continuation prompt.
    expect(transport.submitted).toHaveLength(1);
  });

  test("reconcile does not re-submit a round that is running", async () => {
    const { transport, driver } = setup();
    await driver.drive("ses_a");

    transport.probeResult = "running";
    await driver.reconcile();
    // A running round is in flight: re-sending would duplicate it.
    expect(transport.submitted).toHaveLength(1);
  });

  test("a settled round is settled, not left outstanding or re-sent", async () => {
    const { transport, driver, goal } = setup();
    await driver.drive("ses_a");

    transport.probeResult = "settled";
    await driver.reconcile();

    // The finished round is settled and counted exactly once.
    const original = store.roundsFor(goal.id)[0];
    expect(original.status).toBe("settled");
    // No evidence was captured in this round, so it is not progress. A turn
    // that only emitted text must not reset the stall counter.
    expect(original.classification).toBe("noProgress");

    // The same round is never re-submitted; the next continuation carries a
    // different inbox ID.
    expect(transport.submitted).toHaveLength(2);
    expect(transport.submitted[1].inboxID).not.toBe(transport.submitted[0].inboxID);
  });

  test("a settled round with new evidence is progress", async () => {
    const { transport, driver, goal } = setup();
    await driver.drive("ses_a");
    // Evidence captured during this round, after it was prepared.
    store.addEvidence({ goalID: goal.id, kind: "test", ref: "bun test", detail: "exit 0", exitCode: 0 });

    transport.probeResult = "settled";
    await driver.reconcile();

    const round = store.roundsFor(goal.id)[0];
    expect(round.status).toBe("settled");
    expect(round.classification).toBe("progress");
    expect(store.current("ses_a")!.noProgressRounds).toBe(0);
  });

  test("an unknown probe leaves the round outstanding without re-submitting", async () => {
    const { transport, driver, goal } = setup();
    await driver.drive("ses_a");
    transport.probeResult = "unknown";
    await driver.reconcile();
    expect(transport.submitted).toHaveLength(1);
    expect(store.outstandingRound(goal.id)).toBeDefined();
  });
});

describe("concurrency", () => {
  test("two concurrent drives admit exactly one continuation", async () => {
    const { transport, driver } = setup();
    const [a, b] = await Promise.all([driver.drive("ses_a"), driver.drive("ses_a")]);
    const actions = [a.action, b.action].sort();
    expect(actions).toContain("admitted");
    expect(transport.submitted).toHaveLength(1);
    expect(store.roundsFor(store.current("ses_a")!.id)).toHaveLength(1);
  });

  test("a second reservation on a goal with an outstanding round is refused", () => {
    const { goal } = setup();
    store.prepareRound({ goalID: goal.id, generation: 1, inboxID: newInboxID() });
    expect(() =>
      store.prepareRound({ goalID: goal.id, generation: 1, inboxID: newInboxID() }),
    ).toThrow();
  });

  test("inbox ids are unique across many mints", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 2000; i++) ids.add(newInboxID());
    expect(ids.size).toBe(2000);
  });
});

describe("fencing and recovery", () => {
  test("a round for a superseded goal is failed at replace time, never re-submitted", async () => {
    const { transport, driver, goal } = setup();
    // Reserve, then supersede before dispatch.
    const stale = store.prepareRound({ goalID: goal.id, generation: 1, inboxID: newInboxID() });
    store.replace({ sessionID: "ses_a", expectedGeneration: 1, objective: "new objective" });

    // The replacement fails the stale round in its own transaction — before
    // any reconcile sweep runs.
    expect(store.roundByID(stale.id)!.status).toBe("failed");
    expect(store.roundByID(stale.id)!.detail).toContain("superseded");

    // Nothing outstanding remains for the sweep to find, and nothing was sent.
    const outcomes = await driver.reconcile();
    expect(outcomes.filter((o) => "roundID" in o && o.roundID === stale.id)).toHaveLength(0);
    expect(transport.submitted).toHaveLength(0);
  });

  test("a stale round is cleaned up by reconcile and never blocks the new goal", async () => {
    const { transport, driver, goal } = setup();
    const stale = store.prepareRound({
      goalID: goal.id,
      generation: 1,
      inboxID: newInboxID(),
    });
    const replacement = store.replace({
      sessionID: "ses_a",
      expectedGeneration: 1,
      objective: "newer objective",
    });

    // drive() targets the current goal, so it must not touch the dead one.
    const out = await driver.drive("ses_a");
    expect(out.action).toBe("admitted");
    expect(transport.submitted).toHaveLength(1);
    // The submission is for the replacement, never the superseded objective.
    expect(transport.submitted[0].text).toContain("newer objective");
    expect(transport.submitted[0].text).not.toContain("build the replacement");

    // The stale round is failed by the replacement itself, with a reason. It
    // must never be re-submitted.
    expect(store.roundByID(stale.id)!.status).toBe("failed");
    expect(store.roundByID(stale.id)!.detail).toContain("superseded");
    const outcomes = await driver.reconcile();
    const staleOutcome = outcomes.find((o) => "roundID" in o && o.roundID === stale.id);
    expect(staleOutcome).toBeUndefined();

    // The real invariant: nothing submitted ever carried the superseded
    // objective. (The replacement's own undelivered round is legitimately
    // retried, so a bare submission count would be the wrong assertion.)
    expect(transport.submitted.length).toBeGreaterThanOrEqual(1);
    for (const s of transport.submitted) {
      expect(s.text).toContain("newer objective");
      expect(s.text).not.toContain("build the replacement");
    }
    expect(store.current("ses_a")?.id).toBe(replacement.id);
  });

  test("a round is failed after too many submission attempts", async () => {
    const { transport, driver, goal } = setup();
    const round = store.prepareRound({
      goalID: goal.id,
      generation: 1,
      inboxID: newInboxID(),
    });
    // Push attempts past the cap.
    for (let i = 0; i < 6; i++) store.markRoundUnknown(round.id, "timeout");

    transport.probeResult = "notDelivered";
    const outcomes = await driver.reconcile();
    expect(outcomes[0].action).toBe("failed");
    expect(transport.submitted).toHaveLength(0);
  });

  test("recovery after restart does not duplicate continuations", async () => {
    const { transport, driver, goal } = setup();
    // A round was admitted, then the process died.
    const round = store.prepareRound({
      goalID: goal.id,
      generation: 1,
      inboxID: newInboxID(),
    });
    store.markRoundAdmitted(round.id);
    store.close();

    // New process.
    store = new GoalStore(dbPath);
    const transport2 = new FakeTransport();
    transport2.probeResult = "settled";
    const driver2 = new GoalDriver(store, transport2, {
      classify: () => ({ classification: "progress" }),
    });
    await driver2.reconcile();

    // The admitted round is settled, never re-sent with the same ID.
    expect(store.roundByInboxID(round.inboxID)?.status).toBe("settled");
    for (const s of transport2.submitted) {
      expect(s.inboxID).not.toBe(round.inboxID);
    }
    // The goal is still active, so the loop continues with a NEW continuation.
    expect(transport2.submitted).toHaveLength(1);
  });
});

describe("permanent delivery failure is parked until explicit recovery", () => {
  test("a definitive rejection is never redriven by recovery sweeps", async () => {
    const { transport, driver, goal } = setup();
    // A permanent HTTP 400: not retryable.
    transport.submitResult = { ok: false, retryable: false, error: "400 bad request" };
    const out = await driver.drive("ses_a");
    expect(out.action).toBe("failed");
    expect(store.byID(goal.id)!.deliveryFailed).toBe(true);

    // 100 automatic sweeps. The old behaviour cleared the delivery block on
    // each sweep, minting a fresh continuation every time — an unbounded
    // retry loop against a permanently failing endpoint.
    transport.submitResult = { ok: true };
    for (let i = 0; i < 100; i++) {
      await driver.reconcile();
      await driver.drive("ses_a");
    }
    // Exactly one submission: the original rejected one. No redrive.
    expect(transport.submitted).toHaveLength(1);
    expect(store.roundsFor(goal.id)).toHaveLength(1);
    expect(store.byID(goal.id)!.deliveryFailed).toBe(true);

    // Explicit recovery: exactly one permitted retry, using a fresh id (the
    // rejected round is settled; its id is not reused).
    const controller = new GoalController({ dbPath });
    try {
      controller.resume("ses_a");
    } finally {
      controller.close();
    }
    expect(store.byID(goal.id)!.deliveryFailed).toBe(false);
    const retry = await driver.drive("ses_a");
    expect(retry.action).toBe("admitted");
    expect(transport.submitted).toHaveLength(2);
    // And the recovered goal does not immediately fail again in a loop.
    await driver.reconcile();
    expect(transport.submitted).toHaveLength(2);
  });

  test("a round abandoned because the goal was paused is not a delivery failure", async () => {
    const { transport, driver, goal } = setup();
    // Reserve, then pause before the transport is ever called.
    const round = store.prepareRound({
      goalID: goal.id,
      generation: 1,
      inboxID: newInboxID(),
    });
    store.transition({ goalID: goal.id, generation: 1, to: "paused", actor: "user" });

    transport.probeResult = "notDelivered";
    await driver.reconcile();

    expect(store.roundByID(round.id)!.status).toBe("failed");
    // Nothing was submitted, so no delivery failure may be recorded — a pause
    // must not require an "explicit recovery" the user never caused.
    expect(store.byID(goal.id)!.deliveryFailed).toBe(false);
    expect(transport.submitted).toHaveLength(0);
  });

  test("a superseded goal's failed round does not park the replacement", async () => {
    const { transport, driver, goal } = setup();
    const stale = store.prepareRound({ goalID: goal.id, generation: 1, inboxID: newInboxID() });
    store.replace({ sessionID: "ses_a", expectedGeneration: 1, objective: "new objective" });

    transport.probeResult = "notDelivered";
    await driver.reconcile();

    expect(store.roundByID(stale.id)!.status).toBe("failed");
    // The replacement must be immediately drivable: supersession is not a
    // transport failure of anything.
    const out = await driver.drive("ses_a");
    expect(out.action).toBe("admitted");
  });
});

describe("settling", () => {
  test("settling a round records the classification on both round and goal", async () => {
    const { transport, driver, goal } = setup();
    await driver.drive("ses_a");
    const round = store.roundsFor(goal.id)[0];

    const g = driver.settleRound({
      roundID: round.id,
      classification: "progress",
      detail: "implemented phase 03",
      tokensUsed: 250,
    });

    expect(store.roundByID(round.id)!.status).toBe("settled");
    expect(store.roundByID(round.id)!.classification).toBe("progress");
    expect(g?.rounds).toBe(1);
    expect(g?.tokensUsed).toBe(250);
    // Settling clears it from the outstanding set, allowing the next round.
    expect(store.outstandingRound(goal.id)).toBeUndefined();
    void transport;
  });

  test("a settled round allows a subsequent continuation", async () => {
    const { transport, driver, goal } = setup();
    await driver.drive("ses_a");
    const first = store.roundsFor(goal.id)[0];
    driver.settleRound({ roundID: first.id, classification: "progress" });

    const second = await driver.drive("ses_a");
    expect(second.action).toBe("admitted");
    expect(transport.submitted).toHaveLength(2);
    // A fresh round gets a fresh id — that is a genuine second continuation.
    expect(transport.submitted[0].inboxID).not.toBe(transport.submitted[1].inboxID);
  });
});

describe("resource limits", () => {
  test("the driver limits rather than dispatching when the budget is spent", async () => {
    const { transport, driver, goal } = setup();
    store.db.query("UPDATE goals SET token_budget = 100, tokens_used = 100 WHERE id = ?").run(goal.id);

    const out = await driver.drive("ses_a");
    expect(out.action).toBe("limited");
    expect(store.current("ses_a")?.status).toBe("budgetLimited");
    expect(transport.submitted).toHaveLength(0);
  });

  test("a non-active goal is not driven", async () => {
    const { transport, driver } = setup();
    store.transition({
      goalID: store.current("ses_a")!.id,
      generation: 1,
      to: "paused",
      actor: "user",
    });
    const out = await driver.drive("ses_a");
    expect(out.action).toBe("idle");
    expect(transport.submitted).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Audit defect 2 — the settle -> evaluate -> continue loop must actually run.
// Before the fix, a settled round was left outstanding forever: drive() kept
// returning `reconcile` and no second continuation was ever submitted.
// ---------------------------------------------------------------------------
describe("settled rounds drive the next continuation", () => {
  test("a settled round is settled and the loop continues", async () => {
    const transport = new FakeTransport();
    const driver = new GoalDriver(store, transport, {
      classify: () => ({ classification: "progress" }),
    });
    const goal = store.create({ sessionID: "ses_a", objective: "build the replacement" });

    // First turn: reserve + submit.
    const first = await driver.drive("ses_a");
    expect(first.action).toBe("admitted");
    expect(transport.submitted).toHaveLength(1);
    expect(goal.rounds).toBe(0);

    // The model stops. The round has actually finished.
    transport.probeResult = "settled";
    const second = await driver.drive("ses_a");

    // The round was settled AND the next continuation was submitted.
    expect(second.action).toBe("admitted");
    expect(transport.submitted).toHaveLength(2);

    const rounds = store.roundsFor(goal.id);
    expect(rounds).toHaveLength(2);
    expect(rounds[0].status).toBe("settled");
    expect(rounds[0].classification).toBe("progress");
    // The round counter was incremented exactly once for the settled round.
    expect(store.current("ses_a")!.rounds).toBe(1);
  });

  test("a duplicate terminal event does not double-count the round", async () => {
    const transport = new FakeTransport();
    const driver = new GoalDriver(store, transport, {
      classify: () => ({ classification: "progress" }),
    });
    const goal = store.create({ sessionID: "ses_a", objective: "x" });

    await driver.drive("ses_a");
    transport.probeResult = "settled";

    // Simulate the same `session.execution.succeeded` arriving twice.
    await driver.drive("ses_a");
    const rounds = store.roundsFor(goal.id);
    const settled = rounds.filter((r) => r.status === "settled");
    expect(settled).toHaveLength(1);
    expect(rounds[0].classification).toBe("progress");

    // The counter reflects one settled round, not two.
    expect(store.current("ses_a")!.rounds).toBe(1);
  });

  test("a no-progress classification is recorded and can stall the goal", async () => {
    const transport = new FakeTransport();
    const driver = new GoalDriver(store, transport, {
      maxNoProgressRounds: 2,
      classify: () => ({ classification: "noProgress" }),
    });
    store.create({ sessionID: "ses_a", objective: "x" });

    await driver.drive("ses_a");
    transport.probeResult = "settled";
    await driver.drive("ses_a");
    expect(store.current("ses_a")!.noProgressRounds).toBe(1);

    // Second unproductive round reaches the stall threshold.
    transport.probeResult = "settled";
    await driver.drive("ses_a");
    expect(store.current("ses_a")!.noProgressRounds).toBe(2);

    transport.probeResult = "settled";
    await driver.drive("ses_a");
    expect(store.current("ses_a")!.status).toBe("stalled");
    // Two rounds were settled and counted; the third drive stalled the goal
    // before reserving another continuation.
    expect(store.current("ses_a")!.rounds).toBe(2);
    expect(store.current("ses_a")!.noProgressRounds).toBe(2);
  });
});

// Audit P1-5: progress classification used the DEFAULT classifier wired to
// real evidence, but counted checkpoint refs as evidence — so a model could
// avoid the stall threshold by narrating (goal_checkpoint) instead of working.
describe("progress classification counts only verifiable evidence", () => {
  test("checkpoint spam cannot avoid the stall threshold", async () => {
    const transport = new FakeTransport();
    // Production configuration: no custom classifier, so DEFAULT_CLASSIFY runs.
    const driver = new GoalDriver(store, transport, { maxNoProgressRounds: 3 });
    const goal = store.create({ sessionID: "ses_a", objective: "build the replacement" });

    // Ten rounds, each doing nothing but emitting a checkpoint (ref evidence).
    for (let i = 0; i < 10; i++) {
      await driver.drive("ses_a");
      store.addEvidence({
        goalID: goal.id,
        kind: "ref",
        ref: `checkpoint narrative ${i}`,
        detail: "progress notes",
      });
      transport.probeResult = "settled";
      await driver.drive("ses_a");
      if (store.current("ses_a")!.status === "stalled") break;
    }

    // The refs never counted: the goal stalled at the configured threshold
    // instead of being kept alive by narration.
    expect(store.current("ses_a")!.status).toBe("stalled");
    expect(store.current("ses_a")!.noProgressRounds).toBe(3);
    // Checkpoints WERE captured — and still no round counted as progress.
    expect(store.listEvidence(goal.id).filter((e) => e.kind === "ref").length).toBeGreaterThan(0);
  });

  test("a legitimate investigation with new observations counts as progress", async () => {
    const transport = new FakeTransport();
    const driver = new GoalDriver(store, transport, { maxNoProgressRounds: 1 });
    const goal = store.create({ sessionID: "ses_a", objective: "diagnose the flake" });

    // Dispatch the first continuation.
    await driver.drive("ses_a");

    // A multi-turn investigation: each turn runs a command (machine-observed
    // evidence) and settles. No file is edited — that is still real progress,
    // and with the threshold at 1 a single miscount would stall the goal.
    for (let i = 0; i < 5; i++) {
      store.addEvidence({
        goalID: goal.id,
        kind: "command",
        ref: `cat logs/attempt-${i}.log`,
        detail: "exit 0",
        exitCode: 0,
      });
      transport.probeResult = "settled";
      await driver.drive("ses_a");
    }

    expect(store.current("ses_a")!.status).toBe("active");
    expect(store.current("ses_a")!.noProgressRounds).toBe(0);
  });

  test("a verified live wait does not accumulate toward a stall", async () => {
    const transport = new FakeTransport();
    const driver = new GoalDriver(store, transport, { maxNoProgressRounds: 2 });
    store.create({ sessionID: "ses_a", objective: "wait for the migration" });

    // Three settled rounds with no new evidence, but an execution observably
    // running each time: waiting on a real job, not spinning.
    transport.liveWaitResult = true;
    for (let i = 0; i < 3; i++) {
      await driver.drive("ses_a");
      transport.probeResult = "settled";
      await driver.drive("ses_a");
    }

    expect(store.current("ses_a")!.status).toBe("active");
    expect(store.current("ses_a")!.noProgressRounds).toBe(0);
    const settled = store
      .roundsFor(store.current("ses_a")!.id)
      .filter((r) => r.status === "settled");
    expect(settled.every((r) => r.classification === "verifiedWait")).toBe(true);

    // Once the job finishes (no more live wait), unproductive rounds count
    // again — the stall policy still applies to genuine spinning.
    transport.liveWaitResult = false;
    await driver.drive("ses_a");
    expect(store.current("ses_a")!.noProgressRounds).toBe(1);
    await driver.drive("ses_a");
    expect(store.current("ses_a")!.status).toBe("stalled");
  });
});
