// End-to-end coverage of `tripact status` (§6.1) and `tripact claims` (§6.2), driven through the
// prebuilt CLI over scratch git repos. status renders a per-layer/-edge summary and shares check's
// --json document; claims lists every alive claim (id, layer, group path, normalised text, best
// edge verdict, declaring file:line), excludes dead claims unless --all, orders deterministically,
// and exits 0 even under drift so a large listing survives a pipe.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { git, runCli } from "./helpers/cli.js";
import { CONFIG, fullRepo, MANUAL, specTag, SPECS } from "./helpers/fixture.js";

const scratch: string[] = [];
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});

function track(repo: string): string {
  scratch.push(repo);
  return repo;
}

/** Build a committed scratch repo from a path→content map, wired with the shared tripact.yaml. */
function initRepo(prefix: string, files: Record<string, string>): string {
  const repo = track(mkdtempSync(path.join(os.tmpdir(), prefix)));
  git(repo, ["init", "-b", "main"]);
  for (const [rel, content] of Object.entries({ "tripact.yaml": CONFIG, ...files })) {
    const abs = path.join(repo, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-m", "init"]);
  return repo;
}

// A verificatory file that tags the first spec claim, leaving everything else untagged. The tagged
// claim's best edge verdict becomes `pending`; the untagged ones stay `uncovered`.
const TAGGED_TESTS = [
  `// ${specTag("addition.addnumbers-returns-sum-two")}`,
  'test("addNumbers sums two integers", () => {});',
  "",
].join("\n");

describe("tripact status (§6.1)", () => {
  // @specs:tripact-status.status-prints-per-layer-summary
  // @specs:tripact-status.status-reports-orphan-tag-open-escalation
  it("renders per-layer atom/dead counts, a per-edge coverage percentage, and orphan/escalation counts", () => {
    const repo = track(fullRepo("tripact-status-human-"));
    const status = runCli(["status"], { cwd: repo });
    const out = status.stdout;

    // Per-layer summary: alive atom count, TBD count, and retained dead-id count for each modelled
    // layer (the verificatory layer reports its file count instead).
    expect(out).toContain("layer specs (prescriptive): 2 atoms (0 TBD) · 0 dead ids retained");
    expect(out).toContain("layer manual (descriptive): 2 atoms (0 TBD) · 0 dead ids retained");
    // Per-edge coverage percentage, with the covered/stale/uncovered breakdown.
    expect(out).toContain("edge specs ↔ tests: 0% covered (0 covered, 0 stale, 2 uncovered)");
    // Orphan-tag and open-escalation counts.
    expect(out).toContain("orphan tags: 0 · open escalations: 0");
  });

  // @specs:tripact-status.status---json-emits-same
  it("status --json emits the very report document the check surface produces", () => {
    const repo = track(fullRepo("tripact-status-json-"));
    const statusJson = runCli(["status", "--json"], { cwd: repo });
    const checkJson = runCli(["check", "--json"], { cwd: repo });

    // Byte-identical documents from the two surfaces.
    expect(statusJson.stdout).toBe(checkJson.stdout);
    // And it is the shared check report — carries the report schema and an embedded exitCode that
    // status honours (both drift here, exit 1).
    const doc = JSON.parse(statusJson.stdout);
    expect(doc.schemaVersion).toBe(1);
    expect(doc.exitCode).toBe(1);
    expect(statusJson.status).toBe(1);
    expect(checkJson.status).toBe(1);
  });
});

describe("tripact claims (§6.2)", () => {
  // @specs:claim-listing.tripact-claims-lists-every
  it("lists every alive claim with id, layer, group path, normalised text, and best edge verdict", () => {
    const repo = initRepo("tripact-claims-every-", {
      "SPECS.md": SPECS,
      "docs/manual/using.md": MANUAL,
      "tests/e2e/calc.spec.ts": TAGGED_TESTS,
    });
    const listing = JSON.parse(runCli(["claims", "--json"], { cwd: repo }).stdout);
    const byId = new Map<string, any>(listing.claims.map((c: any) => [c.id, c]));

    // Every alive claim across the two modelled layers is present (2 spec + 2 manual), none from the
    // verificatory layer.
    expect(listing.claims.map((c: any) => c.id).sort()).toEqual(
      [
        "adding-numbers.click-add-see-result",
        "adding-numbers.type-number-each-input",
        "addition.addnumbers-returns-sum-two",
        "addition.entering-two-numbers-clicking",
      ].sort(),
    );

    // id, layer, group path, and normalised text (the source line lower-cased).
    const tagged = byId.get("addition.addnumbers-returns-sum-two");
    expect(tagged.layer).toBe("specs");
    expect(tagged.groupPath).toBe("1. Calculator > 1.1 Addition");
    expect(tagged.text).toBe("addnumbers returns the sum of two integer inputs");

    // Best edge verdict across all edges: the tagged claim is pending, an untagged one uncovered.
    expect(tagged.verdict).toBe("pending");
    expect(byId.get("adding-numbers.type-number-each-input").verdict).toBe("uncovered");
  });

  // @specs:claim-listing.each-listed-claim-carries
  it("carries each alive claim's declaring file and line for use as a navigation target", () => {
    const repo = initRepo("tripact-claims-loc-", {
      "SPECS.md": SPECS,
      "docs/manual/using.md": MANUAL,
      "tests/e2e/calc.spec.ts": TAGGED_TESTS,
    });
    const listing = JSON.parse(runCli(["claims", "--json"], { cwd: repo }).stdout);
    const byId = new Map<string, any>(listing.claims.map((c: any) => [c.id, c]));

    expect(byId.get("addition.addnumbers-returns-sum-two")).toMatchObject({
      file: "SPECS.md",
      line: 7,
    });
    expect(byId.get("adding-numbers.type-number-each-input")).toMatchObject({
      file: "docs/manual/using.md",
      line: 5,
    });
    // Every alive claim carries a location.
    for (const c of listing.claims) {
      expect(typeof c.file, `${c.id} file`).toBe("string");
      expect(typeof c.line, `${c.id} line`).toBe("number");
    }
  });

  // @specs:claim-listing.claims---json-emits-same
  it("claims --json emits the listing machine-readably with a schemaVersion and each file/line", () => {
    const repo = initRepo("tripact-claims-jsonschema-", {
      "SPECS.md": SPECS,
      "docs/manual/using.md": MANUAL,
      "tests/e2e/calc.spec.ts": TAGGED_TESTS,
    });
    const listing = JSON.parse(runCli(["claims", "--json"], { cwd: repo }).stdout);

    expect(listing.schemaVersion).toBe(1);
    expect(Array.isArray(listing.claims)).toBe(true);
    // The same listing the human surface shows, machine-readably: each entry carries id, layer,
    // group path, text, verdict, and its declaring file and line.
    for (const c of listing.claims) {
      expect(c).toEqual(
        expect.objectContaining({
          id: expect.any(String),
          layer: expect.any(String),
          groupPath: expect.any(String),
          text: expect.any(String),
          file: expect.any(String),
          line: expect.any(Number),
        }),
      );
    }
  });

  // @specs:claim-listing.dead-claims-excluded-default
  it("excludes dead claims by default and includes them with --all, marked dead with their last text", () => {
    // Baseline, then retire the second spec claim so it becomes a dead-but-retained id.
    const repo = initRepo("tripact-claims-dead-", {
      "SPECS.md": SPECS,
      "docs/manual/using.md": MANUAL,
      "tests/e2e/calc.spec.ts": TAGGED_TESTS,
    });
    runCli(["accept", "--yes"], { cwd: repo });
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-m", "accept"]);
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
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-m", "retire one spec"]);

    // Default: the dead claim is absent.
    const def = JSON.parse(runCli(["claims", "--json"], { cwd: repo }).stdout);
    expect(def.claims.some((c: any) => !c.alive)).toBe(false);
    expect(def.claims.some((c: any) => c.id === "addition.entering-two-numbers-clicking")).toBe(false);

    // --all: the dead claim reappears, flagged not-alive and carrying its last known text.
    const all = JSON.parse(runCli(["claims", "--json", "--all"], { cwd: repo }).stdout);
    const dead = all.claims.find((c: any) => c.id === "addition.entering-two-numbers-clicking");
    expect(dead).toBeDefined();
    expect(dead.alive).toBe(false);
    expect(dead.lastText).toBe("entering two numbers and clicking add shows the sum on screen");
  });

  // @specs:claim-listing.listing-order-deterministic-layer
  it("orders by layer then document order, with dead entries sorted by id", () => {
    // Alive ordering: layer order (manual before specs), then document order within a layer.
    const alive = initRepo("tripact-claims-order-", {
      "SPECS.md": SPECS,
      "docs/manual/using.md": MANUAL,
      "tests/e2e/calc.spec.ts": TAGGED_TESTS,
    });
    const ids = JSON.parse(runCli(["claims", "--json"], { cwd: alive }).stdout).claims.map(
      (c: any) => c.id,
    );
    expect(ids).toEqual([
      "adding-numbers.type-number-each-input", // manual, line 5
      "adding-numbers.click-add-see-result", // manual, line 6
      "addition.addnumbers-returns-sum-two", // specs, line 7
      "addition.entering-two-numbers-clicking", // specs, line 8
    ]);

    // Dead ordering: two spec claims whose ids sort opposite to their document order, both retired,
    // must come out sorted by id (not by their original line).
    const specTwo = [
      "# Spec",
      "",
      "## 1. Zed",
      "",
      "### 1.1 Sub",
      "",
      "- [ ] zzz alpha claim about widgets working",
      "- [ ] aaa beta claim about gadgets working",
      "",
    ].join("\n");
    const deadRepo = initRepo("tripact-claims-deadorder-", {
      "SPECS.md": specTwo,
      "docs/manual/using.md": MANUAL,
      "tests/e2e/calc.spec.ts": "test(\"x\", () => {});\n",
    });
    runCli(["accept", "--yes"], { cwd: deadRepo });
    git(deadRepo, ["add", "-A"]);
    git(deadRepo, ["commit", "-m", "accept"]);
    writeFileSync(path.join(deadRepo, "SPECS.md"), ["# Spec", "", "## 1. Zed", "", "### 1.1 Sub", ""].join("\n"));
    git(deadRepo, ["add", "-A"]);
    git(deadRepo, ["commit", "-m", "retire both"]);
    const deadIds = JSON.parse(runCli(["claims", "--json", "--all"], { cwd: deadRepo }).stdout).claims
      .filter((c: any) => !c.alive)
      .map((c: any) => c.id);
    expect(deadIds).toEqual(["sub.aaa-beta-claim-about", "sub.zzz-alpha-claim-about"]);
  });

  // @specs:claim-listing.claims-prints-full-listing
  it("prints its full listing and exits 0 under drift, unlike the check/status drift convention", () => {
    // A fully-untagged repo is in drift: check and status exit 1. claims prints the listing and
    // still exits 0, so a large listing survives being piped.
    const repo = track(fullRepo("tripact-claims-exit0-"));
    expect(runCli(["check"], { cwd: repo }).status, "check under drift").toBe(1);
    expect(runCli(["status"], { cwd: repo }).status, "status under drift").toBe(1);

    const claims = runCli(["claims"], { cwd: repo });
    expect(claims.status, "claims exits 0 despite drift").toBe(0);
    expect(claims.stdout).toContain("tripact claims — 4 alive");

    const claimsJson = runCli(["claims", "--json"], { cwd: repo });
    expect(claimsJson.status, "claims --json exits 0 despite drift").toBe(0);
  });
});
