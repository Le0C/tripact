// `tripact detect` (UAC §2.3): a read-only report of which spec system(s) the repo matches by
// signature, either none, one, or several (ambiguous), so an agent or harness can drive `kind:`
// selection from the registry.
// @specs:spec-system-presets.tripact-detect-reports-read-only
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { git, runCli } from "./helpers/cli.js";

const scratch: string[] = [];
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});

function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tripact-detect-"));
  scratch.push(dir);
  git(dir, ["init", "-b", "main"]);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return dir;
}

describe("tripact detect (§2.3)", () => {
  it("reports exactly one match, and writes nothing", () => {
    const dir = repo({ ".specify/x.md": "s", "specs/001-x/spec.md": "# s" });
    const json = JSON.parse(runCli(["detect", "--json"], { cwd: dir }).stdout);
    expect(json).toMatchObject({ schemaVersion: 1, matched: ["spec-kit"], ambiguous: false });
    expect(runCli(["detect"], { cwd: dir }).stdout).toContain("kind: spec-kit");
    expect(existsSync(path.join(dir, ".tripact")), "detect is read-only — no sidecar written").toBe(false);
  });

  it("reports several matches as ambiguous, without picking one", () => {
    const dir = repo({ ".specify/x.md": "s", "specs/001-x/spec.md": "# s", "docs/r.sdoc": "[DOCUMENT]\n" });
    const json = JSON.parse(runCli(["detect", "--json"], { cwd: dir }).stdout);
    expect(json.matched.sort()).toEqual(["spec-kit", "strictdoc"]);
    expect(json.ambiguous).toBe(true);
    expect(runCli(["detect"], { cwd: dir }).stdout).toMatch(/ambiguous/i);
  });

  it("reports no match on a plain repo", () => {
    const dir = repo({ "README.md": "# hi" });
    const json = JSON.parse(runCli(["detect", "--json"], { cwd: dir }).stdout);
    expect(json.matched).toEqual([]);
    expect(json.ambiguous).toBe(false);
    expect(runCli(["detect"], { cwd: dir }).stdout).toContain("no known spec system");
  });

  it("exits 0 regardless of match (a report, not a gate)", () => {
    expect(runCli(["detect"], { cwd: repo({ "README.md": "x" }) }).status).toBe(0);
    expect(runCli(["detect"], { cwd: repo({ ".cursor/specs/f.md": "# f" }) }).status).toBe(0);
  });
});
