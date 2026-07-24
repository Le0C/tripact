// Task emission (UAC §10.1) and repair handoff (UAC §10.2), driven through the prebuilt CLI the way
// a foreign harness would: a scratch git repo with a hand-written tripact.yaml, then `tripact tasks`
// over the states that shape the repair queue (uncovered, pending, stale, orphan, derived-stale,
// reconcile). The repair-handoff claims assert the emitted `tripact-repair` skill's instructions,
// exercised through the pure generator the CLI's `skills` command renders.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { repairSkill } from "../src/skills.js";
import { git, runCli } from "./helpers/cli.js";
import { CONFIG, fullRepo, MANUAL, shellNode, specTag, SPECS } from "./helpers/fixture.js";

const scratch: string[] = [];
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});

function track(repo: string): string {
  scratch.push(repo);
  return repo;
}

/** Two tests, each tagging one of the base SPECS claims, moving both off "uncovered". */
const TAGGED_TESTS = [
  `// ${specTag("addition.addnumbers-returns-sum-two")}`,
  'test("addNumbers sums two integers", () => {});',
  `// ${specTag("addition.entering-two-numbers-clicking")}`,
  'test("Add button shows the sum", () => {});',
  "",
].join("\n");

/**
 * A committed scratch repo carrying all three layers plus a hand-written tripact.yaml. Unlike the
 * shared `fullRepo`, this commits the initial tree so the accept → modify → check flows the stale
 * tests need have a real prior sync-point to diff against. `tests` overrides the verificatory file.
 */
function committedRepo(prefix: string, opts: { specs?: string; config?: string; tests?: string } = {}): string {
  const repo = track(mkdtempSync(path.join(os.tmpdir(), prefix)));
  git(repo, ["init", "-b", "main"]);
  writeFileSync(path.join(repo, "SPECS.md"), opts.specs ?? SPECS);
  writeFileSync(path.join(repo, "tripact.yaml"), opts.config ?? CONFIG);
  mkdirSync(path.join(repo, "docs", "manual"), { recursive: true });
  writeFileSync(path.join(repo, "docs", "manual", "using.md"), MANUAL);
  mkdirSync(path.join(repo, "tests", "e2e"), { recursive: true });
  writeFileSync(path.join(repo, "tests", "e2e", "calc.spec.ts"), opts.tests ?? TAGGED_TESTS);
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-m", "seed"]);
  return repo;
}

/** Parse a `tasks --json` queue, asserting a clean exit path first. `globals` carries any global
 *  flags the fixture needs ahead of the command, e.g. `--allow-shell` for a shell generator. */
function tasksJson(repo: string, globals: string[] = []): { schemaVersion: number; tasks: Array<{ id: string; kind: string; title: string; payload: Record<string, unknown> }> } {
  const r = runCli([...globals, "tasks", "--json"], { cwd: repo });
  expect([0, 1]).toContain(r.status);
  return JSON.parse(r.stdout);
}

describe("tripact tasks — emission (UAC §10.1)", () => {
  // @specs:task-emission.tripact-tasks-derives-work
  it("derives a work queue without mutating artefacts, the sidecar, or escalations", () => {
    const repo = track(fullRepo("tripact-tasks-pure-")); // fullRepo runs `check`, so escalations.json exists
    const escPath = path.join(repo, ".tripact", "escalations.json");
    const sidecarPath = path.join(repo, ".tripact", "claims.json");
    const specsBefore = readFileSync(path.join(repo, "SPECS.md"), "utf8");
    const manualBefore = readFileSync(path.join(repo, "docs", "manual", "using.md"), "utf8");
    const escBefore = readFileSync(escPath, "utf8");
    expect(existsSync(sidecarPath), "no sidecar before tasks").toBe(false);

    // Deriving the queue (plain and with a reconcile pair) must be side-effect free.
    runCli(["tasks", "--json"], { cwd: repo });
    runCli(["tasks", "--reconcile", "specs:docs", "--json"], { cwd: repo });

    expect(readFileSync(path.join(repo, "SPECS.md"), "utf8"), "prescriptive artefact untouched").toBe(specsBefore);
    expect(readFileSync(path.join(repo, "docs", "manual", "using.md"), "utf8"), "descriptive artefact untouched").toBe(manualBefore);
    expect(readFileSync(escPath, "utf8"), "escalation queue untouched").toBe(escBefore);
    expect(existsSync(sidecarPath), "tasks never writes the sidecar").toBe(false);
  });

  // @specs:task-emission.one-task-emitted-per
  it("emits one task per claim group, per uncovered section, and per orphan tag", () => {
    // Untagged claim tests keep both claims uncovered (grouped under one heading); the manual
    // section is undocumented; a second spec file carries 14 tags referencing no live claim.
    const orphans = Array.from({ length: 14 }, (_, i) => `// ${specTag("nonexistent-claim-" + String(i).padStart(2, "0"))}\ntest("orphan ${i}", () => {});`).join("\n");
    const repo = committedRepo("tripact-tasks-perX-", { tests: "test('a', () => {});\ntest('b', () => {});\n" });
    writeFileSync(path.join(repo, "tests", "e2e", "orphans.spec.ts"), `${orphans}\n`);
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-m", "orphans"]);

    const { tasks } = tasksJson(repo);
    const kinds = tasks.map((t) => t.kind);
    // Two uncovered claims share one group → exactly one write-tests task (grouped per claim group).
    expect(kinds.filter((k) => k === "write-tests")).toHaveLength(1);
    // The single undocumented manual section → exactly one cover-section task.
    expect(kinds.filter((k) => k === "cover-section")).toHaveLength(1);
    // One fix-orphan-tag task per orphan tag, emitted individually rather than batched.
    expect(kinds.filter((k) => k === "fix-orphan-tag")).toHaveLength(14);
    const grouped = tasks.find((t) => t.kind === "write-tests");
    expect((grouped?.payload.claims as unknown[]).length, "both uncovered claims in the one group task").toBe(2);
  });

  // @specs:task-emission.uncovered-claim-task-find-or-write-task
  it("makes the uncovered-claim task a find-or-write task naming both options and the exact tag format", () => {
    const repo = track(fullRepo("tripact-tasks-fow-")); // untagged tests → uncovered claims
    const { tasks } = tasksJson(repo);
    const write = tasks.find((t) => t.kind === "write-tests");
    expect(write, "a write-tests task is emitted for the uncovered claims").toBeTruthy();
    // Both options are named verbatim in the payload...
    expect(write!.payload.options).toEqual([
      "tag an existing untagged test that already asserts the claim",
      "write a new tagged test only when none exists",
    ]);
    // ...alongside the exact tag the verificatory layer's scanner recognises.
    expect(write!.payload.tagFormat).toBe("@specs:<id>");
  });

  // @specs:task-emission.uncovered-claim-tasks-title-leads
  it("leads the uncovered-claim task's title with its claim group, instruction trailing", () => {
    const repo = track(fullRepo("tripact-tasks-title-"));
    const write = tasksJson(repo).tasks.find((t) => t.kind === "write-tests")!;
    const group = write.payload.group as string;
    expect(group, "the fixture's uncovered claims share one group").toBeTruthy();
    // The group occupies the head of the title, where a scanned column stays readable...
    expect(write.title.startsWith(group)).toBe(true);
    // ...and the find-or-write instruction, identical across every task of this kind, trails it.
    expect(write.title).toBe(`${group} — Tag or write a test for these claims`);
  });

  // @specs:task-emission.pending-verdict-emits-no
  it("emits no task for a pending verdict", () => {
    // Tagged-but-never-verified tests → both claims pending. Pending's cure is an accept, not repair.
    const repo = committedRepo("tripact-tasks-pending-");
    const check = runCli(["check", "--json"], { cwd: repo });
    const verdicts = JSON.parse(check.stdout).verdicts as Array<{ subject: string; kind: string }>;
    expect(verdicts.filter((v) => v.kind === "pending").map((v) => v.subject).sort()).toEqual([
      "addition.addnumbers-returns-sum-two",
      "addition.entering-two-numbers-clicking",
    ]);
    const { tasks } = tasksJson(repo);
    // No write-tests / reconcile-stale for the pending claims; only the undocumented section remains.
    expect(tasks.some((t) => t.kind === "write-tests")).toBe(false);
    expect(tasks.some((t) => t.kind === "reconcile-stale")).toBe(false);
    expect(tasks.map((t) => t.kind)).toEqual(["cover-section"]);
  });

  // @specs:task-emission.test-side-only-staleness-41-emits
  it("emits a reconcile-stale task only for a reworded claim, never for test-side-only staleness", () => {
    // A: reword a claim after verification (its own text moves) → a reconcile-stale task naming it.
    const reworded = committedRepo("tripact-tasks-reword-");
    expect(runCli(["accept", "--yes"], { cwd: reworded }).status, "baseline the verified state").toBe(0);
    git(reworded, ["add", "-A"]);
    git(reworded, ["commit", "-m", "accept"]);
    const spec = readFileSync(path.join(reworded, "SPECS.md"), "utf8").replace(
      "addNumbers returns the sum of two integer inputs",
      "addNumbers returns the sum of two integer inputs exactly", // id stays stable; only the hash moves
    );
    writeFileSync(path.join(reworded, "SPECS.md"), spec);
    git(reworded, ["add", "-A"]);
    git(reworded, ["commit", "-m", "reword"]);
    const rw = tasksJson(reworded).tasks.filter((t) => t.kind === "reconcile-stale");
    expect(rw, "reworded stale earns one reconcile-stale task").toHaveLength(1);
    expect(rw[0]!.payload.claimId).toBe("addition.addnumbers-returns-sum-two");

    // B: touch only the tagged test file (claim text unchanged) → test-side-only stale, no task.
    const testSide = committedRepo("tripact-tasks-testside-");
    expect(runCli(["accept", "--yes"], { cwd: testSide }).status).toBe(0);
    git(testSide, ["add", "-A"]);
    git(testSide, ["commit", "-m", "accept"]);
    const testFile = path.join(testSide, "tests", "e2e", "calc.spec.ts");
    writeFileSync(testFile, `${readFileSync(testFile, "utf8")}\n// touched\n`);
    git(testSide, ["add", "-A"]);
    git(testSide, ["commit", "-m", "touch"]);
    const check = runCli(["check", "--json"], { cwd: testSide });
    const verdicts = JSON.parse(check.stdout).verdicts as Array<{ kind: string }>;
    expect(verdicts.some((v) => v.kind === "stale"), "the touch does register as staleness").toBe(true);
    expect(tasksJson(testSide).tasks.some((t) => t.kind === "reconcile-stale"), "but it emits no task").toBe(false);
  });

  // @specs:task-emission.derived-stale-output-182-emits
  it("emits a regenerate-derived task naming the exact generate invocation for a stale derived output", () => {
    const config = `${CONFIG}\nderived:\n  cli-docs:\n    output: docs/CLI.md\n    generator: ${JSON.stringify(shellNode("process.stdout.write('fresh\\n')"))}\n`;
    const repo = committedRepo("tripact-tasks-derived-", { config });
    writeFileSync(path.join(repo, "docs", "CLI.md"), "stale\n"); // ≠ generator output → stale
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-m", "derived"]);

    const regen = tasksJson(repo, ["--allow-shell"]).tasks.filter((t) => t.kind === "regenerate-derived");
    expect(regen, "the stale derived output earns one task").toHaveLength(1);
    expect(regen[0]!.payload.name).toBe("cli-docs");
    expect(regen[0]!.payload.invocation).toBe("tripact generate cli-docs");
  });

  // @specs:task-emission.tripact-tasks---reconcile-prescriptivedescriptive
  it("emits one layer-reconciliation task carrying both layers' full inventories under --reconcile", () => {
    const repo = track(fullRepo("tripact-tasks-recon-"));
    const r = runCli(["tasks", "--reconcile", "specs:docs", "--json"], { cwd: repo });
    const recon = JSON.parse(r.stdout).tasks.filter((t: { kind: string }) => t.kind === "reconcile-layers");
    expect(recon, "exactly one reconcile-layers task").toHaveLength(1);
    const payload = recon[0].payload as { prescriptiveLayer: string; descriptiveLayer: string; claims: unknown[]; sections: unknown[] };
    expect(payload.prescriptiveLayer).toBe("specs");
    expect(payload.descriptiveLayer).toBe("docs");
    // Full inventories: every prescriptive claim (both) and every descriptive section (one).
    expect(payload.claims).toHaveLength(2);
    expect(payload.sections).toHaveLength(1);
  });

  // @specs:task-emission.every-emitted-task-payload
  it("marks spec/atom text in every task payload with a source: spec-atom provenance marker", () => {
    const repo = track(fullRepo("tripact-tasks-source-"));
    // write-tests: each claim entry carries the marker
    const wt = tasksJson(repo).tasks.filter((t) => t.kind === "write-tests");
    expect(wt.length).toBeGreaterThan(0);
    for (const t of wt) for (const c of t.payload.claims as Array<{ source: string }>) expect(c.source).toBe("spec-atom");

    // reconcile-layers: each prescriptive claim entry carries the marker
    const recon = JSON.parse(runCli(["tasks", "--reconcile", "specs:docs", "--json"], { cwd: repo }).stdout)
      .tasks.filter((t: { kind: string }) => t.kind === "reconcile-layers");
    for (const c of recon[0].payload.claims as Array<{ source: string }>) expect(c.source).toBe("spec-atom");

    // reconcile-stale: the payload-level marker tags its claimText
    const reworded = committedRepo("tripact-tasks-source-stale-");
    expect(runCli(["accept", "--yes"], { cwd: reworded }).status).toBe(0);
    git(reworded, ["add", "-A"]);
    git(reworded, ["commit", "-m", "accept"]);
    const spec = readFileSync(path.join(reworded, "SPECS.md"), "utf8").replace(
      "addNumbers returns the sum of two integer inputs",
      "addNumbers returns the sum of two integer inputs exactly",
    );
    writeFileSync(path.join(reworded, "SPECS.md"), spec);
    git(reworded, ["add", "-A"]);
    git(reworded, ["commit", "-m", "reword"]);
    const rs = tasksJson(reworded).tasks.filter((t) => t.kind === "reconcile-stale");
    expect(rs[0]!.payload.source).toBe("spec-atom");
  });

  // @specs:task-emission.task-ids-deterministic-same
  it("emits deterministic task ids for the same underlying situation", () => {
    const repo = track(fullRepo("tripact-tasks-determ-"));
    const a = runCli(["tasks", "--json"], { cwd: repo });
    const b = runCli(["tasks", "--json"], { cwd: repo });
    expect(b.stdout, "byte-identical queue across runs").toBe(a.stdout);
    const ids = (s: string) => JSON.parse(s).tasks.map((t: { id: string }) => t.id);
    expect(ids(b.stdout)).toEqual(ids(a.stdout));
  });

  // @specs:task-emission.tasks---json-emits-machine-readable
  it("emits a machine-readable queue with a schemaVersion, and a human queue grouped by kind that truncates unless --long", () => {
    // --json: schemaVersion field + a tasks array.
    const base = track(fullRepo("tripact-tasks-json-"));
    const queue = tasksJson(base);
    expect(queue.schemaVersion).toBe(1);
    expect(Array.isArray(queue.tasks)).toBe(true);

    // Human output groups tasks under per-kind headings and truncates past a fixed threshold (12).
    const orphans = Array.from({ length: 14 }, (_, i) => `// ${specTag("nope-" + String(i).padStart(2, "0"))}\ntest("o${i}", () => {});`).join("\n");
    const repo = committedRepo("tripact-tasks-human-", { tests: "test('a', () => {});\n" });
    writeFileSync(path.join(repo, "tests", "e2e", "orphans.spec.ts"), `${orphans}\n`);
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-m", "orphans"]);

    const short = runCli(["tasks"], { cwd: repo });
    expect(short.stdout, "grouped under a per-kind heading").toContain("fix-orphan-tag (14):");
    expect(short.stdout, "truncated past the threshold").toContain("… and 2 more — run with --long to see all");
    const long = runCli(["tasks", "--long"], { cwd: repo });
    expect(long.stdout, "--long prints every task").not.toContain("more — run with --long");
  });
});

describe("tripact repair handoff — the emitted repair skill (UAC §10.2)", () => {
  // @specs:repair-handoff.emitted-tripact-repair-skill-12
  it("instructs consuming tasks --json, following conventions files, editing artefacts, and validating with check plus the repo's test command", () => {
    const content = repairSkill().content;
    expect(content).toContain("tripact tasks --json"); // consume the machine-readable queue
    expect(content).toContain("conventions"); // follow per-layer conventions files where declared
    expect(content).toContain("tripact.yaml` declares");
    // The engine never edits artefact content; repairing it is agent work.
    expect(content).toContain("The engine never edits artefact content");
    // Validate with tripact check AND the repo's own test command before reporting.
    expect(content).toContain("tripact check");
    expect(content).toContain("the repo's own test command");
    expect(content).toContain("Report per task");
  });

  // @specs:repair-handoff.find-or-write-task-repair-skill
  it("instructs a find-or-write task to search for an existing untagged test before writing a new one", () => {
    const content = repairSkill().content;
    expect(content).toContain("first search the verificatory layer for an existing");
    expect(content).toContain("untagged test that already asserts the claim and tag it in place");
    expect(content).toContain("write a new test");
    expect(content).toContain("only when none is found");
  });

  // @specs:repair-handoff.repair-skills-accept-rule
  it("bakes an accept rule that follows the configured accept policy", () => {
    // human policy → baselining is a person's call; the skill forbids self-accept.
    expect(repairSkill({ policy: "human" }).content).toContain("Never run `tripact accept`");
    // agents policy → self-accept is permitted, gated on green validation and no open escalations.
    expect(repairSkill({ policy: "agents" }).content).toContain("Run `tripact accept` only after validation passes");
  });

  // @specs:repair-handoff.executing-repair-tasks-agent
  it("never edits prescriptive or descriptive artefact content — derived-output generation is the sole exception", () => {
    const config = `${CONFIG}\nderived:\n  cli-docs:\n    output: docs/CLI.md\n    generator: ${JSON.stringify(shellNode("process.stdout.write('fresh\\n')"))}\n`;
    const repo = committedRepo("tripact-kernel-readonly-", { config });
    const specsPath = path.join(repo, "SPECS.md");
    const manualPath = path.join(repo, "docs", "manual", "using.md");
    const derivedPath = path.join(repo, "docs", "CLI.md");
    writeFileSync(derivedPath, "stale\n"); // ≠ generator output, so `generate` has something to write
    const specsBefore = readFileSync(specsPath, "utf8");
    const manualBefore = readFileSync(manualPath, "utf8");

    // Every read/report/accept command in the kernel's surface: none may touch artefact content.
    for (const argv of [["check"], ["status"], ["claims"], ["tasks"], ["diff"], ["accept", "--yes"]]) {
      runCli(["--allow-shell", ...argv], { cwd: repo });
      expect(readFileSync(specsPath, "utf8"), `${argv[0]} left the prescriptive artefact untouched`).toBe(specsBefore);
      expect(readFileSync(manualPath, "utf8"), `${argv[0]} left the descriptive artefact untouched`).toBe(manualBefore);
      expect(readFileSync(derivedPath, "utf8"), `${argv[0]} did not generate`).toBe("stale\n");
    }

    // The one exception is derived-output generation, a deterministic derivation the kernel owns.
    expect(runCli(["--allow-shell", "generate", "cli-docs"], { cwd: repo }).status).toBe(0);
    expect(readFileSync(derivedPath, "utf8"), "generate wrote the derived output").toBe("fresh\n");
    // …and even that writes only the derived output, never the hand-authored layers.
    expect(readFileSync(specsPath, "utf8")).toBe(specsBefore);
    expect(readFileSync(manualPath, "utf8")).toBe(manualBefore);
  });
});
