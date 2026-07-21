// Spec-system presets (UAC §2.3). A `kind:` in tripact.yaml names a known spec system; loadConfig
// expands it into concrete layers/edges/exclude so the whole config can be as small as
// `schemaVersion: 1` + `kind: spec-kit`. The SAME registry backs detection (the tripact-detect
// skill, and any harness `init`): a preset's `signature` globs are the fingerprint of that system
// on disk. Expansion is additive: any layer/edge/exclude the user spells out wins over the preset,
// so a preset is a floor to build on.

import { globSync } from "node:fs";
import path from "node:path";
import type { Config } from "./config.js";
import type { LayerRole } from "./types.js";

export interface PresetLayer {
  role: LayerRole;
  paths: string[];
  tagPattern?: string;
  sectionTagPattern?: string;
}

export interface SpecSystemPreset {
  /** The `kind:` value. */
  name: string;
  /** Display name of the spec system, e.g. "GitHub spec-kit". A table column, so it carries no detail. */
  label: string;
  /** What this preset declares, phrased for a documentation table cell. */
  declares: string;
  /** Globs whose presence on disk fingerprints this system (used by detection, never by expansion). */
  signature: string[];
  /** Layers the preset contributes, keyed by conventional layer name. */
  layers: Record<string, PresetLayer>;
  edges: Array<[string, string]>;
  /** Globs subtracted from every layer: archived/change-delta duplicates, framework scaffolding. */
  exclude: string[];
}

// Verificatory globs common enough to seed an empty tests layer for any system. Matching zero files
// is fine: it still satisfies the two-layer floor and yields the correct all-uncovered baseline
// (the tests layer is declared, just not yet tagged), exactly like a hand-authored empty second layer.
const COMMON_TEST_GLOBS = [
  "test/**/*.test.ts", "tests/**/*.test.ts", "test/**/*.spec.ts", "tests/**/*.spec.ts",
  "test/**/*.test.js", "tests/**/*.test.js", "test/**/*.spec.js", "tests/**/*.spec.js",
  "tests/**/*_test.py", "**/test_*.py", "**/*_test.go",
];

export const SPEC_SYSTEM_PRESETS: Record<string, SpecSystemPreset> = {
  // GitHub spec-kit: the product spec is `specs/<NNN-feature>/spec.md`. The `.specify/` tree is the
  // framework's own scaffolding (constitution + templates) and must NEVER be counted as the spec,
  // so it is excluded.
  "spec-kit": {
    name: "spec-kit",
    label: "GitHub spec-kit",
    declares: "prescriptive `specs/*/spec.md`; excludes the `.specify/` scaffolding so it never counts as the spec",
    signature: [".specify/**/*", "specs/*/spec.md"],
    layers: {
      spec: { role: "prescriptive", paths: ["specs/*/spec.md"] },
      tests: { role: "verificatory", paths: [...COMMON_TEST_GLOBS] },
    },
    edges: [["spec", "tests"]],
    exclude: [".specify/**"],
  },
  // OpenSpec: the live spec is `openspec/specs/**/spec.md`. Per-change deltas and the archive live
  // under `openspec/changes/**` and are duplicate/superseded copies, excluded so they never
  // double-count against the live spec.
  openspec: {
    name: "openspec",
    label: "OpenSpec",
    declares: "prescriptive `openspec/specs/**/spec.md`; excludes per-change deltas under `openspec/changes/`",
    signature: ["openspec/specs/**/spec.md", "openspec/project.md"],
    layers: {
      spec: { role: "prescriptive", paths: ["openspec/specs/**/spec.md"] },
      tests: { role: "verificatory", paths: [...COMMON_TEST_GLOBS] },
    },
    edges: [["spec", "tests"]],
    exclude: ["openspec/changes/**"],
  },
  // Kiro (AWS Kiro spec-driven flow): a flat spec triplet under `specs/` - `requirements.md`
  // (EARS acceptance criteria as numbered `1. THE … SHALL …` items), `design.md`, `tasks.md`. No
  // `.specify/` and no `specs/*/spec.md`, so it is distinct from spec-kit. The prescriptive layer is
  // the acceptance criteria in `requirements.md` (design/tasks are planning artefacts, not intent).
  kiro: {
    name: "kiro",
    label: "AWS Kiro",
    declares: "prescriptive `specs/requirements.md` (EARS numbered acceptance criteria)",
    signature: ["specs/requirements.md"],
    layers: {
      spec: { role: "prescriptive", paths: ["specs/requirements.md"] },
      tests: { role: "verificatory", paths: [...COMMON_TEST_GLOBS] },
    },
    edges: [["spec", "tests"]],
    exclude: [],
  },
  // Cursor spec-driven flow: feature specs live under `.cursor/specs/` as arbitrarily-named markdown
  // (`## Why / What / Constraints`, `### Must / Must Not` bullets). The fixed-name `_template.md`
  // (placeholder scaffolding) and `tasks.md` (the implementation plan, not intent) are excluded, the
  // same way the kiro preset keeps only `requirements.md`, leaving the variable-named feature specs.
  cursor: {
    name: "cursor",
    label: "Cursor spec-driven",
    declares: "prescriptive `.cursor/specs/**/*.md`; excludes `_template.md` and `tasks.md`",
    signature: [".cursor/specs/**/*.md"],
    layers: {
      spec: { role: "prescriptive", paths: [".cursor/specs/**/*.md"] },
      tests: { role: "verificatory", paths: [...COMMON_TEST_GLOBS] },
    },
    edges: [["spec", "tests"]],
    exclude: [".cursor/specs/**/_template.md", ".cursor/specs/**/tasks.md"],
  },
  // Cucumber / Gherkin: `features/**/*.feature`, parsed by the Gherkin parser (§3.5) rather than as
  // markdown. Unlike every other preset the prescriptive layer here is not markdown at all, so the
  // preset carries no exclude — a `.feature` file is a spec by construction, and the sibling
  // `step_definitions/` and `support/` trees are Ruby/JS code that the prescriptive glob cannot
  // match anyway. The test globs add Ruby, since Cucumber's largest install base is Rails and the
  // suite that verifies these scenarios is usually RSpec rather than the step definitions.
  cucumber: {
    name: "cucumber",
    label: "Cucumber / Gherkin",
    declares: "prescriptive `features/**/*.feature` (scenarios as claims), parsed by the Gherkin parser",
    signature: ["features/**/*.feature"],
    layers: {
      spec: { role: "prescriptive", paths: ["features/**/*.feature"] },
      tests: {
        role: "verificatory",
        paths: [...COMMON_TEST_GLOBS, "spec/**/*_spec.rb", "test/**/*_test.rb"],
      },
    },
    edges: [["spec", "tests"]],
    exclude: [],
  },
  // StrictDoc: requirements are `.sdoc` files (parsed by the SDOC parser, not markdown). A generic
  // preset can't know a repo's spec-vs-manual filename convention, so it declares all `.sdoc` as the
  // prescriptive layer; refine by hand (split a `manual` layer, add a docs/**/*.md descriptive layer)
  // as the repo warrants.
  strictdoc: {
    name: "strictdoc",
    label: "StrictDoc",
    declares: "all `.sdoc` files as prescriptive, parsed by the SDOC parser",
    signature: ["**/*.sdoc"],
    layers: {
      spec: { role: "prescriptive", paths: ["**/*.sdoc"] },
      tests: { role: "verificatory", paths: [...COMMON_TEST_GLOBS] },
    },
    edges: [["spec", "tests"]],
    exclude: [],
  },
};

export const SPEC_SYSTEM_NAMES = Object.keys(SPEC_SYSTEM_PRESETS);

/**
 * Expand a config's `kind:` preset into concrete layers/edges/exclude (UAC §2.3). Additive and
 * user-first: a preset layer is added only when the user has not declared a layer of that name;
 * preset edges apply only when the user declared none; preset excludes are unioned ahead of the
 * user's. A config without `kind`, or with an unknown `kind` (reported separately by loadConfig),
 * is returned unchanged.
 */
export function applyPreset(cfg: Config): Config {
  if (cfg.kind === undefined) return cfg;
  const preset = SPEC_SYSTEM_PRESETS[cfg.kind];
  if (!preset) return cfg; // unknown kind: loadConfig reports it; nothing to expand
  const layers = { ...cfg.layers };
  for (const [name, pl] of Object.entries(preset.layers)) {
    if (name in layers) continue; // user-declared layer wins
    layers[name] = {
      role: pl.role,
      paths: [...pl.paths],
      ...(pl.tagPattern !== undefined ? { tagPattern: pl.tagPattern } : {}),
      ...(pl.sectionTagPattern !== undefined ? { sectionTagPattern: pl.sectionTagPattern } : {}),
    };
  }
  const edges = cfg.edges.length ? cfg.edges : preset.edges.map((e) => [e[0], e[1]] as [string, string]);
  const exclude = [...preset.exclude, ...(cfg.exclude ?? [])];
  return { ...cfg, layers, edges, ...(exclude.length ? { exclude } : {}) };
}

/**
 * Every spec system whose signature globs match on disk (UAC §2.3), in registry order. Matching is by
 * file presence alone, never file contents. A repository matching more than one system is AMBIGUOUS;
 * this returns all of them so a caller (the tripact-detect skill, a harness `init`) can present the
 * candidates instead of picking one. Expansion itself never touches disk.
 */
export function detectSpecSystems(repoRoot: string): string[] {
  const anyMatch = (globs: string[]) =>
    globs.some((g) => globSync(g, { cwd: repoRoot }).some((f) => !String(f).split(path.sep).join("/").includes("node_modules")));
  return Object.entries(SPEC_SYSTEM_PRESETS)
    .filter(([, preset]) => anyMatch(preset.signature))
    .map(([name]) => name);
}

/**
 * The single unambiguous spec system for a repository (UAC §2.3), or null when zero or several
 * match, so an ambiguous layout is never auto-assigned a preset. Use `detectSpecSystems` when you
 * need the full candidate set to adjudicate an ambiguous repo.
 */
export function detectSpecSystem(repoRoot: string): string | null {
  const matches = detectSpecSystems(repoRoot);
  return matches.length === 1 ? (matches[0] as string) : null;
}

/**
 * The spec-system registry as a markdown table (UAC §18.4), the `presets-table` builtin's output.
 *
 * The README documented these five systems in four hand-maintained places, and a preset added to the
 * registry with tests reached none of them, so a shipped feature stayed invisible. Rendering the table
 * from the registry is what stops that recurring: adding a preset here updates the docs.
 *
 * Column widths are padded to the longest cell so the committed markdown reads as a table in source as
 * well as rendered. Rows follow registry declaration order, which is stable and deterministic.
 */
export function renderPresetsTable(): string {
  const headers = ["`kind:`", "Spec system", "What the preset declares"];
  const rows = Object.values(SPEC_SYSTEM_PRESETS).map((p) => [`\`${p.name}\``, p.label, p.declares]);
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] as string).length)));
  const line = (cells: string[]) => `| ${cells.map((c, i) => c.padEnd(widths[i] as number)).join(" | ")} |`;
  return [
    line(headers),
    `| ${widths.map((w) => "-".repeat(w)).join(" | ")} |`,
    ...rows.map(line),
  ].join("\n");
}
