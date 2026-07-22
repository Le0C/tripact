// Builtin derived generators the kernel registers for itself (UAC §18.1, §18.4).
//
// `derived.ts` reserves the builtin names but deliberately imports no implementation, so the registry
// stays free of import cycles. This module is where the kernel fills in the builtins it can render
// alone:
//
//   - `hotlink-map` (§20.3) derives from the kernel's own analysis of the tree.
//   - `presets-table` and `task-classes` (§18.4) derive from kernel constants: the spec-system
//     preset registry and the routable task classes.
//   - `cli-reference` renders a *harness's* own command tree, which the kernel cannot know, so the
//     name stays reserved and a driving harness injects the implementation via `registerGenerator`.
//     A tripact config naming it still fails with the "not registered" wiring error, by design.
//
// Registration is a side effect, so it is invoked from the binary surface (`cli.ts`) rather than the
// library barrel. Importing `tripact` as a library must not mutate global state.
//
// A foreign harness still needs these builtins — it drives `check`, which runs the freshness pass, so
// without them a config naming `builtin:presets-table` reports the wiring error where the region is
// in fact fresh. This module is therefore reachable on its own package subpath, `tripact/generators`,
// and NOT from the barrel: opting in stays one explicit import and call, and `import "tripact"` alone
// still registers nothing (kernel/harness boundary, guarded by test/kernel-boundary.test.ts).

import { HOTLINK_MAP, PRESETS_TABLE, registerGenerator, TASK_CLASSES } from "./derived.js";
import { analyze } from "./engine.js";
import { renderHotlinkMap } from "./hotlinks.js";
import { renderPresetsTable } from "./presets.js";
import { renderTaskClasses } from "./tasks.js";

/**
 * Register every builtin generator the kernel implements. Idempotent: re-registering a name simply
 * overwrites it with the same renderer, so calling this more than once is harmless.
 *
 * The `hotlink-map` renderer re-analyses the tree, so it MUST pass `skipDerived`. Otherwise the
 * freshness pass in `analyze()` would regenerate this very output and recurse forever.
 * `presets-table` reads a constant, so it needs neither the tree nor that guard.
 */
export function registerBuiltinGenerators(): void {
  registerGenerator(HOTLINK_MAP, (ctx) => renderHotlinkMap(analyze(ctx.root, { skipDerived: true }), ctx.root));
  registerGenerator(PRESETS_TABLE, () => renderPresetsTable());
  registerGenerator(TASK_CLASSES, () => renderTaskClasses());
}
