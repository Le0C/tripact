Today I am launching **tripact** (github), which is a traceability engine for spec driven development. It ships a CLI tool, and it does a few things:

- Ties together your specs, tests & documentation into claims with stable identifiers that survive reformatting or rewording
- Escalates ambiguous claims to a task queue for intelligent evaluation
- Generates ordered task queues when specs are added or changed

Tripact is a plain old program, i.e. it doesn't use any LLM under the hood. It is designed to be usable by agents, in a harness, in a loop or in a software factory (if you've got the token budget!).

It does this by writing output in JSON, having stable exit codes (0=level, 1=drift, 2=error) and emitting skill files for specific tasks in the lifecycle.

## Concepts

Tripact works by dividing files in your repository into three layers: **prescriptive**, **descriptive** and **verificatory**.

The **prescriptive** layer contains specs or acceptance criteria. Any document which says what the software **should** do, is prescriptive. For example, imagine the following `SPECS.md` file:

```markdown
# Calculator

## Addition

- [ ] add(a, b) returns the sum of two integers
```

The **descriptive** layer contains user manuals, guides, tutorials, or documentation. This layer is made up of instructional texts, which when followed, produce some outcome or state. For example, imagine the following `docs/addition.md` file:

```markdown
# How to add numbers

1. Click the first number you wish to add
2. Click the plus sign (+)
3. Click the second number you wish to add
4. Press the equal sign (=)
5. The sum of the two numbers is shown below your input.
```

The **verificatory** layer contains your test files. These can be unit tests, e2e tests, or snapshot tests. In this example, we can imagine that the `add()` function has no tests yet.

A **claim** is a tracked specification with a stable ID. Each **claim** is classified with one of the following statuses (called **Verdicts**): `uncovered`, `pending`, `covered`, `stale`, `orphan tag` or `escalation`:

| Verdict      | Meaning                                                                                                         |
| ------------ | --------------------------------------------------------------------------------------------------------------- |
| `uncovered`  | no test references the claim (a *new-uncovered* claim is drift, but *acknowledged* backlog tasks are not)       |
| `pending`    | a test now references the claim, but the link has not been baselined yet                                        |
| `covered`    | the link was baselined at the last invocation of `tripact accept`                                               |
| `stale`      | the claim text or its test changed since baselining and should be re-verified                                   |
| `orphan tag` | a test tags an id that no live claim owns - fix or remove the tag                                               |
| `escalation` | a reworded claim tripact cannot verify with confidence; answer it by running `tripact resolve` to create a task |

Next we have the concept of an **edge** which is a pair of layers you want to cross check. These edges are declared in the `tripact.yaml` config file, which we will cover [later](#configuration).

- `[specs, tests]`: Declaring this edge means that you want tripact to check that the product specifications and tests are in sync. This answers the question "Do tests exist for all my product specifications?"
- `[docs, tests]`: Declaring this edge means that you want tripact to check that every procedure in the manual has sufficient test coverage. This answers the question "Can a user do everything I describe in my docs?".
- `[specs, docs]`: Declaring this edge is currently a no-op for tripact, because deciding whether a paragraph of prose says the same thing as a requirement is a judgement call rather than a computable decision.

A core principle of tripact is that if something can be checked without intelligent evaluation, then tripact should check it. If a judgment call or interpretation is required, the checking should be escalated to an intelligent evaluator, be that human or agent.

## How it works

Firstly, you declare your configuration with `tripact.yaml`. The minimal config looks something like this:

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

After authoring a minimal config, you can run `tripact skills` to emit specialised skills for agents to use. The skill `detect` will attempt to locate the prescriptive / descriptive / verificatory artefacts in your repository and flesh out the config.

Next, every list item in your spec files becomes a claim, with a content derived ID. For example, the following feature is prescribed in `SPEC.md`:

```markdown
# Calculator

## Addition

- [ ] add(a, b) returns the sum of two integers
```

If you run `tripact check` you will get the following output:

```console
$ tripact check
edge spec ↔ tests: 0/1 covered
  Addition
    NEW-UNCOVERED addition.adda-b-returns-sum — "add(a, b) returns the sum of two integers" (SPEC.md:5)
✗ drift detected                          # exit 1

$ tripact claims --json                   # list the claim's stable ID
{
  "schemaVersion": 1,
  "claims": [
    { "id": "addition.adda-b-returns-sum", "layer": "spec", "verdict": "uncovered", "alive": true }
  ]
}
```

Then, tag a unit test with that id:

```ts
test("@specs:addition.adda-b-returns-sum - adds two integers", () => {
  expect(add(2, 3)).toBe(5);
});
```

Note that you can use `tripact tasks` & `tripact prompt` to generate instructions for this:

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

After the test is tagged, rerun `tripact check` and `tripact accept` to baseline this claim:

```console
$ tripact check
    PENDING       addition.adda-b-returns-sum          # linked, awaiting a baseline

$ tripact accept --yes
  tripact-sync-id: 277110193e543841        # baseline written to .tripact/claims.json

$ tripact check
edge spec ↔ tests: 1/1 covered
✓ level                                   # exit 0
```

Tripact is naive by design: you could write a test which doesn't actually call the `add()` function which would be marked as `covered` once accepted. Tripact defers the responsibility of checking this to the caller; per-language adapters for function mapping to test coverage are planned for the future.

## Configuration

Everything tripact reads comes from one file, `tripact.yaml`, at the repository root. Validation is all-at-once: every problem in the file is reported in a single pass, so fixing a broken config takes one round trip, not ten.

Here is a config using every option:

```yaml
schemaVersion: 1 # config shape version; always 1 today

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

**`layers`** declares the named file sets and their roles. At least two layers are required, and a layer only participates in checking through the edges that name it. `paths` are repo-relative globs. `conventions` optionally points at a file describing the layer's house style; the emitted repair skill tells agents to read it before touching the layer.

**`tagPattern` / `sectionTagPattern`** are regexes (each with one capture group) that the verificatory layer's files are scanned with: `tagPattern` captures claim ids, `sectionTagPattern` captures doc-section slugs. The defaults are `@specs:([a-z0-9.-]+)` and `@docs:([a-z0-9.-]+)`. Repair tasks derive their instructed tag format from the configured pattern, so a custom vocabulary like `@covers:(…)` flows through to the agent brief instead of silently never matching.

**`edges`** lists the pairs to cross-check; both names must be declared layers. A prescriptive↔verificatory edge checks claim coverage, a descriptive↔verificatory edge checks per-section coverage, and prescriptive↔descriptive is not computed — run `tripact tasks --reconcile specs:docs` to generate the judgement task instead.

**`exclude`** subtracts globs from every layer's file set after collection: archived copies, vendored trees, and generated outputs that would otherwise parse as source claims.

**`pathMap`** is how code drift enters without code being a layer. When a path that changed since the last sync point (uncommitted changes included) matches a glob, `check` warns that the mapped layers' claims may no longer describe the product, and lists them under `affectedLayers` in the JSON report.

**`accept.policy`** decides who baselines. Under `human` (the default), `accept` confirms interactively and `mcp-serve` does not expose an accept tool at all; under `agents`, the emitted sync skill may run `accept` once validation passes, and the MCP server exposes it.

**`routing` and `models`** attach advisory dispatch hints to the work tripact emits: `routing` maps a task class to an effort tier (`judgment`, `planning`, `implementation`, `mechanical`), and `models` maps a tier to a model identifier. Configured hints appear as `effort` and `model` fields on tasks and escalations. Task classes are the kinds `tasks` emits (`write-tests`, `reconcile-stale`, `fix-orphan-tag`, `cover-section`, `reconcile-layers`, `regenerate-derived`), plus `adjudicate` for escalation questions and the `derive-prescriptive` / `derive-descriptive` / `derive-verificatory` bootstrap kinds. These are hints for whatever dispatches the work — tripact itself never calls a model.

**`commands.test`** names the repo's own validation command. Task briefs and the emitted skills point agents at it: the check must not regress, and this must pass.

**`runners`** are command templates keyed by effort tier or `default`, interpolating `{promptFile}`, `{model}` and `{cwd}`. tripact validates them and passes them through; executing them is the driver's job (see the loop and harness examples below). The engine never spawns an agent.

**`derived`** declares generated files: each entry names an `output` path and a `generator` — any shell command that prints the file, or a builtin name. `hotlink-map` is builtin (it renders the code↔spec link map); `cli-reference` is a reserved name a consuming harness can register to render its own command tree. `check` flags outputs that drift from their generator (`derivedStale`) and generators that are not byte-stable (`nonDeterministicGenerators`); `tripact generate` rewrites them. Always add derived outputs to `exclude`.

**`codeLinks`** declares a product-code file set scanned for claim-id tags — navigation between code and spec, surfaced by `tripact hotlinks` and the `hotlink-map` generator. It sits deliberately outside `layers`/`edges`: a tag here never makes a claim covered. Its `tagPattern` defaults to the verificatory layer's, so tests and code share one tag vocabulary.

## CLI Reference

Every command follows the same three conventions:

| Convention   | Detail                                                                                                                                                                            |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Exit codes   | `0` = level (nothing to do), `1` = drift / work exists, `2` = usage or environment error. Scripts and harnesses branch on these.                                                  |
| `--json`     | A machine-readable document on stdout with a top-level `schemaVersion`. The shapes are a versioned public contract — see [public-contract.md](./architecture/public-contract.md). |
| Human output | Long listings truncate past a fixed threshold; `--long` prints everything. Truncation never touches `--json`, which always carries the full list.                                 |

**`tripact check [--json] [--all] [--strict] [--long]`**
The drift check across every declared edge. Scoped to what changed since the last sync point; `--all` audits the full tree regardless. `--strict` counts acknowledged backlog as drift too — the coverage gate for release pipelines. Prints per-edge coverage and every finding, and writes open escalation questions to `.tripact/escalations.json`. Exits 0 when level, 1 on drift.

**`tripact status [--json]`**
The one-screen summary: counts per layer and coverage per edge. Same exit convention as `check`.

**`tripact claims [--json] [--all]`**
Every alive claim with its id, layer, group path, text and best edge verdict — these are the ids you tag tests with. `--all` includes dead claims, marked with their last text. Always exits 0.

**`tripact audit <claim-id> [--json] [--long]`**
The recorded history of one claim: creation, re-anchorings, adjudications, verifying-test history. Sidecar archaeology for "why is this covered?". Always exits 0.

**`tripact tasks [--json] [--reconcile <pair>] [--long]`**
Derives the repair/generation work queue from the current state. Task kinds: `write-tests`, `reconcile-stale`, `fix-orphan-tag`, `cover-section`, `reconcile-layers` (opt-in via `--reconcile specs:docs`) and `regenerate-derived`. Each task carries a self-contained `payload`, plus `effort`/`model` hints when `routing`/`models` are configured. Exits 1 while tasks exist, 0 when the queue is empty — poll it.

**`tripact prompt <id> [--reconcile <pair>]`**
Prints the ready-to-hand-to-an-agent brief for one work item — a task id from `tasks`, or a question id from `.tripact/escalations.json`. The payload is inlined, so the agent needs no tripact knowledge beyond running `check` to validate.

**`tripact reconcile [--json]`**, **`tripact reconcile --dismiss <claimId> <file> <line>`**
Proposes existing untagged tests that may already assert an uncovered claim — for adopting tripact on a repo that already has tests. Advisory: always exits 0. `--dismiss` records a rejected pairing so it is never proposed again.

**`tripact hotlinks [--json]`**
The navigational code↔spec link map from the configured `codeLinks` file set. Advisory: never gates, always exits 0.

**`tripact resolve <question-id> --match 'old-id="new text"' | --new "<atom>" | --dead <old-id> | --dismiss`**
Applies an adjudication answer to an escalation question: the reworded atom is still the same claim (`--match`), it is a genuinely new one (`--new`), the old claim is dead (`--dead`), or an advisory fork review is dismissed (`--dismiss`). This is the only way escalations get answered — never edit `.tripact/*` by hand.

**`tripact diff [--json]`**
A preview of what acceptance would change: created, re-anchored and retired claims, verified-state deltas, and the would-be trailer. Writes nothing, always exits 0.

**`tripact accept [--dry-run] [--yes]`**
Writes anchoring and verified states to the sidecar (`.tripact/claims.json`) and prints the `tripact-sync-id: <hash>` trailer to put in the commit message. Confirms interactively unless `--yes`. Refuses (exit 1) while escalation questions are open. `--dry-run` prints the would-be trailer without writing anything.

**`tripact verify <hash>`**
Compares a `tripact-sync-id` trailer value against the current sidecar's content hash: exit 0 on match, 1 on mismatch. This is how CI proves a build sits at a known sync point.

**`tripact generate [name]`**
Regenerates declared derived outputs and writes them to disk — deterministic, byte-identical across runs. With no name, regenerates every declared output. Always exits 0.

**`tripact skills [--dir <path>] [--force]`**
Emits the six agent skills (`detect`, `adjudicate`, `reconcile`, `repair`, `sync`, `hotlink-decoration`) as `.claude/skills/tripact-<name>/SKILL.md`. Writes into the git repository root unless `--dir` says otherwise; existing files are left untouched unless `--force`.

**`tripact mcp-serve`**
Serves the engine over MCP stdio: the read tools `check`, `status`, `claims`, `tasks` and `escalations`, plus `resolve`. `accept` is exposed only under `accept.policy: agents`, so the protocol enforces the same gate as the CLI.

## Example usages

### Agent instructions

For a single coding agent (Claude Code, Cursor, Codex — anything that reads skill files or an instructions file), the integration is two commands and a few lines of memory:

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

Both routes have the same property: every brief the agent receives is self-contained — claim text, tag format and the allowed options are inlined — and every claim of progress it makes is checkable by re-running `tripact check`. The agent never has to hold your traceability state in its head; that is the sidecar's job.

### Inside a loop

For an interactive agent the loop already ships: the `tripact-sync` skill _is_ the loop, with the gates spelled out — adjudicate before repair, validate before accept, stop early if the open work stops shrinking.

For a headless loop, the exit codes are the control flow: `check` exits 1 while drift exists, `tasks` exits 1 while the queue is non-empty, and `accept` refuses while questions are open. A complete drift-repair loop with a CLI agent:

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

`claude -p` is interchangeable with any agent CLI (`codex exec`, …). If `routing`/`models` are configured, each task in `tasks --json` carries `effort` and `model` fields and `runners` in `tripact.yaml` holds the per-tier invocation template, so the middle of the loop collapses to "for each task, run its runner".

The round bound matters. Repair converges when the queue shrinks every round; a queue that has stopped shrinking is a signal for a human, not for round four.

### Inside a harness

A harness like [Archon](https://github.com/coleam00/Archon) builds coding workflows out of YAML: nodes that run scripts, prompt agents, branch, loop, and stop for approval, triggered from a PR, a schedule, or chat. The division of labour with tripact is clean: **the harness owns the loop** — ordering, retries, approval gates, PR creation, the audit trail. **tripact owns the truth** — what drifted, what work exists, what is safe to baseline. The workflow never needs to understand claims, hashes or re-anchoring, because every step it takes is a `--json` command it can branch on.

A drift-repair workflow (node syntax illustrative — the control flow and the tripact commands are the actual contract):

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

The mapping generalises to any workflow-driven harness: script node → a tripact command, loop node → one of the queues, prompt node → `tripact prompt <id>`, approval node → the accept gate. The `routing`/`models` hints exist exactly so the harness can route each task to the right model tier without inventing its own task classification.

### Inside a software factory

At fleet scale the properties that matter change. One agent repairing drift needs a good brief; twenty agents need to agree on what the work _is_ without talking to each other. Tripact works at this scale because:

- **Discovery happens once, not per agent.** `check --json` and `tasks --json` produce the same queue for every reader. Workers execute the list; they never invent their own view of the drift.
- **Tasks shard by construction.** Task ids are stable content-derived hashes and every payload is self-contained, so a dispatcher can hand `tripact prompt <id>` briefs to N workers — each in its own worktree — without coordination between them.
- **Cost follows the routing table.** `routing`/`models` put an effort tier and model on every task: `fix-orphan-tag` goes to a cheap model, `reconcile-stale` to a strong one, and `runners` gives the dispatcher the invocation template per tier.
- **Escalations are a separate lane.** Repair tasks parallelise; identity questions go to a judgment lane — a strong model or a human — because `accept` refuses while any are open.
- **There is exactly one write gate.** Everything except `resolve` and `accept` is read-only. `accept` is the single baseline write, once per round, after validation — the one serialisation point in the factory.
- **Provenance survives the factory.** Every baseline prints a `tripact-sync-id` trailer for the commit, and `tripact verify <hash>` in CI proves which sync point a build sits at, no matter how many agents produced it.

An example workflow might look like this:

1. The dispatcher runs `tripact check --json`. Escalations go to the judgment lane and come back as `tripact resolve` calls; re-check.
2. `tripact tasks --json` is sharded across workers by task id, each invocation chosen from `runners` by the task's `effort` hint.
3. Workers validate their own patch: the configured `commands.test` plus `tripact check` must not regress.
4. The dispatcher merges the worktrees and re-runs `check` — it is deterministic and LLM-free, so re-checking after every merge costs nothing.
5. Level → `accept` (per the accept policy), commit with the trailer.
6. CI holds the line: `tripact check` on every PR, `tripact check --strict` as the release gate once the backlog is burned to zero.
