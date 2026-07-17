#!/usr/bin/env node
// CLI entrypoint. The command tree lives in program.ts (buildProgram).
// Exit convention (Cross-Cutting): 0 clean, 1 findings/drift, 2 usage or environment error.
//
// `exitOverride()` routes commander's own parse failures (unknown command/option, missing or
// excess arguments, invalid choice) through this catch so they honour the convention too: a usage
// error is exit 2, not commander's default 1. Help and version are clean displays, not errors, so
// they keep exit 0 — distinguished by the CommanderError's own exitCode (0 for those, non-zero for
// a real usage error). Runtime errors thrown by a command action reject with a plain Error and fall
// through to exit 2 (environment/usage), unchanged.
//
// Builtin derived generators (UAC §18.1) are registered at boot, from the binary surface rather than
// the library barrel — see generators.ts. The kernel implements `hotlink-map` (it renders from its
// own analysis); `cli-reference` needs the harness's own command tree, so it stays a harness concern
// and a tripact config declaring it surfaces a clear "not registered" GenerateError by design.
import { CommanderError } from "commander";
import { registerBuiltinGenerators } from "./generators.js";
import { buildProgram } from "./program.js";

registerBuiltinGenerators();

const program = buildProgram();
// exitOverride is per-command in commander, so a usage error raised while parsing a subcommand
// (an unknown option, a missing argument) is thrown by that subcommand — apply it to the root and
// every subcommand so all of them reject into the catch below rather than exiting 1 directly.
program.exitOverride();
for (const sub of program.commands) sub.exitOverride();

program
  .parseAsync()
  .catch((e: unknown) => {
    if (e instanceof CommanderError) {
      // help/version display (exitCode 0) is not an error; any other commander exit is a usage error.
      process.exit(e.exitCode === 0 ? 0 : 2);
    }
    console.error(`tripact: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(2);
  });
