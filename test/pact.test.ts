// The three-way pact join (src/triangle.ts, surfaced on the check document). A test tagging both
// `@specs:` and `@docs:` bridges a spec claim to a doc section; the pact reports the complete
// triangles and the two kinds of hole. Claim ids and section slugs are content-derived, so the test
// discovers them at runtime from a first `check --json` rather than hard-coding them.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { git, runCli } from "./helpers/cli.js";

const SPECS = [
  "# Spec",
  "",
  "## Addition",
  "",
  "- [ ] add returns the sum of two integers",
  "",
  "## Subtraction",
  "",
  "- [ ] subtract returns the difference of two integers",
  "",
].join("\n");

const MANUAL = [
  "# Manual",
  "",
  "## Adding numbers",
  "",
  "- [ ] type a number in each field and click Add",
  "",
  "## Troubleshooting",
  "",
  "- [ ] restart the app if it stops responding",
  "",
].join("\n");

function config(edges: string): string {
  return [
    "schemaVersion: 1",
    "",
    "layers:",
    "  specs:",
    "    role: prescriptive",
    "    paths: [SPECS.md]",
    "  docs:",
    "    role: descriptive",
    "    paths: [docs/manual/**/*.md]",
    "  tests:",
    "    role: verificatory",
    "    paths: [tests/**/*.spec.ts]",
    "",
    "edges:",
    edges,
    "",
  ].join("\n");
}

/** A scratch three-layer repo. `edges` is the YAML list body under `edges:`. */
function makeRepo(edges: string): string {
  const repo = mkdtempSync(path.join(os.tmpdir(), "tripact-pact-"));
  git(repo, ["init", "-b", "main"]);
  writeFileSync(path.join(repo, "SPECS.md"), SPECS);
  writeFileSync(path.join(repo, "tripact.yaml"), config(edges));
  mkdirSync(path.join(repo, "docs", "manual"), { recursive: true });
  writeFileSync(path.join(repo, "docs", "manual", "using.md"), MANUAL);
  mkdirSync(path.join(repo, "tests"), { recursive: true });
  return repo;
}

function checkJson(repo: string): { verdicts: Array<{ edge: [string, string]; subject: string }>; pact: { complete: Array<{ claim: string; sections: string[]; tests: string[] }>; testedUndocumented: Array<{ claim: string; tests: string[] }>; untiedSections: string[] }; counts: Record<string, number> } {
  const r = runCli(["check", "--json"], { cwd: repo });
  return JSON.parse(r.stdout);
}

/** Subjects of verdicts on the edge whose non-tests endpoint is `layer`. */
function subjectsOn(doc: ReturnType<typeof checkJson>, layer: string): string[] {
  return doc.verdicts.filter((v) => v.edge.includes(layer)).map((v) => v.subject);
}

describe("three-way pact", () => {
  const repos: string[] = [];
  afterAll(() => {
    for (const r of repos) rmSync(r, { recursive: true, force: true });
  });

  it("reports complete triangles, tested-undocumented claims, and untied sections", () => {
    const repo = makeRepo("  - [specs, tests]\n  - [docs, tests]");
    repos.push(repo);

    // Discover the content-derived ids/slugs from an untagged first pass.
    const initial = checkJson(repo);
    const specIds = subjectsOn(initial, "specs").sort();
    const slugs = subjectsOn(initial, "docs").sort();
    const addId = specIds.find((s) => s.startsWith("addition."))!;
    const subId = specIds.find((s) => s.startsWith("subtraction."))!;
    const addingSlug = slugs.find((s) => s.includes("adding"))!;
    const troubleshootingSlug = slugs.find((s) => s.includes("troubleshoot"))!;
    expect(addId && subId && addingSlug && troubleshootingSlug).toBeTruthy();

    // Test A bridges the addition claim to the adding-numbers section (complete triangle).
    writeFileSync(
      path.join(repo, "tests", "calc.spec.ts"),
      `test("@specs:${addId} @docs:${addingSlug} - add", () => {});\n`,
    );
    // Test B covers the subtraction claim only (tested but undocumented).
    writeFileSync(
      path.join(repo, "tests", "sub.spec.ts"),
      `test("@specs:${subId} - subtract", () => {});\n`,
    );
    // Test C covers the troubleshooting section only (untied to any spec claim).
    writeFileSync(
      path.join(repo, "tests", "misc.spec.ts"),
      `test("@docs:${troubleshootingSlug} - restart", () => {});\n`,
    );

    const doc = checkJson(repo);
    expect(doc.pact.complete).toEqual([
      { claim: addId, sections: [addingSlug], tests: ["tests/calc.spec.ts"] },
    ]);
    expect(doc.pact.testedUndocumented).toEqual([
      { claim: subId, tests: ["tests/sub.spec.ts"] },
    ]);
    expect(doc.pact.untiedSections).toEqual([troubleshootingSlug]);

    expect(doc.counts.pactComplete).toBe(1);
    expect(doc.counts.pactTestedUndocumented).toBe(1);
    expect(doc.counts.pactUntiedSections).toBe(1);

    // Human surfaces: check lists the gaps, status prints the one-line summary.
    const human = runCli(["check"], { cwd: repo }).stdout;
    expect(human).toContain("three-way gaps:");
    expect(human).toContain("tested but undocumented (1):");
    expect(human).toContain("untied sections (1):");

    const status = runCli(["status"], { cwd: repo }).stdout;
    expect(status).toContain("three-way: 1 complete · 1 tested-undocumented · 1 untied section(s)");
  });

  it("is all-empty when only a spec↔tests edge is declared (applicability guard)", () => {
    const repo = makeRepo("  - [specs, tests]");
    repos.push(repo);

    const specIds = subjectsOn(checkJson(repo), "specs");
    const addId = specIds.find((s) => s.startsWith("addition."))!;
    writeFileSync(
      path.join(repo, "tests", "calc.spec.ts"),
      `test("@specs:${addId} - add", () => {});\n`,
    );

    const doc = checkJson(repo);
    expect(doc.pact).toEqual({ complete: [], testedUndocumented: [], untiedSections: [] });
    expect(doc.counts.pactComplete).toBe(0);

    // No pact content ⇒ no three-way line in status.
    const status = runCli(["status"], { cwd: repo }).stdout;
    expect(status).not.toContain("three-way:");
  });
});
