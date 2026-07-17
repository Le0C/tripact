// Derived outputs — declaration & generation (UAC §18.1) and freshness (§18.2). Derived outputs are
// deterministically regenerable artefacts declared in tripact.yaml under `derived`; a generator is
// either a reserved builtin NAME (implemented by a harness, not the kernel) or an arbitrary shell
// command whose stdout becomes the file. `generate` writes them; `check` regenerates each in memory
// and byte-compares with the committed copy. These tests drive the prebuilt CLI in scratch git repos
// and observe stdout / JSON / exit codes; the two pure claims (config shape, reserved-name set) read
// the kernel directly.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { CLI_REFERENCE, deriveOutputs, HOTLINK_MAP, RESERVED_BUILTINS } from "../src/derived.js";
import { loadConfig } from "../src/config.js";
import { runCli } from "./helpers/cli.js";

const scratch: string[] = [];
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});

const BASE_LAYERS = [
  "schemaVersion: 1",
  "layers:",
  "  specs: {role: prescriptive, paths: [SPECS.md]}",
  "  tests: {role: verificatory, paths: [\"tests/**/*.spec.ts\"]}",
  "edges:",
  "  - [specs, tests]",
];

/** A minimal two-layer git repo with an appended `derived`/`exclude` config block. Optionally seeds
 *  committed derived files, then commits everything so `check` runs against a clean tree. */
function derivedRepo(opts: {
  exclude: string[];
  derivedBlock: string[];
  files?: Record<string, string>;
  git?: boolean;
}): string {
  const repo = mkdtempSync(path.join(os.tmpdir(), "tripact-derived-"));
  scratch.push(repo);
  const yaml = [
    ...BASE_LAYERS,
    "exclude:",
    ...opts.exclude.map((e) => `  - ${e}`),
    ...opts.derivedBlock,
    "",
  ].join("\n");
  writeFileSync(path.join(repo, "tripact.yaml"), yaml);
  writeFileSync(path.join(repo, "SPECS.md"), "# Spec\n\n## 1. X\n\n- [ ] a thing\n");
  mkdirSync(path.join(repo, "tests"), { recursive: true });
  writeFileSync(path.join(repo, "tests", "x.spec.ts"), 'test("a", () => {});\n');
  for (const [rel, content] of Object.entries(opts.files ?? {})) {
    const abs = path.join(repo, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  if (opts.git !== false) {
    execFileSync("git", ["init", "-b", "main"], { cwd: repo });
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "add", "-A"], { cwd: repo });
    execFileSync(
      "git",
      ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"],
      { cwd: repo },
    );
  }
  return repo;
}

/** Baseline uncovered claims so `check`'s exit code reflects derived freshness alone, not the
 *  untagged-spec backlog. */
function baseline(repo: string): void {
  const r = runCli(["accept", "--yes"], { cwd: repo });
  expect(r.status, `accept baseline\n${r.stderr}`).toBe(0);
}

describe("derived outputs — declaration & generation (§18.1)", () => {
  // @specs:declaration-generation.config-accepts-derived-map
  it("config accepts a derived map of name → { output path, generator } for both a shell command and a reserved builtin name", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "tripact-derived-cfg-"));
    scratch.push(dir);
    writeFileSync(
      path.join(dir, "tripact.yaml"),
      [
        ...BASE_LAYERS,
        "derived:",
        "  greeting:",
        "    output: GENERATED.txt",
        "    generator: printf 'hello world'",
        "  cli-reference:",
        "    output: CLI.md",
        "    generator: cli-reference",
        "",
      ].join("\n"),
    );
    const cfg = loadConfig(dir);
    // Each entry carries a name mapped to an output path and a generator, kept verbatim.
    const outputs = deriveOutputs(cfg);
    expect(outputs.map((o) => o.name)).toEqual(["cli-reference", "greeting"]); // sorted by name
    const byName = Object.fromEntries(outputs.map((o) => [o.name, o]));
    expect(byName["greeting"]).toMatchObject({ output: "GENERATED.txt", generator: "printf 'hello world'" });
    // A generator that is a reserved builtin NAME is accepted just the same as a shell command.
    expect(byName["cli-reference"]).toMatchObject({ output: "CLI.md", generator: "cli-reference" });
  });

  // @specs:declaration-generation.kernel-reserves-builtin-names
  it("reserves the builtin names cli-reference and hotlink-map, registers no generator itself, and fails generation with a clear error when a reserved name has no registered implementation", () => {
    // The kernel reserves exactly these names (implementations are harness-injected).
    expect(RESERVED_BUILTINS.has(CLI_REFERENCE)).toBe(true);
    expect(RESERVED_BUILTINS.has(HOTLINK_MAP)).toBe(true);
    expect(CLI_REFERENCE).toBe("cli-reference");
    expect(HOTLINK_MAP).toBe("hotlink-map");

    // The tripact CLI registers no builtin generator of its own, so declaring `cli-reference` and
    // asking to generate it fails with a clear "not registered" error and exit 2.
    const repo = derivedRepo({
      exclude: ["CLI.md"],
      derivedBlock: [
        "derived:",
        "  cli-reference:",
        "    output: CLI.md",
        "    generator: cli-reference",
      ],
    });
    const r = runCli(["generate", "cli-reference"], { cwd: repo });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("not registered");
    expect(r.stderr).toContain("cli-reference");
  });

  // @specs:declaration-generation.non-reserved-generator-runs-shell
  it("runs a non-reserved generator as a shell command whose stdout becomes the file, and fails with exit 2 on a non-zero exit", () => {
    // stdout capture → file content.
    const ok = derivedRepo({
      exclude: ["GENERATED.txt"],
      derivedBlock: [
        "derived:",
        "  greeting:",
        "    output: GENERATED.txt",
        "    generator: printf 'hello world'",
      ],
    });
    const good = runCli(["generate", "greeting"], { cwd: ok });
    expect(good.status).toBe(0);
    expect(readFileSync(path.join(ok, "GENERATED.txt"), "utf8")).toBe("hello world");

    // A non-zero shell exit fails generation with exit code 2.
    const bad = derivedRepo({
      exclude: ["OUT.txt"],
      derivedBlock: [
        "derived:",
        "  boom:",
        "    output: OUT.txt",
        "    generator: \"echo oops >&2; exit 3\"",
      ],
    });
    const failed = runCli(["generate", "boom"], { cwd: bad });
    expect(failed.status).toBe(2);
    expect(failed.stderr).toContain("boom");
  });

  // @specs:declaration-generation.tripact-generate-name-writes
  it("writes only the named output for `generate <name>` and every declared output for `generate` with no name", () => {
    const repo = derivedRepo({
      exclude: ["out/a.txt", "out/b.txt"],
      derivedBlock: [
        "derived:",
        "  alpha:",
        "    output: out/a.txt",
        "    generator: printf 'AAA'",
        "  beta:",
        "    output: out/b.txt",
        "    generator: printf 'BBB'",
      ],
    });
    // Named: writes alpha only.
    const one = runCli(["generate", "alpha"], { cwd: repo });
    expect(one.status).toBe(0);
    expect(one.stdout).toContain("wrote out/a.txt (alpha)");
    expect(readFileSync(path.join(repo, "out", "a.txt"), "utf8")).toBe("AAA");
    expect(() => readFileSync(path.join(repo, "out", "b.txt"), "utf8")).toThrow();

    // No name: regenerates all.
    const all = runCli(["generate"], { cwd: repo });
    expect(all.status).toBe(0);
    expect(readFileSync(path.join(repo, "out", "a.txt"), "utf8")).toBe("AAA");
    expect(readFileSync(path.join(repo, "out", "b.txt"), "utf8")).toBe("BBB");
  });

  // @specs:declaration-generation.generation-deterministic-same-code
  it("produces byte-identical output across repeated generations of the same code and config", () => {
    const repo = derivedRepo({
      exclude: ["GENERATED.txt"],
      derivedBlock: [
        "derived:",
        "  greeting:",
        "    output: GENERATED.txt",
        "    generator: \"printf 'line1\\\\nline2\\\\n'\"",
      ],
    });
    const first = runCli(["generate", "greeting"], { cwd: repo });
    expect(first.status).toBe(0);
    const a = readFileSync(path.join(repo, "GENERATED.txt"));
    const second = runCli(["generate", "greeting"], { cwd: repo });
    expect(second.status).toBe(0);
    const b = readFileSync(path.join(repo, "GENERATED.txt"));
    expect(a.equals(b)).toBe(true);
    expect(a.toString("utf8")).toBe("line1\nline2\n");
  });
});

describe("derived outputs — freshness (§18.2)", () => {
  // @specs:freshness.check-regenerates-each-declared
  it("regenerates each declared output and byte-compares with the committed file — a stable mismatch or a missing file is a derived-stale finding driving exit 1", () => {
    // Stable mismatch: committed content differs from the deterministic regeneration.
    const stale = derivedRepo({
      exclude: ["GENERATED.txt"],
      derivedBlock: [
        "derived:",
        "  greeting:",
        "    output: GENERATED.txt",
        "    generator: printf 'hello world'",
      ],
      files: { "GENERATED.txt": "STALE CONTENT" },
    });
    baseline(stale);
    const s = runCli(["check", "--json"], { cwd: stale });
    expect(s.status).toBe(1);
    const sr = JSON.parse(s.stdout);
    expect(sr.exitCode).toBe(1);
    expect(sr.derivedStale).toEqual(["greeting"]);

    // Missing file: nothing committed at the output path is also derived-stale.
    const missing = derivedRepo({
      exclude: ["GENERATED.txt"],
      derivedBlock: [
        "derived:",
        "  greeting:",
        "    output: GENERATED.txt",
        "    generator: printf 'hello world'",
      ],
    });
    baseline(missing);
    const m = runCli(["check", "--json"], { cwd: missing });
    expect(m.status).toBe(1);
    const mr = JSON.parse(m.stdout);
    expect(mr.derivedStale).toEqual(["greeting"]);
  });

  // @specs:freshness.generator-whose-two-back-to-back
  it("reports a generator whose two back-to-back regenerations disagree as non-deterministic rather than stale", () => {
    // A generator that returns a fresh incrementing value each run: two back-to-back regenerations
    // always disagree, so it is reported non-deterministic, never derived-stale.
    const repo = derivedRepo({
      exclude: ["COUNTER.txt", ".ctr"],
      derivedBlock: [
        "derived:",
        "  counter:",
        "    output: COUNTER.txt",
        "    generator: \"n=$(cat .ctr 2>/dev/null || echo 0); n=$((n+1)); printf %s $n > .ctr; printf %s $n\"",
      ],
      files: { "COUNTER.txt": "committed" },
    });
    baseline(repo);
    const r = runCli(["check", "--json"], { cwd: repo });
    expect(r.status).toBe(1);
    const report = JSON.parse(r.stdout);
    expect(report.nonDeterministicGenerators).toEqual(["counter"]);
    expect(report.derivedStale).toEqual([]);
  });

  // @specs:freshness.derived-stale-finding-appears-task
  it("surfaces a derived-stale finding in the task queue as a regenerate-derived task", () => {
    const repo = derivedRepo({
      exclude: ["GENERATED.txt"],
      derivedBlock: [
        "derived:",
        "  greeting:",
        "    output: GENERATED.txt",
        "    generator: printf 'hello world'",
      ],
      files: { "GENERATED.txt": "STALE CONTENT" },
    });
    baseline(repo);
    const t = runCli(["tasks", "--json"], { cwd: repo });
    expect(t.status).toBe(1);
    const tasks = JSON.parse(t.stdout).tasks as Array<{
      kind: string;
      payload: { name: string; output: string; invocation: string };
    }>;
    const regen = tasks.filter((x) => x.kind === "regenerate-derived");
    expect(regen).toHaveLength(1);
    expect(regen[0].payload).toMatchObject({
      name: "greeting",
      output: "GENERATED.txt",
      invocation: "tripact generate greeting",
    });
  });
});
