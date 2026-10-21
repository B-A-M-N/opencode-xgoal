// src/index.ts
import { appendFileSync, existsSync, mkdirSync, readFileSync as readFileSync2 } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

// src/controller/store.ts
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";

// src/controller/state.ts
var TERMINAL_STATUSES = ["complete", "superseded"];
var NON_TERMINAL_STATUSES = [
  "active",
  "paused",
  "verifying",
  "blocked",
  "stalled",
  "budgetLimited",
  "usageLimited"
];
var ALL_STATUSES = [
  ...NON_TERMINAL_STATUSES,
  ...TERMINAL_STATUSES
];
var TRANSITIONS = {
  active: {
    paused: ["user", "controller"],
    verifying: ["model", "controller"],
    blocked: ["model", "controller"],
    stalled: ["controller"],
    budgetLimited: ["controller"],
    usageLimited: ["controller"],
    superseded: ["user", "controller"]
  },
  paused: {
    active: ["user", "controller"],
    superseded: ["user", "controller"]
  },
  verifying: {
    active: ["controller"],
    complete: ["controller"],
    blocked: ["controller"],
    superseded: ["user", "controller"]
  },
  blocked: {
    active: ["user", "controller"],
    superseded: ["user", "controller"]
  },
  stalled: {
    active: ["user", "controller"],
    superseded: ["user", "controller"]
  },
  budgetLimited: {
    active: ["user"],
    superseded: ["user", "controller"]
  },
  usageLimited: {
    active: ["user"],
    superseded: ["user", "controller"]
  },
  complete: {},
  superseded: {}
};
function canTransition({ from, to, actor }) {
  if (from === to) {
    return { ok: true };
  }
  const targets = TRANSITIONS[from];
  if (!targets) {
    return { ok: false, reason: `unknown source status: ${from}` };
  }
  const actors = targets[to];
  if (!actors) {
    return { ok: false, reason: `illegal transition ${from} -> ${to}` };
  }
  if (!actors.includes(actor)) {
    return {
      ok: false,
      reason: `transition ${from} -> ${to} is not permitted for actor "${actor}" (allowed: ${actors.join(", ")})`
    };
  }
  return { ok: true };
}
function isTerminal(status) {
  return TERMINAL_STATUSES.includes(status);
}
function isNonTerminal(status) {
  return NON_TERMINAL_STATUSES.includes(status);
}

// src/controller/criteria.ts
function normalizedCommand(command) {
  return command.trim().replace(/\s+/g, " ");
}
function preservesObligation(oldSpec, newSpec) {
  if (!oldSpec || !newSpec || oldSpec.type !== newSpec.type)
    return false;
  if (oldSpec.type === "file" && newSpec.type === "file") {
    if (oldSpec.path !== newSpec.path)
      return false;
    if (oldSpec.equals !== undefined)
      return newSpec.equals === oldSpec.equals;
    if (oldSpec.contains !== undefined) {
      if (newSpec.equals !== undefined)
        return newSpec.equals.includes(oldSpec.contains);
      if (newSpec.contains !== undefined)
        return newSpec.contains.includes(oldSpec.contains);
      return false;
    }
    return newSpec.equals !== undefined || newSpec.contains !== undefined;
  }
  if (oldSpec.type === "command" && newSpec.type === "command") {
    return normalizedCommand(oldSpec.command) === normalizedCommand(newSpec.command) && (oldSpec.expectExit ?? 0) === (newSpec.expectExit ?? 0);
  }
  if (oldSpec.type === "test" && newSpec.type === "test") {
    return normalizedCommand(oldSpec.command) === normalizedCommand(newSpec.command);
  }
  return false;
}
function completionPolicyFor(objective, criteria) {
  if (criteria.length === 0)
    return "userAcceptance";
  if (criteria.every((c) => c.spec.type !== "objective"))
    return "machine";
  const text = objective.toLowerCase();
  const investigation = /\b(?:audit|investigate|find|review|analy[sz]e|harden|diagnose|debug)\b/.test(text) && /\b(?:fix|repair|address|resolve|correct|eliminate|patch)\b/.test(text);
  const engineering = /\b(?:file|files|tests?|suite|bugs?|code|repo(?:sitory)?|build|deploy(?:ment)?|commit|branch|function|module|api|endpoint|config(?:uration)?|dependenc(?:y|ies)|lint|typecheck|script|package|database|schema|migration|server|client|pipeline|workflow|command|error|failure|regression|issue|security|performance)\b/.test(text);
  return investigation || engineering ? "audited" : "userAcceptance";
}
var FILE_NAME = "[\\w./\\-]+\\.[A-Za-z0-9]+";
var PATH_TOKEN = "(`[^`]+`|\"[^\"]+\"|'[^']+'|[^\\s,;]+)";
var QUOTED_TOKEN = "(?:`[^`]+`|\"[^\"]+\"|'[^']+')";
var UNQUOTED_CONTENT = "[^.;\\n]+";
var CONTENT_TOKEN = `(${QUOTED_TOKEN}|${UNQUOTED_CONTENT})`;
var EXACTLY_TOKEN = "((?:exactly:?\\s+)?)";
var PATH_NAME = `(${FILE_NAME}|\`[^\`]+\`|"[^"]+"|'[^']+')`;
var FILE_LIST_PREAMBLE = "(?:(?:please\\s+)?(?:create|write|make|add)\\s+(?:(?:a|an|the|new|one|two|three|four|five|six|seven|eight|nine|ten|several|multiple|both|all)\\s+)*(?:new\\s+)?files?(?:\\s*[:,]\\s*|\\s+)(?:(?:called|named)\\s+)?)?";
function strip(value, exact = false) {
  if (!value)
    return "";
  const trimmed = value.trim();
  if (/^([`"']).*\1$/s.test(trimmed)) {
    const inner = trimmed.slice(1, -1);
    return exact ? inner : inner.trim();
  }
  return trimmed.replace(/[.!?]+$/, "");
}
function splitObligation(raw) {
  const trimmed = raw.trim();
  if (/^([`"']).*\1$/s.test(trimmed))
    return { content: raw };
  const re = /(\s*,\s*|\s+)(?:and|then|also)\s+/gi;
  let match;
  while (match = re.exec(raw)) {
    const after = raw.slice(match.index + match[0].length);
    if (!OBLIGATION_VERB.test(after))
      continue;
    return {
      content: raw.slice(0, match.index).replace(/[\s,;]+$/, ""),
      residual: after.trim()
    };
  }
  return { content: raw };
}
var OBLIGATION_VERB = /^(?:run|execute|test|verify|ensure|make|create|write|add|remove|delete|update|fix|refactor|publish|deploy|commit|push|install|configure|document|keep|avoid|check|confirm|use|start|stop|build|lint|format|review|audit|do\s+not|don't|never|must|should|shall|not)\b/i;
var FILE_REQUIREMENT_START = new RegExp(`^(?:${FILE_NAME}|\`[^\`]+\`|"[^"]+"|'[^']+')\\s+(?:must\\s+)?(?:contain|contains|containing|include|includes|including|have|has)\\b`, "i");
var OBLIGATIONISH = /\b(?:[a-z]+(?:e|ed|s|ing|ise|ize|ate|ify)\b|must|should|shall|ensure|verify|run|test|check|deploy|publish|pass|fail|fix|add|create|write|make|keep|avoid|never|do not|don't|no)\b/i;
function readsAsObligation(clause) {
  return OBLIGATIONISH.test(clause);
}
function splitObligationClauses(text) {
  const clauses = [];
  let start = 0;
  let quote;
  const push = (end) => {
    const raw = text.slice(start, end).trim();
    start = end;
    if (raw)
      clauses.push(raw);
  };
  for (let i = 0;i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) {
        const next = text[i + 1];
        if (quote !== "'" || next === undefined || !/\w/.test(next))
          quote = undefined;
      }
      continue;
    }
    if (ch === '"' || ch === "`" || ch === "'" && (i === 0 || !/\w/.test(text[i - 1]))) {
      quote = ch;
      continue;
    }
    if (ch === "." || ch === "!" || ch === "?" || ch === ";" || ch === `
`) {
      const next = text[i + 1];
      if (next === undefined || /\s/.test(next))
        push(i + 1);
      continue;
    }
    if (ch === "," || /\s/.test(ch)) {
      const conj = /^,?\s*(?:and|then|also)\s+/i.exec(text.slice(i));
      if (conj) {
        const after = text.slice(i + conj[0].length);
        if (OBLIGATION_VERB.test(after) || FILE_REQUIREMENT_START.test(after)) {
          push(i);
          start = i + conj[0].length;
          i = start - 1;
        }
      }
    }
  }
  push(text.length);
  return clauses.length > 0 ? clauses : [text];
}
function fileSpec(path, exact, content) {
  if (!path)
    return;
  if (!content)
    return { type: "file", path };
  return exact ? { type: "file", path, equals: content } : { type: "file", path, contains: content };
}
var FILE_PATTERNS = [
  {
    re: new RegExp(`(?:create|write|make|add)\\s+(?:a\\s+|the\\s+)?(?:file\\s+)?(?:called\\s+|named\\s+)?${PATH_TOKEN}\\s+(?:containing|with|that contains|that has|must contain|contains)\\s+${EXACTLY_TOKEN}${CONTENT_TOKEN}`, "gi"),
    build: (m) => {
      const path = strip(m[1]);
      const exact = Boolean(m[2]);
      const split = splitObligation(m[3] ?? "");
      const spec = fileSpec(path, exact, strip(split.content, exact));
      return spec ? { spec, residual: split.residual } : undefined;
    }
  },
  {
    re: new RegExp(`write\\s+${CONTENT_TOKEN}\\s+(?:to|into)\\s+${PATH_TOKEN}`, "gi"),
    build: (m) => {
      const split = splitObligation(m[1] ?? "");
      const path = strip(m[2]);
      const spec = fileSpec(path, false, strip(split.content));
      return spec ? { spec, residual: split.residual } : undefined;
    }
  },
  {
    re: new RegExp(`${FILE_LIST_PREAMBLE}(${FILE_NAME})\\s+(?:must\\s+)?(?:contain|contains|containing|include|includes|including|have|has)\\s+${EXACTLY_TOKEN}${CONTENT_TOKEN}`, "gi"),
    build: (m) => {
      const path = strip(m[1]);
      const exact = Boolean(m[2]);
      const split = splitObligation(m[3] ?? "");
      const spec = fileSpec(path, exact, strip(split.content, exact));
      return spec ? { spec, residual: split.residual } : undefined;
    }
  },
  {
    re: new RegExp(`(?:create|write|make|add)\\s+(?:a\\s+|the\\s+)?(?:file\\s+)?(?:called\\s+|named\\s+)?${PATH_NAME}`, "gi"),
    build: (m) => {
      const path = strip(m[1]);
      if (!path)
        return;
      return { spec: { type: "file", path } };
    }
  }
];
function isProceduralInstruction(clause) {
  const stripped = clause.replace(/^(?:when|once|after|if|as soon as)\b[^,]*,\s*/i, "").trim();
  return new RegExp("^(?:(?:please|then|now|finally)\\s+)*(" + "(?:propose|declare|report|signal|announce)\\s+(?:the\\s+)?(?:goal\\s+)?(?:completion|complete|done|finished)" + "|call\\s+`?goal_propose_complete`?" + "|(?:report|come)\\s+back(?:\\s+to\\s+the\\s+user)?" + "|stop(?:\\s+work)?|finish(?:ed)?|done" + ")[\\s.!]*$", "i").test(stripped);
}
function residualObligations(text, consumed) {
  const residuals = [];
  let start = -1;
  const flush = (end) => {
    if (start === -1)
      return;
    const raw = text.slice(start, end).trim();
    start = -1;
    if (!raw)
      return;
    const cleaned = raw.replace(/^[\s,;.]+|[\s,;.]+$/g, "").replace(/^(?:and|then|also|plus)\s+/i, "").trim();
    if (!cleaned)
      return;
    if (/^(?:and|then|also|plus)$/i.test(cleaned))
      return;
    if (isProceduralInstruction(cleaned))
      return;
    if (!readsAsObligation(cleaned))
      return;
    residuals.push(cleaned);
  };
  for (let i = 0;i < text.length; i++) {
    if (consumed[i]) {
      flush(i);
      continue;
    }
    const ch = text[i];
    if (ch === "." || ch === ";" || ch === `
`) {
      flush(i);
      continue;
    }
    start = start === -1 ? i : start;
  }
  flush(text.length);
  return residuals;
}
function deriveCriteria(objective) {
  const text = objective.trim();
  if (!text)
    return [];
  const rawLines = text.split(/\n+/);
  const listLines = rawLines.filter((line) => /^\s*(?:\d+[.)]|[-*+])\s*/.test(line)).map((line) => line.replace(/^\s*(?:\d+[.)]|[-*+])\s*/, "").trim()).filter((line) => line.length > 0);
  const allLines = rawLines.map((line) => line.replace(/^\s*(?:\d+[.)]|[-*+])\s*/, "").trim()).filter((line) => line.length > 0);
  const enumerated = listLines.length > 1 && listLines.length >= Math.ceil(allLines.length / 2);
  const criteria = [];
  const seen = new Set;
  const push = (criterionText, spec) => {
    const key = `${spec.type}::${criterionText}`;
    if (seen.has(key))
      return;
    seen.add(key);
    criteria.push({ text: criterionText, spec, source: "user" });
  };
  const contentOf = (spec) => spec.type === "file" ? spec.contains ?? spec.equals : undefined;
  const contentText = (spec, content) => {
    if (spec.type !== "file")
      return content;
    return spec.equals !== undefined ? `${spec.path} must be exactly: ${content}` : `${spec.path} contains ${content}`;
  };
  const targets = enumerated ? listLines : [text];
  const contentPaths = new Set;
  for (const target of targets) {
    const unresolvedClauses = [];
    let targetMatched = false;
    for (const clause of splitObligationClauses(target)) {
      let matched = false;
      const consumed = new Array(clause.length).fill(false);
      const mark = (start, end) => {
        for (let i = Math.max(0, start);i < Math.min(clause.length, end); i++)
          consumed[i] = true;
      };
      for (const { re, build } of FILE_PATTERNS) {
        for (const match of clause.matchAll(re)) {
          const parsed = build(match);
          if (!parsed || parsed.spec.type !== "file")
            continue;
          const spec = parsed.spec;
          const content = contentOf(spec);
          if (!content)
            continue;
          matched = true;
          contentPaths.add(spec.path);
          push(contentText(spec, content), spec);
          mark(match.index ?? 0, (match.index ?? 0) + match[0].length);
          if (parsed.residual) {
            push(`The requirement is achieved: ${parsed.residual}`, { type: "objective" });
          }
        }
      }
      for (const { re, build } of FILE_PATTERNS) {
        for (const match of clause.matchAll(re)) {
          const parsed = build(match);
          if (!parsed || parsed.spec.type !== "file")
            continue;
          if (contentOf(parsed.spec))
            continue;
          const spec = parsed.spec;
          if (contentPaths.has(spec.path))
            continue;
          matched = true;
          push(`${spec.path} exists`, spec);
          mark(match.index ?? 0, (match.index ?? 0) + match[0].length);
        }
      }
      if (matched) {
        targetMatched = true;
        for (const residual of residualObligations(clause, consumed)) {
          push(`The requirement is achieved: ${residual}`, { type: "objective" });
        }
      } else {
        unresolvedClauses.push(clause);
      }
    }
    if (!targetMatched) {
      push(`The requirement is achieved: ${target}`, { type: "objective" });
      continue;
    }
    for (const clause of unresolvedClauses) {
      const cleaned = clause.replace(/^[\s,;.]+|[\s,;.]+$/g, "").replace(/^(?:and|then|also|plus)\s+/i, "").trim();
      if (cleaned && !/^(?:and|then|also|plus)$/i.test(cleaned) && !isProceduralInstruction(cleaned) && readsAsObligation(cleaned)) {
        push(`The requirement is achieved: ${cleaned}`, { type: "objective" });
      }
    }
  }
  if (criteria.length === 0) {
    push(`The objective is achieved: ${text}`, { type: "objective" });
  }
  return criteria;
}

// src/controller/store.ts
class GoalConflictError extends Error {
  constructor(message) {
    super(message);
    this.name = "GoalConflictError";
  }
}

class TransitionRejectedError extends Error {
  constructor(message) {
    super(message);
    this.name = "TransitionRejectedError";
  }
}
var SCHEMA = `
CREATE TABLE IF NOT EXISTS goals (
  id                       TEXT PRIMARY KEY,
  session_id               TEXT NOT NULL,
  generation               INTEGER NOT NULL,
  objective                TEXT NOT NULL,
  status                   TEXT NOT NULL,
  reason                   TEXT,
  rounds                   INTEGER NOT NULL DEFAULT 0,
  no_progress_rounds       INTEGER NOT NULL DEFAULT 0,
  repeated_blocker_rounds  INTEGER NOT NULL DEFAULT 0,
  tokens_used              INTEGER,
  token_budget             INTEGER,
  version                  INTEGER NOT NULL DEFAULT 0,
  created_at_ms            INTEGER NOT NULL,
  updated_at_ms            INTEGER NOT NULL,
  completed_at_ms          INTEGER,
  superseded_by            TEXT,
  -- Verification is only valid for the goal and evidence snapshot it actually
  -- checked. A stale verifier must not be able to complete a goal whose
  -- evidence changed underneath it.
  verification_revision    INTEGER NOT NULL DEFAULT 0,
  verification_snapshot    TEXT,
  -- How this goal is permitted to reach completion (audit #1): machine,
  -- audited, or userAcceptance. Decided at creation from the objective text
  -- and its derived criteria; never changed by the model.
  completion_policy        TEXT NOT NULL DEFAULT 'userAcceptance',
  -- Revision of the immutable objective text. Assessments are scoped to it so
  -- a stale assessment can never certify a different requirement set.
  objective_revision       INTEGER NOT NULL DEFAULT 1,
  -- Set when a continuation submission terminally failed. While set, the
  -- driver refuses to dispatch until recovery clears it, so a terminal
  -- delivery failure cannot be circumvented by minting a fresh continuation.
  delivery_failed          INTEGER NOT NULL DEFAULT 0,
  UNIQUE (session_id, generation)
);

-- (1) At most one non-terminal goal per session. Terminal rows (complete,
-- superseded) are excluded so history accumulates freely.
CREATE UNIQUE INDEX IF NOT EXISTS goals_one_current_per_session
  ON goals (session_id)
  WHERE status NOT IN ('complete', 'superseded');

CREATE TABLE IF NOT EXISTS goal_events (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,
  goal_id     TEXT NOT NULL,
  generation  INTEGER NOT NULL,
  kind        TEXT NOT NULL,
  from_status TEXT,
  to_status   TEXT,
  actor       TEXT,
  detail      TEXT,
  at_ms       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS goal_events_goal ON goal_events (goal_id, seq);

CREATE TABLE IF NOT EXISTS goal_criteria (
  id          TEXT PRIMARY KEY,
  goal_id     TEXT NOT NULL,
  generation  INTEGER NOT NULL,
  text        TEXT NOT NULL,
  -- Optional machine-checkable spec (JSON). A criterion with a spec is
  -- verified independently of any evidence the model claims; a criterion
  -- without one still requires explicitly bound evidence.
  spec        TEXT,
  -- Who established the criterion: the user's objective (including
  -- requirements the controller extracted from it), an explicit user
  -- addition, or a model refinement. User-authoritative rows are never
  -- removed to pass verification. Historical "derived" rows are normalized
  -- to "user" by migrate() on open.
  source      TEXT NOT NULL DEFAULT 'user',
  met         INTEGER NOT NULL DEFAULT 0,
  -- A derived/model criterion that investigation proved wrong is superseded,
  -- not deleted: the row stays for the audit trail but no longer gates
  -- verification. User-source criteria cannot be superseded by the model.
  superseded  INTEGER NOT NULL DEFAULT 0,
  -- JSON array of objective-level criterion IDs this concrete requirement was
  -- registered to satisfy (audit #1). Only a proven concrete requirement can
  -- discharge an objective-level remainder under the audited policy, so the
  -- model must name the coverage instead of asserting the objective is met.
  covers      TEXT,
  created_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS goal_criteria_goal ON goal_criteria (goal_id);

CREATE TABLE IF NOT EXISTS goal_evidence (
  id          TEXT PRIMARY KEY,
  goal_id     TEXT NOT NULL,
  generation  INTEGER NOT NULL,
  criterion_id TEXT,
  kind        TEXT NOT NULL,
  ref         TEXT NOT NULL,
  detail      TEXT,
  -- Persisted so validation can be real rather than trusting the capture:
  -- command/test/runtime must record the observed exit status, and file
  -- evidence records a content hash so staleness is detectable. The workspace
  -- is the session workspace the path resolved against at capture time, so a
  -- relative path can never be re-checked against the plugin's own cwd.
  exit_code   INTEGER,
  hash        TEXT,
  workspace   TEXT,
  at_ms       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS goal_evidence_goal ON goal_evidence (goal_id);
CREATE INDEX IF NOT EXISTS goal_evidence_criterion ON goal_evidence (criterion_id);

-- Per-criterion verification proofs. One row per criterion per verification
-- attempt, so an accepted proof can never be silently reused for a different
-- evidence snapshot.
CREATE TABLE IF NOT EXISTS goal_criterion_proofs (
  id            TEXT PRIMARY KEY,
  goal_id       TEXT NOT NULL,
  generation    INTEGER NOT NULL,
  criterion_id  TEXT NOT NULL,
  evidence_ids  TEXT NOT NULL,
  validator_id  TEXT NOT NULL,
  verdict       TEXT NOT NULL,
  detail        TEXT,
  created_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS goal_proofs_goal ON goal_criterion_proofs (goal_id);

-- Durable association between an assistant message and the goal generation
-- that produced it. This is what lets a tool call be fenced to the generation
-- it actually belongs to, instead of being resolved from whatever goal is
-- current when the callback arrives.
CREATE TABLE IF NOT EXISTS goal_message_generations (
  session_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  at_ms      INTEGER NOT NULL,
  PRIMARY KEY (session_id, message_id)
);

-- Blocker claims, one per reporting round. A model can call the blocker tool
-- many times in one turn; only distinct rounds count as confirmations, so
-- repetition inside a single execution cannot manufacture a blocker.
CREATE TABLE IF NOT EXISTS goal_blocker_claims (
  id           TEXT PRIMARY KEY,
  goal_id      TEXT NOT NULL,
  generation   INTEGER NOT NULL,
  round_number INTEGER NOT NULL,
  reason       TEXT NOT NULL,
  at_ms        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS goal_blocker_goal ON goal_blocker_claims (goal_id);

-- Last observed session-level token total. Usage events report a session
-- running total, not a per-goal delta, so we persist the total and charge the
-- difference to whatever goal is active. Without this the goal's budget is
-- never driven by real usage.
CREATE TABLE IF NOT EXISTS session_usage (
  session_id  TEXT PRIMARY KEY,
  total_tokens INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

-- Explicit user acceptance of an objective-level criterion.
--
-- A broad objective ("fix the flaky tests", "clean up the config handling")
-- cannot be machine-proven from ordinary evidence: any passing test or file
-- change is consistent with a partial job. Rather than pretend completeness is
-- established, the verifier leaves such criteria unresolved until the user
-- either accepts the objective explicitly (this table, generation-fenced) or
-- the model registers concrete machine-checkable sub-criteria.
CREATE TABLE IF NOT EXISTS goal_acceptances (
  goal_id     TEXT PRIMARY KEY,
  generation  INTEGER NOT NULL,
  note        TEXT,
  at_ms       INTEGER NOT NULL
);

-- Controller-computed objective-level assessments (audit #1, audited policy).
--
-- Audited goals define completion operationally: the objective is
-- open-ended, so completion means every confirmed requirement discovered
-- within the audited scope is independently verified, and no known,
-- actionable requirement remains unresolved. The controller records the
-- assessment it computed from the per-criterion proofs; the model cannot write
-- this row and cannot declare its own verdict.
--
-- This is NOT a claim that no undiscovered bugs exist. The recorded scope is
-- the honest boundary: what the final bounded review covered, and what it did
-- not. Scope that cannot be bounded yields indeterminate, not satisfied.
CREATE TABLE IF NOT EXISTS goal_objective_assessments (
  goal_id                TEXT PRIMARY KEY,
  generation             INTEGER NOT NULL,
  objective_revision     INTEGER NOT NULL,
  verdict                TEXT NOT NULL,
  scope                  TEXT NOT NULL,
  covered_requirements   TEXT NOT NULL,
  unresolved_requirements TEXT NOT NULL,
  evidence_ids           TEXT NOT NULL,
  note                   TEXT,
  at_ms                  INTEGER NOT NULL
);

-- Continuation ledger. One row per continuation attempt.
--
-- inbox_id is the OpenCode message ID we reserve BEFORE submitting, and it is
-- UNIQUE. That uniqueness is the idempotency guarantee: a retry after a timeout
-- reuses the same id, so the session can deduplicate it and we can never admit
-- the same continuation twice.
--
-- status tracks the attempt's real lifecycle, not our hopes:
--   prepared  reserved, not yet submitted
--   admitted  the session accepted the message (NOT proof it ran)
--   running   execution observed to have started
--   settled   a round outcome was evaluated
--   unknown   submission outcome ambiguous (timeout / lost response)
--   failed    submission definitively rejected
CREATE TABLE IF NOT EXISTS goal_rounds (
  id             TEXT PRIMARY KEY,
  goal_id        TEXT NOT NULL,
  generation     INTEGER NOT NULL,
  inbox_id       TEXT NOT NULL UNIQUE,
  status         TEXT NOT NULL,
  classification TEXT,
  attempts       INTEGER NOT NULL DEFAULT 1,
  detail         TEXT,
  -- Number of evidence rows for the goal when this round was prepared. The
  -- delta at settlement is what distinguishes a round that produced verified
  -- work from one that merely emitted text: a no-evidence round is not progress.
  evidence_baseline INTEGER NOT NULL DEFAULT 0,
  prepared_at_ms INTEGER NOT NULL,
  admitted_at_ms INTEGER,
  settled_at_ms  INTEGER
);
CREATE INDEX IF NOT EXISTS goal_rounds_goal ON goal_rounds (goal_id, prepared_at_ms);
-- At most one in-flight round per goal.
CREATE UNIQUE INDEX IF NOT EXISTS goal_rounds_one_outstanding
  ON goal_rounds (goal_id)
  WHERE status IN ('prepared', 'admitted', 'running', 'unknown');
`;
function toGoal(row) {
  return {
    id: row.id,
    sessionID: row.session_id,
    generation: row.generation,
    objective: row.objective,
    status: row.status,
    reason: row.reason ?? undefined,
    rounds: row.rounds,
    noProgressRounds: row.no_progress_rounds,
    repeatedBlockerRounds: row.repeated_blocker_rounds,
    tokensUsed: row.tokens_used ?? undefined,
    tokenBudget: row.token_budget ?? undefined,
    version: row.version,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
    completedAtMs: row.completed_at_ms ?? undefined,
    supersededBy: row.superseded_by ?? undefined,
    verificationRevision: row.verification_revision,
    verificationSnapshot: row.verification_snapshot ?? undefined,
    deliveryFailed: row.delivery_failed === 1,
    completionPolicy: row.completion_policy ?? "userAcceptance",
    objectiveRevision: row.objective_revision ?? 1
  };
}
function normalizeBlockerReason(reason) {
  return reason.trim().toLowerCase().replace(/\s+/g, " ").replace(/[.!]+$/g, "");
}
var counter = 0;
function newID(prefix) {
  counter += 1;
  return `${prefix}_${Date.now().toString(36)}_${counter.toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}
function snapshotHash(criteria, evidence) {
  const canonical = JSON.stringify({
    criteria: criteria.map((c) => [c.id, c.text, c.spec ?? null]),
    evidence: evidence.map((e) => [
      e.id,
      e.kind,
      e.ref,
      e.exitCode ?? null,
      e.hash ?? null,
      e.criterionID ?? null
    ])
  });
  return createHash("sha256").update(canonical).digest("hex").slice(0, 32);
}

class GoalStore {
  db;
  depth = 0;
  constructor(path) {
    this.db = new Database(path, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec(SCHEMA);
    this.migrate();
  }
  migrate() {
    const columns = this.db.query(`PRAGMA table_info(goal_criteria)`).all().map((row) => row.name);
    if (!columns.includes("superseded")) {
      this.db.exec(`ALTER TABLE goal_criteria ADD COLUMN superseded INTEGER NOT NULL DEFAULT 0`);
    }
    if (!columns.includes("covers")) {
      this.db.exec(`ALTER TABLE goal_criteria ADD COLUMN covers TEXT`);
    }
    const goalColumns = this.db.query(`PRAGMA table_info(goals)`).all().map((row) => row.name);
    if (!goalColumns.includes("completion_policy")) {
      this.db.exec(`ALTER TABLE goals ADD COLUMN completion_policy TEXT NOT NULL DEFAULT 'userAcceptance'`);
    }
    if (!goalColumns.includes("objective_revision")) {
      this.db.exec(`ALTER TABLE goals ADD COLUMN objective_revision INTEGER NOT NULL DEFAULT 1`);
    }
    this.db.query(`UPDATE goals SET completion_policy = 'machine'
          WHERE completion_policy = 'userAcceptance'
            AND status IN ('active', 'verifying', 'paused')
            AND EXISTS (SELECT 1 FROM goal_criteria c WHERE c.goal_id = goals.id AND c.superseded = 0)
            AND NOT EXISTS (
              SELECT 1 FROM goal_criteria c
               WHERE c.goal_id = goals.id AND c.superseded = 0
                 AND (c.spec IS NULL OR json_extract(c.spec, '$.type') = 'objective')
            )`).run();
    this.db.query(`UPDATE goal_criteria SET source = 'user' WHERE source = 'derived'`).run();
  }
  close() {
    this.db.close();
  }
  tx(fn) {
    if (this.depth > 0)
      return fn();
    this.depth += 1;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {}
      throw error;
    } finally {
      this.depth -= 1;
    }
  }
  appendEvent(goalID, generation, kind, extra = {}) {
    this.db.query(`INSERT INTO goal_events (goal_id, generation, kind, from_status, to_status, actor, detail, at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(goalID, generation, kind, extra.fromStatus ?? null, extra.toStatus ?? null, extra.actor ?? null, extra.detail ?? null, Date.now());
  }
  current(sessionID) {
    const row = this.db.query(`SELECT * FROM goals WHERE session_id = ? AND status NOT IN ('complete','superseded') LIMIT 1`).get(sessionID);
    return row ? toGoal(row) : undefined;
  }
  latest(sessionID) {
    const row = this.db.query(`SELECT * FROM goals WHERE session_id = ? ORDER BY generation DESC LIMIT 1`).get(sessionID);
    return row ? toGoal(row) : undefined;
  }
  byID(id) {
    const row = this.db.query(`SELECT * FROM goals WHERE id = ?`).get(id);
    return row ? toGoal(row) : undefined;
  }
  byGeneration(sessionID, generation) {
    const row = this.db.query(`SELECT * FROM goals WHERE session_id = ? AND generation = ?`).get(sessionID, generation);
    return row ? toGoal(row) : undefined;
  }
  history(sessionID) {
    return this.db.query(`SELECT * FROM goals WHERE session_id = ? ORDER BY generation DESC`).all(sessionID).map(toGoal);
  }
  activeGoals() {
    return this.db.query(`SELECT * FROM goals WHERE status NOT IN ('complete','superseded') ORDER BY created_at_ms ASC`).all().map(toGoal);
  }
  events(goalID) {
    return this.db.query(`SELECT * FROM goal_events WHERE goal_id = ? ORDER BY seq ASC`).all(goalID).map((r) => ({
      seq: r.seq,
      goalID: r.goal_id,
      generation: r.generation,
      kind: r.kind,
      fromStatus: r.from_status ?? undefined,
      toStatus: r.to_status ?? undefined,
      actor: r.actor ?? undefined,
      detail: r.detail ?? undefined,
      atMs: r.at_ms
    }));
  }
  create(input) {
    if (!input.objective || !input.objective.trim()) {
      throw new TransitionRejectedError("objective must not be empty");
    }
    return this.tx(() => {
      const existing = this.current(input.sessionID);
      if (existing) {
        throw new GoalConflictError(`session ${input.sessionID} already has a current goal (${existing.id}, generation ${existing.generation}, status ${existing.status}); use replace()`);
      }
      const now = Date.now();
      const id = newID("goal");
      const nextGen = this.db.query(`SELECT COALESCE(MAX(generation), 0) + 1 AS next_generation
           FROM goals WHERE session_id = ?`).get(input.sessionID).next_generation;
      const generation = nextGen;
      this.db.query(`INSERT INTO goals (id, session_id, generation, objective, status, rounds,
             no_progress_rounds, repeated_blocker_rounds, token_budget, version,
             completion_policy, created_at_ms, updated_at_ms)
           VALUES (?, ?, ?, ?, 'active', 0, 0, 0, ?, 0, ?, ?, ?)`).run(id, input.sessionID, generation, input.objective.trim(), input.tokenBudget ?? null, input.completionPolicy ?? "userAcceptance", now, now);
      this.appendEvent(id, generation, "created", {
        toStatus: "active",
        actor: input.actor ?? "user",
        detail: input.objective.trim().slice(0, 200)
      });
      for (const criterion of input.criteria ?? []) {
        this.insertCriterion(id, generation, criterion, now);
      }
      return this.byID(id);
    });
  }
  replace(input) {
    if (!input.objective || !input.objective.trim()) {
      throw new TransitionRejectedError("objective must not be empty");
    }
    return this.tx(() => {
      const existing = this.current(input.sessionID);
      if (!existing) {
        throw new GoalConflictError(`session ${input.sessionID} has no current goal to replace`);
      }
      if (existing.generation !== input.expectedGeneration) {
        throw new GoalConflictError(`stale replacement: expected generation ${input.expectedGeneration}, found ${existing.generation}`);
      }
      const now = Date.now();
      const newIDValue = newID("goal");
      const nextGeneration = existing.generation + 1;
      this.db.query(`UPDATE goals SET status='superseded', superseded_by=?, updated_at_ms=?, version=version+1
           WHERE id=? AND version=?`).run(newIDValue, now, existing.id, existing.version);
      this.appendEvent(existing.id, existing.generation, "superseded", {
        fromStatus: existing.status,
        toStatus: "superseded",
        actor: input.actor ?? "user",
        detail: input.reason ?? `replaced by ${newIDValue}`
      });
      const stale = this.outstandingRound(existing.id);
      if (stale) {
        this.markRoundFailed(stale.id, `superseded by ${newIDValue}`, { parkGoal: false });
      }
      this.db.query(`INSERT INTO goals (id, session_id, generation, objective, status, rounds,
             no_progress_rounds, repeated_blocker_rounds, token_budget, version,
             completion_policy, created_at_ms, updated_at_ms)
           VALUES (?, ?, ?, ?, 'active', 0, 0, 0, ?, 0, ?, ?, ?)`).run(newIDValue, input.sessionID, nextGeneration, input.objective.trim(), input.tokenBudget ?? existing.tokenBudget ?? null, input.completionPolicy ?? "userAcceptance", now, now);
      this.appendEvent(newIDValue, nextGeneration, "created", {
        toStatus: "active",
        actor: input.actor ?? "user",
        detail: `replaces ${existing.id} (generation ${existing.generation})`
      });
      for (const criterion of input.criteria ?? []) {
        this.insertCriterion(newIDValue, nextGeneration, criterion, now);
      }
      return this.byID(newIDValue);
    });
  }
  transition(input) {
    return this.tx(() => {
      const goal = this.byID(input.goalID);
      if (!goal) {
        throw new GoalConflictError(`unknown goal ${input.goalID}`);
      }
      if (goal.generation !== input.generation) {
        throw new GoalConflictError(`stale generation: goal ${input.goalID} is generation ${goal.generation}, callback claimed ${input.generation}`);
      }
      if (isTerminal(goal.status)) {
        throw new GoalConflictError(`goal ${input.goalID} is terminal (${goal.status}); refusing to drive it`);
      }
      if (input.expectedVersion !== undefined && goal.version !== input.expectedVersion) {
        throw new GoalConflictError(`optimistic version conflict on ${input.goalID}: expected ${input.expectedVersion}, found ${goal.version}`);
      }
      const check = canTransition({ from: goal.status, to: input.to, actor: input.actor });
      if (!check.ok) {
        throw new TransitionRejectedError(check.reason);
      }
      if (goal.status === input.to) {
        this.appendEvent(goal.id, goal.generation, "noop", {
          fromStatus: goal.status,
          toStatus: input.to,
          actor: input.actor,
          detail: input.reason
        });
        return goal;
      }
      const now = Date.now();
      const completedAt = input.to === "complete" ? now : null;
      const updated = this.db.query(`UPDATE goals
             SET status=?, reason=?, updated_at_ms=?, version=version+1,
                 completed_at_ms=COALESCE(?, completed_at_ms)
           WHERE id=? AND version=?`).run(input.to, input.reason ?? null, now, completedAt, goal.id, goal.version);
      if (updated.changes !== 1) {
        throw new GoalConflictError(`compare-and-swap failed for ${goal.id}`);
      }
      this.appendEvent(goal.id, goal.generation, "status", {
        fromStatus: goal.status,
        toStatus: input.to,
        actor: input.actor,
        detail: input.reason
      });
      return this.byID(goal.id);
    });
  }
  recordRound(input) {
    return this.tx(() => {
      const goal = this.byID(input.goalID);
      if (!goal)
        throw new GoalConflictError(`unknown goal ${input.goalID}`);
      if (goal.generation !== input.generation) {
        throw new GoalConflictError(`stale generation: ${input.goalID} is generation ${goal.generation}, round claimed ${input.generation}`);
      }
      if (isTerminal(goal.status)) {
        throw new GoalConflictError(`goal ${input.goalID} is terminal (${goal.status}); refusing to record a round against it`);
      }
      const noProgress = input.classification === "noProgress" ? goal.noProgressRounds + 1 : 0;
      const blocker = input.classification === "blocked" ? goal.repeatedBlockerRounds + 1 : 0;
      const now = Date.now();
      const tokens = input.tokensUsed === undefined ? goal.tokensUsed ?? null : (goal.tokensUsed ?? 0) + input.tokensUsed;
      this.db.query(`UPDATE goals
             SET rounds = rounds + 1,
                 no_progress_rounds = ?,
                 repeated_blocker_rounds = ?,
                 tokens_used = ?,
                 updated_at_ms = ?,
                 version = version + 1
           WHERE id = ? AND version = ?`).run(noProgress, blocker, tokens, now, goal.id, goal.version);
      this.appendEvent(goal.id, goal.generation, "round", {
        actor: "controller",
        detail: `${input.classification}${input.detail ? `: ${input.detail}` : ""}`
      });
      return this.byID(goal.id);
    });
  }
  insertCriterion(goalID, generation, input, atMs, covers) {
    const id = newID("crit");
    this.db.query(`INSERT INTO goal_criteria (id, goal_id, generation, text, spec, source, met, covers, created_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`).run(id, goalID, generation, input.text.trim(), input.spec ? JSON.stringify(input.spec) : null, input.source ?? "user", covers && covers.length > 0 ? JSON.stringify(covers) : null, atMs);
    return id;
  }
  addCriterion(goalID, text, spec, source = "user", covers) {
    const goal = this.byID(goalID);
    if (!goal)
      throw new GoalConflictError(`unknown goal ${goalID}`);
    if (!isNonTerminal(goal.status)) {
      throw new TransitionRejectedError(`cannot add criteria to terminal goal ${goalID}`);
    }
    const normalized = text.trim().toLowerCase().replace(/\s+/g, " ");
    if (source === "model" && spec?.type === "objective") {
      throw new TransitionRejectedError("the model cannot establish an objective-type criterion; only the user can accept the objective");
    }
    const covered = covers && covers.length > 0 ? [...new Set(covers)] : undefined;
    if (covered) {
      const existing = this.listCriteria(goalID);
      for (const id2 of covered) {
        const target = existing.find((c) => c.id === id2);
        if (!target) {
          throw new TransitionRejectedError(`unknown criterion ${id2} in covers`);
        }
        if (target.spec?.type !== "objective") {
          throw new TransitionRejectedError(`criterion ${id2} is not an objective-level requirement; covers may only name the objective remainder`);
        }
      }
    }
    let id = "";
    this.tx(() => {
      const existingRows = this.db.query(`SELECT id, text FROM goal_criteria WHERE goal_id = ? AND superseded = 0`).all(goalID);
      const existing = existingRows.find((r) => r.text.trim().toLowerCase().replace(/\s+/g, " ") === normalized);
      if (existing) {
        if (covered)
          this.mergeCoverage(existing.id, covered);
        id = existing.id;
        return;
      }
      id = this.insertCriterion(goalID, goal.generation, { text, spec, source }, Date.now(), covered);
    });
    return id;
  }
  mergeCoverage(criterionID, covers) {
    const row = this.db.query(`SELECT covers FROM goal_criteria WHERE id = ?`).get(criterionID);
    if (!row)
      return;
    const merged = new Set([...row.covers ? JSON.parse(row.covers) : [], ...covers]);
    this.db.query(`UPDATE goal_criteria SET covers = ? WHERE id = ?`).run(JSON.stringify([...merged]), criterionID);
  }
  supersedeCriterion(criterionID, reason, replacement) {
    this.tx(() => {
      const row = this.db.query(`SELECT goal_id, generation, source, spec, superseded FROM goal_criteria WHERE id = ?`).get(criterionID);
      if (!row)
        throw new GoalConflictError(`unknown criterion ${criterionID}`);
      if (row.source === "user") {
        if (!replacement) {
          throw new TransitionRejectedError("an explicit user requirement cannot be superseded; it must be satisfied, or the user must replace the objective");
        }
        const oldSpec = row.spec ? JSON.parse(row.spec) : undefined;
        if (!preservesObligation(oldSpec, replacement.spec)) {
          throw new TransitionRejectedError("the proposed replacement does not preserve the original obligation; ask the user to authorize the change");
        }
        if (row.superseded === 1)
          return;
        this.db.query(`UPDATE goal_criteria SET superseded = 1, met = 0 WHERE id = ?`).run(criterionID);
        this.insertCriterion(row.goal_id, row.generation, { text: replacement.text, spec: replacement.spec, source: "user" }, Date.now());
        this.appendEvent(row.goal_id, row.generation, "criterion-superseded", {
          actor: "controller",
          detail: `model-proposed replacement preserved the obligation: ${reason.slice(0, 240)}`
        });
        return;
      }
      if (row.superseded === 1)
        return;
      this.db.query(`UPDATE goal_criteria SET superseded = 1, met = 0 WHERE id = ?`).run(criterionID);
      this.appendEvent(row.goal_id, row.generation, "criterion-superseded", {
        actor: "model",
        detail: reason.slice(0, 300)
      });
    });
  }
  recordUserAcceptance(goalID, generation, note) {
    this.tx(() => {
      const goal = this.byID(goalID);
      if (!goal)
        throw new GoalConflictError(`unknown goal ${goalID}`);
      if (goal.generation !== generation) {
        throw new GoalConflictError(`stale generation: goal ${goalID} is generation ${goal.generation}, acceptance claimed ${generation}`);
      }
      this.db.query(`INSERT INTO goal_acceptances (goal_id, generation, note, at_ms)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(goal_id) DO UPDATE SET generation=excluded.generation,
             note=excluded.note, at_ms=excluded.at_ms`).run(goalID, generation, note ?? null, Date.now());
      this.appendEvent(goalID, generation, "accepted", {
        actor: "user",
        detail: note ?? "user accepted the objective"
      });
    });
  }
  userAcceptance(goalID) {
    const row = this.db.query(`SELECT generation, note, at_ms FROM goal_acceptances WHERE goal_id = ?`).get(goalID);
    if (!row)
      return;
    return { generation: row.generation, note: row.note ?? undefined, atMs: row.at_ms };
  }
  objectiveAssessment(goalID) {
    const row = this.db.query(`SELECT generation, objective_revision, verdict, scope, covered_requirements,
                unresolved_requirements, evidence_ids, note, at_ms
           FROM goal_objective_assessments WHERE goal_id = ?`).get(goalID);
    if (!row)
      return;
    return {
      generation: row.generation,
      objectiveRevision: row.objective_revision,
      verdict: row.verdict,
      scope: row.scope,
      coveredRequirements: JSON.parse(row.covered_requirements),
      unresolvedRequirements: JSON.parse(row.unresolved_requirements),
      evidenceIDs: JSON.parse(row.evidence_ids),
      note: row.note ?? undefined,
      atMs: row.at_ms
    };
  }
  addEvidence(input) {
    const goal = this.byID(input.goalID);
    if (!goal)
      throw new GoalConflictError(`unknown goal ${input.goalID}`);
    this.tx(() => {
      this.db.query(`INSERT INTO goal_evidence (id, goal_id, generation, criterion_id, kind, ref, detail, exit_code, hash, workspace, at_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(newID("ev"), input.goalID, goal.generation, input.criterionID ?? null, input.kind, input.ref, input.detail ?? null, input.exitCode ?? null, input.hash ?? null, input.workspace ?? null, Date.now());
    });
  }
  listCriteria(goalID) {
    return this.db.query(`SELECT id, text, met, spec, source, covers FROM goal_criteria
          WHERE goal_id = ? AND superseded = 0 ORDER BY created_at_ms ASC`).all(goalID).map((r) => ({
      id: r.id,
      text: r.text,
      met: r.met === 1,
      spec: r.spec ? JSON.parse(r.spec) : undefined,
      source: r.source,
      covers: r.covers ? JSON.parse(r.covers) : undefined
    }));
  }
  listEvidence(goalID) {
    return this.db.query(`SELECT id, criterion_id, kind, ref, exit_code, hash, workspace
           FROM goal_evidence WHERE goal_id = ? ORDER BY at_ms ASC`).all(goalID).map((r) => ({
      id: r.id,
      criterionID: r.criterion_id ?? undefined,
      kind: r.kind,
      ref: r.ref,
      exitCode: r.exit_code ?? undefined,
      hash: r.hash ?? undefined,
      workspace: r.workspace ?? undefined
    }));
  }
  bindEvidence(criterionID, evidenceIDs) {
    return this.tx(() => {
      const criterion = this.db.query(`SELECT id, goal_id FROM goal_criteria WHERE id = ?`).get(criterionID);
      if (!criterion)
        throw new GoalConflictError(`unknown criterion ${criterionID}`);
      let bound = 0;
      for (const evidenceID of evidenceIDs) {
        const updated = this.db.query(`UPDATE goal_evidence SET criterion_id = ?
              WHERE id = ? AND goal_id = ?`).run(criterionID, evidenceID, criterion.goal_id);
        bound += updated.changes;
      }
      return bound;
    });
  }
  recordProofs(goalID, proofs, snapshot, attempt, assessment) {
    return this.tx(() => {
      const goal = this.byID(goalID);
      if (!goal)
        throw new GoalConflictError(`unknown goal ${goalID}`);
      if (attempt && (goal.generation !== attempt.generation || goal.version !== attempt.version)) {
        return false;
      }
      const now = Date.now();
      for (const proof of proofs) {
        this.db.query(`INSERT INTO goal_criterion_proofs
               (id, goal_id, generation, criterion_id, evidence_ids, validator_id, verdict, detail, created_at_ms)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(newID("proof"), goalID, goal.generation, proof.criterionID, JSON.stringify(proof.evidenceIDs), proof.validatorID, proof.verdict, proof.detail, now);
        this.db.query(`UPDATE goal_criteria SET met = ? WHERE id = ? AND goal_id = ?`).run(proof.verdict === "pass" ? 1 : 0, proof.criterionID, goalID);
      }
      if (assessment) {
        this.db.query(`INSERT INTO goal_objective_assessments
               (goal_id, generation, objective_revision, verdict, scope,
                covered_requirements, unresolved_requirements, evidence_ids, note, at_ms)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(goal_id) DO UPDATE SET generation=excluded.generation,
               objective_revision=excluded.objective_revision, verdict=excluded.verdict,
               scope=excluded.scope, covered_requirements=excluded.covered_requirements,
               unresolved_requirements=excluded.unresolved_requirements,
               evidence_ids=excluded.evidence_ids, note=excluded.note, at_ms=excluded.at_ms`).run(goalID, goal.generation, assessment.objectiveRevision, assessment.verdict, assessment.scope, JSON.stringify(assessment.coveredRequirements), JSON.stringify(assessment.unresolvedRequirements), JSON.stringify(assessment.evidenceIDs), assessment.note ?? null, now);
        this.appendEvent(goalID, goal.generation, "assessed", {
          actor: "controller",
          detail: `${assessment.verdict}: ${assessment.unresolvedRequirements.length} unresolved requirement(s)`
        });
      }
      this.db.query(`UPDATE goals
              SET verification_revision = verification_revision + 1,
                  verification_snapshot = ?,
                  updated_at_ms = ?,
                  version = version + 1
            WHERE id = ? AND version = ?`).run(snapshot, now, goalID, goal.version);
      return true;
    });
  }
  listProofs(goalID) {
    return this.db.query(`SELECT id, criterion_id, evidence_ids, validator_id, verdict, detail
           FROM goal_criterion_proofs WHERE goal_id = ? ORDER BY created_at_ms ASC`).all(goalID).map((r) => ({
      id: r.id,
      criterionID: r.criterion_id,
      evidenceIDs: JSON.parse(r.evidence_ids),
      validatorID: r.validator_id,
      verdict: r.verdict,
      detail: r.detail ?? undefined
    }));
  }
  rememberMessageGeneration(sessionID, messageID, generation, atMs) {
    this.tx(() => {
      this.db.query(`INSERT INTO goal_message_generations (session_id, message_id, generation, at_ms)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(session_id, message_id) DO NOTHING`).run(sessionID, messageID, generation, atMs);
    });
  }
  resolveMessageGeneration(sessionID, messageID) {
    const row = this.db.query(`SELECT generation FROM goal_message_generations WHERE session_id = ? AND message_id = ?`).get(sessionID, messageID);
    return row?.generation;
  }
  recordBlockerClaim(input) {
    return this.tx(() => {
      const normalized = normalizeBlockerReason(input.reason);
      this.db.query(`INSERT INTO goal_blocker_claims (id, goal_id, generation, round_number, reason, at_ms)
           VALUES (?, ?, ?, ?, ?, ?)`).run(newID("blk"), input.goalID, input.generation, input.roundNumber, normalized, Date.now());
      const row = this.db.query(`SELECT COUNT(DISTINCT round_number) AS n
             FROM goal_blocker_claims
            WHERE goal_id = ? AND generation = ? AND reason = ?`).get(input.goalID, input.generation, normalized);
      return row.n;
    });
  }
  blockerConfirmations(goalID, generation, reason) {
    const row = this.db.query(`SELECT COUNT(DISTINCT round_number) AS n
           FROM goal_blocker_claims
          WHERE goal_id = ? AND generation = ? AND reason = ?`).get(goalID, generation, normalizeBlockerReason(reason));
    return row.n;
  }
  recordSessionUsage(sessionID, totalTokens) {
    return this.tx(() => {
      const previous = this.db.query(`SELECT total_tokens FROM session_usage WHERE session_id = ?`).get(sessionID)?.total_tokens ?? 0;
      const delta = Math.max(0, Math.floor(totalTokens) - previous);
      this.db.query(`INSERT INTO session_usage (session_id, total_tokens, updated_at_ms)
           VALUES (?, ?, ?)
           ON CONFLICT(session_id) DO UPDATE SET
             total_tokens = excluded.total_tokens,
             updated_at_ms = excluded.updated_at_ms`).run(sessionID, Math.floor(totalTokens), Date.now());
      const current = this.current(sessionID);
      if (!delta || !current || !isNonTerminal(current.status)) {
        return { goal: current, delta };
      }
      this.db.query(`UPDATE goals SET tokens_used = COALESCE(tokens_used, 0) + ?, updated_at_ms = ? WHERE id = ?`).run(delta, Date.now(), current.id);
      return { goal: this.byID(current.id), delta };
    });
  }
  setTokenBudget(goalID, budget) {
    return this.tx(() => {
      this.db.query(`UPDATE goals SET token_budget = ?, updated_at_ms = ? WHERE id = ?`).run(budget === undefined ? null : Math.floor(budget), Date.now(), goalID);
      const goal = this.byID(goalID);
      if (!goal)
        throw new GoalConflictError(`unknown goal ${goalID}`);
      return goal;
    });
  }
  reconcileAfterRestart() {
    return this.tx(() => {
      const stranded = this.db.query(`SELECT * FROM goals WHERE status = 'verifying'`).all().map(toGoal);
      const repaired = [];
      for (const goal of stranded) {
        this.db.query(`UPDATE goals SET status='active', reason=?, updated_at_ms=?, version=version+1
             WHERE id=? AND version=?`).run("resumed after restart: verification was interrupted", Date.now(), goal.id, goal.version);
        this.appendEvent(goal.id, goal.generation, "restart-reconcile", {
          fromStatus: "verifying",
          toStatus: "active",
          actor: "controller"
        });
        repaired.push(this.byID(goal.id));
      }
      return repaired;
    });
  }
  prepareRound(input) {
    return this.tx(() => {
      const goal = this.byID(input.goalID);
      if (!goal)
        throw new GoalConflictError(`unknown goal ${input.goalID}`);
      if (goal.generation !== input.generation) {
        throw new GoalConflictError(`stale generation: ${input.goalID} is generation ${goal.generation}, round claimed ${input.generation}`);
      }
      if (isTerminal(goal.status)) {
        throw new GoalConflictError(`goal ${input.goalID} is terminal (${goal.status})`);
      }
      const existing = this.outstandingRound(input.goalID);
      if (existing) {
        throw new GoalConflictError(`goal ${input.goalID} already has an outstanding round (${existing.id}, ${existing.status})`);
      }
      const id = newID("round");
      const now = Date.now();
      const baseline = this.db.query(`SELECT COUNT(*) AS n FROM goal_evidence WHERE goal_id = ? AND kind != 'ref'`).get(input.goalID).n;
      this.db.query(`INSERT INTO goal_rounds
             (id, goal_id, generation, inbox_id, status, attempts, evidence_baseline, prepared_at_ms)
           VALUES (?, ?, ?, ?, 'prepared', 1, ?, ?)`).run(id, input.goalID, input.generation, input.inboxID, baseline, now);
      this.appendEvent(input.goalID, input.generation, "round-prepared", {
        actor: "controller",
        detail: input.inboxID
      });
      return this.roundByID(id);
    });
  }
  roundByID(id) {
    const r = this.db.query(`SELECT * FROM goal_rounds WHERE id = ?`).get(id);
    return r ? toRound(r) : undefined;
  }
  roundByInboxID(inboxID) {
    const r = this.db.query(`SELECT * FROM goal_rounds WHERE inbox_id = ?`).get(inboxID);
    return r ? toRound(r) : undefined;
  }
  outstandingRound(goalID) {
    const r = this.db.query(`SELECT * FROM goal_rounds
          WHERE goal_id = ? AND status IN ('prepared','admitted','running','unknown')
          LIMIT 1`).get(goalID);
    return r ? toRound(r) : undefined;
  }
  outstandingRounds() {
    return this.db.query(`SELECT * FROM goal_rounds
          WHERE status IN ('prepared','admitted','running','unknown')
          ORDER BY prepared_at_ms ASC`).all().map(toRound);
  }
  roundsFor(goalID) {
    return this.db.query(`SELECT * FROM goal_rounds WHERE goal_id = ? ORDER BY prepared_at_ms ASC`).all(goalID).map(toRound);
  }
  markRoundAdmitted(roundID) {
    return this.tx(() => {
      const round = this.roundByID(roundID);
      if (!round)
        throw new GoalConflictError(`unknown round ${roundID}`);
      const updated = this.db.query(`UPDATE goal_rounds SET status='admitted', admitted_at_ms=?
            WHERE id=? AND status IN ('prepared','unknown')`).run(Date.now(), roundID);
      if (updated.changes !== 1) {
        throw new GoalConflictError(`cannot admit round ${roundID}: expected prepared/unknown, found ${round.status}`);
      }
      this.appendEvent(round.goalID, round.generation, "round-admitted", {
        actor: "controller",
        detail: round.inboxID
      });
      return this.roundByID(roundID);
    });
  }
  markRoundRunning(roundID) {
    return this.tx(() => {
      const round = this.roundByID(roundID);
      if (!round)
        throw new GoalConflictError(`unknown round ${roundID}`);
      this.db.query(`UPDATE goal_rounds SET status='running' WHERE id=? AND status IN ('prepared','admitted','unknown')`).run(roundID);
      this.appendEvent(round.goalID, round.generation, "round-running", { actor: "controller" });
      return this.roundByID(roundID);
    });
  }
  markRoundUnknown(roundID, detail) {
    return this.tx(() => {
      const round = this.roundByID(roundID);
      if (!round)
        throw new GoalConflictError(`unknown round ${roundID}`);
      this.db.query(`UPDATE goal_rounds SET status='unknown', attempts=attempts+1, detail=? WHERE id=?`).run(detail, roundID);
      this.appendEvent(round.goalID, round.generation, "round-unknown", {
        actor: "controller",
        detail
      });
      return this.roundByID(roundID);
    });
  }
  markRoundFailed(roundID, detail, options = {}) {
    const parkGoal = options.parkGoal ?? true;
    return this.tx(() => {
      const round = this.roundByID(roundID);
      if (!round)
        throw new GoalConflictError(`unknown round ${roundID}`);
      this.db.query(`UPDATE goal_rounds SET status='failed', detail=?, settled_at_ms=? WHERE id=?`).run(detail, Date.now(), roundID);
      const goal = this.byID(round.goalID);
      if (goal && parkGoal) {
        this.db.query(`UPDATE goals SET delivery_failed=1, updated_at_ms=?, version=version+1
              WHERE id=? AND version=?`).run(Date.now(), goal.id, goal.version);
      }
      this.appendEvent(round.goalID, round.generation, "round-failed", {
        actor: "controller",
        detail
      });
      return this.roundByID(roundID);
    });
  }
  clearDeliveryFailure(goalID) {
    return this.tx(() => {
      const goal = this.byID(goalID);
      if (!goal)
        return;
      if (!goal.deliveryFailed)
        return goal;
      this.db.query(`UPDATE goals SET delivery_failed=0, updated_at_ms=?, version=version+1
            WHERE id=? AND version=?`).run(Date.now(), goal.id, goal.version);
      this.appendEvent(goal.id, goal.generation, "delivery-recovered", {
        actor: "controller",
        detail: "terminal delivery failure cleared"
      });
      return this.byID(goal.id);
    });
  }
  settleRound(input) {
    return this.tx(() => {
      const round = this.roundByID(input.roundID);
      if (!round)
        throw new GoalConflictError(`unknown round ${input.roundID}`);
      if (round.status === "settled")
        return round;
      this.db.query(`UPDATE goal_rounds SET status='settled', classification=?, detail=?, settled_at_ms=? WHERE id=?`).run(input.classification, input.detail ?? null, Date.now(), input.roundID);
      this.appendEvent(round.goalID, round.generation, "round-settled", {
        actor: "controller",
        detail: `${input.classification}${input.detail ? `: ${input.detail}` : ""}`
      });
      return this.roundByID(input.roundID);
    });
  }
  settleAndRecord(input) {
    return this.tx(() => {
      const before = this.roundByID(input.roundID);
      if (!before)
        throw new GoalConflictError(`unknown round ${input.roundID}`);
      if (before.status === "settled")
        return { round: before };
      this.settleRound(input);
      const goal = this.recordRound({
        goalID: before.goalID,
        generation: before.generation,
        classification: input.classification,
        detail: input.detail,
        tokensUsed: input.tokensUsed
      });
      return { round: this.roundByID(input.roundID), goal };
    });
  }
  snapshotOf(goalID) {
    return snapshotHash(this.listCriteria(goalID), this.listEvidence(goalID));
  }
  completeGoal(input) {
    return this.tx(() => {
      const goal = this.byID(input.goalID);
      if (!goal)
        throw new GoalConflictError(`unknown goal ${input.goalID}`);
      if (goal.generation !== input.generation) {
        throw new GoalConflictError(`stale generation: ${input.goalID} is generation ${goal.generation}, completion claimed ${input.generation}`);
      }
      if (goal.status !== "verifying") {
        throw new TransitionRejectedError(`cannot complete goal ${input.goalID} from status ${goal.status}; verification is required first`);
      }
      if (input.snapshot !== undefined) {
        const current = this.snapshotOf(input.goalID);
        if (current !== input.snapshot) {
          throw new GoalConflictError(`verification is stale: the criteria or evidence changed after the verifier checked ` + `${input.snapshot} (now ${current}); re-verify before completing`);
        }
      }
      const outstanding = this.outstandingRound(input.goalID);
      if (outstanding) {
        this.settleRound({
          roundID: outstanding.id,
          classification: input.settleClassification,
          detail: input.reason
        });
        this.recordRound({
          goalID: input.goalID,
          generation: input.generation,
          classification: input.settleClassification,
          detail: input.reason
        });
      }
      return this.transition({
        goalID: input.goalID,
        generation: input.generation,
        to: "complete",
        actor: "controller",
        reason: input.reason
      });
    });
  }
  generationAt(sessionID, atMs) {
    const row = this.db.query(`SELECT generation FROM goals
          WHERE session_id = ? AND created_at_ms <= ?
          ORDER BY created_at_ms DESC LIMIT 1`).get(sessionID, atMs);
    return row?.generation;
  }
  generationCount(sessionID) {
    const row = this.db.query(`SELECT COUNT(*) AS n FROM goals WHERE session_id = ?`).get(sessionID);
    return row?.n ?? 0;
  }
}
function toRound(r) {
  return {
    id: r.id,
    goalID: r.goal_id,
    generation: r.generation,
    inboxID: r.inbox_id,
    status: r.status,
    classification: r.classification ?? undefined,
    attempts: r.attempts,
    evidenceBaseline: r.evidence_baseline,
    detail: r.detail ?? undefined,
    preparedAtMs: r.prepared_at_ms,
    admittedAtMs: r.admitted_at_ms ?? undefined,
    settledAtMs: r.settled_at_ms ?? undefined
  };
}

// src/controller/controller.ts
class GoalController {
  store;
  maxNoProgressRounds;
  minBlockerConfirmations;
  deriveCriteria;
  constructor(options) {
    this.store = new GoalStore(options.dbPath);
    this.maxNoProgressRounds = options.maxNoProgressRounds ?? 3;
    this.minBlockerConfirmations = options.minBlockerConfirmations ?? 2;
    this.deriveCriteria = options.deriveCriteria ?? deriveCriteria;
  }
  close() {
    this.store.close();
  }
  reconcileStartup() {
    return this.store.reconcileAfterRestart();
  }
  criteriaFor(objective) {
    return this.deriveCriteria(objective);
  }
  policyFor(objective, criteria) {
    return completionPolicyFor(objective, criteria.map((c) => ({
      text: c.text,
      spec: c.spec ?? { type: "objective" },
      source: c.source ?? "user"
    })));
  }
  startOrDescribe(sessionID, objective) {
    const existing = this.store.current(sessionID);
    if (existing)
      return { existing };
    const criteria = this.criteriaFor(objective);
    const goal = this.store.create({
      sessionID,
      objective,
      actor: "user",
      criteria,
      completionPolicy: this.policyFor(objective, criteria)
    });
    return { created: goal };
  }
  replace(sessionID, objective, expectedGeneration) {
    const existing = this.store.current(sessionID);
    const criteria = this.criteriaFor(objective);
    const completionPolicy = this.policyFor(objective, criteria);
    if (!existing) {
      return this.store.create({ sessionID, objective, actor: "user", criteria, completionPolicy });
    }
    return this.store.replace({
      sessionID,
      expectedGeneration: expectedGeneration ?? existing.generation,
      objective,
      actor: "user",
      criteria,
      completionPolicy
    });
  }
  pause(sessionID) {
    const goal = this.requireCurrent(sessionID);
    return this.store.transition({
      goalID: goal.id,
      generation: goal.generation,
      to: "paused",
      actor: "user"
    });
  }
  resume(sessionID) {
    const goal = this.requireCurrent(sessionID);
    const resumed = this.store.transition({
      goalID: goal.id,
      generation: goal.generation,
      to: "active",
      actor: "user",
      reason: "resumed by user"
    });
    if (resumed.deliveryFailed)
      this.store.clearDeliveryFailure(resumed.id);
    return this.store.byID(resumed.id) ?? resumed;
  }
  acceptObjective(sessionID, note) {
    const goal = this.requireCurrent(sessionID);
    this.store.recordUserAcceptance(goal.id, goal.generation, note);
    return this.store.byID(goal.id) ?? goal;
  }
  status(sessionID) {
    return this.store.current(sessionID);
  }
  latest(sessionID) {
    return this.store.latest(sessionID);
  }
  recordUsage(sessionID, totalTokens) {
    return this.store.recordSessionUsage(sessionID, totalTokens).goal;
  }
  setBudget(sessionID, budget) {
    const goal = this.requireCurrent(sessionID);
    return this.store.setTokenBudget(goal.id, budget);
  }
  health(sessionID) {
    const goal = this.store.latest(sessionID);
    if (!goal)
      return { ok: true, goal: null };
    const criteria = this.store.listCriteria(goal.id);
    const evidence = this.store.listEvidence(goal.id);
    const round = this.store.outstandingRound(goal.id);
    const rounds = this.store.roundsFor(goal.id);
    const last = rounds[rounds.length - 1];
    const stuckMs = round ? Date.now() - round.preparedAtMs : 0;
    const problems = [];
    if (goal.status === "active" && !round) {
      problems.push("active goal has no outstanding round: nothing is driving it");
    }
    if (goal.deliveryFailed) {
      problems.push("continuation delivery failed; automatic dispatch is halted");
    }
    if (round && round.attempts > 3) {
      problems.push(`round ${round.id} has ${round.attempts} submission attempts`);
    }
    if (round && stuckMs > 5 * 60000) {
      problems.push(`round ${round.id} has been outstanding for ${Math.round(stuckMs / 1000)}s`);
    }
    if (goal.status === "verifying") {
      const unmet = criteria.filter((criterion) => !criterion.met);
      if (unmet.length)
        problems.push(`${unmet.length} unmet criterion/criteria during verification`);
    }
    return {
      ok: problems.length === 0,
      goal: {
        id: goal.id,
        generation: goal.generation,
        status: goal.status,
        objective: goal.objective
      },
      drive: {
        outstandingRound: round ? { id: round.id, status: round.status, attempts: round.attempts, ageMs: stuckMs } : null,
        lastRound: last ? { id: last.id, status: last.status, classification: last.classification ?? null } : null,
        deliveryFailed: goal.deliveryFailed,
        rounds: goal.rounds,
        noProgressRounds: goal.noProgressRounds
      },
      usage: {
        tokensUsed: goal.tokensUsed ?? 0,
        tokenBudget: goal.tokenBudget ?? null
      },
      verification: {
        criteria: criteria.map((criterion) => ({
          id: criterion.id,
          text: criterion.text,
          met: criterion.met,
          source: criterion.source
        })),
        evidenceCount: evidence.length,
        verificationRevision: goal.verificationRevision
      },
      problems
    };
  }
  history(sessionID) {
    return this.store.history(sessionID);
  }
  get(sessionID) {
    return this.store.current(sessionID);
  }
  bindCriterionEvidence(goalID, criterionID, refs) {
    const evidence = this.store.listEvidence(goalID);
    const chosen = new Set;
    for (const ref of refs) {
      const byID = evidence.find((e) => e.id === ref);
      if (byID) {
        chosen.add(byID.id);
        continue;
      }
      const exact = evidence.filter((e) => e.ref === ref);
      if (exact.length > 0) {
        for (const e of exact)
          chosen.add(e.id);
        continue;
      }
      const candidate = ref.includes("/") || ref.includes("\\") ? evidence.filter((e) => e.ref.endsWith(ref) || e.ref.endsWith(`/${ref}`)) : evidence.filter((e) => e.kind === "file" && e.ref.split("/").pop() === ref);
      if (candidate.length > 0 && new Set(candidate.map((e) => e.ref)).size === 1) {
        for (const e of candidate)
          chosen.add(e.id);
      }
    }
    if (chosen.size === 0)
      return 0;
    return this.store.bindEvidence(criterionID, [...chosen]);
  }
  resolveCriterion(goalID, identifier) {
    const criteria = this.store.listCriteria(goalID);
    if (criteria.some((criterion) => criterion.id === identifier))
      return identifier;
    const byText = criteria.filter((criterion) => criterion.text === identifier);
    return byText.length === 1 ? byText[0].id : undefined;
  }
  checkpoint(sessionID, input) {
    const target = this.resolveTarget(sessionID, input);
    if (!target.ok)
      return { recorded: false, rejected: target.rejected };
    const goal = target.goal;
    for (const ref of input.evidenceRefs ?? []) {
      this.store.addEvidence({
        goalID: goal.id,
        criterionID: input.criterionID,
        kind: "ref",
        ref,
        detail: input.summary
      });
    }
    return { recorded: true, goal: this.store.byID(goal.id) };
  }
  addCriterion(sessionID, input) {
    const target = this.resolveTarget(sessionID, input);
    if (!target.ok)
      return { rejected: target.rejected };
    try {
      const criterionID = this.store.addCriterion(target.goal.id, input.text, input.spec, "model", input.covers);
      return { criterionID };
    } catch (error) {
      return { rejected: String(error) };
    }
  }
  supersedeCriterion(sessionID, input) {
    const target = this.resolveTarget(sessionID, input);
    if (!target.ok)
      return { rejected: target.rejected };
    if (input.replacement && !input.replacement.text.trim()) {
      return { rejected: "a replacement proposal requires non-empty text" };
    }
    const criterionID = this.resolveCriterion(target.goal.id, input.criterion_id);
    if (!criterionID) {
      return { rejected: `criterion ${input.criterion_id} does not exist on this goal` };
    }
    try {
      this.store.supersedeCriterion(criterionID, input.reason, input.replacement);
      return { superseded: true };
    } catch (error) {
      return { rejected: String(error) };
    }
  }
  proposeComplete(sessionID, input) {
    const target = this.resolveTarget(sessionID, input);
    if (!target.ok)
      return { rejected: target.rejected };
    const goal = target.goal;
    for (const ref of input.evidenceRefs ?? []) {
      this.store.addEvidence({ goalID: goal.id, kind: "ref", ref, detail: input.summary });
    }
    for (const binding of input.criteria ?? []) {
      const criterionID = this.resolveCriterion(goal.id, binding.criterionID);
      if (criterionID)
        this.bindCriterionEvidence(goal.id, criterionID, binding.evidenceRefs);
    }
    const updated = this.store.transition({
      goalID: goal.id,
      generation: goal.generation,
      to: "verifying",
      actor: "model",
      reason: input.summary.slice(0, 300)
    });
    return { goal: updated };
  }
  reportBlocked(sessionID, report) {
    const target = this.resolveTarget(sessionID, report);
    if (!target.ok) {
      return { accepted: false, confirmations: 0, rejected: target.rejected };
    }
    const goal = target.goal;
    for (const ref of report.evidenceRefs ?? []) {
      this.store.addEvidence({ goalID: goal.id, kind: "blocker-ref", ref, detail: report.reason });
    }
    const roundNumber = goal.rounds + 1;
    const confirmations = this.store.recordBlockerClaim({
      goalID: goal.id,
      generation: goal.generation,
      roundNumber,
      reason: report.reason
    });
    const genuine = confirmations >= this.minBlockerConfirmations;
    if (!genuine) {
      return {
        goal: this.store.byID(goal.id),
        accepted: false,
        confirmations
      };
    }
    const blocked = this.store.transition({
      goalID: goal.id,
      generation: goal.generation,
      to: "blocked",
      actor: "controller",
      reason: report.reason.slice(0, 300)
    });
    return { goal: blocked, accepted: true, confirmations };
  }
  classifyRound(sessionID, classification, detail, tokensUsed) {
    const goal = this.store.current(sessionID);
    if (!goal || !isNonTerminal(goal.status))
      return goal;
    const updated = this.store.recordRound({
      goalID: goal.id,
      generation: goal.generation,
      classification,
      detail,
      tokensUsed
    });
    if (classification === "noProgress" && updated.noProgressRounds >= this.maxNoProgressRounds && updated.status === "active") {
      return this.store.transition({
        goalID: updated.id,
        generation: updated.generation,
        to: "stalled",
        actor: "controller",
        reason: `${updated.noProgressRounds} consecutive rounds without progress`
      });
    }
    return updated;
  }
  enforceBudget(sessionID) {
    const goal = this.store.current(sessionID);
    if (!goal || goal.status !== "active")
      return goal;
    if (goal.tokenBudget !== undefined && (goal.tokensUsed ?? 0) >= goal.tokenBudget) {
      return this.store.transition({
        goalID: goal.id,
        generation: goal.generation,
        to: "budgetLimited",
        actor: "controller",
        reason: `token budget reached (${goal.tokensUsed}/${goal.tokenBudget})`
      });
    }
    return goal;
  }
  commitComplete(goalID, generation, reason, snapshot) {
    return this.store.completeGoal({
      goalID,
      generation,
      reason,
      snapshot,
      settleClassification: "complete"
    });
  }
  rejectCompletion(goalID, generation, reason) {
    const goal = this.store.byID(goalID);
    if (!goal || goal.status !== "verifying")
      return goal;
    if (goal.generation !== generation)
      return goal;
    return this.store.transition({
      goalID: goal.id,
      generation: goal.generation,
      to: "active",
      actor: "controller",
      reason
    });
  }
  requireCurrent(sessionID) {
    const goal = this.store.current(sessionID);
    if (!goal)
      throw new GoalConflictError(`session ${sessionID} has no current goal`);
    return goal;
  }
  resolveTarget(sessionID, ref) {
    const current = this.store.current(sessionID);
    if (!current)
      return { ok: false, rejected: "no active goal for this session" };
    if (!isNonTerminal(current.status)) {
      return { ok: false, rejected: `goal is ${current.status}` };
    }
    if (!ref?.goalID) {
      return {
        ok: false,
        rejected: `unresolved goal reference: the tool call must name the current goal (${current.id})`
      };
    }
    if (ref.goalID !== current.id) {
      return {
        ok: false,
        rejected: `stale goal reference: ${ref.goalID} is not the current goal (${current.id})`
      };
    }
    if (ref.generation === undefined) {
      return {
        ok: false,
        rejected: `unresolved generation: the tool call must name generation ${current.generation}`
      };
    }
    if (ref.generation !== current.generation) {
      return {
        ok: false,
        rejected: `stale generation: callback claimed ${ref.generation}, current is ${current.generation}`
      };
    }
    return { ok: true, goal: current };
  }
}

// src/controller/calls.ts
function selectToolRef(resolved, input, messageID) {
  if (resolved.goalID && resolved.generation !== undefined) {
    return { ok: true, ref: resolved };
  }
  if (messageID) {
    return {
      ok: false,
      reason: "this call could not be attributed to a goal generation from its message; call goal_get and retry from the current turn"
    };
  }
  if (input?.goal_id && input.generation !== undefined) {
    return { ok: true, ref: { goalID: input.goal_id, generation: input.generation } };
  }
  return {
    ok: false,
    reason: "this call carries neither a resolvable message identity nor a complete goal reference (goal_id and generation); call goal_get and retry"
  };
}
function attributeMessageGeneration(messages, messageID, generationOf) {
  const index = messages.findIndex((m) => m?.id === messageID);
  if (index === -1)
    return;
  for (let i = index - 1;i >= 0; i--) {
    const message = messages[i];
    if (!message)
      continue;
    const generation = generationOf(message);
    if (generation !== undefined)
      return generation;
    if (message.type === "user")
      return;
  }
  return;
}

// src/controller/coordinator.ts
class GoalCoordinator {
  controller;
  dispatcher;
  hooks;
  constructor(controller, dispatcher, hooks = {}) {
    this.controller = controller;
    this.dispatcher = dispatcher;
    this.hooks = hooks;
  }
  async start(sessionID, objective) {
    const out = this.controller.startOrDescribe(sessionID, objective);
    if ("existing" in out)
      return { existing: out.existing };
    const drive = await this.drive(sessionID);
    return { created: out.created, drive };
  }
  async replace(sessionID, objective, expectedGeneration) {
    const goal = this.controller.replace(sessionID, objective, expectedGeneration);
    const drive = await this.drive(sessionID);
    return { goal, drive };
  }
  async resume(sessionID) {
    const goal = this.controller.resume(sessionID);
    const drive = await this.drive(sessionID);
    return { goal, drive };
  }
  pause(sessionID) {
    return this.controller.pause(sessionID);
  }
  async drive(sessionID) {
    const dispatcher = this.dispatcher();
    if (!dispatcher)
      return;
    try {
      return await dispatcher.drive(sessionID);
    } catch (error) {
      this.hooks.onDriveError?.(sessionID, error);
      return;
    }
  }
}

// src/controller/driver.ts
var DEFAULT_CLASSIFY = ({
  evidenceDelta,
  liveWait
}) => {
  if (evidenceDelta > 0) {
    return { classification: "progress", detail: `${evidenceDelta} new evidence item(s)` };
  }
  if (liveWait) {
    return {
      classification: "verifiedWait",
      detail: "no new evidence, but a background execution is still running"
    };
  }
  return { classification: "noProgress", detail: "no new evidence captured this round" };
};
var seq = 0;
function newInboxID() {
  seq += 1;
  const rand = Math.random().toString(36).slice(2, 10);
  return `msg_xgoal_${Date.now().toString(36)}${seq.toString(36)}${rand}`;
}
var DEFAULT_CONTINUATION = (goal) => [
  "Continue working toward the active goal.",
  "",
  `Objective: ${goal.objective}`,
  "",
  "Inspect the current state before acting. Take the next useful action.",
  "A workflow preference, an optional decision, or a choice between reasonable",
  "next steps is not a blocker — choose and continue. If the objective is",
  "genuinely satisfied, propose completion with evidence."
].join(`
`);

class GoalDriver {
  store;
  transport;
  maxNoProgressRounds;
  maxRoundAttempts;
  render;
  classify;
  constructor(store, transport, options = {}) {
    this.store = store;
    this.transport = transport;
    this.maxNoProgressRounds = options.maxNoProgressRounds ?? 3;
    this.maxRoundAttempts = options.maxRoundAttempts ?? 5;
    this.render = options.renderContinuation ?? DEFAULT_CONTINUATION;
    this.classify = options.classify ?? DEFAULT_CLASSIFY;
  }
  async drive(sessionID) {
    const goal = this.store.current(sessionID);
    if (goal && goal.status === "active") {
      const outstanding = this.store.outstandingRound(goal.id);
      if (outstanding) {
        const outcome = await this.reconcileRound(outstanding);
        if (outcome.action !== "reconcile")
          return outcome;
      }
    }
    const decision = this.reserve(sessionID);
    if (decision.action !== "dispatch")
      return decision.outcome;
    return this.dispatch(decision.round, sessionID);
  }
  reserve(sessionID) {
    const goal = this.store.current(sessionID);
    if (!goal)
      return { action: "done", outcome: { action: "idle", reason: "no goal" } };
    if (goal.status !== "active") {
      return {
        action: "done",
        outcome: { action: "idle", reason: `goal status is ${goal.status}` }
      };
    }
    const outstanding = this.store.outstandingRound(goal.id);
    if (outstanding) {
      return {
        action: "done",
        outcome: { action: "reconcile", roundID: outstanding.id, status: outstanding.status }
      };
    }
    if (goal.deliveryFailed) {
      return {
        action: "done",
        outcome: { action: "idle", reason: "delivery failed; awaiting recovery" }
      };
    }
    if (goal.tokenBudget !== undefined && (goal.tokensUsed ?? 0) >= goal.tokenBudget) {
      const limited = this.store.transition({
        goalID: goal.id,
        generation: goal.generation,
        to: "budgetLimited",
        actor: "controller",
        reason: `token budget reached (${goal.tokensUsed}/${goal.tokenBudget})`
      });
      return { action: "done", outcome: { action: "limited", status: limited.status } };
    }
    const inboxID = newInboxID();
    const round = this.store.prepareRound({
      goalID: goal.id,
      generation: goal.generation,
      inboxID
    });
    return { action: "dispatch", round };
  }
  async dispatch(round, sessionID) {
    const goal = this.store.byID(round.goalID);
    if (!goal || goal.generation !== round.generation || goal.status !== "active") {
      const detail = goal ? `goal moved to generation ${goal.generation} / status ${goal.status}` : "goal no longer exists";
      this.store.markRoundFailed(round.id, `abandoned before admission: ${detail}`, {
        parkGoal: false
      });
      return { action: "abandoned", roundID: round.id, detail };
    }
    try {
      const result = await this.transport.submit({
        sessionID,
        inboxID: round.inboxID,
        text: this.render(goal),
        metadata: {
          goalID: goal.id,
          generation: goal.generation,
          roundID: round.id,
          inboxID: round.inboxID
        }
      });
      if (result.ok) {
        this.store.markRoundAdmitted(round.id);
        this.store.rememberMessageGeneration(sessionID, round.inboxID, round.generation, Date.now());
        return { action: "admitted", roundID: round.id, inboxID: round.inboxID };
      }
      if (result.retryable) {
        this.store.markRoundUnknown(round.id, result.error);
        return {
          action: "unknown",
          roundID: round.id,
          inboxID: round.inboxID,
          detail: result.error
        };
      }
      this.store.markRoundFailed(round.id, result.error);
      return {
        action: "failed",
        roundID: round.id,
        inboxID: round.inboxID,
        detail: result.error
      };
    } catch (error) {
      const detail = String(error);
      this.store.markRoundUnknown(round.id, detail);
      return { action: "unknown", roundID: round.id, inboxID: round.inboxID, detail };
    }
  }
  async reconcile() {
    const out = [];
    for (const round of this.store.outstandingRounds()) {
      out.push(await this.reconcileRound(round));
    }
    return out;
  }
  async reconcileRound(round) {
    const goal = this.store.byID(round.goalID);
    if (!goal) {
      this.store.markRoundFailed(round.id, "goal vanished");
      return { action: "failed", roundID: round.id, inboxID: round.inboxID, detail: "goal vanished" };
    }
    if (goal.generation !== round.generation || isTerminal(goal.status)) {
      const detail = `superseded (generation ${goal.generation}, status ${goal.status})`;
      this.store.markRoundFailed(round.id, detail, { parkGoal: false });
      return { action: "failed", roundID: round.id, inboxID: round.inboxID, detail };
    }
    if (round.attempts > this.maxRoundAttempts) {
      const detail = `exceeded ${this.maxRoundAttempts} submission attempts`;
      this.store.markRoundFailed(round.id, detail);
      return { action: "failed", roundID: round.id, inboxID: round.inboxID, detail };
    }
    const probe = await this.transport.probe({ sessionID: goal.sessionID, round });
    switch (probe) {
      case "running":
        this.store.markRoundRunning(round.id);
        return { action: "reconcile", roundID: round.id, status: "running" };
      case "settled": {
        const verifiable = this.store.listEvidence(goal.id).filter((e) => e.kind !== "ref");
        const evidenceCount = verifiable.length;
        const evidenceDelta = Math.max(0, evidenceCount - round.evidenceBaseline);
        const liveWait = this.transport.liveWait?.({ sessionID: goal.sessionID }) ?? false;
        const verdict = this.classify({ goal, round, evidenceCount, evidenceDelta, liveWait });
        const settledGoal = this.settleRound({
          roundID: round.id,
          classification: verdict.classification,
          detail: verdict.detail
        });
        const settledStatus = settledGoal?.status ?? round.status;
        const after = this.store.byID(goal.id);
        if (!after || !isNonTerminal(after.status)) {
          return { action: "reconcile", roundID: round.id, status: settledStatus };
        }
        if (after.generation !== round.generation) {
          return { action: "reconcile", roundID: round.id, status: settledStatus };
        }
        const stalled = verdict.classification === "noProgress" && after.noProgressRounds >= this.maxNoProgressRounds && after.status === "active";
        if (stalled) {
          const parked = this.store.transition({
            goalID: after.id,
            generation: after.generation,
            to: "stalled",
            actor: "controller",
            reason: `${after.noProgressRounds} consecutive rounds without progress`
          });
          return { action: "reconcile", roundID: round.id, status: parked.status };
        }
        const next = this.reserve(after.sessionID);
        if (next.action === "dispatch")
          return this.dispatch(next.round, after.sessionID);
        return next.outcome;
      }
      case "notDelivered": {
        try {
          this.store.markRoundUnknown(round.id, "not delivered; retrying with original id");
        } catch {}
        const retry = this.store.roundByID(round.id);
        return this.dispatch(retry, goal.sessionID);
      }
      case "unknown":
      default:
        return { action: "reconcile", roundID: round.id, status: round.status };
    }
  }
  settleRound(input) {
    const round = this.store.roundByID(input.roundID);
    if (!round)
      throw new GoalConflictError(`unknown round ${input.roundID}`);
    const { goal } = this.store.settleAndRecord({
      roundID: input.roundID,
      classification: input.classification,
      detail: input.detail,
      tokensUsed: input.tokensUsed
    });
    return goal;
  }
  get stallThreshold() {
    return this.maxNoProgressRounds;
  }
}

// src/controller/transport.ts
var LIVE_WAIT_TTL_MS = 15 * 60 * 1000;

class RoundObserver {
  seen = new Map;
  runningBySession = new Map;
  recentTokens = new Map;
  nextToken = 0;
  slot(inboxID) {
    let s = this.seen.get(inboxID);
    if (!s) {
      s = { enqueued: false, delivered: false, running: false, finished: false };
      this.seen.set(inboxID, s);
    }
    return s;
  }
  addBusy(sessionID, slot) {
    const token = ++this.nextToken;
    let refs = this.runningBySession.get(sessionID);
    if (!refs) {
      refs = new Map;
      this.runningBySession.set(sessionID, refs);
    }
    const ref = { startedMs: Date.now() };
    if (slot)
      ref.slot = slot;
    refs.set(token, ref);
    const stack = this.recentTokens.get(sessionID);
    if (stack)
      stack.push(token);
    else
      this.recentTokens.set(sessionID, [token]);
    return token;
  }
  release(sessionID, token) {
    const refs = this.runningBySession.get(sessionID);
    if (!refs?.delete(token))
      return;
    const stack = this.recentTokens.get(sessionID);
    if (stack) {
      const at = stack.indexOf(token);
      if (at >= 0)
        stack.splice(at, 1);
      if (stack.length === 0)
        this.recentTokens.delete(sessionID);
    }
    if (refs.size === 0)
      this.runningBySession.delete(sessionID);
  }
  releaseToken(sessionID, token) {
    const ref = this.runningBySession.get(sessionID)?.get(token);
    if (!ref)
      return;
    if (ref.slot) {
      const slot = this.seen.get(ref.slot);
      if (slot?.counted === token)
        slot.counted = undefined;
    }
    this.release(sessionID, token);
  }
  releaseMostRecent(sessionID) {
    const stack = this.recentTokens.get(sessionID);
    const token = stack?.[stack.length - 1];
    if (token !== undefined)
      this.releaseToken(sessionID, token);
  }
  releaseDirect(sessionID) {
    const refs = this.runningBySession.get(sessionID);
    const stack = this.recentTokens.get(sessionID);
    if (!refs || !stack)
      return;
    for (let i = stack.length - 1;i >= 0; i--) {
      if (!refs.get(stack[i])?.slot) {
        this.releaseToken(sessionID, stack[i]);
        return;
      }
    }
  }
  observe(event) {
    const e = event;
    const type = e?.type;
    if (!type)
      return;
    const d = e?.data ?? {};
    const p = e?.properties ?? {};
    const pick = (k) => d[k] ?? p[k];
    const id = pick("messageID") ?? pick("messageId") ?? pick("message")?.id ?? pick("info")?.id;
    if (type.startsWith("session.execution.")) {
      const sessionID = pick("sessionID");
      if (sessionID) {
        const continuation = id?.startsWith("msg_xgoal_") ? this.slot(id) : undefined;
        const completed = type === "session.execution.succeeded" || type === "session.execution.failed";
        if (continuation)
          continuation.sessionID = sessionID;
        if (type === "session.execution.started") {
          if (continuation) {
            if (!continuation.counted) {
              continuation.counted = this.addBusy(sessionID, id);
            }
          } else {
            this.addBusy(sessionID);
          }
        } else if (completed) {
          if (continuation?.counted !== undefined) {
            this.releaseToken(sessionID, continuation.counted);
          } else if (continuation) {
            this.releaseDirect(sessionID);
          } else {
            this.releaseMostRecent(sessionID);
          }
        }
      }
    }
    if (!id || !id.startsWith("msg_xgoal_"))
      return;
    const s = this.slot(id);
    switch (type) {
      case "session.inbox.enqueued":
        s.enqueued = true;
        break;
      case "session.inbox.delivered":
        s.enqueued = true;
        s.delivered = true;
        break;
      case "session.execution.started":
        s.delivered = true;
        s.running = true;
        break;
      case "session.execution.succeeded":
      case "session.execution.failed":
        s.finished = true;
        s.running = false;
        break;
      default:
        break;
    }
  }
  probe(inboxID) {
    const s = this.seen.get(inboxID);
    if (!s)
      return "unknown";
    if (s.finished)
      return "settled";
    if (s.running)
      return "running";
    if (s.enqueued || s.delivered)
      return "running";
    return "unknown";
  }
  isBusy(sessionID) {
    const refs = this.runningBySession.get(sessionID);
    if (!refs || refs.size === 0)
      return false;
    const now = Date.now();
    for (const ref of refs.values()) {
      if (now - ref.startedMs < LIVE_WAIT_TTL_MS)
        return true;
    }
    return false;
  }
  forget(inboxID) {
    const slot = this.seen.get(inboxID);
    if (slot?.counted !== undefined && slot.sessionID) {
      this.releaseToken(slot.sessionID, slot.counted);
    }
    this.seen.delete(inboxID);
  }
}
function classify(error) {
  const message = error instanceof Error ? error.message : String(error);
  const status = error;
  const code = status?.status ?? status?.statusCode;
  if (typeof code === "number" && code >= 400 && code < 500 && code !== 408 && code !== 429) {
    return { ok: false, retryable: false, error: message };
  }
  if (typeof code === "number" && code === 404) {
    return { ok: false, retryable: false, error: message };
  }
  return { ok: false, retryable: true, error: message };
}

class SessionTransport {
  observer;
  send;
  fetchState;
  constructor(options) {
    this.observer = options.observer;
    this.send = options.send;
    this.fetchState = options.fetchState;
  }
  async submit(input) {
    try {
      await this.send(input);
      return { ok: true };
    } catch (error) {
      return classify(error);
    }
  }
  liveWait(input) {
    return this.observer.isBusy(input.sessionID);
  }
  async probe(input) {
    const cached = this.observer.probe(input.round.inboxID);
    if (cached === "settled") {
      this.observer.forget(input.round.inboxID);
      return "settled";
    }
    if (!this.fetchState)
      return cached;
    let state;
    try {
      state = await this.fetchState({ sessionID: input.sessionID });
    } catch {
      return cached;
    }
    const queued = state.inbox.some((item) => item.id === input.round.inboxID);
    const isOwn = (message) => message.id === input.round.inboxID || message.metadata?.inboxID === input.round.inboxID || message.metadata?.roundID === input.round.id;
    const index = state.messages.findIndex(isOwn);
    if (index === -1) {
      if (queued)
        return "running";
      return cached === "unknown" ? "unknown" : cached;
    }
    for (let i = index + 1;i < state.messages.length; i++) {
      const message = state.messages[i];
      const foreign = message.type === "user" && message.id !== input.round.inboxID && !isOwn(message);
      if (foreign) {
        return cached === "running" ? "running" : "unknown";
      }
      if (message.type === "idle") {
        this.observer.forget(input.round.inboxID);
        return "settled";
      }
      if (message.type === "assistant" && (message.finish === "stop" || message.finish === "length" || message.finish === "content-filter" || message.finish === "error")) {
        this.observer.forget(input.round.inboxID);
        return "settled";
      }
    }
    return "running";
  }
}

// src/controller/workspace.ts
import { createHash as createHash2 } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
function resolveWorkspacePath(ref, workspace) {
  if (isAbsolute(ref))
    return ref;
  const base = workspace && workspace.length > 0 ? workspace : process.cwd();
  return resolve(base, ref);
}
function sessionWorkspace() {
  return String(process.env.XGOAL_WORKSPACE ?? process.env.PWD ?? "");
}
function hashFile(path) {
  try {
    return createHash2("sha256").update(readFileSync(path)).digest("hex").slice(0, 32);
  } catch {
    return "";
  }
}

// src/controller/verification.ts
class EvidenceLedger {
  store;
  constructor(store) {
    this.store = store;
  }
  capture(input) {
    const args = input.args ?? {};
    const now = Date.now();
    const workspace = input.workspace ?? sessionWorkspace();
    if ((input.tool === "shell" || input.tool === "bash") && input.status === "completed") {
      const command = String(args.command ?? args.cmd ?? "").trim();
      if (!command)
        return;
      const exitCode = extractExitCode(input.result);
      const kind = /\b(test|pytest|bun test|go test|jest|vitest|cargo test)\b/.test(command) ? "test" : "command";
      const evidence = { kind, ref: command.slice(0, 400), exitCode, atMs: now };
      this.store.addEvidence({
        goalID: input.goalID,
        kind,
        ref: evidence.ref,
        detail: exitCode === undefined ? undefined : `exit ${exitCode}`,
        exitCode,
        workspace
      });
      return evidence;
    }
    if (input.status === "completed" && /write|edit|patch|create/.test(input.tool)) {
      const path = String(args.filePath ?? args.file_path ?? args.path ?? "").trim();
      if (!path)
        return;
      const resolved = resolveWorkspacePath(path, workspace);
      const hash = hashFile(resolved);
      const evidence = { kind: "file", ref: path, hash, atMs: now };
      this.store.addEvidence({
        goalID: input.goalID,
        kind: "file",
        ref: path,
        detail: "observed write",
        hash,
        workspace
      });
      return evidence;
    }
    return;
  }
  forGoal(goalID) {
    return this.store.listEvidence(goalID).map((e) => ({
      kind: e.kind,
      ref: e.ref,
      exitCode: e.exitCode,
      hash: e.hash,
      workspace: e.workspace,
      atMs: Date.now(),
      criterionID: e.criterionID
    }));
  }
}
function extractExitCode(result) {
  if (!result)
    return;
  const r = result;
  const asNumber = (value) => {
    if (typeof value === "number" && Number.isFinite(value))
      return value;
    if (typeof value === "string" && /^-?\d+$/.test(value.trim()))
      return Number(value.trim());
    return;
  };
  const metadata = r.metadata ?? {};
  for (const candidate of [
    r.exitCode,
    r.exit_code,
    r.code,
    r.exit,
    r.statusCode,
    metadata.exitCode,
    metadata.exit_code,
    metadata.exit,
    metadata.code
  ]) {
    const n = asNumber(candidate);
    if (n !== undefined)
      return n;
  }
  const content = r.content;
  const text = typeof content === "string" ? content : Array.isArray(content) ? content.map((part) => typeof part === "string" ? part : part?.text ?? "").join(`
`) : typeof r.output === "string" ? r.output : "";
  const match = /\bexit(?:\s+code)?\s*[:=]?\s*(-?\d+)\b/i.exec(text);
  return match ? Number(match[1]) : undefined;
}

class GoalVerifier {
  store;
  validator;
  constructor(store, validator) {
    this.store = store;
    this.validator = validator;
  }
  async verify(goalID) {
    const goal = this.store.byID(goalID);
    if (!goal)
      return { verdict: "incomplete", unmet: [], reason: "unknown goal" };
    const attempt = { generation: goal.generation, version: goal.version };
    const criteria = this.store.listCriteria(goalID);
    const evidence = this.store.listEvidence(goalID);
    const workspace = await this.validator.workspaceFor?.(goal.sessionID) ?? "";
    const unmet = [];
    const proofs = [];
    if (criteria.length === 0) {
      return {
        verdict: "incomplete",
        unmet: ["no acceptance criteria recorded for the objective"],
        reason: "cannot verify completion of an objective with no criteria; the controller must first establish what success means"
      };
    }
    const verifiable = evidence.filter((e) => e.kind !== "ref");
    const hasIndependentProofPath = criteria.some((c) => c.spec?.type === "file" || c.spec?.type === "objective");
    if (verifiable.length === 0 && !hasIndependentProofPath) {
      return {
        verdict: "incomplete",
        unmet: ["no machine-verifiable evidence submitted"],
        reason: "completion requires evidence the controller observed (a command that ran, a file that changed); a model statement is not evidence"
      };
    }
    const invalid = new Set;
    const staleNotes = [];
    const validateItem = async (criterion, item) => {
      const validation = await this.validator.validate({
        kind: item.kind,
        ref: item.ref,
        exitCode: item.exitCode,
        hash: item.hash,
        atMs: Date.now(),
        criterionID: item.criterionID
      }, workspace);
      if (validation.valid)
        return true;
      if (!invalid.has(item.id)) {
        invalid.add(item.id);
        staleNotes.push(`evidence no longer valid: ${item.ref} (${item.id}, ${validation.reason})`);
      }
      return false;
    };
    const validBound = (criterion) => verifiable.filter((e) => e.criterionID === criterion.id && !invalid.has(e.id));
    const objectives = [];
    for (const criterion of criteria) {
      let bound = validBound(criterion);
      const proof = async (validatorID, verdict, detail, evidenceIDs = bound.map((e) => e.id)) => ({ criterionID: criterion.id, evidenceIDs, validatorID, verdict, detail });
      if (criterion.spec?.type === "file") {
        if (!this.validator.checkSpec) {
          for (const item of verifiable.filter((e) => e.criterionID === criterion.id)) {
            await validateItem(criterion, item);
          }
          proofs.push(await proof("spec.file", "unknown", "no filesystem check available for the file requirement", []));
          unmet.push(`criterion unresolved: ${criterion.text} — the file requirement cannot be independently checked in this environment`);
          continue;
        }
        const check = await this.validator.checkSpec(criterion, workspace);
        if (check.valid) {
          proofs.push(await proof("spec.file", "pass", check.reason, []));
          continue;
        }
        for (const item of verifiable.filter((e) => e.criterionID === criterion.id)) {
          await validateItem(criterion, item);
        }
        proofs.push(await proof("spec.file", "fail", check.reason, []));
        unmet.push(`criterion not satisfied: ${criterion.text} (${check.reason})`);
        continue;
      }
      if (criterion.spec?.type === "command" || criterion.spec?.type === "test") {
        const expected = criterion.spec.type === "test" ? 0 : criterion.spec.expectExit ?? 0;
        const required = normalizedCommand(criterion.spec.command);
        for (const item of verifiable.filter((e) => e.criterionID === criterion.id && (e.kind === "command" || e.kind === "test"))) {
          await validateItem(criterion, item);
        }
        bound = validBound(criterion);
        const proofRuns = bound.filter((e) => (e.kind === "command" || e.kind === "test") && e.exitCode === expected && normalizedCommand(e.ref) === required);
        if (proofRuns.length === 0) {
          const ran = bound.filter((e) => e.kind === "command" || e.kind === "test");
          proofs.push(await proof("spec.command", "fail", ran.some((e) => e.exitCode === expected) ? `${ran.length} bound run(s) exited ${expected}, but none was the required command` : `no bound command/test evidence exited ${expected}`));
          unmet.push(`criterion not evidenced: ${criterion.text} (a run of "${criterion.spec.command}" exiting ${expected} was not observed)`);
        } else {
          proofs.push(await proof("spec.command", "pass", `${proofRuns.length} bound run(s) of the required command exited ${expected}`, proofRuns.map((e) => e.id)));
        }
        continue;
      }
      if (criterion.spec?.type === "objective") {
        objectives.push(criterion);
        continue;
      }
      for (const item of verifiable.filter((e) => e.criterionID === criterion.id)) {
        await validateItem(criterion, item);
      }
      bound = validBound(criterion);
      if (bound.length === 0) {
        proofs.push(await proof("bound-evidence", "fail", "no bound, currently-valid evidence"));
        unmet.push(`criterion not evidenced: ${criterion.text}`);
      } else {
        proofs.push(await proof("bound-evidence", "pass", `${bound.length} bound evidence item(s)`));
      }
    }
    let assessment;
    if (objectives.length > 0) {
      const acceptance = this.store.userAcceptance(goal.id);
      const accepted = Boolean(acceptance && acceptance.generation === goal.generation);
      const objectiveIDs = new Set(objectives.map((o) => o.id));
      const concrete = criteria.filter((c) => !objectiveIDs.has(c.id));
      const passing = new Set(proofs.filter((p) => p.verdict === "pass").map((p) => p.criterionID));
      const covered = [];
      const coveringEvidence = [];
      const unresolved = [];
      const coverageGaps = [];
      for (const criterion of concrete) {
        if (!criterion.covers)
          continue;
        if (!criterion.covers.some((id) => objectiveIDs.has(id)))
          continue;
        if (passing.has(criterion.id)) {
          covered.push(criterion.text);
          for (const evidenceID of proofs.find((p) => p.criterionID === criterion.id)?.evidenceIDs ?? []) {
            coveringEvidence.push(evidenceID);
          }
        }
      }
      for (const criterion of concrete) {
        if (!passing.has(criterion.id)) {
          unresolved.push(`${criterion.text}`);
        }
      }
      for (const objective of objectives) {
        const proven = concrete.filter((c) => c.covers?.includes(objective.id) && passing.has(c.id));
        if (proven.length === 0) {
          coverageGaps.push(`no independently proven requirement covers: ${objective.text}`);
        }
      }
      const scope = objectives.map((o) => o.text).join(" | ").slice(0, 400) || goal.objective.slice(0, 400);
      const verdict = concrete.length === 0 ? "indeterminate" : unresolved.length > 0 ? "incomplete" : coverageGaps.length > 0 ? "indeterminate" : "satisfied";
      const allUnresolved = [...unresolved, ...coverageGaps];
      assessment = {
        objectiveRevision: goal.objectiveRevision,
        verdict,
        scope,
        coveredRequirements: covered,
        unresolvedRequirements: allUnresolved,
        evidenceIDs: [...new Set(coveringEvidence)],
        note: verdict === "indeterminate" ? "no confirmed requirement was established; an open-ended objective cannot be declared satisfied without a bounded final review" : verdict === "satisfied" && accepted ? acceptance?.note ? `user accepted the objective: ${acceptance.note}` : "user accepted the objective" : undefined
      };
      for (const objective of objectives) {
        if (accepted) {
          proofs.push({
            criterionID: objective.id,
            evidenceIDs: [],
            validatorID: "user-acceptance",
            verdict: "pass",
            detail: acceptance?.note ? `user accepted the objective: ${acceptance.note}` : "user accepted the objective"
          });
          continue;
        }
        if (goal.completionPolicy === "audited" && verdict === "satisfied") {
          const proven = concrete.filter((c) => c.covers?.includes(objective.id) && passing.has(c.id));
          proofs.push({
            criterionID: objective.id,
            evidenceIDs: [...new Set(proven.flatMap((c) => proofs.find((p) => p.criterionID === c.id)?.evidenceIDs ?? []))],
            validatorID: "objective-audit",
            verdict: "pass",
            detail: `audited scope satisfied: ${proven.map((c) => c.text).join("; ").slice(0, 300)}`
          });
          continue;
        }
        if (goal.completionPolicy === "audited" && verdict === "indeterminate") {
          proofs.push({
            criterionID: objective.id,
            evidenceIDs: [],
            validatorID: "objective-audit",
            verdict: "unknown",
            detail: "indeterminate: no confirmed requirement bounded the objective's scope"
          });
          unmet.push(`criterion indeterminate: ${objective.text} — register at least one concrete requirement with covers=<objective criterion id>, prove it, and propose completion again`);
          continue;
        }
        proofs.push({
          criterionID: objective.id,
          evidenceIDs: [],
          validatorID: "objective-acceptance",
          verdict: "unknown",
          detail: goal.completionPolicy === "audited" ? "audit incomplete: a known requirement or objective remainder is unresolved" : "broad objective; cannot establish completeness from ordinary evidence — needs concrete sub-criteria or explicit user acceptance"
        });
        if (goal.completionPolicy === "audited") {
          unmet.push(...allUnresolved.map((r) => r.startsWith("no independently proven requirement covers: ") ? `criterion uncovered: ${r.replace("no independently proven requirement covers: ", "")} — register a concrete requirement with covers=<objective criterion id> and prove it` : `criterion unresolved: ${r} — prove it (bound evidence or a machine spec) before completion`));
        } else {
          unmet.push(`criterion unresolved: ${objective.text} — register concrete machine-checkable criteria with goal_add_criterion, or ask the user to run /goal accept`);
        }
      }
    }
    const staleEvidence = staleNotes;
    if (unmet.length > 0) {
      unmet.push(...staleEvidence);
    }
    const snapshot = snapshotHash(criteria, evidence);
    const recorded = this.store.recordProofs(goalID, proofs, snapshot, attempt, assessment);
    if (!recorded) {
      return {
        verdict: "incomplete",
        unmet: [
          ...unmet,
          "verification discarded: the goal changed state while validation was running"
        ],
        reason: "the goal was replaced or transitioned during verification; the proofs described a superseded goal",
        proofs,
        snapshot,
        staleEvidence: staleEvidence.length > 0 ? staleEvidence : undefined
      };
    }
    if (unmet.length > 0) {
      return {
        verdict: "incomplete",
        unmet,
        reason: `${unmet.length} condition(s) unsatisfied against current evidence`,
        proofs,
        snapshot,
        staleEvidence: staleEvidence.length > 0 ? staleEvidence : undefined
      };
    }
    return {
      verdict: "complete",
      unmet: [],
      reason: verifiable.length === 0 ? `objective satisfied: ${criteria.length} criteria established by independent checks and user acceptance` : `objective satisfied: ${criteria.length} criteria covered by ${verifiable.length} validated evidence item(s)`,
      proofs,
      snapshot,
      staleEvidence: staleEvidence.length > 0 ? staleEvidence : undefined
    };
  }
}

// src/rpc.ts
var RPC_ID = "local.opencode-xgoal";
var str = { type: "string" };
var num = { type: "number" };
function criterionWire(row) {
  return {
    id: row.id,
    text: row.text,
    met: row.met,
    spec: row.spec ?? null,
    source: row.source,
    covers: row.covers ?? null
  };
}
function wire(controller, goal) {
  if (!goal)
    return null;
  return {
    id: goal.id,
    generation: goal.generation,
    objective: goal.objective,
    status: goal.status,
    reason: goal.reason ?? null,
    rounds: goal.rounds,
    noProgressRounds: goal.noProgressRounds,
    tokensUsed: goal.tokensUsed ?? null,
    tokenBudget: goal.tokenBudget ?? null,
    criteria: controller.store.listCriteria(goal.id).map(criterionWire)
  };
}
var goalOrNull = {
  anyOf: [{ type: "object" }, { type: "null" }]
};
var goalRpcDefinition = {
  id: RPC_ID,
  methods: {
    "goal.status": {
      input: { type: "object", properties: { sessionID: str }, required: ["sessionID"] },
      output: {
        type: "object",
        properties: { current: goalOrNull, latest: goalOrNull, goal: goalOrNull }
      }
    },
    "goal.history": {
      input: { type: "object", properties: { sessionID: str }, required: ["sessionID"] },
      output: {
        type: "object",
        properties: { goals: { type: "array", items: { type: "object" } } }
      }
    },
    "goal.create": {
      input: {
        type: "object",
        properties: { sessionID: str, objective: str },
        required: ["sessionID", "objective"]
      },
      output: { type: "object", properties: { goal: goalOrNull, error: str, drive: { type: "object" } } }
    },
    "goal.replace": {
      input: {
        type: "object",
        properties: {
          sessionID: str,
          objective: str,
          expectedGeneration: num
        },
        required: ["sessionID", "objective", "expectedGeneration"]
      },
      output: { type: "object", properties: { goal: goalOrNull, error: str } }
    },
    "goal.pause": {
      input: { type: "object", properties: { sessionID: str }, required: ["sessionID"] },
      output: { type: "object", properties: { goal: goalOrNull } }
    },
    "goal.resume": {
      input: { type: "object", properties: { sessionID: str }, required: ["sessionID"] },
      output: { type: "object", properties: { goal: goalOrNull, error: str } }
    },
    "goal.accept": {
      input: {
        type: "object",
        properties: { sessionID: str, note: str },
        required: ["sessionID"]
      },
      output: { type: "object", properties: { goal: goalOrNull, error: str } }
    },
    "goal.health": {
      input: { type: "object", properties: { sessionID: str }, required: ["sessionID"] },
      output: { type: "object", properties: { health: { type: "object" } } }
    },
    "goal.budget": {
      input: {
        type: "object",
        properties: { sessionID: str, budget: num },
        required: ["sessionID"]
      },
      output: { type: "object", properties: { goal: goalOrNull, error: str } }
    }
  },
  events: {
    "goal.changed": {
      schema: {
        type: "object",
        properties: { sessionID: str, status: str, generation: num }
      }
    }
  }
};
function goalRpcHandlers(controller, coordinator, verifier) {
  return {
    "goal.status": async (input) => {
      if (!input?.sessionID)
        return { current: null, latest: null, goal: null };
      const latest = wire(controller, controller.latest(input.sessionID));
      const current = wire(controller, controller.status(input.sessionID));
      return { current, latest, goal: latest };
    },
    "goal.history": async (input) => {
      if (!input?.sessionID)
        return { goals: [] };
      return {
        goals: controller.history(input.sessionID).map((g) => wire(controller, g)).filter(Boolean)
      };
    },
    "goal.create": async (input) => {
      const { sessionID, objective } = input ?? {};
      if (!sessionID || !objective) {
        return { goal: null, error: "sessionID and objective are required" };
      }
      try {
        if (coordinator) {
          const result = await coordinator.start(sessionID, objective);
          const goal = result.created ?? result.existing;
          if (result.existing) {
            return {
              goal: wire(controller, result.existing),
              error: `a goal is already active (generation ${result.existing.generation}); replace it explicitly`
            };
          }
          return { goal: wire(controller, goal), drive: result.drive ?? null };
        }
        const out = controller.startOrDescribe(sessionID, objective);
        return { goal: wire(controller, "created" in out ? out.created : out.existing) };
      } catch (error) {
        return { goal: null, error: String(error) };
      }
    },
    "goal.replace": async (input) => {
      const { sessionID, objective, expectedGeneration } = input ?? {};
      if (!sessionID || !objective || typeof expectedGeneration !== "number") {
        return { goal: null, error: "sessionID, objective and expectedGeneration are required" };
      }
      try {
        if (coordinator) {
          const result = await coordinator.replace(sessionID, objective, expectedGeneration);
          return { goal: wire(controller, result.goal), drive: result.drive ?? null };
        }
        const goal = controller.replace(sessionID, objective, expectedGeneration);
        return { goal: wire(controller, goal) };
      } catch (error) {
        return { goal: null, error: String(error) };
      }
    },
    "goal.pause": async (input) => {
      if (!input?.sessionID)
        return { goal: null };
      try {
        return { goal: wire(controller, controller.pause(input.sessionID)) };
      } catch (error) {
        return { goal: null, error: String(error) };
      }
    },
    "goal.resume": async (input) => {
      if (!input?.sessionID)
        return { goal: null };
      try {
        if (coordinator) {
          const result = await coordinator.resume(input.sessionID);
          return { goal: wire(controller, result.goal), drive: result.drive ?? null };
        }
        return { goal: wire(controller, controller.resume(input.sessionID)) };
      } catch (error) {
        return { goal: null, error: String(error) };
      }
    },
    "goal.accept": async (input) => {
      if (!input?.sessionID)
        return { goal: null, error: "sessionID is required" };
      try {
        const accepted = controller.acceptObjective(input.sessionID, input.note);
        if (accepted.status === "verifying" && verifier) {
          const result = await verifier.verify(accepted.id);
          if (result.verdict === "complete") {
            const done = controller.commitComplete(accepted.id, accepted.generation, result.reason, result.snapshot);
            return { goal: wire(controller, done) };
          }
          controller.rejectCompletion(accepted.id, accepted.generation, result.reason);
          return {
            goal: wire(controller, controller.status(input.sessionID)),
            error: `acceptance recorded, but completion is still unmet: ${result.unmet.join("; ")}`
          };
        }
        return { goal: wire(controller, accepted) };
      } catch (error) {
        return { goal: null, error: String(error) };
      }
    },
    "goal.health": async (input) => {
      if (!input?.sessionID)
        return { health: { ok: false, error: "sessionID is required" } };
      try {
        return { health: controller.health(input.sessionID) };
      } catch (error) {
        return { health: { ok: false, error: String(error) } };
      }
    },
    "goal.budget": async (input) => {
      if (!input?.sessionID)
        return { goal: null, error: "sessionID is required" };
      try {
        const budget = typeof input.budget === "number" && Number.isFinite(input.budget) && input.budget > 0 ? Math.floor(input.budget) : undefined;
        return { goal: wire(controller, controller.setBudget(input.sessionID, budget)) };
      } catch (error) {
        return { goal: null, error: String(error) };
      }
    }
  };
}

// src/index.ts
var LOG = process.env.XGOAL_HARNESS_LOG ?? "";
function describeDrive(outcome) {
  if (!outcome)
    return "dispatch unavailable (no driver connected)";
  switch (outcome.action) {
    case "admitted":
      return `execution scheduled (${outcome.inboxID}).`;
    case "reconcile":
      return `an outstanding round is still ${outcome.status}.`;
    case "unknown":
      return "dispatch outcome unknown; the recovery sweep will reconcile it.";
    case "failed":
      return `dispatch failed: ${outcome.detail}.`;
    case "abandoned":
      return `dispatch abandoned: ${outcome.detail}.`;
    case "limited":
      return `not dispatched: goal is ${outcome.status}.`;
    case "idle":
      return `not dispatched: ${outcome.reason}.`;
    default:
      return `dispatch: ${String(outcome.action)}.`;
  }
}
function record(entry) {
  if (!LOG)
    return;
  try {
    mkdirSync(dirname(LOG), { recursive: true });
    appendFileSync(LOG, JSON.stringify({ ts: Date.now(), ...entry }) + `
`);
  } catch {}
}
function dbPath() {
  if (process.env.XGOAL_DB)
    return process.env.XGOAL_DB;
  const dataHome = process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
  return join(dataHome, "opencode-xgoal", "goals.db");
}
function sessionIDOf(event) {
  const e = event;
  return e?.data?.sessionID ?? e?.properties?.sessionID ?? e?.sessionID;
}
function obj(properties, required = []) {
  return { type: "object", properties, required, additionalProperties: false };
}
var str2 = { type: "string" };
var strArray = { type: "array", items: { type: "string" } };
var num2 = { type: "number" };
var src_default = {
  id: "opencode-xgoal",
  async setup(ctx) {
    const abort = new AbortController;
    let controller;
    let startupError;
    try {
      mkdirSync(dirname(dbPath()), { recursive: true });
      controller = new GoalController({ dbPath: dbPath() });
      const repaired = controller.reconcileStartup();
      record({ event: "controller.ready", dbPath: dbPath(), reconciled: repaired.length });
    } catch (error) {
      startupError = String(error);
      record({ event: "controller.failed", error: startupError });
    }
    const observer = new RoundObserver;
    let driver;
    let coordinator;
    let ledger;
    let verifier;
    let sweep;
    const sessionWorkspaces = new Map;
    const resolveSessionWorkspace = async (sessionID) => {
      if (sessionID) {
        const cached = sessionWorkspaces.get(sessionID);
        if (cached)
          return cached;
      }
      if (sessionID) {
        try {
          const session = await ctx.session.get({ sessionID });
          const directory = session?.location?.directory;
          if (typeof directory === "string" && directory.length > 0) {
            sessionWorkspaces.set(sessionID, directory);
            return directory;
          }
        } catch {}
      }
      return sessionWorkspace();
    };
    if (controller) {
      const transport = new SessionTransport({
        observer,
        send: async ({ sessionID, inboxID, text, metadata }) => {
          await ctx.session.synthetic({
            sessionID,
            id: inboxID,
            text,
            metadata,
            delivery: "queue"
          });
        },
        fetchState: async ({ sessionID }) => {
          const messages = await ctx.session.context({ sessionID });
          let inbox = [];
          try {
            const api = ctx.session?.inbox;
            if (typeof api?.list === "function") {
              inbox = await api.list({ sessionID });
            }
          } catch {}
          return {
            inbox: (inbox ?? []).map((item) => ({ id: item.id })),
            messages: messages.map((message) => ({
              id: message.id,
              type: message.type,
              metadata: message.metadata,
              time: message.time,
              finish: message.finish
            }))
          };
        }
      });
      driver = new GoalDriver(controller.store, transport);
      coordinator = new GoalCoordinator(controller, () => driver, {
        onDriveError: (sessionID, error) => record({ event: "coordinator.drive.error", sessionID, error: String(error) })
      });
      ledger = new EvidenceLedger(controller.store);
      verifier = new GoalVerifier(controller.store, {
        async workspaceFor(sessionID) {
          return resolveSessionWorkspace(sessionID);
        },
        async validate(evidence, workspace) {
          if (evidence.kind === "file") {
            const resolved = resolveWorkspacePath(evidence.ref, workspace);
            try {
              if (!existsSync(resolved)) {
                return { valid: false, reason: `file not found: ${evidence.ref}` };
              }
              if (evidence.hash !== undefined) {
                const actual = hashFile(resolved);
                if (actual !== evidence.hash) {
                  return {
                    valid: false,
                    reason: `file changed since it was observed: ${evidence.ref}`
                  };
                }
              }
              return { valid: true, reason: "file present and unchanged" };
            } catch {
              return { valid: false, reason: "file could not be checked" };
            }
          }
          if (evidence.kind === "command" || evidence.kind === "test" || evidence.kind === "runtime") {
            if (evidence.exitCode === undefined) {
              return {
                valid: false,
                reason: "no observed exit status recorded; cannot confirm success"
              };
            }
            return evidence.exitCode === 0 ? { valid: true, reason: `exited ${evidence.exitCode}` } : { valid: false, reason: `exited ${evidence.exitCode}` };
          }
          return { valid: false, reason: "unverifiable reference" };
        },
        async checkSpec(criterion, workspace) {
          if (criterion.spec?.type !== "file") {
            return { valid: false, reason: "no independent check for this spec" };
          }
          const spec = criterion.spec;
          const resolved = resolveWorkspacePath(spec.path, workspace);
          try {
            if (!existsSync(resolved)) {
              return { valid: false, reason: `file not found: ${spec.path}` };
            }
            if (spec.equals !== undefined || spec.contains !== undefined) {
              const content = readFileSync2(resolved, "utf8");
              if (spec.equals !== undefined && content !== spec.equals) {
                return {
                  valid: false,
                  reason: `${spec.path} does not exactly match the required content`
                };
              }
              if (spec.contains !== undefined && !content.includes(spec.contains)) {
                return {
                  valid: false,
                  reason: `${spec.path} does not contain ${JSON.stringify(spec.contains)}`
                };
              }
            }
            return { valid: true, reason: `${spec.path} matches the required content` };
          } catch (error) {
            return { valid: false, reason: `file could not be checked: ${String(error)}` };
          }
        }
      });
      const driveAll = async () => {
        const goals = controller?.store.activeGoals() ?? [];
        const outcomes = [];
        for (const goal of goals) {
          if (goal.status !== "active")
            continue;
          try {
            const outcome = await driver.drive(goal.sessionID);
            outcomes.push(`${goal.id}:${outcome.action}`);
          } catch (error) {
            record({
              event: "driver.drive.error",
              goalID: goal.id,
              error: String(error)
            });
          }
        }
        return outcomes;
      };
      driver.reconcile().then(async (outcomes) => {
        record({ event: "driver.reconciled", count: outcomes.length });
        const driven = await driveAll();
        record({ event: "driver.resumed", outcomes: driven });
      }).catch((error) => record({ event: "driver.reconcile.error", error: String(error) }));
      const sweepMs = Number(process.env.XGOAL_SWEEP_MS ?? "20000");
      sweep = setInterval(() => {
        driver?.reconcile().then(() => driveAll()).catch((error) => record({ event: "driver.sweep.error", error: String(error) }));
      }, sweepMs);
      sweep?.unref?.();
    }
    record({
      event: "setup.begin",
      pluginId: "opencode-xgoal",
      domains: Object.keys(ctx ?? {}).sort(),
      sessionMethods: typeof ctx?.session === "object" ? Object.keys(ctx.session).sort() : [],
      controllerReady: controller !== undefined
    });
    async function resolveMessageRef(sessionID, messageID) {
      if (!controller || !sessionID || !messageID)
        return {};
      const store = controller.store;
      const cached = store.resolveMessageGeneration(sessionID, messageID);
      if (cached !== undefined) {
        const goal2 = store.byGeneration(sessionID, cached);
        return goal2 ? { goalID: goal2.id, generation: cached } : {};
      }
      let messages = [];
      try {
        messages = await ctx.session.context({ sessionID });
      } catch (error) {
        record({ event: "call.resolve.error", sessionID, messageID, error: String(error) });
      }
      const list = messages;
      const generationOf = (message) => {
        const id = message.id;
        if (!id)
          return;
        const mapped = store.resolveMessageGeneration(sessionID, id);
        if (mapped !== undefined)
          return mapped;
        return store.roundByInboxID(id)?.generation;
      };
      let generation = attributeMessageGeneration(list.map((m) => ({ id: m.id ?? "", type: m.type, metadata: m.metadata })), messageID, generationOf);
      if (generation !== undefined) {
        store.rememberMessageGeneration(sessionID, messageID, generation, Date.now());
        const goal2 = store.byGeneration(sessionID, generation);
        return goal2 ? { goalID: goal2.id, generation } : {};
      }
      if (store.generationCount(sessionID) !== 1)
        return {};
      const self = list.find((m) => m.id === messageID);
      const atMs = typeof self?.time?.created === "number" ? self.time.created : undefined;
      if (atMs === undefined)
        return {};
      generation = store.generationAt(sessionID, atMs);
      if (generation === undefined)
        return {};
      store.rememberMessageGeneration(sessionID, messageID, generation, atMs);
      const goal = store.byGeneration(sessionID, generation);
      return goal ? { goalID: goal.id, generation } : {};
    }
    try {
      await ctx.tool.transform((editor) => {
        editor.add({
          name: "goal_get",
          description: "Report the current goal for this session, including status, generation, round counts and unmet criteria.",
          input: obj({}),
          async execute(_input, toolCtx) {
            if (!controller)
              return { content: `goal controller unavailable: ${startupError}` };
            const goal = controller.get(toolCtx?.sessionID);
            if (!goal)
              return { content: "No active goal for this session." };
            const criteria = controller.store.listCriteria(goal.id);
            const evidence = controller.store.listEvidence(goal.id).map((item) => ({
              id: item.id,
              kind: item.kind,
              ref: item.ref,
              exitCode: item.exitCode ?? null,
              hash: item.hash ?? null,
              criterionID: item.criterionID ?? null
            }));
            return {
              content: JSON.stringify({
                id: goal.id,
                generation: goal.generation,
                objective: goal.objective,
                status: goal.status,
                rounds: goal.rounds,
                noProgressRounds: goal.noProgressRounds,
                tokensUsed: goal.tokensUsed ?? null,
                tokenBudget: goal.tokenBudget ?? null,
                criteria,
                evidence
              }, null, 2),
              metadata: { goalID: goal.id, generation: goal.generation, status: goal.status }
            };
          }
        });
        editor.add({
          name: "goal_checkpoint",
          description: "Record progress toward the current goal without changing its status. Use for completed work, or for investigation that materially narrows the problem. Optionally bind evidence to a criterion.",
          input: obj({
            summary: str2,
            evidence_refs: strArray,
            criterion_id: str2,
            goal_id: str2,
            generation: num2
          }, ["summary"]),
          async execute(input, toolCtx) {
            if (!controller)
              return { content: `goal controller unavailable: ${startupError}` };
            const ref = await resolveMessageRef(toolCtx?.sessionID, toolCtx?.messageID);
            const target = selectToolRef(ref, input, toolCtx?.messageID);
            if (!target.ok)
              return { content: `Goal call rejected: ${target.reason}` };
            const out = controller.checkpoint(toolCtx?.sessionID, {
              summary: String(input?.summary ?? ""),
              evidenceRefs: input?.evidence_refs,
              criterionID: input?.criterion_id,
              goalID: target.ref.goalID,
              generation: target.ref.generation
            });
            if (!out.recorded)
              return { content: `Checkpoint not recorded: ${out.rejected}` };
            return {
              content: `Checkpoint recorded. Goal is ${out.goal?.status}.`,
              metadata: { status: out.goal?.status, rounds: out.goal?.rounds }
            };
          }
        });
        editor.add({
          name: "goal_add_criterion",
          description: "Refine the acceptance criteria during investigation: register a concrete, machine-checkable requirement the work must satisfy. Additive and idempotent — adding a requirement that already exists returns the existing criterion. Objective-type specs are refused: only the user can accept the objective itself.",
          input: obj({
            text: str2,
            spec: {
              type: "object",
              properties: {
                type: {
                  type: "string",
                  enum: ["file", "command", "test", "manual"]
                },
                path: { type: "string" },
                equals: { type: "string" },
                contains: { type: "string" },
                command: { type: "string" },
                expectExit: num2
              },
              additionalProperties: false
            },
            covers: {
              type: "array",
              items: { type: "string" },
              description: "Objective-level criterion IDs this concrete requirement was registered to satisfy. Only proven concrete requirements discharge an objective-level remainder under the audited completion policy."
            },
            goal_id: str2,
            generation: num2
          }, ["text"]),
          async execute(input, toolCtx) {
            if (!controller)
              return { content: `goal controller unavailable: ${startupError}` };
            const ref = await resolveMessageRef(toolCtx?.sessionID, toolCtx?.messageID);
            const target = selectToolRef(ref, input, toolCtx?.messageID);
            if (!target.ok)
              return { content: `Goal call rejected: ${target.reason}` };
            const rawSpec = input?.spec;
            let spec;
            if (rawSpec && typeof rawSpec === "object") {
              const parsed = { ...rawSpec };
              if (parsed.type === "file" && typeof parsed.path !== "string") {
                return { content: "Criterion rejected: a file spec requires path." };
              }
              if ((parsed.type === "command" || parsed.type === "test") && typeof parsed.command !== "string") {
                return { content: "Criterion rejected: a command/test spec requires command." };
              }
              spec = parsed;
            }
            const out = controller.addCriterion(toolCtx?.sessionID, {
              text: String(input?.text ?? ""),
              spec,
              covers: Array.isArray(input?.covers) ? input.covers.map((v) => String(v)) : undefined,
              goalID: target.ref.goalID,
              generation: target.ref.generation
            });
            if (out.rejected)
              return { content: `Criterion rejected: ${out.rejected}` };
            return {
              content: `Criterion registered: ${out.criterionID}`,
              metadata: { criterionID: out.criterionID }
            };
          }
        });
        editor.add({
          name: "goal_supersede_criterion",
          description: "Retire a model-added criterion that investigation proved wrong; it no longer gates verification. Requirements that came from the user's objective cannot be retired — you may propose a replacement only when it provably preserves the original obligation (e.g. a stricter content requirement on the same file path); otherwise ask the user to run /goal replace.",
          input: obj({
            criterion_id: str2,
            reason: str2,
            replacement: {
              type: "object",
              properties: {
                text: { type: "string" },
                spec: {
                  type: "object",
                  properties: {
                    type: {
                      type: "string",
                      enum: ["file", "command", "test", "manual"]
                    },
                    path: { type: "string" },
                    equals: { type: "string" },
                    contains: { type: "string" },
                    command: { type: "string" },
                    expectExit: num2
                  },
                  additionalProperties: false
                }
              },
              required: ["text"],
              additionalProperties: false
            },
            goal_id: str2,
            generation: num2
          }, ["criterion_id", "reason"]),
          async execute(input, toolCtx) {
            if (!controller)
              return { content: `goal controller unavailable: ${startupError}` };
            const ref = await resolveMessageRef(toolCtx?.sessionID, toolCtx?.messageID);
            const target = selectToolRef(ref, input, toolCtx?.messageID);
            if (!target.ok)
              return { content: `Goal call rejected: ${target.reason}` };
            let replacement;
            if (input?.replacement && typeof input.replacement === "object") {
              replacement = { text: String(input.replacement.text ?? "") };
              const rawSpec = input.replacement.spec;
              if (rawSpec && typeof rawSpec === "object") {
                const parsed = { ...rawSpec };
                if (parsed.type === "file" && typeof parsed.path !== "string") {
                  return { content: "Replacement rejected: a file spec requires path." };
                }
                if ((parsed.type === "command" || parsed.type === "test") && typeof parsed.command !== "string") {
                  return { content: "Replacement rejected: a command/test spec requires command." };
                }
                replacement.spec = parsed;
              }
            }
            const out = controller.supersedeCriterion(toolCtx?.sessionID, {
              criterion_id: String(input?.criterion_id ?? ""),
              reason: String(input?.reason ?? ""),
              replacement,
              goalID: target.ref.goalID,
              generation: target.ref.generation
            });
            if (out.rejected)
              return { content: `Supersede rejected: ${out.rejected}` };
            return { content: "Criterion superseded; it no longer gates verification." };
          }
        });
        editor.add({
          name: "goal_propose_complete",
          description: "Propose that the goal's original objective has been fully achieved. This moves the goal to verification; it does not complete it. The controller decides completion. File criteria with a machine-checkable spec are re-checked independently; other criteria require explicitly bound evidence. Call goal_get first and pass criteria: [{criterion_id, evidence_refs}], where evidence_refs are evidence IDs or refs from goal_get.",
          input: obj({
            summary: str2,
            evidence_refs: strArray,
            criteria: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  criterion_id: { type: "string" },
                  evidence_refs: { type: "array", items: { type: "string" } }
                },
                required: ["criterion_id"],
                additionalProperties: false
              }
            },
            goal_id: str2,
            generation: num2
          }, ["summary"]),
          async execute(input, toolCtx) {
            if (!controller)
              return { content: `goal controller unavailable: ${startupError}` };
            const sessionID = toolCtx?.sessionID;
            const ref = await resolveMessageRef(sessionID, toolCtx?.messageID);
            const target = selectToolRef(ref, input, toolCtx?.messageID);
            if (!target.ok)
              return { content: `Goal call rejected: ${target.reason}` };
            const out = controller.proposeComplete(sessionID, {
              summary: String(input?.summary ?? ""),
              evidenceRefs: input?.evidence_refs,
              criteria: Array.isArray(input?.criteria) ? input.criteria.map((c) => ({
                criterionID: String(c?.criterion_id ?? ""),
                evidenceRefs: Array.isArray(c?.evidence_refs) ? c.evidence_refs : []
              })) : undefined,
              goalID: target.ref.goalID,
              generation: target.ref.generation
            });
            if (out.rejected)
              return { content: `Completion proposal rejected: ${out.rejected}` };
            const goal = controller.status(sessionID);
            if (!goal || !verifier) {
              return {
                content: "Completion proposed and pending verification.",
                metadata: { status: goal?.status }
              };
            }
            const result = await verifier.verify(goal.id);
            if (result.verdict === "complete") {
              const done = controller.commitComplete(goal.id, goal.generation, result.reason, result.snapshot);
              record({ event: "completion.verified", goalID: goal.id, reason: result.reason });
              return {
                content: `Completion verified and the goal is now complete. ${result.reason}`,
                metadata: { status: done.status }
              };
            }
            const back = controller.rejectCompletion(goal.id, goal.generation, result.reason);
            record({
              event: "completion.rejected",
              goalID: goal.id,
              unmet: result.unmet,
              reason: result.reason
            });
            return {
              content: [
                "Completion NOT verified. The goal remains active.",
                `Reason: ${result.reason}`,
                result.unmet.length ? `Unsatisfied conditions:
${result.unmet.map((u) => `- ${u}`).join(`
`)}` : "",
                "Address these and continue working."
              ].filter(Boolean).join(`
`),
              metadata: { status: back?.status, unmet: result.unmet }
            };
          }
        });
        editor.add({
          name: "goal_report_blocked",
          description: "Report that the goal cannot proceed. Only use this for a genuine external dependency: missing credentials, permissions, or required information. A workflow preference, an optional decision, or a choice between reasonable next steps is NOT a blocker — continue working instead.",
          input: obj({
            reason: str2,
            evidence_refs: strArray,
            external_dependency: { type: "boolean" },
            goal_id: str2,
            generation: num2
          }, ["reason"]),
          async execute(input, toolCtx) {
            if (!controller)
              return { content: `goal controller unavailable: ${startupError}` };
            const ref = await resolveMessageRef(toolCtx?.sessionID, toolCtx?.messageID);
            const target = selectToolRef(ref, input, toolCtx?.messageID);
            if (!target.ok)
              return { content: `Goal call rejected: ${target.reason}` };
            const out = controller.reportBlocked(toolCtx?.sessionID, {
              reason: String(input?.reason ?? ""),
              evidenceRefs: input?.evidence_refs,
              externalDependency: input?.external_dependency === true,
              goalID: target.ref.goalID,
              generation: target.ref.generation
            });
            if (out.rejected)
              return { content: `Blocker report rejected: ${out.rejected}` };
            if (!out.accepted) {
              return {
                content: "Blocker not accepted: no concrete external dependency was identified. The goal remains active — take the next useful action.",
                metadata: { confirmations: out.confirmations, status: out.goal?.status }
              };
            }
            return {
              content: "Blocker accepted. The goal is now blocked pending user action.",
              metadata: { status: out.goal?.status }
            };
          }
        });
      });
      record({ event: "tools.registered", ok: true });
    } catch (error) {
      record({ event: "tools.registered", ok: false, error: String(error) });
    }
    try {
      if (controller && ctx.rpc?.register) {
        await ctx.rpc.register(goalRpcDefinition, goalRpcHandlers(controller, coordinator, verifier));
        record({ event: "rpc.registered", ok: true });
      } else {
        record({ event: "rpc.registered", ok: false, reason: "rpc domain unavailable" });
      }
    } catch (error) {
      record({ event: "rpc.registered", ok: false, error: String(error) });
    }
    try {
      await ctx.command.transform((editor) => {
        editor.add({
          name: "goal",
          description: "Set, replace, inspect or control the session goal",
          async execute(invocation) {
            const sessionID = invocation?.sessionID;
            const raw = String(invocation?.prompt?.text ?? "").trim();
            if (!controller)
              return;
            const [verb, ...rest] = raw.split(/\s+/);
            const arg = rest.join(" ").trim();
            const reply = (text) => record({ event: "command.reply", sessionID, text: text.slice(0, 200) });
            try {
              if (!verb) {
                const goal = controller.status(sessionID);
                reply(goal ? `Goal ${goal.generation}: [${goal.status}] ${goal.objective} (rounds ${goal.rounds})` : "No active goal. Use /goal <objective>.");
                return;
              }
              if (verb === "status") {
                const goal = controller.status(sessionID);
                reply(goal ? `[${goal.status}] ${goal.objective}` : "No active goal.");
                return;
              }
              if (verb === "history") {
                const history = controller.history(sessionID);
                reply(history.length ? history.map((g) => `gen ${g.generation} [${g.status}] ${g.objective}`).join(`
`) : "No goal history.");
                return;
              }
              if (verb === "pause") {
                reply(`Paused: ${(coordinator ?? controller).pause(sessionID).status}`);
                return;
              }
              if (verb === "resume") {
                if (coordinator) {
                  const result = await coordinator.resume(sessionID);
                  reply(`Resumed: ${result.goal.status}. ${describeDrive(result.drive)}`);
                } else {
                  reply(`Resumed: ${controller.resume(sessionID).status}`);
                }
                return;
              }
              if (verb === "accept") {
                const accepted = controller.acceptObjective(sessionID, arg || undefined);
                if (accepted.status === "verifying" && verifier) {
                  const result = await verifier.verify(accepted.id);
                  if (result.verdict === "complete") {
                    const done = controller.commitComplete(accepted.id, accepted.generation, result.reason, result.snapshot);
                    record({ event: "completion.verified", goalID: accepted.id, reason: result.reason });
                    return reply(`Acceptance recorded. Completion verified: ${done.status}`);
                  }
                  controller.rejectCompletion(accepted.id, accepted.generation, result.reason);
                  return reply(`Acceptance recorded, but completion is still unmet: ${result.unmet.join("; ")}`);
                }
                reply("Acceptance recorded for the current generation.");
                return;
              }
              if (verb === "replace") {
                if (!arg)
                  return reply("Usage: /goal replace <objective>");
                const result = coordinator ? await coordinator.replace(sessionID, arg) : { goal: controller.replace(sessionID, arg) };
                reply(`Replaced. Generation ${result.goal.generation} is now active. ${describeDrive(result.drive)}`);
                return;
              }
              if (verb === "budget") {
                const goal = controller.status(sessionID);
                if (!goal)
                  return reply("No active goal.");
                const used = goal.tokensUsed ?? 0;
                if (!arg) {
                  reply(`Tokens: ${used}${goal.tokenBudget !== undefined ? ` / ${goal.tokenBudget}` : " (no budget set)"}`);
                  return;
                }
                if (/^(off|none|clear)$/i.test(arg)) {
                  controller.setBudget(sessionID, undefined);
                  return reply("Token budget cleared.");
                }
                const n = Number(arg);
                if (!Number.isFinite(n) || n <= 0)
                  return reply("Usage: /goal budget <positive number>");
                controller.setBudget(sessionID, Math.floor(n));
                reply(`Budget set to ${Math.floor(n)} tokens (used ${used}).`);
                return;
              }
              const objective = raw;
              if (coordinator) {
                const result = await coordinator.start(sessionID, objective);
                if (result.existing) {
                  reply(`A goal is already active (generation ${result.existing.generation}): ${result.existing.objective}
Use /goal replace <objective> to supersede it.`);
                } else {
                  reply(`Goal created (generation ${result.created.generation}). ${describeDrive(result.drive)}`);
                }
                return;
              }
              const out = controller.startOrDescribe(sessionID, objective);
              if ("existing" in out) {
                reply(`A goal is already active (generation ${out.existing.generation}): ${out.existing.objective}
Use /goal replace <objective> to supersede it.`);
              } else {
                reply(`Goal created (generation ${out.created.generation}); no driver is connected.`);
              }
            } catch (error) {
              reply(`Goal command failed: ${String(error)}`);
            }
          }
        });
      });
      record({ event: "command.registered", ok: true });
    } catch (error) {
      record({ event: "command.registered", ok: false, error: String(error) });
    }
    try {
      await ctx.session.hook("context", async (event) => {
        if (!controller)
          return;
        const goal = controller.status(event?.sessionID);
        record({
          event: "session.context",
          sessionID: event?.sessionID,
          agent: event?.agent,
          hasGoal: Boolean(goal),
          status: goal?.status
        });
        if (!goal || goal.status !== "active")
          return;
        if (!Array.isArray(event?.system))
          return;
        const unmet = controller.store.listCriteria(goal.id).filter((c) => !c.met).map((c) => `- ${c.text}`);
        event.system.push({
          type: "text",
          text: [
            `Active goal (generation ${goal.generation}): ${goal.objective}`,
            "",
            "Completion contract:",
            "- The original objective is authoritative.",
            "- Inspect current evidence before claiming success.",
            "- If unfinished, take the next useful action.",
            "- A workflow preference or optional choice is not a blocker.",
            "- Propose completion only when the objective is actually satisfied.",
            unmet.length ? `
Outstanding criteria:
${unmet.join(`
`)}` : ""
          ].filter(Boolean).join(`
`)
        });
      });
      record({ event: "session.hook.context", ok: true });
    } catch (error) {
      record({ event: "session.hook.context", ok: false, error: String(error) });
    }
    try {
      await ctx.session.hook("compaction", async (event) => {
        if (!controller)
          return;
        const goal = controller.status(event?.sessionID);
        record({ event: "session.compaction", sessionID: event?.sessionID, status: goal?.status });
      });
      record({ event: "session.hook.compaction", ok: true });
    } catch (error) {
      record({ event: "session.hook.compaction", ok: false, error: String(error) });
    }
    try {
      await ctx.tool.hook("execute.after", async (event) => {
        const sessionID = sessionIDOf(event);
        record({
          event: "tool.execute.after",
          tool: event?.tool,
          sessionID,
          status: event?.status
        });
        if (process.env.XGOAL_DEBUG_TOOLS === "1") {
          const result = event?.result ?? null;
          record({
            event: "tool.result.shape",
            tool: event?.tool,
            eventKeys: event && typeof event === "object" ? Object.keys(event) : [],
            resultKeys: result && typeof result === "object" ? Object.keys(result) : [],
            metadata: result?.metadata ?? null,
            content: typeof result?.content === "string" ? result.content.slice(0, 200) : undefined
          });
        }
        if (!controller || !ledger || !sessionID)
          return;
        const ref = await resolveMessageRef(sessionID, event?.messageID);
        const goal = ref.goalID ? controller.store.byID(ref.goalID) : undefined;
        if (!goal || goal.status !== "active")
          return;
        const current = controller.status(sessionID);
        if (!current || current.id !== goal.id || current.generation !== goal.generation)
          return;
        try {
          const captured = ledger.capture({
            goalID: goal.id,
            tool: String(event?.tool ?? ""),
            status: event?.status === "completed" ? "completed" : "error",
            args: event?.input ?? event?.args,
            result: event?.result,
            workspace: await resolveSessionWorkspace(sessionID)
          });
          if (captured) {
            record({
              event: "evidence.captured",
              goalID: goal.id,
              kind: captured.kind,
              ref: captured.ref.slice(0, 120),
              exitCode: captured.exitCode ?? null
            });
          }
        } catch (error) {
          record({ event: "evidence.capture.error", error: String(error) });
        }
      });
      record({ event: "tool.hook.execute.after", ok: true });
    } catch (error) {
      record({ event: "tool.hook.execute.after", ok: false, error: String(error) });
    }
    const eventsSeen = new Set;
    const IDLE_SIGNALS = new Set([
      "session.execution.succeeded",
      "session.execution.failed",
      "session.inbox.delivered"
    ]);
    let lastDrive = 0;
    (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: abort.signal })) {
          const type = String(event?.type ?? "unknown");
          eventsSeen.add(type);
          observer.observe(event);
          record({ event: "event", type, total: eventsSeen.size });
          if (type.startsWith("session.")) {
            const evtSession = String(event?.data?.sessionID ?? event?.properties?.sessionID ?? "");
            if (evtSession && (type === "session.updated" || type === "session.moved" || type === "session.deleted" || type === "session.renamed")) {
              sessionWorkspaces.delete(evtSession);
            }
          }
          if (controller && type === "session.usage.updated") {
            const data = event?.data;
            const usageSession = data?.sessionID;
            const tokens = data?.tokens;
            if (usageSession && tokens) {
              const total = Number(tokens.input ?? 0) + Number(tokens.output ?? 0) + Number(tokens.reasoning ?? 0) + Number(tokens.cache?.read ?? 0) + Number(tokens.cache?.write ?? 0);
              try {
                const goal = controller.recordUsage(usageSession, total);
                record({
                  event: "usage.recorded",
                  sessionID: usageSession,
                  tokensUsed: goal?.tokensUsed ?? null,
                  tokenBudget: goal?.tokenBudget ?? null
                });
              } catch (error) {
                record({ event: "usage.record.error", error: String(error) });
              }
            }
          }
          if (!driver || !IDLE_SIGNALS.has(type))
            continue;
          const now = Date.now();
          if (now - lastDrive < 500)
            continue;
          lastDrive = now;
          const sessionID = sessionIDOf(event);
          if (!sessionID)
            continue;
          try {
            const outcome = await driver.drive(sessionID);
            record({ event: "driver.drive", sessionID, outcome: outcome.action });
          } catch (error) {
            record({ event: "driver.drive.error", sessionID, error: String(error) });
          }
        }
      } catch (error) {
        record({ event: "event.stream.error", error: String(error) });
      }
    })();
    record({ event: "setup.complete" });
    return async () => {
      abort.abort();
      if (sweep)
        clearInterval(sweep);
      try {
        controller?.close();
      } catch {}
      record({ event: "cleanup", eventsObserved: eventsSeen.size });
    };
  }
};
export {
  src_default as default
};
