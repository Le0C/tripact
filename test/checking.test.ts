// `tripact check` core behaviour (§5.1), Output (§5.2), and Scoping (§5.3), driven the way a
// foreign harness would: a scratch git repo with a hand-written tripact.yaml, then the prebuilt
// kernel CLI over `check` — observing exit codes, the human report, and the --json document.
//
// All fixtures are built in temp dirs and cleaned up in afterAll. Assertions target only
// deterministic surfaces (scope, counts, labels, layer names) — never nondeterministic ones such
// as a sync-point commit sha.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { git, runCli } from "./helpers/cli.js";
import { CONFIG, fullRepo, MANUAL, SPECS, TESTS } from "./helpers/fixture.js";

const scratch: string[] = [];
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});

function track(repo: string): string {
  scratch.push(repo);
  return repo;
}

/** Parse the `tripact-sync-id:` trailer value out of an accept's stdout. */
function trailerOf(acceptStdout: string): string {
  const sid = acceptStdout.match(/tripact-sync-id:\s*(\S+)/)?.[1];
  expect(sid, "accept printed a sync-id trailer").toBeTruthy();
  return sid!;
}

// A repo carrying all three layers plus a pathMap routing code under src/** to the specs layer —
// the fixture the §5.3 scoping claims need. Unlike fixture.fullRepo it is committed but NOT
// checked/accepted, so each scoping test controls the sync-point state itself.
const SCOPED_CONFIG = `${CONFIG}pathMap:\n  'src/**': [specs]\n`;

function scopedRepo(prefix: string): string {
  const repo = track(mkdtempSync(path.join(os.tmpdir(), prefix)));
  git(repo, ["init", "-b", "main"]);
  writeFileSync(path.join(repo, "SPECS.md"), SPECS);
  writeFileSync(path.join(repo, "tripact.yaml"), SCOPED_CONFIG);
  mkdirSync(path.join(repo, "docs", "manual"), { recursive: true });
  writeFileSync(path.join(repo, "docs", "manual", "using.md"), MANUAL);
  mkdirSync(path.join(repo, "tests", "e2e"), { recursive: true });
  writeFileSync(path.join(repo, "tests", "e2e", "calc.spec.ts"), TESTS);
  mkdirSync(path.join(repo, "src"), { recursive: true });
  writeFileSync(path.join(repo, "src", "app.ts"), "export const x = 1;\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-m", "init"]);
  return repo;
}

/** accept a baseline, then commit it with the printed sync-id trailer so findSyncPoint sees it. */
function acceptAndCommitSyncPoint(repo: string): void {
  const accept = runCli(["accept", "--yes"], { cwd: repo });
  expect(accept.status, `accept\n${accept.stderr}`).toBe(0);
  const sid = trailerOf(accept.stdout);
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-m", `accept baseline\n\ntripact-sync-id: ${sid}`]);
}

describe("check core behaviour (§5.1)", () => {
  // @specs:tripact-check-core.check-parses-all-declared
  it("parses all layers and evaluates all edges, mutating no artefact or sidecar — only the escalation queue it writes", () => {
    const repo = track(fullRepo("tripact-check-nomutate-"));
    // Establish a sidecar so there is something check could (but must not) mutate.
    expect(runCli(["accept", "--yes"], { cwd: repo }).status).toBe(0);
    const sidecar = path.join(repo, ".tripact", "claims.json");
    const specs = path.join(repo, "SPECS.md");
    const beforeSidecar = readFileSync(sidecar, "utf8");
    const beforeSpecs = readFileSync(specs, "utf8");

    const check = runCli(["check", "--json"], { cwd: repo });
    const report = JSON.parse(check.stdout);
    // All declared layers were parsed and every declared edge evaluated: verdicts span both edges.
    const edges = new Set(report.verdicts.map((v: { edge: [string, string] }) => v.edge.join("->")));
    expect(edges.has("specs->tests"), "specs↔tests edge evaluated").toBe(true);
    expect(edges.has("docs->tests"), "docs↔tests edge evaluated").toBe(true);

    // check mutates neither the prescriptive artefact nor the sidecar…
    expect(readFileSync(sidecar, "utf8"), "sidecar unchanged by check").toBe(beforeSidecar);
    expect(readFileSync(specs, "utf8"), "spec artefact unchanged by check").toBe(beforeSpecs);
    // …apart from the escalation queue, which it writes.
    expect(existsSync(path.join(repo, ".tripact", "escalations.json")), "escalation queue written").toBe(true);
  });

  // @specs:tripact-check-core.uncovered-claim-section-not
  it("treats a claim not acknowledged at the last accept as new-uncovered drift, exit 1", () => {
    // fullRepo commits untagged tests and never accepts, so every claim is new-uncovered.
    const repo = track(fullRepo("tripact-check-newuncovered-"));
    const check = runCli(["check", "--json"], { cwd: repo });
    expect(check.status, `check on never-accepted repo\n${check.stderr}`).toBe(1);
    const report = JSON.parse(check.stdout);
    expect(report.exitCode).toBe(1);
    expect(report.counts["new-uncovered"], "new-uncovered count").toBe(3);
    expect(report.counts["acknowledged"], "nothing acknowledged yet").toBe(0);
    // The human report labels them NEW-UNCOVERED, not BACKLOG.
    expect(runCli(["check"], { cwd: repo }).stdout).toContain("NEW-UNCOVERED");
  });

  // @specs:tripact-check-core.check---strict-treats-acknowledged
  it("gates acknowledged backlog only under --strict (plain check is level, --strict is drift)", () => {
    const repo = track(fullRepo("tripact-check-strict-"));
    expect(runCli(["accept", "--yes"], { cwd: repo }).status, "accept baselines the backlog").toBe(0);
    // Acknowledged backlog is not drift for a plain check…
    expect(runCli(["check"], { cwd: repo }).status, "plain check after accept").toBe(0);
    // …but --strict restores coverage-gating and treats it as drift.
    expect(runCli(["check", "--strict"], { cwd: repo }).status, "check --strict").toBe(1);
  });

  // @specs:tripact-check-core.level-report-ends-level
  it("ends a level report with ✓ level, naming the non-zero acknowledged backlog count", () => {
    const repo = track(fullRepo("tripact-check-level-"));
    expect(runCli(["accept", "--yes"], { cwd: repo }).status).toBe(0);
    const out = runCli(["check"], { cwd: repo }).stdout;
    const last = out.trimEnd().split("\n").pop() ?? "";
    expect(last.startsWith("✓ level"), `last line was: ${last}`).toBe(true);
    // 3 acknowledged claims (2 specs + 1 docs) — the backlog count is named.
    expect(last).toContain("3 acknowledged backlog items");
  });

  // @specs:tripact-check-core.check-makes-no-network
  it("makes no network call and invokes no LLM, even under a config binding routing, models, derived and codeLinks", () => {
    // A CJS preload that traps every egress primitive the kernel could reach for — sockets, DNS,
    // http/https and fetch. Each records to a log file and throws, so a call is observable both as a
    // log line and as a crashed run. Loaded via NODE_OPTIONS so it patches the CLI child, not vitest.
    const trapDir = track(mkdtempSync(path.join(os.tmpdir(), "tripact-nonet-trap-")));
    const trap = path.join(trapDir, "trap.cjs");
    const netLog = path.join(trapDir, "net.log");
    writeFileSync(
      trap,
      [
        'const fs = require("node:fs");',
        'const log = process.env.TRIPACT_NET_LOG;',
        'function note(what) { fs.appendFileSync(log, what + "\\n"); throw new Error("network blocked: " + what); }',
        'const net = require("node:net");',
        'net.Socket.prototype.connect = function () { note("net.Socket.connect"); };',
        'net.connect = () => note("net.connect");',
        'net.createConnection = () => note("net.createConnection");',
        'const dns = require("node:dns");',
        'dns.lookup = () => note("dns.lookup");',
        'dns.promises.lookup = () => note("dns.promises.lookup");',
        'const http = require("node:http");',
        'http.request = () => note("http.request");',
        'http.get = () => note("http.get");',
        'const https = require("node:https");',
        'https.request = () => note("https.request");',
        'https.get = () => note("https.get");',
        'globalThis.fetch = () => note("fetch");',
        "",
      ].join("\n"),
    );
    writeFileSync(netLog, "");

    // "any configuration": every optional block that names an effort tier, a model, a generator
    // command or a code file set — the ones a reader might expect to pull the kernel online.
    const repo = track(fullRepo("tripact-check-nonet-"));
    mkdirSync(path.join(repo, "src"), { recursive: true });
    writeFileSync(path.join(repo, "src", "app.ts"), "export const x = 1;\n");
    writeFileSync(
      path.join(repo, "tripact.yaml"),
      `${CONFIG}accept:\n  policy: agents\nrouting:\n  write-tests: implementation\nmodels:\n  implementation: some-model\nderived:\n  traceability:\n    output: docs/traceability.md\n    generator: 'node scripts/gen.js'\ncodeLinks:\n  paths:\n    - 'src/**/*.ts'\n`,
    );

    const env = { ...process.env, TRIPACT_NET_LOG: netLog, NODE_OPTIONS: `--require ${trap}` };
    for (const args of [["check", "--json"], ["check"], ["check", "--all"], ["check", "--strict"]]) {
      const r = runCli(args, { cwd: repo, env });
      // 1 = drift (this fixture's tests are untagged); 2 would mean a config/environment error,
      // which is what a thrown "network blocked" would surface as.
      expect(r.status, `tripact ${args.join(" ")}\n${r.stderr}`).toBe(1);
      expect(r.stderr, "no trapped-egress crash").not.toContain("network blocked");
    }
    // The run completed all four ways and the trap recorded nothing: no socket, DNS, http/https or
    // fetch egress — and so no LLM invocation, which could only travel over one of them.
    expect(readFileSync(netLog, "utf8"), "trapped network egress").toBe("");
  });
});

describe("check output (§5.2)", () => {
  // @specs:output.default-output-human-readable-report
  it("defaults to a human report grouping non-covered verdicts under their group heading path per edge", () => {
    const repo = track(fullRepo("tripact-out-human-"));
    const out = runCli(["check"], { cwd: repo }).stdout;
    // Human, not JSON.
    expect(out).toContain("tripact check —");
    expect(() => JSON.parse(out)).toThrow();
    // Both edges head their own section.
    expect(out).toContain("edge specs ↔ tests:");
    expect(out).toContain("edge docs ↔ tests:");
    // The group heading path is printed above the verdict lines it groups.
    const headingIdx = out.indexOf("1. Calculator > 1.1 Addition");
    const verdictIdx = out.indexOf("addition.addnumbers-returns-sum-two");
    expect(headingIdx, "group heading path present").toBeGreaterThanOrEqual(0);
    expect(verdictIdx).toBeGreaterThan(headingIdx);
  });

  // @specs:output.each-reported-verdict-line
  it("carries the claim id, a text excerpt, and the declaring file:line on each uncovered verdict line", () => {
    const repo = track(fullRepo("tripact-out-line-"));
    const out = runCli(["check"], { cwd: repo }).stdout;
    // id · excerpt · location (the claim's own declaring file:line, since uncovered verdicts are untagged).
    expect(out).toMatch(
      /addition\.addnumbers-returns-sum-two — "addNumbers returns the sum of two integer inputs" \(SPECS\.md:7\)/,
    );
  });

  // @specs:output.report-counts-include-forks
  it("includes a forks metric in both the human report and check --json", () => {
    const repo = track(fullRepo("tripact-out-forks-"));
    expect(runCli(["accept", "--yes"], { cwd: repo }).status).toBe(0);
    // Rewrite the first spec claim wholesale: the old atom dies and a new one is created in the same
    // section — a fork (§3.3). Its sibling claim is left intact so the section still exists.
    writeFileSync(
      path.join(repo, "SPECS.md"),
      [
        "# Product Specification — Example",
        "",
        "## 1. Calculator",
        "",
        "### 1.1 Addition",
        "",
        "- [ ] the quotient of dividing two decimals is rounded to four places",
        "- [ ] Entering two numbers and clicking Add shows the sum on screen",
        "",
      ].join("\n"),
    );
    const report = JSON.parse(runCli(["check", "--json"], { cwd: repo }).stdout);
    expect(report.counts.forks, "forks metric in --json counts").toBe(1);
    // The human report carries the same metric as a line.
    expect(runCli(["check"], { cwd: repo }).stdout).toContain("forks: 1 group(s)");
  });

  // @specs:output.check---long-prints-every
  it("truncates listings past a fixed threshold by default, and prints every item under --long", () => {
    const repo = track(mkdtempSync(path.join(os.tmpdir(), "tripact-out-long-")));
    git(repo, ["init", "-b", "main"]);
    writeFileSync(
      path.join(repo, "tripact.yaml"),
      [
        "schemaVersion: 1",
        "layers:",
        "  specs:",
        "    role: prescriptive",
        "    paths:",
        "      - SPECS.md",
        "  tests:",
        "    role: verificatory",
        "    paths:",
        "      - tests/**/*.spec.ts",
        "edges:",
        "  - [specs, tests]",
        "",
      ].join("\n"),
    );
    const claims = ["# Spec", "", "## 1. Section", ""];
    for (let i = 1; i <= 15; i++) claims.push(`- [ ] claim number ${i} does a distinct thing worth testing here`);
    writeFileSync(path.join(repo, "SPECS.md"), `${claims.join("\n")}\n`);
    mkdirSync(path.join(repo, "tests", "e2e"), { recursive: true });
    writeFileSync(path.join(repo, "tests", "e2e", "x.spec.ts"), 'test("noop", () => {});\n');
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-m", "init"]);

    const def = runCli(["check"], { cwd: repo }).stdout;
    const long = runCli(["check", "--long"], { cwd: repo }).stdout;
    const count = (s: string) => (s.match(/NEW-UNCOVERED/g) ?? []).length;
    // Default truncates to the fixed threshold (12) and names --long in the closing line.
    expect(count(def), "default truncates to threshold").toBe(12);
    expect(def).toContain("— run with --long to see all");
    // --long prints every one of the 15 items and adds no truncation line.
    expect(count(long), "--long prints every item").toBe(15);
    expect(long).not.toContain("— run with --long to see all");
  });
});

describe("check scoping (§5.3)", () => {
  // @specs:scoping.without-any-sync-point-check
  it("audits everything and says so in the header when there is no sync-point", () => {
    const repo = scopedRepo("tripact-scope-nosync-");
    const report = JSON.parse(runCli(["check", "--json"], { cwd: repo }).stdout);
    expect(report.scope).toBe("full");
    expect(report.syncPoint).toBeNull();
    // The human header announces the full audit.
    expect(runCli(["check"], { cwd: repo }).stdout).toContain("no sync-point found — full audit");
  });

  // @specs:scoping.sync-point-present-81-check
  it("scopes to the diff and narrows affected layers via pathMap globs when a sync-point is present", () => {
    const repo = scopedRepo("tripact-scope-diff-");
    acceptAndCommitSyncPoint(repo);
    // A code change under src/** routes to the specs layer via the pathMap glob.
    writeFileSync(path.join(repo, "src", "app.ts"), "export const x = 2;\n");
    git(repo, ["add", "src/app.ts"]);
    git(repo, ["commit", "-m", "change code"]);

    const report = JSON.parse(runCli(["check", "--json"], { cwd: repo }).stdout);
    expect(report.scope).toBe("diff");
    expect(report.syncPoint, "sync-point resolved").not.toBeNull();
    expect(report.changedPaths, "code diff since the sync-point").toContain("src/app.ts");
    expect(report.affectedLayers, "pathMap narrows candidates to specs").toEqual(["specs"]);
    // The human report names the affected layer and its pathMap routing.
    expect(runCli(["check"], { cwd: repo }).stdout).toContain(
      "changed code maps to layers via pathMap: specs",
    );
  });

  // @specs:scoping.check---all-forces-full
  it("forces a full audit with --all regardless of the sync-point", () => {
    const repo = scopedRepo("tripact-scope-all-");
    acceptAndCommitSyncPoint(repo);
    writeFileSync(path.join(repo, "src", "app.ts"), "export const x = 2;\n");
    git(repo, ["add", "src/app.ts"]);
    git(repo, ["commit", "-m", "change code"]);

    // Without --all the very same repo scopes to the diff…
    const diff = JSON.parse(runCli(["check", "--json"], { cwd: repo }).stdout);
    expect(diff.scope).toBe("diff");
    // …and --all forces full, clearing the diff path set even though the sync-point still resolves.
    const all = JSON.parse(runCli(["check", "--all", "--json"], { cwd: repo }).stdout);
    expect(all.scope).toBe("full");
    expect(all.changedPaths).toEqual([]);
  });
});
