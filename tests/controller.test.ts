/**
 * Phase 02 — controller authority split.
 *
 * These are the behaviours that distinguish the replacement from the legacy
 * plugin: the model proposes, the controller decides, and a workflow question
 * is not a blocker.
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GoalController } from "../src/controller/controller.ts";

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
  test("a single blocker report does not park the goal", () => {
    controller.startOrDescribe("ses_a", "build the replacement");
    const out = controller.reportBlocked("ses_a", {
      ...ref(),
      reason: "I finished phase 01 and asked the user whether to push or continue",
    });
    expect(out.accepted).toBe(false);
    expect(out.confirmations).toBe(1);
    // The goal is still drivable.
    expect(controller.status("ses_a")?.status).toBe("active");
  });

  test("repeated calls in one round count once; a later round confirms", () => {
    controller.startOrDescribe("ses_a", "x");
    const first = controller.reportBlocked("ses_a", { ...ref(), reason: "waiting on vendor API key" });
    expect(first.accepted).toBe(false);
    // A second call in the same turn must NOT be a second confirmation.
    const sameRound = controller.reportBlocked("ses_a", {
      ...ref(),
      reason: "waiting on vendor API key",
    });
    expect(sameRound.accepted).toBe(false);
    expect(sameRound.confirmations).toBe(1);

    // Settle the round, then report again in the next independently evaluated round.
    controller.classifyRound("ses_a", "blocked", "round ended with the same unresolved blocker");
    const second = controller.reportBlocked("ses_a", { ...ref(), reason: "waiting on vendor API key" });
    expect(second.accepted).toBe(true);
    expect(second.confirmations).toBe(2);
    expect(second.goal?.status).toBe("blocked");
  });

  test("a claimed external dependency is not self-authenticating", () => {
    controller.startOrDescribe("ses_a", "x");
    const out = controller.reportBlocked("ses_a", {
      ...ref(),
      reason: "cannot proceed without the production API credential",
      externalDependency: true,
    });
    // The claim alone does not park the goal.
    expect(out.accepted).toBe(false);
    expect(controller.status("ses_a")?.status).toBe("active");

    controller.classifyRound("ses_a", "blocked");
    const again = controller.reportBlocked("ses_a", {
      ...ref(),
      reason: "cannot proceed without the production API credential",
      externalDependency: true,
    });
    expect(again.accepted).toBe(true);
    expect(again.goal?.status).toBe("blocked");
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
