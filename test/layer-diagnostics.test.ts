// Layer diagnostics (UAC §5.4, §6.1): a declared layer that matches no files, or a prescriptive/
// descriptive layer that matches files but parses to zero atoms, is surfaced as an advisory warning
// in check (human + --json) and status, without changing the exit code. Driven the foreign-harness
// way: a scratch git repo, the prebuilt CLI, assertions on the --json document and human report.
// @specs:layer-diagnostics.declared-layer-whose-paths
// @specs:layer-diagnostics.prescriptive-descriptive-layer-matches
// @specs:layer-diagnostics.layer-diagnostic-warnings-advisory-they
// @specs:layer-diagnostics.check-parsed-zero-atoms
// @specs:layer-diagnostics.vacuous-check-names-empty
// @specs:layer-diagnostics.check---strict-additionally-treats
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
    expect(report.zeroFileLayers).not.toContain("spec"); // spec matched a file, so not a zero-file case
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

  it("an individual mis-declared layer stays advisory: it warns without raising the exit code", () => {
    // A populated spec layer keeps the check non-vacuous; the extra docs layer matches nothing.
    // That lone empty layer warns but must not gate, so a layer can be declared before it is filled.
    const dir = repo({
      "tripact.yaml": [
        "schemaVersion: 1", "layers:",
        "  spec:", "    role: prescriptive", "    paths:", "      - SPEC.md",
        "  docs:", "    role: descriptive", "    paths:", "      - docs/**/*.md", // nothing there yet
        "  tests:", "    role: verificatory", "    paths:", "      - tests/**/*.spec.ts",
        "edges:", "  - [spec, tests]", "",
      ].join("\n"),
      "SPEC.md": "# Spec\n\n- [ ] a real atom\n",
      "tests/a.spec.ts": `// @${"specs"}:root.real-atom\ntest("a real atom", () => {});\n`,
    });
    const res = runCli(["check"], { cwd: dir });
    expect(res.stdout).toContain("matched no files"); // docs layer warns
    expect(res.stdout).not.toContain("vacuous check"); // spec parsed atoms, so not vacuous
    expect(JSON.parse(runCli(["check", "--json"], { cwd: dir }).stdout).vacuous).toBe(false);
  });

  it("a check parsing 0 atoms across every authoring layer is vacuous — drift, not level", () => {
    // The failure this guards: a wrong glob or unparsable format silently yields an empty claim
    // set, and a naive `✓ level` then certifies a repo the tool never actually read.
    const dir = repo({ "tripact.yaml": TWO_LAYER("specs/*.md", "tests/**/*.spec.ts") });
    const res = runCli(["check"], { cwd: dir });
    expect(res.status).toBe(1);
    expect(res.stdout).toContain("vacuous check");
    expect(res.stdout).not.toContain("✓ level");
    const report = JSON.parse(runCli(["check", "--json"], { cwd: dir }).stdout);
    expect(report.vacuous).toBe(true);
    expect(report.exitCode).toBe(1);
  });

  it("a vacuous check names the empty layers and points at the glob and the spec format", () => {
    const dir = repo({
      "tripact.yaml": TWO_LAYER("SPEC.md", "tests/**/*.spec.ts"),
      "SPEC.md": "# Spec\n\nProse with a lowercase must, which is not a requirement atom.\n",
      "tests/a.spec.ts": "// placeholder\n",
    });
    const out = runCli(["check"], { cwd: dir }).stdout;
    expect(out).toContain("vacuous check"); // leads, before the weaker per-layer warning
    expect(out).toContain("spec"); // names the authoring layer that came up empty
    expect(out).toContain("paths glob"); // first likely cause
    expect(out).toContain("SHALL"); // second: the RFC-2119 keyword requirement
  });

  it("check --strict treats a zero-file or zero-atom layer as drift, for release pipelines", () => {
    // Same repo as the advisory case above: default exit is unaffected by the empty docs layer,
    // while --strict gates on it.
    const dir = repo({
      "tripact.yaml": [
        "schemaVersion: 1", "layers:",
        "  spec:", "    role: prescriptive", "    paths:", "      - SPEC.md",
        "  docs:", "    role: descriptive", "    paths:", "      - docs/**/*.md",
        "  tests:", "    role: verificatory", "    paths:", "      - tests/**/*.spec.ts",
        "edges:", "  - [spec, tests]", "",
      ].join("\n"),
      "SPEC.md": "# Spec\n\n- [ ] a real atom\n",
      "tests/a.spec.ts": `// @${"specs"}:root.real-atom\ntest("a real atom", () => {});\n`,
    });
    expect(runCli(["check", "--strict"], { cwd: dir }).status).toBe(1);
    expect(runCli(["check"], { cwd: dir }).stdout).toContain("matched no files"); // advisory by default
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
