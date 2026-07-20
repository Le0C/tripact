// Navigational code↔spec hotlinks. UAC §20.1 (codeLinks configuration), §20.2 (scanning code links)
// and §20.3 (the hotlink-map derived renderer). Hotlinks are navigation, never verification: the
// assertions here pin that a code tag moves no verdict, no count and no exit code, and that the scan
// and the map are byte-stable for the same tree.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { RESERVED_BUILTINS, HOTLINK_MAP } from "../src/derived.js";
import { analyze } from "../src/engine.js";
import { renderHotlinkMap } from "../src/hotlinks.js";
import { git, runCli } from "./helpers/cli.js";

const scratch: string[] = [];
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});

const SPEC = ["# S", "", "## 1. A", "", "- [ ] thing one happens", "- [ ] thing two happens", ""].join("\n");

/** The layers/edges half of the config, identical with and without a codeLinks block. */
const BASE_CONFIG = [
  "schemaVersion: 1",
  "layers:",
  "  specs:",
  "    role: prescriptive",
  "    paths:",
  "      - SPECS.md",
  "  tests:",
  "    role: verificatory",
  "    paths:",
  "      - tests/**/*.spec.ts",
  "edges:",
  "  - [specs, tests]",
  "",
].join("\n");

const CODE_LINKS = ["codeLinks:", "  paths:", "    - src/**/*.ts", ""].join("\n");

/**
 * A git repo with a prescriptive layer (claims `a.thing-one-happens`, `a.thing-two-happens`), a
 * verificatory layer, and product code under src/. `codeLinks` is opt-in so the with/without
 * comparisons can share one builder.
 */
function repo(opts: { codeLinks?: string; code?: Record<string, string>; tests?: string } = {}): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tripact-hotlinks-"));
  scratch.push(dir);
  execFileSync("git", ["init", "-b", "main"], { cwd: dir });
  writeFileSync(path.join(dir, "SPECS.md"), SPEC);
  writeFileSync(path.join(dir, "tripact.yaml"), BASE_CONFIG + (opts.codeLinks ?? ""));
  mkdirSync(path.join(dir, "tests"), { recursive: true });
  writeFileSync(path.join(dir, "tests", "a.spec.ts"), opts.tests ?? 'test("x", () => {});\n');
  mkdirSync(path.join(dir, "src"), { recursive: true });
  for (const [name, body] of Object.entries(opts.code ?? {})) {
    writeFileSync(path.join(dir, "src", name), body);
  }
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-m", "init"]);
  return dir;
}

/**
 * Build a fixture tag. Assembled rather than written literally so tripact's own verificatory scan
 * over this file does not pick the fixture ids up as orphan tags.
 */
const tag = (id: string) => `@${"specs"}:${id}`;

const LINKED_CODE = [`/** ${tag("a.thing-one-happens")} */`, "export function f() {}", ""].join("\n");
const GHOST_CODE = [`/** ${tag("ghost.does-not-exist")} */`, "export function g() {}", ""].join("\n");
const TAGGED_TEST = [`// ${tag("a.thing-one-happens")}`, 'test("x", () => {});', ""].join("\n");

describe("code-link configuration (§20.1)", () => {
  // @specs:code-link-configuration.codelinks-declared-outside-layers
  it("declares codeLinks outside layers and edges, so the code file set never gets a coverage verdict", () => {
    const dir = repo({ codeLinks: CODE_LINKS, code: { "x.ts": LINKED_CODE + GHOST_CODE } });

    // Config shape: codeLinks is its own top-level block, never a layer or an edge endpoint.
    const cfg = loadConfig(dir);
    expect(cfg.codeLinks).toEqual({ paths: ["src/**/*.ts"] });
    expect(Object.keys(cfg.layers).sort()).toEqual(["specs", "tests"]);
    expect(Object.keys(cfg.layers)).not.toContain("codeLinks");
    expect(cfg.edges).toEqual([["specs", "tests"]]);
    for (const [from, to] of cfg.edges) {
      expect(cfg.layers[from]).toBeDefined();
      expect(cfg.layers[to]).toBeDefined();
    }

    // Behaviour: neither the linked tag nor the ghost tag in src/ produces any verdict or orphan.
    const status = runCli(["status", "--json"], { cwd: dir });
    const report = JSON.parse(status.stdout) as {
      verdicts: Array<{ edge: string[]; subject: string; tags: Array<{ file: string }> }>;
      orphans: unknown[];
    };
    for (const v of report.verdicts) {
      expect(v.edge).toEqual(["specs", "tests"]);
      for (const t of v.tags) expect(t.file.startsWith("src/")).toBe(false);
    }
    expect(report.orphans).toEqual([]);
  });
});

describe("scanning code links (§20.2)", () => {
  // @specs:scanning-code-links.tripact-hotlinks-scans-codelinkspaths
  it("scans codeLinks.paths and reports a navigational link between a claim id and its code file:line", () => {
    const dir = repo({ codeLinks: CODE_LINKS, code: { "x.ts": LINKED_CODE } });

    const json = runCli(["hotlinks", "--json"], { cwd: dir });
    expect(json.status).toBe(0);
    expect(JSON.parse(json.stdout).links).toEqual([
      { claimId: "a.thing-one-happens", file: "src/x.ts", line: 1 },
    ]);

    const human = runCli(["hotlinks"], { cwd: dir });
    expect(human.status).toBe(0);
    expect(human.stdout).toContain("src/x.ts:1 → a.thing-one-happens");
  });

  // @specs:scanning-code-links.hotlink-scanning-never-affects
  it("never affects an edge verdict, a coverage count, or an exit code", () => {
    const code = { "x.ts": LINKED_CODE + GHOST_CODE };
    const without = repo({ tests: TAGGED_TEST, code });
    const withLinks = repo({ codeLinks: CODE_LINKS, tests: TAGGED_TEST, code });

    const a = runCli(["check", "--json"], { cwd: without });
    const b = runCli(["check", "--json"], { cwd: withLinks });
    // Byte-identical payload and identical exit code: the code tags moved nothing.
    expect(b.stdout).toBe(a.stdout);
    expect(b.status).toBe(a.status);

    const counts = JSON.parse(b.stdout).counts as Record<string, number>;
    expect(counts.covered).toBe(0);
    expect(counts.pending).toBe(1);
    expect(counts.orphans).toBe(0);
    // The scan itself is advisory even while `check` is gating on drift.
    expect(runCli(["hotlinks"], { cwd: withLinks }).status).toBe(0);
  });

  // @specs:scanning-code-links.code-tag-referencing-id
  it("reports an unknown id as a navigational orphan with its file:line", () => {
    const dir = repo({ codeLinks: CODE_LINKS, code: { "x.ts": GHOST_CODE } });

    const json = runCli(["hotlinks", "--json"], { cwd: dir });
    expect(json.status).toBe(0);
    expect(JSON.parse(json.stdout).orphans).toEqual([
      { tag: "ghost.does-not-exist", file: "src/x.ts", line: 1 },
    ]);
    expect(runCli(["hotlinks"], { cwd: dir }).stdout).toContain(
      "ORPHAN src/x.ts:1 → ghost.does-not-exist (unknown claim)",
    );
  });

  // @specs:scanning-code-links.code-tag-referencing-id
  it("reports a dead id as an orphan hinting at the claim's last text", () => {
    const dead = [`/** ${tag("a.thing-two-happens")} */`, "export function g() {}", ""].join("\n");
    const dir = repo({ codeLinks: CODE_LINKS, code: { "x.ts": dead } });
    // Baseline both claims into the sidecar, then retire the second one from the spec.
    expect(runCli(["accept", "--yes"], { cwd: dir }).status).toBe(0);
    writeFileSync(path.join(dir, "SPECS.md"), SPEC.replace("- [ ] thing two happens\n", ""));
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-m", "retire"]);
    expect(runCli(["accept", "--yes"], { cwd: dir }).status).toBe(0);

    const json = runCli(["hotlinks", "--json"], { cwd: dir });
    expect(json.status).toBe(0);
    expect(JSON.parse(json.stdout).orphans).toEqual([
      {
        tag: "a.thing-two-happens",
        file: "src/x.ts",
        line: 1,
        deadClaimLastText: "thing two happens",
      },
    ]);
    expect(runCli(["hotlinks"], { cwd: dir }).stdout).toContain(
      'ORPHAN src/x.ts:1 → a.thing-two-happens (dead: "thing two happens")',
    );
  });

  // @specs:scanning-code-links.hotlinks---json-emits-machine-readable
  it("emits a schemaVersion'd map on --json and exits 0 even while the repo is in drift", () => {
    const dir = repo({ codeLinks: CODE_LINKS, code: { "x.ts": LINKED_CODE } });
    expect(runCli(["check"], { cwd: dir }).status).toBe(1); // the repo is in drift

    const json = runCli(["hotlinks", "--json"], { cwd: dir });
    expect(json.status).toBe(0);
    const report = JSON.parse(json.stdout);
    expect(report.schemaVersion).toBe(1);
    expect(Object.keys(report).sort()).toEqual(["links", "orphans", "schemaVersion"]);
  });

  // @specs:scanning-code-links.hotlinks---json-emits-machine-readable
  it("exits 2 — never 1 — on a config error or a usage error", () => {
    const bad = repo({
      codeLinks: ["codeLinks:", "  paths:", '    - ""', "  tagPattern: '@specs:(['", ""].join("\n"),
    });
    const cfgErr = runCli(["hotlinks", "--json"], { cwd: bad });
    expect(cfgErr.status).toBe(2);
    expect(cfgErr.stderr).toContain("codeLinks.paths[0]: empty glob");
    expect(cfgErr.stderr).toContain("codeLinks.tagPattern: invalid pattern");

    const ok = repo({ codeLinks: CODE_LINKS, code: { "x.ts": LINKED_CODE } });
    const usageErr = runCli(["hotlinks", "--bogus"], { cwd: ok });
    expect(usageErr.status).toBe(2);
    expect(usageErr.stderr).toContain("unknown option");
  });

  // @specs:scanning-code-links.scanning-deterministic-identical-tree
  it("is deterministic: an identical tree yields an identical, stably ordered map", () => {
    const dir = repo({
      codeLinks: CODE_LINKS,
      code: {
        // Written out of order (z before b, later line before earlier) on purpose.
        "z.ts": LINKED_CODE,
        "b.ts": ["", `/** ${tag("a.thing-one-happens")} */`, "export function b2() {}", ""].join("\n"),
        "a.ts": GHOST_CODE + GHOST_CODE.replace("g()", "g2()"),
      },
    });

    const first = runCli(["hotlinks", "--json"], { cwd: dir });
    const second = runCli(["hotlinks", "--json"], { cwd: dir });
    expect(first.status).toBe(0);
    expect(second.stdout).toBe(first.stdout);

    const report = JSON.parse(first.stdout) as {
      links: Array<{ file: string; line: number }>;
      orphans: Array<{ file: string; line: number }>;
    };
    expect(report.links.map((l) => `${l.file}:${l.line}`)).toEqual(["src/b.ts:2", "src/z.ts:1"]);
    expect(report.orphans.map((o) => `${o.file}:${o.line}`)).toEqual(["src/a.ts:1", "src/a.ts:3"]);
  });
});

describe("hotlink map (§20.3)", () => {
  // @specs:hotlink-map.kernel-provides-reserved-hotlink-map
  it("renders the reserved hotlink-map: spec file:line, code tags and covering test tags, byte-identically", () => {
    const dir = repo({
      codeLinks: CODE_LINKS,
      tests: TAGGED_TEST,
      code: { "x.ts": LINKED_CODE, "z.ts": LINKED_CODE },
    });

    expect(RESERVED_BUILTINS.has(HOTLINK_MAP)).toBe(true);
    expect(HOTLINK_MAP).toBe("hotlink-map");

    const rendered = renderHotlinkMap(analyze(dir, { skipDerived: true }), dir);
    expect(JSON.parse(rendered)).toEqual({
      schemaVersion: 1,
      claims: [
        {
          claimId: "a.thing-one-happens",
          spec: { file: "SPECS.md", line: 5 },
          code: [
            { file: "src/x.ts", line: 1 },
            { file: "src/z.ts", line: 1 },
          ],
          tests: [{ file: "tests/a.spec.ts", line: 1 }],
        },
      ],
    });
    // Same tree → byte-identical output.
    expect(renderHotlinkMap(analyze(dir, { skipDerived: true }), dir)).toBe(rendered);
  });

  // @specs:hotlink-map.writing-hotlink-decoration-comment
  it("never edits product code: the map derivation is a pure render and the scan writes nothing", () => {
    const dir = repo({ codeLinks: CODE_LINKS, code: { "x.ts": LINKED_CODE } });
    const codePath = path.join(dir, "src", "x.ts");
    const before = readFileSync(codePath, "utf8");

    expect(runCli(["hotlinks"], { cwd: dir }).status).toBe(0);
    renderHotlinkMap(analyze(dir, { skipDerived: true }), dir);

    expect(readFileSync(codePath, "utf8")).toBe(before);
    // No decoration comment was written into the tagged function, and nothing else moved either.
    expect(git(dir, ["status", "--porcelain"])).toBe("");
  });
});
