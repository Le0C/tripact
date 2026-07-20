// Spec-system presets: `kind` expansion + detection. UAC §2.3.
// @specs:spec-system-presets.config-accepts-optional-top-level
// @specs:spec-system-presets.preset-expansion-user-first-layer
// @specs:spec-system-presets.preset-expansion-runs-before
// @specs:spec-system-presets.unknown-kind-fails-validation
// @specs:spec-system-presets.same-preset-registry-backs
// @specs:spec-system-presets.detection-returns-every-spec
// @specs:spec-system-presets.repository-auto-assigned-single-kind
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { detectSpecSystem, detectSpecSystems, SPEC_SYSTEM_PRESETS } from "../src/presets.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function repo(files: Record<string, string>): string {
  const d = mkdtempSync(path.join(tmpdir(), "tri-preset-"));
  dirs.push(d);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(d, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return d;
}

describe("kind expansion", () => {
  it("expands a kind-only config into the preset's layers, edges, and excludes", () => {
    const d = repo({ "tripact.yaml": "schemaVersion: 1\nkind: spec-kit\n" });
    const cfg = loadConfig(d);
    expect(cfg.layers.spec?.role).toBe("prescriptive");
    expect(cfg.layers.spec?.paths).toEqual(["specs/*/spec.md"]);
    expect(cfg.layers.tests?.role).toBe("verificatory");
    expect(cfg.edges).toEqual([["spec", "tests"]]);
    expect(cfg.exclude).toContain(".specify/**"); // scaffolding excluded, not read as the spec
  });

  it("clears the two-layer floor for a kind-only config (expansion before validation)", () => {
    const d = repo({ "tripact.yaml": "schemaVersion: 1\nkind: openspec\n" });
    // Would otherwise throw "at least 2 layers are required"; the preset supplies them first.
    const cfg = loadConfig(d);
    expect(Object.keys(cfg.layers).length).toBeGreaterThanOrEqual(2);
    expect(cfg.exclude).toContain("openspec/changes/**"); // change deltas de-duplicated
  });

  it("is user-first: an explicitly declared layer overrides the preset, presets fill the rest", () => {
    const d = repo({
      "tripact.yaml": [
        "schemaVersion: 1",
        "kind: spec-kit",
        "layers:",
        "  spec:",
        "    role: prescriptive",
        "    paths: [my/custom/spec.md]",
        "",
      ].join("\n"),
    });
    const cfg = loadConfig(d);
    expect(cfg.layers.spec?.paths).toEqual(["my/custom/spec.md"]); // user's layer kept
    expect(cfg.layers.tests).toBeDefined(); // preset still supplies the omitted tests layer
  });

  it("rejects an unknown kind with a message naming the accepted systems", () => {
    const d = repo({ "tripact.yaml": "schemaVersion: 1\nkind: bogus\n" });
    expect(() => loadConfig(d)).toThrow(/unknown spec system "bogus"/);
    expect(() => loadConfig(d)).toThrow(/spec-kit/);
  });
});

describe("detectSpecSystem", () => {
  it("fingerprints spec-kit by .specify/ and specs/*/spec.md", () => {
    const d = repo({ ".specify/memory/constitution.md": "x", "specs/001-x/spec.md": "# s" });
    expect(detectSpecSystem(d)).toBe("spec-kit");
  });

  it("fingerprints openspec by openspec/specs/**/spec.md", () => {
    const d = repo({ "openspec/specs/auth/spec.md": "# s", "openspec/project.md": "p" });
    expect(detectSpecSystem(d)).toBe("openspec");
  });

  it("fingerprints strictdoc by the presence of .sdoc files", () => {
    const d = repo({ "docs/reqs.sdoc": "[DOCUMENT]\nTITLE: x\n" });
    expect(detectSpecSystem(d)).toBe("strictdoc");
  });

  it("returns null when no spec system signature is present", () => {
    const d = repo({ "README.md": "# hi" });
    expect(detectSpecSystem(d)).toBeNull();
  });

  it("detectSpecSystems returns EVERY matching system, not only the first (ambiguous repo)", () => {
    // .specify + specs/001-x/spec.md → spec-kit; **/*.sdoc → strictdoc. Two systems present.
    const d = repo({ ".specify/x.md": "s", "specs/001-x/spec.md": "# s", "docs/reqs.sdoc": "[DOCUMENT]\n" });
    expect(detectSpecSystems(d).sort()).toEqual(["spec-kit", "strictdoc"]);
  });

  it("detectSpecSystem returns a kind only when exactly one system matches, else null (forked, never guessed)", () => {
    const one = repo({ ".cursor/specs/f.md": "# f" });
    expect(detectSpecSystem(one)).toBe("cursor"); // exactly one → assigned

    const ambiguous = repo({ "specs/requirements.md": "# r", "notes.sdoc": "[DOCUMENT]\n" }); // kiro + strictdoc
    expect(detectSpecSystems(ambiguous).sort()).toEqual(["kiro", "strictdoc"]);
    expect(detectSpecSystem(ambiguous)).toBeNull(); // several match → not auto-assigned

    expect(detectSpecSystem(repo({ "README.md": "# x" }))).toBeNull(); // none → null
  });

  it("fingerprints kiro by a flat specs/requirements.md (no .specify, no specs/*/spec.md)", () => {
    const d = repo({ "specs/requirements.md": "# Requirements", "specs/design.md": "# Design" });
    expect(detectSpecSystem(d)).toBe("kiro");
  });

  it("does not confuse kiro with spec-kit (spec-kit's specs/*/spec.md + .specify win)", () => {
    const speckit = repo({ ".specify/x.md": "s", "specs/001-x/spec.md": "# s" });
    expect(detectSpecSystem(speckit)).toBe("spec-kit"); // nested spec.md + .specify, not flat requirements.md
  });

  it("fingerprints cursor by feature specs under .cursor/specs/", () => {
    const d = repo({ ".cursor/specs/my-feature.md": "# Feature", ".cursor/specs/_template.md": "# T" });
    expect(detectSpecSystem(d)).toBe("cursor");
  });

  it("only advertises presets that are actually registered", () => {
    expect(Object.keys(SPEC_SYSTEM_PRESETS).sort()).toEqual(["cursor", "kiro", "openspec", "spec-kit", "strictdoc"]);
  });
});

describe("cursor preset expansion", () => {
  it("expands kind: cursor into a .cursor/specs prescriptive layer, excluding template + tasks", () => {
    const d = repo({ "tripact.yaml": "schemaVersion: 1\nkind: cursor\n" });
    const cfg = loadConfig(d);
    expect(cfg.layers.spec?.role).toBe("prescriptive");
    expect(cfg.layers.spec?.paths).toEqual([".cursor/specs/**/*.md"]);
    expect(cfg.exclude).toContain(".cursor/specs/**/_template.md");
    expect(cfg.exclude).toContain(".cursor/specs/**/tasks.md");
    expect(cfg.edges).toEqual([["spec", "tests"]]);
  });
});

describe("kiro preset expansion", () => {
  it("expands kind: kiro into a prescriptive specs/requirements.md layer", () => {
    const d = repo({ "tripact.yaml": "schemaVersion: 1\nkind: kiro\n" });
    const cfg = loadConfig(d);
    expect(cfg.layers.spec?.role).toBe("prescriptive");
    expect(cfg.layers.spec?.paths).toEqual(["specs/requirements.md"]);
    expect(cfg.layers.tests?.role).toBe("verificatory");
    expect(cfg.edges).toEqual([["spec", "tests"]]);
  });
});
