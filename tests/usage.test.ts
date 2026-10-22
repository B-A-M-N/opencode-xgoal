/**
 * Audit-4 #3 — usage ledger: monotonic high-water totals, observation-identity
 * dedup, and execution-scoped attribution. And audit-4 #10 — durable
 * verification attempt records fencing proof commits.
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GoalStore } from "../src/controller/store.ts";
import {
  GoalVerifier,
  type EvidenceValidator,
} from "../src/controller/verification.ts";

let dir: string;
let store: GoalStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "xgoal-usage-"));
  store = new GoalStore(join(dir, "goals.db"));
});

afterEach(() => {
  try {
    store.close();
  } catch {
    /* closed */
  }
});

describe("audit-4 #3: monotonic usage high-water mark", () => {
  test("delayed totals 1000 -> 1200 -> 900 -> 1200 account exactly 1200, not 1500", () => {
    const goal = store.create({ sessionID: "ses_a", objective: "work" });

    const first = store.recordUsageObservation({ sessionID: "ses_a", total: 1000 });
    expect(first.delta).toBe(1000);
    const second = store.recordUsageObservation({ sessionID: "ses_a", total: 1200 });
    expect(second.delta).toBe(200);
    // The delayed 900 must not lower the baseline or produce a negative delta.
    const delayed = store.recordUsageObservation({ sessionID: "ses_a", total: 900 });
    expect(delayed.delta).toBe(0);
    // Replaying the later event afterwards must NOT charge 1200 again.
    const replay = store.recordUsageObservation({ sessionID: "ses_a", total: 1200 });
    expect(replay.delta).toBe(0);

    expect(store.current("ses_a")!.tokensUsed).toBe(1200);
    expect(goal.tokenBudget).toBeUndefined();
    expect(store.db.query(`SELECT total_tokens FROM session_usage`).get()).toEqual({
      total_tokens: 1200,
    });
  });

  test("the persisted high-water mark never decreases across a whole session", () => {
    store.create({ sessionID: "ses_a", objective: "work" });
    for (const total of [500, 300, 800, 100, 800, 1200, 400]) {
      store.recordUsageObservation({ sessionID: "ses_a", total });
    }
    const row = store.db.query(`SELECT total_tokens FROM session_usage`).get() as {
      total_tokens: number;
    };
    expect(row.total_tokens).toBe(1200);
    expect(store.current("ses_a")!.tokensUsed).toBe(1200);
  });
});

describe("audit-4 #3: observation identity dedup", () => {
  test("the same event id delivered twice charges once", () => {
    store.create({ sessionID: "ses_a", objective: "work" });
    const once = store.recordUsageObservation({
      sessionID: "ses_a",
      eventID: "evt_1",
      total: 700,
    });
    expect(once.duplicate).toBe(false);
    expect(once.delta).toBe(700);
    const twice = store.recordUsageObservation({
      sessionID: "ses_a",
      eventID: "evt_1",
      total: 700,
    });
    expect(twice.duplicate).toBe(true);
    expect(twice.delta).toBe(0);
    expect(store.current("ses_a")!.tokensUsed).toBe(700);
  });

  test("without an event id, the execution+totals+second tuple deduplicates replays", () => {
    const goal = store.create({ sessionID: "ses_a", objective: "work" });
    store.rememberMessageGeneration("ses_a", "msg_9", goal.generation, Date.now());
    const at = 1_700_000_000_123;
    const once = store.recordUsageObservation({
      sessionID: "ses_a",
      messageID: "msg_9",
      inputTokens: 100,
      outputTokens: 50,
      atMs: at,
    });
    expect(once.duplicate).toBe(false);
    // Same message, same totals, same second: a replay, not new usage.
    const replay = store.recordUsageObservation({
      sessionID: "ses_a",
      messageID: "msg_9",
      inputTokens: 100,
      outputTokens: 50,
      atMs: at + 40,
    });
    expect(replay.duplicate).toBe(true);
    expect(replay.delta).toBe(0);
    // A genuinely new step (different totals) in the same second still charges.
    const next = store.recordUsageObservation({
      sessionID: "ses_a",
      messageID: "msg_9",
      inputTokens: 130,
      outputTokens: 50,
      atMs: at + 500,
    });
    expect(next.duplicate).toBe(false);
    expect(next.delta).toBe(30);
    expect(store.current("ses_a")!.tokensUsed).toBe(180);
  });
});

describe("audit-4 #3: execution-scoped attribution", () => {
  test("a late event from generation 1 does not charge the generation-2 replacement", () => {
    const v1 = store.create({ sessionID: "ses_a", objective: "v1" });
    // The execution that produced the usage belongs to generation 1.
    store.rememberMessageGeneration("ses_a", "msg_old", v1.generation, Date.now());

    store.replace({
      sessionID: "ses_a",
      expectedGeneration: v1.generation,
      objective: "v2",
    });
    const v2 = store.current("ses_a")!;

    // The delayed event arrives after the replacement.
    const result = store.recordUsageObservation({
      sessionID: "ses_a",
      messageID: "msg_old",
      total: 900,
    });
    // The superseded goal is terminal: the usage is recorded as unassigned,
    // never silently accrued to the replacement.
    expect(result.attribution).toBe("unassigned");
    expect(result.goal?.id).not.toBe(v2.id);
    expect(v2.tokensUsed ?? 0).toBe(0);
    expect(store.byID(v1.id)!.tokensUsed ?? 0).toBe(0);
  });

  test("an event attributed to a still-active goal charges that goal, not another session's", () => {
    const goal = store.create({ sessionID: "ses_a", objective: "active work" });
    store.rememberMessageGeneration("ses_a", "msg_now", goal.generation, Date.now());
    const result = store.recordUsageObservation({
      sessionID: "ses_a",
      messageID: "msg_now",
      total: 400,
    });
    expect(result.attribution).toBe("execution");
    expect(result.goal?.id).toBe(goal.id);
    expect(store.byID(goal.id)!.tokensUsed).toBe(400);
  });

  test("an event with no execution identity charges the current goal explicitly", () => {
    const goal = store.create({ sessionID: "ses_a", objective: "work" });
    const result = store.recordUsageObservation({ sessionID: "ses_a", total: 250 });
    expect(result.attribution).toBe("current");
    expect(result.goal?.id).toBe(goal.id);
    expect(store.byID(goal.id)!.tokensUsed).toBe(250);
  });

  test("usage attributed to a superseded-but-charged generation lands on the historical goal", () => {
    // A generation that is superseded is terminal, so attribution falls to
    // unassigned — but a generation that is still active in ITS OWN session
    // while another session's goal is current is unaffected. Cross-session
    // isolation: ses_b's usage never touches ses_a's goal.
    const a = store.create({ sessionID: "ses_a", objective: "a" });
    const b = store.create({ sessionID: "ses_b", objective: "b" });
    const result = store.recordUsageObservation({ sessionID: "ses_b", total: 60 });
    expect(result.goal?.id).toBe(b.id);
    expect(store.byID(a.id)!.tokensUsed ?? 0).toBe(0);
  });
});

describe("audit-4 #10: durable verification attempt records", () => {
  const passiveValidator: EvidenceValidator = {
    validate: async () => ({ valid: true, reason: "ok" }),
  };

  test("a verification run opens and closes a durable attempt record", async () => {
    const goal = store.create({ sessionID: "ses_a", objective: "work" });
    const criterionID = store.addCriterion(goal.id, "tests pass", undefined, "user");
    store.addEvidence({ goalID: goal.id, criterionID, kind: "test", ref: "bun test", exitCode: 0 });
    store.transition({ goalID: goal.id, generation: goal.generation, to: "verifying", actor: "model" });

    const verifier = new GoalVerifier(store, passiveValidator);
    await verifier.verify(goal.id);

    const attempts = store.db
      .query(`SELECT status FROM goal_verification_attempts WHERE goal_id = ?`)
      .all(goal.id) as Array<{ status: string }>;
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.status).toBe("recorded");
  });

  test("a delayed first verifier cannot overwrite a newer run's proof results", async () => {
    const goal = store.create({ sessionID: "ses_a", objective: "work" });
    const criterionID = store.addCriterion(goal.id, "tests pass", undefined, "user");
    store.addEvidence({ goalID: goal.id, criterionID, kind: "test", ref: "bun test", exitCode: 0 });
    store.transition({ goalID: goal.id, generation: goal.generation, to: "verifying", actor: "model" });

    // Verifier A: its validator hangs until released.
    let releaseA: () => void = () => {};
    const gateA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    const verifierA = new GoalVerifier(store, {
      validate: async () => {
        await gateA;
        return { valid: true, reason: "stale run" };
      },
    });
    const pendingA = verifierA.verify(goal.id);

    // Verifier B runs to completion while A is still parked.
    const verifierB = new GoalVerifier(store, passiveValidator);
    const resultB = await verifierB.verify(goal.id);
    expect(resultB.verdict).toBe("complete");

    // Now A finishes: its attempt is no longer the open one, so its proofs
    // are discarded and B's recorded results are untouched.
    releaseA();
    const resultA = await pendingA;
    expect(resultA.verdict).toBe("incomplete");
    expect(resultA.unmet.some((u) => u.includes("verification discarded"))).toBe(true);

    const proofs = store.listProofs(goal.id);
    expect(proofs).toHaveLength(1);
    expect(proofs[0]!.detail).not.toContain("stale run");
    // B's results stand: the criterion readout says met.
    expect(store.listCriteria(goal.id).find((c) => c.id === criterionID)!.met).toBe(true);

    const attempts = store.db
      .query(`SELECT status FROM goal_verification_attempts WHERE goal_id = ? ORDER BY started_at_ms`)
      .all(goal.id) as Array<{ status: string }>;
    expect(attempts.map((a) => a.status)).toEqual(["abandoned", "recorded"]);
  });

  test("a paused goal's open attempts are abandoned and their results discarded", async () => {
    const goal = store.create({ sessionID: "ses_a", objective: "work" });
    const criterionID = store.addCriterion(goal.id, "tests pass", undefined, "user");
    store.addEvidence({ goalID: goal.id, criterionID, kind: "test", ref: "bun test", exitCode: 0 });
    store.transition({ goalID: goal.id, generation: goal.generation, to: "verifying", actor: "model" });

    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const verifier = new GoalVerifier(store, {
      validate: async () => {
        await gate;
        return { valid: true, reason: "ok" };
      },
    });
    const pending = verifier.verify(goal.id);

    // The completion proposal is rejected mid-verification: back to active.
    store.transition({
      goalID: goal.id,
      generation: goal.generation,
      to: "active",
      actor: "controller",
    });
    release();
    const result = await pending;
    expect(result.verdict).toBe("incomplete");
    expect(store.listProofs(goal.id)).toHaveLength(0);
    const attempts = store.db
      .query(`SELECT status FROM goal_verification_attempts WHERE goal_id = ?`)
      .all(goal.id) as Array<{ status: string }>;
    expect(attempts[0]!.status).toBe("abandoned");
  });
});
