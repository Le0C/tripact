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

function checkJson(repo: string): { verdicts: Array<{ edge: [string, string]; subject: string }>; pact: { complete: Array<{ claim: string; sections: string[]; tests: string[] }>; testedUndocumented: Array<{ claim: string; tests: string[] }>; untiedSections: string[] }; counts: Record<string, number>; exitCode: 0 | 1 | 2 } {
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
    // Collapsed by default (UAC §5.2) — the gaps are advisory, so they get one line unless asked.
    const collapsed = runCli(["check"], { cwd: repo }).stdout;
    expect(collapsed).toContain("three-way gaps: 1 tested but undocumented, 1 untied section");
    expect(collapsed).not.toContain("tested but undocumented (1):");

    const human = runCli(["check", "--long"], { cwd: repo }).stdout;
    expect(human).toContain("three-way gaps:");
    expect(human).toContain("tested but undocumented (1):");
    expect(human).toContain("untied sections (1):");

    const status = runCli(["status"], { cwd: repo }).stdout;
    expect(status).toContain("three-way: 1 complete · 1 tested-undocumented · 1 untied section(s)");
  });

  it("@specs:three-way-pact.tags-merely-sharing-test - a @docs: tag elsewhere in the file bridges nothing", () => {
    const repo = makeRepo("  - [specs, tests]\n  - [docs, tests]");
    repos.push(repo);

    const initial = checkJson(repo);
    const specIds = subjectsOn(initial, "specs").sort();
    const addId = specIds.find((s) => s.startsWith("addition."))!;
    const subId = specIds.find((s) => s.startsWith("subtraction."))!;
    const addingSlug = subjectsOn(initial, "docs").find((s) => s.includes("adding"))!;

    // One file, three tags, the section tag on its own line — the shape that used to mark BOTH
    // claims documented on a page describing only addition. Subtraction is not mentioned anywhere
    // in the manual, so a join that called it documented would be inventing coverage.
    writeFileSync(
      path.join(repo, "tests", "calc.spec.ts"),
      [
        `test("@specs:${addId} - add", () => {});`,
        `test("@specs:${subId} - subtract", () => {});`,
        `// @docs:${addingSlug}`,
        "",
      ].join("\n"),
    );

    const doc = checkJson(repo);
    expect(doc.pact.complete).toEqual([]);
    expect(doc.pact.testedUndocumented.map((c: { claim: string }) => c.claim).sort()).toEqual(
      [addId, subId].sort(),
    );
    // The section is test-covered but reaches no claim, which is exactly what "untied" reports.
    expect(doc.pact.untiedSections).toEqual([addingSlug]);
  });

  it("@specs:three-way-pact.bridge-from-spec-claim - the bridge is one line carrying both tags, and it bridges only that line's claims", () => {
    const repo = makeRepo("  - [specs, tests]\n  - [docs, tests]");
    repos.push(repo);

    const initial = checkJson(repo);
    const specIds = subjectsOn(initial, "specs").sort();
    const addId = specIds.find((s) => s.startsWith("addition."))!;
    const subId = specIds.find((s) => s.startsWith("subtraction."))!;
    const addingSlug = subjectsOn(initial, "docs").find((s) => s.includes("adding"))!;

    // Same file as above; the only change is that the section tag now shares the addition line.
    writeFileSync(
      path.join(repo, "tests", "calc.spec.ts"),
      [
        `test("@specs:${addId} @docs:${addingSlug} - add", () => {});`,
        `test("@specs:${subId} - subtract", () => {});`,
        "",
      ].join("\n"),
    );

    const doc = checkJson(repo);
    // Addition bridges; subtraction, in the same file, does not.
    expect(doc.pact.complete).toEqual([
      { claim: addId, sections: [addingSlug], tests: ["tests/calc.spec.ts"] },
    ]);
    expect(doc.pact.testedUndocumented).toEqual([{ claim: subId, tests: ["tests/calc.spec.ts"] }]);
    expect(doc.pact.untiedSections).toEqual([]);
  });

  it("@specs:three-way-pact.three-way-pact-correlates-spectests @specs:three-way-pact.pact-advisory-feeds-no - the pact reports three readings and drives no exit code", () => {
    const repo = makeRepo("  - [specs, tests]\n  - [docs, tests]");
    repos.push(repo);

    const initial = checkJson(repo);
    const specIds = subjectsOn(initial, "specs").sort();
    const addId = specIds.find((s) => s.startsWith("addition."))!;
    const subId = specIds.find((s) => s.startsWith("subtraction."))!;
    const addingSlug = subjectsOn(initial, "docs").find((s) => s.includes("adding"))!;
    const troubleshootingSlug = subjectsOn(initial, "docs").find((s) => s.includes("troubleshoot"))!;

    writeFileSync(
      path.join(repo, "tests", "calc.spec.ts"),
      [
        `test("@specs:${addId} @docs:${addingSlug} - add", () => {});`,
        // Tested, but bridged to no section — an untagged claim would be `uncovered` instead, and
        // uncovered claims are outside the pact entirely.
        `test("@specs:${subId} - subtract", () => {});`,
        `test("@docs:${troubleshootingSlug} - restart", () => {});`,
        "",
      ].join("\n"),
    );

    const doc = checkJson(repo);
    // All three readings present at once: complete, tested-undocumented, untied.
    expect(doc.pact.complete.length).toBe(1);
    expect(doc.pact.testedUndocumented.length).toBe(1);
    expect(doc.pact.untiedSections).toEqual([troubleshootingSlug]);

    // Advisory: the exit code is driven by the edges, not by the pact. Here the tree still has an
    // uncovered claim and an unverified section, so it drifts — but for those reasons, not this one.
    const before = doc.exitCode;
    const accepted = runCli(["accept", "--yes"], { cwd: repo });
    expect(accepted.status).toBe(0);
    const after = checkJson(repo);
    // Still two pact holes after acceptance, and yet the tree is level: the pact moved nothing.
    expect(after.pact.testedUndocumented.length + after.pact.untiedSections.length).toBeGreaterThan(0);
    expect(after.exitCode).toBe(0);
    expect(before).toBe(1);
  });

  it("@specs:three-way-pact.pact-empty-unless-config - is all-empty when only a spec↔tests edge is declared (applicability guard)", () => {
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
