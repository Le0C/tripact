// Config loading + validation. UAC §2.1 (schema) and §2.2 (all-at-once validation), plus the
// §20.1 codeLinks block. loadConfig is pure over a repo root, so most of this needs no git — a
// temp dir with a tripact.yaml is enough. The two exit-code claims drive the real CLI.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/config.js";
import { git, runCli } from "./helpers/cli.js";

const scratch: string[] = [];
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});

/** Write a tripact.yaml into a fresh temp dir and return the dir. */
function repoWith(yaml: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tripact-config-"));
  scratch.push(dir);
  writeFileSync(path.join(dir, "tripact.yaml"), yaml);
  return dir;
}

const VALID = [
  "schemaVersion: 1",
  "layers:",
  "  specs:",
  "    role: prescriptive",
  "    paths: [UAC.md]",
  "    conventions: conventions/specs.md",
  "  manual:",
  "    role: descriptive",
  "    paths: [docs/**/*.md]",
  "  tests:",
  "    role: verificatory",
  "    paths: [test/**/*.test.ts]",
  "    tagPattern: '@specs:([a-z0-9.-]+)'",
  "edges:",
  "  - [specs, tests]",
  "  - [manual, tests]",
].join("\n");

describe("config schema (§2.1)", () => {
  // @specs:tripactyaml-schema.kernel-reads-tripactyaml-from
  // @specs:tripactyaml-schema.config-declares-named-layers
  // @specs:tripactyaml-schema.config-declares-edges-explicitly
  it("reads tripact.yaml from the root and accepts declared layers + edges", () => {
    const cfg = loadConfig(repoWith(VALID));
    expect(cfg.schemaVersion).toBe(1);
    expect(Object.keys(cfg.layers).sort()).toEqual(["manual", "specs", "tests"]);
    expect(cfg.layers.specs!.role).toBe("prescriptive");
    expect(cfg.layers.specs!.conventions).toBe("conventions/specs.md");
    expect(cfg.edges).toEqual([
      ["specs", "tests"],
      ["manual", "tests"],
    ]);
  });

  // @specs:tripactyaml-schema.config-accepts-optional-pathmap
  // @specs:tripactyaml-schema.config-accepts-optional-exclude
  // @specs:tripactyaml-schema.config-accepts-optional-accept
  // @specs:tripactyaml-schema.config-accepts-optional-routing
  // @specs:tripactyaml-schema.config-accepts-optional-commands
  it("accepts every optional block — pathMap, exclude, accept, routing/models, commands/runners/derived/codeLinks", () => {
    const cfg = loadConfig(
      repoWith(
        [
          VALID,
          "pathMap:",
          "  'src/**': [specs]",
          "exclude: ['archive/**']",
          "accept:",
          "  policy: agents",
          "routing:",
          "  write-tests: implementation",
          "models:",
          "  implementation: claude-opus",
          "commands:",
          "  test: pnpm test",
          "runners:",
          "  default: 'run {promptFile} {model} {cwd}'",
          "derived:",
          "  ref: { output: docs/ref.md, generator: cli-reference }",
          "codeLinks:",
          "  paths: ['src/**/*.ts']",
        ].join("\n"),
      ),
    );
    expect(cfg.pathMap).toEqual({ "src/**": ["specs"] });
    expect(cfg.exclude).toEqual(["archive/**"]);
    expect(cfg.accept!.policy).toBe("agents");
    expect(cfg.routing!["write-tests"]).toBe("implementation");
    expect(cfg.models!.implementation).toBe("claude-opus");
    expect(cfg.commands!.test).toBe("pnpm test");
    expect(cfg.runners!.default).toContain("{promptFile}");
    expect(cfg.derived!.ref!.generator).toBe("cli-reference");
  });
});

describe("config validation (§2.2)", () => {
  // @specs:validation-behaviour.config-fewer-than-two
  it("a config with fewer than two layers is rejected", () => {
    const yaml = ["schemaVersion: 1", "layers:", "  specs:", "    role: prescriptive", "    paths: [UAC.md]", "edges: []"].join("\n");
    expect(() => loadConfig(repoWith(yaml))).toThrow(ConfigError);
    try {
      loadConfig(repoWith(yaml));
    } catch (e) {
      expect((e as ConfigError).problems.join("\n")).toContain("at least 2 layers");
    }
  });

  // @specs:validation-behaviour.unknown-role-edge-referencing
  // @specs:validation-behaviour.check-every-other-command
  it("reports every semantic problem at once, each naming its key", () => {
    // Valid schema (roles/structure fine) but three semantic faults: an edge to an undeclared
    // layer, an unknown accept policy, and an unknown routing tier. All must surface together.
    const yaml = [
      VALID,
      "accept:",
      "  policy: robot",
      "routing:",
      "  write-tests: wizardry",
    ]
      .join("\n")
      .replace("  - [manual, tests]", "  - [specs, ghost]");
    let problems: string[] = [];
    try {
      loadConfig(repoWith(yaml));
    } catch (e) {
      problems = (e as ConfigError).problems;
    }
    const joined = problems.join("\n");
    expect(problems.length, joined).toBeGreaterThanOrEqual(3);
    expect(joined).toContain("ghost"); // undeclared edge layer named
    expect(joined).toContain("accept.policy"); // offending key path named
    expect(joined).toContain("routing.write-tests"); // offending key path named
  });

  it("an unknown role is rejected (schema-level)", () => {
    const yaml = [
      "schemaVersion: 1",
      "layers:",
      "  a:",
      "    role: descriptive",
      "    paths: [a.md]",
      "  b:",
      "    role: sideways", // not a valid role
      "    paths: [b.md]",
      "edges: [[a, b]]",
    ].join("\n");
    expect(() => loadConfig(repoWith(yaml))).toThrow(ConfigError);
  });
});

describe("codeLinks configuration (§20.1)", () => {
  // @specs:code-link-configuration.tripactyaml-accepts-optional-codelinks
  it("accepts a codeLinks block with paths and an optional tagPattern", () => {
    const cfg = loadConfig(
      repoWith([VALID, "codeLinks:", "  paths: ['src/**/*.ts']", "  tagPattern: '@impl:([a-z0-9.-]+)'"].join("\n")),
    );
    expect(cfg.codeLinks!.paths).toEqual(["src/**/*.ts"]);
    expect(cfg.codeLinks!.tagPattern).toBe("@impl:([a-z0-9.-]+)");
  });

  // @specs:code-link-configuration.invalid-codelinks-block-fails
  it("an invalid codeLinks tagPattern is rejected, naming the key", () => {
    const yaml = [VALID, "codeLinks:", "  paths: ['src/**/*.ts']", "  tagPattern: '@impl:([a-z0-9.-]+'"].join("\n"); // unbalanced (
    try {
      loadConfig(repoWith(yaml));
      throw new Error("expected ConfigError");
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as ConfigError).problems.join("\n")).toContain("codeLinks.tagPattern");
    }
  });
});

describe("check refuses an invalid config (§2.2 exit code)", () => {
  // @specs:validation-behaviour.check-every-other-command
  it("check against an invalid config exits 2 without running", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "tripact-config-e2e-"));
    scratch.push(dir);
    git(dir, ["init", "-b", "main"]);
    // one-layer config is invalid (§2.2)
    writeFileSync(
      path.join(dir, "tripact.yaml"),
      ["schemaVersion: 1", "layers:", "  specs:", "    role: prescriptive", "    paths: [UAC.md]", "edges: []"].join("\n"),
    );
    const r = runCli(["check"], { cwd: dir });
    expect(r.status, r.stderr).toBe(2);
  });
});
