<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/tripact-lockup-dark.svg">
  <img src="docs/assets/tripact-lockup.svg" alt="tripact" width="340">
</picture>

**tripact** is a deterministic traceability engine that helps keep your spec, docs and tests in
sync. It is a three-way pact between your product specification, your user documentation, and your
tests. It turns requirements and docs into _claims_ with stable identities, links those claims to
tests through explicit tags, and reports when any side stops agreeing with the others.

It works by parsing every list item in your prescriptive (spec) and descriptive (docs) files into a
**claim**: a normalised statement with a stable, content-derived id. Tests declare which claims they
cover with tags - `@specs:<id>` for spec claims, `@docs:<slug>` for doc sections. On every `check`,
tripact re-derives the claims, **re-anchors** each one to its previous identity so an id survives
rewording, and reports the state of every spec↔test and docs↔test edge: what is covered, what is
newly uncovered, and what went **stale** because a claim or its test changed since it was baselined.

No LLM is used in this process, so the output is deterministic. Any ambiguous claims that require judgement - like "is this reworded requirement functionally the same as it was before, or is it now a new claim?" - are surfaced as a structured queue for you or your agent to answer.

**tripact** is intended to be an **engine** that any agent or harness can drive, because it is an executable that only emits claims and instructions, it doesn't spawn any agents of its own.

- **Spec-driven development with coding agents.** Every specification you write becomes a claim with
  a stable id; tag the test that proves it and tripact confirms the link, so you always know which
  requirements are covered. (Full [walkthrough](#how-it-works) below.)

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
  hashes - it reads queues and shells the work out to agents. See [Inside a harness](#inside-a-harness).

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

## Concepts

tripact works by dividing the files in your repository into three layers: **prescriptive**,
**descriptive**, and **verificatory**.

| Role             | Typical files                          | Unit tracked                                              |
| ---------------- | -------------------------------------- | -------------------------------------------------------- |
| **prescriptive** | product spec, acceptance criteria      | each list item, numbered item, or requirement paragraph is a claim |
| **descriptive**  | user manuals, guides, tutorials        | list items & requirement prose are claims; coverage is per section |
| **verificatory** | unit / integration / end-to-end tests  | tags link tests to claims and sections                   |

The **prescriptive** layer contains specs or acceptance criteria. Any document which says what the
software _should_ do is prescriptive. For example, imagine the following `SPECS.md` file:

```markdown
# Calculator

## Addition

- [ ] add(a, b) returns the sum of two integers
```

The **descriptive** layer contains user manuals, guides, tutorials, or documentation. This layer is
made up of instructional texts which, when followed, produce some outcome or state. For example, a
`docs/addition.md` file:

```markdown
# How to add numbers

1. Click the first number you wish to add
2. Click the plus sign (+)
3. Click the second number you wish to add
4. Press the equal sign (=)
5. The sum of the two numbers is shown below your input.
```

The **verificatory** layer contains your test files. These can be unit tests, e2e tests, or snapshot
tests. In this example, we can imagine that the `add()` function has no tests yet.

tripact atomises more than checkbox lists. In prescriptive and descriptive files, an unordered `- `
item, an ordered `1.` / `1)` item (so EARS/Kiro-style numbered acceptance criteria are tracked), and
any requirement _paragraph_ — one that leads with a bold label (`**User Story:** …`) or contains an
uppercase RFC-2119 keyword (`SHALL`, `MUST`, `SHOULD`) — each become a claim; ordinary prose, code
blocks, and nested items do not. And StrictDoc `.sdoc` files are parsed natively through their typed
`[REQUIREMENT]` nodes rather than as markdown.

A **claim** is a tracked specification with a stable, content-derived id. Each claim is classified
with one of the following statuses (**verdicts**):

| Verdict      | Meaning                                                                                                         |
| ------------ | --------------------------------------------------------------------------------------------------------------- |
| `uncovered`  | no test references the claim (a _new-uncovered_ claim is drift, but _acknowledged_ backlog tasks are not)       |
| `pending`    | a test now references the claim, but the link has not been baselined yet                                        |
| `covered`    | the link was baselined at the last invocation of `tripact accept`                                               |
| `stale`      | the claim text or its test changed since baselining and should be re-verified                                   |
| `orphan tag` | a test tags an id that no live claim owns - fix or remove the tag                                               |
| `escalation` | a reworded claim tripact cannot verify with confidence; answer it by running `tripact resolve` to create a task |

An **edge** is a pair of layers you want to cross-check. Edges are declared in the `tripact.yaml`
config file (see [Configuration](#configuration)). tripact only checks the edges you declare, so it
works even when only a prescriptive or a descriptive layer exists.

- `[specs, tests]` answers **"Do tests exist for all my product specifications?"**
- `[docs, tests]` answers **"Can a user do everything I describe in my docs?"**
- `[specs, docs]` is currently a no-op: deciding whether a paragraph of prose says the same thing as
  a requirement is a judgement call rather than a computable decision. Run
  `tripact tasks --reconcile specs:docs` to generate that judgement task instead.

A core principle of tripact is that if something can be checked without intelligent evaluation, then
tripact checks it. If a judgement call or interpretation is required, the checking is escalated to an
intelligent evaluator, be that a human or an agent. And you tag tests with the claim **id**
(`@specs:<id>`), never the claim prose, which drifts.

## How it works

First, you declare your configuration in `tripact.yaml`. The minimal config looks like this:

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

After authoring a minimal config, run `tripact skills` to emit specialised skills for agents to use.
The `detect` skill will locate the prescriptive / descriptive / verificatory artefacts in your
repository and flesh the config out. (tripact ships no `init` command — classifying a repo's files is
a judgement call, so it ships as agent guidance rather than being baked in as a heuristic.)

Every requirement in your spec files becomes a claim with a content-derived id — each bullet,
numbered item, or requirement paragraph. Given this `SPEC.md`:

```markdown
# Calculator

## Addition

- [ ] add(a, b) returns the sum of two integers
```

running `tripact check` sees the claim but no test covering it:

```console
$ tripact check
edge spec ↔ tests: 0/1 covered
  Addition
    NEW-UNCOVERED addition.adda-b-returns-sum — "add(a, b) returns the sum of two integers" (SPEC.md:5)
✗ drift detected                          # exit 1

$ tripact claims --json                   # list the claim's stable ID - tag tests with this, never the prose
{
  "schemaVersion": 1,
  "claims": [
    { "id": "addition.adda-b-returns-sum", "layer": "spec", "verdict": "uncovered", "alive": true }
  ]
}
```

Tag a test with that id:

```ts
test("@specs:addition.adda-b-returns-sum - adds two integers", () => {
  expect(add(2, 3)).toBe(5);
});
```

You can use `tripact tasks` and `tripact prompt` to generate the instructions for exactly this:

```console
$ tripact tasks
tripact tasks — 1 task(s)

write-tests (1):
  write-tests-0f7f2602b3  Tag an existing test or write one for 1 uncovered claim(s) in "Addition"

$ tripact prompt write-tests-0f7f2602b3 # emits the following:

# tripact task: Tag an existing test or write one for 1 uncovered claim(s) in "Addition"

Kind: write-tests    Id: write-tests-0f7f2602b3

## What to do
Write tests that genuinely assert each listed claim, tagging each with the payload's `tagFormat` in the test title. Never tag a test that does not assert the claim.

## Payload (self-contained)
{
  "group": "Addition",
  "claims": [
    { "id": "addition.adda-b-returns-sum", "text": "add(a, b) returns the sum of two integers" }
  ],
  "tagFormat": "@specs:<id>",
  "options": [
    "tag an existing untagged test that already asserts the claim",
    "write a new tagged test only when none exists"
  ]
}

## When done
Validate with `tripact check` and the repo's own test command; the check must not regress.
Do not edit `.tripact/*` by hand.
```

Once the test is tagged, rerun `tripact check`, then `tripact accept` to baseline the claim:

```console
$ tripact check
    PENDING       addition.adda-b-returns-sum          # linked, awaiting a baseline

$ tripact accept --yes
  tripact-sync-id: 277110193e543841        # baseline written to .tripact/claims.json

$ tripact check
edge spec ↔ tests: 1/1 covered
✓ level                                   # exit 0
```

Reword the claim later and its **identity survives**: the id stays `addition.adda-b-returns-sum`, and
the linked test is flagged **STALE** for re-verification instead of being dropped. A reword too large
to re-anchor with confidence becomes an **escalation**: a question for you or your agent, answered
with `tripact resolve`.

tripact is naive by design: you could write a test that never actually calls `add()` and it would be
marked `covered` once accepted. tripact defers the responsibility of checking _that_ to the caller;
per-language adapters mapping functions to test coverage are planned for the future.

## Configuration

Everything tripact reads comes from one file, `tripact.yaml`, at the repository root. Validation is
all-at-once: every problem in the file is reported in a single pass, so fixing a broken config takes
one round trip, not ten. A config with fewer than two declared layers, an unknown role, an edge
referencing an undeclared layer, a malformed glob, or an unknown `accept.policy` fails validation
with exit code `2` and a message naming the offending key path.

Here is a config using every option:

```yaml
schemaVersion: 1 # config shape version; always 1 today
kind: spec-kit # optional: preset a known spec system (spec-kit | openspec | kiro | strictdoc) — fills in any layers/edges/excludes you omit

layers: # named file sets; at least two required
  specs:
    role: prescriptive # prescriptive | descriptive | verificatory
    paths: [SPECS.md] # globs, relative to the repo root
  docs:
    role: descriptive
    paths: [docs/manual/**/*.md]
    conventions: docs/CONVENTIONS.md # agents read this file before editing the layer
  tests:
    role: verificatory
    paths: [tests/**/*.spec.ts]
    tagPattern: "@specs:([a-z0-9.-]+)" # how tests reference spec claims (default shown)
    sectionTagPattern: "@docs:([a-z0-9.-]+)" # how tests reference doc sections (default shown)

edges: # the layer pairs to cross-check
  - [specs, tests]
  - [docs, tests]

exclude: # globs subtracted from every layer's file set
  - archive/**
  - docs/reference/hotlinks.md # a generated file (see `derived`) must never parse as source claims

pathMap: # code globs → the layers whose claims describe that code
  "src/billing/**": [specs]

accept:
  policy: human # who may baseline: human (default) | agents

routing: # task class → effort tier
  write-tests: implementation
  reconcile-stale: judgment
  fix-orphan-tag: mechanical
models: # effort tier → model identifier
  judgment: anthropic/claude-opus-4-8
  mechanical: anthropic/claude-haiku-4-5

commands:
  test: pnpm test # the validation command task briefs point agents at

runners: # per-tier agent invocations, for whatever drives the loop
  default: 'claude -p "$(cat {promptFile})"'
  mechanical: 'claude -p "$(cat {promptFile})" --model {model}'

derived: # generated outputs whose freshness `check` verifies
  hotlink-map:
    output: docs/reference/hotlinks.md
    generator: hotlink-map # a builtin, or any shell command that prints the file

codeLinks: # navigational code↔spec links; never a layer, never an edge
  paths: [src/**/*.ts]
```

| Key                                | What it does                                                                                                                                                                                                                           |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schemaVersion`                    | Config shape version; always `1` today.                                                                                                                                                                                               |
| `kind`                             | Optional top-level preset naming a known spec system (`spec-kit`, `openspec`, `kiro`, `strictdoc`). Expands into layers/edges/excludes so a config can be `schemaVersion` + `kind` alone. User-first — anything you declare wins. See [Spec-system presets](#spec-system-presets). |
| `layers`                           | The named file sets and their roles. At least two are required; a layer only participates through the edges that name it. `paths` are repo-relative globs. `conventions` optionally points at a house-style file agents read first.   |
| `tagPattern` / `sectionTagPattern` | Per-layer regexes (one capture group each) scanned in verificatory files: `tagPattern` captures claim ids, `sectionTagPattern` doc-section slugs. Defaults `@specs:(…)` / `@docs:(…)`. Repair briefs inherit the configured format.   |
| `edges`                            | The layer pairs to cross-check; both names must be declared layers. prescriptive↔verificatory checks claim coverage; descriptive↔verificatory checks per-section coverage; prescriptive↔descriptive is not computed.                  |
| `exclude`                          | Globs subtracted from every layer's file set after collection: archived copies, vendored trees, and generated outputs that would otherwise parse as source claims. Always add `derived` outputs here.                                 |
| `pathMap`                          | Code globs → the layers whose claims describe that code. When a path changed since the last sync point matches a glob, `check` warns those layers' claims may be stale and lists them under `affectedLayers`. How code drift enters.   |
| `accept.policy`                    | Who may baseline: `human` (default — `accept` confirms interactively and `mcp-serve` exposes no accept tool) or `agents` (the sync skill may run `accept` after validation, and MCP exposes it).                                      |
| `routing` / `models`               | Advisory dispatch hints: `routing` maps a task class to an effort tier (`judgment`, `planning`, `implementation`, `mechanical`); `models` maps a tier to a model id. They surface as `effort`/`model` on tasks. tripact never calls a model. |
| `commands.test`                    | The repo's own validation command. Task briefs and emitted skills point agents at it: the check must not regress, and this must pass.                                                                                                 |
| `runners`                          | Command templates keyed by effort tier or `default`, interpolating `{promptFile}`, `{model}`, `{cwd}`. tripact validates and passes them through; executing them is the driver's job.                                                 |
| `derived`                          | Generated files: each entry names an `output` path and a `generator` (the `hotlink-map` builtin, or any shell command that prints the file). `check` flags outputs that drift or are non-deterministic; `tripact generate` rewrites them. |
| `codeLinks`                        | A product-code file set scanned for claim-id tags — code↔spec navigation surfaced by `tripact hotlinks` and the `hotlink-map` generator. Outside `layers`/`edges`: a tag here never makes a claim covered. `tagPattern` defaults to the verificatory layer's. |

### Spec-system presets

If your repo already uses a known spec system, set a top-level `kind:` and tripact fills in the
layers, edges, and excludes for you — a whole config can be as small as:

```yaml
schemaVersion: 1
kind: openspec
```

| `kind:`     | Spec system     | What the preset declares                                                                              |
| ----------- | --------------- | ---------------------------------------------------------------------------------------------------- |
| `spec-kit`  | GitHub spec-kit | prescriptive `specs/*/spec.md`; excludes the `.specify/` scaffolding so it never counts as the spec  |
| `openspec`  | OpenSpec        | prescriptive `openspec/specs/**/spec.md`; excludes per-change deltas under `openspec/changes/`        |
| `kiro`      | AWS Kiro        | prescriptive `specs/requirements.md` (EARS numbered acceptance criteria)                              |
| `strictdoc` | StrictDoc       | all `.sdoc` files as prescriptive, parsed by the SDOC parser                                          |

Each preset also seeds a conventional verificatory `tests` layer and a `[spec, tests]` edge, so a
`kind:`-only config still clears the two-layer floor with the correct all-uncovered baseline.
Expansion is **user-first**: anything you declare explicitly wins, and the preset only supplies the
layers, edges, and excludes you leave out. The same registry powers detection — the `tripact-detect`
skill fingerprints these systems on disk from their signature files. An unknown `kind` fails
validation with exit code `2`, naming the accepted systems.

## CLI reference

Every command follows the same three conventions:

| Convention   | Detail                                                                                                                                                                            |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Exit codes   | `0` = level (nothing to do), `1` = drift / work exists, `2` = usage or environment error. Scripts and harnesses branch on these.                                                  |
| `--json`     | A machine-readable document on stdout with a top-level `schemaVersion`. The shapes are a versioned public contract — see [public-contract.md](./docs/architecture/public-contract.md). |
| Human output | Long listings truncate past a fixed threshold; `--long` prints everything. Truncation never touches `--json`, which always carries the full list.                                 |

| Command                                                     | What it does                                                                                                                                                        | Exit          |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| `check [--json] [--all] [--strict] [--long]`                | The drift check across every declared edge, scoped to what changed since the last sync point (`--all` audits the full tree). `--strict` counts acknowledged backlog as drift — the release gate. Writes open escalations to `.tripact/escalations.json`. | 0 level / 1 drift |
| `status [--json]`                                           | One-screen summary: counts per layer and coverage per edge.                                                                                                          | 0 / 1         |
| `claims [--json] [--all]`                                   | Every alive claim with its id, layer, group path, text and best verdict — the ids you tag tests with. `--all` includes dead claims.                                  | 0             |
| `audit <claim-id> [--json] [--long]`                        | The recorded history of one claim: creation, re-anchorings, adjudications, verifying-test history. Sidecar archaeology for "why is this covered?".                   | 0             |
| `tasks [--json] [--reconcile <pair>] [--long]`              | Derives the repair/generation work queue. Each task carries a self-contained `payload`, plus `effort`/`model` hints when `routing`/`models` are set.                 | 1 while tasks / 0 empty |
| `prompt <id> [--reconcile <pair>]`                          | Prints the ready-to-hand-off brief for one work item — a `tasks` id or an escalation question id — with its payload inlined.                                         | 0             |
| `reconcile [--json]` · `reconcile --dismiss <id> <f> <ln>`  | Proposes existing untagged tests that may already assert an uncovered claim (for adopting tripact on a repo that already has tests). `--dismiss` records a rejected pairing. | 0        |
| `hotlinks [--json]`                                         | The navigational code↔spec link map from the configured `codeLinks` file set. Advisory, never gates.                                                                 | 0             |
| `resolve <question-id> --match \| --new \| --dead \| --dismiss` | Applies an adjudication answer to an escalation: reworded atom is the same claim (`--match`), a new one (`--new`), the old claim is dead (`--dead`), or dismiss an advisory fork. The only way escalations get answered. | 0 |
| `diff [--json]`                                             | A preview of what acceptance would change: created, re-anchored and retired claims, state deltas, and the would-be trailer. Writes nothing.                          | 0             |
| `accept [--dry-run] [--yes]`                                | Writes anchoring and verified states to `.tripact/claims.json` and prints the `tripact-sync-id: <hash>` trailer. Confirms interactively unless `--yes`. Refuses while escalation questions are open. | 1 if questions open |
| `verify <hash>`                                             | Compares a `tripact-sync-id` trailer value against the current sidecar's content hash. How CI proves a build sits at a known sync point.                             | 0 match / 1 mismatch |
| `generate [name]`                                           | Regenerates declared derived outputs and writes them to disk — deterministic, byte-identical across runs. No name regenerates every declared output.                 | 0             |
| `skills [--dir <path>] [--force]`                           | Emits the six agent skills as `.claude/skills/tripact-<name>/SKILL.md`. Existing files are left untouched unless `--force`; `--dir` overrides the output root.       | 0             |
| `mcp-serve`                                                 | Serves the engine over MCP stdio: read tools `check`, `status`, `claims`, `tasks`, `escalations`, plus `resolve`. `accept` is exposed only under `accept.policy: agents`. | (server)   |

## Usage

### As agent instructions

For a single coding agent (Claude Code, Cursor, Codex — anything that reads skill files or an
instructions file), the integration is two commands and a few lines of memory:

```console
$ npm install -D tripact
$ npx tripact skills          # writes .claude/skills/tripact-*/SKILL.md
```

The six emitted skills teach the agent every job in the lifecycle, using only engine commands:

| Skill                        | Teaches the agent to                                                     |
| ---------------------------- | ------------------------------------------------------------------------ |
| `tripact-detect`             | classify the repo's files into layers and scaffold `tripact.yaml`        |
| `tripact-adjudicate`         | answer open escalation questions with `tripact resolve`                  |
| `tripact-repair`             | work one repair/generation task from its self-contained payload          |
| `tripact-reconcile`          | link existing untagged tests to claims they already assert               |
| `tripact-hotlink-decoration` | decorate product code with claim-id hotlinks                             |
| `tripact-sync`               | run the whole loop: check → adjudicate → repair → validate → accept gate |

Then point the agent at the tool from your instructions file (`CLAUDE.md`, `AGENTS.md`, …):

```markdown
## Traceability

- After changing the spec, the docs, or tests, run `tripact check`.
- If it exits 1, run the tripact-sync skill and work the queue back to level.
- Never edit `.tripact/*` by hand; answer escalations with `tripact resolve`.
- `tripact accept` is a human decision — propose it, never run it.
```

(The last line matches `accept.policy: human`; drop it once you have granted `agents`.)

If you prefer tools over shell commands, serve the same surface over MCP:

```console
$ claude mcp add tripact -- npx tripact mcp-serve
```

Both routes have the same property: every brief the agent receives is self-contained — claim text,
tag format and the allowed options are inlined — and every claim of progress it makes is checkable by
re-running `tripact check`. The agent never has to hold your traceability state in its head; that is
the sidecar's job.

### Inside a loop

For an interactive agent the loop already ships: the `tripact-sync` skill _is_ the loop, with the
gates spelled out — adjudicate before repair, validate before accept, stop early if the open work
stops shrinking.

For a headless loop, the exit codes are the control flow: `check` exits 1 while drift exists, `tasks`
exits 1 while the queue is non-empty, and `accept` refuses while questions are open. A complete
drift-repair loop with a CLI agent:

```bash
for round in 1 2 3; do                     # bound the rounds — never loop unattended forever
  tripact check && break                   # exit 0: level, done

  # adjudicate first: accept refuses while identity questions are open
  tripact check --json | jq -r '.escalations[].id' | while read -r q; do
    tripact prompt "$q" | claude -p        # the brief has the agent apply its answer via `tripact resolve`
  done

  # then work the task queue
  tripact tasks --json | jq -r '.tasks[].id' | while read -r t; do
    tripact prompt "$t" | claude -p --permission-mode acceptEdits
  done

  pnpm test                                # the repo's own validation — check alone is not enough
done

tripact diff                               # a human reads what acceptance would baseline
tripact accept                             # interactive gate (or --yes under accept.policy: agents)
```

`claude -p` is interchangeable with any agent CLI (`codex exec`, …). If `routing`/`models` are
configured, each task in `tasks --json` carries `effort` and `model` fields and `runners` in
`tripact.yaml` holds the per-tier invocation template, so the middle of the loop collapses to "for
each task, run its runner". The round bound matters: repair converges when the queue shrinks every
round; a queue that has stopped shrinking is a signal for a human, not for round four.

### Inside a harness

A harness like [Archon](https://github.com/coleam00/Archon) builds coding workflows out of YAML:
nodes that run scripts, prompt agents, branch, loop, and stop for approval, triggered from a PR, a
schedule, or chat. The division of labour with tripact is clean: **the harness owns the loop** —
ordering, retries, approval gates, PR creation, the audit trail. **tripact owns the truth** — what
drifted, what work exists, what is safe to baseline. The workflow never needs to understand claims,
hashes or re-anchoring, because every step it takes is a `--json` command it can branch on.

A drift-repair workflow (node syntax illustrative — the control flow and the tripact commands are the
actual contract):

```yaml
name: tripact-drift-loop
trigger: { on: pull_request }

nodes:
  - id: check
    run: "tripact check --json"
    capture: { stdout: report, exit_code: code }
  - branch: { when: "code == 0", then: stop } # level — report green
  - branch: { when: "code == 2", then: fail } # config/env error — surface it

  # adjudicate before repair: accept refuses while questions are open
  - loop:
      over: "{{ report.escalations }}"
      as: q
      do:
        - run: "tripact prompt {{ q.id }}"
          capture: { stdout: brief }
        - prompt: { input: "{{ brief }}", model_tier: judgment }
          # the brief has the agent apply its answer via `tripact resolve`

  - id: tasks
    run: "tripact tasks --json"
    capture: { stdout: queue }
  - loop:
      over: "{{ queue.tasks }}"
      as: t
      do:
        - run: "tripact prompt {{ t.id }}"
          capture: { stdout: brief }
        - prompt: { input: "{{ brief }}", model_tier: "{{ t.effort }}" } # honour the routing hint

  - run: "pnpm test" # or read commands.test from tripact.yaml
  - approval: "Baseline this as the new sync point?" # the human gate, as a node
  - id: accept
    run: "tripact accept --yes"
    capture: { stdout: trailer }
  - github.pr:
      commit_body: "{{ trailer }}" # tripact-sync-id: <hash> — checkable later with `tripact verify`
```

The mapping generalises to any workflow-driven harness: script node → a tripact command, loop node →
one of the queues, prompt node → `tripact prompt <id>`, approval node → the accept gate. The
`routing`/`models` hints exist exactly so the harness can route each task to the right model tier
without inventing its own task classification.

### Inside a software factory

At fleet scale the properties that matter change. One agent repairing drift needs a good brief;
twenty agents need to agree on what the work _is_ without talking to each other. tripact works at this
scale because:

- **Discovery happens once, not per agent.** `check --json` and `tasks --json` produce the same queue
  for every reader. Workers execute the list; they never invent their own view of the drift.
- **Tasks shard by construction.** Task ids are stable content-derived hashes and every payload is
  self-contained, so a dispatcher can hand `tripact prompt <id>` briefs to N workers — each in its own
  worktree — without coordination between them.
- **Cost follows the routing table.** `routing`/`models` put an effort tier and model on every task:
  `fix-orphan-tag` goes to a cheap model, `reconcile-stale` to a strong one, and `runners` gives the
  dispatcher the invocation template per tier.
- **Escalations are a separate lane.** Repair tasks parallelise; identity questions go to a judgment
  lane — a strong model or a human — because `accept` refuses while any are open.
- **There is exactly one write gate.** Everything except `resolve` and `accept` is read-only.
  `accept` is the single baseline write, once per round, after validation — the one serialisation
  point in the factory.
- **Provenance survives the factory.** Every baseline prints a `tripact-sync-id` trailer for the
  commit, and `tripact verify <hash>` in CI proves which sync point a build sits at, no matter how
  many agents produced it.

### As a library

The engine is also importable — the same documents the CLI prints, as data:

```ts
import { analyze, toJsonReport, deriveTasks } from "tripact";

const analysis = analyze(process.cwd());
const report = toJsonReport(analysis); // the same document `check --json` prints
const queue = deriveTasks(analysis); // the same document `tasks --json` prints
```

`buildServer` / `serveMcp` are exported too, so a harness can embed the MCP server under its own
identity. So are the prompt/skill generators: `agentSkills`, `adjudicateSkill`, `repairSkill`,
`taskPrompt`, `escalationPrompt`.

## Transitional notes

Extracted pre-alpha:

- **No `init`, no run-book execution.** Layer detection is emitted as the `detect` skill (a
  judgement call rather than a built-in heuristic); run-book _execution_ stays a harness concern.
  Skill and prompt _emission_ live in the engine.
- **Pre-alpha (0.x).** The public contract (`--json` schemas, exit codes, MCP tools) is versioned
  but still evolving; breaking changes may land in minor 0.x bumps. Pin an exact version.
