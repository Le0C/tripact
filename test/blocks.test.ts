// Block-level derived regions (UAC §18.3): a generated fragment fenced inside a hand-written file.
//
// The parser assertions here are the load-bearing ones. Whole-file derived outputs stay out of every
// layer through `exclude`, so their content never parses as claims; a block has no such escape, since
// the file is a source artefact and only a region of it is generated. If the parser ever stopped
// skipping these regions, `generate` would start rewriting claim-bearing text.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { findBlockRegions, replaceBlockRegions } from "../src/blocks.js";
import { parseLayerFile } from "../src/parser.js";
import { runCli } from "./helpers/cli.js";

const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

/** A scratch repo whose `blocks` config scans DOC.md, plus the two-layer floor the config needs. */
function blocksRepo(doc: string, generators: Record<string, string>, paths = ["DOC.md"]): string {
  const repo = mkdtempSync(path.join(os.tmpdir(), "tripact-blocks-"));
  scratch.push(repo);
  execFileSync("git", ["init", "-b", "main"], { cwd: repo });
  writeFileSync(path.join(repo, "DOC.md"), doc);
  writeFileSync(path.join(repo, "SPECS.md"), "# Spec\n\n## One\n\n- a claim that exists\n");
  mkdirSync(path.join(repo, "tests"), { recursive: true });
  writeFileSync(path.join(repo, "tests", "a.test.ts"), 'test("x", () => {});\n');
  const gen = Object.entries(generators)
    .map(([name, command]) => `    ${name}: ${JSON.stringify(command)}`)
    .join("\n");
  writeFileSync(
    path.join(repo, "tripact.yaml"),
    [
      "schemaVersion: 1",
      "layers:",
      "  spec:",
      "    role: prescriptive",
      "    paths: [SPECS.md]",
      "  tests:",
      "    role: verificatory",
      "    paths: [tests/**/*.test.ts]",
      "edges:",
      "  - [spec, tests]",
      "blocks:",
      `  paths: [${paths.join(", ")}]`,
      "  generators:",
      gen,
      "",
    ].join("\n"),
  );
  return repo;
}

const fence = (name: string, body: string) =>
  [`<!-- tripact:${name} -->`, body, `<!-- /tripact:${name} -->`].join("\n");

describe("block-level derived regions (UAC §18.3)", () => {
  it("config accepts a blocks block and a region never produces a coverage verdict", () => {
    // @specs:block-level-derived-regions.config-accepts-optional-blocks
    const repo = blocksRepo(`# Doc\n\n${fence("t", "generated")}\n`, { t: "shell:printf 'generated'" });
    const res = runCli(["--allow-shell", "check", "--json"], { cwd: repo });
    const json = JSON.parse(res.stdout);
    // The config loads (no exit 2) and the block contributes no verdict of its own: the only
    // subjects are the spec layer's claims, none of which come from DOC.md.
    expect(res.status).not.toBe(2);
    expect(json.verdicts.every((v: { subject: string }) => !v.subject.includes("doc"))).toBe(true);
    expect(json.blockStale).toEqual([]);
  });

  it("generate replaces the region and leaves the fences and surrounding file byte-identical", () => {
    // @specs:block-level-derived-regions.block-region-fenced-opening
    const before = `# Doc\n\nintro paragraph\n\n${fence("t", "OLD")}\n\ntrailing paragraph\n`;
    const repo = blocksRepo(before, { t: "shell:printf 'NEW BODY'" });
    expect(runCli(["--allow-shell", "generate"], { cwd: repo }).status).toBe(0);
    const after = readFileSync(path.join(repo, "DOC.md"), "utf8");
    expect(after).toBe(`# Doc\n\nintro paragraph\n\n${fence("t", "NEW BODY")}\n\ntrailing paragraph\n`);
    // Everything outside the region survived unchanged, fences included.
    expect(after.split("\n").filter((l) => !l.includes("NEW BODY") && !l.includes("OLD"))).toEqual(
      before.split("\n").filter((l) => !l.includes("NEW BODY") && !l.includes("OLD")),
    );
  });

  it("regenerating a region twice produces a byte-identical file", () => {
    // @specs:block-level-derived-regions.regenerating-block-region-twice
    // The generator ends its output with a newline, which is where an off-by-one would land: a naive
    // implementation grows the region by a blank line on every run.
    const repo = blocksRepo(`# Doc\n\n${fence("t", "x")}\n`, { t: "shell:printf 'line one\\nline two\\n'" });
    expect(runCli(["--allow-shell", "generate"], { cwd: repo }).status).toBe(0);
    const once = readFileSync(path.join(repo, "DOC.md"), "utf8");
    expect(runCli(["--allow-shell", "generate"], { cwd: repo }).status).toBe(0);
    expect(readFileSync(path.join(repo, "DOC.md"), "utf8")).toBe(once);
  });

  it("the parser yields no atom and no group from inside a region, and line numbers continue", () => {
    // @specs:block-level-derived-regions.markdown-parser-produces-no
    const doc = [
      "# Title", // 1
      "", // 2
      "## Real Section", // 3
      "", // 4
      "- a real claim", // 5
      "", // 6
      "<!-- tripact:t -->", // 7
      "## Generated Heading", // 8
      "", // 9
      "- a generated bullet", // 10
      "- another generated bullet", // 11
      "<!-- /tripact:t -->", // 12
      "", // 13
      "- a claim after the region", // 14
      "",
    ].join("\n");
    const parsed = parseLayerFile("spec", "DOC.md", doc);
    const texts = parsed.atoms.map((a) => a.raw);
    expect(texts).toEqual(["a real claim", "a claim after the region"]);
    // No group was opened by the generated heading.
    expect(parsed.groups.map((g) => g.groupPath)).not.toContain("Generated Heading");
    expect(parsed.groups.some((g) => g.groupPath.includes("Generated"))).toBe(false);
    // Line numbering counted through the skipped region, so the trailing claim keeps its true line.
    expect(parsed.atoms.find((a) => a.raw === "a claim after the region")?.line).toBe(14);
  });

  it("a fence shown inside a code block is content, not a region", () => {
    // Documentation that demonstrates the syntax must not be treated as a region to fill, which is
    // also why this repo's own spec doc can show the markers.
    const doc = ["# Doc", "", "```markdown", "<!-- tripact:t -->", "example", "<!-- /tripact:t -->", "```", ""].join("\n");
    expect(findBlockRegions(doc, "DOC.md")).toEqual([]);
  });

  it("check reports a stale region and queues a regenerate-derived task", () => {
    // @specs:block-level-derived-regions.check-regenerates-each-declared
    const repo = blocksRepo(`# Doc\n\n${fence("t", "STALE")}\n`, { t: "shell:printf 'FRESH'" });
    const res = runCli(["--allow-shell", "check", "--json"], { cwd: repo });
    expect(res.status).toBe(1);
    const json = JSON.parse(res.stdout);
    expect(json.blockStale).toHaveLength(1);
    expect(json.counts.blockStale).toBe(1);
    const queue = JSON.parse(runCli(["--allow-shell", "tasks", "--json"], { cwd: repo }).stdout);
    expect(queue.tasks.some((t: { kind: string }) => t.kind === "regenerate-derived")).toBe(true);
    // Regenerating clears it.
    expect(runCli(["--allow-shell", "generate"], { cwd: repo }).status).toBe(0);
    expect(JSON.parse(runCli(["--allow-shell", "check", "--json"], { cwd: repo }).stdout).blockStale).toEqual([]);
  });

  it("a stale finding is identified by name, file and line, so two regions do not collapse", () => {
    // @specs:block-level-derived-regions.block-level-derived-stale-finding-identified
    const doc = `# Doc\n\n${fence("t", "STALE")}\n\nmiddle\n\n${fence("t", "ALSO STALE")}\n`;
    const repo = blocksRepo(doc, { t: "shell:printf 'FRESH'" });
    const json = JSON.parse(runCli(["--allow-shell", "check", "--json"], { cwd: repo }).stdout);
    expect(json.blockStale).toHaveLength(2);
    expect(json.blockStale.map((b: { name: string }) => b.name)).toEqual(["t", "t"]);
    expect(json.blockStale.every((b: { file: string }) => b.file === "DOC.md")).toBe(true);
    // Two regions of one generator are two distinct findings at two distinct lines.
    const lines = json.blockStale.map((b: { line: number }) => b.line);
    expect(new Set(lines).size).toBe(2);
    // And two distinct tasks, rather than one id colliding with the other.
    const queue = JSON.parse(runCli(["--allow-shell", "tasks", "--json"], { cwd: repo }).stdout);
    const ids = queue.tasks.filter((t: { kind: string }) => t.kind === "regenerate-derived").map((t: { id: string }) => t.id);
    expect(new Set(ids).size).toBe(2);
  });

  it("a non-deterministic block generator is reported as such rather than as stale", () => {
    // @specs:block-level-derived-regions.block-generator-whose-two
    // Each run returns a different number, so regeneration could never make check pass. Reporting it
    // stale would be a permanent misdiagnosis of a fixable config fault.
    const counter = "shell:n=$(cat .ctr 2>/dev/null || echo 0); n=$((n+1)); echo $n > .ctr; printf \"%s\" $n";
    const repo = blocksRepo(`# Doc\n\n${fence("t", "0")}\n`, { t: counter });
    const json = JSON.parse(runCli(["--allow-shell", "check", "--json"], { cwd: repo }).stdout);
    expect(json.nonDeterministicGenerators).toContain("t");
    expect(json.blockStale).toEqual([]);
  });

  it("an undeclared generator, an unclosed fence and a nested fence each exit 2", () => {
    // @specs:block-level-derived-regions.marker-naming-generator-absent
    const undeclared = blocksRepo(`# Doc\n\n${fence("nope", "x")}\n`, { t: "shell:printf 'x'" });
    const undeclaredRes = runCli(["check"], { cwd: undeclared });
    expect(undeclaredRes.status).toBe(2);
    expect(undeclaredRes.stderr).toContain("nope");

    const unclosed = blocksRepo(`# Doc\n\n<!-- tripact:t -->\nbody\n`, { t: "shell:printf 'x'" });
    expect(runCli(["check"], { cwd: unclosed }).status).toBe(2);

    const nested = blocksRepo(
      `# Doc\n\n<!-- tripact:t -->\n<!-- tripact:t -->\nbody\n<!-- /tripact:t -->\n<!-- /tripact:t -->\n`,
      { t: "shell:printf 'x'" },
    );
    expect(runCli(["check"], { cwd: nested }).status).toBe(2);
  });

  it("malformed fences report all-at-once rather than one per run", () => {
    // §2.2 reporting: fixing a repo with several bad markers should not be an iterative guess.
    const repo = blocksRepo(`# Doc\n\n${fence("nope", "x")}\n\n${fence("alsonope", "y")}\n`, { t: "shell:printf 'x'" });
    const res = runCli(["check"], { cwd: repo });
    expect(res.status).toBe(2);
    expect(res.stderr).toContain("nope");
    expect(res.stderr).toContain("alsonope");
  });

  it("replaceBlockRegions leaves a file with no regions untouched", () => {
    const content = "# Doc\n\njust prose\n";
    expect(replaceBlockRegions(content, findBlockRegions(content, "DOC.md"), () => "x")).toBe(content);
  });
});
