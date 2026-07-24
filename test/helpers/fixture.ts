// A scratch repository fixture with all three layers, wired by a hand-written tripact.yaml. tripact
// ships no `init` command (layer detection is a judgement call, emitted as the `detect` skill), so
// consumers author the config directly, which is what these tests exercise. The committed sidecar
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

// Untagged on purpose: the tests exist but tag no claim, so every claim starts life uncovered,
// which is the drift state the exit-code and payload assertions rely on.
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
  "  docs:",
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
  "  - [docs, tests]",
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

// Tag composers for SCRATCH-REPO fixture files. Always build a fixture's `@specs:`/`@docs:` tag
// through these. Never write the literal into this suite's source.
//
// This repository dogfoods tripact: its own `tests` layer scans `test/**/*.test.ts` for those very
// patterns. A literal fixture tag here is indistinguishable, to the scanner, from a coverage tag on
// one of this repo's own claims, so it gets read as a tag naming a claim that does not exist in
// this repo's UAC.md and reported as an orphan tag, i.e. drift. Composing the prefix at runtime
// keeps the literal out of this source while the scratch repo still receives the tag it needs.
const AT = "@";
export const specTag = (id: string): string => `${AT}specs:${id}`;
export const docsTag = (slug: string): string => `${AT}docs:${slug}`;

/**
 * A cross-platform `shell:` generator for fixtures. A generator runs under the platform's shell —
 * `/bin/sh` on Unix, `cmd.exe` on Windows (see src/derived.ts) — so a fixture written in one shell's
 * dialect (`printf`, `$(...)`, `; exit 3`) does not behave the same on the other, which is exactly
 * what made the Windows CI job red. Routing through `node -e` sidesteps every shell dialect: node is
 * always present (this suite runs on it) and behaves identically on every OS.
 *
 * The JS `body` MUST use single quotes for strings and contain no shell metacharacters
 * (`$ \` % & | < > ( ) ;`), so the surrounding `node -e "..."` parses the same under `sh` and
 * `cmd.exe`. Put any logic (counters, exit codes, stderr) inside the JS, never in shell syntax.
 */
export const shellNode = (body: string): string => `shell:node -e "${body}"`;
