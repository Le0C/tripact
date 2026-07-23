// Two reporting defects found while reading real output during the ngx-dev-toolbar trial
// (2026-07-22), both of which made a correct number look like a different, wrong one.
//
// @specs:tripact-status.per-edge-line-accounts-every
// @specs:tripact-accept.acceptance-summary-headed-command
import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { runCli } from "./helpers/cli.js";
import { fullRepo, specTag } from "./helpers/fixture.js";

const scratch: string[] = [];
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});

function track(repo: string): string {
  scratch.push(repo);
  return repo;
}

/** Tag one of the fixture's two claims, so the repo holds a genuinely pending verdict. */
function tagOneClaim(repo: string): void {
  writeFileSync(
    path.join(repo, "tests", "e2e", "calc.spec.ts"),
    [
      `// ${specTag("addition.addnumbers-returns-sum-two")}`,
      'test("addNumbers sums two integers", () => {});',
      'test("Add button shows the sum", () => {});',
      "",
    ].join("\n"),
  );
}

describe("status accounts for every verdict on the edge (§6.1)", () => {
  it("names the pending count, so the parts sum to the edge's verdict total", () => {
    const repo = track(fullRepo("nit-status-pending-"));
    tagOneClaim(repo);

    const out = runCli(["status"], { cwd: repo }).stdout;
    // One claim tagged but never accepted — the state that was invisible before: the line read
    // "0 covered … 1 uncovered" over 2 verdicts, and the pending one was nowhere in it.
    expect(out).toContain("edge specs ↔ tests: 0% covered (0 covered, 1 pending, 0 stale, 1 uncovered)");

    // The stated parts must reconcile against the edge's own verdict count, whatever the numbers.
    const line = out.split("\n").find((l) => l.startsWith("edge specs ↔ tests:")) ?? "";
    const parts = [...line.matchAll(/(\d+) (covered|pending|stale|uncovered)/g)].map((m) => Number(m[1]));
    const total = runCli(["check", "--json"], { cwd: repo }).stdout;
    const verdicts = (JSON.parse(total) as { verdicts: Array<{ edge: [string, string] }> }).verdicts.filter(
      (v) => v.edge[0] === "specs" && v.edge[1] === "tests",
    );
    expect(parts.reduce((a, b) => a + b, 0)).toBe(verdicts.length);
  });
});

describe("the acceptance summary is headed by its own command (§8.3)", () => {
  it("accept titles the summary it is about to act on as accept, not as the read-only preview", () => {
    const repo = track(fullRepo("nit-accept-heading-"));
    tagOneClaim(repo);

    const accept = runCli(["accept", "--yes"], { cwd: repo });
    expect(accept.stdout).toContain("tripact accept — what will be recorded");
    expect(accept.stdout).not.toContain("tripact diff —");
    // Still the command that writes: the trailer it prints is what the operator commits.
    expect(accept.stdout).toContain("tripact-sync-id:");
  });

  it("diff keeps its own heading — it is the surface that writes nothing", () => {
    const repo = track(fullRepo("nit-diff-heading-"));
    tagOneClaim(repo);

    const diff = runCli(["diff"], { cwd: repo });
    expect(diff.stdout).toContain("tripact diff — what acceptance would change");
    expect(diff.stdout).not.toContain("tripact accept —");
  });
});
