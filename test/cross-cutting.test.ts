// The Cross-Cutting Concerns the whole kernel owes, checked at the CLI boundary: determinism
// (identical tree → byte-identical output, no clock/locale/host bleed), machine readability (every
// reporting command offers a versioned `--json`; one 0/1/2 exit convention), human output (counts
// before details, a fixed truncation threshold naming `--long`, the `--json` vocabulary and nothing
// else, and a human flag that never touches a machine document), and footprint (Node 22+, no native
// dependencies, a three-file `.tripact/`).
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { git, runCli } from "./helpers/cli.js";
import { CONFIG, MANUAL, SPECS, fullRepo } from "./helpers/fixture.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const scratch: string[] = [];
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});

function track(repo: string): string {
  scratch.push(repo);
  return repo;
}

/** Every CLI surface that emits a machine report (contract.ts: PUBLIC_CONTRACT's `cli` entries). */
const REPORT_COMMANDS = ["check", "status", "claims", "tasks", "reconcile", "hotlinks"] as const;

// The tag markers a fixture test file carries. Assembled by concatenation so this file's own text
// never matches tripact's tag pattern. A fixture's tag names a fixture claim, and a literal here
// would surface as an orphan tag in tripact's own report.
const SPEC_TAG = `@${"specs"}:addition.addnumbers-returns-sum-two`;
const SECTION_TAG = `@${"docs"}:adding-numbers`;

/** The fixture's tests, tagged, so a later reword leaves an orphan tag behind. */
const TAGGED_TESTS = [
  `// ${SPEC_TAG}`,
  'test("addNumbers sums two integers", () => {});',
  `// ${SECTION_TAG}`,
  'test("Add button shows the sum", () => {});',
  "",
].join("\n");

/**
 * A baselined repo whose one tagged spec claim was then reworded and committed. `check` therefore
 * finds a sync-point and reports the full spread this section needs: a new-uncovered claim, an
 * acknowledged backlog item, an orphan tag, and a re-anchoring escalation (the only route to a
 * `.tripact/journal.jsonl`).
 */
function driftedRepo(prefix: string): string {
  const repo = track(mkdtempSync(path.join(os.tmpdir(), prefix)));
  git(repo, ["init", "-b", "main"]);
  writeFileSync(path.join(repo, "tripact.yaml"), CONFIG);
  writeFileSync(path.join(repo, "SPECS.md"), SPECS);
  mkdirSync(path.join(repo, "docs", "manual"), { recursive: true });
  writeFileSync(path.join(repo, "docs", "manual", "using.md"), MANUAL);
  mkdirSync(path.join(repo, "tests", "e2e"), { recursive: true });
  writeFileSync(path.join(repo, "tests", "e2e", "calc.spec.ts"), TAGGED_TESTS);
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-qm", "init"]);

  const accept = runCli(["accept", "--yes"], { cwd: repo });
  expect(accept.status, `accept\n${accept.stderr}`).toBe(0);
  const trailer = accept.stdout.match(/tripact-sync-id:\s*(\S+)/)?.[1];
  expect(trailer, "accept prints the sync-point trailer").toBeTruthy();
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-qm", `baseline\n\ntripact-sync-id: ${trailer}`]);

  writeFileSync(
    path.join(repo, "SPECS.md"),
    SPECS.replace(
      "addNumbers returns the sum of two integer inputs",
      "addNumbers returns the arithmetic total of its two integer arguments",
    ),
  );
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-qm", "reword the addition claim"]);
  return repo;
}

/** Adjudicate the drifted repo's single escalation by re-anchoring the old id onto the new text. */
function resolveTheEscalation(repo: string): void {
  const report = JSON.parse(runCli(["check", "--json"], { cwd: repo }).stdout);
  const question = report.escalations[0];
  expect(question, "the reworded spec raises an escalation").toBeTruthy();
  const answer = `${question.deleted[0].id}="${question.created[0].text}"`;
  const resolved = runCli(["resolve", question.id, "--match", answer], { cwd: repo });
  expect(resolved.status, `resolve\n${resolved.stderr}`).toBe(0);
}

/**
 * A repo whose prescriptive layer carries more claims than the fixed listing threshold (12), so the
 * human report has to truncate. Nothing is tagged, so every claim is new-uncovered.
 */
function manyClaimsRepo(prefix: string): string {
  const repo = track(mkdtempSync(path.join(os.tmpdir(), prefix)));
  git(repo, ["init", "-b", "main"]);
  writeFileSync(path.join(repo, "tripact.yaml"), CONFIG);
  const claims = Array.from({ length: 20 }, (_, i) => `- [ ] claim number ${i + 1} does a thing`);
  writeFileSync(
    path.join(repo, "SPECS.md"),
    ["# Spec", "", "## 1. Big", "", "### 1.1 Many", "", ...claims, ""].join("\n"),
  );
  mkdirSync(path.join(repo, "docs", "manual"), { recursive: true });
  writeFileSync(path.join(repo, "docs", "manual", "using.md"), MANUAL);
  mkdirSync(path.join(repo, "tests", "e2e"), { recursive: true });
  writeFileSync(path.join(repo, "tests", "e2e", "calc.spec.ts"), 'test("a", () => {});\n');
  return repo;
}

describe("cross-cutting: determinism", () => {
  // A machine's timezone, locale and language are the usual sources of cross-machine divergence;
  // the kernel must ignore all of them. `env` replaces the child environment wholesale, so the
  // parent's is spread in to keep PATH and friends.
  const envA = { ...process.env, TZ: "UTC", LANG: "C", LC_ALL: "C" };
  const envB = { ...process.env, TZ: "Pacific/Kiritimati", LANG: "de_DE.UTF-8", LC_ALL: "de_DE.UTF-8" };

  // One repo for the whole block, built and settled once: `check` is documented to (re)write
  // .tripact/escalations.json (§5.1, §7.1), so the very first invocation adds a path to the working
  // tree and the run after it would see a different changed-paths count. The claim is that identical
  // STATE yields identical output, so settle the state first rather than measuring the queue-write
  // side effect.
  let repo: string;
  beforeAll(() => {
    repo = driftedRepo("tripact-xcut-determ-");
    runCli(["check"], { cwd: repo, env: envA });
  });

  // One case per command, rather than one test looping over all of them. Each runCli is a blocking
  // spawnSync; a single test spanning every command blocks its worker for tens of seconds, which
  // trips both the 30s test timeout and the fork pool's reporter-IPC timeout (see vitest.config.ts).
  // Per-command tests keep each blocking budget to three spawns and let the worker breathe between.
  const invocations = [
    ["check"],
    ["check", "--json"],
    ["status"],
    ["status", "--json"],
    ["claims"],
    ["claims", "--json"],
    ["tasks"],
    ["tasks", "--json"],
    ["reconcile"],
    ["reconcile", "--json"],
    ["hotlinks"],
    ["hotlinks", "--json"],
    ["diff"],
  ];
  for (const args of invocations) {
    const label = args.join(" ");
    // @specs:determinism.identical-repository-state-config
    it(`\`${label}\` is byte-identical across runs and across TZ/locale`, () => {
      const a = runCli(args, { cwd: repo, env: envA });
      const again = runCli(args, { cwd: repo, env: envA });
      const b = runCli(args, { cwd: repo, env: envB });
      expect(again.stdout, `${label} differs between two identical runs`).toBe(a.stdout);
      expect(b.stdout, `${label} depends on TZ/locale`).toBe(a.stdout);
      expect(b.status, `${label} exit code differs across environments`).toBe(a.status);
    });
  }

  // @specs:determinism.no-command-writes-timestamp
  it("writes no timestamp, hostname or locale-dependent formatting into a committed file — journal.jsonl alone is timestamped", () => {
    const repo = driftedRepo("tripact-xcut-stamp-");
    resolveTheEscalation(repo);
    expect(runCli(["accept", "--yes"], { cwd: repo }).status, "accept after adjudication").toBe(0);

    const dir = path.join(repo, ".tripact");
    const isoStamp = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
    const hostname = os.hostname();

    for (const file of ["claims.json", "escalations.json"]) {
      const body = readFileSync(path.join(dir, file), "utf8");
      expect(body, `${file} carries a timestamp`).not.toMatch(isoStamp);
      expect(body.includes(hostname), `${file} carries the hostname`).toBe(false);
    }
    // Claim provenance is recorded as commit ids, not wall-clock times.
    const sidecar = JSON.parse(readFileSync(path.join(dir, "claims.json"), "utf8"));
    for (const claim of sidecar.claims) {
      expect(claim.firstSeen, `${claim.id}.firstSeen is a commit id`).toMatch(/^[0-9a-f]+$/);
      expect(claim.lastSeen, `${claim.id}.lastSeen is a commit id`).toMatch(/^[0-9a-f]+$/);
    }

    // The resolution log (§7.2) is the sole timestamped artefact.
    const journal = readFileSync(path.join(dir, "journal.jsonl"), "utf8");
    const entry = JSON.parse(journal.trim().split("\n")[0]);
    expect(typeof entry.at, "journal entries carry an `at` timestamp").toBe("string");
    expect(entry.at, "the journal is timestamped").toMatch(isoStamp);
  });
});

describe("cross-cutting: no network I/O", () => {
  // @specs:determinism.no-checking-reporting-state-mutating
  it("performs no network I/O in any checking, reporting or state-mutating command", () => {
    // A CJS preload trapping every egress primitive the kernel could reach for (outbound sockets,
    // DNS, http/https, fetch), plus the server side, so an attempt to LISTEN is caught too. Each
    // records to a log and throws, making a call observable as both a log line and a crashed run.
    // Loaded via NODE_OPTIONS so it patches the CLI child rather than vitest itself.
    const trapDir = track(mkdtempSync(path.join(os.tmpdir(), "tripact-xcut-nonet-")));
    const trap = path.join(trapDir, "trap.cjs");
    const netLog = path.join(trapDir, "net.log");
    writeFileSync(
      trap,
      [
        'const fs = require("node:fs");',
        "const log = process.env.TRIPACT_NET_LOG;",
        'function note(what) { fs.appendFileSync(log, what + "\\n"); throw new Error("network blocked: " + what); }',
        'const net = require("node:net");',
        'net.Socket.prototype.connect = function () { note("net.Socket.connect"); };',
        'net.connect = () => note("net.connect");',
        'net.createConnection = () => note("net.createConnection");',
        'net.createServer = () => note("net.createServer");',
        'net.Server.prototype.listen = function () { note("net.Server.listen"); };',
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

    const repo = track(fullRepo("tripact-xcut-nonet-repo-"));
    const env = { ...process.env, TRIPACT_NET_LOG: netLog, NODE_OPTIONS: `--require ${trap}` };
    // One command per class the claim names: checking, the reporting family, and a state-mutating
    // baseline. `accept` runs last because it writes the sidecar.
    const commands = [
      ["check"],
      ["status"],
      ["claims"],
      ["tasks"],
      ["diff"],
      ["reconcile"],
      ["hotlinks"],
      ["accept", "--yes"],
    ];
    for (const args of commands) {
      const r = runCli(args, { cwd: repo, env });
      // Exit codes differ per command (0 level / 1 drift), but a thrown "network blocked" surfaces
      // as an environment error (2), so exit 2 is what the assertion looks for.
      expect(r.status, `tripact ${args.join(" ")} hit the egress trap\n${r.stderr}`).not.toBe(2);
      expect(r.stderr, `tripact ${args.join(" ")} trapped egress`).not.toContain("network blocked");
    }
    // Every command completed and the trap recorded nothing: no socket, DNS, http/https or fetch
    // egress, and so no LLM invocation, which could only travel over one of them.
    expect(readFileSync(netLog, "utf8"), "trapped network egress").toBe("");
  });
});

describe("cross-cutting: machine readability", () => {
  // @specs:machine-readability.every-command-offering-report
  it("offers --json with a versioned schema on every reporting command", () => {
    const repo = track(fullRepo("tripact-xcut-json-"));
    for (const command of REPORT_COMMANDS) {
      const r = runCli([command, "--json"], { cwd: repo });
      expect([0, 1], `${command} --json exit\n${r.stderr}`).toContain(r.status);
      const payload = JSON.parse(r.stdout);
      expect(typeof payload.schemaVersion, `${command} --json carries no schemaVersion`).toBe("number");
      expect(payload.schemaVersion, `${command} --json schemaVersion`).toBe(1);
    }
  });

  // @specs:machine-readability.exit-codes-follow-one
  it("follows one exit convention everywhere: 0 level, 1 drift, 2 usage or environment error", () => {
    // 1 = drift. Untagged tests leave every claim new-uncovered.
    const repo = track(fullRepo("tripact-xcut-exit-"));
    expect(runCli(["check"], { cwd: repo }).status, "check on drift").toBe(1);
    expect(runCli(["check", "--json"], { cwd: repo }).status, "check --json on drift").toBe(1);
    expect(runCli(["status"], { cwd: repo }).status, "status on drift").toBe(1);
    expect(runCli(["tasks"], { cwd: repo }).status, "tasks with an open queue").toBe(1);

    // 0 = level. Accepting baselines the tree: acknowledged backlog is not drift.
    expect(runCli(["accept", "--yes"], { cwd: repo }).status, "accept").toBe(0);
    expect(runCli(["check"], { cwd: repo }).status, "check after accept").toBe(0);
    expect(runCli(["status"], { cwd: repo }).status, "status after accept").toBe(0);

    // 2 = usage error. Commander parse failures route through the same convention rather than
    // Commander's own exit 1.
    expect(runCli(["frobnicate"], { cwd: repo }).status, "unknown command").toBe(2);
    expect(runCli(["check", "--nope"], { cwd: repo }).status, "unknown option").toBe(2);
    expect(runCli(["claims", "--long"], { cwd: repo }).status, "option not offered by this command").toBe(2);

    // 2 = environment error: no git history to anchor a sync-point to.
    const noGit = track(mkdtempSync(path.join(os.tmpdir(), "tripact-xcut-nogit-")));
    writeFileSync(path.join(noGit, "SPECS.md"), SPECS);
    writeFileSync(path.join(noGit, "tripact.yaml"), CONFIG);
    expect(runCli(["check"], { cwd: noGit }).status, "check outside a git repo").toBe(2);
  });
});

describe("cross-cutting: human output", () => {
  // @specs:human-output.counts-precede-details-every
  it("prints counts before details in the human report", () => {
    const repo = driftedRepo("tripact-xcut-counts-");
    const human = runCli(["check"], { cwd: repo }).stdout;
    const lines = human.split("\n");
    const lineOf = (predicate: (l: string) => boolean, what: string): number => {
      const i = lines.findIndex(predicate);
      expect(i, `no ${what} line in:\n${human}`).toBeGreaterThanOrEqual(0);
      return i;
    };

    // Each edge announces its covered/total count before listing any verdict under it.
    const edgeCount = lineOf((l) => /^edge specs ↔ tests: \d+\/\d+ covered$/.test(l), "edge count");
    const firstVerdict = lineOf((l) => /^ {4}(NEW-UNCOVERED|BACKLOG|PENDING|STALE)\s/.test(l), "verdict detail");
    expect(edgeCount, "the edge count precedes its verdict details").toBeLessThan(firstVerdict);

    // Orphan tags and escalations both lead with a parenthesised count.
    const orphanCount = lineOf((l) => /^orphan tags \(\d+\):$/.test(l), "orphan count");
    const orphanDetail = lineOf((l) => /^ {2}@\S+ at \S+:\d+/.test(l), "orphan detail");
    expect(orphanCount, "the orphan count precedes the orphan details").toBeLessThan(orphanDetail);

    const escalationCount = lineOf((l) => /^escalations \(\d+\)/.test(l), "escalation count");
    const escalationDetail = lineOf(
      (l) => /^ {2}\[(reanchor|split-merge|fork-review)\]/.test(l),
      "escalation detail",
    );
    expect(escalationCount, "the escalation count precedes the escalation details").toBeLessThan(escalationDetail);
  });

  // @specs:human-output.listing-longer-than-fixed
  it("truncates a listing past the fixed threshold with a closing '… and N more' line naming --long, and prints everything under --long", () => {
    const repo = manyClaimsRepo("tripact-xcut-trunc-");
    const short = runCli(["check"], { cwd: repo }).stdout;
    const long = runCli(["check", "--long"], { cwd: repo }).stdout;
    const verdictLines = (out: string): string[] =>
      out.split("\n").filter((l) => /^ {4}NEW-UNCOVERED\s+many\./.test(l));

    // 20 spec claims against a fixed threshold of 12 → 12 shown, and a closing line for the other 8
    // that names the flag which prints them.
    expect(verdictLines(short).length, "the truncated listing shows the threshold's worth").toBe(12);
    expect(short).toContain("… and 8 more — run with --long to see all");
    expect(short.match(/… and \d+ more/g)?.length, "one closing line per truncated listing").toBe(1);

    // --long prints everything and drops the closing line.
    expect(verdictLines(long).length, "--long prints every item").toBe(20);
    expect(long, "--long has nothing left to summarise").not.toMatch(/… and \d+ more/);
  });

  // @specs:human-output.human-output-change-never-alters
  it("never lets the human --long flag alter a --json document", () => {
    const repo = manyClaimsRepo("tripact-xcut-jsonstable-");
    // `--long` is a human-rendering flag; where a command offers it, the machine document is
    // byte-identical with and without it.
    for (const command of ["check", "tasks"] as const) {
      const plain = runCli([command, "--json"], { cwd: repo });
      const long = runCli([command, "--json", "--long"], { cwd: repo });
      expect(long.stdout, `${command} --json changed under --long`).toBe(plain.stdout);
      expect(long.status, `${command} --json exit changed under --long`).toBe(plain.status);
    }

    // The machine document carries the full list even where the human rendering truncates, and its
    // shape is pinned by its schemaVersion rather than by any human flag.
    const report = JSON.parse(runCli(["check", "--json"], { cwd: repo }).stdout);
    expect(report.verdicts.length, "the --json document is never truncated").toBeGreaterThan(12);
    expect(report.schemaVersion, "machine schemas evolve only through schemaVersion").toBe(1);
  });

  // @specs:human-output.human-reports-name-verdicts
  it("names verdicts and question kinds with exactly the --json vocabulary", () => {
    const repo = driftedRepo("tripact-xcut-vocab-");
    const human = runCli(["check", "--long", "--strict"], { cwd: repo }).stdout;
    const report = JSON.parse(runCli(["check", "--json", "--strict"], { cwd: repo }).stdout);

    // Verdict labels are the JSON `kind` verbatim, upper-cased. The one embellishment is the
    // acknowledged/new split of `uncovered`, which is itself the JSON's `acknowledged` field.
    const jsonKinds = new Set<string>(report.verdicts.map((v: { kind: string }) => v.kind));
    expect(jsonKinds.has("uncovered"), "the fixture leaves uncovered claims").toBe(true);
    const labels = [...human.matchAll(/^ {4}([A-Z-]+) +\S+ — "/gm)].map((m) => m[1]);
    expect(labels.length, "the human report lists verdicts").toBeGreaterThan(0);
    for (const label of labels) {
      const kind = label === "NEW-UNCOVERED" || label === "BACKLOG" ? "uncovered" : label.toLowerCase();
      expect(jsonKinds.has(kind), `human label ${label} is not a --json verdict kind`).toBe(true);
    }
    // No synonyms for the coverage vocabulary.
    for (const synonym of ["MISSING", "UNTESTED", "FAILED", "PASSED", "OK", "TODO"]) {
      expect(labels, `human report invents the label ${synonym}`).not.toContain(synonym);
    }

    // Question kinds are printed verbatim.
    const jsonQuestionKinds: string[] = report.escalations.map((e: { kind: string }) => e.kind);
    expect(jsonQuestionKinds.length, "the fixture raises an escalation").toBeGreaterThan(0);
    for (const kind of jsonQuestionKinds) expect(human).toContain(`[${kind}]`);
  });
});

describe("cross-cutting: footprint", () => {
  // @specs:footprint.cli-runs-node-22
  it("runs on Node 22 or newer with no native dependencies", () => {
    const pkg = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
    expect(pkg.engines.node, "declared engine range").toBe(">=22");

    // The declared floor is honoured in practice: this suite drives the CLI on the running Node,
    // which the range admits.
    const major = Number(process.versions.node.split(".")[0]);
    expect(major, "the suite runs the CLI on a Node the engine range admits").toBeGreaterThanOrEqual(22);
    const repo = track(fullRepo("tripact-xcut-node-"));
    expect(runCli(["check", "--json"], { cwd: repo }).status, "the CLI runs on this Node").toBe(1);

    // No native dependencies: every runtime dependency is pure JS, with no gyp binding, no prebuilt
    // binary, and no install hook that could compile one.
    for (const dep of Object.keys(pkg.dependencies)) {
      const dir = path.join(repoRoot, "node_modules", dep);
      expect(existsSync(dir), `${dep} is installed`).toBe(true);
      expect(existsSync(path.join(dir, "binding.gyp")), `${dep} ships a node-gyp binding`).toBe(false);
      const depPkg = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
      const scripts: Record<string, string> = depPkg.scripts ?? {};
      for (const hook of ["install", "preinstall", "postinstall"]) {
        expect(scripts[hook], `${dep} runs a ${hook} hook (native build risk)`).toBeUndefined();
      }
      expect(depPkg.gypfile, `${dep} declares a gypfile`).toBeFalsy();
    }
  });

  // @specs:footprint.tripact-contains-only-claimsjson
  it("keeps .tripact/ to claims.json, escalations.json and journal.jsonl", () => {
    const repo = driftedRepo("tripact-xcut-footprint-");
    // Drive every write path: check writes the queue, resolve appends the journal, accept writes
    // the sidecar and clears the queue.
    resolveTheEscalation(repo);
    expect(runCli(["accept", "--yes"], { cwd: repo }).status, "accept after adjudication").toBe(0);
    runCli(["tasks"], { cwd: repo });
    runCli(["reconcile"], { cwd: repo });
    runCli(["status"], { cwd: repo });

    const entries = readdirSync(path.join(repo, ".tripact")).sort();
    expect(entries).toEqual(["claims.json", "escalations.json", "journal.jsonl"]);
  });
});
