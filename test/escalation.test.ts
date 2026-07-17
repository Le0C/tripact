// Escalation queue (UAC §7.1): questions the deterministic engine cannot answer are written to
// .tripact/escalations.json. Driven the way a foreign harness would — a scratch git repo with a
// hand-written tripact.yaml, baselined via `accept`, then a spec edit that forces a re-anchoring
// situation the engine escalates rather than resolves. Every assertion below is matched against the
// real prebuilt CLI's on-disk JSON, observed empirically.
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { runCli } from "./helpers/cli.js";
import { SPECS, fullRepo } from "./helpers/fixture.js";

// The first spec atom in the fixture (SPECS.md, §1.1 Addition). Rewriting it triggers the
// re-anchoring cascade against the baselined sidecar.
const ORIGINAL = "addNumbers returns the sum of two integer inputs";
// Sub-autoAccept similarity (ratio ~0.75): paired as a candidate → a `reanchor` question.
const REANCHOR_VARIANT = "addNumbers returns the sum of two whole numbers together";
// Below the in-group similarity floor: the group loses a dead atom and gains an unpaired created
// atom → an advisory `fork-review` question.
const FORK_VARIANT = "addNumbers adds two integers and returns their total";

const scratch: string[] = [];
afterAll(() => {
  // fullRepo leaks its temp dir; the CLI-driven runs above pollute it further. Clean everything.
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});

/** A fixture repo whose current in-memory anchoring has been baselined into the sidecar. */
function baseline(prefix: string): string {
  const repo = fullRepo(prefix);
  scratch.push(repo);
  const accept = runCli(["accept", "--yes"], { cwd: repo });
  expect(accept.status, `accept\n${accept.stderr}`).toBe(0);
  return repo;
}

/** Rewrite the first spec atom to `variant`, then re-run check so the queue is refreshed. */
function reSpec(repo: string, variant: string): void {
  writeFileSync(path.join(repo, "SPECS.md"), SPECS.replace(ORIGINAL, variant), "utf8");
  runCli(["check"], { cwd: repo });
}

/** Parse the escalation queue straight off disk — no kernel imports, as a foreign consumer would. */
function queue(repo: string): { schemaVersion: unknown; questions: any[] } {
  return JSON.parse(readFileSync(path.join(repo, ".tripact", "escalations.json"), "utf8"));
}

describe("escalation queue (UAC §7.1)", () => {
  // @specs:escalation-queue.questions-deterministic-engine-cannot
  it("writes unanswerable questions to .tripact/escalations.json, replacing the queue each check", () => {
    const repo = baseline("tripact-esc-replace-");

    // A reanchor situation the engine cannot silently resolve is written to the queue file.
    reSpec(repo, REANCHOR_VARIANT);
    const first = queue(repo);
    expect(first.questions.length).toBe(1);
    const reanchorId = first.questions[0].id;
    expect(reanchorId).toMatch(/^reanchor-/);

    // A different edit produces a different question. The next check REPLACES the queue rather than
    // appending: the old reanchor question is gone and only the new fork-review question remains.
    reSpec(repo, FORK_VARIANT);
    const second = queue(repo);
    expect(second.questions.length).toBe(1);
    expect(second.questions.map((q) => q.id)).not.toContain(reanchorId);
    expect(second.questions[0].id).toMatch(/^fork-review-/);
  });

  // @specs:escalation-queue.each-question-has-stable
  it("gives each question a stable deterministic id, a known kind, and a self-contained payload", () => {
    const repo = baseline("tripact-esc-shape-");
    reSpec(repo, REANCHOR_VARIANT);

    const q = queue(repo).questions[0];
    // kind is one of the three escalation kinds.
    expect(["reanchor", "split-merge", "fork-review"]).toContain(q.kind);
    expect(q.kind).toBe("reanchor");

    // Self-contained payload: the affected group's deleted + created atoms and the candidate pairings.
    expect(typeof q.groupPath).toBe("string");
    expect(q.deleted).toEqual([
      { id: expect.any(String), text: expect.any(String) },
    ]);
    expect(q.created[0]).toMatchObject({ text: REANCHOR_VARIANT, file: "SPECS.md" });
    expect(q.candidates[0]).toMatchObject({
      oldId: q.deleted[0].id,
      newText: REANCHOR_VARIANT,
      ratio: expect.any(Number),
    });

    // Stable id: the same underlying situation yields the same id across independent checks.
    const before = q.id;
    runCli(["check"], { cwd: repo });
    expect(queue(repo).questions[0].id).toBe(before);
  });

  // @specs:escalation-queue.fork-review-question-advisory-names
  it("emits an advisory fork-review naming the dead + created atoms, answerable by --dismiss", () => {
    const repo = baseline("tripact-esc-fork-dismiss-");
    reSpec(repo, FORK_VARIANT);

    const q = queue(repo).questions[0];
    expect(q.kind).toBe("fork-review");
    // Names the forked group's dead atom (by id + last text) and its created atom.
    expect(q.deleted[0]).toMatchObject({ id: expect.any(String), text: expect.any(String) });
    expect(q.created[0]).toMatchObject({ text: FORK_VARIANT });

    // Answered by `resolve --dismiss` (accepting the fork): it resolves and leaves the queue.
    const dismiss = runCli(["resolve", q.id, "--dismiss"], { cwd: repo });
    expect(dismiss.status, `dismiss\n${dismiss.stderr}`).toBe(0);
    expect(queue(repo).questions.map((x) => x.id)).not.toContain(q.id);
  });

  // @specs:escalation-queue.fork-review-question-advisory-names
  it("answers a fork-review by --match, reuniting the identity", () => {
    const repo = baseline("tripact-esc-fork-match-");
    reSpec(repo, FORK_VARIANT);

    const q = queue(repo).questions[0];
    expect(q.kind).toBe("fork-review");
    // resolve --match <old-id>="new text" reunites the dead identity with the created atom.
    const match = runCli(
      ["resolve", q.id, "--match", `${q.deleted[0].id}=${q.created[0].text}`],
      { cwd: repo },
    );
    expect(match.status, `match\n${match.stderr}`).toBe(0);
    expect(queue(repo).questions.map((x) => x.id)).not.toContain(q.id);
  });

  // @specs:escalation-queue.escalation-file-valid-json
  it("writes valid JSON carrying a schemaVersion, consumable without kernel internals", () => {
    const repo = baseline("tripact-esc-json-");
    reSpec(repo, REANCHOR_VARIANT);

    // A plain fs read + JSON.parse (no kernel imports) must yield the documented shape.
    const file = queue(repo);
    expect(file.schemaVersion).toBe(1);
    expect(Array.isArray(file.questions)).toBe(true);
  });
});
