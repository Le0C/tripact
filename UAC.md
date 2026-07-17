# User Acceptance Criteria — tripact

tripact is the deterministic traceability **kernel**: an executable that parses spec, docs, and
test artefacts into claims with stable identities, checks the declared edges between them, and
emits claims, queues, and instructions. It never edits artefacts and never drives a loop of its
own — a consuming harness does that.

This document specifies the kernel's own behaviour. Section numbers are shared with the harness
specification (prodsync's `UAC.md`) so that a `(UAC §N)` citation resolves to the same requirement
on either side. Concerns that belong to a driving harness rather than the kernel are out of scope here and carry
no claims. **§1.1 Project initialisation** is one: tripact ships no `init` command, layer detection
is emitted as the `tripact-detect` skill (§1.2), and creating the config, sidecar, and skills at
first run is a harness responsibility. **§8.5 commit, §15 bootstrap, §17 one-invocation sync, and
§19 doctor** are likewise harness commands — committing the sidecar, bootstrapping missing layers,
executing a repair run-book, and environment health-checks — so the kernel stops at `accept` and
prints the trailer for the harness to commit. **§11–§14** (LLM provider adapters, CI packaging,
evidence export, intra-layer coherence) are not implemented.

---

## 1. Project Initialisation

Section §1.1 (`init`) is out of scope, as noted above. The kernel's initialisation surface is the
skill emission below.

### 1.2 Agent skill emission

- `tripact skills` writes four agent skills as `.claude/skills/<name>/SKILL.md` files — `tripact-detect`, `tripact-adjudicate`, `tripact-repair`, and `tripact-sync`
- The `tripact-detect` skill teaches a coding agent to classify a repository's files into prescriptive, descriptive, and verificatory layers and scaffold a `tripact.yaml`, since layer detection is a judgement task the kernel does not automate
- The `tripact-adjudicate` skill instructs an agent to read `.tripact/escalations.json`, answer each question, and apply the answers with `tripact resolve` (§7.2)
- The `tripact-repair` skill instructs an agent to consume `tripact tasks --json`, apply the edits, and validate before reporting (§10.2)
- The `tripact-sync` skill instructs a host agent to work the queues stage by stage and honour the accept policy at the final gate
- Emitted skill content is deterministic — the same CLI name, kernel version, and accept policy produce byte-identical files
- An existing skill file is left untouched unless `--force` is given; `--dir` overrides the output root
- The emitted skills' accept authority follows the configured accept policy (§2.1): baselining is forbidden under `human` and permitted after clean validation under `agents`

---

## 2. Configuration

### 2.1 `tripact.yaml` schema

- The kernel reads `tripact.yaml` from the repository root; `schemaVersion` is the literal `1`
- Config declares named layers, each with a `role` (`prescriptive`, `descriptive`, or `verificatory`), a non-empty list of glob `paths`, and an optional `conventions` file path
- A layer accepts an optional `tagPattern` and `sectionTagPattern` regex; the defaults match `@specs:<id>` in test titles and annotations for claims and `@manual:<slug>` for descriptive sections
- Config declares `edges` explicitly as pairs of layer names — no edge is ever checked that is not declared
- Config accepts an optional `pathMap` of code globs to layer names, used to narrow which claims a code diff can affect (§5.3)
- Config accepts an optional `exclude` list of globs subtracted from every layer's file set after collection, so archived, vendored, or generated trees never parse as source atoms
- Config accepts an optional `accept` block whose `policy` is `human` (the default) or `agents` — whether an agent may baseline (§8.3, §16.2)
- Config accepts optional `routing` (task class to effort tier) and `models` (effort tier to model identifier) maps, whose entries become advisory dispatch hints (§16.1)
- Config accepts optional `commands`, `runners`, `derived`, and `codeLinks` blocks; `commands` and `runners` are validated for a driving harness but no kernel command executes them

### 2.2 Validation behaviour

- `check` and every other command refuse to run against an invalid config, reporting all validation errors at once rather than one failure per run
- A config with fewer than two declared layers fails validation with exit code 2
- An unknown role, an edge referencing an undeclared layer, a malformed glob, an unknown `accept.policy`, an unknown routing tier, or a malformed derived/runner entry fails validation with exit code 2 and a message naming the offending key path and the accepted values

---

## 3. Claim Parsing & Identity

### 3.1 Markdown parsing

- Prescriptive and descriptive layer files parse into claim **groups** (one per heading, keyed by the full heading path) and claim **atoms** (one per `- ` list item under a heading; legacy `- [ ]` / `- [x]` checkbox items parse identically, their marker ignored)
- Prose paragraphs, code blocks, blockquotes, and nested (indented) list items are not atoms and never receive identities
- Atom normalisation lowercases, collapses whitespace, and strips any checkbox marker and trailing punctuation before hashing — reformatting a line without rewording it, including converting checkbox syntax to a plain bullet, does not change its content hash
- A heading marked `(TBD)` parses normally; its atoms are tracked in the sidecar but excluded from edge coverage verdicts (§4.1)
- Parsing is deterministic: the same file bytes always produce the same groups, atoms, and hashes

### 3.2 Sidecar

- Claim identities live in `.tripact/claims.json`, committed to the repository, so deleting the working tree and re-cloning loses nothing
- Each sidecar entry records a stable id, layer, group path, content hash, and per-edge verified state
- The sidecar records the **acknowledged backlog** — the uncovered claim ids and section slugs as of the last accept — so coverage debt only grows deliberately, through an accept (§5.1)
- Ids are human-readable slugs derived from the group and atom at creation (e.g. `addition.adda-b-returns-sum`), unique within the repository
- When two atoms in the same group would mint the same base slug, each colliding atom receives a distinct disambiguating suffix derived from its own identity; a non-colliding atom keeps its bare slug
- The disambiguating suffix depends only on the atom's own identity, never on minting order — adding, removing, or reordering a colliding sibling never changes an already-distinct atom's id
- Id assignment is a pure function of the new-atom set: the same set yields the same ids regardless of parse or iteration order
- Order-independent minting governs only the first assignment of a fresh atom; re-anchoring an existing repository reuses the persisted sidecar id and never rewrites it
- An id, once assigned, is never reused — a deleted claim's entry is marked dead, not removed
- Sidecar serialisation is stable: entries are sorted by id with fixed formatting, so an unchanged repository state always produces a byte-identical file and minimal git diffs

### 3.3 Re-anchoring

- When artefacts change, atoms are re-matched to existing identities by a deterministic cascade: exact normalised match within the aligned group, exact match across groups, group alignment, similarity match within the group, then similarity match across groups at a stricter threshold, then a containment pass
- The containment pass matches an atom whose earlier text is preserved verbatim inside an extended rewrite
- Similarity is computed with autojunk disabled at every string length, so a long atom's same-meaning reword scores on its full text and length alone never causes a fork
- A match at or above the auto-accept threshold (0.9) is taken silently; a weaker match becomes a `reanchor` escalation question (§7.1) rather than a silent link
- One atom matching several successors (split) or several atoms collapsing into one (merge) is detected and always escalated as a `split-merge` question — never auto-resolved
- Unmatched new atoms receive fresh ids and unmatched old atoms are marked dead — identity is forked rather than guessed
- A group that in one transition loses an unmatched atom and gains an unmatched atom is a **fork**: it additionally emits an advisory `fork-review` question (§7.1), so identity never forks silently

---

## 4. Edges

### 4.1 Prescriptive ↔ Verificatory (`P↔V`)

- Verificatory layer files are scanned for tags matching the layer's `tagPattern`; each tag names a claim id
- Every non-(TBD) prescriptive atom receives exactly one P↔V verdict: **covered** (a tag references it and its hash matches the recorded verified state), **pending** (tagged, but no verified state has ever been recorded for it on this edge), **stale** (a verified state exists and either side's hash no longer matches), or **uncovered** (no tag references it)
- The lifecycle is uncovered → pending when the first tag lands → covered when an accept records the verified state — a claim is never stale before it has been verified once
- A tag referencing an id that no live claim owns is reported as an **orphan tag** with its file and line; a tag referencing a dead claim id is reported as an orphan with a hint naming the claim's last text
- Verified state records the claim hash and the tagged test file's content hash at acceptance time (§8.1), so a change to either side makes the verdict **stale**
- A stale verdict is test-side-only when the claim's text still matches its verified state and only a tagged file's hash moved — the class an accept re-verifies without judgement; a stale verdict whose claim text moved is a reworded re-baseline

### 4.2 Descriptive ↔ Verificatory (`D↔V`)

- Descriptive groups (manual sections) are linked to tests via section tags matching the layer's `sectionTagPattern` (default `@manual:<group-slug>`)
- Every descriptive group receives a D↔V verdict — **covered**, **pending**, **stale** (any atom in the section changed since verification), or **uncovered** — evaluated at group level, so individual descriptive atoms are tracked for identity but not individually required to have tests
- Orphan section tags are reported identically to §4.1

Section §4.3 (Prescriptive ↔ Descriptive) is not implemented: direct spec-to-docs comparison is a
judgement task offered as a reconciliation task (§10.3), not a checked edge.

---

## 5. Checking

### 5.1 `tripact check` core behaviour

- `check` parses all declared layers, re-anchors identities in memory, evaluates all declared edges, and reports — it never mutates artefacts or the sidecar, apart from replacing the escalation queue it writes (§7.1)
- `check` makes no network calls and invokes no LLM under any configuration
- Exit code is 0 when the repository is **level** — no pending, stale, or new-uncovered verdicts, no orphans, no open escalations, no stale derived outputs — 1 when drift exists, 2 on config or environment error
- Uncovered claims and sections acknowledged at the last accept are **backlog**: reported as a count pointing at `tripact tasks`, never driving exit 1
- An uncovered claim or section not acknowledged at the last accept is **new-uncovered** — drift, driving exit 1
- `check --strict` treats acknowledged backlog as drift too, restoring coverage gating for release pipelines
- A level report ends with `✓ level`, naming the acknowledged backlog count when it is non-zero
- Running `check` twice on the same tree produces byte-identical output

### 5.2 Output

- Default output is a human-readable report that groups non-covered verdicts under their group heading path within each edge
- Each reported verdict line carries the claim id, a text excerpt, and a location: the tag's file:line for tagged verdicts, the claim's own declaring file:line for uncovered ones
- Report counts include a **forks** metric (§3.3) in both the human report and `check --json`
- `check --json` emits a single machine-readable report on stdout with nothing else, carrying a `schemaVersion` field
- `check --long` prints every listing in full instead of truncating past a fixed threshold

### 5.3 Scoping

- With a sync-point present (§8.1), `check` reports which claims the code diff since it may affect, using `pathMap` globs to narrow candidates
- Without any sync-point, `check` audits everything and says so in the report header
- `check --all` forces a full audit regardless of sync-point

---

## 6. Status & Reporting

### 6.1 `tripact status`

- `status` prints a per-layer summary — alive, dead, and TBD atom counts — and a per-edge coverage percentage
- `status` reports the orphan-tag and open-escalation counts
- `status --json` emits the same report document the check surface produces

### 6.2 Claim listing

- `tripact claims` lists every alive claim — id, layer, group path, normalised text, and its best edge verdict across all edges — the discovery command for writing tags
- Each listed claim carries its declaring file and line, so a claim can be opened directly from the listing and used as a navigation target (§20)
- `claims --json` emits the same listing machine-readably with a `schemaVersion` field, including each claim's file and line
- Dead claims are excluded by default and included with `claims --all`, each marked dead with its last text
- Listing order is deterministic: layer order, then document order, with dead entries sorted by id
- `claims` prints its full listing and exits 0 rather than following the drift convention, so a large listing survives being piped

Section §6.3 (bare-invocation orientation) is out of scope: invoking `tripact` with no arguments
prints command help, not a repo orientation — orientation is a harness affordance.

---

## 7. Escalation & Agent Handoff

### 7.1 Escalation queue

- Questions the deterministic engine cannot answer are written to `.tripact/escalations.json`, replacing the previous queue on each `check`
- Each question has a stable id (deterministic for the same underlying situation), a `kind` of `reanchor`, `split-merge`, or `fork-review`, and a self-contained payload carrying the affected group's deleted and created atoms and the candidate pairings
- A `fork-review` question is advisory: it names the dead and created atoms of the forked group and is answered by `resolve --match` (reuniting the identities) or `resolve --dismiss` (accepting the fork)
- The escalation file is valid JSON with a `schemaVersion`, consumable without access to kernel internals

### 7.2 `tripact resolve`

- `tripact resolve <question-id>` applies an adjudication answer with exactly one of `--match <old-id>="new text"`, `--new <atom>`, `--dead <old-id>`, or `--dismiss`
- `resolve` validates that the referenced question exists and the answer shape matches its kind; a mismatch exits 2 without touching the sidecar
- `--dismiss` is valid only for a `fork-review` question; the dismissal is recorded so subsequent checks do not re-emit the question for the same dead/created pair
- Resolving one atom of a multi-atom question shrinks the question in place — the remaining atoms keep the same question id, and the question leaves the queue only when no atoms remain
- Resolving every question and re-running `check` yields no `reanchor` or `split-merge` escalations for unchanged content
- Every resolution is appended to `.tripact/journal.jsonl` with a timestamp and the question id

---

## 8. Sync-Point & Acceptance

### 8.1 Sync-point convention

- A commit whose message body carries a `tripact-sync-id:` trailer marks a sync-point; `check` finds the most recent one via git log
- The trailer value is the sidecar's content hash at commit time, letting `check` detect a moved or hand-edited sidecar

### 8.2 Trailer verification

- `tripact verify <hash>` compares a supplied trailer value against the current sidecar's content hash: exit 0 on match, 1 on mismatch, printing both values
- `tripact accept --dry-run` prints the trailer a real accept would produce without writing the sidecar or clearing escalations

### 8.3 `tripact accept`

- `accept` writes the current in-memory anchoring into `.tripact/claims.json` and records verified states for every edge verdict currently **covered**
- `accept` refuses to run (exit 1) while any `reanchor` or `split-merge` escalation is open, listing them; open `fork-review` questions never block but are named in the acceptance summary
- `accept` prints an acceptance summary before writing: claims created, re-anchored, and retired, plus verified-state changes per edge and backlog items newly acknowledged or covered
- Claims that would be re-baselined after a reword (§4.1) are listed in their own summary section with old and new text excerpts; `--yes` still prints that section before writing
- `accept` snapshots the currently uncovered claims and sections as the acknowledged backlog (§3.2, §5.1)
- On an interactive terminal `accept` asks for confirmation and aborts on anything but yes; `--yes` skips the prompt; without a terminal it proceeds as scripted
- `accept` prints the `tripact-sync-id:` trailer for the user to include in their commit and never commits by itself
- After `accept` and a commit carrying the trailer, an immediately following `check` exits 0

### 8.4 Acceptance preview

- `tripact diff` shows what acceptance would change — claims created, re-anchored, and retired; verified states newly recorded or re-baselined per edge; backlog items newly acknowledged or covered; and the current and would-be trailer values — without writing anything
- A re-baselined verified state distinguishes re-verified (test-side-only, §4.1) from re-baselined after a reword, the latter with old and new text excerpts
- `diff --json` emits the same document machine-readably with a `schemaVersion` field

Section §8.5 (`commit`) is a harness concern: the kernel stops at `accept` and the printed trailer.

---

## 9. Dogfooding

This repository's own `tripact.yaml` declares `UAC.md` as its prescriptive layer, `README.md` and
`docs/` as its descriptive layer, and `test/` as its verificatory layer, checking a spec↔tests edge
and a docs↔tests edge. `tripact check` runs level on the repository, and the kernel's own claims are
tagged by the tests under `test/`. This section carries no claims — it records the setup, not a
requirement.

---

## 10. Repair & Generation Tasks

### 10.1 Task emission

- `tripact tasks` derives a work queue from the current analysis without mutating artefacts, the sidecar, or escalations
- One task is emitted per reworded stale claim (§4.1), per orphan tag, and per uncovered descriptive section; uncovered claims are grouped into one task per claim group
- The uncovered-claim task is a find-or-write task: it instructs tagging an existing untagged test that already asserts the claim, or writing a new tagged test only when none exists, and its payload names both options and the exact tag format
- A pending verdict emits no task — its cure is an accept recording the verified state, which belongs to the accept gate (§8.3), not to repair work
- Test-side-only staleness (§4.1) emits no task; only a reworded stale claim, whose own text moved, emits a `reconcile-stale` task
- A derived-stale output (§18.2) emits a `regenerate-derived` task naming the exact `tripact generate` invocation
- `tripact tasks --reconcile <prescriptive>:<descriptive>` additionally emits a single layer-reconciliation task carrying both layers' full inventories, so the agent judges what documentation is missing
- Task ids are deterministic for the same underlying situation
- `tasks --json` emits a machine-readable queue with a `schemaVersion` field; the human output groups tasks by kind and truncates past a fixed threshold unless `--long`
- `tripact prompt <id>` prints a ready-to-hand-off brief for a single work item — a task id or an escalation question id (§7.2) — with the item's self-contained payload inlined; an unknown id exits 1

### 10.2 Repair handoff

- The emitted `tripact-repair` skill (§1.2) instructs an agent to consume `tripact tasks --json`, follow per-layer conventions files where declared, apply artefact edits, and validate with `tripact check` and the repository's own test command before reporting
- For a find-or-write task, the repair skill instructs the agent to first search the verificatory layer for an existing untagged test that already asserts the claim and tag it in place, writing a new test only when none is found
- The repair skill's accept rule follows the configured accept policy (§2.1)
- Executing repair tasks is agent work: the kernel never edits prescriptive or descriptive artefact content — the sole exception is derived-output generation (§18), a deterministic derivation

### 10.3 Reconcile untagged tests

- `tripact reconcile` proposes, per uncovered non-(TBD) prescriptive claim, existing tests whose title scores above a fixed similarity threshold against the claim text, ranked by score — a propose-only queue for linking claims to tests that already exist
- `reconcile` mutates nothing — no artefact, sidecar, escalation, or tag; confirming a candidate and tagging the test is agent or human work
- Reconcile scoring reuses the deterministic similarity matcher (§3.3) over normalised claim text and normalised test title; an identical tree produces an identical proposal set and ranking, with ties broken by test file and line, then claim id
- A dismissed candidate, recorded via `tripact reconcile --dismiss <claim-id> <file> <line>`, is keyed by claim id and test identity and is never re-proposed until either side's text changes; a dismissal survives an accept
- `reconcile` is opt-in and not part of `check`: it runs its own scan and never affects `check`'s verdicts, counts, or exit code
- `reconcile --json` emits a machine-readable queue with a `schemaVersion` field; the command exits 0 (advisory), or 2 on a config or usage error, and never exits 1

---

## 16. Dispatch & Routing

### 16.1 Effort routing

- `tripact.yaml` accepts a `routing` map from task class to an effort tier (`judgment`, `planning`, `implementation`, or `mechanical`) and a `models` map from effort tier to a model identifier string
- Emitted tasks and escalation questions carry their resolved `effort` and `model` hint when the config binds their class, and carry nothing when it does not — hints are advisory
- Routing and models entries are validated with the same all-at-once error reporting as the rest of the config (§2.2)

### 16.2 MCP serving

- `tripact mcp-serve` exposes the task queue, claim listing, check report, status summary, and escalation queue as MCP read tools over stdio, plus `resolve` as a write tool
- `accept` is exposed as a write tool only when the accept policy is `agents`, and is absent under `human`
- Each MCP read tool returns the same JSON document the corresponding CLI `--json` flag produces

---

## 18. Derived Outputs

### 18.1 Declaration & generation

- Config accepts a `derived` map of name → an `output` path and a `generator`, either a reserved builtin name or a shell command
- The kernel reserves the builtin names `cli-reference` and `hotlink-map` but registers no generator of its own; a driving harness injects an implementation, and a config naming a reserved builtin with no registered generator fails generation with a clear error
- A non-reserved generator runs as a shell command whose captured stdout becomes the output file; a non-zero exit fails with exit code 2
- `tripact generate [name]` writes the declared output file(s); with no name it regenerates all
- Generation is deterministic: the same code and config produce byte-identical output

### 18.2 Freshness

- `check` regenerates each declared derived output in memory and byte-compares it with the committed file; a stable mismatch or a missing file is a **derived-stale** finding that drives exit 1
- A generator whose two back-to-back regenerations disagree is reported as non-deterministic rather than stale, since regeneration cannot fix it
- A derived-stale finding appears in the task queue as a `regenerate-derived` task (§10.1)

---

## 20. Navigational Code↔Spec Hotlinks

### 20.1 Code-link configuration

- `tripact.yaml` accepts an optional `codeLinks` block with `paths` (globs over product code) and an optional `tagPattern`, defaulting to the verificatory layer's pattern, then to the built-in default
- `codeLinks` is declared outside `layers` and `edges`: a code file set is never a layer role and never an edge, so it never produces a coverage verdict
- An invalid `codeLinks` block fails validation with exit code 2 under the all-at-once reporting (§2.2)

### 20.2 Scanning code links

- `tripact hotlinks` scans `codeLinks.paths` for tags matching the code-link pattern, each naming a claim id, and reports navigational links between a claim id and the code file:line that tags it
- Hotlink scanning never affects any edge verdict, coverage count, or exit code — a code tag is navigation, not verification
- A code tag referencing an id that is unknown or dead is reported as a navigational orphan with its file:line and, for a dead id, a hint naming the claim's last text
- `hotlinks --json` emits a machine-readable map with a `schemaVersion` field; the command exits 0 (advisory), or 2 on a config or usage error, and never exits 1
- Scanning is deterministic: an identical tree yields an identical, stably ordered map

### 20.3 Hotlink map

- The kernel provides the reserved `hotlink-map` derived renderer (§18.1) which, per code-linked prescriptive claim, renders its spec file:line, its code tag locations, and its covering test tags, byte-identically for the same tree
- Writing a hotlink decoration comment into a tagged function is agent work: the kernel never edits product code, and the `hotlink-map` derivation is its sole write

---

## Cross-Cutting Concerns

### Determinism

- No checking, reporting, or state-mutating command performs network I/O or invokes an LLM; `mcp-serve` speaks only stdio and opens no socket
- Identical repository state and config produce byte-identical output for every command, across machines and runs
- No command writes a timestamp, hostname, or locale-dependent formatting into a committed file; the `.tripact/journal.jsonl` resolution log (§7.2) is the sole timestamped artefact

### Machine readability

- Every command offering a report offers `--json` with a versioned schema
- Exit codes follow one convention everywhere: 0 level, 1 drift, 2 usage or environment error

### Human output

- Counts precede details in every human report
- A listing longer than a fixed threshold truncates with a closing "… and N more" line naming `--long`; `--long` prints everything
- Human reports name verdicts and question kinds with exactly the `--json` vocabulary — no synonyms
- A human-output change never alters any `--json` document; machine schemas evolve only through their `schemaVersion`

### Footprint

- The CLI runs on Node 22 or newer with no native dependencies
- `.tripact/` contains only `claims.json`, `escalations.json`, and `journal.jsonl`
