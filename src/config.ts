// tripact.yaml loading + validation. UAC §2.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

export const CONFIG_FILENAME = "tripact.yaml";

// Effort routing (UAC §16.1). Task classes are the five task kinds (src/tasks.ts),
// `adjudicate` for escalation questions, plus the derive-* bootstrap kinds (§15)
// accepted as forward-compatible strings.
export const EFFORT_TIERS = ["judgment", "planning", "implementation", "mechanical"] as const;
export type EffortTier = (typeof EFFORT_TIERS)[number];

// Runner templates (UAC §17.2) are keyed by effort tier or the literal "default",
// and interpolate exactly these placeholders — validated all-at-once in loadConfig.
export const RUNNER_KEYS = [...EFFORT_TIERS, "default"] as const;
export const RUNNER_PLACEHOLDERS = ["promptFile", "model", "cwd"] as const;

export const KNOWN_TASK_CLASSES = [
  "write-tests",
  "reconcile-stale",
  "fix-orphan-tag",
  "cover-section",
  "reconcile-layers",
  "adjudicate",
  "derive-prescriptive",
  "derive-descriptive",
  "derive-verificatory",
  "regenerate-derived",
] as const;

export const LayerSchema = z.object({
  role: z.enum(["prescriptive", "descriptive", "verificatory"]),
  paths: z.array(z.string()).min(1),
  conventions: z.string().optional(),
  tagPattern: z.string().optional(),
  sectionTagPattern: z.string().optional(),
});

// Accept policy (UAC §2.1, §8.3, §16.2, §17.2): whether agents may baseline. `policy`
// is typed loosely here so an unknown value reports all-at-once in loadConfig alongside
// every other config problem, rather than short-circuiting safeParse.
export const ACCEPT_POLICIES = ["human", "agents"] as const;
export type AcceptPolicy = (typeof ACCEPT_POLICIES)[number];

export const ConfigSchema = z.object({
  schemaVersion: z.literal(1),
  layers: z.record(z.string(), LayerSchema),
  edges: z.array(z.tuple([z.string(), z.string()])),
  pathMap: z.record(z.string(), z.array(z.string())).optional(),
  // accept.policy validated against ACCEPT_POLICIES in loadConfig (all-at-once, §2.2)
  accept: z.object({ policy: z.string() }).optional(),
  // values validated against EFFORT_TIERS / KNOWN_TASK_CLASSES in loadConfig so that
  // routing/models problems report all-at-once alongside every other config problem
  routing: z.record(z.string(), z.string()).optional(),
  models: z.record(z.string(), z.string()).optional(),
  // commands.test / runners.<tier|default> validated in loadConfig so §17.2 problems
  // report all-at-once alongside every other config problem, same as routing/models
  commands: z.record(z.string(), z.string()).optional(),
  runners: z.record(z.string(), z.string()).optional(),
  // derived outputs (UAC §18.1): name → { output path, generator }. `output`/`generator`
  // non-emptiness validated in loadConfig so §18 problems report all-at-once too.
  derived: z.record(z.string(), z.object({ output: z.string(), generator: z.string() })).optional(),
});

export type LayerConfig = z.infer<typeof LayerSchema>;
export type Config = z.infer<typeof ConfigSchema>;

/** The configured accept policy (UAC §2.1); `human` (the default) unless `agents` is set. */
export function acceptPolicy(config: Config): AcceptPolicy {
  return config.accept?.policy === "agents" ? "agents" : "human";
}

/** Advisory dispatch hints for one task class (UAC §16.1); null when the config binds none. */
export function hintsFor(config: Config, taskClass: string): { effort: EffortTier; model?: string } | null {
  const tier = config.routing?.[taskClass];
  if (tier === undefined) return null;
  const model = config.models?.[tier];
  return { effort: tier as EffortTier, ...(model !== undefined ? { model } : {}) };
}

export class ConfigError extends Error {
  constructor(public readonly problems: string[]) {
    super(`invalid ${CONFIG_FILENAME}:\n` + problems.map((p) => `  - ${p}`).join("\n"));
  }
}

export const DEFAULT_TAG_PATTERN = "@specs:([a-z0-9.-]+)";
export const DEFAULT_SECTION_TAG_PATTERN = "@manual:([a-z0-9.-]+)";

/** Reports ALL validation problems at once (UAC §2.2). */
export function loadConfig(repoRoot: string): Config {
  const p = path.join(repoRoot, CONFIG_FILENAME);
  if (!existsSync(p)) {
    throw new ConfigError([`${CONFIG_FILENAME} not found — author one (see the tripact README) or emit the scaffolding skill with \`tripact skills\``]);
  }
  let doc: unknown;
  try {
    doc = parseYaml(readFileSync(p, "utf8"));
  } catch (e) {
    throw new ConfigError([`YAML parse error: ${(e as Error).message}`]);
  }
  const parsed = ConfigSchema.safeParse(doc);
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
    );
  }
  const cfg = parsed.data;
  const problems: string[] = [];
  const layerNames = Object.keys(cfg.layers);
  if (layerNames.length < 2) {
    problems.push(`layers: at least 2 layers are required, found ${layerNames.length} (accepted roles: prescriptive, descriptive, verificatory)`);
  }
  for (const [i, [a, b]] of cfg.edges.entries()) {
    for (const name of [a, b]) {
      if (!(name in cfg.layers)) {
        problems.push(`edges[${i}]: references undeclared layer "${name}" (declared: ${layerNames.join(", ")})`);
      }
    }
  }
  for (const [name, layer] of Object.entries(cfg.layers)) {
    for (const pat of [layer.tagPattern, layer.sectionTagPattern]) {
      if (pat !== undefined) {
        try {
          new RegExp(pat);
        } catch (e) {
          problems.push(`layers.${name}: invalid pattern ${JSON.stringify(pat)} — ${(e as Error).message}`);
        }
      }
    }
    for (const g of layer.paths) {
      if (g.trim() === "") problems.push(`layers.${name}.paths: empty glob`);
    }
  }
  const tiers: readonly string[] = EFFORT_TIERS;
  const classes: readonly string[] = KNOWN_TASK_CLASSES;
  for (const [cls, tier] of Object.entries(cfg.routing ?? {})) {
    if (!classes.includes(cls)) {
      problems.push(`routing: unknown task class "${cls}" (known: ${classes.join(", ")})`);
    }
    if (!tiers.includes(tier)) {
      problems.push(`routing.${cls}: unknown effort tier "${tier}" (tiers: ${tiers.join(", ")})`);
    }
  }
  for (const [tier, model] of Object.entries(cfg.models ?? {})) {
    if (!tiers.includes(tier)) {
      problems.push(`models: unknown effort tier "${tier}" (tiers: ${tiers.join(", ")})`);
    }
    if (model.trim() === "") {
      problems.push(`models.${tier}: empty model identifier`);
    }
  }
  // accept block (UAC §2.1): policy, if present, must be `human` or `agents`
  const acceptPolicies: readonly string[] = ACCEPT_POLICIES;
  if (cfg.accept !== undefined && !acceptPolicies.includes(cfg.accept.policy)) {
    problems.push(`accept.policy: unknown value "${cfg.accept.policy}" (accepted: ${acceptPolicies.join(", ")})`);
  }
  // commands map (UAC §17.2): the `test` entry, if present, must be a non-empty string
  if (cfg.commands?.test !== undefined && cfg.commands.test.trim() === "") {
    problems.push(`commands.test: empty validation command`);
  }
  // runners map (UAC §17.2): keys are effort tiers or "default"; templates are non-empty
  // and interpolate only known placeholders
  const runnerKeys: readonly string[] = RUNNER_KEYS;
  const placeholders: readonly string[] = RUNNER_PLACEHOLDERS;
  for (const [key, template] of Object.entries(cfg.runners ?? {})) {
    if (!runnerKeys.includes(key)) {
      problems.push(`runners: unknown key "${key}" (accepted: effort tier or "default" — ${runnerKeys.join(", ")})`);
    }
    if (template.trim() === "") {
      problems.push(`runners.${key}: empty command template`);
    }
    for (const m of template.matchAll(/\{([a-zA-Z0-9_]+)\}/g)) {
      const ph = m[1] ?? "";
      if (!placeholders.includes(ph)) {
        problems.push(
          `runners.${key}: unknown placeholder "{${ph}}" (known: ${placeholders.map((p) => `{${p}}`).join(", ")})`,
        );
      }
    }
  }
  // derived map (UAC §18.1): each entry needs a non-empty output path and a non-empty
  // generator (the builtin `cli-reference` or an arbitrary shell command string)
  for (const [name, d] of Object.entries(cfg.derived ?? {})) {
    if (d.output.trim() === "") problems.push(`derived.${name}.output: empty output path`);
    if (d.generator.trim() === "") {
      problems.push(`derived.${name}.generator: empty generator (use "cli-reference" or a shell command)`);
    }
  }
  if (problems.length) throw new ConfigError(problems);
  return cfg;
}
