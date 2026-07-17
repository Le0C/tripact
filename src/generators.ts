// Builtin derived generators the kernel registers for itself (UAC §18.1).
//
// `derived.ts` reserves two builtin names but deliberately imports neither implementation, so the
// registry stays free of import cycles. This module is where the kernel fills in the one builtin it
// can render alone:
//
//   - `hotlink-map` (§20.3) derives purely from the kernel's own analysis of the tree, so the kernel
//     registers it here. Nothing about it is harness-specific.
//   - `cli-reference` renders a *harness's* own command tree, which the kernel cannot know, so the
//     name stays reserved and a driving harness injects the implementation via `registerGenerator`.
//     A tripact config naming it still fails with the "not registered" wiring error, by design.
//
// Registration is a side effect, so it is invoked from the binary surface (`cli.ts`) rather than the
// library barrel — importing `tripact` as a library must not mutate global state.

import { HOTLINK_MAP, registerGenerator } from "./derived.js";
import { analyze } from "./engine.js";
import { renderHotlinkMap } from "./hotlinks.js";

/**
 * Register every builtin generator the kernel implements. Idempotent: re-registering a name simply
 * overwrites it with the same renderer, so calling this more than once is harmless.
 *
 * The `hotlink-map` renderer re-analyses the tree, so it MUST pass `skipDerived` — otherwise the
 * freshness pass in `analyze()` would regenerate this very output and recurse forever.
 */
export function registerBuiltinGenerators(): void {
  registerGenerator(HOTLINK_MAP, (root) => renderHotlinkMap(analyze(root, { skipDerived: true }), root));
}
