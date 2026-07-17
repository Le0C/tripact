// Agent skill + per-item prompt generation. Two halves: pure unit tests of the deterministic
// generators (no repo needed), and e2e of the `skills` and `prompt` CLI commands against a real
// scratch repo. The whole point of this surface is that a foreign harness can pick up the kernel
// and get well-formed adjudication/repair guidance and per-work-item prompts without re-deriving them.
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  adjudicateSkill,
  agentSkills,
  escalationPrompt,
  repairSkill,
  taskPrompt,
} from "../src/skills.js";
import type { Task } from "../src/tasks.js";
import type { Escalation } from "../src/types.js";
import { runCli } from "./helpers/cli.js";
import { fullRepo } from "./helpers/fixture.js";

const scratch: string[] = [];
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});

describe("skill generators (pure)", () => {
  // @specs:agent-skill-emission.tripact-adjudicate-skill-instructs-agent
  it("default to tripact branding and stamp a version", () => {
    const adj = adjudicateSkill();
    expect(adj.name).toBe("tripact-adjudicate");
    expect(adj.content).toContain("generatedBy: tripact@");
    expect(adj.content).toContain("`tripact resolve <question-id>");
    expect(adj.content).toContain(".tripact/escalations.json");
  });

  // @specs:agent-skill-emission.tripact-repair-skill-instructs-agent
  it("re-brand every command and name for a driving harness", () => {
    const opts = { cli: "acme", namePrefix: "acme", version: "9.9.9", reEmitCommand: "acme init --force" };
    const rep = repairSkill(opts);
    expect(rep.name).toBe("acme-repair");
    expect(rep.content).toContain("generatedBy: acme@9.9.9");
    expect(rep.content).toContain("`acme tasks --json`");
    expect(rep.content).toContain("acme init --force"); // re-emit hint uses the harness path
    // The command word is fully rebranded — no default `tripact <command>` leaks. (The fixed on-disk
    // names `tripact.yaml` (config) and `.tripact/` (sidecar) are not command words and are expected
    // regardless of branding.)
    expect(rep.content.replace(/tripact\.yaml/g, "").replace(/\.tripact\b/g, "")).not.toContain("tripact");
  });

  // @specs:agent-skill-emission.emitted-skills-accept-authority
  it("bake the accept policy into the guidance", () => {
    expect(adjudicateSkill({ policy: "human" }).content).toContain("Never run `tripact accept`");
    expect(adjudicateSkill({ policy: "agents" }).content).toContain("Run `tripact accept` only after validation");
  });

  // @specs:agent-skill-emission.tripact-skills-writes-four
  // @specs:agent-skill-emission.emitted-skill-content-deterministic
  it("emit exactly the portable skills, deterministically", () => {
    const a = agentSkills();
    const b = agentSkills();
    expect(a.map((s) => s.name)).toEqual(["tripact-detect", "tripact-adjudicate", "tripact-repair", "tripact-sync"]);
    expect(a).toEqual(b); // same options → byte-identical
  });

  // @specs:task-emission.tripact-prompt-id-prints
  it("taskPrompt inlines the payload and kind-specific instructions", () => {
    const task: Task = {
      id: "write-tests-abc123",
      kind: "write-tests",
      title: 'Write tagged tests for 2 uncovered claim(s) in "Addition"',
      payload: { group: "Addition", claimIds: ["a", "b"], tagFormat: "@specs:<id>" },
      effort: "implementation",
    };
    const p = taskPrompt(task);
    expect(p).toContain("write-tests-abc123");
    expect(p).toContain("genuinely assert each listed claim");
    expect(p).toContain('"tagFormat": "@specs:<id>"'); // payload inlined verbatim
    expect(p).toContain("implementation"); // dispatch hint surfaced
    expect(p).toContain("`tripact check`");
  });

  it("escalationPrompt lays out the atoms and the exact resolve commands", () => {
    const q: Escalation = {
      id: "reanchor-deadbeef01",
      kind: "reanchor",
      groupPath: "Addition",
      deleted: [{ id: "add.sum", text: "adds two integers" }],
      created: [{ text: "adds two whole numbers", file: "UAC.md", line: 7 }],
      candidates: [{ oldId: "add.sum", newText: "adds two whole numbers", ratio: 0.62 }],
    };
    const p = escalationPrompt(q);
    expect(p).toContain("reanchor-deadbeef01");
    expect(p).toContain("add.sum");
    expect(p).toContain("ratio 0.62");
    expect(p).toContain('tripact resolve reanchor-deadbeef01 --match');
  });
});

describe("skills + prompt commands (e2e)", () => {
  // @specs:agent-skill-emission.existing-skill-file-left
  it("`tripact skills` writes the four SKILL.md files", () => {
    const repo = fullRepo("tripact-skills-");
    scratch.push(repo);
    const r = runCli(["skills"], { cwd: repo });
    expect(r.status, r.stderr).toBe(0);
    for (const name of ["tripact-detect", "tripact-adjudicate", "tripact-repair", "tripact-sync"]) {
      const p = path.join(repo, ".claude", "skills", name, "SKILL.md");
      expect(existsSync(p), `${name} written`).toBe(true);
      expect(readFileSync(p, "utf8")).toContain(`name: ${name}`);
    }
    // idempotent: a second run leaves them untouched
    const rerun = runCli(["skills"], { cwd: repo });
    expect(rerun.stdout).toContain("already present");
  });

  it("`tripact prompt <task-id>` prints a per-task brief for a real queued task", () => {
    const repo = fullRepo("tripact-prompt-");
    scratch.push(repo);
    const queue = JSON.parse(runCli(["tasks", "--json"], { cwd: repo }).stdout);
    expect(queue.tasks.length).toBeGreaterThan(0);
    const id = queue.tasks[0].id;
    const r = runCli(["prompt", id], { cwd: repo });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain(id);
    expect(r.stdout).toContain("## Payload (self-contained)");
  });

  it("`tripact prompt <unknown>` exits 1 with a helpful message", () => {
    const repo = fullRepo("tripact-prompt-miss-");
    scratch.push(repo);
    const r = runCli(["prompt", "no-such-id-000000"], { cwd: repo });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("no task or escalation");
  });
});
