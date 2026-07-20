// Sidecar identity + serialisation. UAC §3.2 (.tripact/claims.json). The id-minting claims are
// pure functions of the atom set, so they are driven directly through `assignIds`; the persistence,
// backlog, dead-entry and stable-serialisation claims are driven through the prebuilt CLI over a
// scratch git repo, exactly as a foreign harness would use the kernel.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { assignIds } from "../src/id.js";
import { emptySidecar, serializeSidecar } from "../src/sidecar.js";
import { git, runCli } from "./helpers/cli.js";
import { CONFIG, MANUAL, specTag, SPECS } from "./helpers/fixture.js";

const scratch: string[] = [];
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});

/** Build a committed git repo carrying all three layers; `tests` supplies the verificatory file. */
function makeRepo(tests: string, prefix = "tripact-sidecar-"): string {
  const repo = mkdtempSync(path.join(os.tmpdir(), prefix));
  scratch.push(repo);
  writeFileSync(path.join(repo, "SPECS.md"), SPECS);
  writeFileSync(path.join(repo, "tripact.yaml"), CONFIG);
  mkdirSync(path.join(repo, "docs", "manual"), { recursive: true });
  writeFileSync(path.join(repo, "docs", "manual", "using.md"), MANUAL);
  mkdirSync(path.join(repo, "tests", "e2e"), { recursive: true });
  writeFileSync(path.join(repo, "tests", "e2e", "calc.spec.ts"), tests);
  git(repo, ["init", "-b", "main"]);
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-qm", "init"]);
  return repo;
}

/** Untagged verificatory file: every claim starts uncovered. */
const UNTAGGED = ['test("addNumbers sums two integers", () => {});', 'test("Add button shows the sum", () => {});', ""].join("\n");

/** Reads the committed sidecar as parsed JSON. */
function readSidecar(repo: string): any {
  return JSON.parse(readFileSync(path.join(repo, ".tripact", "claims.json"), "utf8"));
}

describe("sidecar identity (§3.2) — pure id minting", () => {
  const mk = (norm: string) => ({ id: "", groupKey: "Calc > Addition", norm });

  // @specs:sidecar.two-atoms-same-group
  it("gives each colliding atom a distinct self-derived suffix while a non-colliding atom keeps its bare slug", () => {
    // a and b share the same base slug (identical first four significant words); c is distinct.
    const a = mk("sum result value here first variant");
    const b = mk("sum result value here second variant");
    const c = mk("totally different unique wording");
    assignIds([a, b, c], new Set());

    // Both colliders take the bare base plus a six-hex suffix, and the two suffixes differ.
    expect(a.id).toMatch(/^addition\.sum-result-value-here-[0-9a-f]{6}$/);
    expect(b.id).toMatch(/^addition\.sum-result-value-here-[0-9a-f]{6}$/);
    expect(a.id).not.toBe(b.id);
    // The non-colliding atom keeps its bare slug, with no suffix.
    expect(c.id).toBe("addition.totally-different-unique-wording");
  });

  // @specs:sidecar.disambiguating-suffix-depends-only
  it("keeps an already-distinct atom's id fixed when a colliding sibling is added, removed or reordered", () => {
    const distinctAlone = mk("totally different unique wording");
    assignIds([distinctAlone], new Set());

    const distinctWithSiblings = mk("totally different unique wording");
    assignIds([mk("sum result value here first"), mk("sum result value here second"), distinctWithSiblings], new Set());
    // Adding the colliding pair did not perturb the distinct atom.
    expect(distinctWithSiblings.id).toBe(distinctAlone.id);

    // And a collider's own suffix depends only on its identity, never on visitation order.
    const a1 = mk("sum result value here first variant");
    const b1 = mk("sum result value here second variant");
    assignIds([a1, b1], new Set());
    const a2 = mk("sum result value here first variant");
    const b2 = mk("sum result value here second variant");
    assignIds([b2, a2], new Set()); // reversed
    expect(a2.id).toBe(a1.id);
    expect(b2.id).toBe(b1.id);
  });

  // @specs:sidecar.id-assignment-pure-function
  it("assigns the same id to each atom regardless of iteration order (pure function of the set)", () => {
    const norms = ["alpha one two three", "beta four five six", "gamma seven eight nine"];
    const idsFor = (order: string[]) => {
      const atoms = order.map(mk);
      assignIds(atoms, new Set());
      return Object.fromEntries(atoms.map((atom, i) => [order[i]!, atom.id]));
    };
    const forward = idsFor(norms);
    const reversed = idsFor([...norms].reverse());
    expect(reversed).toEqual(forward);
  });
});

describe("sidecar serialisation (§3.2) — stable file", () => {
  // @specs:sidecar.sidecar-serialisation-stable-entries
  it("sorts entries by id, ends with a trailing newline, and is byte-identical for unchanged state", () => {
    const s = emptySidecar();
    const entry = (id: string) => ({
      id,
      layer: "specs",
      groupPath: "Addition",
      groupKey: "addition",
      text: "t",
      hash: "h",
      firstSeen: "a",
      lastSeen: "a",
      alive: true,
      verified: [],
    });
    // Insert deliberately out of order.
    s.claims = [entry("zeta.b"), entry("alpha.a"), entry("mid.c")];
    const out = serializeSidecar(s);
    expect(JSON.parse(out).claims.map((c: any) => c.id)).toEqual(["alpha.a", "mid.c", "zeta.b"]);
    expect(out.endsWith("\n")).toBe(true);
    expect(serializeSidecar(s)).toBe(out); // idempotent → minimal git diffs
  });

  // @specs:sidecar.sidecar-serialisation-stable-entries
  it("writes a byte-identical claims.json when accept runs twice over an unchanged tree", () => {
    const repo = makeRepo(UNTAGGED, "tripact-sidecar-stable-");
    expect(runCli(["accept", "--yes"], { cwd: repo }).status).toBe(0);
    const first = readFileSync(path.join(repo, ".tripact", "claims.json"), "utf8");
    expect(runCli(["accept", "--yes"], { cwd: repo }).status).toBe(0);
    const second = readFileSync(path.join(repo, ".tripact", "claims.json"), "utf8");
    expect(second).toBe(first);
  });
});

describe("sidecar persistence + records (§3.2) — driven through the CLI", () => {
  // @specs:sidecar.claim-identities-live-tripactclaimsjson
  it("commits identities to .tripact/claims.json so a fresh clone reproduces every id", () => {
    const repo = makeRepo(UNTAGGED, "tripact-sidecar-clone-");
    expect(runCli(["accept", "--yes"], { cwd: repo }).status).toBe(0);
    const sidecarFile = path.join(repo, ".tripact", "claims.json");
    expect(existsSync(sidecarFile)).toBe(true);
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-qm", "commit sidecar"]);

    const cloneDir = mkdtempSync(path.join(os.tmpdir(), "tripact-sidecar-cloned-"));
    scratch.push(cloneDir);
    execFileSync("git", ["clone", "--quiet", repo, cloneDir]);
    const cloned = JSON.parse(readFileSync(path.join(cloneDir, ".tripact", "claims.json"), "utf8"));
    const original = readSidecar(repo);
    expect(cloned.claims.map((c: any) => c.id)).toEqual(original.claims.map((c: any) => c.id));
  });

  // @specs:sidecar.each-sidecar-entry-records
  it("records a stable id, layer, group path, content hash and per-edge verified state on each entry", () => {
    // Tag one spec claim so its verified state is populated with the covering edge.
    const tagged = [
      `// ${specTag("addition.addnumbers-returns-sum-two")}`,
      'test("addNumbers sums two integers", () => {});',
      'test("Add button shows the sum", () => {});',
      "",
    ].join("\n");
    const repo = makeRepo(tagged, "tripact-sidecar-records-");
    expect(runCli(["accept", "--yes"], { cwd: repo }).status).toBe(0);
    const sidecar = readSidecar(repo);

    for (const entry of sidecar.claims) {
      expect(typeof entry.id).toBe("string");
      expect(typeof entry.layer).toBe("string");
      expect(typeof entry.groupPath).toBe("string");
      expect(typeof entry.hash).toBe("string");
      expect(Array.isArray(entry.verified)).toBe(true);
    }
    const covered = sidecar.claims.find((c: any) => c.id === "addition.addnumbers-returns-sum-two");
    expect(covered.layer).toBe("specs");
    expect(covered.groupPath).toBe("1. Calculator > 1.1 Addition");
    // Per-edge verified state: the covering edge is recorded on the entry.
    expect(covered.verified).toHaveLength(1);
    expect(covered.verified[0].edge).toEqual(["specs", "tests"]);
  });

  // @specs:sidecar.ids-human-readable-slugs-derived
  it("mints human-readable group.atom slugs that are unique within the repository", () => {
    const repo = makeRepo(UNTAGGED, "tripact-sidecar-slugs-");
    expect(runCli(["accept", "--yes"], { cwd: repo }).status).toBe(0);
    const ids = readSidecar(repo).claims.map((c: any) => c.id);
    // Every id is a group-part.atom-part slug of lowercase words.
    for (const id of ids) expect(id).toMatch(/^[a-z0-9-]+\.[a-z0-9-]+$/);
    // Derived from the group leaf ("Addition") and the atom text ("addNumbers returns the sum…").
    expect(ids).toContain("addition.addnumbers-returns-sum-two");
    // Unique within the repository.
    expect(new Set(ids).size).toBe(ids.length);
  });

  // @specs:sidecar.sidecar-records-acknowledged-backlog
  it("snapshots the uncovered claim ids and section slugs into the acknowledged backlog on accept", () => {
    const repo = makeRepo(UNTAGGED, "tripact-sidecar-backlog-");
    // The backlog only appears once accept has run.
    expect(existsSync(path.join(repo, ".tripact", "claims.json"))).toBe(false);
    expect(runCli(["accept", "--yes"], { cwd: repo }).status).toBe(0);
    const backlog = readSidecar(repo).backlog;
    // Uncovered spec claim ids are acknowledged…
    expect(backlog.claims).toContain("addition.addnumbers-returns-sum-two");
    expect(backlog.claims).toContain("addition.entering-two-numbers-clicking");
    // …and the uncovered descriptive section slug is acknowledged.
    expect(backlog.sections).toContain("adding-numbers");
  });

  // @specs:sidecar.order-independent-minting-governs-only
  it("reuses the persisted id when re-anchoring an unchanged repository, never rewriting it", () => {
    const repo = makeRepo(UNTAGGED, "tripact-sidecar-reanchor-");
    expect(runCli(["accept", "--yes"], { cwd: repo }).status).toBe(0);
    const before = readSidecar(repo).claims.map((c: any) => c.id);
    // Re-anchor: accept again over the same tree.
    expect(runCli(["accept", "--yes"], { cwd: repo }).status).toBe(0);
    const after = readSidecar(repo).claims.map((c: any) => c.id);
    expect(after).toEqual(before);
  });

  // @specs:sidecar.id-once-assigned-never
  it("marks a deleted claim's entry dead rather than removing it, so its id is never reused", () => {
    const repo = makeRepo(UNTAGGED, "tripact-sidecar-dead-");
    expect(runCli(["accept", "--yes"], { cwd: repo }).status).toBe(0);
    expect(readSidecar(repo).claims.some((c: any) => c.id === "addition.entering-two-numbers-clicking")).toBe(true);

    // Drop the second spec claim and re-anchor.
    const trimmed = [
      "# Product Specification — Example",
      "",
      "## 1. Calculator",
      "",
      "### 1.1 Addition",
      "",
      "- [ ] addNumbers returns the sum of two integer inputs",
      "",
    ].join("\n");
    writeFileSync(path.join(repo, "SPECS.md"), trimmed);
    git(repo, ["commit", "-qam", "drop one spec claim"]);
    expect(runCli(["accept", "--yes"], { cwd: repo }).status).toBe(0);

    const dead = readSidecar(repo).claims.find((c: any) => c.id === "addition.entering-two-numbers-clicking");
    expect(dead, "deleted claim's entry is retained").toBeTruthy();
    expect(dead.alive).toBe(false);
  });
});
