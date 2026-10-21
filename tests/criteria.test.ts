/**
 * Phase 03 — acceptance criteria derivation.
 *
 * Ordinary `/goal <objective>` must establish criteria at creation time, and a
 * concrete file requirement must become an independently checkable spec rather
 * than collapsing into "the objective is achieved".
 */
import { describe, expect, test } from "bun:test";
import {
  deriveCriteria,
  preservesObligation,
  type CriterionSpec,
} from "../src/controller/criteria.ts";

describe("deriveCriteria", () => {
  test("parses an exact file-content requirement", () => {
    const [criterion] = deriveCriteria(
      "Create a file called a.txt containing exactly: alpha.",
    );
    // "exactly" is an exact-content requirement: byte equality, not substring.
    expect(criterion.spec).toEqual({ type: "file", path: "a.txt", equals: "alpha" });
  });

  test("a plain containing requirement stays a substring test", () => {
    const [criterion] = deriveCriteria("Create a file called a.txt containing alpha.");
    expect(criterion.spec).toEqual({ type: "file", path: "a.txt", contains: "alpha" });
  });

  // Audit-3 #1: the "exactly" modifier was consumed but discarded, so
  // "result.txt containing exactly: success" accepted "success but unfinished".
  test("the auditor's exact-content example emits an equals spec", () => {
    const [criterion] = deriveCriteria(
      "Create `result.txt` containing exactly: success",
    );
    expect(criterion.spec).toEqual({ type: "file", path: "result.txt", equals: "success" });
    expect(criterion.text).toContain("exactly");
  });

  test("exact content with extra bytes must fail the criterion", () => {
    // Material bytes are those the user wrote: an equals spec is checked with
    // byte equality (see checkSpec in index.ts), so "success but unfinished"
    // cannot satisfy equals "success".
    const [criterion] = deriveCriteria("Create a file called a.txt containing exactly: success");
    const spec = criterion.spec as { equals?: string };
    expect(spec.equals).toBe("success");
    expect("success but unfinished".includes(spec.equals!)).toBe(true); // contains would have passed
    expect("success but unfinished" === spec.equals).toBe(false); // equals does not
  });

  test("quoted exact content preserves significant whitespace", () => {
    const [criterion] = deriveCriteria(
      'Create a file called a.txt containing exactly: "alpha  beta  "',
    );
    expect(criterion.spec).toEqual({ type: "file", path: "a.txt", equals: "alpha  beta  " });
  });

  test("parses two file requirements in one objective without dropping either", () => {
    const criteria = deriveCriteria(
      "Create a file called a.txt containing exactly: alpha. Create a file called b.txt containing exactly: bravo.",
    );
    const files = criteria.filter((c) => c.spec.type === "file");
    expect(files.map((c) => (c.spec as { path: string }).path).sort()).toEqual(["a.txt", "b.txt"]);
    // A parsed objective must not also fall back to an unsatisfiable objective
    // criterion that would require unrelated evidence.
    expect(criteria.some((c) => c.spec.type === "objective")).toBe(false);
  });

  test("keeps paths with directories and extensions intact", () => {
    const [criterion] = deriveCriteria(
      "Write a file called src/mod.js containing exactly: export const add = 1",
    );
    expect(criterion.spec).toEqual({
      type: "file",
      path: "src/mod.js",
      equals: "export const add = 1",
    });
  });

  test("quoted content preserves punctuation, exact or not", () => {
    const [criterion] = deriveCriteria(
      'Create a file called README.md containing exactly: "Installation."',
    );
    expect(criterion.spec).toEqual({
      type: "file",
      path: "README.md",
      equals: "Installation.",
    });
  });

  test("a must-contain objective honors the exactly modifier too", () => {
    const [criterion] = deriveCriteria("result.txt must contain exactly: alpha");
    expect(criterion.spec).toEqual({ type: "file", path: "result.txt", equals: "alpha" });
  });

  test("an unparseable objective still gets a machine-checked criterion", () => {
    const [criterion] = deriveCriteria("make the tests pass and keep the API stable");
    expect(criterion.spec.type).toBe("objective");
    expect(criterion.text).toContain("make the tests pass");
  });

  test("enumerated requirements become one criterion per item", () => {
    const criteria = deriveCriteria(
      [
        "Complete all of the following:",
        "1. Create a file called a.txt containing exactly: alpha",
        "2. Create a file called b.txt containing exactly: bravo",
        "3. Create a file called c.txt containing exactly: charlie",
      ].join("\n"),
    );
    expect(criteria).toHaveLength(3);
    expect(criteria.every((c) => c.spec.type === "file")).toBe(true);
  });

  // Audit P0-2: derivation used to stop after 8 parsed items, silently
  // discarding the tail of an enumerated objective — verification could then
  // certify a shortened interpretation of what the user asked for.
  test("no requirement is silently truncated, however long the list", () => {
    const names = "abcdefghijkl".split("");
    const objective = [
      "Complete all of the following:",
      ...names.map(
        (n, i) => `${i + 1}. Create a file called ${n}.txt containing exactly: content-${n}`,
      ),
    ].join("\n");
    const criteria = deriveCriteria(objective);
    const paths = criteria.map((c) => (c.spec as { path: string }).path);
    expect(criteria).toHaveLength(names.length);
    expect(new Set(paths).size).toBe(names.length);
  });

  // Audit-3 #5: authority follows origin, not the parsing mechanism. Every
  // requirement extracted from the user's objective is user-authoritative —
  // including numbered items — so the model cannot retire it.
  test("requirements extracted from the objective carry user authority", () => {
    const criteria = deriveCriteria(
      [
        "Complete all of the following:",
        "1. Create a file called a.txt containing exactly: alpha",
        "2. The changelog documents the fix",
      ].join("\n"),
    );
    expect(criteria.length).toBeGreaterThan(0);
    expect(criteria.every((c) => c.source === "user")).toBe(true);
    const [fallback] = deriveCriteria("make the tests pass and keep the API stable");
    expect(fallback.source).toBe("user");
  });

  test("an existence-only fallback never weakens an equals criterion", () => {
    const criteria = deriveCriteria(
      "Create a file called result.txt containing exactly: success",
    );
    const fileCriteria = criteria.filter((c) => c.spec.type === "file");
    // One criterion for the path: the exact-content one. No existence-only
    // duplicate that a bare file write could satisfy instead.
    expect(fileCriteria).toHaveLength(1);
    expect(fileCriteria[0].spec).toEqual({ type: "file", path: "result.txt", equals: "success" });
  });
});

describe("preservesObligation", () => {
  const file = (spec: { path: string; equals?: string; contains?: string }): CriterionSpec => ({
    type: "file",
    ...spec,
  });

  test("an identical spec preserves the obligation", () => {
    const old = file({ path: "a.txt", equals: "alpha" });
    expect(preservesObligation(old, file({ path: "a.txt", equals: "alpha" }))).toBe(true);
  });

  test("a weaker content requirement does not preserve the obligation", () => {
    const old = file({ path: "a.txt", equals: "alpha" });
    expect(preservesObligation(old, file({ path: "a.txt", contains: "al" }))).toBe(false);
    expect(preservesObligation(old, file({ path: "a.txt", contains: "alph" }))).toBe(false);
  });

  test("equals is preserved only by the identical requirement", () => {
    const old = file({ path: "a.txt", equals: "alpha" });
    expect(preservesObligation(old, file({ path: "a.txt", equals: "alpha " }))).toBe(false);
  });

  test("a contains requirement is preserved by a content superset or an exact value", () => {
    const old = file({ path: "a.txt", contains: "alpha" });
    expect(preservesObligation(old, file({ path: "a.txt", contains: "alpha beta" }))).toBe(true);
    expect(preservesObligation(old, file({ path: "a.txt", equals: "alpha and beta" }))).toBe(true);
    expect(preservesObligation(old, file({ path: "a.txt", contains: "alp" }))).toBe(false);
    expect(preservesObligation(old, file({ path: "a.txt" }))).toBe(false);
  });

  test("existence-only is preserved by any same-path content requirement", () => {
    const old = file({ path: "a.txt" });
    expect(preservesObligation(old, file({ path: "a.txt", contains: "anything" }))).toBe(true);
    expect(preservesObligation(old, file({ path: "a.txt", equals: "x" }))).toBe(true);
    expect(preservesObligation(old, file({ path: "b.txt", contains: "x" }))).toBe(false);
  });

  test("command identity is preserved only by the same normalized command", () => {
    const old = { type: "command", command: "bun test" } as const;
    expect(preservesObligation(old, { type: "command", command: "bun  test" })).toBe(true);
    expect(preservesObligation(old, { type: "command", command: "cd x && bun test" })).toBe(false);
    expect(
      preservesObligation(old, { type: "command", command: "bun test", expectExit: 1 }),
    ).toBe(false);
  });

  test("spec types that cannot be compared mechanically are refused", () => {
    expect(preservesObligation({ type: "objective" }, { type: "objective" })).toBe(false);
    expect(preservesObligation({ type: "manual" }, { type: "manual" })).toBe(false);
    expect(preservesObligation(undefined, file({ path: "a.txt", equals: "x" }))).toBe(false);
    expect(preservesObligation(file({ path: "a.txt", equals: "x" }), undefined)).toBe(false);
  });
});
