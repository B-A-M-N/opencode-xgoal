/**
 * OpenCode-XGoal — acceptance criteria model and derivation.
 *
 * A criterion is never just free text. It either carries a machine-checkable
 * spec (verified independently of anything the model claims) or it requires
 * explicitly bound, currently-valid evidence. Either way, three unrelated
 * successful commands can no longer collectively satisfy three criteria.
 *
 * Derivation is deliberately conservative and deterministic: for an objective
 * we can parse into concrete file requirements we emit those as specs; anything
 * we cannot parse becomes a single objective-level criterion, which ordinary
 * evidence cannot prove — it resolves only through concrete sub-criteria or
 * explicit user acceptance. The original objective is never rewritten,
 * and derived criteria are additive — the model may refine them during
 * investigation but may not remove an explicit requirement to pass.
 *
 * Authority is a property of the requirement's origin, not of the parsing
 * mechanism: every criterion this module extracts comes from the user's own
 * objective text, so it carries `source: "user"`. The model may not retire it
 * (see `supersedeCriterion`); it may only propose a replacement that provably
 * preserves the obligation (see `preservesObligation`).
 */

/** A machine-checkable criterion specification. */
export type CriterionSpec =
  /**
   * The objective as a whole. Deliberately NOT provable by ordinary evidence:
   * a passing test or a real file change is equally consistent with a partial
   * job. Resolves through explicit user acceptance or decomposition into
   * concrete sub-criteria.
   */
  | { type: "objective" }
  /** A file must exist in the session workspace and match content if given. */
  | { type: "file"; path: string; equals?: string; contains?: string }
  /** A command must run and exit with the expected status. */
  | { type: "command"; command: string; expectExit?: number }
  /** A test command must run and exit zero. */
  | { type: "test"; command: string }
  /** Human judgement; requires explicitly bound evidence. */
  | { type: "manual" };

/**
 * Explicit normalization policy for command identity: trim and collapse runs
 * of internal whitespace. Deliberately NOT shell-string canonicalization —
 * `bun  test` and `bun test` are the same command as written, but
 * `cd x && bun test` is a different command and must not match.
 */
export function normalizedCommand(command: string): string {
  return command.trim().replace(/\s+/g, " ");
}

/**
 * Can `newSpec` replace `oldSpec` without weakening what the user required?
 *
 * Used when the model proposes correcting a misparsed user requirement: the
 * replacement is accepted only if everything the old spec accepted, the new
 * spec rejects — i.e. the obligation is preserved or narrowed. Specifications
 * that cannot be compared mechanically (objective, manual, type changes)
 * cannot be established to preserve anything and are refused; the user must
 * authorize those.
 *
 * File specs, same path:
 *  - equals X  → preserved only by the identical equals X
 *  - contains X → preserved by equals Y when Y includes X, or by contains Y
 *    when Y includes X (every string containing Y then contains X)
 *  - existence only → preserved by any content spec on the same path
 *
 * Command/test specs: preserved only by the identical normalized command
 * (and expected exit, for command specs).
 */
export function preservesObligation(
  oldSpec: CriterionSpec | undefined,
  newSpec: CriterionSpec | undefined,
): boolean {
  if (!oldSpec || !newSpec || oldSpec.type !== newSpec.type) return false;
  if (oldSpec.type === "file" && newSpec.type === "file") {
    if (oldSpec.path !== newSpec.path) return false;
    if (oldSpec.equals !== undefined) return newSpec.equals === oldSpec.equals;
    if (oldSpec.contains !== undefined) {
      if (newSpec.equals !== undefined) return newSpec.equals.includes(oldSpec.contains);
      if (newSpec.contains !== undefined) return newSpec.contains.includes(oldSpec.contains);
      return false;
    }
    // Existence-only: any same-path spec that also checks content is stricter.
    return newSpec.equals !== undefined || newSpec.contains !== undefined;
  }
  if (oldSpec.type === "command" && newSpec.type === "command") {
    return (
      normalizedCommand(oldSpec.command) === normalizedCommand(newSpec.command) &&
      (oldSpec.expectExit ?? 0) === (newSpec.expectExit ?? 0)
    );
  }
  if (oldSpec.type === "test" && newSpec.type === "test") {
    return normalizedCommand(oldSpec.command) === normalizedCommand(newSpec.command);
  }
  // objective/manual/spec-type changes: preservation cannot be established.
  return false;
}

export interface DerivedCriterion {
  text: string;
  spec: CriterionSpec;
  /**
   * The requirement's authority origin. Criteria extracted from the user's
   * objective are "user" regardless of how they were parsed; "model" marks
   * requirements the model established during investigation.
   */
  source: "derived" | "user" | "model";
}

/**
 * How a goal is allowed to reach verified completion (audit #1).
 *
 *  - `machine`: every criterion has a machine-checkable spec; no human or
 *    model verdict is needed.
 *  - `audited`: the objective is open-ended, but completion is defined
 *    operationally — every confirmed requirement must be machine-proven AND
 *    the objective-level remainder must be covered by concrete criteria the
 *    controller proved independently. The verdict (`ObjectiveAssessment`) is
 *    computed by the controller from proofs it re-checked itself — never from
 *    a model assertion — and is persisted with generation fencing.
 *  - `userAcceptance`: subjective outcomes that only a human can judge.
 *
 * `audited` deliberately does NOT mean "the machine proved there are no
 * remaining bugs". It means every requirement discovered within the audited
 * scope is resolved, and the scope itself is recorded. An inherently
 * open-ended objective stays `indeterminate` rather than being declared
 * exhaustively satisfied.
 */
export type CompletionPolicy = "machine" | "audited" | "userAcceptance";

/**
 * The completion policy an objective calls for, decided at creation time from
 * the objective's own text and the criteria it yielded.
 *
 * An objective that parsed into only machine-checkable requirements is
 * `machine`. An objective whose remainder is a broad investigation/repair task
 * ("audit ... and fix ...", "find and fix ...", "review ...") is `audited`.
 * Anything else is `userAcceptance`.
 */
export function completionPolicyFor(
  objective: string,
  criteria: DerivedCriterion[],
): CompletionPolicy {
  if (criteria.length === 0) return "userAcceptance";
  if (criteria.every((c) => c.spec.type !== "objective")) return "machine";
  const text = objective.toLowerCase();
  // Engineering objectives are recognisable by the artefacts and activities
  // they name. A broad engineering task gets the `audited` policy so it can
  // finish hands-off once every discovered requirement is independently
  // proven; a subjective objective ("write a poem", "improve the onboarding
  // copy") keeps the explicit user-acceptance rule, because no machine check
  // can stand in for human judgement there.
  const investigation =
    /\b(?:audit|investigate|find|review|analy[sz]e|harden|diagnose|debug)\b/.test(text) &&
    /\b(?:fix|repair|address|resolve|correct|eliminate|patch)\b/.test(text);
  const engineering =
    /\b(?:file|files|tests?|suite|bugs?|code|repo(?:sitory)?|build|deploy(?:ment)?|commit|branch|function|module|api|endpoint|config(?:uration)?|dependenc(?:y|ies)|lint|typecheck|script|package|database|schema|migration|server|client|pipeline|workflow|command|error|failure|regression|issue|security|performance)\b/.test(
      text,
    );
  return investigation || engineering ? "audited" : "userAcceptance";
}

/** A requirement established explicitly by the user or the model. */
export interface CriterionInput {
  text: string;
  spec?: CriterionSpec;
  /** Authority origin: the user's objective, or a model-added requirement. */
  source?: "derived" | "user" | "model";
}

const FILE_NAME = "[\\w./\\-]+\\.[A-Za-z0-9]+";
// Paths are single tokens; content may be a quoted string or a multi-word
// phrase that ends at sentence punctuation. Both may contain dots (`a.txt`,
// `v1.2`), so sentence punctuation is stripped after capture instead.
const PATH_TOKEN = "(`[^`]+`|\"[^\"]+\"|'[^']+'|[^\\s,;]+)";
// Unquoted content ends at sentence punctuation, a comma/semicolon, or a
// conjunction that introduces another obligation ("and", "then"). Quoting is
// how a user makes punctuation, whitespace, or a conjunction material to the
// requirement; without quotes the boundary of literal content is ambiguous,
// so the conservative reading stops the content and leaves the remainder as a
// separate requirement rather than absorbing it (audit #2).
// Quoted alternatives are non-capturing so CONTENT_TOKEN's own group stays the
// single index every pattern builder refers to.
const QUOTED_TOKEN = "(?:`[^`]+`|\"[^\"]+\"|'[^']+')";
const UNQUOTED_CONTENT = "[^.;\\n]+";
const CONTENT_TOKEN = `(${QUOTED_TOKEN}|${UNQUOTED_CONTENT})`;
// The "exactly" modifier is captured, not consumed: an exact requirement
// emits an `equals` spec, whose match is byte-exact, not a substring test.
const EXACTLY_TOKEN = "((?:exactly:?\\s+)?)";
// A bare "create X" only names a file when X looks like one. Requiring an
// extension prevents "make the tests pass" from becoming a file criterion.
const PATH_NAME = `(${FILE_NAME}|\`[^\`]+\`|"[^"]+"|'[^']+')`;
// An imperative lead-in that enumerates files ("Write two files: a.txt ...").
// Consumed as part of a match so it cannot resurface as a residual obligation.
// Optional as a whole; the file word must be followed by a real separator
// (":" or "," plus space, or plain whitespace), so a path that merely starts
// with "file" ("files.json containing x") is never partially eaten by it.
const FILE_LIST_PREAMBLE =
  "(?:(?:please\\s+)?(?:create|write|make|add)\\s+(?:(?:a|an|the|new|one|two|three|four|five|six|seven|eight|nine|ten|several|multiple|both|all)\\s+)*(?:new\\s+)?files?(?:\\s*[:,]\\s*|\\s+)(?:(?:called|named)\\s+)?)?";

function strip(value: string | undefined, exact = false): string {
  if (!value) return "";
  const trimmed = value.trim();
  // Quoted values are literal. An exact requirement keeps the inner content
  // verbatim — significant whitespace is material to an exact match.
  if (/^([`"']).*\1$/s.test(trimmed)) {
    const inner = trimmed.slice(1, -1);
    return exact ? inner : inner.trim();
  }
  // Unquoted values end at sentence punctuation, which is prose formatting
  // rather than content. Quoting is how a user makes punctuation or
  // whitespace material to the requirement. Stripping here can only make
  // verification stricter, never weaker.
  return trimmed.replace(/[.!?]+$/, "");
}

/**
 * Split unquoted captured content at a conjunction that introduces a new,
 * obligation-bearing clause ("... and run the integration suite").
 *
 * Audit #2: an unquoted content capture must not absorb a trailing requirement.
 * The boundary is only trusted when the text after the conjunction starts with
 * an imperative verb or modal — "alpha and beta" is literal content, while
 * "alpha and run the tests" is two requirements. Quoted content is never split:
 * its boundary is explicit. Returns the residual text (still part of the same
 * source span) so the caller can account for it instead of dropping it.
 */
function splitObligation(raw: string): { content: string; residual?: string } {
  const trimmed = raw.trim();
  if (/^([`"']).*\1$/s.test(trimmed)) return { content: raw };
  const re = /(\s*,\s*|\s+)(?:and|then|also)\s+/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(raw))) {
    const after = raw.slice(match.index + match[0].length);
    if (!OBLIGATION_VERB.test(after)) continue;
    return {
      content: raw.slice(0, match.index).replace(/[\s,;]+$/, ""),
      residual: after.trim(),
    };
  }
  return { content: raw };
}

/** An imperative verb or modal that starts a new obligation clause. */
const OBLIGATION_VERB =
  /^(?:run|execute|test|verify|ensure|make|create|write|add|remove|delete|update|fix|refactor|publish|deploy|commit|push|install|configure|document|keep|avoid|check|confirm|use|start|stop|build|lint|format|review|audit|do\s+not|don't|never|must|should|shall|not)\b/i;

/**
 * A clause that itself states a file requirement ("b.txt containing exactly
 * bravo"). A conjunction followed by this shape is a boundary between two
 * requirements, not literal content inside the previous one.
 */
const FILE_REQUIREMENT_START = new RegExp(
  `^(?:${FILE_NAME}|\`[^\`]+\`|"[^"]+"|'[^']+')\\s+(?:must\\s+)?(?:contain|contains|containing|include|includes|including|have|has)\\b`,
  "i",
);

/** A clause that reads as an obligation: it carries a verb or a modal. */
const OBLIGATIONISH =
  /\b(?:[a-z]+(?:e|ed|s|ing|ise|ize|ate|ify)\b|must|should|shall|ensure|verify|run|test|check|deploy|publish|pass|fail|fix|add|create|write|make|keep|avoid|never|do not|don't|no)\b/i;

function readsAsObligation(clause: string): boolean {
  return OBLIGATIONISH.test(clause);
}

/**
 * Split a target into obligation clauses at boundaries a conservative reader
 * trusts (audit #2): sentence punctuation outside quotes, and a conjunction
 * whose following text itself states an obligation — an imperative verb or
 * another file requirement. Quoted text is never split; the quote is the
 * user's explicit boundary. A dot that stays attached to a token ("a.txt")
 * is not sentence punctuation, so the path of a following file requirement
 * can no longer be amputated into the previous content capture — the failure
 * that corrupted "alpha, and b.txt containing exactly bravo" into the literal
 * content "alpha, and b".
 */
function splitObligationClauses(text: string): string[] {
  const clauses: string[] = [];
  let start = 0;
  let quote: string | undefined;
  const push = (end: number) => {
    const raw = text.slice(start, end).trim();
    start = end;
    if (raw) clauses.push(raw);
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quote) {
      if (ch === quote) {
        // A single quote closes only at a word boundary, so the apostrophe
        // in a contraction cannot swallow the rest of the clause.
        const next = text[i + 1];
        if (quote !== "'" || next === undefined || !/\w/.test(next)) quote = undefined;
      }
      continue;
    }
    if (ch === '"' || ch === "`" || (ch === "'" && (i === 0 || !/\w/.test(text[i - 1]!)))) {
      quote = ch;
      continue;
    }
    if (ch === "." || ch === "!" || ch === "?" || ch === ";" || ch === "\n") {
      const next = text[i + 1];
      if (next === undefined || /\s/.test(next)) push(i + 1);
      continue;
    }
    if (ch === "," || /\s/.test(ch)) {
      // A conjunction splits only when the text after it states an
      // obligation; otherwise it is literal content ("alpha and beta").
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

/** Build a file spec from a parsed path/content pair, honoring `exactly`. */
function fileSpec(path: string, exact: boolean, content: string): CriterionSpec | undefined {
  if (!path) return undefined;
  if (!content) return { type: "file", path };
  // "write alpha to a.txt" has no `exactly` modifier; substring is the
  // conservative reading (a conventional trailing newline must not fail it).
  return exact ? { type: "file", path, equals: content } : { type: "file", path, contains: content };
}

/** A parsed file requirement plus any obligation-bearing tail it excluded. */
interface ParsedFile {
  spec: CriterionSpec;
  /** Text inside the match that is a separate requirement, not content. */
  residual?: string;
}

/**
 * Objective patterns that name a concrete file requirement. Each returns a
 * `{ type: "file" }` spec when it matches. These are heuristics, not a parser:
 * an objective that matches none of them is handled by the objective fallback,
 * which is still machine-verified (it just cannot be pre-checked).
 */
const FILE_PATTERNS: Array<{ re: RegExp; build: (m: RegExpMatchArray) => ParsedFile | undefined }> = [
  {
    // "create a file called a.txt containing exactly: alpha"
    // "create src/mod.js that exports a function named add"
    re: new RegExp(
      `(?:create|write|make|add)\\s+(?:a\\s+|the\\s+)?(?:file\\s+)?(?:called\\s+|named\\s+)?${PATH_TOKEN}\\s+(?:containing|with|that contains|that has|must contain|contains)\\s+${EXACTLY_TOKEN}${CONTENT_TOKEN}`,
      "gi",
    ),
    build: (m) => {
      const path = strip(m[1]);
      const exact = Boolean(m[2]);
      // Split the RAW capture: quoting is the user's explicit boundary, and it
      // must be visible here so quoted conjunctions are never split.
      const split = splitObligation(m[3] ?? "");
      const spec = fileSpec(path, exact, strip(split.content, exact));
      return spec ? { spec, residual: split.residual } : undefined;
    },
  },
  {
    // "write alpha to a.txt" / "write alpha into a.txt"
    re: new RegExp(`write\\s+${CONTENT_TOKEN}\\s+(?:to|into)\\s+${PATH_TOKEN}`, "gi"),
    build: (m) => {
      const split = splitObligation(m[1] ?? "");
      const path = strip(m[2]);
      const spec = fileSpec(path, false, strip(split.content));
      return spec ? { spec, residual: split.residual } : undefined;
    },
  },
  {
    // "a.txt must contain alpha" / "a.txt contains alpha" / "a.txt containing exactly: alpha"
    // An enumerating preamble ("write two files: a.txt containing ...") is
    // optional and non-capturing; when present it is part of the match, so
    // the span accounting sees it as explained rather than residual.
    re: new RegExp(
      `${FILE_LIST_PREAMBLE}(${FILE_NAME})\\s+(?:must\\s+)?(?:contain|contains|containing|include|includes|including|have|has)\\s+${EXACTLY_TOKEN}${CONTENT_TOKEN}`,
      "gi",
    ),
    build: (m) => {
      const path = strip(m[1]);
      const exact = Boolean(m[2]);
      const split = splitObligation(m[3] ?? "");
      const spec = fileSpec(path, exact, strip(split.content, exact));
      return spec ? { spec, residual: split.residual } : undefined;
    },
  },
  {
    // "create a file called a.txt" (no content)
    re: new RegExp(`(?:create|write|make|add)\\s+(?:a\\s+|the\\s+)?(?:file\\s+)?(?:called\\s+|named\\s+)?${PATH_NAME}`, "gi"),
    build: (m) => {
      const path = strip(m[1]);
      if (!path) return undefined;
      return { spec: { type: "file", path } };
    },
  },
];

/**
 * Completion instructions are workflow, not outcome: "when it exists, propose
 * completion" tells the model what to do next, it does not state a requirement
 * the finished work must satisfy. Treating them as obligations would make every
 * ordinary objective unsolvable.
 */
function isProceduralInstruction(clause: string): boolean {
  const stripped = clause
    .replace(/^(?:when|once|after|if|as soon as)\b[^,]*,\s*/i, "")
    .trim();
  return new RegExp(
    "^(?:(?:please|then|now|finally)\\s+)*(" +
      "(?:propose|declare|report|signal|announce)\\s+(?:the\\s+)?(?:goal\\s+)?(?:completion|complete|done|finished)" +
      "|call\\s+`?goal_propose_complete`?" +
      "|(?:report|come)\\s+back(?:\\s+to\\s+the\\s+user)?" +
      "|stop(?:\\s+work)?|finish(?:ed)?|done" +
      ")[\\s.!]*$",
    "i",
  ).test(stripped);
}

/**
 * Extract obligation-bearing text that no confident match explained.
 *
 * Audit #2: a parsed file requirement must not absorb the rest of its clause.
 * The unconsumed spans of a clause are grouped into clauses (split on
 * sentence punctuation and on `and`/`then` conjunctions) and anything that
 * still reads as a requirement — a verb or a modal, not bare connective
 * prose — is returned. Ambiguity resolves toward "unresolved obligation",
 * never toward guessing that the residue was literal file content.
 */
export function residualObligations(text: string, consumed: boolean[]): string[] {
  const residuals: string[] = [];
  let start = -1;
  const flush = (end: number) => {
    if (start === -1) return;
    const raw = text.slice(start, end).trim();
    start = -1;
    if (!raw) return;
    const cleaned = raw
      .replace(/^[\s,;.]+|[\s,;.]+$/g, "")
      .replace(/^(?:and|then|also|plus)\s+/i, "")
      .trim();
    if (!cleaned) return;
    // Connective-only residue is prose glue, not a requirement.
    if (/^(?:and|then|also|plus)$/i.test(cleaned)) return;
    // Workflow instructions ("propose completion", "report back") describe
    // what the model should do next, not a property the finished work needs.
    if (isProceduralInstruction(cleaned)) return;
    // A clause without any verb-like or modal token is a fragment (e.g. the
    // tail of a quoted string) rather than an action the user required.
    if (!readsAsObligation(cleaned)) return;
    residuals.push(cleaned);
  };
  for (let i = 0; i < text.length; i++) {
    if (consumed[i]) {
      flush(i);
      continue;
    }
    const ch = text[i]!;
    if (ch === "." || ch === ";" || ch === "\n") {
      flush(i);
      continue;
    }
    start = start === -1 ? i : start;
  }
  flush(text.length);
  return residuals;
}

/**
 * Derive preliminary acceptance criteria from an objective.
 *
 * The original objective is always retained verbatim; criteria are additive.
 * Enumerated objectives become one criterion per item — every explicit
 * requirement is preserved, with no cap. A parsed file requirement becomes a
 * file spec (independently re-checked at verification). Everything else
 * collapses to an objective-level criterion, which cannot be machine-proven
 * from ordinary evidence: it resolves only through concrete sub-criteria
 * registered during investigation or explicit user acceptance. This means an
 * ordinary `/goal <objective>` starts with criteria and verification remains
 * meaningful.
 */
export function deriveCriteria(objective: string): DerivedCriterion[] {
  const text = objective.trim();
  if (!text) return [];

  const rawLines = text.split(/\n+/);
  const listLines = rawLines
    .filter((line) => /^\s*(?:\d+[.)]|[-*+])\s*/.test(line))
    .map((line) => line.replace(/^\s*(?:\d+[.)]|[-*+])\s*/, "").trim())
    .filter((line) => line.length > 0);
  const allLines = rawLines
    .map((line) => line.replace(/^\s*(?:\d+[.)]|[-*+])\s*/, "").trim())
    .filter((line) => line.length > 0);
  // A short preamble ("Complete all of the following:") is not a requirement.
  // When the objective is a list, only the listed items are criteria.
  const enumerated = listLines.length > 1 && listLines.length >= Math.ceil(allLines.length / 2);

  const criteria: DerivedCriterion[] = [];
  const seen = new Set<string>();
  const push = (criterionText: string, spec: CriterionSpec) => {
    const key = `${spec.type}::${criterionText}`;
    if (seen.has(key)) return;
    seen.add(key);
    // Authority follows origin: everything here was extracted from the
    // user's own objective, so it carries the user's authority even though
    // a regex produced the spec. See preservesObligation for the model's
    // correction path.
    criteria.push({ text: criterionText, spec, source: "user" });
  };

  const contentOf = (spec: CriterionSpec): string | undefined =>
    spec.type === "file" ? (spec.contains ?? spec.equals) : undefined;
  const contentText = (spec: CriterionSpec, content: string): string => {
    if (spec.type !== "file") return content;
    return spec.equals !== undefined
      ? `${spec.path} must be exactly: ${content}`
      : `${spec.path} contains ${content}`;
  };

  const targets = enumerated ? listLines : [text];
  const contentPaths = new Set<string>();
  for (const target of targets) {
    // Clause pre-splitting (audit #2): each target is parsed clause by clause
    // at boundaries a conservative reader trusts. Within a clause the regexes
    // never cross a boundary, so a following file requirement can no longer
    // be truncated into the previous content by the dot inside its own path,
    // and an obligation after "and"/"then" is its own clause rather than
    // somebody else's literal content.
    const unresolvedClauses: string[] = [];
    let targetMatched = false;
    for (const clause of splitObligationClauses(target)) {
      let matched = false;
      // Source-span accounting (audit #2): a regex match proves only that the
      // span it consumed was represented. The remainder of the clause must be
      // examined: an obligation-bearing residual ("... and run the integration
      // suite") is a separate requirement, never absorbed into a parsed file
      // content and never silently dropped. `consumed[i]` marks characters of
      // the clause a confident match explained.
      const consumed = new Array<boolean>(clause.length).fill(false);
      const mark = (start: number, end: number) => {
        for (let i = Math.max(0, start); i < Math.min(clause.length, end); i++) consumed[i] = true;
      };

      // First pass: content-bearing file requirements. There is deliberately
      // no cap on how many requirements are kept: truncation silently
      // discarded the tail of an enumerated objective, letting verification
      // certify a shortened interpretation of what the user asked for.
      for (const { re, build } of FILE_PATTERNS) {
        for (const match of clause.matchAll(re)) {
          const parsed = build(match);
          if (!parsed || parsed.spec.type !== "file") continue;
          const spec = parsed.spec;
          const content = contentOf(spec);
          if (!content) continue;
          matched = true;
          contentPaths.add(spec.path);
          push(contentText(spec, content), spec);
          mark(match.index ?? 0, (match.index ?? 0) + match[0].length);
          // A conjunction inside an unquoted capture introduced a separate
          // obligation: it was excluded from the content, and it is preserved
          // as its own unresolved requirement rather than absorbed or dropped.
          if (parsed.residual) {
            push(`The requirement is achieved: ${parsed.residual}`, { type: "objective" });
          }
        }
      }
      // Second pass: existence-only requirements, unless a content criterion
      // already covers the same path — an existence-only criterion must never
      // sit beside a stronger content requirement for the same file.
      for (const { re, build } of FILE_PATTERNS) {
        for (const match of clause.matchAll(re)) {
          const parsed = build(match);
          if (!parsed || parsed.spec.type !== "file") continue;
          if (contentOf(parsed.spec)) continue;
          const spec = parsed.spec;
          if (contentPaths.has(spec.path)) continue;
          matched = true;
          push(`${spec.path} exists`, spec);
          mark(match.index ?? 0, (match.index ?? 0) + match[0].length);
        }
      }
      if (matched) {
        targetMatched = true;
        // Residual obligations: text left outside every confident match that
        // still carries an obligation. Each becomes its own criterion so
        // nothing is lost or folded into a neighbour's content. Pure
        // connective prose ("and", "then") is not an obligation and is
        // discarded.
        for (const residual of residualObligations(clause, consumed)) {
          push(`The requirement is achieved: ${residual}`, { type: "objective" });
        }
      } else {
        unresolvedClauses.push(clause);
      }
    }
    if (!targetMatched) {
      // Nothing in the target parsed concretely: the target itself is the
      // objective-level remainder, kept verbatim as ONE criterion. It is
      // never proven by ordinary evidence; it resolves through concrete
      // sub-criteria, an audit verdict, or user acceptance. Fragmenting an
      // unparseable objective would invent arbitrary sub-remainders ("audit
      // the repository" / "fix any critical bugs") whose coverage semantics
      // the model cannot honestly establish.
      push(`The requirement is achieved: ${target}`, { type: "objective" });
      continue;
    }
    // Excluded clauses of a partially parsed target: each unresolved clause is
    // a specific obligation the confident parse set aside. It is recorded as
    // its own criterion when it still reads as an obligation; connective
    // prose, fragments, and workflow instructions ("propose completion") are
    // not requirements and are dropped.
    for (const clause of unresolvedClauses) {
      const cleaned = clause
        .replace(/^[\s,;.]+|[\s,;.]+$/g, "")
        .replace(/^(?:and|then|also|plus)\s+/i, "")
        .trim();
      if (
        cleaned &&
        !/^(?:and|then|also|plus)$/i.test(cleaned) &&
        !isProceduralInstruction(cleaned) &&
        readsAsObligation(cleaned)
      ) {
        push(`The requirement is achieved: ${cleaned}`, { type: "objective" });
      }
    }
  }

  // An open-ended objective we could not decompose becomes a single
  // objective-level criterion. It is never proven by ordinary evidence; it
  // resolves through user acceptance or concrete sub-criteria.
  if (criteria.length === 0) {
    push(`The objective is achieved: ${text}`, { type: "objective" });
  }

  return criteria;
}
