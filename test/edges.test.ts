// End-to-end coverage of the two coverage edges, driven through the prebuilt CLI over scratch git
// repos: Prescriptive ↔ Verificatory (UAC §4.1: claim ids ↔ test tags, one verdict per non-(tbd)
// atom, orphan tags) and Descriptive ↔ Verificatory (UAC §4.2: docs sections ↔ section tags,
// evaluated at group level).
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { git, runCli } from "./helpers/cli.js";
import { CONFIG, MANUAL, docsTag, specTag, SPECS } from "./helpers/fixture.js";

const scratch: string[] = [];
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});

/** Build a committed scratch repo from a path→content map, wired with the shared tripact.yaml. */
function initRepo(prefix: string, files: Record<string, string>, config = CONFIG): string {
  const repo = mkdtempSync(path.join(os.tmpdir(), prefix));
  scratch.push(repo);
  git(repo, ["init", "-b", "main"]);
  write(repo, { "tripact.yaml": config, ...files });
  commit(repo, "init");
  return repo;
}

function write(repo: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(repo, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
}

function commit(repo: string, message: string): void {
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-m", message]);
}

interface Verdict {
  edge: [string, string];
  subject: string;
  kind: string;
  tags: { file: string; line: number }[];
}
interface Orphan {
  tag: string;
  file: string;
  line: number;
  deadClaimLastText?: string;
}
interface CheckReport {
  verdicts: Verdict[];
  orphans: Orphan[];
  escalations: unknown[];
  exitCode: number;
}

function check(repo: string): CheckReport {
  const r = runCli(["check", "--json"], { cwd: repo });
  return JSON.parse(r.stdout) as CheckReport;
}

/** Every verdict on `edge`, keyed by subject. */
function onEdge(report: CheckReport, edge: [string, string]): Map<string, Verdict> {
  const m = new Map<string, Verdict>();
  for (const v of report.verdicts) {
    if (v.edge[0] === edge[0] && v.edge[1] === edge[1]) m.set(v.subject, v);
  }
  return m;
}

function accept(repo: string): void {
  const r = runCli(["accept", "--yes"], { cwd: repo });
  expect(r.status, `accept\n${r.stderr}`).toBe(0);
}

const SPECS_TBD = [
  "# Spec",
  "",
  "## 1. Calculator",
  "",
  "### 1.1 Addition",
  "",
  "- [ ] alpha claim one",
  "- [ ] bravo claim two",
  "- [ ] charlie claim three",
  "- [ ] delta claim four",
  "",
  "### 1.2 Division (TBD)",
  "",
  "- [ ] echo claim five",
  "",
].join("\n");

describe("Prescriptive ↔ Verificatory (§4.1)", () => {
  // @specs:prescriptive-verificatory-pv.every-non-tbd-prescriptive-atom
  it("gives every non-(tbd) prescriptive atom exactly one verdict — covered, pending, stale, or uncovered", () => {
    // One repo, driven into all four states at once. alpha and charlie are tagged and accepted
    // (covered); then bravo gains a fresh tag (pending), charlie's tagged file is edited (stale),
    // delta is never tagged (uncovered), and echo lives under a (TBD) heading.
    const repo = initRepo("tripact-pv-quad-", {
      "SPECS.md": SPECS_TBD,
      "docs/manual/using.md": MANUAL,
      "tests/e2e/a.spec.ts": `// ${specTag("addition.alpha-claim-one")}\ntest("a", () => {});\n`,
      "tests/e2e/c.spec.ts": `// ${specTag("addition.charlie-claim-three")}\ntest("c", () => {});\n`,
    });
    accept(repo);
    commit(repo, "accept");
    write(repo, {
      "tests/e2e/b.spec.ts": `// ${specTag("addition.bravo-claim-two")}\ntest("b", () => {});\n`,
      "tests/e2e/c.spec.ts": `// ${specTag("addition.charlie-claim-three")}\ntest("c", () => { /* changed */ });\n`,
    });
    commit(repo, "retag and edit");

    const pv = onEdge(check(repo), ["specs", "tests"]);
    expect([...pv.keys()].sort()).toEqual([
      "addition.alpha-claim-one",
      "addition.bravo-claim-two",
      "addition.charlie-claim-three",
      "addition.delta-claim-four",
    ]);
    // covered: a tag references it and the recorded verified state still matches both sides.
    expect(pv.get("addition.alpha-claim-one")?.kind).toBe("covered");
    // pending: tagged, but no verified state has ever been recorded for it on this edge.
    expect(pv.get("addition.bravo-claim-two")?.kind).toBe("pending");
    // stale: a verified state exists but the tagged file's hash moved.
    expect(pv.get("addition.charlie-claim-three")?.kind).toBe("stale");
    // uncovered: no tag references it.
    expect(pv.get("addition.delta-claim-four")?.kind).toBe("uncovered");
    // The (tbd) atom is tracked as a claim but receives no p↔v verdict at all.
    const claims = JSON.parse(runCli(["claims", "--json"], { cwd: repo }).stdout) as {
      claims: { id: string; layer: string; tbd: boolean; verdict?: string }[];
    };
    const echo = claims.claims.find((c) => c.id === "division-tbd.echo-claim-five");
    expect(echo?.tbd).toBe(true);
    expect(pv.has("division-tbd.echo-claim-five")).toBe(false);
  });

  // @specs:prescriptive-verificatory-pv.verified-state-records-claim
  it("records the claim hash and the tagged file's content hash at acceptance, so either side drifting goes stale", () => {
    const repo = initRepo("tripact-pv-verified-", {
      "SPECS.md": SPECS,
      "docs/manual/using.md": MANUAL,
      "tests/e2e/calc.spec.ts":
        `// ${specTag("addition.addnumbers-returns-sum-two")}\ntest("sums", () => {});\n`,
    });
    accept(repo);
    commit(repo, "accept");

    // The verified state names the edge, the claim hash, and the tagged file plus its content hash.
    interface Sidecar {
      claims: {
        id: string;
        hash: string;
        verified: { edge: [string, string]; claimHash: string; file: string; targetFileHash: string }[];
      }[];
    }
    const sidecar = JSON.parse(
      readFileSync(path.join(repo, ".tripact", "claims.json"), "utf8"),
    ) as Sidecar;
    const entry = sidecar.claims.find((c) => c.id === "addition.addnumbers-returns-sum-two");
    expect(entry?.verified).toHaveLength(1);
    const state = entry!.verified[0]!;
    expect(state.edge).toEqual(["specs", "tests"]);
    expect(state.claimHash).toBe(entry!.hash); // claim side, hashed at acceptance time
    expect(state.file).toBe("tests/e2e/calc.spec.ts");
    expect(state.targetFileHash).toMatch(/^[0-9a-f]{16}$/); // test-file side
    expect(check(repo).verdicts.find((v) => v.subject === entry!.id)?.kind).toBe("covered");

    // Test side moves → stale.
    write(repo, {
      "tests/e2e/calc.spec.ts":
        `// ${specTag("addition.addnumbers-returns-sum-two")}\ntest("sums", () => { /* body */ });\n`,
    });
    commit(repo, "edit test");
    expect(check(repo).verdicts.find((v) => v.subject === entry!.id)?.kind).toBe("stale");

    // Re-baseline, then move the claim side instead → stale again.
    accept(repo);
    commit(repo, "accept 2");
    expect(check(repo).verdicts.find((v) => v.subject === entry!.id)?.kind).toBe("covered");
    write(repo, {
      "SPECS.md": SPECS.replace("two integer inputs", "two integer arguments"),
    });
    commit(repo, "reword claim");
    expect(check(repo).verdicts.find((v) => v.subject === entry!.id)?.kind).toBe("stale");
  });

  // @specs:prescriptive-verificatory-pv.stale-verdict-test-side-only-claims
  it("separates test-side-only staleness (accept re-verifies it) from a reworded re-baseline", () => {
    interface Sidecar {
      claims: { id: string; text: string; verified: { claimHash: string }[] }[];
    }
    const readText = (repo: string, id: string): string => {
      const s = JSON.parse(readFileSync(path.join(repo, ".tripact", "claims.json"), "utf8")) as Sidecar;
      return s.claims.find((c) => c.id === id)!.text;
    };
    const currentText = (repo: string, id: string): string => {
      const listed = JSON.parse(runCli(["claims", "--json"], { cwd: repo }).stdout) as {
        claims: { id: string; text: string }[];
      };
      return listed.claims.find((c) => c.id === id)!.text;
    };
    const id = "addition.addnumbers-returns-sum-two";

    // (a) test-side-only: only the tagged file moved. The claim's text still matches its verified
    // state, and accept re-verifies it with no escalation, since no judgement is required.
    const testSide = initRepo("tripact-pv-stale-test-", {
      "SPECS.md": SPECS,
      "docs/manual/using.md": MANUAL,
      "tests/e2e/calc.spec.ts": `// @specs:${id}\ntest("sums", () => {});\n`,
    });
    accept(testSide);
    commit(testSide, "accept");
    write(testSide, {
      "tests/e2e/calc.spec.ts": `// @specs:${id}\ntest("sums", () => { /* body */ });\n`,
    });
    commit(testSide, "edit test");
    const staleA = check(testSide);
    expect(staleA.verdicts.find((v) => v.subject === id)?.kind).toBe("stale");
    expect(currentText(testSide, id)).toBe(readText(testSide, id)); // claim side unmoved
    expect(staleA.escalations).toEqual([]);
    accept(testSide); // re-verifies without judgement
    commit(testSide, "re-accept");
    expect(check(testSide).verdicts.find((v) => v.subject === id)?.kind).toBe("covered");

    // (b) reworded re-baseline: the tagged file is untouched but the claim's text moved away from
    // the text recorded in its verified state.
    const reworded = initRepo("tripact-pv-stale-reword-", {
      "SPECS.md": SPECS,
      "docs/manual/using.md": MANUAL,
      "tests/e2e/calc.spec.ts": `// @specs:${id}\ntest("sums", () => {});\n`,
    });
    accept(reworded);
    commit(reworded, "accept");
    write(reworded, { "SPECS.md": SPECS.replace("two integer inputs", "two integer arguments") });
    commit(reworded, "reword claim");
    const staleB = check(reworded);
    expect(staleB.verdicts.find((v) => v.subject === id)?.kind).toBe("stale");
    expect(currentText(reworded, id)).toBe("addnumbers returns the sum of two integer arguments");
    expect(readText(reworded, id)).toBe("addnumbers returns the sum of two integer inputs");
    expect(currentText(reworded, id)).not.toBe(readText(reworded, id)); // claim side moved
  });

  // @specs:prescriptive-verificatory-pv.tag-referencing-id-no
  it("reports a tag for an unknown id as an orphan with file and line, and a dead claim's tag with its last text", () => {
    const twoClaims = SPECS;
    const repo = initRepo("tripact-pv-orphan-", {
      "SPECS.md": twoClaims,
      "docs/manual/using.md": MANUAL,
      "tests/e2e/calc.spec.ts": [
        `// ${specTag("addition.addnumbers-returns-sum-two")}`,
        'test("sums", () => {});',
        `// ${specTag("no.such-claim")}`,
        'test("nothing", () => {});',
        "",
      ].join("\n"),
    });

    // A tag naming an id no live claim owns is an orphan carrying its file and line.
    const before = check(repo);
    expect(before.orphans).toEqual([
      { tag: "no.such-claim", file: "tests/e2e/calc.spec.ts", line: 3 },
    ]);

    // Retire the tagged claim, leaving its tag behind: the orphan now carries a hint naming the
    // dead claim's last text.
    accept(repo);
    commit(repo, "accept");
    write(repo, {
      "SPECS.md": twoClaims.replace("- [ ] addNumbers returns the sum of two integer inputs\n", ""),
    });
    commit(repo, "delete claim");
    accept(repo); // retires the claim
    commit(repo, "accept retirement");

    const after = check(repo);
    expect(after.orphans).toEqual([
      {
        tag: "addition.addnumbers-returns-sum-two",
        file: "tests/e2e/calc.spec.ts",
        line: 1,
        deadClaimLastText: "addnumbers returns the sum of two integer inputs",
      },
      { tag: "no.such-claim", file: "tests/e2e/calc.spec.ts", line: 3 },
    ]);
    const human = runCli(["check"], { cwd: repo }).stdout;
    expect(human).toContain("orphan tags (2):");
    expect(human).toContain(
      '@addition.addnumbers-returns-sum-two at tests/e2e/calc.spec.ts:1 — dead claim, last text: "addnumbers returns the sum of two integer inputs"',
    );
    expect(human).toContain("@no.such-claim at tests/e2e/calc.spec.ts:3");
  });
});

describe("Descriptive ↔ Verificatory (§4.2)", () => {
  // @specs:descriptive-verificatory-dv.descriptive-groups-manual-sections
  it("links docs sections to tests via section tags matching the layer's sectionTagPattern", () => {
    // Default pattern: @docs:<group-slug>.
    const dflt = initRepo("tripact-dv-default-", {
      "SPECS.md": SPECS,
      "docs/manual/using.md": MANUAL,
      "tests/e2e/calc.spec.ts": `// ${docsTag("adding-numbers")}\ntest("docs", () => {});\n`,
    });
    const dv = onEdge(check(dflt), ["docs", "tests"]);
    expect(dv.get("adding-numbers")?.kind).toBe("pending");
    expect(dv.get("adding-numbers")?.tags).toEqual([{ file: "tests/e2e/calc.spec.ts", line: 1 }]);

    // A configured sectionTagPattern REPLACES the default: `@guide:` links the section, while the
    // default `@docs:` is not scanned at all on this layer, so it links nothing and is not an
    // orphan either. The custom pattern must differ from the default for this to prove anything.
    // `@guide:` is written literally on purpose: this repo scans only `@specs:`/`@docs:`, so the
    // literal is inert here, whereas a literal `@docs:` would be read as a section tag of this
    // repo's own docs layer and reported as an orphan.
    const custom = initRepo(
      "tripact-dv-custom-",
      {
        "SPECS.md": SPECS,
        "docs/manual/using.md": MANUAL,
        "tests/e2e/calc.spec.ts":
          `// @guide:adding-numbers\n// ${docsTag("adding-numbers")}\ntest("docs", () => {});\n`,
      },
      CONFIG.replace(
        "      - tests/**/*.spec.ts\n",
        '      - tests/**/*.spec.ts\n    sectionTagPattern: "@guide:([a-z0-9.-]+)"\n',
      ),
    );
    const report = check(custom);
    const dvCustom = onEdge(report, ["docs", "tests"]);
    expect(dvCustom.get("adding-numbers")?.kind).toBe("pending");
    expect(dvCustom.get("adding-numbers")?.tags).toEqual([
      { file: "tests/e2e/calc.spec.ts", line: 1 },
    ]);
    expect(report.orphans).toEqual([]);
  });

  // @specs:descriptive-verificatory-dv.every-descriptive-group-receives
  it("verdicts descriptive groups — not atoms — through uncovered → pending → covered → stale", () => {
    const edge: [string, string] = ["docs", "tests"];
    const repo = initRepo("tripact-dv-lifecycle-", {
      "SPECS.md": SPECS,
      "docs/manual/using.md": MANUAL,
      "tests/e2e/calc.spec.ts": 'test("docs", () => {});\n',
    });

    // uncovered: no section tag.
    expect(onEdge(check(repo), edge).get("adding-numbers")?.kind).toBe("uncovered");

    // pending: tagged, never verified.
    write(repo, {
      "tests/e2e/calc.spec.ts": `// ${docsTag("adding-numbers")}\ntest("docs", () => {});\n`,
    });
    commit(repo, "tag section");
    expect(onEdge(check(repo), edge).get("adding-numbers")?.kind).toBe("pending");

    // covered: accept records the verified state.
    accept(repo);
    commit(repo, "accept");
    expect(onEdge(check(repo), edge).get("adding-numbers")?.kind).toBe("covered");

    // stale: ANY atom in the section changed since verification, including one no tag names.
    write(repo, {
      "docs/manual/using.md": MANUAL.replace(
        "Type a number in each input field",
        "Type a number into each input field",
      ),
    });
    commit(repo, "edit an atom");
    const stale = check(repo);
    expect(onEdge(stale, edge).get("adding-numbers")?.kind).toBe("stale");
    // The prescriptive edge is untouched by a descriptive edit, so the verdict is group-level.
    expect(onEdge(stale, ["specs", "tests"]).get("addition.addnumbers-returns-sum-two")?.kind).toBe(
      "uncovered",
    );

    // Evaluated at group level: the only docs↔tests subject is the group slug, never an atom id.
    expect([...onEdge(stale, edge).keys()]).toEqual(["adding-numbers"]);
    // Atoms are still tracked for identity: each carries its own id and inherits the group verdict
    // rather than being individually required to have a test.
    const listed = JSON.parse(runCli(["claims", "--json"], { cwd: repo }).stdout) as {
      claims: { id: string; layer: string; verdict?: string }[];
    };
    const docsAtoms = listed.claims.filter((c) => c.layer === "docs");
    expect(docsAtoms.map((c) => c.id).sort()).toEqual([
      "adding-numbers.click-add-see-result",
      "adding-numbers.type-number-each-input", // re-anchored onto the reworded atom
    ]);
    expect(docsAtoms.every((c) => c.verdict === "stale")).toBe(true);
  });

  // @specs:descriptive-verificatory-dv.orphan-section-tags-reported
  it("reports orphan section tags in the same list and shape as §4.1's claim-tag orphans", () => {
    const repo = initRepo("tripact-dv-orphan-", {
      "SPECS.md": SPECS,
      "docs/manual/using.md": MANUAL,
      "tests/e2e/calc.spec.ts": [
        `// ${specTag("no.such-claim")}`,
        `// ${docsTag("no-such-section")}`,
        'test("x", () => {});',
        "",
      ].join("\n"),
    });
    const report = check(repo);
    // Both kinds of orphan land in the one `orphans` list, with identical {tag, file, line} shape.
    expect(report.orphans).toEqual([
      { tag: "no.such-claim", file: "tests/e2e/calc.spec.ts", line: 1 },
      { tag: "no-such-section", file: "tests/e2e/calc.spec.ts", line: 2 },
    ]);
    const human = runCli(["check"], { cwd: repo }).stdout;
    expect(human).toContain("orphan tags (2):");
    expect(human).toContain("@no.such-claim at tests/e2e/calc.spec.ts:1");
    expect(human).toContain("@no-such-section at tests/e2e/calc.spec.ts:2");
    expect(report.exitCode).toBe(1);
  });
});
