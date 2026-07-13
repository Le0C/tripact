// A scratch repository fixture with all three layers, wired by a hand-written prodsync.yaml. tripact
// ships no `init` command (layer scaffolding is a harness concern), so foreign consumers author the
// config directly — exactly what these tests exercise. The on-disk names keep prodsync branding for
// now (prodsync.yaml, .prodsync/) — a deliberate transitional choice.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCli } from "./cli.js";

export const UAC = [
  "# User Acceptance Criteria — Example",
  "",
  "## 1. Calculator",
  "",
  "### 1.1 Addition",
  "",
  "- [ ] addNumbers returns the sum of two integer inputs",
  "- [ ] Entering two numbers and clicking Add shows the sum on screen",
  "",
].join("\n");

export const MANUAL = [
  "# Using the calculator",
  "",
  "## Adding numbers",
  "",
  "- [ ] Type a number in each input field",
  "- [ ] Click Add to see the result",
  "",
].join("\n");

// Untagged on purpose: the tests exist but tag no claim, so every claim starts life uncovered —
// the drift state the exit-code and payload assertions rely on.
export const SPEC = [
  'test("addNumbers sums two integers", () => {});',
  'test("Add button shows the sum", () => {});',
  "",
].join("\n");

export const CONFIG = [
  "schemaVersion: 1",
  "",
  "layers:",
  "  uac:",
  "    role: prescriptive",
  "    paths:",
  "      - UAC.md",
  "  manual:",
  "    role: descriptive",
  "    paths:",
  "      - docs/manual/**/*.md",
  "  tests:",
  "    role: verificatory",
  "    paths:",
  "      - tests/**/*.spec.ts",
  "",
  "edges:",
  "  - [uac, tests]",
  "  - [manual, tests]",
  "",
].join("\n");

/**
 * A git repo carrying all three layers plus a hand-written prodsync.yaml. Runs `check` once so the
 * escalation queue document (.prodsync/escalations.json) exists for tests that read it. Returns the
 * repo path; the caller is responsible for cleanup.
 */
export function fullRepo(prefix = "tripact-fixture-"): string {
  const repo = mkdtempSync(path.join(os.tmpdir(), prefix));
  execFileSync("git", ["init", "-b", "main"], { cwd: repo });
  writeFileSync(path.join(repo, "UAC.md"), UAC);
  writeFileSync(path.join(repo, "prodsync.yaml"), CONFIG);
  mkdirSync(path.join(repo, "docs", "manual"), { recursive: true });
  writeFileSync(path.join(repo, "docs", "manual", "using.md"), MANUAL);
  mkdirSync(path.join(repo, "tests", "e2e"), { recursive: true });
  writeFileSync(path.join(repo, "tests", "e2e", "calc.spec.ts"), SPEC);
  runCli(["check"], { cwd: repo }); // writes .prodsync/escalations.json
  return repo;
}
