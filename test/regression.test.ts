// Regression tests for the code-review fixes (HEAD 7e362ed follow-up):
//   H1  tag format is derived from the configured tagPattern, not hard-coded
//   H2  a source atom tagged on multiple edges keeps every edge's verified state through accept
//   M2  colliding section slugs are disambiguated within a descriptive layer
//   L4  glob matching is dependency-free (no path.matchesGlob)
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { tagFormatFromPattern } from "../src/config.js";
import { matchesGlob } from "../src/glob.js";
import { disambiguateSlugs, parseMarkdownLayer } from "../src/parser.js";
import type { Group } from "../src/types.js";
import { runCli } from "./helpers/cli.js";

// ---------------------------------------------------------------------------------------------
// H1 — tagFormatFromPattern
// ---------------------------------------------------------------------------------------------
describe("tagFormatFromPattern (H1)", () => {
  // @specs:tripactyaml-schema.layer-accepts-optional-tagpattern
  it("renders the default patterns to their familiar literals", () => {
    expect(tagFormatFromPattern("@specs:([a-z0-9.-]+)", "<id>")).toBe("@specs:<id>");
    expect(tagFormatFromPattern("@docs:([a-z0-9.-]+)", "<slug>")).toBe("@docs:<slug>");
  });

  it("honours a custom literal prefix so the emitted tag matches what the scanner recognises", () => {
    expect(tagFormatFromPattern("@covers:([a-z0-9.-]+)", "<id>")).toBe("@covers:<id>");
    expect(tagFormatFromPattern("@trace-([A-Za-z0-9_-]+)", "<id>")).toBe("@trace-<id>");
  });

  it("unescapes metacharacters and keeps a literal suffix outside the capture group", () => {
    expect(tagFormatFromPattern("\\[spec:([a-z0-9.-]+)\\]", "<id>")).toBe("[spec:<id>]");
  });

  it("skips a non-capturing group to find the real capture", () => {
    // A pattern with an alternation prefix has no single literal rendering, but the capture must
    // still be located past the (?: … ) group rather than mistaken for it.
    expect(tagFormatFromPattern("@x(?:a|b):([a-z0-9.-]+)!", "<id>")).toBe("@x(?:a|b):<id>!");
  });
});

// ---------------------------------------------------------------------------------------------
// L4 — dependency-free glob matcher
// ---------------------------------------------------------------------------------------------
describe("matchesGlob (L4)", () => {
  it("matches * within a segment but not across /", () => {
    expect(matchesGlob("a.md", "*.md")).toBe(true);
    expect(matchesGlob("dir/a.md", "*.md")).toBe(false);
  });
  it("matches ** across directory boundaries, and a/**/b covers a/b", () => {
    expect(matchesGlob("docs/a.md", "docs/**/*.md")).toBe(true);
    expect(matchesGlob("docs/x/y/a.md", "docs/**/*.md")).toBe(true);
    expect(matchesGlob("src/x.spec.js", "**/*.spec.js")).toBe(true);
    expect(matchesGlob("x.spec.js", "**/*.spec.js")).toBe(true);
    expect(matchesGlob("archive/x/y", "archive/**")).toBe(true);
  });
  it("does not match a different extension or a sibling directory", () => {
    expect(matchesGlob("docs/a.txt", "docs/**/*.md")).toBe(false);
    expect(matchesGlob("other/a.md", "docs/**/*.md")).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// M2 — slug disambiguation
// ---------------------------------------------------------------------------------------------
describe("disambiguateSlugs (M2)", () => {
  const groupWith = (file: string, groupPath: string, slug: string): Group => ({
    layer: "docs",
    groupPath,
    slug,
    file,
    line: 1,
    tbd: false,
    atoms: [],
  });

  it("leaves already-unique slugs untouched", () => {
    const gs = [groupWith("a.md", "Setup", "setup"), groupWith("a.md", "Teardown", "teardown")];
    disambiguateSlugs(gs);
    expect(gs.map((g) => g.slug)).toEqual(["setup", "teardown"]);
  });

  it("makes two colliding slugs distinct, deterministically and per-group-identity", () => {
    const a = groupWith("a.md", "Setup", "setup");
    const b = groupWith("b.md", "Setup", "setup");
    disambiguateSlugs([a, b]);
    expect(a.slug).not.toBe(b.slug);
    expect(a.slug.startsWith("setup-")).toBe(true);
    expect(b.slug.startsWith("setup-")).toBe(true);
    // stable: a group's suffix depends only on its own file+heading path
    const a2 = groupWith("a.md", "Setup", "setup");
    disambiguateSlugs([a2, groupWith("b.md", "Setup", "setup")]);
    expect(a2.slug).toBe(a.slug);
  });

  it("cross-file same-heading collisions are the parser's real failure mode", () => {
    const doc = "# Doc\n\n## Adding numbers\n\n- step one\n";
    const g1 = parseMarkdownLayer("docs", "one.md", doc).groups;
    const g2 = parseMarkdownLayer("docs", "two.md", doc).groups;
    const all = [...g1, ...g2];
    expect(new Set(all.map((g) => g.slug)).size).toBe(1); // collide before disambiguation
    disambiguateSlugs(all);
    expect(new Set(all.map((g) => g.slug)).size).toBe(2); // distinct after
  });
});

// ---------------------------------------------------------------------------------------------
// H1 + H2 — end to end against a two-verificatory-edge repo with a custom tag pattern
// ---------------------------------------------------------------------------------------------
const scratch: string[] = [];
afterAll(() => {
  for (const d of scratch) spawnSync("rm", ["-rf", d]);
});

/** A repo where one spec layer is checked against TWO verificatory layers (unit + e2e), the second
 *  of which uses a custom `@covers:` tag pattern. Exercises H1 (custom pattern) and H2 (multi-edge
 *  verified state). Returns the repo path. */
function twoEdgeRepo(): string {
  const repo = mkdtempSync(path.join(os.tmpdir(), "tripact-regress-"));
  scratch.push(repo);
  execFileSync("git", ["init", "-b", "main"], { cwd: repo });
  writeFileSync(
    path.join(repo, "SPECS.md"),
    ["# Spec", "", "## Calculator", "", "- addNumbers returns the sum of two integers", ""].join("\n"),
  );
  writeFileSync(
    path.join(repo, "tripact.yaml"),
    [
      "schemaVersion: 1",
      "layers:",
      "  specs:",
      "    role: prescriptive",
      "    paths: [SPECS.md]",
      "  unit:",
      "    role: verificatory",
      "    paths: [unit/**/*.test.ts]",
      "  e2e:",
      "    role: verificatory",
      "    paths: [e2e/**/*.spec.ts]",
      "    tagPattern: '@covers:([a-z0-9.-]+)'",
      "edges:",
      "  - [specs, unit]",
      "  - [specs, e2e]",
      "",
    ].join("\n"),
  );
  mkdirSync(path.join(repo, "unit"), { recursive: true });
  mkdirSync(path.join(repo, "e2e"), { recursive: true });
  writeFileSync(path.join(repo, "unit", "calc.test.ts"), "// placeholder\n");
  writeFileSync(path.join(repo, "e2e", "calc.spec.ts"), "// placeholder\n");
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "add", "-A"], { cwd: repo });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "init"], { cwd: repo });
  return repo;
}

describe("tasks + accept across two edges (H1, H2)", () => {
  // @specs:prescriptive-verificatory-pv.verificatory-layer-files-scanned
  // @specs:prescriptive-verificatory-pv.lifecycle-uncovered-pending-first
  it("emits the per-edge tag format and reaches level with a claim tagged on both edges", () => {
    const repo = twoEdgeRepo();

    // Discover the claim id from the check report.
    const report = JSON.parse(runCli(["check", "--json"], { cwd: repo }).stdout);
    const id: string = report.verdicts[0].subject;
    expect(id).toBeTruthy();

    // H1: the two edges must instruct different tag formats (default @specs on unit, @covers on e2e).
    const tasks = JSON.parse(runCli(["tasks", "--json"], { cwd: repo }).stdout);
    const formats = new Set(
      tasks.tasks.filter((t: { kind: string }) => t.kind === "write-tests").map((t: { payload: { tagFormat: string } }) => t.payload.tagFormat),
    );
    expect(formats).toEqual(new Set(["@specs:<id>", "@covers:<id>"]));

    // Tag the claim on BOTH edges, each in the format its layer scans for.
    writeFileSync(path.join(repo, "unit", "calc.test.ts"), `// @specs:${id}\ntest("sum", () => {});\n`);
    writeFileSync(path.join(repo, "e2e", "calc.spec.ts"), `// @covers:${id}\ntest("sum", () => {});\n`);

    // Accept, then re-check: H2 requires BOTH edges to be covered (level, exit 0). Under the
    // overwrite bug one edge would fall back to `pending` and check would exit 1 forever.
    const accept = runCli(["accept", "--yes"], { cwd: repo });
    expect(accept.status, accept.stderr).toBe(0);

    const after = runCli(["check", "--json"], { cwd: repo });
    const afterReport = JSON.parse(after.stdout);
    expect(after.status, `expected level; verdicts=${JSON.stringify(afterReport.verdicts)}`).toBe(0);
    const covered = afterReport.verdicts.filter((v: { kind: string }) => v.kind === "covered");
    expect(covered).toHaveLength(2); // specs↔unit AND specs↔e2e

    // And the accepted sidecar records a verified state on each distinct edge for the one atom.
    const sidecar = JSON.parse(readFileSync(path.join(repo, ".tripact", "claims.json"), "utf8"));
    const entry = sidecar.claims.find((c: { id: string }) => c.id === id);
    const edges = new Set(entry.verified.map((v: { edge: string[] }) => v.edge.join("↔")));
    expect(edges).toEqual(new Set(["specs↔unit", "specs↔e2e"]));
  });
});
