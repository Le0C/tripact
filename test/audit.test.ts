// `tripact audit` — the recorded history of one claim (UAC §21.1). Each scenario builds a scratch
// git repo with fixed commit identities and dates (audit output embeds author/date, so determinism
// assertions need pinned history), walks it through accept/commit cycles to lay down real sidecar
// archaeology, then drives `audit` through the prebuilt CLI. Dates are 2024 constants; the journal's
// own timestamps are the only now()-derived values and are asserted by presence, never by value.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

function specs(...items: string[]): string {
  return ["# Spec", "", "## 1. Calculator", "", "### 1.1 Addition", "", ...items.map((t) => `- [ ] ${t}`), ""].join("\n");
}

const SUM = "addNumbers returns the sum of two integer inputs";
const SUM_ID = "addition.addnumbers-returns-sum-two";
// Below the auto-match threshold, so the reword mints a reanchor question (§3.3) for resolve.
const SUM_REWORD = "addNumbers returns the total of two whole number values";

const D = ["2024-01-01 10:00:00 +0000", "2024-01-02 10:00:00 +0000", "2024-01-03 10:00:00 +0000", "2024-01-04 10:00:00 +0000", "2024-01-05 10:00:00 +0000"];

/** git with fixed identity AND a fixed author/committer date — audit renders both. */
function gitAt(repo: string, args: string[], date: string): string {
  return execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
  });
}

function commitAll(repo: string, message: string, date: string): void {
  gitAt(repo, ["add", "-A"], date);
  gitAt(repo, ["commit", "-qm", message], date);
}

/** `accept --yes`, then commit the whole tree with the printed trailer — a real sync-point (§8.1). */
function acceptAndCommit(repo: string, message: string, date: string): string {
  const acc = runCli(["accept", "--yes"], { cwd: repo });
  expect(acc.status, `accept failed:\n${acc.stderr}`).toBe(0);
  const m = acc.stdout.match(/tripact-sync-id: ([0-9a-f]+)/);
  expect(m, `no trailer in accept output:\n${acc.stdout}`).toBeTruthy();
  commitAll(repo, `${message}\n\ntripact-sync-id: ${m![1]}`, date);
  return m![1];
}

function newRepo(prefix: string, files: Record<string, string>, date = D[0]!): string {
  const repo = mkdtempSync(path.join(os.tmpdir(), prefix));
  scratch.push(repo);
  execFileSync("git", ["init", "-b", "main"], { cwd: repo });
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(repo, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
  commitAll(repo, "init", date);
  return repo;
}

interface AuditJson {
  schemaVersion: number;
  claim: { id: string; alive: boolean; layer: string; groupPath: string; text: string; verdicts: Array<{ edge: [string, string]; kind: string; tags: Array<{ file: string; line: number }> }> };
  events: Array<{ source: string; kind: string; detail: string; date?: string; commit?: string; author?: string; syncId?: string; file?: string; oldText?: string; newText?: string }>;
}

function auditJson(repo: string, id: string): AuditJson {
  const r = runCli(["audit", id, "--json"], { cwd: repo });
  expect(r.status, `audit failed:\n${r.stderr}`).toBe(0);
  return JSON.parse(r.stdout) as AuditJson;
}

const TAGGED_TEST = `// ${specTag(SUM_ID)}\ntest("sums", () => {});\n`;

/**
 * The shared lifecycle repo: created at D1's accept, verified at D2's, the test file edited at D3,
 * re-baselined at D4 — four dated waypoints of real archaeology.
 */
function lifecycleRepo(prefix: string): string {
  const repo = newRepo(prefix, { "tripact.yaml": CONFIG, "SPECS.md": specs(SUM) });
  acceptAndCommit(repo, "baseline spec", D[1]!);
  mkdirSync(path.join(repo, "tests"), { recursive: true });
  writeFileSync(path.join(repo, "tests", "calc.spec.ts"), TAGGED_TEST);
  acceptAndCommit(repo, "cover claim", D[2]!);
  writeFileSync(path.join(repo, "tests", "calc.spec.ts"), `${TAGGED_TEST}test("sums negatives", () => {});\n`);
  commitAll(repo, "strengthen the test", D[3]!);
  acceptAndCommit(repo, "re-baseline", D[4]!);
  return repo;
}

describe("tripact audit — sidecar archaeology (§21.1)", () => {
  // @specs:tripact-audit.tripact-audit-claim-id-reports
  // @specs:tripact-audit.sidecar-archaeology-audit-walks
  it("derives created / verified-recorded / re-baselined events from sidecar history, newest first, attributed to commits", () => {
    const repo = lifecycleRepo("tripact-audit-lifecycle-");
    const report = auditJson(repo, SUM_ID);
    const lifecycle = report.events.filter((e) => e.source === "sync-point");
    expect(lifecycle.map((e) => e.kind)).toEqual(["re-baselined", "verified-recorded", "created"]);
    // newest first across the whole timeline
    const dates = report.events.map((e) => e.date ?? "").filter(Boolean);
    expect([...dates].sort().reverse()).toEqual(dates);
    for (const e of lifecycle) {
      expect(e.commit, `event ${e.kind} carries its commit`).toBeTruthy();
      expect(e.author).toBe("t");
      expect(e.syncId, `event ${e.kind} carries the sync-point trailer`).toMatch(/^[0-9a-f]{16}$/);
    }
    expect(lifecycle[2]!.date!.startsWith("2024-01-02")).toBe(true);
    expect(lifecycle[1]!.date!.startsWith("2024-01-03")).toBe(true);
    expect(lifecycle[0]!.date!.startsWith("2024-01-05")).toBe(true);
  });

  // @specs:tripact-audit.header-card-shows-claims
  it("renders the header card — id, aliveness, layer, group path, text, per-edge verdict — with the event count first", () => {
    const repo = lifecycleRepo("tripact-audit-card-");
    const r = runCli(["audit", SUM_ID], { cwd: repo });
    expect(r.status).toBe(0);
    const lines = r.stdout.split("\n");
    expect(lines[0]).toMatch(new RegExp(`^tripact audit ${SUM_ID} — \\d+ event\\(s\\)$`));
    expect(r.stdout).toContain(`CLAIM ${SUM_ID}  [alive]`);
    expect(r.stdout).toContain("specs › 1. Calculator > 1.1 Addition");
    expect(r.stdout).toContain(`"${SUM.toLowerCase()}"`);
    expect(r.stdout).toMatch(/specs↔tests {2}covered — tests\/calc\.spec\.ts:\d+/);
    // the count line precedes the card and the timeline
    expect(lines.indexOf("TIMELINE")).toBeGreaterThan(0);
  });

  // @specs:tripact-audit.accepted-but-uncommitted-sidecar-surfaces-undated
  it("an accepted-but-uncommitted baseline surfaces as undated uncommitted events ordered ahead of dated ones", () => {
    const repo = newRepo("tripact-audit-uncommitted-", { "tripact.yaml": CONFIG, "SPECS.md": specs(SUM) });
    acceptAndCommit(repo, "baseline spec", D[1]!);
    mkdirSync(path.join(repo, "tests"), { recursive: true });
    writeFileSync(path.join(repo, "tests", "calc.spec.ts"), TAGGED_TEST);
    const acc = runCli(["accept", "--yes"], { cwd: repo }); // accepted, NOT committed
    expect(acc.status).toBe(0);
    const report = auditJson(repo, SUM_ID);
    const first = report.events[0]!;
    expect(first.date).toBeUndefined();
    expect(first.kind).toBe("verified-recorded");
    expect(first.detail).toMatch(/\(uncommitted\)$/);
    expect(report.events.at(-1)!.kind).toBe("created");
    expect(report.events.at(-1)!.date).toBeTruthy();
  });

  // @specs:tripact-audit.commits-touching-file-named
  it("commits touching a verifying test file appear as test-history events marked file-level, never claim-precise", () => {
    const repo = lifecycleRepo("tripact-audit-filelevel-");
    const report = auditJson(repo, SUM_ID);
    const fileEvents = report.events.filter((e) => e.source === "test-history");
    expect(fileEvents).toHaveLength(1); // only the D3 edit — accept commits are sync-point events, not file noise
    expect(fileEvents[0]!.kind).toBe("file-edited");
    expect(fileEvents[0]!.file).toBe("tests/calc.spec.ts");
    expect(fileEvents[0]!.detail).toContain("(file-level)");
    expect(fileEvents[0]!.date!.startsWith("2024-01-04")).toBe(true);
  });
});

describe("tripact audit — adjudications, rewording, death (§21.1)", () => {
  // @specs:tripact-audit.journal-entries-naming-claim
  it("a resolve --match adjudication appears as a journal event, and the accept records the reword with both texts", () => {
    const repo = newRepo("tripact-audit-journal-", { "tripact.yaml": CONFIG, "SPECS.md": specs(SUM) });
    acceptAndCommit(repo, "baseline spec", D[1]!);
    writeFileSync(path.join(repo, "SPECS.md"), specs(SUM_REWORD));
    const check = runCli(["check", "--json"], { cwd: repo });
    const question = (JSON.parse(check.stdout).escalations as Array<{ id: string; kind: string }>).find((e) => e.kind === "reanchor");
    expect(question, "the reword minted a reanchor question").toBeTruthy();
    const res = runCli(["resolve", question!.id, "--match", `${SUM_ID}=${SUM_REWORD}`], { cwd: repo });
    expect(res.status, res.stderr).toBe(0);
    acceptAndCommit(repo, "accept reword", D[2]!);

    const report = auditJson(repo, SUM_ID);
    const adjudication = report.events.find((e) => e.source === "adjudication");
    expect(adjudication).toBeTruthy();
    expect(adjudication!.kind).toBe("resolve-match");
    expect(adjudication!.date, "journal events carry their recorded timestamp").toBeTruthy();
    const reword = report.events.find((e) => e.kind === "reworded");
    expect(reword).toBeTruthy();
    expect(reword!.oldText).toBe(SUM.toLowerCase());
    expect(reword!.newText).toBe(SUM_REWORD.toLowerCase());
  });

  // @specs:tripact-audit.auditing-dead-claim-works
  it("audits a dead claim: [dead] header with last text, and a retired event in the timeline", () => {
    const repo = newRepo("tripact-audit-dead-", { "tripact.yaml": CONFIG, "SPECS.md": specs(SUM) });
    acceptAndCommit(repo, "baseline spec", D[1]!);
    // dissimilar replacement → an advisory fork-review question, which never blocks accept (§8.3)
    writeFileSync(path.join(repo, "SPECS.md"), specs("the settings page lists every configured layer name"));
    acceptAndCommit(repo, "replace the claim", D[2]!);

    const human = runCli(["audit", SUM_ID], { cwd: repo });
    expect(human.status).toBe(0);
    expect(human.stdout).toContain(`CLAIM ${SUM_ID}  [dead]`);
    expect(human.stdout).toContain("last text:");
    const report = auditJson(repo, SUM_ID);
    expect(report.claim.alive).toBe(false);
    expect(report.events.map((e) => e.kind)).toContain("retired");
  });

  // @specs:tripact-audit.unknown-claim-id-exits
  it("an unknown claim id exits 2 and names the nearest known ids", () => {
    const repo = newRepo("tripact-audit-unknown-", { "tripact.yaml": CONFIG, "SPECS.md": specs(SUM) });
    acceptAndCommit(repo, "baseline spec", D[1]!);
    const r = runCli(["audit", "addition.addnumbers-returns-sum-tow"], { cwd: repo });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("unknown claim id");
    expect(r.stderr).toContain(SUM_ID);
  });
});

describe("tripact audit — output contract (§21.1)", () => {
  // @specs:tripact-audit.audit---json-emits-header
  it("--json carries schemaVersion, the claim card, and the timeline; drift never turns the exit into 1", () => {
    const repo = lifecycleRepo("tripact-audit-json-");
    // introduce unaccepted drift: audit stays advisory
    writeFileSync(path.join(repo, "tests", "calc.spec.ts"), `${TAGGED_TEST}test("even more", () => {});\n`);
    const r = runCli(["audit", SUM_ID, "--json"], { cwd: repo });
    expect(r.status).toBe(0);
    const report = JSON.parse(r.stdout) as AuditJson;
    expect(report.schemaVersion).toBe(1);
    expect(Object.keys(report).sort()).toEqual(["claim", "events", "schemaVersion"]);
    expect(report.claim.id).toBe(SUM_ID);
    expect(report.events.length).toBeGreaterThan(0);
  });

  // @specs:tripact-audit.audit-writes-nothing-identical
  it("writes nothing and renders byte-identical output across runs", () => {
    const repo = lifecycleRepo("tripact-audit-determinism-");
    const sidecarBefore = readFileSync(path.join(repo, ".tripact", "claims.json"), "utf8");
    const first = runCli(["audit", SUM_ID, "--json"], { cwd: repo });
    const second = runCli(["audit", SUM_ID, "--json"], { cwd: repo });
    const humanFirst = runCli(["audit", SUM_ID], { cwd: repo });
    const humanSecond = runCli(["audit", SUM_ID], { cwd: repo });
    expect(first.stdout).toBe(second.stdout);
    expect(humanFirst.stdout).toBe(humanSecond.stdout);
    expect(readFileSync(path.join(repo, ".tripact", "claims.json"), "utf8")).toBe(sidecarBefore);
  });

  // @specs:tripact-audit.human-timeline-truncates-past
  it("truncates the human timeline past the threshold naming --long, while --json always carries every event", () => {
    // created first, then 13 tagged test files land in a second accept → 13 verified-recorded
    // events + created = 14 > the listing threshold
    const repo = newRepo("tripact-audit-truncate-", { "tripact.yaml": CONFIG, "SPECS.md": specs(SUM) });
    acceptAndCommit(repo, "baseline spec", D[1]!);
    mkdirSync(path.join(repo, "tests"), { recursive: true });
    for (let i = 0; i < 13; i++) writeFileSync(path.join(repo, "tests", `t${String(i).padStart(2, "0")}.spec.ts`), TAGGED_TEST);
    acceptAndCommit(repo, "cover from 13 files", D[2]!);

    const short = runCli(["audit", SUM_ID], { cwd: repo });
    expect(short.stdout).toMatch(/… and \d+ more — run with --long to see all/);
    const long = runCli(["audit", SUM_ID, "--long"], { cwd: repo });
    expect(long.stdout).not.toContain("… and");
    const report = auditJson(repo, SUM_ID);
    expect(report.events).toHaveLength(14);
  });
});
