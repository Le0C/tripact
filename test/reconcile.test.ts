// End-to-end coverage of `tripact reconcile` (UAC §10.3), the propose-only queue that suggests
// existing untagged tests which may already assert an uncovered claim. Driven the way a foreign
// harness would: a scratch git repo with a hand-written tripact.yaml, then the prebuilt CLI over
// its lifecycle. Everything here is a black-box assertion against observed stdout / JSON / exit code.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { runCli } from "./helpers/cli.js";
import { fullRepo } from "./helpers/fixture.js";

const scratch: string[] = [];
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});

function track(repo: string): string {
  scratch.push(repo);
  return repo;
}

function commit(repo: string, message: string): void {
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "add", "-A"], { cwd: repo });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", message], { cwd: repo });
}

/**
 * Minimal specs+tests repo (no descriptive layer) with caller-supplied spec claim lines and test
 * titles, git-initialised and committed. Deliberately does NOT run `check`, so no sidecar exists:
 * the clean slate the mutate-nothing assertion relies on.
 */
function makeRepo(prefix: string, specLines: string[], testTitles: string[]): string {
  const repo = track(mkdtempSync(path.join(os.tmpdir(), prefix)));
  execFileSync("git", ["init", "-b", "main", "-q"], { cwd: repo });
  writeFileSync(
    path.join(repo, "SPECS.md"),
    ["# Spec", "", "## 1. Calculator", "", "### 1.1 Addition", "", ...specLines.map((l) => `- [ ] ${l}`), ""].join("\n"),
  );
  writeFileSync(
    path.join(repo, "tripact.yaml"),
    [
      "schemaVersion: 1",
      "layers:",
      "  specs:",
      "    role: prescriptive",
      "    paths: [SPECS.md]",
      "  tests:",
      "    role: verificatory",
      '    paths: ["tests/**/*.spec.ts"]',
      "edges:",
      "  - [specs, tests]",
      "",
    ].join("\n"),
  );
  mkdirSync(path.join(repo, "tests"), { recursive: true });
  writeFileSync(path.join(repo, "tests", "calc.spec.ts"), testTitles.map((t) => `test(${JSON.stringify(t)}, () => {});`).join("\n") + "\n");
  commit(repo, "init");
  return repo;
}

describe("tripact reconcile — untagged-test proposals (UAC §10.3)", () => {
  // @specs:reconcile-untagged-tests.tripact-reconcile-proposes-per
  it("proposes, per uncovered prescriptive claim, existing test titles above the similarity threshold", () => {
    // fullRepo leaves every claim uncovered (tests tag nothing), the drift state reconcile scans.
    const repo = track(fullRepo("tripact-recon-propose-"));
    const r = runCli(["reconcile", "--json"], { cwd: repo });
    expect(r.status, r.stderr).toBe(0);
    const report = JSON.parse(r.stdout);

    // Exactly one claim clears the fixed threshold: "addNumbers returns the sum…" ↔ the near-verbatim
    // test title. The second claim ("Entering two numbers and clicking Add…") is not proposed:
    // its closest test title scores below threshold, so the threshold is what filters the queue.
    expect(report.candidates).toHaveLength(1);
    const entry = report.candidates[0];
    expect(entry.claimId).toBe("addition.addnumbers-returns-sum-two");
    expect(entry.tagFormat).toBe("@specs:<id>");
    expect(entry.candidates).toHaveLength(1);
    const cand = entry.candidates[0];
    expect(cand.file).toBe("tests/e2e/calc.spec.ts");
    expect(cand.title).toBe("addNumbers sums two integers");
    expect(cand.score).toBeGreaterThanOrEqual(0.5);
  });

  // @specs:reconcile-untagged-tests.reconcile-scoring-reuses-deterministic
  it("ranks candidates by descending score and is byte-identical for an unchanged tree", () => {
    // Two test titles both clear the threshold against one claim → they must be ordered by score.
    const repo = makeRepo(
      "tripact-recon-rank-",
      ["addNumbers returns the sum of two integer inputs"],
      ["addNumbers sums two integers", "addNumbers returns the sum of two integer values"],
    );
    const a = runCli(["reconcile", "--json"], { cwd: repo });
    expect(a.status, a.stderr).toBe(0);
    const cands = JSON.parse(a.stdout).candidates[0].candidates as Array<{ line: number; score: number }>;
    expect(cands).toHaveLength(2);
    // Ranked by score: the fuller-overlap title (line 2) outranks the terser one (line 1).
    expect(cands[0].score).toBeGreaterThan(cands[1].score);
    expect(cands[0].line).toBe(2);
    expect(cands[1].line).toBe(1);

    // An identical tree yields an identical proposal set and ranking: same bytes on a re-run.
    const b = runCli(["reconcile", "--json"], { cwd: repo });
    expect(b.stdout).toBe(a.stdout);
  });

  // @specs:reconcile-untagged-tests.reconcile-mutates-nothing-no
  it("mutates nothing — a scan writes no sidecar, artefact, or escalation", () => {
    // fullRepo has run `check`, so .tripact/escalations.json exists but claims.json (the accept
    // sidecar) does not. A reconcile scan must leave that state exactly as it found it.
    const repo = track(fullRepo("tripact-recon-nomutate-"));
    const escalationsPath = path.join(repo, ".tripact", "escalations.json");
    const before = readFileSync(escalationsPath, "utf8");
    expect(existsSync(path.join(repo, ".tripact", "claims.json"))).toBe(false);

    const r = runCli(["reconcile", "--json"], { cwd: repo });
    expect(r.status, r.stderr).toBe(0);

    // No new sidecar, and the pre-existing escalation queue is untouched byte-for-byte.
    expect(existsSync(path.join(repo, ".tripact", "claims.json"))).toBe(false);
    expect(readFileSync(escalationsPath, "utf8")).toBe(before);
  });

  // @specs:reconcile-untagged-tests.dismissed-candidate-recorded-tripact
  it("suppresses a dismissed pairing until its text changes, and the dismissal survives an accept", () => {
    const repo = makeRepo("tripact-recon-dismiss-", ["addNumbers returns the sum of two integer inputs"], ["addNumbers sums two integers"]);
    const claimId = "addition.addnumbers-returns-sum-two";

    // Baseline: the pairing is proposed.
    expect(JSON.parse(runCli(["reconcile", "--json"], { cwd: repo }).stdout).candidates).toHaveLength(1);

    // Record a dismissal via `reconcile --dismiss <claimId> <file> <line>` → no longer proposed.
    const dismiss = runCli(["reconcile", "--dismiss", claimId, "tests/calc.spec.ts", "1"], { cwd: repo });
    expect(dismiss.status, dismiss.stderr).toBe(0);
    expect(dismiss.stdout).toContain("dismissed reconcile candidate");
    expect(JSON.parse(runCli(["reconcile", "--json"], { cwd: repo }).stdout).candidates).toHaveLength(0);

    // A dismissal survives an accept: accepting the baseline does not clear it.
    expect(runCli(["accept", "--yes"], { cwd: repo }).status).toBe(0);
    expect(JSON.parse(runCli(["reconcile", "--json"], { cwd: repo }).stdout).candidates).toHaveLength(0);

    // Keyed by the test text: once the title changes, the pairing is re-proposed.
    writeFileSync(path.join(repo, "tests", "calc.spec.ts"), 'test("addNumbers returns the sum of two integer inputs exactly", () => {});\n');
    commit(repo, "retitle");
    expect(JSON.parse(runCli(["reconcile", "--json"], { cwd: repo }).stdout).candidates).toHaveLength(1);
  });

  // @specs:reconcile-untagged-tests.reconcile-opt-in-not-part
  it("is opt-in — running it never affects check's verdicts, counts, or exit code", () => {
    const repo = track(fullRepo("tripact-recon-optin-"));

    // check reports drift and exits 1; its JSON carries no reconcile field.
    const check1 = runCli(["check", "--json"], { cwd: repo });
    expect(check1.status).toBe(1);
    expect(Object.keys(JSON.parse(check1.stdout))).not.toContain("candidates");

    // Reconcile runs its own scan and exits 0 (advisory) on the same drift tree.
    expect(runCli(["reconcile"], { cwd: repo }).status).toBe(0);

    // check is unchanged: same exit code and byte-identical JSON as before the reconcile run.
    const check2 = runCli(["check", "--json"], { cwd: repo });
    expect(check2.status).toBe(1);
    expect(check2.stdout).toBe(check1.stdout);
  });

  // @specs:reconcile-untagged-tests.reconcile---json-emits-machine-readable
  it("--json emits a schemaVersion'd queue, exits 0 on drift and 2 on config/usage errors, never 1", () => {
    const repo = track(fullRepo("tripact-recon-json-"));

    // Machine-readable queue with a schemaVersion field; advisory exit 0.
    const ok = runCli(["reconcile", "--json"], { cwd: repo });
    expect(ok.status, ok.stderr).toBe(0);
    expect(JSON.parse(ok.stdout).schemaVersion).toBe(1);

    // Usage error (a non-numeric line for --dismiss) → exit 2, not 1.
    const usage = runCli(["reconcile", "--dismiss", "some-claim", "tests/e2e/calc.spec.ts", "notanumber"], { cwd: repo });
    expect(usage.status).toBe(2);

    // Config error (no tripact.yaml) → exit 2, not 1.
    const bare = track(mkdtempSync(path.join(os.tmpdir(), "tripact-recon-noconfig-")));
    execFileSync("git", ["init", "-b", "main", "-q"], { cwd: bare });
    expect(runCli(["reconcile", "--json"], { cwd: bare }).status).toBe(2);
  });
});
