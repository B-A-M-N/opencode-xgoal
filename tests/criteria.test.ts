/**
 * Phase 03 — acceptance criteria derivation.
 *
 * Ordinary `/goal <objective>` must establish criteria at creation time, and a
 * concrete file requirement must become an independently checkable spec rather
 * than collapsing into "the objective is achieved".
 */
import { describe, expect, test } from "bun:test";
import { deriveCriteria } from "../src/controller/criteria.ts";

describe("deriveCriteria", () => {
  test("parses an exact file-content requirement", () => {
    const [criterion] = deriveCriteria(
      "Create a file called a.txt containing exactly: alpha.",
    );
    expect(criterion.spec).toEqual({ type: "file", path: "a.txt", contains: "alpha" });
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
      contains: "export const add = 1",
    });
  });

  test("quoted content preserves punctuation", () => {
    const [criterion] = deriveCriteria(
      'Create a file called README.md containing exactly: "Installation."',
    );
    expect(criterion.spec).toEqual({
      type: "file",
      path: "README.md",
      contains: "Installation.",
    });
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
});
