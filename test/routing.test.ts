// Effort routing — UAC §16.1. `tripact.yaml` may carry a `routing` map (task class → effort tier)
// and a `models` map (effort tier → model identifier). Those bindings resolve into advisory
// `effort`/`model` hints on emitted tasks (src/tasks.ts) and on escalation questions (src/engine.ts,
// via the `adjudicate` class). Routing/models entries validate all-at-once with the rest of the
// config (§2.2). loadConfig + hintsFor are pure over a repo root, so the schema/validation claims
// need no git; the hint-propagation claims drive the real CLI over a committed scratch repo.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ConfigError, hintsFor, loadConfig } from "../src/config.js";
import { runCli } from "./helpers/cli.js";
import { MANUAL, SPECS, TESTS } from "./helpers/fixture.js";

const scratch: string[] = [];
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});

// The layer block every config in this file reuses; matches the three-layer fixture wiring so the
// only variable under test is the routing/models config.
const LAYERS = [
  "schemaVersion: 1",
  "layers:",
  "  specs:",
  "    role: prescriptive",
  "    paths:",
  "      - SPECS.md",
  "  docs:",
  "    role: descriptive",
  "    paths:",
  "      - docs/manual/**/*.md",
  "  tests:",
  "    role: verificatory",
  "    paths:",
  "      - tests/**/*.spec.ts",
  "edges:",
  "  - [specs, tests]",
  "  - [docs, tests]",
].join("\n");

/** A temp dir carrying just a tripact.yaml (no git) — enough for loadConfig, which is pure. */
function configOnly(yaml: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tripact-routing-cfg-"));
  scratch.push(dir);
  writeFileSync(path.join(dir, "tripact.yaml"), yaml);
  return dir;
}

/** A committed git repo with all three layers plus the supplied tripact.yaml. */
function repoWith(yaml: string): string {
  const repo = mkdtempSync(path.join(os.tmpdir(), "tripact-routing-repo-"));
  scratch.push(repo);
  execFileSync("git", ["init", "-b", "main"], { cwd: repo });
  writeFileSync(path.join(repo, "SPECS.md"), SPECS);
  writeFileSync(path.join(repo, "tripact.yaml"), yaml);
  mkdirSync(path.join(repo, "docs", "manual"), { recursive: true });
  writeFileSync(path.join(repo, "docs", "manual", "using.md"), MANUAL);
  mkdirSync(path.join(repo, "tests", "e2e"), { recursive: true });
  writeFileSync(path.join(repo, "tests", "e2e", "calc.spec.ts"), TESTS);
  commit(repo, "init");
  return repo;
}

function commit(repo: string, message: string): void {
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "add", "-A"], { cwd: repo });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", message], { cwd: repo });
}

describe("effort routing — schema (§16.1)", () => {
  // @specs:effort-routing.tripactyaml-accepts-routing-map
  it("accepts a routing map (class → effort tier, all four tiers) and a models map (tier → identifier)", () => {
    const cfg = loadConfig(
      configOnly(
        [
          LAYERS,
          "routing:",
          "  write-tests: judgment",
          "  cover-section: planning",
          "  fix-orphan-tag: implementation",
          "  reconcile-stale: mechanical",
          "models:",
          "  judgment: m-judgment",
          "  planning: m-planning",
          "  implementation: m-impl",
          "  mechanical: m-mech",
        ].join("\n"),
      ),
    );
    // The four effort tiers are all accepted as routing values, mapping task class → tier.
    expect(cfg.routing).toEqual({
      "write-tests": "judgment",
      "cover-section": "planning",
      "fix-orphan-tag": "implementation",
      "reconcile-stale": "mechanical",
    });
    // The models map keys each tier to a model identifier string.
    expect(cfg.models).toEqual({
      judgment: "m-judgment",
      planning: "m-planning",
      implementation: "m-impl",
      mechanical: "m-mech",
    });
    // Resolved together, a bound class yields its tier + the tier's model identifier.
    expect(hintsFor(cfg, "write-tests")).toEqual({ effort: "judgment", model: "m-judgment" });
    expect(hintsFor(cfg, "reconcile-stale")).toEqual({ effort: "mechanical", model: "m-mech" });
  });
});

describe("effort routing — hint propagation (§16.1)", () => {
  // @specs:effort-routing.emitted-tasks-escalation-questions
  it("emitted tasks carry effort + model when the config binds their class, and nothing when it does not", () => {
    // Binds write-tests (with a mapped model) but not cover-section; mechanical is left unmapped so
    // the bound-but-unmapped case shows the model hint is advisory (present tier, absent model).
    const bound = repoWith(
      [
        LAYERS,
        "routing:",
        "  write-tests: implementation",
        "  cover-section: mechanical",
        "models:",
        "  implementation: claude-opus",
      ].join("\n"),
    );
    const boundQueue = JSON.parse(runCli(["tasks", "--json"], { cwd: bound }).stdout);
    const writeTests = boundQueue.tasks.find((t: { kind: string }) => t.kind === "write-tests");
    const coverSection = boundQueue.tasks.find((t: { kind: string }) => t.kind === "cover-section");
    // Bound class with a mapped tier → both hints resolve onto the task.
    expect(writeTests.effort).toBe("implementation");
    expect(writeTests.model).toBe("claude-opus");
    // Bound class whose tier has no models entry → effort resolves, model stays absent (advisory).
    expect(coverSection.effort).toBe("mechanical");
    expect("model" in coverSection).toBe(false);

    // A repo with no routing config at all → every emitted task carries neither hint.
    const unbound = repoWith(LAYERS);
    const unboundQueue = JSON.parse(runCli(["tasks", "--json"], { cwd: unbound }).stdout);
    expect(unboundQueue.tasks.length).toBeGreaterThan(0);
    for (const t of unboundQueue.tasks) {
      expect("effort" in t).toBe(false);
      expect("model" in t).toBe(false);
    }
  });

  // @specs:effort-routing.emitted-tasks-escalation-questions
  it("escalation questions carry the adjudicate effort + model when bound, and nothing when not", () => {
    const rework = (repo: string): void => {
      const p = path.join(repo, "SPECS.md");
      const reworded = SPECS.replace(
        "addNumbers returns the sum of two integer inputs",
        "multiplyValues returns the product of three floating point operands entirely reworded",
      );
      writeFileSync(p, reworded);
      commit(repo, "rework spec claim");
    };

    // Bound: routing binds the adjudicate class (escalation questions) to a tier with a model.
    const bound = repoWith(
      [LAYERS, "routing:", "  adjudicate: judgment", "models:", "  judgment: claude-opus-judge"].join("\n"),
    );
    runCli(["accept"], { cwd: bound }); // baseline the original claims into the sidecar
    rework(bound); // substantial rewording forces an escalation question against the baseline
    const boundReport = JSON.parse(runCli(["check", "--json"], { cwd: bound }).stdout);
    expect(boundReport.escalations.length).toBeGreaterThan(0);
    for (const e of boundReport.escalations) {
      expect(e.effort).toBe("judgment");
      expect(e.model).toBe("claude-opus-judge");
    }

    // Unbound: routing exists but never binds `adjudicate`, so escalations carry no hint.
    const unbound = repoWith(
      [LAYERS, "routing:", "  write-tests: implementation", "models:", "  implementation: claude-opus"].join("\n"),
    );
    runCli(["accept"], { cwd: unbound });
    rework(unbound);
    const unboundReport = JSON.parse(runCli(["check", "--json"], { cwd: unbound }).stdout);
    expect(unboundReport.escalations.length).toBeGreaterThan(0);
    for (const e of unboundReport.escalations) {
      expect("effort" in e).toBe(false);
      expect("model" in e).toBe(false);
    }
  });
});

describe("effort routing — validation (§16.1 / §2.2)", () => {
  // @specs:effort-routing.routing-models-entries-validated
  it("reports routing + models faults all at once, each naming its key, alongside other config problems", () => {
    const yaml = [
      LAYERS,
      "accept:",
      "  policy: robot", // an unrelated §2.1 problem, to prove all-at-once reporting
      "routing:",
      "  no-such-class: implementation", // unknown task class
      "  write-tests: wizardry", // unknown effort tier
      "models:",
      "  nonsense-tier: whatever", // unknown effort tier
      "  implementation: '   '", // empty model identifier
    ].join("\n");
    let problems: string[] = [];
    try {
      loadConfig(configOnly(yaml));
      throw new Error("expected ConfigError");
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      problems = (e as ConfigError).problems;
    }
    const joined = problems.join("\n");
    // Every routing/models fault surfaces, keyed, in the one report...
    expect(joined).toContain('routing: unknown task class "no-such-class"');
    expect(joined).toContain('routing.write-tests: unknown effort tier "wizardry"');
    expect(joined).toContain('models: unknown effort tier "nonsense-tier"');
    expect(joined).toContain("models.implementation: empty model identifier");
    // ...together with the unrelated config problem (all-at-once, not short-circuited).
    expect(joined).toContain('accept.policy: unknown value "robot"');
  });

  // @specs:effort-routing.routing-models-entries-validated
  it("check refuses a config with an invalid routing tier, exiting 2", () => {
    const repo = mkdtempSync(path.join(os.tmpdir(), "tripact-routing-e2e-"));
    scratch.push(repo);
    execFileSync("git", ["init", "-b", "main"], { cwd: repo });
    writeFileSync(
      path.join(repo, "tripact.yaml"),
      [LAYERS, "routing:", "  write-tests: wizardry"].join("\n"),
    );
    const r = runCli(["check"], { cwd: repo });
    expect(r.status, r.stderr).toBe(2);
    expect(r.stderr).toContain('routing.write-tests: unknown effort tier "wizardry"');
  });
});
