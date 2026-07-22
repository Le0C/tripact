// Guards the kernel/harness import boundary that src/derived.ts and src/generators.ts describe.
//
// The kernel is everything reachable from the library barrel (src/index.ts). The harness is the
// binary surface: program.ts (the commander tree), cli.ts (the entry point), and generators.ts
// (which registers builtin generator implementations as a side effect).
//
// Two properties hold that boundary up, and both are asserted here because both are load-bearing
// and neither is visible at a call site:
//
//   1. No module reachable from the barrel statically imports a harness module. This is what lets
//      `derived.ts` reserve a builtin generator NAME while a harness injects its IMPLEMENTATION at
//      boot: the kernel names `cli-reference` without importing the commander program that renders
//      it. Break this and engine.ts drags program.ts into every consumer's bundle.
//   2. Importing the barrel registers nothing. Registration is a side effect invoked from cli.ts,
//      so `import "tripact"` must leave the generator registry untouched. Break this and importing
//      the library mutates global state.
//
// Type-only imports are erased before runtime and create no dependency, so they are permitted and
// skipped by the walk. There are none today; the allowance exists so a future shared interface does
// not have to break the rule to be declared.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");

/** The binary surface. A kernel module reaching any of these is the failure this file catches. */
const HARNESS_MODULES = ["program.ts", "cli.ts", "generators.ts"];

/**
 * Relative import specifiers in one source file, excluding type-only imports and exports.
 * `export * from "./x.js"` counts: a re-export is a runtime dependency like any other.
 */
function relativeImports(file: string): string[] {
  const src = readFileSync(file, "utf8");
  const specifiers: string[] = [];
  for (const line of src.split("\n")) {
    if (/^\s*(import|export)\s+type\s/.test(line)) continue;
    const m = line.match(/^\s*(?:import|export)\b[^"']*from\s*["']([^"']+)["']/) ?? line.match(/^\s*import\s*["']([^"']+)["']/);
    if (m?.[1]?.startsWith(".")) specifiers.push(m[1]);
  }
  return specifiers;
}

/** Walk static imports from `entry`, returning every reached src-relative path. */
function reachableFrom(entry: string): Set<string> {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const current = queue.pop() as string;
    const rel = path.relative(SRC, current);
    if (seen.has(rel)) continue;
    seen.add(rel);
    for (const spec of relativeImports(current)) {
      // Emitted ESM specifiers carry a .js extension that resolves to the .ts source here.
      const resolved = path.resolve(path.dirname(current), spec.replace(/\.js$/, ".ts"));
      queue.push(resolved);
    }
  }
  return seen;
}

describe("kernel/harness import boundary", () => {
  it("the library barrel reaches no harness module", () => {
    // Implements @specs:kernelharness-boundary.no-module-reachable-from
    const reached = reachableFrom(path.join(SRC, "index.ts"));
    const leaked = HARNESS_MODULES.filter((m) => reached.has(m));
    expect(leaked).toEqual([]);
  });

  it("engine.ts stays import-separable from program.ts", () => {
    // Called out by name in src/derived.ts: the freshness pass in engine.ts runs generators, and
    // the registry indirection is what keeps it from importing the commander program to do so.
    const reached = reachableFrom(path.join(SRC, "engine.ts"));
    expect(reached.has("program.ts")).toBe(false);
  });

  it("the walk actually traverses, so a passing result means something", () => {
    // Without this, a regex that silently matched nothing would make every assertion above vacuous.
    const reached = reachableFrom(path.join(SRC, "index.ts"));
    expect(reached.has("engine.ts")).toBe(true);
    expect(reached.has("parser.ts")).toBe(true);
    expect(reached.size).toBeGreaterThan(10);
  });

  it("the harness does import the kernel, so the separation has a direction", () => {
    const reached = reachableFrom(path.join(SRC, "cli.ts"));
    expect(reached.has("program.ts")).toBe(true);
    expect(reached.has("generators.ts")).toBe(true);
    expect(reached.has("engine.ts")).toBe(true);
  });

  it("importing the barrel registers no builtin generator", async () => {
    // Implements @specs:kernelharness-boundary.importing-library-registers-no
    const { generateContent, HOTLINK_MAP, GenerateError } = await import("../src/index.js");
    // hotlink-map is reserved by the kernel and registered by generators.ts, which only cli.ts
    // pulls in. Reaching it through the barrel alone must report the wiring error rather than render.
    expect(() =>
      generateContent(process.cwd(), { name: "probe", output: "probe.md", generator: HOTLINK_MAP }),
    ).toThrow(GenerateError);
  });

  // Implements @specs:kernelharness-boundary.kernels-own-builtin-registration
  //
  // Runs LAST on purpose: the generator registry is module-global, so opting in here would make the
  // "barrel registers nothing" test above pass vacuously if it ran after this one.
  it("exposes the kernel's own builtin registration on a subpath the barrel does not reach", async () => {
    // Declared as a package subpath, so a harness opts in without reaching past the package surface.
    const pkg = JSON.parse(readFileSync(path.join(SRC, "..", "package.json"), "utf8")) as {
      exports: Record<string, { default?: string; types?: string }>;
    };
    expect(pkg.exports["./generators"]?.default).toBe("./dist/generators.js");
    expect(pkg.exports["./generators"]?.types).toBe("./dist/generators.d.ts");
    // Declaring it must not have wired it into the barrel — that is what keeps the opt-in explicit.
    expect(reachableFrom(path.join(SRC, "index.ts")).has("generators.ts")).toBe(false);

    // One import and one call is the whole opt-in, after which a kernel builtin renders in-process
    // where the bare barrel (asserted above) still reports the wiring error.
    const { registerBuiltinGenerators } = await import("../src/generators.js");
    const { generateContent, PRESETS_TABLE } = await import("../src/index.js");
    registerBuiltinGenerators();
    const table = generateContent(process.cwd(), { name: "probe", output: "probe.md", generator: PRESETS_TABLE });
    expect(table).toContain("| `kind:`");
  });
});
