// Atoms tracked but kept out of the coverage denominator: unfilled template placeholders and
// informative sections. UAC §3.1, §5.4, §6.2, §10.1, and the preset glob shape of §2.3.
//
// All three behaviours came out of the ngx-dev-toolbar trial (2026-07-22), where a spec-kit repo
// with 401 passing tests reported as having none, 38 of its 426 claims were unedited template
// boilerplate, and a `write-tests` task for its Out of Scope section produced 114 tagged
// tautologies from a cheap model that had no way to say "this is not a requirement".
//
// @specs:markdown-parsing.atom-whose-text-still
// @specs:markdown-parsing.placeholder-detection-ignores-markdown
// @specs:markdown-parsing.atom-under-heading-naming
// @specs:markdown-parsing.heading-matched-against-informative
// @specs:tripactyaml-schema.config-accepts-optional-informativegroups
// @specs:spec-system-presets.preset-seeds-verificatory-layer
// @specs:layer-diagnostics.zero-file-warning-names-globs
// @specs:layer-diagnostics.atoms-excluded-from-coverage
// @specs:claim-listing.claim-excluded-from-coverage
// @specs:task-emission.placeholder-informative-atom-31
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listClaims } from "../src/claims.js";
import { loadConfig } from "../src/config.js";
import { analyze } from "../src/engine.js";
import { hasTemplatePlaceholder, isInformativeHeading, parseMarkdownLayer } from "../src/parser.js";
import { SPEC_SYSTEM_PRESETS } from "../src/presets.js";
import { renderHuman, toJsonReport } from "../src/report.js";
import { deriveTasks } from "../src/tasks.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function repo(files: Record<string, string>): string {
  const d = mkdtempSync(path.join(tmpdir(), "tri-excl-"));
  dirs.push(d);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(d, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  execFileSync("git", ["init", "-q"], { cwd: d });
  execFileSync("git", ["add", "-A"], { cwd: d });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: d });
  return d;
}

// ---------------------------------------------------------------------------------------------
// §3.1 — unfilled template placeholders
// ---------------------------------------------------------------------------------------------
describe("template placeholders (§3.1)", () => {
  it("treats an atom carrying an unsubstituted bracketed span as TBD, not a live requirement", () => {
    const { atoms } = parseMarkdownLayer(
      "spec",
      "spec.md",
      [
        "## Requirements",
        "",
        '- **FR-001**: System MUST [specific capability, e.g., "allow users to create accounts"]',
        "- **FR-002**: System MUST persist the forced state to localStorage",
      ].join("\n"),
    );
    const [boilerplate, real] = atoms;
    expect(boilerplate?.placeholder).toBe(true);
    expect(boilerplate?.tbd).toBe(true); // rides the existing exclusion rail
    expect(real?.placeholder).toBe(false);
    expect(real?.tbd).toBe(false);
  });

  it("ignores markdown links and inline code, and needs two words, so real requirements survive", () => {
    // The three shapes a real requirement legitimately uses.
    expect(hasTemplatePlaceholder("see the [contract](docs/contract.md) for the full list")).toBe(false);
    expect(hasTemplatePlaceholder("the `[all]` filter selects every entry")).toBe(false);
    expect(hasTemplatePlaceholder("supports [1..n] items")).toBe(false);
    expect(hasTemplatePlaceholder("- [x] a legacy checkbox item")).toBe(false);
    // The shapes spec-kit's own template ships with.
    expect(hasTemplatePlaceholder("System MUST [specific capability]")).toBe(true);
    expect(hasTemplatePlaceholder("How does the system handle [error scenario]?")).toBe(true);
    expect(hasTemplatePlaceholder("User Story 1 - [Brief Title]")).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// §3.1 — informative sections
// ---------------------------------------------------------------------------------------------
describe("informative sections (§3.1)", () => {
  const DOC = [
    "## Requirements",
    "",
    "- the toolbar MUST persist forced flags",
    "",
    "## Out of Scope",
    "",
    "- cloud sync and team sharing",
    "- backend API integration",
    "",
    "## Requirements Again",
    "",
    "- the badge MUST hide at zero",
  ].join("\n");

  it("tracks an Out of Scope atom but marks it informative, and resumes at the next heading", () => {
    const { atoms } = parseMarkdownLayer("spec", "spec.md", DOC);
    const byText = (t: string) => atoms.find((a) => a.raw.includes(t));
    expect(byText("cloud sync")?.informative).toBe(true);
    expect(byText("backend API")?.informative).toBe(true);
    // Tracked, not dropped — the statement still has an identity.
    expect(atoms).toHaveLength(4);
    // The flag does not leak past its own heading.
    expect(byText("persist forced flags")?.informative).toBe(false);
    expect(byText("badge MUST hide")?.informative).toBe(false);
  });

  it("matches on the numbering-stripped, case-folded title, annotations and all", () => {
    for (const title of ["Out of Scope", "7. Out of Scope", "OUT OF SCOPE", "Out-of-Scope *(mandatory)*", "Non-Goals"]) {
      expect(isInformativeHeading(title, ["out of scope", "out-of-scope", "non-goals"])).toBe(true);
    }
    // A heading that merely mentions the words is not one.
    expect(isInformativeHeading("Requirements", ["out of scope"])).toBe(false);
    expect(isInformativeHeading("What is out of scope for this release", ["out of scope"])).toBe(false);
  });

  it("takes the configured list in place of the default, and an empty list turns it off", () => {
    const d = repo({
      "tripact.yaml": [
        "schemaVersion: 1",
        "informativeGroups: ['Deliberately Excluded']",
        "layers:",
        "  spec: { role: prescriptive, paths: ['spec.md'] }",
        "  tests: { role: verificatory, paths: ['t/**/*.test.ts'] }",
        "edges: [[spec, tests]]",
      ].join("\n"),
      "spec.md": "## Out of Scope\n\n- cloud sync\n\n## Deliberately Excluded\n\n- team sharing\n",
      "t/a.test.ts": "// none\n",
    });
    const cfg = loadConfig(d);
    expect(cfg.informativeGroups).toEqual(["Deliberately Excluded"]);
    const atoms = analyze(d).layers.get("spec")?.atoms ?? [];
    // The declared list REPLACES the default: the built-in "Out of Scope" no longer applies.
    expect(atoms.find((a) => a.raw.includes("cloud sync"))?.informative).toBe(false);
    expect(atoms.find((a) => a.raw.includes("team sharing"))?.informative).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// §5.4 / §6.2 / §10.1 — what the excluded atoms do to coverage, reporting, listing and tasks
// ---------------------------------------------------------------------------------------------
describe("excluded atoms leave the denominator visibly (§5.4, §6.2, §10.1)", () => {
  const specKitRepo = () =>
    repo({
      "tripact.yaml": [
        "schemaVersion: 1",
        "layers:",
        "  spec: { role: prescriptive, paths: ['spec.md'] }",
        "  tests: { role: verificatory, paths: ['t/**/*.test.ts'] }",
        "edges: [[spec, tests]]",
      ].join("\n"),
      "spec.md": [
        "## Requirements",
        "",
        "- the toolbar MUST persist forced flags",
        "- **FR-002**: System MUST [specific capability]",
        "",
        "## Out of Scope",
        "",
        "- cloud sync and team sharing",
      ].join("\n"),
      "t/a.test.ts": "// nothing tagged yet\n",
    });

  it("counts a placeholder and an informative atom out of coverage, and says so in both surfaces", () => {
    const doc = toJsonReport(analyze(specKitRepo()));
    expect(doc.excludedAtoms).toEqual({ placeholder: 1, informative: 1 });
    expect(doc.counts["placeholderAtoms"]).toBe(1);
    expect(doc.counts["informativeAtoms"]).toBe(1);
    // Only the one real requirement is owed a test.
    expect(doc.counts["uncovered"]).toBe(1);
  });

  it("emits no write-tests task for a claim it does not coverage-check", () => {
    const { tasks } = deriveTasks(analyze(specKitRepo()));
    const claimIds = tasks.flatMap((t) => ((t.payload as { claims?: Array<{ id: string }> }).claims ?? []).map((c) => c.id));
    // The one real requirement is queued; the placeholder and the Out of Scope statement are not.
    expect(claimIds).toEqual(["requirements.toolbar-must-persist-forced"]);
  });

  it("marks an informative claim as such in the listing, distinctly from tbd", () => {
    const listing = listClaims(analyze(specKitRepo()));
    const informative = listing.claims.find((c) => c.id.startsWith("out-of-scope."));
    expect(informative?.informative).toBe(true);
    expect(informative?.verdict).toBeNull(); // never reads as uncovered-awaiting-a-test
    const real = listing.claims.find((c) => c.id === "requirements.toolbar-must-persist-forced");
    expect(real?.informative).toBe(false);
    expect(real?.verdict).toBe("uncovered");
  });

  it("names the declared globs on a zero-file layer, so a wrong glob is visible in the report", () => {
    const d = repo({
      "tripact.yaml": [
        "schemaVersion: 1",
        "layers:",
        "  spec: { role: prescriptive, paths: ['spec.md'] }",
        "  tests: { role: verificatory, paths: ['test/**/*.spec.ts'] }",
        "edges: [[spec, tests]]",
      ].join("\n"),
      "spec.md": "## Requirements\n\n- the toolbar MUST persist forced flags\n",
      // Colocated, exactly where the directory-anchored glob above cannot see it.
      "libs/toolbar/toolbar.spec.ts": "// a real test, invisible to the declared glob\n",
    });
    const analysis = analyze(d);
    expect(analysis.zeroFileLayers).toEqual(["tests"]);
    const out = renderHuman(analysis, { long: true });
    expect(out).toContain("matched no files");
    expect(out).toContain("tests: test/**/*.spec.ts");
  });
});

// ---------------------------------------------------------------------------------------------
// §2.3 — the preset glob shape that made the trial's repo look testless
// ---------------------------------------------------------------------------------------------
describe("preset verificatory globs (§2.3)", () => {
  it("seeds colocated test globs, not only directory-anchored ones", () => {
    for (const [name, preset] of Object.entries(SPEC_SYSTEM_PRESETS)) {
      const verificatory = Object.values(preset.layers).filter((l) => l.role === "verificatory");
      if (verificatory.length === 0) continue;
      const globs = verificatory.flatMap((l) => l.paths);
      expect(globs, `${name} must see a colocated .spec.ts`).toContain("**/*.spec.ts");
      expect(globs, `${name} must see a colocated .test.ts`).toContain("**/*.test.ts");
    }
  });

  it("matches a colocated spec under any depth, which the directory-anchored globs could not", () => {
    const d = repo({
      "tripact.yaml": "schemaVersion: 1\nkind: spec-kit\n",
      "specs/001-toolbar/spec.md": "## Requirements\n\n- the toolbar MUST persist forced flags\n",
      "libs/ngx-dev-toolbar/src/tools/feature-flags.service.spec.ts": "// colocated, the Angular norm\n",
      // A nested dependency tree must never be collected, now that the globs walk the whole repo.
      "libs/ngx-dev-toolbar/node_modules/pkg/vendored.spec.ts": "// vendored\n",
    });
    const files = [...(analyze(d).layers.get("tests")?.files.keys() ?? [])];
    expect(files).toContain("libs/ngx-dev-toolbar/src/tools/feature-flags.service.spec.ts");
    expect(files.some((f) => f.includes("node_modules"))).toBe(false);
  });
});
