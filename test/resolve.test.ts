// `tripact resolve` — the escalation adjudication surface (UAC §7.2). Each scenario builds a scratch
// git repo, baselines it with `accept` so the sidecar carries a claim identity, then rewords/replaces
// the prescriptive text so the next `check` mints a real escalation question. The resolve behaviours
// (validation + exit 2, --dismiss forks only, in-place shrink of multi-atom questions, journalling,
// and the drift-clearing property) are then driven through the prebuilt CLI and asserted against the
// on-disk sidecar / escalations.json / journal.jsonl. Only `git init` + a working tree is needed —
// no commits, matching the fixture's own layer wiring.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { runCli } from "./helpers/cli.js";
import { specTag } from "./helpers/fixture.js";

const scratch: string[] = [];
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});

const CONFIG = [
  "schemaVersion: 1",
  "layers:",
  "  specs:",
  "    role: prescriptive",
  "    paths: [SPECS.md]",
  "  tests:",
  "    role: verificatory",
  "    paths: [tests/**/*.spec.ts]",
  "edges:",
  "  - [specs, tests]",
  "",
].join("\n");

/** Wrap prescriptive checklist items under a single Addition group. */
function specs(...items: string[]): string {
  return ["# Spec", "", "## 1. Calculator", "", "### 1.1 Addition", "", ...items.map((t) => `- [ ] ${t}`), ""].join("\n");
}

/**
 * A baselined scratch repo: git-inited, wired to SPECS.md + a (tag-bearing) test, and `accept`ed so
 * the sidecar anchors the given claim texts. Returns the repo path; cleaned up in afterAll.
 */
function baselinedRepo(prefix: string, ...items: string[]): string {
  const repo = mkdtempSync(path.join(os.tmpdir(), prefix));
  scratch.push(repo);
  execFileSync("git", ["init", "-b", "main"], { cwd: repo });
  writeFileSync(path.join(repo, "tripact.yaml"), CONFIG);
  writeFileSync(path.join(repo, "SPECS.md"), specs(...items));
  const testDir = path.join(repo, "tests");
  mkdirSync(testDir, { recursive: true });
  writeFileSync(path.join(testDir, "calc.spec.ts"), `// ${specTag("x")}\ntest("a", () => {});\n`);
  const accept = runCli(["accept", "--yes"], { cwd: repo });
  if (accept.status !== 0) throw new Error(`baseline accept failed: ${accept.stderr}`);
  return repo;
}

/** Rewrite SPECS.md with new checklist items, then return the escalation questions the next check mints. */
function rewordAndCheck(repo: string, ...items: string[]): Array<{ id: string; kind: string; deleted: { id: string; text: string }[]; created: { text: string }[] }> {
  writeFileSync(path.join(repo, "SPECS.md"), specs(...items));
  const check = runCli(["check", "--json"], { cwd: repo });
  return JSON.parse(check.stdout).escalations;
}

function readEscalations(repo: string): { questions: { id: string; kind: string; deleted: { id: string }[]; created: { text: string }[] }[] } {
  return JSON.parse(readFileSync(path.join(repo, ".tripact", "escalations.json"), "utf8"));
}

const SUM = "addNumbers returns the sum of two integer inputs";
const SUM_REWORD = "addNumbers returns the total of two whole number values";
const SUB = "subtractNumbers returns the difference of two integer inputs";
const SUB_REWORD = "subtractNumbers returns the gap between two whole number values";

describe("tripact resolve — validation & exit convention (§7.2)", () => {
  // @specs:tripact-resolve.resolve-validates-referenced-question
  it("rejects an unknown question id and a shape-mismatched answer with exit 2, leaving the sidecar untouched", () => {
    const repo = baselinedRepo("tripact-resolve-validate-", SUM);
    const escalations = rewordAndCheck(repo, SUM_REWORD);
    const reanchor = escalations.find((e) => e.kind === "reanchor");
    expect(reanchor, "a reanchor question was minted by the reword").toBeTruthy();

    const sidecarPath = path.join(repo, ".tripact", "claims.json");
    const before = readFileSync(sidecarPath, "utf8");

    // (a) referenced question must exist — an unknown id exits 2.
    const unknown = runCli(["resolve", "no-such-question", "--dead", "whatever"], { cwd: repo });
    expect(unknown.status, `unknown id\n${unknown.stderr}`).toBe(2);

    // (b) the answer shape must match the question's kind — --dismiss is not a reanchor answer, exit 2.
    const wrongShape = runCli(["resolve", reanchor!.id, "--dismiss"], { cwd: repo });
    expect(wrongShape.status, `dismiss on reanchor\n${wrongShape.stderr}`).toBe(2);

    // Neither rejected call may have mutated the sidecar.
    expect(readFileSync(sidecarPath, "utf8"), "sidecar untouched by failed resolves").toBe(before);
  });
});

describe("tripact resolve — --dismiss is fork-review only (§7.2)", () => {
  // @specs:tripact-resolve.--dismiss-valid-only-fork-review
  it("dismisses a fork-review question and records it so a re-run does not re-emit it, and refuses --dismiss on non-forks", () => {
    // A wholly dissimilar replacement in the same group forks identity → an advisory fork-review question.
    const repo = baselinedRepo("tripact-resolve-dismiss-", SUM);
    const escalations = rewordAndCheck(repo, "the interface displays a persistent dark theme toggle in the header");
    const fork = escalations.find((e) => e.kind === "fork-review");
    expect(fork, "a fork-review question was minted by the dissimilar replacement").toBeTruthy();

    // --dismiss is valid only for fork-review: a reanchor question rejects it (proven in the other repo),
    // here it is accepted for the fork and drops the question from the queue.
    const dismiss = runCli(["resolve", fork!.id, "--dismiss"], { cwd: repo });
    expect(dismiss.status, `dismiss fork-review\n${dismiss.stderr}`).toBe(0);
    expect(readEscalations(repo).questions.some((q) => q.id === fork!.id), "question left the queue").toBe(false);

    // The dismissal is recorded (sidecar.dismissedForks) so a subsequent check does not re-emit the
    // same dead/created pair.
    const sidecar = JSON.parse(readFileSync(path.join(repo, ".tripact", "claims.json"), "utf8"));
    expect(sidecar.dismissedForks, "dismissal recorded in the sidecar").toContain(fork!.id);
    const recheck = runCli(["check", "--json"], { cwd: repo });
    const reEmitted = JSON.parse(recheck.stdout).escalations.map((e: { id: string }) => e.id);
    expect(reEmitted, "the dismissed fork is not re-emitted").not.toContain(fork!.id);
  });
});

describe("tripact resolve — partial disposition of a multi-atom question (§7.2)", () => {
  // @specs:tripact-resolve.resolving-one-atom-multi-atom
  it("shrinks a multi-atom reanchor in place, keeping the same id until no atoms remain", () => {
    // Rewording two sibling claims in one group yields a single reanchor question carrying both atoms.
    const repo = baselinedRepo("tripact-resolve-shrink-", SUM, SUB);
    const escalations = rewordAndCheck(repo, SUM_REWORD, SUB_REWORD);
    const reanchor = escalations.find((e) => e.kind === "reanchor")!;
    expect(reanchor.deleted.length, "two dead atoms").toBe(2);
    expect(reanchor.created.length, "two created atoms").toBe(2);
    const qid = reanchor.id;
    const addId = reanchor.deleted.find((d) => d.id.includes("addnumbers"))!.id;
    const subId = reanchor.deleted.find((d) => d.id.includes("subtractnumbers"))!.id;

    // Resolve ONE atom — the question must survive in place under the SAME id, one atom lighter.
    const first = runCli(["resolve", qid, "--match", `${addId}=${SUM_REWORD}`], { cwd: repo });
    expect(first.status, `first match\n${first.stderr}`).toBe(0);
    const afterOne = readEscalations(repo).questions.find((q) => q.id === qid);
    expect(afterOne, "question still present under the same id").toBeTruthy();
    expect(afterOne!.deleted.map((d) => d.id), "only the unresolved atom remains").toEqual([subId]);

    // Resolve the remaining atom — now empty, so the question leaves the queue.
    const second = runCli(["resolve", qid, "--match", `${subId}=${SUB_REWORD}`], { cwd: repo });
    expect(second.status, `second match\n${second.stderr}`).toBe(0);
    expect(readEscalations(repo).questions.some((q) => q.id === qid), "question gone once no atoms remain").toBe(false);
  });
});

describe("tripact resolve — clears drift & journals (§7.2)", () => {
  // @specs:tripact-resolve.resolving-every-question-re-running
  it("re-running check after resolving every question yields no reanchor/split-merge escalations", () => {
    const repo = baselinedRepo("tripact-resolve-cleared-", SUM);
    const escalations = rewordAndCheck(repo, SUM_REWORD);
    const reanchor = escalations.find((e) => e.kind === "reanchor")!;
    const oldId = reanchor.deleted[0]!.id;

    const res = runCli(["resolve", reanchor.id, "--match", `${oldId}=${SUM_REWORD}`], { cwd: repo });
    expect(res.status, `match\n${res.stderr}`).toBe(0);

    const recheck = runCli(["check", "--json"], { cwd: repo });
    const kinds = JSON.parse(recheck.stdout).escalations.map((e: { kind: string }) => e.kind);
    expect(kinds, "no reanchor/split-merge remains for the now-anchored content").not.toContain("reanchor");
    expect(kinds).not.toContain("split-merge");
  });

  // @specs:tripact-resolve.every-resolution-appended-tripactjournaljsonl
  it("appends every resolution to .tripact/journal.jsonl with a timestamp and the question id", () => {
    // Two resolutions against one multi-atom question → two journal lines, proving the append.
    const repo = baselinedRepo("tripact-resolve-journal-", SUM, SUB);
    const escalations = rewordAndCheck(repo, SUM_REWORD, SUB_REWORD);
    const reanchor = escalations.find((e) => e.kind === "reanchor")!;
    const qid = reanchor.id;
    const addId = reanchor.deleted.find((d) => d.id.includes("addnumbers"))!.id;
    const subId = reanchor.deleted.find((d) => d.id.includes("subtractnumbers"))!.id;

    expect(existsSync(path.join(repo, ".tripact", "journal.jsonl")), "no journal before any resolution").toBe(false);
    runCli(["resolve", qid, "--match", `${addId}=${SUM_REWORD}`], { cwd: repo });
    runCli(["resolve", qid, "--match", `${subId}=${SUB_REWORD}`], { cwd: repo });

    const lines = readFileSync(path.join(repo, ".tripact", "journal.jsonl"), "utf8").trim().split("\n");
    expect(lines.length, "one appended line per resolution").toBe(2);
    for (const line of lines) {
      const rec = JSON.parse(line);
      expect(rec.questionId, "each record carries the question id").toBe(qid);
      expect(rec.at, "each record carries an ISO timestamp").toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
    }
  });
});
