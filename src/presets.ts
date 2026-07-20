// Spec-system presets (UAC §2.3). A `kind:` in tripact.yaml names a known spec system; loadConfig
// expands it into concrete layers/edges/exclude so the whole config can be as small as
// `schemaVersion: 1` + `kind: spec-kit`. The SAME registry backs detection (the tripact-detect
// skill, and any harness `init`): a preset's `signature` globs are the fingerprint of that system
// on disk. Expansion is additive and non-destructive — any layer/edge/exclude the user spells out
// wins over the preset, so a preset is a floor to build on, never an override.

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
  description: string;
  /** Globs whose presence on disk fingerprints this system (used by detection, never by expansion). */
  signature: string[];
  /** Layers the preset contributes, keyed by conventional layer name. */
  layers: Record<string, PresetLayer>;
  edges: Array<[string, string]>;
  /** Globs subtracted from every layer — archived/change-delta duplicates, framework scaffolding. */
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
  // framework's own scaffolding (constitution + templates) and must NEVER be counted as the spec —
  // so it is excluded, fixing the mis-detection where `.specify/**/*.md` was read as the spec.
  "spec-kit": {
    name: "spec-kit",
    description: "GitHub spec-kit — product spec at specs/<feature>/spec.md, scaffolding under .specify/",
    signature: [".specify/**/*", "specs/*/spec.md"],
    layers: {
      spec: { role: "prescriptive", paths: ["specs/*/spec.md"] },
      tests: { role: "verificatory", paths: [...COMMON_TEST_GLOBS] },
    },
    edges: [["spec", "tests"]],
    exclude: [".specify/**"],
  },
  // OpenSpec: the live spec is `openspec/specs/**/spec.md`. Per-change deltas and the archive live
  // under `openspec/changes/**` and are duplicate/superseded copies — excluded so they never
  // double-count against the live spec.
  openspec: {
    name: "openspec",
    description: "OpenSpec — live spec at openspec/specs/**/spec.md; per-change deltas under openspec/changes/ excluded",
    signature: ["openspec/specs/**/spec.md", "openspec/project.md"],
    layers: {
      spec: { role: "prescriptive", paths: ["openspec/specs/**/spec.md"] },
      tests: { role: "verificatory", paths: [...COMMON_TEST_GLOBS] },
    },
    edges: [["spec", "tests"]],
    exclude: ["openspec/changes/**"],
  },
  // Kiro (AWS Kiro spec-driven flow): a flat spec triplet under `specs/` — `requirements.md`
  // (EARS acceptance criteria as numbered `1. THE … SHALL …` items), `design.md`, `tasks.md`. No
  // `.specify/` and no `specs/*/spec.md`, so it is distinct from spec-kit. The prescriptive layer is
  // the acceptance criteria in `requirements.md` (design/tasks are planning artefacts, not intent).
  kiro: {
    name: "kiro",
    description: "Kiro — flat specs/requirements.md (EARS numbered acceptance criteria), design.md, tasks.md",
    signature: ["specs/requirements.md"],
    layers: {
      spec: { role: "prescriptive", paths: ["specs/requirements.md"] },
      tests: { role: "verificatory", paths: [...COMMON_TEST_GLOBS] },
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
    description: "StrictDoc — requirements in .sdoc files (SDOC parser), all .sdoc declared prescriptive",
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
  if (!preset) return cfg; // unknown kind — loadConfig reports it; nothing to expand
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
 * Fingerprint the repo against every known spec system (UAC §2.3): return the `kind` whose signature
 * globs match on disk, or null. Order is registry order; the first match wins. Intended for detection
 * surfaces (the tripact-detect skill, harness `init`) — expansion itself never touches disk.
 */
export function detectSpecSystem(repoRoot: string): string | null {
  const anyMatch = (globs: string[]) =>
    globs.some((g) => globSync(g, { cwd: repoRoot }).some((f) => !String(f).split(path.sep).join("/").includes("node_modules")));
  for (const [name, preset] of Object.entries(SPEC_SYSTEM_PRESETS)) {
    if (anyMatch(preset.signature)) return name;
  }
  return null;
}
