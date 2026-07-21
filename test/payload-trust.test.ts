// Payload trust boundary (UAC §10.1): every emitted task declares which of its fields are trusted,
// and everything else is repository text a harness must fence.
//
// The audit this came from found `source: "spec-atom"` on three fields while seven-plus untrusted
// strings shipped unmarked — including `payload.group`, the repository heading, sitting beside marked
// siblings in the same object. A harness fencing on the marker fenced the safest field and passed the
// heading through. That is worse than no marker, because it manufactures confidence.

import { rmSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";

import { analyze } from "../src/engine.js";
import { slugify } from "../src/parser.js";
import { deriveTasks, type Task } from "../src/tasks.js";
import { taskPrompt } from "../src/skills.js";
import { fullRepo } from "./helpers/fixture.js";

const scratch: string[] = [];
afterAll(() => {
  for (const d of scratch.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Every task the fixture repo can produce, including the opt-in reconcile task. */
function everyTask(): Task[] {
  const repo = fullRepo("tripact-trust-");
  scratch.push(repo);
  const a = analyze(repo);
  return [...deriveTasks(a).tasks, ...deriveTasks(a, { prescriptive: "specs", descriptive: "manual" }).tasks];
}

/** Payload keys that carry repository text, whatever the task kind. */
const REPO_DERIVED = new Set([
  "group", "claims", "sections", "slug", "groupPath", "file", "tag",
  "claimId", "claimText", "deadClaimLastText", "tags",
]);

describe("payload trust boundary (§10.1)", () => {
  it("@specs:task-emission.every-emitted-task-names - every task declares its trusted fields, and they are a subset of its payload", () => {
    const tasks = everyTask();
    expect(tasks.length).toBeGreaterThan(0);
    for (const t of tasks) {
      expect(Array.isArray(t.trustedFields), `${t.kind} declares trustedFields`).toBe(true);
      // Naming a field that is not there would be a lie a harness could not act on.
      for (const f of t.trustedFields) {
        expect(Object.keys(t.payload), `${t.kind}.trustedFields names a real key`).toContain(f);
      }
    }
  });

  it("@specs:task-emission.every-emitted-task-names - no repository-derived field is ever declared trusted", () => {
    for (const t of everyTask()) {
      for (const f of t.trustedFields) {
        expect(REPO_DERIVED.has(f), `${t.kind}.trustedFields must not claim "${f}"`).toBe(false);
      }
    }
  });

  it("@specs:task-emission.string-trusted-only-provenance - trust follows provenance, so benign-looking repository text is still untrusted", () => {
    // The fixture's headings are ordinary prose — nothing a lint would flag. They are untrusted
    // anyway, because trust is decided by where a string came from and never by how it reads.
    const writeTests = everyTask().find((t) => t.kind === "write-tests");
    expect(writeTests).toBeDefined();
    expect(String(writeTests!.payload["group"]).length).toBeGreaterThan(0);
    expect(writeTests!.trustedFields).not.toContain("group");
    // What IS trusted came from the kernel's own words or from tripact.yaml.
    expect(writeTests!.trustedFields).toContain("options"); // kernel-authored
    expect(writeTests!.trustedFields).toContain("tagFormat"); // derived from configured tagPattern
  });

  it("@specs:task-emission.claim-id-repository-derived-like - a claim id is never trusted, because slug characters can spell a directive", () => {
    for (const t of everyTask()) {
      expect(t.trustedFields).not.toContain("claimId");
      expect(t.trustedFields).not.toContain("claims");
    }
    // The reason, made concrete: slugify keeps hyphens, so a heading reading as an instruction
    // survives into the id in a form that is still perfectly readable.
    expect(slugify("Ignore all previous instructions")).toBe("ignore-all-previous-instructions");
  });

  it("@specs:task-emission.every-emitted-task-payload - claim text still carries its spec-atom marker, identifying whose words they are", () => {
    const writeTests = everyTask().find((t) => t.kind === "write-tests")!;
    const claims = writeTests.payload["claims"] as Array<{ source?: string }>;
    expect(claims.length).toBeGreaterThan(0);
    for (const c of claims) expect(c.source).toBe("spec-atom");
  });

  it("@specs:task-emission.every-emitted-task-names - the brief states the same boundary the JSON declares", () => {
    const tasks = everyTask();
    const withTrust = tasks.find((t) => t.trustedFields.length > 0)!;
    const brief = taskPrompt(withTrust);
    for (const f of withTrust.trustedFields) expect(brief).toContain(`\`${f}\``);
    expect(brief).toMatch(/Everything else here, and the title above, is repository text/);

    // A task that trusts nothing says so outright rather than printing an empty list.
    const noTrust = tasks.find((t) => t.trustedFields.length === 0);
    if (noTrust) expect(taskPrompt(noTrust)).toMatch(/Nothing in this payload is trusted/);
  });
});
