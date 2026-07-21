// A sidecar that two branches both accepted into (UAC §3.2). `.tripact/claims.json` is committed,
// so this is not an exotic corruption — it is what happens the first time two people work in
// parallel, and the message has to carry the resolution rather than a parser's position offset.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { loadSidecar, sidecarPath } from "../src/sidecar.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A repo root whose sidecar holds exactly `content`. */
function repoWithSidecar(content: string): string {
  const d = mkdtempSync(path.join(tmpdir(), "tri-conflict-"));
  dirs.push(d);
  const p = sidecarPath(d);
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, content);
  return d;
}

// Built by concatenation so this file's own text never carries a real conflict marker at column 0,
// which would confuse both git and any tool scanning the tree.
const LT = "<".repeat(7);
const EQ = "=".repeat(7);
const GT = ">".repeat(7);
const CONFLICTED = [
  "{",
  '  "schemaVersion": 1,',
  `${LT} HEAD`,
  '  "claims": [{ "id": "addition.a" }]',
  EQ,
  '  "claims": [{ "id": "addition.b" }]',
  `${GT} feature-b`,
  "}",
].join("\n");

describe("a conflicted sidecar (§3.2)", () => {
  it("@specs:sidecar.sidecar-left-carrying-version-control - reports an unresolved merge, naming the file", () => {
    const d = repoWithSidecar(CONFLICTED);
    expect(() => loadSidecar(d)).toThrow(/merge conflict markers/);
    expect(() => loadSidecar(d)).toThrow(/claims\.json/);
    // Not the raw parser complaint, which names a byte offset and no file.
    expect(() => loadSidecar(d)).not.toThrow(/Expected property name/);
  });

  it("@specs:sidecar.sidecar-left-carrying-version-control - the message carries the resolution, and it is rebuild rather than hand-merge", () => {
    const d = repoWithSidecar(CONFLICTED);
    let message = "";
    try {
      loadSidecar(d);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/do NOT hand-merge/i);
    expect(message).toContain("git checkout --ours");
    expect(message).toContain("tripact accept");
    // The reason taking one side is safe: ids come from claim content, not from this file.
    expect(message).toMatch(/derived from claim content/);
  });

  it("@specs:sidecar.sidecar-left-carrying-version-control - a marker is only a marker at column 0, so claim prose that mentions one is not a false positive", () => {
    // A claim whose text legitimately discusses conflict markers must still load.
    const d = repoWithSidecar(
      JSON.stringify({
        schemaVersion: 1,
        claims: [{ id: "docs.merge", text: `a heading may contain ${EQ} inside prose` }],
        groups: [],
        backlog: { claims: [], sections: [] },
      }),
    );
    expect(() => loadSidecar(d)).not.toThrow();
  });

  it("@specs:sidecar.any-other-unreadable-sidecar - unparseable-but-unconflicted names the file and the reason", () => {
    const d = repoWithSidecar("{ this is not json");
    expect(() => loadSidecar(d)).toThrow(/could not read/);
    expect(() => loadSidecar(d)).toThrow(/claims\.json/);
    // No merge advice where there was no merge.
    expect(() => loadSidecar(d)).not.toThrow(/hand-merge/);
  });

  it("@specs:sidecar.any-other-unreadable-sidecar - a missing sidecar is not an error at all, it is an unbaselined repo", () => {
    const d = mkdtempSync(path.join(tmpdir(), "tri-conflict-"));
    dirs.push(d);
    expect(loadSidecar(d).claims).toEqual([]);
  });
});
