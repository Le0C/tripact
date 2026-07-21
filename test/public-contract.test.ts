// Pins tripact's public read contract (see src/contract.ts) against its own live CLI output.
// src/contract.ts is the single source of truth for the schema versions and the guaranteed
// top-level fields of each surface; this test runs each CLI `--json` command in a scratch repo and
// asserts the payload matches what the contract declares:
//
//   - schemaVersion === the declared constant, and
//   - the set of top-level keys === the declared `fields`.
//
// That makes any shape drift a failing build: add or remove a top-level field and this test breaks
// until the contract manifest is updated too, so a change of payload shape has to be a deliberate
// version decision.
import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { PUBLIC_CONTRACT } from "../src/contract.js";
import { runCli } from "./helpers/cli.js";
import { fullRepo } from "./helpers/fixture.js";

const scratch: string[] = [];
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});

/** The live JSON document for one contract surface, from its first CLI command or its sidecar file. */
function liveDocument(repo: string, surface: (typeof PUBLIC_CONTRACT)[number]): unknown {
  if (surface.cli.length > 0) {
    const args = surface.cli[0]! as string[];
    const r = runCli(args, { cwd: repo });
    try {
      return JSON.parse(r.stdout);
    } catch {
      throw new Error(`tripact ${args.join(" ")} did not print JSON (status ${r.status})\n${r.stderr}`);
    }
  }
  // No CLI command (escalations): the document `check` writes to .tripact/escalations.json.
  return JSON.parse(readFileSync(path.join(repo, ".tripact", "escalations.json"), "utf8"));
}

describe("tripact public contract", () => {
  const repo = fullRepo("tripact-contract-");
  scratch.push(repo);

  // @specs:output.check---json-emits-single
  for (const surface of PUBLIC_CONTRACT) {
    it(`${surface.key}: payload matches the declared schema version and fields`, () => {
      const doc = liveDocument(repo, surface) as Record<string, unknown>;

      expect(doc.schemaVersion, `${surface.key} schemaVersion`).toBe(surface.schemaVersion);

      const keys = Object.keys(doc).sort();
      expect(keys, `${surface.key} top-level fields drifted from src/contract.ts — update the contract deliberately`).toEqual(
        [...surface.fields].sort(),
      );
    });
  }

  it("every surface declares schemaVersion among its guaranteed fields", () => {
    for (const surface of PUBLIC_CONTRACT) {
      expect(surface.fields, `${surface.key} must list schemaVersion`).toContain("schemaVersion");
    }
  });
});
