// Write-target containment (UAC §18.5): a generated artefact is never written outside the
// repository root, including through a symbolic link.
//
// Config validation already rejects paths that SPELL an escape. It cannot reject a link, because it
// is deliberately pure — it resolves against a notional root so a config validates the same on every
// machine. So this is the second check, against the filesystem, at the moment of writing.

import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { OutsideRootError, resolveWriteTarget } from "../src/derived.js";
import { git, runCli } from "./helpers/cli.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function scratch(prefix: string): string {
  const d = mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(d);
  return d;
}

const CONFIG = (extra: string) =>
  [
    "schemaVersion: 1",
    "layers:",
    "  specs:",
    "    role: prescriptive",
    "    paths: [SPEC.md]",
    "  tests:",
    "    role: verificatory",
    "    paths: [test/**/*.test.ts]",
    "edges:",
    "  - [specs, tests]",
    extra,
    "",
  ].join("\n");

/** A git repo with a spec, a test, and whatever `extra` config the case needs. */
function repo(extra: string): string {
  const d = scratch("tri-contain-");
  mkdirSync(path.join(d, "test"), { recursive: true });
  writeFileSync(path.join(d, "SPEC.md"), "# S\n\n## G\n\n- [ ] a claim\n");
  writeFileSync(path.join(d, "test", "a.test.ts"), 'test("x", () => {});\n');
  writeFileSync(path.join(d, "tripact.yaml"), CONFIG(extra));
  git(d, ["init", "-q"]);
  return d;
}

describe("write-target containment (§18.5)", () => {
  it("@specs:shell-generator-trust.containment-enforced-again-point - refuses a derived output reached through a symlink out of the repo", () => {
    const outside = path.join(scratch("tri-outside-"), "ESCAPED.md");
    const d = repo(
      ["derived:", "  evil:", "    output: ok/fine.md", '    generator: "builtin:hotlink-map"'].join("\n"),
    );
    mkdirSync(path.join(d, "ok"));
    symlinkSync(outside, path.join(d, "ok", "fine.md"));

    const r = runCli(["generate"], { cwd: d });
    expect(r.status).toBe(2);
    expect(r.stderr + r.stdout).toMatch(/refusing to write/);
    expect(r.stderr + r.stdout).toMatch(/outside the repository root/);
    expect(existsSync(outside)).toBe(false);
  });

  it("@specs:shell-generator-trust.containment-enforced-again-point - refuses a DANGLING symlink, whose target does not exist yet", () => {
    // The case that matters most, and the one an existsSync-based check misses: existsSync follows
    // the link, so a link to a not-yet-created file reads as "nothing there" — while writing to it
    // is precisely what creates the file outside the repo.
    const outside = path.join(scratch("tri-outside-"), "NOT-YET.md");
    expect(existsSync(outside)).toBe(false);

    const d = repo(
      ["derived:", "  evil:", "    output: ok/fine.md", '    generator: "builtin:hotlink-map"'].join("\n"),
    );
    mkdirSync(path.join(d, "ok"));
    symlinkSync(outside, path.join(d, "ok", "fine.md"));
    expect(lstatSync(path.join(d, "ok", "fine.md")).isSymbolicLink()).toBe(true);

    expect(runCli(["generate"], { cwd: d }).status).toBe(2);
    expect(existsSync(outside)).toBe(false);
  });

  it("@specs:shell-generator-trust.containment-enforced-again-point - refuses a block-region file reached through a symlink", () => {
    const outsideDir = scratch("tri-outside-");
    const outside = path.join(outsideDir, "PAGE.md");
    writeFileSync(outside, "# Doc\n\n<!-- tripact:hotlink-map -->\n<!-- /tripact:hotlink-map -->\n");
    const before = readFileSync(outside, "utf8");

    const d = repo(["blocks:", "  paths: [docs/**/*.md]", "  generators:", '    hotlink-map: "builtin:hotlink-map"'].join("\n"));
    mkdirSync(path.join(d, "docs"));
    symlinkSync(outside, path.join(d, "docs", "page.md"));

    const r = runCli(["generate"], { cwd: d });
    expect(r.status).toBe(2);
    expect(readFileSync(outside, "utf8")).toBe(before); // untouched
  });

  it("@specs:shell-generator-trust.containment-enforced-again-point - refuses a symlinked directory on the way down", () => {
    // The link need not be the file itself: a linked parent directory escapes just as well.
    const outsideDir = scratch("tri-outside-");
    const d = repo(
      ["derived:", "  evil:", "    output: linked/out.md", '    generator: "builtin:hotlink-map"'].join("\n"),
    );
    symlinkSync(outsideDir, path.join(d, "linked"));

    expect(runCli(["generate"], { cwd: d }).status).toBe(2);
    expect(existsSync(path.join(outsideDir, "out.md"))).toBe(false);
  });

  it("@specs:shell-generator-trust.containment-enforced-again-point - allows an ordinary in-repo path, and a link that stays inside", () => {
    const d = repo(
      ["derived:", "  fine:", "    output: docs/map.md", '    generator: "builtin:hotlink-map"'].join("\n"),
    );
    // Plain path: written.
    expect(runCli(["generate"], { cwd: d }).status).toBe(0);
    expect(existsSync(path.join(d, "docs", "map.md"))).toBe(true);

    // A link is not itself the problem — leaving the root is. One pointing inside is fine.
    mkdirSync(path.join(d, "real"), { recursive: true });
    writeFileSync(path.join(d, "real", "target.md"), "");
    symlinkSync(path.join(d, "real", "target.md"), path.join(d, "docs", "linked.md"));
    expect(() => resolveWriteTarget(d, "docs/linked.md")).not.toThrow();
  });

  it("@specs:shell-generator-trust.containment-enforced-again-point - resolveWriteTarget throws OutsideRootError, naming the real destination", () => {
    const outside = path.join(scratch("tri-outside-"), "X.md");
    const d = repo("");
    symlinkSync(outside, path.join(d, "link.md"));

    expect(() => resolveWriteTarget(d, "link.md")).toThrow(OutsideRootError);
    try {
      resolveWriteTarget(d, "link.md");
    } catch (e) {
      // The message has to name where it actually resolved, or the operator cannot tell which link
      // on the path is the problem.
      expect((e as Error).message).toContain("X.md");
      expect((e as Error).message).toMatch(/symbolic link/);
    }
  });
});
