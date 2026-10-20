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

export interface DerivedCriterion {
  text: string;
  spec: CriterionSpec;
  source: "derived" | "user" | "model";
}

/** A requirement established explicitly by the user or the model. */
export interface CriterionInput {
  text: string;
  spec?: CriterionSpec;
  /** "derived" marks criteria synthesized from the objective, not stated. */
  source?: "derived" | "user" | "model";
}

const FILE_NAME = "[\\w./\\-]+\\.[A-Za-z0-9]+";
// Paths are single tokens; content may be a quoted string or a multi-word
// phrase that ends at sentence punctuation. Both may contain dots (`a.txt`,
// `v1.2`), so sentence punctuation is stripped after capture instead.
const PATH_TOKEN = "(`[^`]+`|\"[^\"]+\"|'[^']+'|[^\\s,;]+)";
const CONTENT_TOKEN = "(`[^`]+`|\"[^\"]+\"|'[^']+'|[^.;\\n]+)";
// A bare "create X" only names a file when X looks like one. Requiring an
// extension prevents "make the tests pass" from becoming a file criterion.
const PATH_NAME = `(${FILE_NAME}|\`[^\`]+\`|"[^"]+"|'[^']+')`;

/**
 * Objective patterns that name a concrete file requirement. Each returns a
 * `{ type: "file" }` spec when it matches. These are heuristics, not a parser:
 * an objective that matches none of them is handled by the objective fallback,
 * which is still machine-verified (it just cannot be pre-checked).
 */
const FILE_PATTERNS: Array<{ re: RegExp; build: (m: RegExpMatchArray) => CriterionSpec | undefined }> = [
  {
    // "create a file called a.txt containing exactly: alpha"
    // "create src/mod.js that exports a function named add"
    re: new RegExp(
      `(?:create|write|make|add)\\s+(?:a\\s+|the\\s+)?(?:file\\s+)?(?:called\\s+|named\\s+)?${PATH_TOKEN}\\s+(?:containing|with|that contains|that has|must contain|contains)\\s+(?:exactly:?\\s+)?${CONTENT_TOKEN}`,
      "gi",
    ),
    build: (m) => {
      const path = strip(m[1]);
      const content = strip(m[2]);
      if (!path) return undefined;
      return { type: "file", path, contains: content || undefined };
    },
  },
  {
    // "write alpha to a.txt" / "write alpha into a.txt"
    re: new RegExp(`write\\s+${CONTENT_TOKEN}\\s+(?:to|into)\\s+${PATH_TOKEN}`, "gi"),
    build: (m) => {
      const content = strip(m[1]);
      const path = strip(m[2]);
      if (!path) return undefined;
      return { type: "file", path, contains: content || undefined };
    },
  },
  {
    // "a.txt must contain alpha" / "a.txt contains alpha"
    re: new RegExp(`${FILE_NAME}\\s+(?:must\\s+)?(?:contain|include|have)\\s+(?:exactly:?\\s+)?${CONTENT_TOKEN}`, "gi"),
    build: (m) => {
      const path = strip(m[0].split(/\s+/)[0]);
      const content = strip(m[1]);
      if (!path) return undefined;
      return { type: "file", path, contains: content || undefined };
    },
  },
  {
    // "create a file called a.txt" (no content)
    re: new RegExp(`(?:create|write|make|add)\\s+(?:a\\s+|the\\s+)?(?:file\\s+)?(?:called\\s+|named\\s+)?${PATH_NAME}`, "gi"),
    build: (m) => {
      const path = strip(m[1]);
      if (!path) return undefined;
      return { type: "file", path };
    },
  },
];

function strip(value: string | undefined): string {
  if (!value) return "";
  const trimmed = value.trim();
  // Quoted values are literal: keep punctuation inside the quotes.
  if (/^([`"']).*\1$/s.test(trimmed)) return trimmed.slice(1, -1).trim();
  // Unquoted values end at sentence punctuation.
  return trimmed.replace(/[.!?]+$/, "");
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
    criteria.push({ text: criterionText, spec, source: "derived" });
  };

  const targets = enumerated ? listLines : [text];
  const contentPaths = new Set<string>();
  for (const target of targets) {
    let matched = false;
    // First pass: content-bearing file requirements. There is deliberately no
    // cap on how many requirements are kept: truncation silently discarded the
    // tail of an enumerated objective, letting verification certify a
    // shortened interpretation of what the user asked for.
    for (const { re, build } of FILE_PATTERNS) {
      for (const match of target.matchAll(re)) {
        const spec = build(match);
        if (!spec || spec.type !== "file") continue;
        const content = "contains" in spec ? spec.contains : undefined;
        if (!content) continue;
        matched = true;
        contentPaths.add(spec.path);
        push(`${spec.path} contains ${content}`, spec);
      }
    }
    // Second pass: existence-only requirements, unless a content criterion
    // already covers the same path.
    for (const { re, build } of FILE_PATTERNS) {
      for (const match of target.matchAll(re)) {
        const spec = build(match);
        if (!spec || spec.type !== "file") continue;
        if ("contains" in spec && spec.contains) continue;
        if (contentPaths.has(spec.path)) continue;
        matched = true;
        push(`${spec.path} exists`, spec);
      }
    }
    if (!matched) {
      push(`The requirement is achieved: ${target}`, { type: "objective" });
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
