// Sync-point convention, trailer verification, `tripact accept`, and the acceptance preview
// (`tripact diff`) — UAC §8.1–§8.4. Driven end-to-end against the prebuilt CLI the way a foreign
// harness would: hand-written tripact.yaml, no `init`. Each scratch repo is built, baselined via
// `accept`, then mutated (reword / fork / reanchor) so the delta machinery has something to report.
// Deterministic throughout: escalation ids and content hashes are content-derived, no clock.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { cliInvocation, git, runCli } from "./helpers/cli.js";
import { specTag } from "./helpers/fixture.js";

const scratch: string[] = [];
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});

// A two-layer (prescriptive specs ↔ verificatory tests) config — the smallest tree that exercises
// anchoring + verified states without the descriptive layer's slug machinery getting in the way.
const CONFIG = [
  "schemaVersion: 1",
  "",
  "layers:",
  "  specs:",
  "    role: prescriptive",
  "    paths:",
  "      - SPECS.md",
  "  tests:",
  "    role: verificatory",
  "    paths:",
  "      - tests/**/*.spec.ts",
  "",
  "edges:",
  "  - [specs, tests]",
  "",
].join("\n");

const specs = (lastLine: string): string =>
  ["# Product Specification", "", "## 1. Calculator", "", "### 1.1 Addition", "", lastLine, ""].join("\n");

// id derived by the kernel from the atom text below is `addition.addnumbers-returns-sum-two`.
const ATOM = "- [ ] addNumbers returns the sum of two integer inputs";
const ATOM_REWORD = "- [ ] addNumbers returns the sum of two integer values"; // ≥0.9 → auto-match, id kept

/** Build a git repo from a file map (dirs auto-created), commit it, return the path. */
function newRepo(files: Record<string, string>, prefix = "tripact-accept-"): string {
  const repo = mkdtempSync(path.join(os.tmpdir(), prefix));
  scratch.push(repo);
  execFileSync("git", ["init", "-b", "main"], { cwd: repo });
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(repo, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-m", "init"]);
  return repo;
}

/** A repo whose single spec atom is covered by a tagged test, already baselined via `accept`. */
function coveredBaseline(prefix: string): string {
  const repo = newRepo(
    {
      "tripact.yaml": CONFIG,
      "SPECS.md": specs(ATOM),
      "tests/e2e/calc.spec.ts": `// ${specTag("addition.addnumbers-returns-sum-two")}\ntest("sums", () => {});\n`,
    },
    prefix,
  );
  const acc = runCli(["accept", "--yes"], { cwd: repo });
  expect(acc.status, `baseline accept\n${acc.stderr}`).toBe(0);
  return repo;
}

describe("Sync-point convention & trailer verification (§8.1, §8.2)", () => {
  // @specs:sync-point-convention.commit-whose-message-body
  // @specs:tripact-accept.after-accept-commit-carrying
  it("a commit carrying the trailer marks a sync-point, check finds the most recent, and exits 0", () => {
    const repo = newRepo(
      { "tripact.yaml": CONFIG, "SPECS.md": specs(ATOM), "tests/e2e/calc.spec.ts": 'test("x", () => {});\n' },
      "tripact-syncpoint-",
    );

    // Before any trailer commit there is nothing to anchor to: a full audit, no sync-point.
    expect(runCli(["check"], { cwd: repo }).stdout).toContain("no sync-point found");

    // accept baselines, then a commit whose message *body* carries the trailer marks the sync-point.
    const acc = runCli(["accept", "--yes"], { cwd: repo });
    const hash = acc.stdout.match(/tripact-sync-id:\s*(\S+)/)?.[1];
    expect(hash, "accept printed a trailer").toBeTruthy();
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-m", `accept\n\ntripact-sync-id: ${hash}`]);
    const head1 = git(repo, ["rev-parse", "HEAD"]).trim();

    const check1 = runCli(["check"], { cwd: repo });
    // After accept + a commit carrying the trailer, an immediately following check exits 0.
    expect(check1.status, `check after accept+commit\n${check1.stdout}`).toBe(0);
    const reported1 = check1.stdout.match(/sync-point\s+([0-9a-f]+)/)?.[1];
    expect(reported1, "check names the sync-point commit").toBeTruthy();
    expect(head1.startsWith(reported1!), "sync-point is the trailer-carrying commit").toBe(true);

    // A newer trailer-carrying commit becomes the sync-point — check finds the MOST RECENT via git log.
    git(repo, ["commit", "--allow-empty", "-m", `bump\n\ntripact-sync-id: ${hash}`]);
    const head2 = git(repo, ["rev-parse", "HEAD"]).trim();
    expect(head2).not.toBe(head1);
    const reported2 = runCli(["check"], { cwd: repo }).stdout.match(/sync-point\s+([0-9a-f]+)/)?.[1];
    expect(head2.startsWith(reported2!), "check advances to the newest sync-point").toBe(true);
    expect(head1.startsWith(reported2!), "the older sync-point is no longer reported").toBe(false);
  });

  // @specs:trailer-verification.tripact-accept---dry-run-prints
  it("accept --dry-run prints the would-be trailer without writing the sidecar or clearing escalations", () => {
    const repo = newRepo(
      { "tripact.yaml": CONFIG, "SPECS.md": specs(ATOM), "tests/e2e/calc.spec.ts": 'test("x", () => {});\n' },
      "tripact-dryrun-",
    );
    const dry = runCli(["accept", "--dry-run"], { cwd: repo });
    expect(dry.status, dry.stderr).toBe(0);
    expect(dry.stdout).toContain("dry run — sidecar not written, escalations untouched");
    expect(dry.stdout).toContain("a real accept would print this trailer:");
    expect(dry.stdout).toMatch(/tripact-sync-id:\s*[0-9a-f]+/);
    // Nothing was written: the sidecar the dry run advertised does not exist on disk.
    expect(existsSync(path.join(repo, ".tripact", "claims.json")), "dry run wrote no sidecar").toBe(false);
  });
});

describe("tripact accept (§8.3)", () => {
  // @specs:tripact-accept.accept-refuses-run-exit
  it("refuses (exit 1) while a reanchor escalation is open, but fork-review questions never block", () => {
    // Reanchor: a ~0.73 reword against the baseline is an open reanchor question — accept refuses.
    const blocked = coveredBaseline("tripact-accept-blocked-");
    writeFileSync(path.join(blocked, "SPECS.md"), specs("- [ ] addNumbers computes the total of two integer values"));
    const refused = runCli(["accept", "--yes"], { cwd: blocked });
    expect(refused.status, "reanchor blocks accept").toBe(1);
    expect(refused.stderr).toContain("cannot accept");
    expect(refused.stderr).toContain("[reanchor]"); // the open escalation is listed by kind

    // Fork-review: a sub-0.65 reword forks identity. That question is advisory — accept proceeds
    // (exit 0) and names the fork in the acceptance summary rather than blocking on it.
    const forked = newRepo(
      {
        "tripact.yaml": CONFIG,
        "SPECS.md": [
          "# Product Specification",
          "",
          "## 1. Calculator",
          "",
          "### 1.1 Addition",
          "",
          "- [ ] addNumbers returns the sum of two integer inputs",
          "- [ ] Entering two numbers and clicking Add shows the sum on screen",
          "",
        ].join("\n"),
        "tests/e2e/calc.spec.ts": 'test("x", () => {});\n',
      },
      "tripact-accept-fork-",
    );
    runCli(["accept", "--yes"], { cwd: forked }); // baseline both atoms
    writeFileSync(
      path.join(forked, "SPECS.md"),
      [
        "# Product Specification",
        "",
        "## 1. Calculator",
        "",
        "### 1.1 Addition",
        "",
        "- [ ] operators can export the full audit log as a signed csv file",
        "- [ ] Entering two numbers and clicking Add shows the sum on screen",
        "",
      ].join("\n"),
    );
    const forkAccept = runCli(["accept", "--yes"], { cwd: forked });
    expect(forkAccept.status, "fork-review never blocks accept").toBe(0);
    expect(forkAccept.stdout).toContain("open fork-review question(s) (advisory, non-blocking)");
    expect(forkAccept.stdout).toContain("[fork-review]");
  });

  // @specs:tripact-accept.accept-prints-acceptance-summary
  it("prints an acceptance summary before writing: created / re-anchored / retired / verified / backlog", () => {
    // A fork transition retires one claim and creates another, moving the backlog both ways — a
    // summary that exercises every category the claim enumerates.
    const repo = newRepo(
      {
        "tripact.yaml": CONFIG,
        "SPECS.md": [
          "# Product Specification",
          "",
          "## 1. Calculator",
          "",
          "### 1.1 Addition",
          "",
          "- [ ] addNumbers returns the sum of two integer inputs",
          "- [ ] Entering two numbers and clicking Add shows the sum on screen",
          "",
        ].join("\n"),
        "tests/e2e/calc.spec.ts": 'test("x", () => {});\n',
      },
      "tripact-accept-summary-",
    );
    runCli(["accept", "--yes"], { cwd: repo });
    writeFileSync(
      path.join(repo, "SPECS.md"),
      [
        "# Product Specification",
        "",
        "## 1. Calculator",
        "",
        "### 1.1 Addition",
        "",
        "- [ ] operators can export the full audit log as a signed csv file",
        "- [ ] Entering two numbers and clicking Add shows the sum on screen",
        "",
      ].join("\n"),
    );
    const acc = runCli(["accept", "--yes"], { cwd: repo });
    expect(acc.status, acc.stderr).toBe(0);
    // Every summary category is present, printed before the sidecar-written line.
    const summary = acc.stdout.slice(0, acc.stdout.indexOf("sidecar written"));
    expect(summary).toContain("claims created:");
    expect(summary).toContain("claims re-anchored:");
    expect(summary).toContain("claims retired:");
    expect(summary).toContain("verified states:");
    expect(summary).toContain("backlog:");
    // and the values reflect the fork: a claim created, one retired, backlog acknowledged + covered.
    expect(summary).toContain("addition.operators-can-export-full"); // created
    expect(summary).toContain("addition.addnumbers-returns-sum-two"); // retired
    expect(summary).toMatch(/backlog: 1 newly acknowledged, 1 covered since/);
  });

  // @specs:tripact-accept.claims-would-re-baselined-after
  it("lists reworded re-baselines in their own summary section with old/new excerpts, even under --yes", () => {
    const repo = coveredBaseline("tripact-accept-reword-");
    writeFileSync(path.join(repo, "SPECS.md"), specs(ATOM_REWORD)); // ≥0.9 reword: id kept, text moves
    const acc = runCli(["accept", "--yes"], { cwd: repo });
    expect(acc.status, acc.stderr).toBe(0);
    const summary = acc.stdout.slice(0, acc.stdout.indexOf("sidecar written"));
    // --yes still prints the reword section before writing.
    expect(summary).toContain("re-baselined after reword:");
    expect(summary).toContain('old: "addnumbers returns the sum of two integer inputs"');
    expect(summary).toContain('new: "addnumbers returns the sum of two integer values"');
  });
});

describe("Acceptance preview: tripact diff (§8.4)", () => {
  // @specs:acceptance-preview.tripact-diff-shows-what
  it("shows created/re-anchored/retired, per-edge verified states, backlog, and both trailers — writing nothing", () => {
    const repo = coveredBaseline("tripact-diff-shows-");
    writeFileSync(path.join(repo, "SPECS.md"), specs(ATOM_REWORD)); // reword → re-anchor + verified re-baseline
    const sidecarPath = path.join(repo, ".tripact", "claims.json");
    const before = readFileSync(sidecarPath, "utf8");

    const diff = runCli(["diff"], { cwd: repo });
    expect(diff.status, diff.stderr).toBe(0);
    const out = diff.stdout;
    expect(out).toContain("claims created:");
    expect(out).toContain("claims re-anchored:");
    expect(out).toContain("claims retired:");
    expect(out).toContain("verified states:");
    expect(out).toContain("specs ↔ tests"); // per-edge verified-state line
    expect(out).toContain("backlog:");
    expect(out).toContain("current trailer:");
    expect(out).toContain("would-be trailer:");
    // Preview only: the committed sidecar is byte-identical after diff.
    expect(readFileSync(sidecarPath, "utf8"), "diff wrote nothing").toBe(before);
  });

  // @specs:acceptance-preview.re-baselined-verified-state-distinguishes
  it("distinguishes a reword re-baseline (old/new excerpts) from a test-side-only re-verify", () => {
    // Reword: the claim text itself moved → surfaced as a rewordRebaseline with old + new text.
    const reword = coveredBaseline("tripact-diff-reword-");
    writeFileSync(path.join(reword, "SPECS.md"), specs(ATOM_REWORD));
    const rw = JSON.parse(runCli(["diff", "--json"], { cwd: reword }).stdout);
    expect(rw.rewordRebaselines).toHaveLength(1);
    expect(rw.rewordRebaselines[0].subject).toBe("addition.addnumbers-returns-sum-two");
    expect(rw.rewordRebaselines[0].oldText).toBe("addnumbers returns the sum of two integer inputs");
    expect(rw.rewordRebaselines[0].newText).toBe("addnumbers returns the sum of two integer values");
    const rwEdge = rw.verified.find((e: { reBaselined: string[] }) => e.reBaselined.length > 0);
    expect(rwEdge.reBaselined).toContain("addition.addnumbers-returns-sum-two");

    // Test-side-only: only the tagged file's bytes changed, the claim text is untouched → a plain
    // re-baseline with NO reword entry. This is the distinction the claim draws.
    const tside = coveredBaseline("tripact-diff-testside-");
    writeFileSync(
      path.join(tside, "tests", "e2e", "calc.spec.ts"),
      `// ${specTag("addition.addnumbers-returns-sum-two")}\ntest("sums", () => { expect(1 + 1).toBe(2); });\n`,
    );
    const ts = JSON.parse(runCli(["diff", "--json"], { cwd: tside }).stdout);
    const tsEdge = ts.verified.find((e: { reBaselined: string[] }) => e.reBaselined.length > 0);
    expect(tsEdge.reBaselined, "the verified state re-baselines").toContain("addition.addnumbers-returns-sum-two");
    expect(ts.rewordRebaselines, "no reword — the claim text did not move").toHaveLength(0);
    expect(ts.reAnchored, "text unchanged → not re-anchored").toHaveLength(0);
  });

  // @specs:acceptance-preview.diff---json-emits-same
  it("diff --json emits the same document machine-readably with a schemaVersion field", () => {
    const repo = coveredBaseline("tripact-diff-json-");
    writeFileSync(path.join(repo, "SPECS.md"), specs(ATOM_REWORD));
    const res = runCli(["diff", "--json"], { cwd: repo });
    expect(res.status, res.stderr).toBe(0);
    const doc = JSON.parse(res.stdout);
    expect(doc.schemaVersion).toBe(1);
    // The same shape the human render walks: creation/anchoring/retirement, per-edge verified
    // deltas, backlog, and the current + would-be trailers.
    expect(doc).toHaveProperty("created");
    expect(doc).toHaveProperty("reAnchored");
    expect(doc).toHaveProperty("retired");
    expect(doc).toHaveProperty("verified");
    expect(doc).toHaveProperty("rewordRebaselines");
    expect(doc).toHaveProperty("backlog.newlyAcknowledged");
    expect(doc).toHaveProperty("backlog.coveredSince");
    expect(typeof doc.currentTrailer).toBe("string");
    expect(typeof doc.wouldBeTrailer).toBe("string");
    expect(doc.currentTrailer).not.toBe(doc.wouldBeTrailer); // acceptance would change the trailer
    expect(doc.reAnchored).toContain("addition.addnumbers-returns-sum-two");
  });
});

// The confirmation gate is a runtime `process.stdin.isTTY && process.stdout.isTTY` check, so a
// plain spawn (pipes on both ends) can only ever exercise the scripted half. To reach the
// interactive half we spawn a tiny driver that loads the same program module the CLI entry point
// loads, marks both streams as a terminal, and feeds the answer on stdin. Nothing about the
// behaviour under test is stubbed — only the terminal-ness of the streams.
const DRIVER = (programUrl: string): string =>
  [
    `import { buildProgram } from ${JSON.stringify(programUrl)};`,
    'Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });',
    'Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });',
    "process.stdin.setRawMode = () => process.stdin;",
    'await buildProgram().parseAsync(["node", "tripact", ...process.argv.slice(2)]);',
    "",
  ].join("\n");

/** Run `tripact <args>` in `cwd` with both streams pretending to be a terminal, answering `input`. */
function runCliOnTty(args: string[], opts: { cwd: string; input: string }) {
  const { command, baseArgs } = cliInvocation();
  const entry = baseArgs[0]; // …/dist/cli.js or …/src/cli.ts — the program module sits beside it.
  const programPath = path.join(path.dirname(entry), path.basename(entry).replace(/^cli\./, "program."));
  const dir = mkdtempSync(path.join(os.tmpdir(), "tripact-tty-driver-"));
  scratch.push(dir);
  const driver = path.join(dir, "driver.mjs");
  writeFileSync(driver, DRIVER(pathToFileURL(programPath).href));
  const r = spawnSync(command, [driver, ...args], { cwd: opts.cwd, encoding: "utf8", input: opts.input });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

describe("accept confirmation (§8.3)", () => {
  // @specs:tripact-accept.interactive-terminal-accept-asks
  it("asks on a terminal and aborts on anything but yes; --yes skips the prompt; a non-terminal proceeds as scripted", () => {
    const files = {
      "tripact.yaml": CONFIG,
      "SPECS.md": specs(ATOM),
      "tests/e2e/calc.spec.ts": `// ${specTag("addition.addnumbers-returns-sum-two")}\ntest("sums", () => {});\n`,
    };
    const sidecarOf = (repo: string) => path.join(repo, ".tripact", "claims.json");

    // On a terminal, "y" is asked for and accepted: the sidecar is written and the trailer printed.
    const yes = newRepo(files, "tripact-tty-y-");
    const rYes = runCliOnTty(["accept"], { cwd: yes, input: "y\n" });
    expect(rYes.status, rYes.stderr).toBe(0);
    expect(rYes.stdout, "the terminal run prompts").toContain("Proceed?");
    expect(rYes.stdout).toContain("sidecar written: .tripact/claims.json");
    expect(existsSync(sidecarOf(yes)), "confirmed accept writes the sidecar").toBe(true);

    // "yes" is the other accepted answer.
    const spelled = newRepo(files, "tripact-tty-yes-");
    const rSpelled = runCliOnTty(["accept"], { cwd: spelled, input: "yes\n" });
    expect(rSpelled.status, rSpelled.stderr).toBe(0);
    expect(rSpelled.stdout).toContain("Proceed?");
    expect(existsSync(sidecarOf(spelled)), '"yes" also confirms').toBe(true);

    // Anything but yes aborts — "n", and any other answer, including an empty one.
    for (const [answer, prefix] of [
      ["n\n", "tripact-tty-n-"],
      ["maybe\n", "tripact-tty-maybe-"],
      ["\n", "tripact-tty-empty-"],
    ]) {
      const repo = newRepo(files, prefix);
      const r = runCliOnTty(["accept"], { cwd: repo, input: answer });
      expect(r.stdout, `answer ${JSON.stringify(answer)} prompts`).toContain("Proceed?");
      expect(r.stdout, `answer ${JSON.stringify(answer)} aborts`).toContain(
        "aborted — nothing written, escalations untouched",
      );
      expect(existsSync(sidecarOf(repo)), `answer ${JSON.stringify(answer)} wrote nothing`).toBe(false);
    }

    // --yes skips the prompt: no question is asked even on a terminal, and the sidecar is written.
    const skipped = newRepo(files, "tripact-tty-flag-");
    const rSkip = runCliOnTty(["accept", "--yes"], { cwd: skipped, input: "" });
    expect(rSkip.status, rSkip.stderr).toBe(0);
    expect(rSkip.stdout, "--yes asks nothing").not.toContain("Proceed?");
    expect(rSkip.stdout).toContain("sidecar written: .tripact/claims.json");
    expect(existsSync(sidecarOf(skipped)), "--yes writes the sidecar").toBe(true);

    // Without a terminal (plain spawn — pipes both ends) accept proceeds as scripted: no prompt,
    // no --yes needed, sidecar written.
    const scripted = newRepo(files, "tripact-notty-");
    const rScripted = runCli(["accept"], { cwd: scripted });
    expect(rScripted.status, rScripted.stderr).toBe(0);
    expect(rScripted.stdout, "a non-terminal is never prompted").not.toContain("Proceed?");
    expect(rScripted.stdout).toContain("sidecar written: .tripact/claims.json");
    expect(existsSync(sidecarOf(scripted)), "the scripted run writes the sidecar").toBe(true);
  });
});
