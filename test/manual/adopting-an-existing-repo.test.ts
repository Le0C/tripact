// Walks docs/manual/adopting-an-existing-repo.md exactly as written.
//
// Convention for manual walkthroughs (UAC §6.4): the `@docs:<slug>` tag sits on the SAME LINE as the
// `@specs:` ids the section genuinely documents, because that pairing is what bridges a claim to a
// section. Tags merely sharing a file bridge nothing, which is deliberate — it is what stops a page
// marking claims documented that it never mentions.
//
// So: tag a claim here only if the assertions below actually exercise it AND the page actually tells
// the reader about it. A tag that fails either half is false coverage of the worst kind, because it
// is the tool reporting on itself.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { git, runCli } from "../helpers/cli.js";

const repos: string[] = [];
afterAll(() => {
  for (const d of repos.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A git repo containing exactly `files`. */
function repo(files: Record<string, string>): string {
  const d = mkdtempSync(path.join(os.tmpdir(), "tri-manual-adopt-"));
  repos.push(d);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(d, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  git(d, ["init", "-q"]);
  return d;
}

const SPEC = ["# Spec", "", "## Addition", "", "- [ ] add returns the sum of two integers", ""].join("\n");

/** A tag marker for fixture content, assembled so this file's own text never carries a real one. */
const SPEC_TAG = `@${"specs"}:`;

describe("manual: adopting tripact on an existing repository", () => {
  it("@docs:detecting-your-spec-system @specs:spec-system-presets.tripact-detect-reports-read-only @specs:spec-system-presets.same-preset-registry-backs @specs:spec-system-presets.repository-auto-assigned-single-kind @specs:spec-system-presets.detection-returns-every-spec - detect matches by files present, writes nothing, and declines to guess", () => {
    // "It matches known spec systems by the files present on disk, never by reading their contents,
    // and it writes nothing at all - no config, no `.tripact/` directory."
    const one = repo({ "specs/requirements.md": "# Requirements\n\n- [ ] the system SHALL work\n" });
    const detected = runCli(["detect"], { cwd: one });
    expect(detected.status).toBe(0);
    expect(detected.stdout).toContain("kiro");
    expect(existsSync(path.join(one, "tripact.yaml"))).toBe(false);
    expect(existsSync(path.join(one, ".tripact"))).toBe(false);

    // Signatures are file presence, not file contents: an empty file of the right name still matches.
    const byPresence = repo({ "specs/requirements.md": "" });
    expect(runCli(["detect"], { cwd: byPresence }).stdout).toContain("kiro");

    // "Take a single named system as the answer: it is reported only when exactly one system matches."
    expect(detected.stdout).toMatch(/kind: kiro/);

    // "Treat two or more reported systems as a question for you… tripact reports every system whose
    // signature is present and assigns none of them."
    const ambiguous = repo({ "specs/requirements.md": "# R\n", "notes.sdoc": "[DOCUMENT]\nTITLE: x\n" });
    const many = runCli(["detect"], { cwd: ambiguous });
    expect(many.stdout).toContain("kiro");
    expect(many.stdout).toContain("strictdoc");
    expect(many.stdout).not.toMatch(/use `kind: \w/); // no single assignment offered
    expect(many.status).toBe(0); // a report, not a gate

    // "Treat no match as the normal case for a repository that predates any spec-driven convention."
    const none = repo({ "README.md": "# hi" });
    expect(runCli(["detect"], { cwd: none }).stdout).toMatch(/no known spec system/);
  });

  it("@docs:declaring-layers-when-nothing-matches @specs:spec-system-presets.config-accepts-optional-top-level @specs:spec-system-presets.preset-expansion-runs-before @specs:spec-system-presets.preset-expansion-user-first-layer @specs:spec-system-presets.unknown-kind-fails-validation - a kind-only config is complete, what you declare is kept, and a bad kind names the alternatives", () => {
    // "Set `kind:` to a detected system and stop there… `schemaVersion` plus `kind` is a complete
    // config" — and "a `kind:`-only config clears [the two-layer floor] through the preset's own
    // layers", which is only true because expansion runs before structural validation.
    const kindOnly = repo({
      "tripact.yaml": "schemaVersion: 1\nkind: kiro\n",
      "specs/requirements.md": "# R\n\n- [ ] the system SHALL add numbers\n",
    });
    const ran = runCli(["status"], { cwd: kindOnly });
    expect(ran.status).not.toBe(2); // no "at least 2 layers are required"
    expect(ran.stdout).toContain("prescriptive");
    expect(ran.stdout).toContain("verificatory");

    // "Declare any layer, edge list, or exclude you want to differ… what you spell out is kept
    // exactly as written, and the preset fills only what you left out."
    const overridden = repo({
      "tripact.yaml": [
        "schemaVersion: 1",
        "kind: kiro",
        "layers:",
        "  spec:",
        "    role: prescriptive",
        "    paths: [my/own/spec.md]",
        "",
      ].join("\n"),
      "my/own/spec.md": "# Mine\n\n- [ ] a claim of my own\n",
    });
    const kept = runCli(["status"], { cwd: overridden });
    expect(kept.status).not.toBe(2);
    // The declared layer won (it parsed my/own/spec.md), and the preset still supplied `tests`.
    expect(kept.stdout).toContain("1 atoms");
    expect(kept.stdout).toContain("verificatory");

    // "An unknown spec system exits 2 with a message naming the ones tripact accepts."
    const bad = repo({ "tripact.yaml": "schemaVersion: 1\nkind: nope\n" });
    const rejected = runCli(["check"], { cwd: bad });
    expect(rejected.status).toBe(2);
    const said = rejected.stdout + rejected.stderr;
    expect(said).toMatch(/unknown spec system/);
    expect(said).toContain("kiro"); // the accepted systems are named
  });

  it("@docs:reading-the-layer-diagnostics @specs:layer-diagnostics.declared-layer-whose-paths @specs:layer-diagnostics.prescriptive-descriptive-layer-matches @specs:layer-diagnostics.layer-diagnostic-warnings-advisory-they @specs:layer-diagnostics.check-parsed-zero-atoms @specs:layer-diagnostics.vacuous-check-names-empty @specs:layer-diagnostics.check---strict-additionally-treats - the two warnings name different mistakes, are advisory, and gate under --strict", () => {
    const config = (specGlob: string) =>
      [
        "schemaVersion: 1",
        "layers:",
        "  specs:",
        "    role: prescriptive",
        `    paths: [${specGlob}]`,
        "  tests:",
        "    role: verificatory",
        "    paths: [test/**/*.test.ts]",
        "edges:",
        "  - [specs, tests]",
        "",
      ].join("\n");

    // "Read `matched no files` as a wrong path." Spec glob points nowhere; the tests layer is real.
    const wrongPath = repo({
      "tripact.yaml": config("nowhere/**/*.md"),
      "SPEC.md": SPEC,
      "test/a.test.ts": 'test("x", () => {});\n',
    });
    const pathRun = runCli(["check"], { cwd: wrongPath });
    expect(pathRun.stdout).toContain("matched no files");

    // "Read `parsed to 0 atoms` as a wrong format." The file exists but holds no list items.
    const wrongFormat = repo({
      "tripact.yaml": config("PROSE.md"),
      "PROSE.md": "# Prose\n\nThis paragraph states a requirement in lowercase prose only.\n",
      "test/a.test.ts": 'test("x", () => {});\n',
    });
    const formatRun = runCli(["check"], { cwd: wrongFormat });
    expect(formatRun.stdout).toContain("parsed to 0 atoms");

    // "Treat a `vacuous check` differently… reported as drift rather than as a level tree", and it
    // "names the empty layers and points at the glob and format as the likely cause".
    expect(formatRun.stdout).toContain("vacuous check");
    expect(formatRun.stdout).toContain("specs"); // names the empty layer
    expect(formatRun.stdout).toMatch(/glob/);
    expect(formatRun.stdout).toMatch(/format/);
    expect(formatRun.status).toBe(1); // drift, never level

    // "Both are advisory, and neither on its own changes the exit code." Shown on a tree that is
    // otherwise level: one empty layer, but real claims parsed and covered elsewhere.
    const advisory = repo({
      "tripact.yaml": [
        "schemaVersion: 1",
        "layers:",
        "  specs:",
        "    role: prescriptive",
        "    paths: [SPEC.md]",
        "  future:",
        "    role: descriptive",
        "    paths: [docs/**/*.md]", // declared ahead of being populated
        "  tests:",
        "    role: verificatory",
        "    paths: [test/**/*.test.ts]",
        "edges:",
        "  - [specs, tests]",
        "",
      ].join("\n"),
      "SPEC.md": SPEC,
      // Built by concatenation: a literal `@specs:` here would be scanned as one of THIS repo's own
      // tags and reported as an orphan, since the fixture's claim does not exist in this tree.
      "test/a.test.ts": `test("${SPEC_TAG}addition.add-returns-sum-two - adds", () => {});\n`,
    });
    runCli(["accept", "--yes"], { cwd: advisory });
    const advisoryRun = runCli(["check"], { cwd: advisory });
    expect(advisoryRun.stdout).toContain("matched no files"); // the warning is present…
    expect(advisoryRun.status).toBe(0); // …and the tree is still level

    // "Add `--strict` once your layers are populated, which promotes both warnings to drift."
    expect(runCli(["check", "--strict"], { cwd: advisory }).status).toBe(1);
  });

  it("@docs:linking-tests-you-already-have @specs:reconcile-untagged-tests.tripact-reconcile-proposes-per @specs:reconcile-untagged-tests.reconcile-mutates-nothing-no @specs:reconcile-untagged-tests.reconcile-opt-in-not-part @specs:reconcile-untagged-tests.dismissed-candidate-recorded-tripact @specs:reconcile-untagged-tests.reconcile---json-emits-machine-readable - reconcile proposes existing tests, changes nothing, and remembers a dismissal", () => {
    const adopted = repo({
      "tripact.yaml": [
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
        "",
      ].join("\n"),
      "SPEC.md": SPEC,
      // An untagged test whose title closely matches the claim — the adoption case exactly.
      "test/add.test.ts": 'test("add returns the sum of two integers", () => {});\n',
    });

    // "For each uncovered claim it proposes existing tests whose titles score above a fixed
    // similarity threshold against the claim's text."
    const proposed = runCli(["reconcile", "--json"], { cwd: adopted });
    // "…carries a `schemaVersion` and exits 0 because a proposal is advice, not a failure."
    expect(proposed.status).toBe(0);
    const queue = JSON.parse(proposed.stdout) as {
      schemaVersion: number;
      candidates: Array<{ claimId: string; candidates: Array<{ file: string; line: number }> }>;
    };
    expect(queue.schemaVersion).toBe(1);
    expect(queue.candidates.length).toBeGreaterThan(0);
    const first = queue.candidates[0]!;
    const claimId = first.claimId;
    const site = first.candidates[0]!;
    expect(claimId).toMatch(/^addition\./);
    expect(site.file).toBe("test/add.test.ts");

    // "reconcile mutates nothing - no tag, no sidecar, no escalation".
    expect(existsSync(path.join(adopted, ".tripact", "claims.json"))).toBe(false);
    const testFile = readFileSync(path.join(adopted, "test", "add.test.ts"), "utf8");
    expect(testFile).not.toContain("@specs:"); // the test was not tagged for us

    // "reconcile is opt-in and separate from `check`, and never affects its verdicts, counts, or
    // exit code": check reports the claim as uncovered either way.
    const before = runCli(["check", "--json"], { cwd: adopted }).stdout;
    runCli(["reconcile"], { cwd: adopted });
    const after = runCli(["check", "--json"], { cwd: adopted }).stdout;
    expect(after).toBe(before);

    // "Dismiss a proposal you have rejected… which records it against that claim and test so it is
    // never proposed again."
    const dismissed = runCli(
      ["reconcile", "--dismiss", claimId, site!.file, String(site!.line)],
      { cwd: adopted },
    );
    expect(dismissed.status).toBe(0);
    const requeued = JSON.parse(runCli(["reconcile", "--json"], { cwd: adopted }).stdout) as {
      candidates: Array<{ claimId: string }>;
    };
    expect(requeued.candidates.some((p) => p.claimId === claimId)).toBe(false);
  });

  it("@docs:writing-a-tag-that-counts @specs:tag-recognition.tag-verificatory-layer-file @specs:tag-recognition.recognition-property-verificatory-scan @specs:tag-recognition.code-link-scanning-202-exempt @specs:tag-recognition.ignored-mention-never-silent - a tag counts alone on a comment line or in a title, a mention is ignored and named, and code links are untouched", () => {
    const config = [
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
      "codeLinks:",
      "  paths: [src/**/*.ts]",
      "",
    ].join("\n");
    const untagged = repo({ "tripact.yaml": config, "SPEC.md": SPEC, "test/add.test.ts": 'test("adds", () => {});\n' });
    const claimId = (JSON.parse(runCli(["check", "--json"], { cwd: untagged }).stdout) as {
      verdicts: Array<{ subject: string }>;
    }).verdicts[0]!.subject;

    const verdictFor = (dir: string): string =>
      (JSON.parse(runCli(["check", "--json"], { cwd: dir }).stdout) as {
        verdicts: Array<{ subject: string; kind: string }>;
      }).verdicts.find((v) => v.subject === claimId)!.kind;

    // "Write the tag alone on a comment line above the test, or inside the test's title. Both count."
    const online = repo({
      "tripact.yaml": config,
      "SPEC.md": SPEC,
      "test/add.test.ts": `// ${SPEC_TAG}${claimId}\ntest("adds", () => {});\n`,
    });
    expect(verdictFor(online)).toBe("pending");
    const inTitle = repo({
      "tripact.yaml": config,
      "SPEC.md": SPEC,
      "test/add.test.ts": `test("${SPEC_TAG}${claimId} adds", () => {});\n`,
    });
    expect(verdictFor(inTitle)).toBe("pending");

    // "Expect a tag inside a sentence to be ignored, including in the comment explaining why a
    // claim is *not* asserted yet."
    const mentioned = repo({
      "tripact.yaml": config,
      "SPEC.md": SPEC,
      "test/add.test.ts": `// not asserted yet: ${SPEC_TAG}${claimId} needs a browser\ntest("adds", () => {});\n`,
      // "Keep writing `Implements <id>` decorations in product code as prose… `codeLinks` is
      // navigation, never coverage, and is scanned without this rule."
      "src/add.ts": `// Implements ${SPEC_TAG}${claimId}\nexport const add = 1;\n`,
    });
    expect(verdictFor(mentioned)).toBe("uncovered");

    // "Find every ignored mention in the `written into prose` warning that check prints, which
    // names each one's claim id, file and line."
    const report = JSON.parse(runCli(["check", "--json"], { cwd: mentioned }).stdout) as {
      ignoredTags: Array<{ id: string; file: string; line: number }>;
    };
    expect(report.ignoredTags).toEqual([{ id: claimId, file: "test/add.test.ts", line: 1 }]);
    expect(runCli(["check"], { cwd: mentioned }).stdout).toContain("written into prose");

    // The code decoration still resolves as a hotlink, and never entered the coverage reading.
    const hotlinks = JSON.parse(runCli(["hotlinks", "--json"], { cwd: mentioned }).stdout) as {
      links: Array<{ claimId: string; file: string }>;
    };
    expect(hotlinks.links).toEqual([{ claimId, file: "src/add.ts", line: 1 }]);
  });
});

