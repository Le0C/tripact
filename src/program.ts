// Command construction for tripact's CLI. Wires the deterministic kernel commands (check, status,
// claims, tasks, resolve, verify, diff, accept, generate, mcp-serve) plus the agent-facing surface
// (skills, prompt) — the whole callable a foreign harness drives. Run-book execution and git-commit
// orchestration are harness concerns and live in a driving harness, not here.
//
// buildProgram() must stay free of I/O at construction time; all work happens inside command
// actions. Exit convention (Cross-Cutting): 0 clean, 1 findings/drift, 2 usage or environment error.

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { Command } from "commander";
import { listClaims, renderClaimsHuman } from "./claims.js";
import { acceptPolicy, ConfigError, loadConfig } from "./config.js";
import { deriveOutputs, generateContent, GenerateError } from "./derived.js";
import { computeAcceptanceDelta, renderDeltaHuman } from "./diff.js";
import { analyze, buildAcceptedSidecar } from "./engine.js";
import { resolve as applyResolution, ResolveError, writeEscalations } from "./escalation.js";
import { isGitRepo, repoRootOf, SYNC_POINT_TRAILER } from "./git.js";
import { exitCodeFor, renderHuman, renderStatus, toJsonReport } from "./report.js";
import { loadSidecar, saveSidecar, sidecarContentHash } from "./sidecar.js";
import { emitSkills, escalationPrompt, taskPrompt } from "./skills.js";
import { deriveTasks, renderTasksHuman } from "./tasks.js";
import { TRIPACT_VERSION } from "./version.js";

function fail(message: string, code: 1 | 2 = 2): never {
  console.error(`tripact: ${message}`);
  process.exit(code);
}

function requireRepoRoot(): string {
  if (!isGitRepo(process.cwd())) {
    fail("not inside a git repository — tripact needs git history to track sync-points");
  }
  const root = repoRootOf(process.cwd());
  if (!root) fail("could not determine the git repository root");
  return root;
}

function runAnalysis(root: string) {
  try {
    return analyze(root);
  } catch (e) {
    if (e instanceof ConfigError) fail(e.message);
    throw e;
  }
}

/** Interactive y/N confirmation (UAC §8.3). Only reached on a TTY; anything but y/yes is a no. */
function promptProceed(): Promise<boolean> {
  return new Promise((resolvePrompt) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question("Proceed? [y/N] ", (answer) => {
      rl.close();
      const a = answer.trim().toLowerCase();
      resolvePrompt(a === "y" || a === "yes");
    });
  });
}

/** Outcome of the shared baselining flow (UAC §8.3). `hash` carries the trailer's content hash. */
type BaselineOutcome =
  | { status: "written"; hash: string }
  | { status: "dry"; hash: string }
  | { status: "blocked" }
  | { status: "aborted" };

/**
 * The acceptance core behind `accept` (UAC §8.3): gate on open reanchor/split-merge escalations,
 * print the acceptance summary, confirm on a TTY, then write the sidecar and clear escalations. On
 * `dryRun` it stops after the gate and returns the would-be hash without printing a summary or
 * writing anything.
 */
async function baselineTree(
  root: string,
  analysis: ReturnType<typeof analyze>,
  opts: { yes?: boolean; dryRun?: boolean },
): Promise<BaselineOutcome> {
  const blocking = analysis.escalations.filter((e) => e.kind === "reanchor" || e.kind === "split-merge");
  if (blocking.length) {
    console.error(`tripact: cannot accept — ${blocking.length} open escalation(s):`);
    for (const e of blocking) console.error(`  [${e.kind}] ${e.id} in "${e.groupPath}"`);
    console.error("adjudicate them first with `tripact resolve`");
    return { status: "blocked" };
  }
  const accepted = buildAcceptedSidecar(root, analysis);
  const hash = sidecarContentHash(accepted);
  if (opts.dryRun) return { status: "dry", hash };
  // Acceptance summary before writing (UAC §8.3): created / re-anchored / retired claims, plus
  // verified-state changes per edge.
  const delta = computeAcceptanceDelta(analysis.sidecar, accepted);
  console.log(renderDeltaHuman(delta));
  // Open fork-review questions never block accept (UAC §8.3), but they are named in the acceptance
  // summary so the operator knows which forks they are baselining unadjudicated.
  const openForks = analysis.escalations.filter((e) => e.kind === "fork-review");
  if (openForks.length) {
    console.log("");
    console.log(`accepting with ${openForks.length} open fork-review question(s) (advisory, non-blocking):`);
    for (const e of openForks) console.log(`  [fork-review] ${e.id} in "${e.groupPath}" — ${e.deleted.length} dead / ${e.created.length} created`);
  }
  console.log("");
  // Interactive confirmation on a TTY (UAC §8.3); --yes skips; a non-TTY proceeds as scripted.
  if (process.stdin.isTTY && process.stdout.isTTY && !opts.yes) {
    const ok = await promptProceed();
    if (!ok) return { status: "aborted" };
  }
  saveSidecar(root, accepted);
  writeEscalations(root, []);
  return { status: "written", hash };
}

/**
 * Build the tripact command program (all commands wired, nothing parsed). cli.ts calls
 * `.parseAsync()` on it. Constructing it must never touch the filesystem or exit.
 */
export function buildProgram(): Command {
  const program = new Command("tripact")
    .description("The deterministic traceability kernel — keep spec, docs, and tests describing the same behaviour.")
    .version(TRIPACT_VERSION)
    // Bare `tripact` prints help rather than erroring; discovery over a cryptic exit.
    .action(() => {
      program.help();
    });

  program
    .command("check")
    .description("Deterministic drift check across declared edges (UAC §5)")
    .option("--json", "machine-readable report on stdout")
    .option("--all", "full audit regardless of sync-point")
    .option("--strict", "treat acknowledged backlog as drift too — coverage gate for release pipelines (UAC §5.1)")
    .option("--long", "print every listing in full instead of truncating past a fixed threshold (Cross-Cutting: Human output)")
    .action((opts: { json?: boolean; all?: boolean; strict?: boolean; long?: boolean }) => {
      const root = requireRepoRoot();
      const analysis = runAnalysis(root);
      if (opts.all) {
        analysis.scope = "full";
        analysis.changedPaths = [];
      }
      if (opts.strict) analysis.strict = true;
      writeEscalations(root, analysis.escalations);
      if (opts.json) console.log(JSON.stringify(toJsonReport(analysis), null, 2));
      else console.log(renderHuman(analysis, { long: opts.long === true }));
      process.exit(exitCodeFor(analysis));
    });

  program
    .command("status")
    .description("Traceability summary per layer and edge (UAC §6)")
    .option("--json", "machine-readable output")
    .action((opts: { json?: boolean }) => {
      const root = requireRepoRoot();
      const analysis = runAnalysis(root);
      if (opts.json) console.log(JSON.stringify(toJsonReport(analysis), null, 2));
      else console.log(renderStatus(analysis));
      process.exit(0);
    });

  program
    .command("claims")
    .description("List every alive claim with id, layer, group path, text, and best edge verdict (UAC §6.2)")
    .option("--json", "machine-readable listing on stdout")
    .option("--all", "include dead claims, marked with their last text")
    .action((opts: { json?: boolean; all?: boolean }) => {
      const root = requireRepoRoot();
      const analysis = runAnalysis(root);
      const listing = listClaims(analysis, { all: opts.all === true });
      if (opts.json) console.log(JSON.stringify(listing, null, 2));
      else console.log(renderClaimsHuman(listing));
      // no process.exit(0): the listing can exceed the pipe buffer, and exiting before stdout
      // drains would truncate it — fall through to a natural exit
    });

  program
    .command("tasks")
    .description("Derive a repair/generation work queue from the current state (UAC §10.1)")
    .option("--json", "machine-readable queue on stdout")
    .option("--reconcile <pair>", "also emit a layer-reconciliation task, e.g. uac:manual")
    .option("--long", "print every task in full instead of truncating past a fixed threshold (Cross-Cutting: Human output)")
    .action((opts: { json?: boolean; reconcile?: string; long?: boolean }) => {
      const root = requireRepoRoot();
      const analysis = runAnalysis(root);
      let reconcile: { prescriptive: string; descriptive: string } | undefined;
      if (opts.reconcile !== undefined) {
        const [p, d] = opts.reconcile.split(":");
        if (!p || !d) fail("--reconcile expects <prescriptive-layer>:<descriptive-layer>");
        if (!analysis.layers.has(p) || !analysis.layers.has(d)) {
          fail(`--reconcile: unknown layer in "${opts.reconcile}" (declared: ${[...analysis.layers.keys()].join(", ")})`);
        }
        reconcile = { prescriptive: p, descriptive: d };
      }
      const queue = deriveTasks(analysis, reconcile);
      if (opts.json) console.log(JSON.stringify(queue, null, 2));
      else console.log(renderTasksHuman(queue, { long: opts.long === true }));
      process.exit(queue.tasks.length ? 1 : 0);
    });

  program
    .command("resolve")
    .description("Apply an adjudication answer to an escalation question (UAC §7.2)")
    .argument("<question-id>")
    .option("--match <mapping>", 'old-id="new atom text" — reunite an old identity with a created atom (also reunites a fork)')
    .option("--new <atom>", "treat as a genuinely new atom")
    .option("--dead <old-id>", "mark the old claim dead")
    .option("--dismiss", "accept an advisory fork-review fork — records the dismissal so it is not re-emitted (UAC §7.2)")
    .action((questionId: string, opts: { match?: string; new?: string; dead?: string; dismiss?: boolean }) => {
      const root = requireRepoRoot();
      const given = [opts.match, opts.new, opts.dead, opts.dismiss ? "dismiss" : undefined].filter((x) => x !== undefined);
      if (given.length !== 1) fail("resolve takes exactly one of --match, --new, --dead, --dismiss");
      try {
        if (opts.match !== undefined) {
          const eq = opts.match.indexOf("=");
          if (eq < 1) fail('--match expects old-id="new atom text"');
          applyResolution(root, questionId, {
            kind: "match",
            oldId: opts.match.slice(0, eq).trim(),
            newAtomText: opts.match.slice(eq + 1).trim().replace(/^"|"$/g, ""),
          });
        } else if (opts.new !== undefined) {
          applyResolution(root, questionId, { kind: "new", atomText: opts.new });
        } else if (opts.dead !== undefined) {
          applyResolution(root, questionId, { kind: "dead", oldId: opts.dead });
        } else if (opts.dismiss) {
          applyResolution(root, questionId, { kind: "dismiss" });
        }
        console.log(`resolved ${questionId}`);
        process.exit(0);
      } catch (e) {
        if (e instanceof ResolveError) fail(e.message);
        throw e;
      }
    });

  program
    .command("verify")
    .description("Compare a tripact-sync-id trailer value against the current sidecar's content hash (UAC §8.2)")
    .argument("<hash>", "trailer value to verify")
    .action((hash: string) => {
      const root = requireRepoRoot();
      const current = sidecarContentHash(loadSidecar(root));
      console.log(`supplied trailer:     ${hash}`);
      console.log(`current sidecar hash: ${current}`);
      if (hash === current) {
        console.log("✓ match");
        process.exit(0);
      }
      console.log("✗ mismatch — the sidecar has changed since this trailer was produced");
      process.exit(1);
    });

  program
    .command("diff")
    .description("Preview what acceptance would change — created/re-anchored/retired claims, verified-state deltas, trailers; writes nothing (UAC §8.4)")
    .option("--json", "machine-readable delta on stdout with a schemaVersion")
    .action((opts: { json?: boolean }) => {
      const root = requireRepoRoot();
      const analysis = runAnalysis(root);
      const accepted = buildAcceptedSidecar(root, analysis);
      const delta = computeAcceptanceDelta(analysis.sidecar, accepted);
      if (opts.json) console.log(JSON.stringify(delta, null, 2));
      else console.log(renderDeltaHuman(delta, { trailers: true }));
      process.exit(0); // preview only: never writes, always exit 0
    });

  program
    .command("accept")
    .description("Write anchoring + verified states to the sidecar; prints the tripact-sync-id trailer (UAC §8.3)")
    .option("--dry-run", "print the would-be trailer without writing the sidecar or clearing escalations (UAC §8.2)")
    .option("--yes", "skip the interactive confirmation prompt (UAC §8.3)")
    .action(async (opts: { dryRun?: boolean; yes?: boolean }) => {
      const root = requireRepoRoot();
      const analysis = runAnalysis(root);
      const r = await baselineTree(root, analysis, opts);
      if (r.status === "blocked") process.exit(1);
      if (r.status === "dry") {
        console.log("dry run — sidecar not written, escalations untouched");
        console.log("a real accept would print this trailer:");
        console.log("");
        console.log(`  ${SYNC_POINT_TRAILER}: ${r.hash}`);
        process.exit(0);
      }
      if (r.status === "aborted") {
        console.log("aborted — nothing written, escalations untouched");
        process.exit(0);
      }
      console.log("sidecar written: .tripact/claims.json");
      console.log("include this trailer in your commit message:");
      console.log("");
      console.log(`  ${SYNC_POINT_TRAILER}: ${r.hash}`);
      process.exit(0);
    });

  program
    .command("generate")
    .description("Regenerate declared derived outputs and write them to disk — deterministic, byte-identical across runs; no name regenerates all (UAC §18.1)")
    .argument("[name]", "one declared derived output; omit to regenerate every declared output")
    .action((name: string | undefined) => {
      const root = requireRepoRoot();
      let config;
      try {
        config = loadConfig(root);
      } catch (e) {
        if (e instanceof ConfigError) fail(e.message);
        throw e;
      }
      const outputs = deriveOutputs(config);
      const declared = outputs.map((o) => o.name).join(", ") || "(none declared)";
      let targets = outputs;
      if (name !== undefined) {
        const found = outputs.find((o) => o.name === name);
        if (!found) fail(`unknown derived output "${name}" (declared: ${declared})`);
        targets = [found];
      }
      if (targets.length === 0) {
        console.log("no derived outputs declared in tripact.yaml — nothing to generate");
        process.exit(0);
      }
      try {
        for (const d of targets) {
          const content = generateContent(root, d);
          const abs = path.join(root, d.output);
          mkdirSync(path.dirname(abs), { recursive: true });
          writeFileSync(abs, content, "utf8");
          console.log(`wrote ${d.output} (${d.name})`);
        }
      } catch (e) {
        if (e instanceof GenerateError) fail(e.message); // generator failure → exit 2
        throw e;
      }
      process.exit(0);
    });

  program
    .command("skills")
    .description("Emit the agent skills (detect, adjudicate, repair, sync) as .claude/skills/<name>/SKILL.md — deterministic prompts any coding agent can pick up (UAC §1.2)")
    .option("--dir <path>", "repo root to write into (default: the git repository root)")
    .option("--force", "overwrite existing skill files (default: leave existing files untouched)")
    .action((opts: { dir?: string; force?: boolean }) => {
      const root = opts.dir ?? requireRepoRoot();
      // Bake the configured accept policy into the guidance when there is a config; fall back to the
      // safe `human` default when none is present (skills can be emitted before any check).
      let policy: "human" | "agents" = "human";
      try {
        policy = acceptPolicy(loadConfig(root));
      } catch {
        policy = "human";
      }
      const { written } = emitSkills(root, { cli: "tripact", policy, version: TRIPACT_VERSION, force: opts.force === true });
      if (written.length === 0) {
        console.log("skills already present — pass --force to overwrite");
      } else {
        for (const w of written) console.log(`wrote ${w}`);
      }
      process.exit(0);
    });

  program
    .command("prompt")
    .description("Print a ready-to-hand-to-an-agent prompt for one work item — a task id or an escalation question id (UAC §10.1, §7.2)")
    .argument("<id>", "a task id (from `tasks`) or an escalation question id (from `check`/`escalations`)")
    .option("--reconcile <pair>", "include reconciliation tasks when resolving the id, e.g. uac:manual")
    .action((id: string, opts: { reconcile?: string }) => {
      const root = requireRepoRoot();
      const analysis = runAnalysis(root);
      // Escalation ids and task ids share no namespace; check escalations first, then the queue.
      const esc = analysis.escalations.find((e) => e.id === id);
      if (esc) {
        console.log(escalationPrompt(esc, { cli: "tripact" }));
        process.exit(0);
      }
      let reconcile: { prescriptive: string; descriptive: string } | undefined;
      if (opts.reconcile !== undefined) {
        const [p, d] = opts.reconcile.split(":");
        if (!p || !d) fail("--reconcile expects <prescriptive-layer>:<descriptive-layer>");
        reconcile = { prescriptive: p, descriptive: d };
      }
      const task = deriveTasks(analysis, reconcile).tasks.find((t) => t.id === id);
      if (!task) fail(`no task or escalation with id "${id}" (list them with \`tripact tasks\` / \`tripact check\`)`, 1);
      console.log(taskPrompt(task, { cli: "tripact" }));
      process.exit(0);
    });

  program
    .command("mcp-serve")
    .description("Serve the queues and reports over MCP stdio — read tools plus resolve; accept is exposed only under the `agents` accept policy (UAC §16.2)")
    .action(async () => {
      const root = requireRepoRoot();
      // Lazy import: only mcp-serve ever loads the MCP SDK, so every other command stays SDK-free
      // (Cross-Cutting: Determinism).
      const { serveMcp } = await import("./mcp.js");
      await serveMcp(root);
      // no process.exit: the stdio transport keeps the process alive until the client disconnects
    });

  return program;
}
