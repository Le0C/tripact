// A scratch repository fixture with all three layers, wired by a hand-written tripact.yaml. tripact
// ships no `init` command (layer detection is a judgement call, emitted as the `detect` skill), so
// consumers author the config directly — exactly what these tests exercise. The committed sidecar
// lives in `.tripact/`.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCli } from "./cli.js";

/** Prescriptive layer content (written to SPECS.md). */
export const SPECS = [
  "# Product Specification — Example",
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
export const TESTS = [
  'test("addNumbers sums two integers", () => {});',
  'test("Add button shows the sum", () => {});',
  "",
].join("\n");

export const CONFIG = [
  "schemaVersion: 1",
  "",
  "layers:",
  "  specs:",
  "    role: prescriptive",
  "    paths:",
  "      - SPECS.md",
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
  "  - [specs, tests]",
  "  - [manual, tests]",
  "",
].join("\n");

/**
 * A git repo carrying all three layers plus a hand-written tripact.yaml. Runs `check` once so the
 * escalation queue document (.tripact/escalations.json) exists for tests that read it. Returns the
 * repo path; the caller is responsible for cleanup.
 */
export function fullRepo(prefix = "tripact-fixture-"): string {
  const repo = mkdtempSync(path.join(os.tmpdir(), prefix));
  execFileSync("git", ["init", "-b", "main"], { cwd: repo });
  writeFileSync(path.join(repo, "SPECS.md"), SPECS);
  writeFileSync(path.join(repo, "tripact.yaml"), CONFIG);
  mkdirSync(path.join(repo, "docs", "manual"), { recursive: true });
  writeFileSync(path.join(repo, "docs", "manual", "using.md"), MANUAL);
  mkdirSync(path.join(repo, "tests", "e2e"), { recursive: true });
  writeFileSync(path.join(repo, "tests", "e2e", "calc.spec.ts"), TESTS);
  runCli(["check"], { cwd: repo }); // writes .tripact/escalations.json
  return repo;
}
