// Shell generator trust boundary (UAC §18.5). `tripact.yaml` is repository-controlled, so a
// `shell:` generator in it is code the repository supplies. Every analysing command regenerates
// derived outputs to judge their freshness, which means `check` — a read-only command by its own
// contract (§5.1) — reaches the spawn just as `generate` does. These tests pin the gate closed by
// default, open under the explicit opt-in, and pin the reporting that keeps a withheld generator
// from being mistaken for either a level result or drift.
//
// Driven the foreign-harness way: a scratch git repo, the prebuilt CLI, assertions on the exit
// code, the --json document and the human report. The generators here write a marker file, so a
// leaked execution is observable rather than merely assumed absent.
// @specs:shell-generator-trust.tripactyaml-repository-controlled-input-so
// @specs:shell-generator-trust.without-opt-in-every-builtin
// @specs:shell-generator-trust.check-reports-each-withheld
// @specs:shell-generator-trust.withheld-shell-generators-never
// @specs:shell-generator-trust.generate-refuses-run-named
// @specs:shell-generator-trust.derived-output-path-block-region
// @specs:generator-resolution-and.generator-string-carrying-no
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { git, runCli } from "./helpers/cli.js";

const scratch: string[] = [];
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});

/** The side-effect a leaked execution leaves behind, relative to the scratch repo root. */
const MARKER = "generator-ran.txt";

/**
 * A repo with one prescriptive atom, one tagged test, and a `derived` entry using `generator`.
 * The tag is assembled at runtime rather than written literally: a literal `@specs:` in this file
 * would be scanned as a real tag by tripact's own check of this repository and reported as an
 * orphan, since the claim it names exists only in these fixtures.
 */
function repo(generator: string, output = "OUT.md"): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tripact-shell-"));
  scratch.push(dir);
  git(dir, ["init", "-b", "main"]);
  const files: Record<string, string> = {
    "tripact.yaml": [
      "schemaVersion: 1",
      "layers:",
      "  spec:",
      "    role: prescriptive",
      "    paths: [SPEC.md]",
      "  tests:",
      "    role: verificatory",
      "    paths: [tests/**/*.spec.ts]",
      "edges:",
      "  - [spec, tests]",
      "derived:",
      "  marker:",
      `    output: ${output}`,
      `    generator: ${JSON.stringify(generator)}`,
      "",
    ].join("\n"),
    "SPEC.md": "# Spec\n\n- [ ] a real atom\n",
    "tests/a.spec.ts": `// @${"specs"}:root.real-atom\ntest("a real atom", () => {});\n`,
  };
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return dir;
}

/** A shell generator that records that it ran, then emits a body. */
const RECORDING = `shell:touch ${MARKER} && echo body`;

describe("shell generator trust boundary (§18.5)", () => {
  it("does not run a shell generator without the opt-in — not even from the read-only check", () => {
    const dir = repo(RECORDING);
    runCli(["check"], { cwd: dir });
    // The whole point: `check` promises it never mutates artefacts (§5.1), and a repo-supplied
    // shell command is the one way it could. The marker is the proof it stayed unrun.
    expect(existsSync(path.join(dir, MARKER))).toBe(false);
  });

  it("runs a shell generator under --allow-shell, and under TRIPACT_ALLOW_SHELL=1", () => {
    const viaFlag = repo(RECORDING);
    runCli(["--allow-shell", "check"], { cwd: viaFlag });
    expect(existsSync(path.join(viaFlag, MARKER))).toBe(true);

    const viaEnv = repo(RECORDING);
    runCli(["check"], { cwd: viaEnv, env: { ...process.env, TRIPACT_ALLOW_SHELL: "1" } });
    expect(existsSync(path.join(viaEnv, MARKER))).toBe(true);
  });

  it("withholds only shell generators: builtin and harness generators still render", () => {
    // A builtin needs no opt-in, so a config with no shell generator behaves exactly as before.
    const dir = repo("builtin:hotlink-map", "HOTLINKS.md");
    const report = JSON.parse(runCli(["check", "--json"], { cwd: dir }).stdout);
    expect(report.shellGeneratorsWithheld).toEqual([]);
    expect(report.counts["shellGeneratorsWithheld"]).toBe(0);
  });

  it("check names each withheld generator, in --json and the human report", () => {
    const dir = repo(RECORDING);
    const report = JSON.parse(runCli(["check", "--json"], { cwd: dir }).stdout);
    expect(report.shellGeneratorsWithheld).toEqual(["marker"]);
    expect(report.counts["shellGeneratorsWithheld"]).toBe(1);
    // It must not be laundered into derivedStale: "I was not allowed to look" is a different
    // claim from "this is out of date", and conflating them sends someone chasing phantom drift.
    expect(report.derivedStale).not.toContain("marker");

    const human = runCli(["check"], { cwd: dir }).stdout;
    expect(human).toContain("marker");
    expect(human).toContain("NOT verified");
    expect(human).toContain("--allow-shell");
  });

  it("a withheld generator does not on its own drive exit 1", () => {
    // Not verifying an output is a capability limit, not evidence of drift. Baseline the tree
    // first so the claim is covered and accepted: that makes the withheld generator the only
    // thing left that could raise the exit code, which is exactly what the claim is about.
    const dir = repo(RECORDING);
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-m", "init"]);
    runCli(["accept", "--yes"], { cwd: dir });
    const res = runCli(["check"], { cwd: dir });
    expect(res.status).toBe(0); // level, despite the withheld generator
    expect(res.stdout).toContain("NOT verified"); // still reported, just not as drift
  });

  it("generate refuses without the opt-in, naming the generator and the flag, and writes nothing", () => {
    const dir = repo(RECORDING);
    const res = runCli(["generate"], { cwd: dir });
    expect(res.status).toBe(2);
    expect(res.stderr).toContain("marker");
    expect(res.stderr).toContain("--allow-shell");
    expect(existsSync(path.join(dir, MARKER))).toBe(false);
    expect(existsSync(path.join(dir, "OUT.md"))).toBe(false); // refused before writing anything
  });

  it("rejects a derived output resolving outside the repository root", () => {
    for (const escape of ["../escaped.md", "../../escaped.md", "/etc/escaped.md"]) {
      const res = runCli(["check"], { cwd: repo("builtin:hotlink-map", escape) });
      expect(res.status).toBe(2); // config error, before any analysis runs
      expect(res.stderr).toContain("outside the repository root");
    }
  });

  it("rejects an unprefixed generator as a config error rather than running it (§18.4)", () => {
    // The regression this locks down: the unprefixed case used to be the default branch straight
    // into the shell, so a mistyped prefix silently became an execution.
    const dir = repo(`touch ${MARKER} && echo body`);
    const res = runCli(["check"], { cwd: dir });
    expect(res.status).toBe(2);
    expect(res.stderr).toContain("no recognised prefix");
    expect(res.stderr).toContain("shell:");
    expect(existsSync(path.join(dir, MARKER))).toBe(false);
  });

  it("still resolves the bare reserved builtin names, so pre-prefix configs keep working", () => {
    const dir = repo("hotlink-map", "HOTLINKS.md"); // bare, no prefix — grandfathered
    expect(runCli(["check"], { cwd: dir }).status).not.toBe(2);
  });
});
