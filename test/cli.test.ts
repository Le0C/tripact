// End-to-end smoke of tripact's thin CLI, driven the way a foreign harness would: a scratch git
// repo with a hand-written tripact.yaml (no `init`), then the kernel commands over a full lifecycle.
// Proves the extracted kernel is usable standalone — check → tasks → accept → level, the 0/1/2 exit
// convention, and byte-identical output for an unchanged tree (the determinism property the kernel
// guarantees, checked here in miniature since determinism.test.ts's full harness form stays in a
// full harness).
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { runCli } from "./helpers/cli.js";
import { fullRepo, SPECS } from "./helpers/fixture.js";

const scratch: string[] = [];
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});

function track(repo: string): string {
  scratch.push(repo);
  return repo;
}

describe("tripact CLI end-to-end", () => {
  it("runs the check → tasks → accept lifecycle and reaches level", () => {
    const repo = track(fullRepo("tripact-cli-life-"));

    // 1 — drift. Untagged tests leave every claim new-uncovered; check reports drift and exits 1,
    // and the repair queue (tasks) agrees.
    const check = runCli(["check", "--json"], { cwd: repo });
    expect(check.status, `check on drift\n${check.stderr}`).toBe(1);
    const report = JSON.parse(check.stdout);
    expect(report.schemaVersion).toBe(1);
    expect(report.exitCode).toBe(1);
    expect(runCli(["tasks"], { cwd: repo }).status, "tasks with a non-empty queue").toBe(1);

    // 0 — level. Accepting baselines the current state: still-uncovered claims become acknowledged
    // backlog, which is not drift. accept exits 0, writes the sidecar, and prints the trailer.
    const accept = runCli(["accept", "--yes"], { cwd: repo });
    expect(accept.status, `accept\n${accept.stderr}`).toBe(0);
    expect(accept.stdout).toContain("tripact-sync-id:");
    expect(existsSync(path.join(repo, ".prodsync", "claims.json")), "sidecar written").toBe(true);

    // The next check is level → 0.
    expect(runCli(["check"], { cwd: repo }).status, "check after accept — backlog is not drift").toBe(0);
  });

  it("verify round-trips the accepted trailer", () => {
    const repo = track(fullRepo("tripact-cli-verify-"));
    const accept = runCli(["accept", "--yes"], { cwd: repo });
    expect(accept.status, accept.stderr).toBe(0);
    const trailer = accept.stdout.match(/tripact-sync-id:\s*(\S+)/)?.[1];
    expect(trailer, "trailer present in accept output").toBeTruthy();

    expect(runCli(["verify", trailer!], { cwd: repo }).status, "verify matching hash").toBe(0);
    expect(runCli(["verify", "deadbeef"], { cwd: repo }).status, "verify stale hash").toBe(1);
  });

  it("emits byte-identical --json for an unchanged tree (determinism)", () => {
    const repo = track(fullRepo("tripact-cli-determ-"));
    for (const args of [["check", "--json"], ["tasks", "--json"], ["claims", "--json"], ["status", "--json"]]) {
      const a = runCli(args, { cwd: repo }).stdout;
      const b = runCli(args, { cwd: repo }).stdout;
      expect(b, `${args.join(" ")} is not deterministic`).toBe(a);
    }
  });

  it("follows the 0/1/2 exit convention", () => {
    const repo = track(fullRepo("tripact-cli-exit-"));

    // 0 — level (diff previews, writing nothing).
    expect(runCli(["diff"], { cwd: repo }).status, "diff preview").toBe(0);

    // 2 — usage error. Commander parse failures route through the convention: an unknown command
    // and an unknown option both exit 2, never commander's default 1.
    expect(runCli(["frobnicate"], { cwd: repo }).status, "unknown command").toBe(2);
    expect(runCli(["check", "--nope"], { cwd: repo }).status, "unknown option").toBe(2);
    // resolve requires exactly one adjudication flag; none given is a usage error.
    expect(runCli(["resolve", "some-id"], { cwd: repo }).status, "resolve with no answer flag").toBe(2);

    // 2 — environment error. Outside a git repo the kernel has no history to anchor sync-points to.
    const noGit = track(mkdtempSync(path.join(os.tmpdir(), "tripact-cli-nogit-")));
    writeFileSync(path.join(noGit, "SPECS.md"), SPECS);
    expect(runCli(["check"], { cwd: noGit }).status, "check outside a git repo").toBe(2);
  });

  it("prints help and version cleanly (exit 0)", () => {
    const repo = track(mkdtempSync(path.join(os.tmpdir(), "tripact-cli-help-")));
    execFileSync("git", ["init", "-b", "main"], { cwd: repo });
    const help = runCli(["--help"], { cwd: repo });
    expect(help.status, "--help exit").toBe(0);
    expect(help.stdout).toContain("The deterministic traceability kernel");
    const version = runCli(["--version"], { cwd: repo });
    expect(version.status, "--version exit").toBe(0);
    expect(version.stdout.trim()).toBe("0.0.1");
  });
});
