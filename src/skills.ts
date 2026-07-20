// Agent-facing prompt & skill generation. This is kernel, not harness: generating the prose an
// agent reads is deterministic text (no LLM, no network) - what must stay in a harness is *invoking*
// the agent, not writing the prompt it consumes. Keeping this here is what lets any harness pick up
// the kernel and immediately have well-formed adjudication/repair guidance and per-work-item prompts,
// rather than re-deriving them.
//
// Everything is parameterised by the command word (`cli`) the driving harness exposes, so the same
// generators emit `tripact resolve …` for the tripact CLI, or `<yourcli> resolve …` when another
// harness drives the kernel under its own name.

import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { AcceptPolicy } from "./config.js";
import type { Task } from "./tasks.js";
import type { Escalation } from "./types.js";
import { TRIPACT_VERSION } from "./version.js";

/** How emitted prompts/skills should name the driving CLI and identify themselves. */
export interface SkillOptions {
  /** Command word used in emitted prose, e.g. "tripact". Default "tripact". */
  cli?: string;
  /** Prefix for emitted skill names (`<prefix>-adjudicate`). Default = `cli`. */
  namePrefix?: string;
  /** Version stamped into `generatedBy: <namePrefix>@<version>`. Default the tripact version. */
  version?: string;
  /** Accept policy baked into the guidance. Default "human". */
  policy?: AcceptPolicy;
  /** How the operator re-emits skills after a policy/version change. Default `<cli> skills --force`. */
  reEmitCommand?: string;
}

interface Resolved {
  cli: string;
  namePrefix: string;
  version: string;
  policy: AcceptPolicy;
  reEmit: string;
}

function resolveOpts(o: SkillOptions = {}): Resolved {
  const cli = o.cli ?? "tripact";
  return {
    cli,
    namePrefix: o.namePrefix ?? cli,
    version: o.version ?? TRIPACT_VERSION,
    policy: o.policy ?? "human",
    reEmit: o.reEmitCommand ?? `${cli} skills --force`,
  };
}

/** One emitted skill: a name (its directory) and the SKILL.md content. */
export interface EmittedSkill {
  name: string;
  content: string;
}

function acceptRule(r: Resolved): string {
  return r.policy === "agents"
    ? `Run \`${r.cli} accept\` only after validation passes (\`${r.cli} check\` and the repo's test command) with no open escalations - the configured \`agents\` accept policy permits it. Never accept while validation is red or escalations remain.`
    : `Never run \`${r.cli} accept\` - under the configured \`human\` accept policy, baselining is a person's call.`;
}

function policyNote(r: Resolved): string {
  return `The accept policy is read from \`tripact.yaml\` (\`accept.policy\`, default \`human\`). If you change it, re-emit the skills with \`${r.reEmit}\`.`;
}

/**
 * The adjudication skill: answer the escalation questions the deterministic engine will not guess at
 * (reworded claims, splits/merges, forks). Drives only kernel commands (`check`, `resolve`), so it
 * is portable to any harness.
 */
export function adjudicateSkill(opts?: SkillOptions): EmittedSkill {
  const r = resolveOpts(opts);
  const content = `---
name: ${r.namePrefix}-adjudicate
description: >
  Adjudicate ${r.cli} escalation questions in .tripact/escalations.json - ambiguous
  claim re-anchorings and split/merge cases the deterministic engine will not guess at.
  Use when the user says "resolve the ${r.cli} escalations", "adjudicate the sync
  questions", after \`${r.cli} check\` reports open escalations, or before \`${r.cli} accept\`.
metadata:
  generatedBy: ${r.namePrefix}@${r.version}
---

# Adjudicate ${r.cli} escalations

${r.cli} tracks requirement/doc checklist items ("claims") with stable identities.
When a claim is reworded beyond mechanical recognition, ${r.cli} asks instead of
guessing. Your job: answer those questions with semantic judgment.

## Steps

1. Read \`.tripact/escalations.json\` (or run \`${r.cli} prompt <question-id>\` for a
   ready-made per-question brief). Each question has:
   - \`kind\`: \`reanchor\` (old claims vs new texts in one section), \`split-merge\`, or
     \`fork-review\` (a group lost an old atom and gained a new one - identity forked;
     advisory, never blocks \`accept\`)
   - \`deleted\`: old claims (id + text) that no longer match anything
   - \`created\`: new texts that match no existing claim
   - \`candidates\`: possible pairings with similarity ratios
2. For each question, decide per atom, using the texts (not the ratios) as evidence:
   - Same requirement restated → \`${r.cli} resolve <question-id> --match <old-id>="<new text>"\`
   - Genuinely new requirement → \`${r.cli} resolve <question-id> --new "<new text>"\`
   - Requirement removed → \`${r.cli} resolve <question-id> --dead <old-id>\`
   - Forked identity is genuinely two different requirements (fork-review) →
     \`${r.cli} resolve <question-id> --dismiss\` to accept the fork; or \`--match\` to
     reunite the old id with the new text if it was the same requirement all along.
   Resolving one atom shrinks a multi-atom question in place - the remaining atoms keep
   the same question id, so answer them one at a time without re-running \`check\`.
   A split (one old → several new) is expressed as one \`--match\` for the closest
   successor plus \`--new\` for the others; a merge as \`--match\` for the surviving
   text's closest ancestor plus \`--dead\` for the rest.
3. Re-run \`${r.cli} check\`. Repeat until no \`reanchor\`/\`split-merge\` escalations remain
   (\`fork-review\` questions are advisory - dismiss or match them, but they never gate accept).
4. Report to the user what you decided and why, per question - they review before
   \`${r.cli} accept\`.

## Rules

- ${acceptRule(r)}
- When genuinely uncertain, ask the user rather than deciding.
- Do not edit \`.tripact/*.json\` by hand - always go through \`${r.cli} resolve\`.
- ${policyNote(r)}
`;
  return { name: `${r.namePrefix}-adjudicate`, content };
}

/**
 * The reconcile skill: work the propose-only queue that links uncovered claims to existing tests
 * (UAC §10.3). Drives only kernel commands (`reconcile`), so it is portable to any harness.
 */
export function reconcileSkill(opts?: SkillOptions): EmittedSkill {
  const r = resolveOpts(opts);
  const content = `---
name: ${r.namePrefix}-reconcile
description: >
  Work ${r.cli}'s reconcile queue - existing untagged tests that may already assert an
  uncovered claim. Use when the user says "reconcile the untagged tests", "link claims to
  existing tests", or after \`${r.cli} check\` shows a large uncovered backlog on a repo that
  already has tests.
metadata:
  generatedBy: ${r.namePrefix}@${r.version}
---

# Reconcile untagged tests

On a repo with existing tests, many claims read uncovered only because no test carries a tag
yet. \`${r.cli} reconcile\` proposes, per uncovered claim, existing tests whose title resembles
the claim - a propose-only queue. Your job: confirm the genuine matches and tag them, and
dismiss the rest. ${r.cli} never tags for you.

## Steps

1. Run \`${r.cli} reconcile --json\`. Each entry has a \`claimId\`, the \`claimText\`, the exact
   \`tagFormat\` to use, and ranked \`candidates\` (each a test \`file\`, \`line\`, \`title\`, and
   similarity \`score\`).
2. For each candidate, open the test and read what it actually asserts - the score is a hint,
   not proof. Then either:
   - It genuinely asserts the claim → add the tag (\`tagFormat\` with the \`claimId\`) to that
     test's title, exactly as \`${r.cli} check\` scans for it. Never tag a test that does not
     assert the claim.
   - It does not → \`${r.cli} reconcile --dismiss <claimId> <file> <line>\` so it is not
     re-proposed until either side's text changes.
3. Re-run \`${r.cli} check\`: newly tagged claims move uncovered → pending → covered once
   baselined. Write a genuine test for any claim still uncovered (see the repair skill).
4. Report per claim what you tagged, dismissed, or left for a fresh test.

## Rules

- ${acceptRule(r)}
- \`reconcile\` proposes; you decide. Tag only a test that truly asserts the claim.
- ${policyNote(r)}
`;
  return { name: `${r.namePrefix}-reconcile`, content };
}

/**
 * The hotlink-decoration skill: place navigational hotlink comments in product-code docstrings so a
 * developer can jump from a function to the spec claim it implements (UAC §20.3). Writing the comment
 * is agent work - the kernel only reads the tags back with `hotlinks`.
 */
export function hotlinkDecorationSkill(opts?: SkillOptions): EmittedSkill {
  const r = resolveOpts(opts);
  const content = `---
name: ${r.namePrefix}-hotlink-decoration
description: >
  Decorate product-code functions with navigational hotlinks to the spec claims they implement.
  Use when the user says "add hotlinks", "decorate the code with spec links", or after a
  \`codeLinks\` block is configured so a developer can jump from a function to its requirement.
metadata:
  generatedBy: ${r.namePrefix}@${r.version}
---

# Decorate code with spec hotlinks

A \`codeLinks\` block declares which product-code files carry claim-id tags. Your job: place a
clickable hotlink comment in the docstring of each function that implements a claim, so a
developer hovering it in their editor can open the spec claim and its tests. ${r.cli} never edits
product code - you do; ${r.cli} only reads the tags back with \`${r.cli} hotlinks\`.

## Steps

1. Run \`${r.cli} hotlinks --json\` for the current code↔spec links and any orphan code tags, and
   \`${r.cli} claims --json\` for each claim's declaring \`file\`/\`line\` and covering test tags.
2. In the docstring of each function that implements a claim, add:
   - the claim-id tag in the repo's \`codeLinks.tagPattern\` form, so \`${r.cli} hotlinks\` links it
   - a back-link to the claim's spec FILE, and forward links to its covering test files, each written
     as a markdown link whose target is a \`{@link}\` tag:
     \`- spec: [SPEC.md - §3.1 Section name]({@link ./../SPEC.md})\`
     That combined form is the one that both renders as a label and navigates from an editor hover.
   - Link to the file, never to a line or a heading. A \`#L42\` or \`#some-heading\` fragment renders
     but refuses to navigate: JSDoc has no file-link support (microsoft/TypeScript#47718 is still
     open, and line numbers are an unmet ask in that thread). A line number would rot anyway -
     nothing re-checks the back-link text, so it goes wrong the moment the spec shifts and
     tells no one.
     Put the section name in the link label instead: it is greppable and survives edits.
3. Re-run \`${r.cli} hotlinks\`: the function shows as a link, not an orphan. Fix any orphan code tag
   (unknown or dead id) by correcting it to a live id from \`${r.cli} claims\`.
4. If a \`hotlink-map\` derived output is declared, refresh it with \`${r.cli} generate\`.

## Rules

- Never invent a claim id - copy it from \`${r.cli} claims\` / \`${r.cli} hotlinks\` output.
- A code tag is navigation, not verification: it never makes a claim "covered" - only a tagged test
  does that.
- ${policyNote(r)}
`;
  return { name: `${r.namePrefix}-hotlink-decoration`, content };
}

/**
 * The repair skill: execute the derived repair/generation queue (write tagged tests, reconcile
 * stale claims, fix orphan tags, cover docs sections, reconcile layers). Drives only kernel
 * commands (`tasks`, `check`, `status`) plus artefact edits, so it is portable to any harness.
 */
export function repairSkill(opts?: SkillOptions): EmittedSkill {
  const r = resolveOpts(opts);
  const content = `---
name: ${r.namePrefix}-repair
description: >
  Execute ${r.cli} repair and generation tasks - write missing tagged tests, reconcile
  stale claims, fix orphan tags, cover undocumented docs sections, and reconcile a
  descriptive layer against its prescriptive layer. Use when the user says "work the
  ${r.cli} backlog", "repair the drift", "reconcile the docs with the spec", or after
  \`${r.cli} tasks\` reports open work.
metadata:
  generatedBy: ${r.namePrefix}@${r.version}
---

# Execute ${r.cli} repair tasks

${r.cli} detects drift; you repair it. The engine never edits artefact content - that
is your job, under human review.

## Steps

1. Run \`${r.cli} tasks --json\` (add \`--reconcile <p>:<d>\` if asked to reconcile
   documentation against the spec). Each task's \`payload\` is self-contained; for a
   ready-made brief on a single task run \`${r.cli} prompt <task-id>\`.
2. Before editing a layer, read its \`conventions\` file if \`tripact.yaml\` declares
   one, and match the existing voice and structure of the artefacts you touch.
3. Work task kinds like this:
   - **write-tests** (find-or-write): first search the verificatory layer for an existing
     untagged test that already asserts the claim and tag it in place; write a new test
     only when none is found. Tag in the test title using the task's \`tagFormat\`. Never
     tag a test that does not assert the claim.
   - **reconcile-stale**: read the claim and its tagged test; align whichever is wrong
     (test asserts the old behaviour → update the test; claim text drifted → flag to
     the user rather than editing the spec without saying so).
   - **fix-orphan-tag**: the tag references a retired or mistyped id - find the right
     live id with \`${r.cli} status --json\`, or remove the tag if the claim is gone.
   - **cover-section**: write or tag a test that walks the docs section's steps,
     tagged \`@docs:<slug>\`.
   - **reconcile-layers**: judge which claims lack user-facing documentation and write
     the missing sections in the descriptive layer's existing style. Document
     user-operable behaviour; skip internals.
   - **regenerate-derived**: run the payload's \`invocation\` to regenerate the stale
     derived output deterministically; never hand-edit a generated file.
4. Validate before reporting: run \`${r.cli} check\` AND the repo's own test command.
   New tests must pass; the check must not regress (no new orphans or escalations).
5. Report per task: what you changed, why, and anything you chose not to do.

## Rules

- ${acceptRule(r)}
- Never edit \`.tripact/*\` by hand.
- Never invent spec: if a claim seems wrong or missing, report it; do not add or
  reword prescriptive atoms unless the user explicitly asked.
- ${policyNote(r)}
`;
  return { name: `${r.namePrefix}-repair`, content };
}

/**
 * The loop skill: run one full reconciliation loop using only kernel commands
 * (check → adjudicate → tasks → repair → validate → accept). Unlike a harness run-book command,
 * this composes the primitives directly, so it works wherever the kernel does.
 */
export function loopSkill(opts?: SkillOptions): EmittedSkill {
  const r = resolveOpts(opts);
  const content = `---
name: ${r.namePrefix}-sync
description: >
  Run one full ${r.cli} reconciliation loop - check, adjudicate, repair, validate, and honour
  the accept policy at the final gate. Use when the user says "sync ${r.cli}", "run the full
  loop", "bring the spec, docs, and tests back into agreement", or after a feature change.
metadata:
  generatedBy: ${r.namePrefix}@${r.version}
---

# Run a ${r.cli} sync

Drive the whole loop from the kernel commands. ${r.cli} derives the work; you adjudicate
and edit; acceptance happens as the configured accept policy allows.

## Steps

1. **Check.** Run \`${r.cli} check --json\`. Exit 0 means level - stop, nothing to do.
   Exit 1 means drift; read the report's \`escalations\` and \`verdicts\`.
2. **Adjudicate first.** If \`escalations\` is non-empty, work them with the
   **${r.namePrefix}-adjudicate** skill (or \`${r.cli} resolve\` directly) before any repair -
   \`accept\` refuses while identity questions are open. Re-run \`${r.cli} check\` after.
3. **Repair.** Run \`${r.cli} tasks --json\` and execute each task with the
   **${r.namePrefix}-repair** skill, matching the declared layer conventions. Re-run
   \`${r.cli} check\` between passes and stop early if the open work is not going down.
4. **Validate.** Run the repo's own test command; new tests must pass and the check must
   not regress.
5. **Accept.** ${
    r.policy === "agents"
      ? `Under the configured \`agents\` policy, run \`${r.cli} accept\` once validation passes and no escalations remain, then present the printed trailer to commit with.`
      : `Under the configured \`human\` policy, stop before accept: present \`${r.cli} diff\` versus the sync-point and leave baselining to a person.`
  } Report per stage what you did.

## Rules

- ${acceptRule(r)}
- Never edit the spec without saying so: if a claim seems wrong or missing, report it; do not add or
  reword prescriptive atoms unless the user explicitly asked.
- Never edit \`.tripact/*\` by hand - go through \`${r.cli} resolve\`.
- ${policyNote(r)}
`;
  return { name: `${r.namePrefix}-sync`, content };
}

/**
 * The detect skill: scaffold `tripact.yaml` by classifying the repository's artefacts into
 * prescriptive / descriptive / verificatory layers and declaring the edges between them. tripact has
 * no `init` command - layer detection is a judgement task (which files are the spec? which are docs?),
 * so it is emitted as agent guidance rather than baked into the kernel as a heuristic.
 */
export function detectSkill(opts?: SkillOptions): EmittedSkill {
  const r = resolveOpts(opts);
  const content = `---
name: ${r.namePrefix}-detect
description: >
  Scaffold a tripact.yaml for this repository - classify its files into prescriptive (spec),
  descriptive (docs), and verificatory (test) layers and declare the edges to check between them.
  Use when the user says "set up ${r.cli}", "detect the layers", "scaffold the ${r.cli} config",
  or when \`${r.cli} check\` reports that tripact.yaml is missing.
metadata:
  generatedBy: ${r.namePrefix}@${r.version}
---

# Scaffold a tripact.yaml

tripact needs a \`tripact.yaml\` declaring which files hold requirements, which hold user
documentation, and which hold tests - and which of those must agree. Deciding that is a judgement
call, so it is your job, not a fixed heuristic. Propose the config, confirm with the user, write it.

## Steps

0. **Check for a known spec system first.** If the repo uses a recognised layout, prefer a
   one-line \`kind:\` config over hand-declaring globs - the kernel expands it into the right layers,
   edges, and excludes (and you can still override any of them):
   - **spec-kit** - a \`.specify/\` directory and product specs at \`specs/<feature>/spec.md\` → \`kind: spec-kit\`
     (the \`.specify/\` scaffolding is auto-excluded, never read as the spec).
   - **openspec** - \`openspec/specs/**/spec.md\` (with \`openspec/changes/\` deltas auto-excluded) → \`kind: openspec\`.
   - **strictdoc** - StrictDoc \`.sdoc\` requirement files (parsed natively, not as markdown) → \`kind: strictdoc\`.
   - **kiro** - a flat \`specs/requirements.md\` (+ \`design.md\`, \`tasks.md\`) with numbered EARS
     acceptance criteria → \`kind: kiro\`.
   - **cursor** - feature specs under \`.cursor/specs/*.md\` (template + tasks auto-excluded) → \`kind: cursor\`.
   When one matches, the whole config can be just \`schemaVersion: 1\` + \`kind: <system>\`; add a tests
   layer / edges only if the preset's defaults do not fit. If none matches, hand-declare layers below.
1. **Survey the repository.** Look for each role - do not assume conventional paths:
   - **prescriptive** (the source of truth): a product spec, acceptance criteria, PRD, or
     requirements checklist. Common names: \`SPECS.md\`, \`UAC.md\`, \`REQUIREMENTS.md\`, \`docs/spec/**\`.
     The unit tracked is each Markdown list item.
   - **descriptive** (user-facing docs): manuals, guides, tutorials. Common: \`docs/**/*.md\`,
     \`README\` sections, a \`manual/\` tree. Coverage is evaluated per section.
   - **verificatory** (tests): end-to-end, integration, or unit tests. Detect the framework from
     the repo (Playwright \`*.spec.ts\`, Vitest/Jest \`*.test.ts\`, pytest \`test_*.py\`, …).
2. **Choose layers and globs.** Give each layer a short name and the narrowest glob that captures its
   files. A repo need not have all three - tripact checks only the edges you declare.
3. **Declare edges.** Supported edges are prescriptive↔verificatory and descriptive↔verificatory -
   e.g. \`[specs, tests]\`, \`[docs, tests]\`. (Direct spec↔docs is a reconciliation task, not an edge.)
4. **Write \`tripact.yaml\`** at the repository root. Minimal shape:
   \`\`\`yaml
   schemaVersion: 1
   layers:
     specs:  { role: prescriptive, paths: [SPECS.md] }
     docs:   { role: descriptive,  paths: ['docs/**/*.md'] }
     tests:  { role: verificatory, paths: ['tests/**/*.spec.ts'] }
   edges:
     - [specs, tests]
     - [docs, tests]
   \`\`\`
5. **Verify.** Run \`${r.cli} check\` - it should parse without a config error and report the initial
   drift (everything uncovered until tests are tagged). Then emit the working skills with
   \`${r.cli} skills\` and hand off to the ${r.namePrefix}-repair skill.

## Rules

- Tag conventions: tests reference spec claims with \`@specs:<id>\` and doc sections with
  \`@docs:<slug>\` (override per layer with \`tagPattern\` / \`sectionTagPattern\` if your repo differs).
- Propose, then confirm: show the user the layers and edges you inferred before writing the file.
- Do not invent artefacts. If a role has no files, leave that layer out rather than pointing at
  something that is not really a spec / doc / test.
`;
  return { name: `${r.namePrefix}-detect`, content };
}

/** All portable agent skills the kernel emits: detect (scaffold), adjudicate, repair, and full-loop sync. */
// Emitted in the order an agent meets them: scaffold the config, answer the identity questions,
// link claims to tests that already exist, write the ones that don't, drive the whole loop, then
// decorate the code for navigation. `reconcile` precedes `repair` deliberately - find-or-write
// (§10.1) wants an existing test tagged before a new one is written.
export function agentSkills(opts?: SkillOptions): EmittedSkill[] {
  return [
    detectSkill(opts),
    adjudicateSkill(opts),
    reconcileSkill(opts),
    repairSkill(opts),
    loopSkill(opts),
    hotlinkDecorationSkill(opts),
  ];
}

/**
 * Write the emitted skills under `<repoRoot>/.claude/skills/<name>/SKILL.md`. Existing files are
 * left untouched unless `force`. Returns the repo-relative paths actually written. Deterministic:
 * same options → byte-identical files.
 */
export function emitSkills(
  repoRoot: string,
  opts: SkillOptions & { force?: boolean } = {},
): { written: string[] } {
  const written: string[] = [];
  for (const skill of agentSkills(opts)) {
    const rel = path.join(".claude", "skills", skill.name, "SKILL.md");
    const abs = path.join(repoRoot, rel);
    if (existsSync(abs) && !opts.force) continue;
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, skill.content, "utf8");
    written.push(rel);
  }
  return { written };
}

/**
 * A ready-to-hand-to-an-agent prompt for one derived task - the kind-specific instructions plus the
 * task's own self-contained payload inlined. This is the per-work-item context a foreign harness
 * shells out with, without having to know how each task kind should be worked.
 */
export function taskPrompt(task: Task, opts?: SkillOptions): string {
  const r = resolveOpts(opts);
  const how: Record<string, string> = {
    "write-tests":
      "Write tests that genuinely assert each listed claim, tagging each with the payload's `tagFormat` in the test title. Never tag a test that does not assert the claim.",
    "reconcile-stale":
      "Read the claim and its tagged test. Align whichever drifted: if the test asserts old behaviour, update the test; if the claim text changed, flag it to the user rather than editing the spec without saying so.",
    "fix-orphan-tag":
      `The tag references no live claim. Find the correct live id (\`${r.cli} status --json\`) and fix the tag, or remove it if the claim is gone.`,
    "cover-section":
      "Write or tag a test that walks the docs section's steps, tagged with the payload's `tagFormat`.",
    "reconcile-layers":
      "Judge which prescriptive claims lack user-facing documentation and write the missing sections in the descriptive layer's existing style. Document user-operable behaviour; skip internals.",
    "regenerate-derived":
      "Run the payload's `invocation` to regenerate the stale derived output deterministically. Never hand-edit a generated file.",
  };
  const dispatch = task.effort ? `Suggested effort tier: ${task.effort}${task.model ? ` (model: ${task.model})` : ""}.` : "";
  return [
    `# ${r.cli} task: ${task.title}`,
    "",
    `Kind: ${task.kind}    Id: ${task.id}`,
    dispatch,
    "",
    "## What to do",
    how[task.kind] ?? "Work this task from its payload below.",
    "",
    "## Payload (self-contained)",
    "```json",
    JSON.stringify(task.payload, null, 2),
    "```",
    "",
    "## When done",
    `Validate with \`${r.cli} check\` and the repo's own test command; the check must not regress. Do not edit \`.tripact/*\` by hand.`,
    "",
  ].join("\n");
}

/**
 * A ready-to-hand-to-an-agent prompt for one escalation question - the deleted/created atoms and
 * candidate pairings, plus the exact \`resolve\` commands to answer it.
 */
export function escalationPrompt(q: Escalation, opts?: SkillOptions): string {
  const r = resolveOpts(opts);
  const deleted = q.deleted.map((d) => `  - ${d.id}: "${d.text}"`).join("\n") || "  (none)";
  const created = q.created.map((c) => `  - "${c.text}" (${c.file}:${c.line})`).join("\n") || "  (none)";
  const candidates =
    q.candidates.map((c) => `  - ${c.oldId} ↔ "${c.newText}"  (ratio ${c.ratio.toFixed(2)})`).join("\n") || "  (none)";
  const advisory = q.kind === "fork-review" ? " (advisory - never blocks accept)" : "";
  return [
    `# ${r.cli} escalation: ${q.id}`,
    "",
    `Kind: ${q.kind}${advisory}    Group: ${q.groupPath}`,
    "",
    "Decide, per atom, using the TEXTS as evidence (not the ratios).",
    "",
    "## Old claims that no longer match",
    deleted,
    "",
    "## New texts that match no existing claim",
    created,
    "",
    "## Candidate pairings",
    candidates,
    "",
    "## How to answer",
    `- Same requirement restated → \`${r.cli} resolve ${q.id} --match <old-id>="<new text>"\``,
    `- Genuinely new requirement → \`${r.cli} resolve ${q.id} --new "<new text>"\``,
    `- Requirement removed → \`${r.cli} resolve ${q.id} --dead <old-id>\``,
    q.kind === "fork-review"
      ? `- Genuinely two different requirements → \`${r.cli} resolve ${q.id} --dismiss\``
      : "",
    "",
    `Re-run \`${r.cli} check\` when done. Do not edit \`.tripact/*\` by hand.`,
    "",
  ].join("\n");
}
