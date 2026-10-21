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
const CONTENT_TOKEN = "(`[^`]+`|\"[^\"]+\"|'[^']+'|[^.;\\n]+)";
// The "exactly" modifier is captured, not consumed: an exact requirement
// emits an `equals` spec, whose match is byte-exact, not a substring test.
const EXACTLY_TOKEN = "((?:exactly:?\\s+)?)";
// A bare "create X" only names a file when X looks like one. Requiring an
// extension prevents "make the tests pass" from becoming a file criterion.
const PATH_NAME = `(${FILE_NAME}|\`[^\`]+\`|"[^"]+"|'[^']+')`;

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

/** Build a file spec from a parsed path/content pair, honoring `exactly`. */
function fileSpec(path: string, exact: boolean, content: string): CriterionSpec | undefined {
  if (!path) return undefined;
  if (!content) return { type: "file", path };
  // "write alpha to a.txt" has no `exactly` modifier; substring is the
  // conservative reading (a conventional trailing newline must not fail it).
  return exact ? { type: "file", path, equals: content } : { type: "file", path, contains: content };
}

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
      `(?:create|write|make|add)\\s+(?:a\\s+|the\\s+)?(?:file\\s+)?(?:called\\s+|named\\s+)?${PATH_TOKEN}\\s+(?:containing|with|that contains|that has|must contain|contains)\\s+${EXACTLY_TOKEN}${CONTENT_TOKEN}`,
      "gi",
    ),
    build: (m) => {
      const path = strip(m[1]);
      const exact = Boolean(m[2]);
      const content = strip(m[3], exact);
      return fileSpec(path, exact, content);
    },
  },
  {
    // "write alpha to a.txt" / "write alpha into a.txt"
    re: new RegExp(`write\\s+${CONTENT_TOKEN}\\s+(?:to|into)\\s+${PATH_TOKEN}`, "gi"),
    build: (m) => {
      const content = strip(m[1]);
      const path = strip(m[2]);
      return fileSpec(path, false, content);
    },
  },
  {
    // "a.txt must contain alpha" / "a.txt contains alpha"
    re: new RegExp(`${FILE_NAME}\\s+(?:must\\s+)?(?:contain|include|have)\\s+${EXACTLY_TOKEN}${CONTENT_TOKEN}`, "gi"),
    build: (m) => {
      const path = strip(m[0].split(/\s+/)[0]);
      const exact = Boolean(m[1]);
      const content = strip(m[2], exact);
      return fileSpec(path, exact, content);
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
    let matched = false;
    // First pass: content-bearing file requirements. There is deliberately no
    // cap on how many requirements are kept: truncation silently discarded the
    // tail of an enumerated objective, letting verification certify a
    // shortened interpretation of what the user asked for.
    for (const { re, build } of FILE_PATTERNS) {
      for (const match of target.matchAll(re)) {
        const spec = build(match);
        if (!spec || spec.type !== "file") continue;
        const content = contentOf(spec);
        if (!content) continue;
        matched = true;
        contentPaths.add(spec.path);
        push(contentText(spec, content), spec);
      }
    }
    // Second pass: existence-only requirements, unless a content criterion
    // already covers the same path — an existence-only criterion must never
    // sit beside a stronger content requirement for the same file.
    for (const { re, build } of FILE_PATTERNS) {
      for (const match of target.matchAll(re)) {
        const spec = build(match);
        if (!spec || spec.type !== "file") continue;
        if (contentOf(spec)) continue;
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
