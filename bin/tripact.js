#!/usr/bin/env node
// Dev launcher: runs the CLI from TypeScript source via the repo-local tsx, so the `tripact`
// command always reflects the current source with no build step. At publish time the package bin
// switches to dist/cli.js.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tsx = path.join(root, "node_modules", ".bin", "tsx");
const result = spawnSync(tsx, [path.join(root, "src", "cli.ts"), ...process.argv.slice(2)], {
  stdio: "inherit",
  cwd: process.cwd(),
});
process.exit(result.status ?? 1);
