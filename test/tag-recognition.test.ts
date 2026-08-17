// Tag recognition (UAC §4.4) and its diagnostic (§5.4). A tag counts towards a verdict only when
// written AS a tag - alone on a comment line, or inside a test's title. A tag written into prose is
// a mention, and a mention is ignored and named. Before this rule the scan was pure text, so
// documenting why a claim was untested registered that claim as covered: the failure was silent and
// inverted, and the more carefully a gap was explained the more coverage it invented.
//
// Driven the foreign-harness way: scratch git repos and the prebuilt CLI. Fixture tags are composed
// through specTag()/docsTag() and never written literally, because this repo dogfoods tripact and
// scans this very file (see test/helpers/fixture.ts).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { git, runCli } from "./helpers/cli.js";
import { docsTag, MANUAL, specTag, SPECS } from "./helpers/fixture.js";

const scratch: string[] = [];
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});

const SPECS_ONLY = [
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
].join("\n");

const WITH_DOCS = [
  "schemaVersion: 1",
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
  "edges:",
  "  - [specs, tests]",
  "  - [docs, tests]",
  "",
].join("\n");

interface IgnoredTag {
  id: string;
  file: string;
  line: number;
}
interface Report {
  verdicts: Array<{ edge: [string, string]; subject: string; kind: string }>;
  orphans: unknown[];
  ignoredTags: IgnoredTag[];
  counts: Record<string, number>;
  exitCode: 0 | 1 | 2;
}

function repo(files: Record<string, string>, config = SPECS_ONLY): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tripact-tagrec-"));
  scratch.push(dir);
  git(dir, ["init", "-b", "main"]);
  write(dir, { "tripact.yaml": config, "SPECS.md": SPECS, ...files });
  commit(dir, "init");
  return dir;
}

function write(dir: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
}

function commit(dir: string, message: string): void {
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-m", message]);
}

function check(dir: string): Report {
  return JSON.parse(runCli(["check", "--json"], { cwd: dir }).stdout) as Report;
}

/** Verdict subjects on the edge touching `layer`, so content-derived ids never have to be guessed. */
function subjectsOn(report: Report, layer: string): string[] {
  return report.verdicts.filter((v) => v.edge.includes(layer)).map((v) => v.subject).sort();
}

function kindOf(report: Report, subject: string): string | undefined {
  return report.verdicts.find((v) => v.subject === subject)?.kind;
}

/** The two content-derived claim ids of the shared SPECS fixture, discovered from an untagged pass. */
function claimIds(dir: string): [string, string] {
  const ids = subjectsOn(check(dir), "specs");
  expect(ids).toHaveLength(2);
  return [ids[0] as string, ids[1] as string];
}

describe("tag recognition (§4.4)", () => {
  // @specs:tag-recognition.tag-verificatory-layer-file
  it("counts a tag written as a tag, and ignores one written into prose", () => {
    const dir = repo({ "tests/calc.spec.ts": "" });
    const [a, b] = claimIds(dir);

    // Both real conventions count: a dedicated comment line, and a tag inside a test's title.
    write(dir, {
      "tests/calc.spec.ts": [
        `// ${specTag(a)}`,
        'test("sums two integers", () => {});',
        `test("${specTag(b)} shows the sum on screen", () => {});`,
        "",
      ].join("\n"),
    });
    commit(dir, "tag both claims");
    const declared = check(dir);
    expect(kindOf(declared, a), "dedicated comment line counts").toBe("pending");
    expect(kindOf(declared, b), "test title counts").toBe("pending");
    expect(declared.ignoredTags).toEqual([]);

    // Neither prose shape counts: the line comment carries an explanation, and the block comment a
    // cross-reference. This is the exact shape that used to fabricate coverage.
    write(dir, {
      "tests/calc.spec.ts": [
        `// cannot assert ${specTag(a)} until the calculator mounts`,
        'test("sums two integers", () => {});',
        `/* see ${specTag(b)} for context */`,
        'test("shows the sum on screen", () => {});',
        "",
      ].join("\n"),
    });
    commit(dir, "mention both claims in prose");
    const prose = check(dir);
    expect(kindOf(prose, a), "prose line comment does not count").toBe("uncovered");
    expect(kindOf(prose, b), "prose block comment does not count").toBe("uncovered");
    expect(prose.ignoredTags.map((t) => t.id).sort()).toEqual([a, b].sort());
  });

  // @specs:tag-recognition.recognition-property-verificatory-scan
  it("applies to section tags too, and reads one dedicated line carrying both kinds as a declaration", () => {
    const dir = repo({ "docs/manual/using.md": MANUAL, "tests/calc.spec.ts": "" }, WITH_DOCS);
    const [a] = claimIds(dir);
    const slug = subjectsOn(check(dir), "docs").find((s) => s.includes("adding")) as string;
    expect(slug).toBeTruthy();

    // One dedicated line carrying an id tag and a section tag together is still nothing but tags,
    // so both vocabularies are recognised on it - the two scans run separately over the same line.
    write(dir, {
      "tests/calc.spec.ts": [`// ${specTag(a)} ${docsTag(slug)}`, 'test("sums two integers", () => {});', ""].join("\n"),
    });
    commit(dir, "tag claim and section on one line");
    const both = check(dir);
    expect(kindOf(both, a), "id tag on the shared line").toBe("pending");
    expect(kindOf(both, slug), "section tag on the shared line").toBe("pending");
    expect(both.ignoredTags).toEqual([]);

    // A section tag written into prose is ignored exactly as an id tag is.
    write(dir, {
      "tests/calc.spec.ts": [
        `// ${specTag(a)}`,
        `// this walkthrough does not yet cover ${docsTag(slug)} end to end`,
        'test("sums two integers", () => {});',
        "",
      ].join("\n"),
    });
    commit(dir, "mention the section in prose");
    const mentioned = check(dir);
    expect(kindOf(mentioned, slug), "section mentioned in prose").toBe("uncovered");
    expect(mentioned.ignoredTags.map((t) => t.id)).toEqual([slug]);
  });

  // @specs:tag-recognition.code-link-scanning-202-exempt
  it("leaves code-link scanning alone: a hotlink written into prose still resolves", () => {
    const dir = repo({ "tests/calc.spec.ts": "" }, `${SPECS_ONLY}codeLinks:\n  paths:\n    - src/**/*.ts\n`);
    const [a] = claimIds(dir);
    // The prose form is the documented hotlink convention (§20.3): a decoration comment written into
    // a JSDoc block, which recognition would read as a mention if it applied here.
    write(dir, { "src/calc.ts": [`/**`, ` * Implements ${specTag(a)}`, ` */`, "export const add = 1;", ""].join("\n") });
    commit(dir, "add a prose hotlink");

    const hotlinks = JSON.parse(runCli(["hotlinks", "--json"], { cwd: dir }).stdout) as {
      links: Array<{ claimId: string; file: string }>;
      orphans: unknown[];
    };
    expect(hotlinks.links.map((l) => l.claimId), "the prose hotlink still resolves").toEqual([a]);
    expect(hotlinks.orphans).toEqual([]);

    // And it stays navigation: no verdict moved, and it is not reported as an ignored mention,
    // because a code tag never counted towards coverage in the first place.
    const report = check(dir);
    expect(kindOf(report, a)).toBe("uncovered");
    expect(report.ignoredTags).toEqual([]);
  });

  // @specs:tag-recognition.ignored-mention-never-silent
  it("explains an uncovered claim whose only tag sits in prose, rather than dropping it silently", () => {
    const dir = repo({ "tests/calc.spec.ts": "" });
    const [a] = claimIds(dir);
    write(dir, {
      "tests/calc.spec.ts": [`// deliberately untagged: cannot assert ${specTag(a)} headlessly`, 'test("sums", () => {});', ""].join("\n"),
    });
    commit(dir, "explain the gap in prose");

    const report = check(dir);
    // The linkage is the point: every claim that reads uncovered purely because its tag was
    // ignored has a diagnostic entry naming it, so the coverage flip is never mysterious.
    expect(kindOf(report, a)).toBe("uncovered");
    expect(report.ignoredTags.map((t) => t.id)).toContain(a);
  });

  // @specs:tag-recognition.recognition-deterministic-line-based-same
  it("is deterministic and stably ordered by file then line", () => {
    const dir = repo({ "tests/calc.spec.ts": "" });
    const [a, b] = claimIds(dir);
    write(dir, {
      "tests/b-later.spec.ts": [`// nothing asserts ${specTag(b)} yet`, 'test("later", () => {});', ""].join("\n"),
      "tests/a-first.spec.ts": [
        "// intentionally two mentions in one file, on descending ids",
        `// blocked on ${specTag(b)}`,
        `// blocked on ${specTag(a)}`,
        'test("first", () => {});',
        "",
      ].join("\n"),
    });
    commit(dir, "mentions across two files");

    const first = check(dir);
    const second = check(dir);
    expect(second.ignoredTags, "an identical tree yields an identical scan").toEqual(first.ignoredTags);
    expect(first.ignoredTags.map((t) => [t.file, t.line])).toEqual([
      ["tests/a-first.spec.ts", 2],
      ["tests/a-first.spec.ts", 3],
      ["tests/b-later.spec.ts", 1],
    ]);
  });
});

describe("the ignoredTags diagnostic (§5.4)", () => {
  // @specs:layer-diagnostics.verificatory-tag-ignored-prose
  it("reports an ignored mention in --json and the human report, naming the id, file and line", () => {
    const dir = repo({ "tests/calc.spec.ts": "" });
    const [a] = claimIds(dir);
    write(dir, {
      "tests/calc.spec.ts": ["", `// cannot assert ${specTag(a)} without a browser`, 'test("sums", () => {});', ""].join("\n"),
    });
    commit(dir, "mention in prose");

    const report = check(dir);
    expect(report.ignoredTags).toHaveLength(1);
    expect(report.ignoredTags[0]).toEqual({ id: a, file: "tests/calc.spec.ts", line: 2 });
    expect(report.counts["ignoredTags"]).toBe(1);

    const human = runCli(["check"], { cwd: dir }).stdout;
    expect(human).toContain("written into prose");
    expect(human).toContain(`tests/calc.spec.ts:2 — ${a}`);
  });

  // @specs:layer-diagnostics.ignoredtags-warning-advisory-never
  it("is advisory: a mention beside an otherwise-covered claim leaves a level repository level", () => {
    const dir = repo({ "tests/calc.spec.ts": "" });
    const [a, b] = claimIds(dir);
    // Every claim genuinely tagged, so the repository is level once accepted…
    write(dir, {
      "tests/calc.spec.ts": [`// ${specTag(a)}`, `// ${specTag(b)}`, 'test("sums and shows", () => {});', ""].join("\n"),
    });
    commit(dir, "tag both claims");
    expect(runCli(["accept", "--yes"], { cwd: dir }).status, "accept baselines both claims").toBe(0);
    commit(dir, "accept");
    expect(runCli(["check"], { cwd: dir }).status, "level before the mention").toBe(0);

    // …and adding a prose mention of an ALREADY COVERED claim must not move the exit code. Asserting
    // against a covered claim is the sharp version: with an uncovered one the check would exit 1 for
    // the verdict, and the assertion would pass for the wrong reason.
    write(dir, {
      "tests/calc.spec.ts": [
        `// ${specTag(a)}`,
        `// ${specTag(b)}`,
        `// note: ${specTag(a)} is only asserted for integers`,
        'test("sums and shows", () => {});',
        "",
      ].join("\n"),
    });
    commit(dir, "add a prose mention");
    expect(runCli(["accept", "--yes"], { cwd: dir }).status, "re-verify the edited test file").toBe(0);
    commit(dir, "re-accept");

    const after = check(dir);
    expect(kindOf(after, a), "the claim is still covered by its real tag").toBe("covered");
    expect(after.ignoredTags.map((t) => t.id), "the mention is still reported").toEqual([a]);
    expect(after.exitCode, "the warning alone is not drift").toBe(0);
    expect(runCli(["check"], { cwd: dir }).status, "exit code matches the report").toBe(0);
  });
});
