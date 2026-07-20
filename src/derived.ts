// Derived outputs (UAC §18): deterministically regenerable artefacts declared in
// tripact.yaml under `derived`. Two generator kinds: builtin generators (reserved names
// rendered in-process, with no spawning and byte-identical output across runs) and arbitrary
// shell commands (stdout captured as the file content). Determinism is the contract: the same
// code + config always produce byte-identical output.
//
// Kernel/harness boundary: this module is kernel.
// Builtin generators reserve a NAME here (a deterministic fact) but their IMPLEMENTATION is
// injected by the harness at boot via registerGenerator(), so the kernel never imports the
// CLI. `cli-reference`, for instance, needs the full commander program to render, which is a
// harness capability; keeping its impl out of this file lets engine.ts stay import-separable
// from program.ts (UAC Cross-Cutting: Kernel/harness boundary, enforced by
// test/kernel-boundary.test.ts).

import { spawnSync } from "node:child_process";
import type { Config } from "./config.js";

/** The builtin `cli-reference` generator name. Reserved here; implemented by the harness. */
export const CLI_REFERENCE = "cli-reference";

/** The builtin `hotlink-map` generator name (UAC §20.3). Reserved here; implemented by the kernel. */
export const HOTLINK_MAP = "hotlink-map";

/** The builtin `presets-table` generator name (UAC §18.4). Renders the spec-system preset registry. */
export const PRESETS_TABLE = "presets-table";

/** The builtin `task-classes` generator name (UAC §18.4). Renders the routable task classes. */
export const TASK_CLASSES = "task-classes";

/**
 * Reserved builtin generator names: the closed set whose meaning is the same under every harness. A
 * generator naming one of these renders in-process rather than running as a shell command. The kernel
 * reserves the name; an implementation is registered separately (registerGenerator), which is what
 * lets `cli-reference` name a renderer that needs the commander program without this module importing
 * it. A reserved name that was never registered is a wiring error, so generateContent throws rather
 * than trying to exec the name as a shell command.
 */
export const RESERVED_BUILTINS: ReadonlySet<string> = new Set([CLI_REFERENCE, HOTLINK_MAP, PRESETS_TABLE, TASK_CLASSES]);

/** What a generator is handed when it renders (UAC §18.4). `file` and `line` are present only when
 *  the generator is filling a block region, and absent for a whole-file derived output. */
export interface GeneratorContext {
  root: string;
  name: string;
  file?: string;
  line?: number;
}

export type GeneratorRender = (ctx: GeneratorContext) => string;

/** Implementations of reserved builtin names. Closed: only RESERVED_BUILTINS may be registered. */
const builtinRegistry = new Map<string, GeneratorRender>();

/** Implementations a driving harness contributes. Open, except that it may not shadow a builtin. */
const harnessRegistry = new Map<string, GeneratorRender>();

/** The `builtin:` / `harness:` prefixes that select a registry instead of the shell (UAC §18.4). */
const BUILTIN_PREFIX = "builtin:";
const HARNESS_PREFIX = "harness:";

/**
 * Register a builtin generator implementation, called at startup by whoever owns the name
 * (src/generators.ts for the kernel's own, a harness for `cli-reference`). Only reserved names may be
 * registered, which keeps the builtin namespace closed and its meaning identical everywhere.
 */
export function registerGenerator(name: string, render: GeneratorRender): void {
  if (!RESERVED_BUILTINS.has(name)) {
    throw new Error(`cannot register unknown builtin generator "${name}"`);
  }
  builtinRegistry.set(name, render);
}

/**
 * Register a generator a driving harness offers to its users, referenced as `harness:<name>`. The
 * namespace is open so a harness can ship whatever its repos need, with one exception: a name a
 * kernel builtin already holds is refused, so no harness can change what `presets-table` means in
 * someone else's config.
 */
export function registerHarnessGenerator(name: string, render: GeneratorRender): void {
  if (RESERVED_BUILTINS.has(name)) {
    throw new Error(`cannot register harness generator "${name}": the name is a reserved kernel builtin`);
  }
  harnessRegistry.set(name, render);
}

/**
 * How a generator string resolves (UAC §18.4). An explicit prefix selects a registry; anything else
 * is a shell command. The prefixes exist so that a harness registering a name can never capture a
 * config whose generator was a same-named shell command: `make` stays the build tool.
 *
 * The two bare reserved names predate the prefixes and still resolve, so a config written against
 * the earlier shape keeps working.
 */
export function resolveGenerator(generator: string): { kind: "builtin" | "harness" | "shell"; name: string } {
  if (generator.startsWith(BUILTIN_PREFIX)) return { kind: "builtin", name: generator.slice(BUILTIN_PREFIX.length) };
  if (generator.startsWith(HARNESS_PREFIX)) return { kind: "harness", name: generator.slice(HARNESS_PREFIX.length) };
  if (RESERVED_BUILTINS.has(generator)) return { kind: "builtin", name: generator };
  return { kind: "shell", name: generator };
}

export interface DerivedOutput {
  name: string;
  /** Repo-relative path the generated content is written to / compared against. */
  output: string;
  /** `builtin:<name>`, `harness:<name>`, a bare reserved builtin, or a shell command. */
  generator: string;
}

/** A generator that failed at runtime (nonzero shell exit). CLI maps this to exit 2. */
export class GenerateError extends Error {}

/** Declared derived outputs, sorted by name for deterministic ordering (UAC §18.1). */
export function deriveOutputs(config: Config): DerivedOutput[] {
  return Object.entries(config.derived ?? {})
    .map(([name, d]) => ({ name, output: d.output, generator: d.generator }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * Produce the content for one derived output or block region. The generator string resolves through
 * `resolveGenerator`: a builtin or harness name renders in-process and spawns nothing, and anything
 * else runs as a shell command in `root` with its stdout captured. A nonzero exit or a spawn failure
 * throws GenerateError (UAC §18.1: shell nonzero → error exit 2), as does a builtin or harness name
 * with no registered implementation, which is a wiring error rather than a command to try.
 *
 * `where` carries the block region's file and line when one is being filled, so a generator can tell
 * which region it is rendering into (UAC §18.4).
 */
export function generateContent(root: string, d: DerivedOutput, where?: { file: string; line: number }): string {
  const resolved = resolveGenerator(d.generator);
  if (resolved.kind !== "shell") {
    const registry = resolved.kind === "builtin" ? builtinRegistry : harnessRegistry;
    const render = registry.get(resolved.name);
    if (!render) {
      throw new GenerateError(
        `${resolved.kind} generator "${resolved.name}" for "${d.name}" is not registered; ` +
          `it must be registered before generation (see src/generators.ts)`,
      );
    }
    return render({ root, name: d.name, ...(where ? { file: where.file, line: where.line } : {}) });
  }
  const r = spawnSync(resolved.name, {
    cwd: root,
    shell: true,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.error) {
    throw new GenerateError(`derived generator for "${d.name}" failed to start: ${r.error.message}`);
  }
  if (r.status !== 0) {
    const detail = (r.stderr ?? "").trim();
    throw new GenerateError(
      `derived generator for "${d.name}" exited ${r.status}: ${resolved.name}${detail ? `\n${detail}` : ""}`,
    );
  }
  return r.stdout ?? "";
}
