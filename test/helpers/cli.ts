// Shared spawn helpers for the e2e suite. The CLI is resolved in exactly one place.
//
// Resolution order:
//   1. TRIPACT_TEST_CLI (set by test/helpers/global-setup.ts after a one-shot build) spawns the
//      prebuilt dist/cli.js with plain node (~0.08s/call). This is the path taken by `pnpm test`.
//   2. Fallback (env var absent) is tsx + src/cli.ts, for ad-hoc single-file runs
//      (`vitest run test/foo.test.ts`) where globalSetup did not run. Slower, but no build.
//
// A configured-but-missing dist is a hard error. Once the caller has asked for the built CLI a
// stale or absent build fails loudly, rather than dropping back to tsx behind their back.
//
// NOTE: this file lives under test/ but is intentionally not named *.test.ts, so it is not collected
// by vitest.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

let cached: { command: string; baseArgs: string[] } | undefined;

/** Resolve, once, the command + leading args used to invoke the tripact CLI. */
export function cliInvocation(): { command: string; baseArgs: string[] } {
  if (cached) return cached;
  const built = process.env.TRIPACT_TEST_CLI;
  if (built) {
    if (!existsSync(built)) {
      throw new Error(
        `TRIPACT_TEST_CLI points at ${built} but nothing is there. ` +
          `Run the build (vitest globalSetup does this) or unset the var to fall back to tsx.`,
      );
    }
    cached = { command: process.execPath, baseArgs: [built] };
  } else {
    cached = {
      command: path.join(root, "node_modules", ".bin", "tsx"),
      baseArgs: [path.join(root, "src", "cli.ts")],
    };
  }
  return cached;
}

export interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Spawn the tripact CLI synchronously in `cwd`. `env`, when given, replaces the child environment
 * exactly as a raw spawnSync would; omit it to inherit this process's env.
 */
export function runCli(args: string[], opts: { cwd: string; env?: NodeJS.ProcessEnv }): CliResult {
  const { command, baseArgs } = cliInvocation();
  const r = spawnSync(command, [...baseArgs, ...args], {
    cwd: opts.cwd,
    encoding: "utf8",
    ...(opts.env ? { env: opts.env } : {}),
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** git with a fixed throwaway identity, run in `cwd`; returns stdout. */
export function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], {
    cwd,
    encoding: "utf8",
  });
}
