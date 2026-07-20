// vitest globalSetup: build the CLI exactly once for the whole run, then hand every test worker the
// absolute path to the built entrypoint. The e2e suite spawns the CLI many times, and paying tsx's
// per-call compile on every spawn blocks the worker for long enough to trip vitest's reporter-IPC
// timeout. A prebuilt dist/cli.js spawned with plain node runs in ~0.08s, keeping the worker
// responsive.
//
// globalSetup runs in the main process, separate from the forked workers. We plumb the path across
// the boundary two ways so a plain `process.env.TRIPACT_TEST_CLI` read inside a test file always
// works: (1) set it on the main process env (forks inherit it), and (2) `provide` it so the setup
// file (test/helpers/setup-env.ts) can re-assert it inside each worker via `inject`.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { GlobalSetupContext } from "vitest/node";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const distCli = path.join(root, "dist", "cli.js");

declare module "vitest" {
  interface ProvidedContext {
    tripactTestCli: string;
  }
}

export default function setup({ provide }: GlobalSetupContext): void {
  // `pnpm build` === `tsc`; dist/ is gitignored, so this is always a fresh emit.
  execFileSync("pnpm", ["build"], { cwd: root, stdio: "inherit" });
  if (!existsSync(distCli)) {
    throw new Error(`build did not produce ${distCli} — cannot run the suite against a missing dist`);
  }
  process.env.TRIPACT_TEST_CLI = distCli;
  provide("tripactTestCli", distCli);
}
