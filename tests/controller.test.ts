/**
 * Phase 02 — controller authority split.
 *
 * These are the behaviours that distinguish the replacement from the legacy
 * plugin: the model proposes, the controller decides, and a workflow question
 * is not a blocker.
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GoalController } from "../src/controller/controller.ts";
import { selectToolRef } from "../src/controller/calls.ts";
import type { Goal } from "../src/controller/state.ts";

let dir: string;
let controller: GoalController;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "xgoal-ctl-"));
  controller = new GoalController({ dbPath: join(dir, "goals.db") });
});

afterEach(() => {
  try {
    controller.close();
  } catch {
    /* closed by test */
  }
  rmSync(dir, { recursive: true, force: true });
});

/** The current goal's fencing reference, as a model tool call must supply. */
function ref(sessionID = "ses_a"): { goalID: string; generation: number } {
  const goal = controller.status(sessionID);
  if (!goal) throw new Error(`no current goal for ${sessionID}`);
  return { goalID: goal.id, generation: goal.generation };
}

/** Create a goal that must not already exist. */
function start(objective: string, sessionID = "ses_a"): Goal {
  const out = controller.startOrDescribe(sessionID, objective);
  if (!("created" in out)) throw new Error(`a goal already exists for ${sessionID}`);
  return out.created;
}

describe("model cannot commit its own completion", () => {
  test("proposeComplete only moves the goal to verifying", () => {
    controller.startOrDescribe("ses_a", "fix all bugs in the subsystem");
    const out = controller.proposeComplete("ses_a", { ...ref(), summary: "I finished everything" });

    expect(out.goal?.status).toBe("verifying");
    // Crucially, not complete — the model's assertion is a proposal.
    expect(out.goal?.status).not.toBe("complete");
    expect(out.goal?.completedAtMs).toBeUndefined();
  });

  test("only the controller can commit completion", () => {
    controller.startOrDescribe("ses_a", "x");
    controller.proposeComplete("ses_a", { ...ref(), summary: "done" });
    const goal = controller.status("ses_a")!;
    const committed = controller.commitComplete(goal.id, goal.generation, "evidence verified");
    expect(committed.status).toBe("complete");
    expect(committed.completedAtMs).toBeDefined();
  });

  test("a rejected completion returns the goal to active, not complete", () => {
    controller.startOrDescribe("ses_a", "x");
    controller.proposeComplete("ses_a", { ...ref(), summary: "done, honest" });
    const goal = controller.status("ses_a")!;
    const back = controller.rejectCompletion(
      goal.id,
      goal.generation,
      "verification failed: no evidence for criterion 2",
    );
    expect(back?.status).toBe("active");
    expect(back?.completedAtMs).toBeUndefined();
    expect(back?.reason).toContain("verification failed");
  });
});

describe("blockers must be genuine", () => {
  test("a workflow question is rejected as a blocker, not counted", () => {
    controller.startOrDescribe("ses_a", "build the replacement");
    const out = controller.reportBlocked("ses_a", {
      ...ref(),
      reason: "I finished phase 01 and asked the user whether to push or continue",
    });
    expect(out.accepted).toBe(false);
    // Classification precedes counting: a workflow question accrues nothing.
    expect(out.confirmations).toBe(0);
    expect(out.rejected).toContain("workflow question");
    // The goal is still drivable.
    expect(controller.status("ses_a")?.status).toBe("active");
  });

  test("REGRESSION: a workflow question never blocks, even across five rounds", () => {
    controller.startOrDescribe("ses_a", "deliver the migration");
    const question = "Should I push phase 1 or continue phase 2?";
    for (let round = 1; round <= 5; round++) {
      const out = controller.reportBlocked("ses_a", {
        ...ref(),
        reason: question,
        externalDependency: true, // even asserted as one
        evidenceRefs: [`probe output ${round}`],
      });
      expect(out.accepted).toBe(false);
      expect(out.confirmations).toBe(0);
      expect(out.rejected).toContain("workflow question");
      // A new round between reports does not change the class. The idle rounds
      // may eventually trip the STALL policy (that is its job), but a blocker
      // must never be manufactured from repetition.
      controller.classifyRound("ses_a", "noProgress");
      expect(controller.status("ses_a")?.status).not.toBe("blocked");
    }
    expect(controller.status("ses_a")?.status).not.toBe("blocked");
  });

  test("a claim without backing evidence cannot confirm, even repeated", () => {
    controller.startOrDescribe("ses_a", "x");
    const first = controller.reportBlocked("ses_a", {
      ...ref(),
      reason: "waiting on vendor API key",
      externalDependency: true, // asserted, but nothing cited
    });
    expect(first.accepted).toBe(false);
    // The same assertion in a later round is still just an assertion.
    controller.classifyRound("ses_a", "noProgress");
    const second = controller.reportBlocked("ses_a", {
      ...ref(),
      reason: "waiting on vendor API key",
      externalDependency: true,
    });
    expect(second.accepted).toBe(false);
    expect(second.confirmations).toBe(0);
    expect(controller.status("ses_a")?.status).toBe("active");
  });

  test("repeating the same claim without a new observation adds no confirmation", () => {
    controller.startOrDescribe("ses_a", "x");
    // Round 1: the controller observed the failed auth probe; the claim cites it.
    controller.store.addEvidence({
      goalID: ref().goalID,
      kind: "command",
      ref: "auth --check",
      detail: "exit 1",
      exitCode: 1,
    });
    const out1 = controller.reportBlocked("ses_a", {
      ...ref(),
      reason: "cannot proceed without the production API credential",
      externalDependency: true,
      evidenceRefs: ["auth --check"],
    });
    expect(out1.accepted).toBe(false);
    expect(out1.confirmations).toBe(1);

    // Round 2: same reason, same evidence, nothing newly observed — a
    // repetition, not an independent confirmation.
    controller.classifyRound("ses_a", "noProgress");
    const out2 = controller.reportBlocked("ses_a", {
      ...ref(),
      reason: "cannot proceed without the production API credential",
      externalDependency: true,
      evidenceRefs: ["auth --check"],
    });
    expect(out2.accepted).toBe(false);
    expect(out2.confirmations).toBe(1);
    expect(controller.status("ses_a")?.status).toBe("active");
  });

  test("REGRESSION: an unavailable credential with a fresh observation blocks", () => {
    controller.startOrDescribe("ses_a", "deploy the release");
    // Round 1: the controller observed the failed auth probe; the claim cites it.
    controller.store.addEvidence({
      goalID: ref().goalID,
      kind: "command",
      ref: "auth --check",
      detail: "exit 1",
      exitCode: 1,
    });
    const out1 = controller.reportBlocked("ses_a", {
      ...ref(),
      reason: "cannot proceed without the production API credential",
      externalDependency: true,
      evidenceRefs: ["auth --check"],
    });
    expect(out1.accepted).toBe(false);
    expect(out1.confirmations).toBe(1);
    controller.classifyRound("ses_a", "noProgress");

    // Round 2: the model re-ran the probe and the controller observed it — a
    // NEW observation of the same unresolved dependency.
    controller.store.addEvidence({
      goalID: ref().goalID,
      kind: "command",
      ref: "auth --check --verbose",
      detail: "exit 1",
      exitCode: 1,
    });
    const out2 = controller.reportBlocked("ses_a", {
      ...ref(),
      reason: "cannot proceed without the production API credential",
      externalDependency: true,
      evidenceRefs: ["auth --check --verbose"],
    });
    expect(out2.accepted).toBe(true);
    expect(out2.confirmations).toBe(2);
    expect(out2.goal?.status).toBe("blocked");
  });

  test("REGRESSION: the Phase 01 scenario cannot force blocked or stalled", () => {
    // The exact situation the legacy plugin mis-scored: a milestone is done and
    // the agent asks an optional workflow question.
    controller.startOrDescribe("ses_a", "produce a working replacement /goal plugin");
    controller.checkpoint("ses_a", { ...ref(), summary: "phase 01 complete and committed" });

    const out = controller.reportBlocked("ses_a", {
      ...ref(),
      reason: "waiting for the user's decision on whether to publish the baseline or continue",
    });

    expect(out.accepted).toBe(false);
    const goal = controller.status("ses_a")!;
    expect(goal.status).toBe("active");
    expect(goal.status).not.toBe("blocked");
    expect(goal.status).not.toBe("stalled");
    expect(goal.noProgressRounds).toBe(0);
  });

  test("a blocker claim carrying a stale goal reference is refused", () => {
    const { created } = controller.startOrDescribe("ses_a", "one") as { created: any };
    const second = controller.replace("ses_a", "two");

    // The model reports against the goal it last saw, which is now superseded.
    const out = controller.reportBlocked("ses_a", {
      reason: "stuck",
      externalDependency: true,
      goalID: created.id,
      generation: created.generation,
    });

    expect(out.accepted).toBe(false);
    expect(out.rejected).toContain("stale goal reference");
    // The replacement is untouched and still active.
    expect(controller.status("ses_a")?.id).toBe(second.id);
    expect(controller.status("ses_a")?.status).toBe("active");
  });

  test("a stale generation on the same goal is refused", () => {
    controller.startOrDescribe("ses_a", "one");
    const second = controller.replace("ses_a", "two");
    const out = controller.reportBlocked("ses_a", {
      reason: "stuck",
      externalDependency: true,
      goalID: second.id,
      generation: 1, // current is 2
    });
    expect(out.accepted).toBe(false);
    expect(out.rejected).toContain("stale generation");
    expect(controller.status("ses_a")?.status).toBe("active");
  });

  test("checkpoint and proposeComplete are also ref-fenced", () => {
    const { created } = controller.startOrDescribe("ses_a", "one") as { created: any };
    controller.replace("ses_a", "two");

    const cp = controller.checkpoint("ses_a", {
      summary: "late checkpoint",
      goalID: created.id,
      generation: created.generation,
    });
    expect(cp.recorded).toBe(false);
    expect(cp.rejected).toContain("stale goal reference");

    const pc = controller.proposeComplete("ses_a", {
      summary: "late completion claim",
      goalID: created.id,
      generation: created.generation,
    });
    expect(pc.rejected).toContain("stale goal reference");
    expect(controller.status("ses_a")?.status).toBe("active");
  });
});

describe("progress accounting and stall policy", () => {
  test("investigation counts as progress, not no-progress", () => {
    controller.startOrDescribe("ses_a", "x");
    const g = controller.classifyRound("ses_a", "progress", "narrowed the failure to the token refresh path");
    expect(g?.status).toBe("active");
    expect(g?.noProgressRounds).toBe(0);
  });

  test("a verified wait does not accumulate toward a stall", () => {
    controller.startOrDescribe("ses_a", "x");
    controller.classifyRound("ses_a", "noProgress");
    const g = controller.classifyRound("ses_a", "verifiedWait", "test suite still running (pid 1234)");
    expect(g?.noProgressRounds).toBe(0);
    expect(g?.status).toBe("active");
  });

  test("stalls only after repeated genuinely unproductive rounds", () => {
    controller.startOrDescribe("ses_a", "x");
    expect(controller.classifyRound("ses_a", "noProgress")?.status).toBe("active");
    expect(controller.classifyRound("ses_a", "noProgress")?.status).toBe("active");
    const third = controller.classifyRound("ses_a", "noProgress");
    expect(third?.status).toBe("stalled");
    expect(third?.reason).toContain("without progress");
  });

  test("a stalled goal can be resumed by the user", () => {
    controller.startOrDescribe("ses_a", "x");
    controller.classifyRound("ses_a", "noProgress");
    controller.classifyRound("ses_a", "noProgress");
    controller.classifyRound("ses_a", "noProgress");
    expect(controller.status("ses_a")?.status).toBe("stalled");
    const resumed = controller.resume("ses_a");
    expect(resumed.status).toBe("active");
  });
});

describe("resource limits", () => {
  test("budget exhaustion limits the goal, and only the user can clear it", () => {
    const { created } = controller.startOrDescribe("ses_a", "x") as { created: any };
    expect(created.status).toBe("active");
    // Set a budget then consume it.
    controller.store.db.query("UPDATE goals SET token_budget = 100 WHERE id = ?").run(created.id);
    controller.classifyRound("ses_a", "progress", "work", 120);

    const limited = controller.enforceBudget("ses_a");
    expect(limited?.status).toBe("budgetLimited");
    // The model cannot resume it (transition table); the user can.
    const resumed = controller.resume("ses_a");
    expect(resumed.status).toBe("active");
  });
});

describe("replacement via the controller", () => {
  test("replace supersedes and preserves history", () => {
    controller.startOrDescribe("ses_a", "original objective");
    const second = controller.replace("ses_a", "new objective");
    expect(second.generation).toBe(2);
    expect(second.status).toBe("active");
    expect(controller.history("ses_a")).toHaveLength(2);
    expect(controller.history("ses_a").map((g) => g.status)).toEqual(["active", "superseded"]);
  });

  test("startOrDescribe reports an existing goal instead of silently replacing", () => {
    controller.startOrDescribe("ses_a", "one");
    const out = controller.startOrDescribe("ses_a", "two");
    expect("existing" in out).toBe(true);
    expect(controller.status("ses_a")?.objective).toBe("one");
  });

  test("replace creates a goal when none exists", () => {
    const goal = controller.replace("ses_a", "fresh");
    expect(goal.generation).toBe(1);
    expect(goal.status).toBe("active");
  });
});

describe("startup reconciliation", () => {
  test("a goal stranded mid-verification is returned to active on startup", () => {
    controller.startOrDescribe("ses_a", "x");
    controller.proposeComplete("ses_a", { ...ref(), summary: "done" });
    expect(controller.status("ses_a")?.status).toBe("verifying");
    controller.close();

    const reopened = new GoalController({ dbPath: join(dir, "goals.db") });
    try {
      const repaired = reopened.reconcileStartup();
      expect(repaired).toHaveLength(1);
      expect(reopened.status("ses_a")?.status).toBe("active");
    } finally {
      reopened.close();
    }
    controller = new GoalController({ dbPath: join(dir, "goals.db") });
  });
});

describe("completion binding and post-completion lifecycle", () => {
  test("a proposal may bind evidence using the criterion's exact text", () => {
    const goal = start("make the suite pass");
    const criterion = controller.store.listCriteria(goal.id)[0];
    controller.store.addEvidence({
      goalID: goal.id,
      kind: "test",
      ref: "bun test",
      exitCode: 0,
    });

    // Models often echo the criterion text instead of its opaque ID. Accept it
    // when it is unambiguous, otherwise the binding silently does nothing and
    // an objective-level criterion can never be proven.
    const out = controller.proposeComplete("ses_a", {
      ...ref(),
      summary: "done",
      criteria: [{ criterionID: criterion.text, evidenceRefs: ["bun test"] }],
    });

    expect(out.rejected).toBeUndefined();
    expect(out.goal?.status).toBe("verifying");
    const bound = controller.store
      .listEvidence(goal.id)
      .filter((e) => e.criterionID === criterion.id);
    expect(bound.map((e) => e.ref)).toContain("bun test");
  });

  test("a new goal after a completed one gets the next generation", () => {
    const first = start("one");
    controller.store.transition({
      goalID: first.id,
      generation: first.generation,
      to: "superseded",
      actor: "user",
    });

    const second = start("two");
    expect(second.generation).toBe(2);
    expect(controller.latest("ses_a")?.id).toBe(second.id);
    expect(controller.status("ses_a")?.status).toBe("active");
  });

  test("latest reports a terminal goal while status reports none", () => {
    const goal = start("one");
    controller.store.transition({
      goalID: goal.id,
      generation: goal.generation,
      to: "superseded",
      actor: "user",
    });
    expect(controller.latest("ses_a")?.status).toBe("superseded");
    expect(controller.status("ses_a")).toBeUndefined();
  });
});

describe("model tool calls are fenced to their message identity", () => {
  const resolved = { goalID: "goal_from_message", generation: 3 };

  test("the resolved message generation wins over model-supplied refs", () => {
    const choice = selectToolRef(resolved, { goal_id: "spoofed", generation: 99 }, "msg_1");
    expect(choice).toEqual({ ok: true, ref: resolved });
  });

  test("an unresolvable message identity is rejected, not guessed", () => {
    const choice = selectToolRef({}, { goal_id: "goal_current", generation: 2 }, "msg_1");
    expect(choice.ok).toBe(false);
    if (!choice.ok) expect(choice.reason).toContain("could not be attributed");
  });

  test("input refs are only accepted when the host exposes no message identity", () => {
    const choice = selectToolRef({}, { goal_id: "legacy_goal", generation: 1 }, undefined);
    expect(choice).toEqual({ ok: true, ref: { goalID: "legacy_goal", generation: 1 } });
  });

  // Audit P1-3: the old fallback let a call with neither message identity nor
  // a complete reference through as an empty ref, to be resolved against
  // whatever goal was current. That is how a delayed callback from a
  // superseded execution contaminates its replacement.
  test("a call with neither message identity nor a complete reference fails closed", () => {
    const bare = selectToolRef({}, undefined, undefined);
    expect(bare.ok).toBe(false);
    if (!bare.ok) expect(bare.reason).toContain("neither");

    const partial = selectToolRef({}, { goal_id: "goal_only" }, undefined);
    expect(partial.ok).toBe(false);
  });
});

// Audit P1-4: the model could not register criteria at all, and there was no
// way to retire a derived criterion investigation proved wrong.
describe("criterion refinement is additive, idempotent and fenced", () => {
  test("adding an identical requirement twice returns the existing criterion", () => {
    const goal = start("ship the feature");
    const before = controller.store.listCriteria(goal.id).length;
    const first = controller.addCriterion("ses_a", {
      ...ref(),
      text: "the retry backoff is exponential",
    });
    const second = controller.addCriterion("ses_a", {
      ...ref(),
      // Different case and spacing: normalization must still see one criterion.
      text: "  The RETRY backoff   is exponential ",
    });

    expect(first.criterionID).toBeDefined();
    expect(second.criterionID).toBe(first.criterionID);
    expect(controller.store.listCriteria(goal.id)).toHaveLength(before + 1);
  });

  test("the model cannot establish an objective-type criterion", () => {
    start("ship the feature");
    const out = controller.addCriterion("ses_a", {
      ...ref(),
      text: "everything is good",
      spec: { type: "objective" },
    });
    expect(out.rejected).toContain("objective");
  });

  test("a derived criterion investigation proved wrong can be superseded", () => {
    const goal = start("ship the feature");
    const before = controller.store.listCriteria(goal.id).map((c) => c.id);
    const derived = controller.addCriterion("ses_a", {
      ...ref(),
      text: "config.yaml contains retries: 3",
      spec: { type: "file", path: "config.yaml", contains: "retries: 3" },
    });

    const out = controller.supersedeCriterion("ses_a", {
      ...ref(),
      criterion_id: derived.criterionID!,
      reason: "the requirement moved to config.json during investigation",
    });

    expect(out.superseded).toBe(true);
    // The superseded row is retained for the audit trail but no longer listed.
    const after = controller.store.listCriteria(goal.id).map((c) => c.id);
    expect(after).toEqual(before);
    expect(after).not.toContain(derived.criterionID);
    const row = controller.store.db
      .query<{ superseded: number }, [string]>(
        `SELECT superseded FROM goal_criteria WHERE id = ?`,
      )
      .get(derived.criterionID!);
    expect(row?.superseded).toBe(1);
  });

  test("an explicit user requirement cannot be superseded by the model", () => {
    const goal = start("ship the feature");
    // start() derives criteria from the objective with source "derived";
    // establish an explicit user-source one to prove the protection.
    controller.store.addCriterion(goal.id, "the API stays backward compatible", undefined, "user");
    const userCriterion = controller.store
      .listCriteria(goal.id)
      .find((c) => c.text === "the API stays backward compatible")!;

    const out = controller.supersedeCriterion("ses_a", {
      ...ref(),
      criterion_id: userCriterion.id,
      reason: "inconvenient",
    });

    expect(out.rejected).toContain("cannot be superseded");
    expect(controller.store.listCriteria(goal.id).map((c) => c.id)).toContain(userCriterion.id);
  });

  // Audit-3 #5: requirements extracted from the user's objective (numbered
  // items included) were labeled "derived" and were therefore retireable by
  // the model via goal_supersede_criterion. Their origin is the user's.
  test("a requirement derived from the user's objective cannot be retired by the model", () => {
    const goal = start(
      ["Complete all of the following:", "1. Create a file called a.txt containing exactly: alpha", "2. The changelog documents the fix"].join("\n"),
    );
    const changelog = controller.store
      .listCriteria(goal.id)
      .find((c) => c.text.includes("changelog"))!;
    // The auditor's repro: the requirement was stored with user authority.
    expect(changelog.source).toBe("user");

    const out = controller.supersedeCriterion("ses_a", {
      ...ref(),
      criterion_id: changelog.id,
      reason: "documentation is out of scope",
    });
    expect(out.rejected).toContain("cannot be superseded");
    expect(controller.store.listCriteria(goal.id).map((c) => c.id)).toContain(changelog.id);
  });

  test("completion stays impossible while the user requirement stands", async () => {
    const { GoalVerifier } = await import("../src/controller/verification.ts");
    const goal = start(
      [
        "Complete all of the following:",
        "1. Create a file called a.txt containing exactly: alpha",
        "2. Create a file called CHANGELOG.md",
      ].join("\n"),
    );
    const changelog = controller.store
      .listCriteria(goal.id)
      .find((c) => c.text.includes("CHANGELOG.md"))!;
    controller.supersedeCriterion("ses_a", {
      ...ref(),
      criterion_id: changelog.id,
      reason: "documentation is out of scope",
    });

    // The a.txt requirement is satisfied and the objective accepted — but the
    // changelog requirement stands, so completion is refused.
    const workspace = mkdtempSync(join(tmpdir(), "xgoal-authority-"));
    try {
      writeFileSync(join(workspace, "a.txt"), "alpha");
      const verifier = new GoalVerifier(controller.store, {
        validate: async () => ({ valid: true, reason: "ok" }),
        checkSpec: async (criterion) => {
          if (criterion.spec?.type !== "file") {
            return { valid: false, reason: "no independent check" };
          }
          const resolved = join(workspace, criterion.spec.path);
          if (criterion.spec.equals === undefined && criterion.spec.contains === undefined) {
            return existsSync(resolved)
              ? { valid: true, reason: "exists" }
              : { valid: false, reason: `file not found: ${criterion.spec.path}` };
          }
          const content = readFileSync(resolved, "utf8");
          return content === criterion.spec.equals
            ? { valid: true, reason: "exact" }
            : { valid: false, reason: "content differs" };
        },
      });
      // The user accepts the objective — acceptance must not waive the
      // unsatisfied explicit file requirement.
      controller.acceptObjective("ses_a");
      const result = await verifier.verify(goal.id);
      expect(result.verdict).toBe("incomplete");
      expect(result.unmet.some((u) => u.toLowerCase().includes("changelog"))).toBe(true);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("a proposed replacement that preserves the obligation is accepted", () => {
    const goal = start("Create a file called a.txt containing exactly: alpha");
    const original = controller.store.listCriteria(goal.id).find((c) => c.spec?.type === "file")!;

    const out = controller.supersedeCriterion("ses_a", {
      ...ref(),
      criterion_id: original.id,
      reason: "the objective's phrasing was a paraphrase; the user's list says exactly this",
      replacement: {
        text: "a.txt must be exactly: alpha",
        spec: { type: "file", path: "a.txt", equals: "alpha" },
      },
    });
    expect(out.superseded).toBe(true);

    // The replacement is user-authoritative and gates verification; the
    // original row is retained only for the audit trail.
    const criteria = controller.store.listCriteria(goal.id);
    expect(criteria.map((c) => c.id)).not.toContain(original.id);
    const replacement = criteria.find((c) => c.text === "a.txt must be exactly: alpha")!;
    expect(replacement.source).toBe("user");
    expect(replacement.spec).toEqual({ type: "file", path: "a.txt", equals: "alpha" });
  });

  test("an empty replacement proposal is refused", () => {
    const goal = start("Create a file called a.txt containing exactly: alpha");
    const original = controller.store.listCriteria(goal.id).find((c) => c.spec?.type === "file")!;
    const out = controller.supersedeCriterion("ses_a", {
      ...ref(),
      criterion_id: original.id,
      reason: "typo",
      replacement: { text: "   ", spec: { type: "file", path: "a.txt", equals: "alpha" } },
    });
    expect(out.rejected).toContain("non-empty text");
    expect(controller.store.listCriteria(goal.id).map((c) => c.id)).toContain(original.id);
  });

  test("a weakening replacement proposal is refused", () => {
    const goal = start("Create a file called a.txt containing exactly: alpha");
    const original = controller.store.listCriteria(goal.id).find((c) => c.spec?.type === "file")!;

    const out = controller.supersedeCriterion("ses_a", {
      ...ref(),
      criterion_id: original.id,
      reason: "a prefix should be enough",
      replacement: {
        text: "a.txt contains al",
        spec: { type: "file", path: "a.txt", contains: "al" },
      },
    });
    expect(out.rejected).toContain("does not preserve");
    expect(controller.store.listCriteria(goal.id).map((c) => c.id)).toContain(original.id);
  });

  test("legacy derived rows are normalized to user authority on reopen", () => {
    // Rows stored as "derived" by older versions all came from the user's
    // objective; on upgrade they must gain user authority and protection.
    const goal = start("Create a file called a.txt containing exactly: alpha");
    controller.store.db
      .query(`UPDATE goal_criteria SET source = 'derived' WHERE goal_id = ?`)
      .run(goal.id);
    controller.close();
    controller = new GoalController({ dbPath: join(dir, "goals.db") });

    const sources = controller.store.listCriteria(goal.id).map((c) => c.source);
    expect(sources.length).toBeGreaterThan(0);
    expect(sources.every((s) => s === "user")).toBe(true);
    const original = controller.store.listCriteria(goal.id)[0];
    const out = controller.supersedeCriterion("ses_a", {
      ...ref(),
      criterion_id: original.id,
      reason: "inconvenient",
    });
    expect(out.rejected).toContain("cannot be superseded");
  });

  test("a superseded criterion no longer blocks verification", async () => {
    const { GoalVerifier } = await import("../src/controller/verification.ts");
    const goal = start("ship the feature");
    // A derived file criterion that will never be satisfied, plus one
    // satisfiable manual criterion.
    const impossible = controller.store.addCriterion(
      goal.id,
      "ghost.txt contains never",
      { type: "file", path: "ghost.txt", contains: "never" },
      "derived",
    );
    const satisfiable = controller.store.addCriterion(goal.id, "the regression is fixed");
    controller.store.addEvidence({
      goalID: goal.id,
      criterionID: satisfiable,
      kind: "test",
      ref: "bun test",
      exitCode: 0,
      detail: "exit 0",
    });

    const verifier = new GoalVerifier(controller.store, {
      validate: async () => ({ valid: true, reason: "ok" }),
      checkSpec: async () => ({ valid: false, reason: "file absent" }),
    });
    expect((await verifier.verify(goal.id)).verdict).toBe("incomplete");

    controller.supersedeCriterion("ses_a", {
      ...ref(),
      criterion_id: impossible,
      reason: "requirement dropped during investigation",
    });
    // The objective-level remainder (derived from the objective) resolves via
    // explicit user acceptance.
    controller.acceptObjective("ses_a");
    expect((await verifier.verify(goal.id)).verdict).toBe("complete");
  });
});
