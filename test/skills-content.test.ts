// The *content* of two emitted agent skills (UAC §1.2): `tripact-detect` (layer classification +
// tripact.yaml scaffolding, the judgement task the kernel deliberately does not automate) and
// `tripact-sync` (the stage-by-stage host run-book that honours the accept policy at the final gate).
// test/skills.test.ts covers emission mechanics (which files, determinism, --force); this file covers
// what the two documents actually instruct an agent to do — pure generator assertions plus the
// on-disk files a real `tripact skills` run produces.
import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { detectSkill, loopSkill } from "../src/skills.js";
import { runCli } from "./helpers/cli.js";
import { fullRepo } from "./helpers/fixture.js";

const scratch: string[] = [];
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});

/** A fixture repo with the four skills emitted; returns the repo path. */
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
