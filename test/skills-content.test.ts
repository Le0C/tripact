// The *content* of four emitted agent skills (UAC §1.2): `tripact-detect` (layer classification +
// tripact.yaml scaffolding, the judgement task the kernel deliberately does not automate),
// `tripact-sync` (the stage-by-stage host run-book that honours the accept policy at the final gate),
// `tripact-reconcile` (working the propose-only queue that links claims to existing tests, §10.3),
// and `tripact-hotlink-decoration` (writing navigational spec back-links into product code, §20.3).
// test/skills.test.ts covers emission mechanics (which files, determinism, --force); this file covers
// what the documents actually instruct an agent to do — pure generator assertions plus the on-disk
// files a real `tripact skills` run produces.
import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { detectSkill, hotlinkDecorationSkill, loopSkill, reconcileSkill } from "../src/skills.js";
import { runCli } from "./helpers/cli.js";
import { fullRepo } from "./helpers/fixture.js";

const scratch: string[] = [];
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});

/** A fixture repo with the six skills emitted; returns the repo path. */
function repoWithSkills(prefix: string): string {
  const repo = fullRepo(prefix);
  scratch.push(repo);
  const r = runCli(["skills"], { cwd: repo });
  expect(r.status, r.stderr).toBe(0);
  return repo;
}

function skillFile(repo: string, name: string): string {
  return readFileSync(path.join(repo, ".claude", "skills", name, "SKILL.md"), "utf8");
}

describe("tripact-detect skill content (§1.2)", () => {
  // @specs:agent-skill-emission.tripact-detect-skill-teaches-coding
  it("teaches classifying files into the three layer roles and scaffolding a tripact.yaml", () => {
    const { name, content } = detectSkill();
    expect(name).toBe("tripact-detect");
    // It is a coding-agent skill about scaffolding the config.
    expect(content).toContain("# Scaffold a tripact.yaml");
    expect(content).toContain("Write `tripact.yaml`** at the repository root");
    expect(content).toContain("schemaVersion: 1");
    // Each of the three roles is taught, with guidance on what belongs in it.
    expect(content).toContain("**prescriptive** (the source of truth)");
    expect(content).toContain("**descriptive** (user-facing docs)");
    expect(content).toContain("**verificatory** (tests)");
    // Classification is presented as judgement, not something the kernel automates for you.
    expect(content).toContain("Deciding that is a judgement");
    expect(content).toContain("not a fixed heuristic");
  });

  // @specs:agent-skill-emission.tripact-detect-skill-teaches-coding
  it("is emitted to disk while the kernel itself exposes no layer-detecting command", () => {
    const repo = repoWithSkills("tripact-detect-content-");
    const content = skillFile(repo, "tripact-detect");
    expect(content).toContain("name: tripact-detect");
    expect(content).toContain("Scaffold a tripact.yaml for this repository");
    expect(content).toContain("classify its files into prescriptive (spec)");

    // Detection stays a judgement task: there is no kernel `init`/`detect` command to do it.
    const help = runCli(["--help"], { cwd: repo });
    expect(help.status, help.stderr).toBe(0);
    expect(help.stdout).not.toMatch(/^\s+init\b/m);
    expect(help.stdout).not.toMatch(/^\s+detect\b/m);
    const init = runCli(["init"], { cwd: repo });
    expect(init.status).not.toBe(0);
  });
});

describe("tripact-sync skill content (§1.2)", () => {
  // @specs:agent-skill-emission.tripact-sync-skill-instructs-host
  it("instructs the host agent to work the queues stage by stage", () => {
    const { name, content } = loopSkill();
    expect(name).toBe("tripact-sync");
    // The five ordered stages, each naming the queue-bearing kernel command it drives.
    expect(content).toContain("1. **Check.** Run `tripact check --json`");
    expect(content).toContain("2. **Adjudicate first.**");
    expect(content).toContain("`tripact resolve`");
    expect(content).toContain("3. **Repair.** Run `tripact tasks --json`");
    expect(content).toContain("4. **Validate.**");
    expect(content).toContain("5. **Accept.**");
    // Stage ordering is explicit, not incidental: adjudication precedes repair.
    expect(content.indexOf("2. **Adjudicate first.**")).toBeLessThan(content.indexOf("3. **Repair.**"));
    expect(content.indexOf("4. **Validate.**")).toBeLessThan(content.indexOf("5. **Accept.**"));
    expect(content).toContain("Report per stage what you did.");
  });

  // @specs:agent-skill-emission.tripact-sync-skill-instructs-host
  it("honours the configured accept policy at the final gate", () => {
    const human = loopSkill({ policy: "human" }).content;
    const agents = loopSkill({ policy: "agents" }).content;
    // The final stage — and only the final stage — differs by policy.
    expect(human).toContain("Under the configured `human` policy, stop before accept");
    expect(human).toContain("leave baselining to a person");
    expect(human).toContain("Never run `tripact accept`");
    expect(agents).toContain("Under the configured `agents` policy, run `tripact accept` once validation passes");
    expect(agents).toContain("no escalations remain");
    expect(agents).not.toContain("stop before accept");
  });

  // @specs:agent-skill-emission.tripact-sync-skill-instructs-host
  it("is emitted to disk as the host-facing loop run-book", () => {
    const repo = repoWithSkills("tripact-sync-content-");
    const content = skillFile(repo, "tripact-sync");
    expect(content).toContain("name: tripact-sync");
    expect(content).toContain("# Run a tripact sync");
    expect(content).toContain("check, adjudicate, repair, validate, and honour");
    // Under the fixture's default (human) policy the final gate withholds accept authority.
    expect(content).toContain("Under the configured `human` policy, stop before accept");
  });
});

describe("tripact-reconcile skill content (§1.2)", () => {
  // @specs:agent-skill-emission.tripact-reconcile-skill-instructs-agent
  it("instructs reading what each candidate actually asserts, tagging only genuine matches, dismissing the rest", () => {
    const { name, content } = reconcileSkill();
    expect(name).toBe("tripact-reconcile");
    expect(content).toBe(reconcileSkill().content); // deterministic
    expect(content).toContain("# Reconcile untagged tests");
    // It drives the propose-only queue…
    expect(content).toContain("`tripact reconcile --json`");
    expect(content).toContain("propose-only queue");
    // …reads the test rather than trusting the score…
    expect(content).toContain("open the test and read what it actually asserts - the score is a hint,\n   not proof");
    // …tags only a genuine match, and dismisses the rest so it is not re-proposed.
    expect(content).toContain("Never tag a test that does not\n     assert the claim");
    expect(content).toContain("reconcile --dismiss <claimId> <file> <line>");
    expect(content).toContain("re-proposed until either side's text changes");
  });

  // @specs:agent-skill-emission.tripact-reconcile-skill-instructs-agent
  it("makes clear the kernel proposes but never tags on the agent's behalf", () => {
    const content = reconcileSkill().content;
    expect(content).toContain("tripact never tags for you");
    expect(content).toContain("`reconcile` proposes; you decide");
  });

  // @specs:agent-skill-emission.tripact-reconcile-skill-instructs-agent
  it("is emitted to disk by a real `tripact skills` run", () => {
    const repo = repoWithSkills("tripact-reconcile-content-");
    const content = skillFile(repo, "tripact-reconcile");
    expect(content).toContain("name: tripact-reconcile");
    expect(content).toContain("existing untagged tests that may already assert an");
  });
});

describe("tripact-hotlink-decoration skill content (§1.2)", () => {
  // @specs:agent-skill-emission.tripact-hotlink-decoration-skill-instructs-agent
  it("instructs writing a claim-id tag and a spec back-link into the implementing function's docstring", () => {
    const { name, content } = hotlinkDecorationSkill();
    expect(name).toBe("tripact-hotlink-decoration");
    expect(content).toContain("# Decorate code with spec hotlinks");
    // The decoration itself: the tag in the codeLinks form, plus a back-link to the claim and
    // forward links to its covering tests — placed in the implementing function's docstring.
    expect(content).toContain("docstring of each function that implements a claim");
    expect(content).toContain("`codeLinks.tagPattern` form");
    expect(content).toContain("a back-link to the claim's spec FILE");
    expect(content).toContain("forward links to its covering test files");
    // It teaches the one link form that both renders and navigates from a hover — a markdown link
    // wrapping a {@link} tag — and warns off the fragment forms that render but refuse to navigate.
    expect(content).toContain("markdown link whose target is a `{@link}` tag");
    expect(content).toContain("Link to the file, never to a line or a heading");
    expect(content).toContain("microsoft/TypeScript#47718");
    // It reads the links back through the kernel rather than inventing them.
    expect(content).toContain("`tripact hotlinks --json`");
    expect(content).toContain("Never invent a claim id");
    // A code tag navigates; it never confers coverage (§20.2).
    expect(content).toContain("A code tag is navigation, not verification");
  });

  // @specs:agent-skill-emission.tripact-hotlink-decoration-skill-instructs-agent
  it("tells the agent to refresh a declared hotlink-map, and that the kernel never edits product code", () => {
    const content = hotlinkDecorationSkill().content;
    expect(content).toContain("If a `hotlink-map` derived output is declared, refresh it with `tripact generate`");
    // The division of labour §20.3 fixes: the agent writes the comment, the kernel only reads it back.
    expect(content).toContain("tripact never edits");
    expect(content).toContain("product code - you do");
  });

  // @specs:agent-skill-emission.tripact-hotlink-decoration-skill-instructs-agent
  it("is emitted to disk by a real `tripact skills` run", () => {
    const repo = repoWithSkills("tripact-hotlink-content-");
    const content = skillFile(repo, "tripact-hotlink-decoration");
    expect(content).toContain("name: tripact-hotlink-decoration");
    expect(content).toContain("Decorate product-code functions with navigational hotlinks");
  });
});
