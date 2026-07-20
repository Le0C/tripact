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
// from program.ts (enforced by test/kernel-boundary.test.ts).

import { spawnSync } from "node:child_process";
import type { Config } from "./config.js";

/** The builtin `cli-reference` generator name. Reserved here; implemented by the harness. */
export const CLI_REFERENCE = "cli-reference";

/** The builtin `hotlink-map` generator name (UAC §20.3). Reserved here; implemented by the harness. */
export const HOTLINK_MAP = "hotlink-map";

/**
 * Reserved builtin generator names. A `derived` entry naming one of these is rendered in-process
 * by a harness-registered function rather than run as a shell command. The kernel reserves the
 * name only; the implementation is injected (registerGenerator) so this module imports no harness
 * code. An output declaring a reserved generator that was never registered is a wiring error, so
 * generateContent throws rather than trying to exec the name as a shell command.
 */
export const RESERVED_BUILTINS: ReadonlySet<string> = new Set([CLI_REFERENCE, HOTLINK_MAP]);

/** Harness-injected implementations for reserved builtin generators, keyed by name. Called with the
 *  repo root so a generator that projects repo state (e.g. hotlink-map) can analyse it. */
const generatorRegistry = new Map<string, (root: string) => string>();

/**
 * Register a builtin generator implementation. Called by the harness at startup
 * (src/generators.ts). Only reserved names may be registered, keeping the builtin namespace
 * closed and deterministic; registering an unreserved name is a programming error.
 */
export function registerGenerator(name: string, render: (root: string) => string): void {
  if (!RESERVED_BUILTINS.has(name)) {
    throw new Error(`cannot register unknown builtin generator "${name}"`);
  }
  generatorRegistry.set(name, render);
}

export interface DerivedOutput {
  name: string;
  /** Repo-relative path the generated content is written to / compared against. */
  output: string;
  /** `cli-reference` or an arbitrary shell command string. */
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
 * Produce the content for one derived output. A reserved builtin → its registered in-process
 * renderer; any other generator → run it as a shell command in `root` and capture stdout. A
 * nonzero exit (or spawn failure) throws GenerateError (UAC §18.1: shell nonzero → error exit 2).
 * A reserved builtin with no registered implementation also throws, since it is a wiring error
 * rather than a shell command.
 */
export function generateContent(root: string, d: DerivedOutput): string {
  if (RESERVED_BUILTINS.has(d.generator)) {
    const render = generatorRegistry.get(d.generator);
    if (!render) {
      throw new GenerateError(
        `builtin generator "${d.generator}" for derived output "${d.name}" is not registered; ` +
          `the harness must register it before generation (see src/generators.ts)`,
      );
    }
    return render(root);
  }
  const r = spawnSync(d.generator, {
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
      `derived generator for "${d.name}" exited ${r.status}: ${d.generator}${detail ? `\n${detail}` : ""}`,
    );
  }
  return r.stdout ?? "";
}
