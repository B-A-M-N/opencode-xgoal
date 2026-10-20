#!/usr/bin/env bun
/**
 * Phase 02 milestone evidence.
 *
 * Demonstrates the five behaviours that must be shown with observable values,
 * not asserted. Each check prints what it actually observed.
 *
 * Run: bun scripts/evidence.ts
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GoalController } from "../src/controller/controller.ts";
import { GoalConflictError } from "../src/controller/store.ts";

const dir = mkdtempSync(join(tmpdir(), "xgoal-evidence-"));
const dbPath = join(dir, "goals.db");

let failures = 0;
function check(n: number, title: string, ok: boolean, observed: string): void {
  const mark = ok ? "PASS" : "FAIL";
  if (!ok) failures += 1;
  console.log(`\n[${mark}] ${n}. ${title}`);
  console.log(`       observed: ${observed}`);
}

/** Narrow the start-or-describe result to a freshly created goal. */
function mustCreate(result: { created: any } | { existing: any }): any {
  if (!("created" in result)) throw new Error("expected a new goal, found an existing one");
  return result.created;
}

console.log("OpenCode-XGoal — Phase 02 evidence");
console.log("=".repeat(64));

// ---------------------------------------------------------------- 1
{
  const c = new GoalController({ dbPath });
  const g = mustCreate(c.startOrDescribe("ses_1", "persist across restart"));
  c.classifyRound("ses_1", "progress", "work done", 1000);
  c.proposeComplete("ses_1", { summary: "claims done" });
  const before = c.status("ses_1")!;
  c.close();

  // New process, same file.
  const reopened = new GoalController({ dbPath });
  const repaired = reopened.reconcileStartup();
  const after = reopened.status("ses_1")!;
  const ok =
    after.id === before.id &&
    after.objective === before.objective &&
    after.tokensUsed === 1000 &&
    repaired.length === 1 &&
    after.status === "active";
  check(
    1,
    "A goal persists across process restart",
    ok,
    `objective preserved=${after.objective === before.objective}, tokens=${after.tokensUsed}, ` +
      `status ${before.status} -> ${after.status} (reconciled ${repaired.length})`,
  );
  reopened.close();
}

// ---------------------------------------------------------------- 2
{
  const c = new GoalController({ dbPath });
  const a = mustCreate(c.startOrDescribe("ses_a", "goal A"));
  const b = mustCreate(c.startOrDescribe("ses_b", "goal B"));
  c.classifyRound("ses_a", "progress", "advanced A", 500);
  c.pause("ses_a");

  const aNow = c.status("ses_a")!;
  const bNow = c.status("ses_b")!;
  const ok =
    aNow.status === "paused" &&
    aNow.tokensUsed === 500 &&
    bNow.status === "active" &&
    bNow.tokensUsed === undefined &&
    bNow.objective === "goal B" &&
    a.id !== b.id;
  check(
    2,
    "Two concurrent sessions cannot contaminate each other's goal state",
    ok,
    `ses_a=[${aNow.status}, tokens=${aNow.tokensUsed}] ses_b=[${bNow.status}, tokens=${bNow.tokensUsed}]`,
  );
  c.close();
}

// ---------------------------------------------------------------- 3
{
  const c = new GoalController({ dbPath });
  const old = mustCreate(c.startOrDescribe("ses_3", "original"));
  const fresh = c.replace("ses_3", "replacement");

  let refused = "";
  try {
    c.store.transition({ goalID: old.id, generation: 1, to: "active", actor: "controller" });
    refused = "NOT REFUSED";
  } catch (error) {
    refused = error instanceof GoalConflictError ? "refused" : `wrong error: ${String(error)}`;
  }
  // Also via the controller's fenced path.
  const late = c.proposeComplete("ses_3", {
    summary: "late claim from the dead goal",
    goalID: old.id,
    generation: old.generation,
  });

  const now = c.status("ses_3")!;
  const ok =
    refused === "refused" &&
    Boolean(late.rejected) &&
    now.id === fresh.id &&
    now.status === "active" &&
    now.rounds === 0;
  check(
    3,
    "A late callback from an old goal cannot affect its replacement",
    ok,
    `direct write ${refused}; fenced call rejected="${late.rejected}"; ` +
      `replacement still [${now.status}], rounds=${now.rounds}`,
  );
  c.close();
}

// ---------------------------------------------------------------- 4
{
  const c = new GoalController({ dbPath });
  const g = mustCreate(c.startOrDescribe("ses_4", "fix all bugs in the subsystem"));
  c.store.addCriterion(g.id, "bug one fixed");
  c.store.addCriterion(g.id, "bug two fixed");
  c.store.addCriterion(g.id, "regression suite passes");

  // The plan looks complete; there is no evidence for any criterion.
  c.proposeComplete("ses_4", { summary: "the checklist is done" });
  const verifying = c.status("ses_4")!;

  // The controller refuses to complete it and sends it back to work.
  const back = c.rejectCompletion("ses_4", "no evidence submitted for any criterion")!;
  const criteria = c.store.listCriteria(g.id);
  const ok =
    verifying.status === "verifying" &&
    back.status === "active" &&
    back.completedAtMs === undefined &&
    criteria.every((x) => !x.met) &&
    c.store.listEvidence(g.id).length === 0;
  check(
    4,
    "An unfinished goal cannot be marked complete merely because its plan says done",
    ok,
    `plan=${criteria.length} criteria, evidence=0, status ${verifying.status} -> ${back.status}, ` +
      `completedAt=${back.completedAtMs ?? "unset"}`,
  );
  c.close();
}

// ---------------------------------------------------------------- 5
{
  const c = new GoalController({ dbPath });
  c.startOrDescribe("ses_5", "produce a working replacement /goal plugin");
  c.checkpoint("ses_5", { summary: "phase 01 complete and committed" });

  // The exact Phase 01 scenario: the agent asks an optional workflow question.
  const report = c.reportBlocked("ses_5", {
    reason: "waiting for the user's decision on whether to publish the baseline or continue",
  });
  const g = c.status("ses_5")!;
  const ok =
    report.accepted === false &&
    g.status === "active" &&
    g.noProgressRounds === 0 &&
    g.repeatedBlockerRounds === 1;
  check(
    5,
    "A nonblocking workflow choice cannot force the controller into blocked or stalled",
    ok,
    `accepted=${report.accepted}, status=${g.status}, ` +
      `noProgressRounds=${g.noProgressRounds}, blockerClaims=${g.repeatedBlockerRounds}`,
  );
  c.close();
}

console.log("\n" + "=".repeat(64));
console.log(failures === 0 ? "All five behaviours observed." : `${failures} behaviour(s) FAILED.`);

rmSync(dir, { recursive: true, force: true });
process.exit(failures === 0 ? 0 : 1);
