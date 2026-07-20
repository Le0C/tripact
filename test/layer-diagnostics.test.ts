// Layer diagnostics (UAC §5.4, §6.1): a declared layer that matches no files, or a prescriptive/
// descriptive layer that matches files but parses to zero atoms, is surfaced as an advisory warning
// in check (human + --json) and status — without changing the exit code. Driven the foreign-harness
// way: a scratch git repo, the prebuilt CLI, assertions on the --json document and human report.
// @specs:layer-diagnostics.declared-layer-whose-paths
// @specs:layer-diagnostics.prescriptive-descriptive-layer-matches
// @specs:layer-diagnostics.layer-diagnostic-warnings-advisory-they
// @specs:tripact-status.status-marks-any-zero-file
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { git, runCli } from "./helpers/cli.js";

const scratch: string[] = [];
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});

function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tripact-diag-"));
  scratch.push(dir);
  git(dir, ["init", "-b", "main"]);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return dir;
}

const TWO_LAYER = (specPaths: string, testPaths: string) =>
  ["schemaVersion: 1", "layers:", "  spec:", "    role: prescriptive", "    paths:", `      - ${specPaths}`,
    "  tests:", "    role: verificatory", "    paths:", `      - ${testPaths}`, "edges:", "  - [spec, tests]", ""].join("\n");

describe("layer diagnostics (§5.4)", () => {
  it("flags a declared layer whose paths match no files as zeroFileLayers, in --json and the human report", () => {
    const dir = repo({ "tripact.yaml": TWO_LAYER("specs/*.md", "tests/**/*.spec.ts") }); // neither dir exists
    const report = JSON.parse(runCli(["check", "--json"], { cwd: dir }).stdout);
    expect(report.zeroFileLayers.sort()).toEqual(["spec", "tests"]);
    expect(report.counts["zeroFileLayers"]).toBe(2);
    expect(runCli(["check"], { cwd: dir }).stdout).toContain("matched no files");
  });

  it("flags a prescriptive layer that matches files but parses to 0 atoms as zeroAtomLayers", () => {
    const dir = repo({
      "tripact.yaml": TWO_LAYER("SPEC.md", "tests/**/*.spec.ts"),
      "SPEC.md": "# Spec\n\nThis is prose with no list items, so it yields no atoms.\n",
      "tests/a.spec.ts": "// placeholder test file\n",
    });
    const report = JSON.parse(runCli(["check", "--json"], { cwd: dir }).stdout);
    expect(report.zeroAtomLayers).toEqual(["spec"]);
    expect(report.counts["zeroAtomLayers"]).toBe(1);
    expect(report.zeroFileLayers).not.toContain("spec"); // it matched a file — not a zero-file case
    expect(runCli(["check"], { cwd: dir }).stdout).toContain("parsed to 0 atoms");
  });

  it("verificatory layers are never zeroAtomLayers (they carry no atoms by design)", () => {
    const dir = repo({
      "tripact.yaml": TWO_LAYER("SPEC.md", "tests/**/*.spec.ts"),
      "SPEC.md": "# Spec\n\n- a real atom\n",
      "tests/a.spec.ts": "// a present but empty test file\n",
    });
    const report = JSON.parse(runCli(["check", "--json"], { cwd: dir }).stdout);
    expect(report.zeroAtomLayers).toEqual([]); // tests matched a file; spec has an atom
  });

  it("layer-diagnostic warnings are advisory: a zero-file/zero-atom layer alone does not raise the exit code", () => {
    // spec + tests both match nothing → no atoms, no verdicts → level (exit 0) despite the warning.
    const dir = repo({ "tripact.yaml": TWO_LAYER("specs/*.md", "tests/**/*.spec.ts") });
    const res = runCli(["check"], { cwd: dir });
    expect(res.status).toBe(0); // warning present, but exit stays 0 — advisory only
    expect(res.stdout).toContain("warning:");
    expect(res.stdout).toContain("level");
  });

  it("status marks a zero-file layer and a zero-atom prescriptive layer inline (§6.1)", () => {
    const dir = repo({
      "tripact.yaml": TWO_LAYER("SPEC.md", "tests/**/*.spec.ts"), // SPEC.md prose → 0 atoms; tests → 0 files
      "SPEC.md": "# Spec\n\nProse only, no atoms.\n",
    });
    const status = runCli(["status"], { cwd: dir }).stdout;
    expect(status).toMatch(/layer spec .*⚠ 0 atoms/);
    expect(status).toMatch(/layer tests .*⚠ no files/);
  });
});
