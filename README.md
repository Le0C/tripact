# tripact

**tripact** is a deterministic traceability engine that helps keep your spec, docs and tests in
sync. It a three-way pact between your product specification, your user documentation, and your
tests. It turns requirements and docs into _claims_ with stable identities, links those claims to
tests through explicit tags, and reports when any side stops agreeing with the others.

It works by parsing every list item in your prescriptive (spec) and descriptive (docs) files into a
**claim**: a normalised statement with a stable, content-derived id. Tests declare which claims they
cover with tags - `@specs:<id>` for spec claims, `@docs:<slug>` for doc sections. On every `check`,
tripact re-derives the claims, **re-anchors** each one to its previous identity so an id survives
rewording, and reports the state of every spec↔test and docs↔test edge: what is covered, what is
newly uncovered, and what went **stale** because a claim or its test changed since it was baselined.

No LLM is used in this process, so the output is deterministic. Any ambiguous claims that require judgement - like "is this reworded requirement functionally the same as it was before, or is it now a new claim?" - are surfaced as a structured queue for you or your agent to answer.

**tripact** is intended to be a **engine** that any agent or harness can drive, because it is an executable that only emits claims and instructions, it doesn't spawn any agents of its own.

- **Spec-driven development with coding agents.** Every specification you write becomes a claim with
  a stable id; tag the test that proves it and tripact confirms the link, so you always know which
  requirements are covered. (Full [walkthrough](#walkthrough) below.)

  ```console
  $ tripact check                 # a spec claim exists, but no test references it
  edge spec ↔ tests: 0/1 covered
    NEW-UNCOVERED addition.adda-b-returns-sum — "add(a, b) returns the sum of two integers"
  ✗ drift detected                # exit 1

  # …tag the test with @specs:addition.adda-b-returns-sum, baseline once…
  $ tripact check
  edge spec ↔ tests: 1/1 covered
  ✓ level                         # exit 0 - the requirement is provably tested
  ```

- **Archon or another workflow-driven harness.** Archon owns the loop; every step it needs from
  tripact is a deterministic `--json` command, so the workflow never has to understand claims or
  hashes - it reads queues and shells the work out to agents. The node DSL below is _illustrative_.

  ```yaml
  trigger: pull_request
  steps:
    - run: tripact check --json           # exit 0 clean → stop; 1 → work exists; 2 → fail the run
    - for_each: "{{ check.escalations }}"  # reworded claims the engine won't guess at
        agent: decide same-or-new          # → tripact resolve <id> --match|--new|--dead
    - run: tripact tasks --json            # the repair / generation task queue
    - for_each: "{{ tasks.tasks }}"
        agent: "{{ shell: tripact prompt <id> }}"   # a per-task brief, with payload inlined
    - run: npm test                        # your test suite
    - approve: "Baseline this?"            # acceptance policy (escalate to a human or agent based on config)
    - run: tripact accept                  # prints the tripact-sync-id commit trailer
  ```

- **An agentic coding loop.** tripact links the loop's _goal_ to its _verification_: the spec claims
  are the goals and the tagged tests are the evidence that each one is met. Open the loop by writing
  or refining the spec (`tripact check` shows what is newly uncovered); close it by running
  `tripact check` again to prove every goal is linked to a test. Where one isn't, `tripact tasks`
  plus `tripact prompt <id>` (or the emitted `tripact skills`) hand the agent the repair work with
  its context already inlined.

## Install

Requires Git and Node.js ≥ 22.

```bash
npm install tripact
```

> Pre-alpha (0.x): the `--json` contract and CLI are still moving. Pin an exact version.

## Walkthrough

Take a one-claim spec from uncovered to provably tested. Given `SPEC.md`:

```markdown
# Calculator

## Addition

- [ ] add(a, b) returns the sum of two integers
```

and a `tripact.yaml` declaring a `spec` (prescriptive) → `tests` (verificatory) edge, tripact sees
the claim but no test covering it:

```console
$ tripact check
edge spec ↔ tests: 0/1 covered
  Addition
    NEW-UNCOVERED addition.adda-b-returns-sum — "add(a, b) returns the sum of two integers" (SPEC.md:5)
✗ drift detected                          # exit 1

$ tripact claims --json                   # the claim's stable id - tag tests with this, never the prose
{
  "schemaVersion": 1,
  "claims": [
    { "id": "addition.adda-b-returns-sum", "layer": "spec", "verdict": "uncovered", "alive": true }
  ]
}
```

Tag the test with that id:

```ts
test("@specs:addition.adda-b-returns-sum - adds two integers", () => {
  expect(add(2, 3)).toBe(5);
});
```

The claim is now linked but not yet baselined; `accept` records the baseline, and the next check is
level:

```console
$ tripact check
    PENDING       addition.adda-b-returns-sum          # linked, awaiting a baseline

$ tripact accept --yes
  tripact-sync-id: 277110193e543841        # baseline written to .tripact/claims.json

$ tripact check
edge spec ↔ tests: 1/1 covered
✓ level                                   # exit 0 - the requirement is provably tested
```

Reword the claim later and its **identity survives**: the id stays `addition.adda-b-returns-sum`, and
the linked test is flagged **STALE** for re-verification instead of being dropped. A reword too
large to re-anchor with confidence becomes an **escalation**: a question for you or your agent,
answered with `tripact resolve`.

## Two ways to use it

### 1. As a CLI a harness shells out to

The thin `tripact` binary exposes the engine commands. Each `--json` document is a versioned public
contract (see [docs/architecture/public-contract.md](./docs/architecture/public-contract.md)):

```bash
tripact check --json        # deterministic drift check → exit 0 level, 1 drift, 2 error
tripact tasks --json        # create a repair/generation work queue
tripact claims --json       # print every claim + its id (use these ids when tagging tests)
tripact resolve <question-id> --match '<claim-id>="reworded text"'   # answer an escalation: this reworded text is still <claim-id>
tripact diff                # preview what accept would baseline; writes nothing
tripact accept --yes        # baseline the tree; prints the tripact-sync-id trailer
tripact verify <hash>       # check a trailer against the current sidecar
tripact generate [name]     # regenerate declared derived outputs (deterministic)
tripact skills              # emit detect/adjudicate/repair/sync agent skills to .claude/skills/
tripact prompt <id>         # print a ready-to-run prompt for one task or escalation
tripact mcp-serve           # serve the read tools + resolve over MCP stdio
```

A typical loop using these commands:

1. `tripact check` reports drift and writes any escalations.
2. An agent answers each escalation through the `adjudicate` skill (`tripact resolve`).
3. `tripact tasks` derives the work queue; an agent works each item from its `tripact prompt <id>` brief.
4. `tripact check` again, against the diff, to confirm the tree is level.
5. `tripact accept` baselines.

### 2. As a library

```ts
import { analyze, toJsonReport, deriveTasks } from "tripact";

const analysis = analyze(process.cwd());
const report = toJsonReport(analysis); // the same document `check --json` prints
const queue = deriveTasks(analysis); // the same document `tasks --json` prints
```

`buildServer` / `serveMcp` are exported too, so a harness can embed the MCP server under its own identity. So are the prompt/skill generators: `agentSkills`, `adjudicateSkill`, `repairSkill`, `taskPrompt`, `escalationPrompt`.

### Agent skills & per-item prompts

tripact emits the prompts an agent needs to _work_ the queues; the consuming harness is responsible for running the tasks. `tripact skills` writes four `.claude/skills/<name>/SKILL.md` files - `detect` (scaffold a `tripact.yaml` by classifying the repo's files into layers), `adjudicate`, `repair`, and `sync` - that teach an agent how to set up tripact, answer escalations, and repair drift using only engine commands. `tripact prompt <id>` prints a ready-to-hand-off brief for a single task or escalation, with its self-contained payload inlined: the per-work-item context a foreign harness shells out with.

## Concepts

**Layers and roles.** You group your files into named _layers_, each with one of three roles:

| Role             | Typical files                         | Unit tracked                                             |
| ---------------- | ------------------------------------- | -------------------------------------------------------- |
| **prescriptive** | product spec, acceptance criteria     | each list item is a claim                                |
| **descriptive**  | user manuals, guides                  | list items are claims; coverage is evaluated per section |
| **verificatory** | end-to-end / integration / unit tests | tags link tests to claims and sections                   |

**Edges.** You declare which layers must agree, e.g. `[spec, tests]`. **tripact** only checks the
edges you declare, so it works even when only a prescriptive or a descriptive layer exists. Direct
spec↔docs comparison is a judgement task, offered as a reconciliation step rather than checked
programmatically.

**Claims and ids.** Each tracked item becomes a claim with a stable id derived from its group path
and normalised text. Tag tests with the id (`@specs:<id>`), never with the claim prose, which drifts.

**The verdict lifecycle.** Every claim sits at one verdict, and `check` reports the set:

| Verdict      | Meaning                                                                                                     |
| ------------ | ----------------------------------------------------------------------------------------------------------- |
| `uncovered`  | no test references the claim (a _new-uncovered_ claim is drift, but _acknowledged_ backlog tasks are not)   |
| `pending`    | a test now references the claim, but the link has not been baselined yet                                    |
| `covered`    | the link was baselined at the last `accept`                                                                 |
| `stale`      | the claim text or its test changed since baselining - re-verify                                             |
| _orphan tag_ | a test tags an id that no live claim owns - fix or remove the tag                                           |
| _escalation_ | a reworded claim tripact cannot re-anchor with confidence; answer it with `resolve` - tripact never guesses |

`accept` baselines the current tree and prints a `tripact-sync-id: <hash>` trailer; `verify <hash>`
later confirms the sidecar has not changed since.

## Configuration

tripact reads `tripact.yaml` from the repository root: a declaration of the layers it tracks
(prescriptive / descriptive / verificatory) and the edges to check between them. Minimal example:

```yaml
schemaVersion: 1
layers:
  specs:
    role: prescriptive
    paths: [SPECS.md]
  docs:
    role: descriptive
    paths: [docs/manual/**/*.md]
  tests:
    role: verificatory
    paths: [tests/**/*.spec.ts]
edges:
  - [specs, tests]
  - [docs, tests]
```

Author a minimal config, run `tripact skills`, and then use the emitted `detect` skill to locate the prescriptive / descriptive / verificatory artefacts and flesh the config out. tripact ships no `init` command - classifying a repo's files is a judgement call, so it ships as agent guidance rather than being baked in as a heuristic.

## Transitional notes

Extracted pre-alpha:

- **No `init`, no run-book execution.** Layer detection is emitted as the `detect` skill (a
  judgement call rather than a built-in heuristic); run-book _execution_ stays a harness concern.
  Skill and prompt _emission_ live in the engine.
- **Pre-alpha (0.x).** The public contract (`--json` schemas, exit codes, MCP tools) is versioned
  but still evolving; breaking changes may land in minor 0.x bumps. Pin an exact version.
