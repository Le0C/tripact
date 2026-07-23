# User Acceptance Criteria - tripact

tripact is the deterministic traceability **kernel**: an executable that parses spec, docs, and
test artefacts into claims with stable identities, checks the declared edges between them, and
emits claims, queues, and instructions. It never edits artefacts and never drives a loop of its
own - a consuming harness does that.

This document specifies the kernel's own behaviour. Section numbers are reserved so that a
`(UAC §N)` citation resolves to the same requirement whether it is read here or in a driving
harness's own specification. Concerns that belong to a driving harness rather than the kernel are out of scope here and carry
no claims. **§1.1 Project initialisation** is one: tripact ships no `init` command; spec-system
fingerprinting is available read-only as `tripact detect` (§2.3), but layer classification is a
judgement task emitted as the `tripact-detect` skill (§1.2), and driving that skill at first run is a
harness responsibility. **§8.5 commit, §15 bootstrap, §17 one-invocation sync, and
§19 doctor** are likewise harness commands - committing the sidecar, bootstrapping missing layers,
executing a repair run-book, and environment health-checks - so the kernel stops at `accept` and
prints the trailer for the harness to commit. **§11–§14** (LLM provider adapters, CI packaging,
evidence export, intra-layer coherence) are not implemented.

---

## 1. Project Initialisation

Section §1.1 (`init`) is out of scope, as noted above. The kernel's initialisation surface is the
skill emission below.

### 1.2 Agent skill emission

- `tripact skills` writes six agent skills as `.claude/skills/<name>/SKILL.md` files - `tripact-detect`, `tripact-adjudicate`, `tripact-reconcile`, `tripact-repair`, `tripact-sync`, and `tripact-hotlink-decoration`
- An emitted skill's name prefix is validated before it becomes a path segment, so a caller embedding the kernel cannot direct a skill file outside `.claude/skills/`
- The `tripact-detect` skill drives repository initialisation end to end: it runs `tripact detect` to pick a spec-system `kind:` when one matches, classifies files into prescriptive, descriptive, and verificatory layers when none does, writes `tripact.yaml`, emits the working skills, and verifies with `tripact check` - layer classification stays a judgement task the kernel does not automate
- The `tripact-adjudicate` skill instructs an agent to read `.tripact/escalations.json`, answer each question, and apply the answers with `tripact resolve` (§7.2)
- The `tripact-reconcile` skill instructs an agent to work the propose-only reconcile queue (§10.3): read what each candidate test actually asserts, tag only one that genuinely asserts the claim, and dismiss the rest - the kernel proposes, and never tags on the agent's behalf
- The `tripact-repair` skill instructs an agent to consume `tripact tasks --json`, apply the edits, and validate before reporting (§10.2)
- The `tripact-sync` skill instructs a host agent to work the queues stage by stage and honour the accept policy at the final gate
- The `tripact-hotlink-decoration` skill instructs an agent to write a claim-id tag and a clickable spec back-link into the docstring of the product-code function implementing a claim, and to refresh a declared `hotlink-map` (§20.3) - the kernel reads those tags back but never edits product code
- Emitted skill content is deterministic - the same CLI name, kernel version, and accept policy produce byte-identical files
- An existing skill file is left untouched unless `--force` is given; `--dir` overrides the output root
- The emitted skills' accept authority follows the configured accept policy (§2.1): baselining is forbidden under `human` and permitted after clean validation under `agents`

---

## 2. Configuration

### 2.1 `tripact.yaml` schema

- The kernel reads `tripact.yaml` from the repository root; `schemaVersion` is the literal `1`
- Config declares named layers, each with a `role` (`prescriptive`, `descriptive`, or `verificatory`), a non-empty list of glob `paths`, and an optional `conventions` file path
- A layer accepts an optional `tagPattern` and `sectionTagPattern` regex; the defaults match `@specs:<id>` in test titles and annotations for claims and `@docs:<slug>` for descriptive sections
- Config declares `edges` explicitly as pairs of layer names - no edge is ever checked that is not declared
- Config accepts an optional `pathMap` of code globs to layer names, used to narrow which claims a code diff can affect (§5.3)
- Config accepts an optional `exclude` list of globs subtracted from every layer's file set after collection, so archived, vendored, or generated trees never parse as source atoms
- Config accepts an optional `accept` block whose `policy` is `human` (the default) or `agents` - whether an agent may baseline (§8.3, §16.2)
- Config accepts optional `routing` (task class to effort tier) and `models` (effort tier to model identifier) maps, whose entries become advisory dispatch hints (§16.1)
- Config accepts optional `commands`, `runners`, `derived`, and `codeLinks` blocks; `commands` and `runners` are validated for a driving harness but no kernel command executes them
- Config accepts an optional `display` block: `colour` turns the palette off, and `mark` opts the witness mark in, since it is off by default
- Config accepts an optional `informativeGroups` list of heading titles naming the sections whose atoms are tracked but never coverage-checked (§3.1); a declared list replaces the built-in default rather than extending it, and an empty list turns the exclusion off entirely

### 2.2 Validation behaviour

- `check` and every other command refuse to run against an invalid config, reporting all validation errors at once rather than one failure per run
- A config with fewer than two declared layers fails validation with exit code 2
- An unknown role, an edge referencing an undeclared layer, a malformed glob, an unknown `accept.policy`, an unknown routing tier, or a malformed derived/runner entry fails validation with exit code 2 and a message naming the offending key path and the accepted values

### 2.3 Spec-system presets

- Config accepts an optional top-level `kind` naming a known spec system, one of `spec-kit`, `openspec`, `strictdoc`, `kiro`, `cursor`, or `cucumber`, expanded by the kernel into layers, edges, and excludes so a minimal config can declare only `schemaVersion` and `kind`
- Preset expansion is user-first: a layer, an edge list, or an exclude the config declares explicitly is kept unchanged, and the preset supplies only the layers, edges, and excludes the config omits
- Preset expansion runs before structural validation, so a `kind`-only config clears the two-layer floor through the preset's own layers
- An unknown `kind` fails validation with exit code 2 in a message naming the accepted spec systems
- A preset seeds its verificatory layer with colocated test globs as well as directory-anchored ones, since a test file sitting beside the source it exercises is the dominant convention in JavaScript and TypeScript repositories and a directory-anchored glob alone reports such a repository as having no tests
- The same preset registry backs detection: each spec system declares signature globs that fingerprint it on disk from file presence alone, never from file contents
- Detection returns every spec system whose signatures are present, not only the first: a repository matching more than one spec system is ambiguous, and its candidates are surfaced for a person or agent to choose rather than resolved silently by registry order
- A repository is auto-assigned a single `kind` only when exactly one spec system matches; when none or several match it is left unassigned, so an ambiguous layout is never silently guessed
- `tripact detect` reports, read-only, which spec system(s) the repository matches by signature - none, one, or several (ambiguous) - reading no file contents and writing nothing, so an agent or harness can drive `kind:` selection from the registry; `--json` emits the same result with a `schemaVersion`

---

## 3. Claim Parsing & Identity

### 3.1 Markdown parsing

- Prescriptive and descriptive layer files parse into claim **groups** (one per heading, keyed by the full heading path) and claim **atoms** (one per `- ` list item under a heading; legacy `- [ ]` / `- [x]` checkbox items parse identically, their marker ignored)
- A column-0 ordered list item (`1.` or `1)`) is an atom on the same terms as a `- ` bullet, so EARS/Kiro-style numbered acceptance criteria atomise; the ordered marker is not part of the atom text, so renumbering an item leaves its content hash unchanged
- A prose paragraph is an atom when it reads as a requirement: it leads with a bold label (`**User Story:** …`) or it contains an uppercase RFC-2119 keyword (`SHALL`, `MUST`, `SHOULD`); the whole wrapped paragraph is a single atom, and the keyword match is case-sensitive so lowercase prose is left alone
- Prose paragraphs that carry no requirement signal, along with code blocks, blockquotes, and nested (indented) list items, are not atoms and never receive identities
- Atom normalisation lowercases, collapses whitespace, and strips any checkbox marker and trailing punctuation before hashing - reformatting a line without rewording it, including converting checkbox syntax to a plain bullet, does not change its content hash
- A heading marked `(TBD)` parses normally; its atoms are tracked in the sidecar but excluded from edge coverage verdicts (§4.1)
- An atom whose text still carries an unfilled template placeholder - a bracketed span left unsubstituted, such as `[specific capability]` - parses normally but is tracked as TBD rather than as a live requirement, so a committed but unedited spec template never becomes coverage debt
- Placeholder detection ignores markdown links and inline code and requires the bracketed span to carry at least two words, so a requirement that legitimately cites a bracketed token is not mistaken for boilerplate
- An atom under a heading naming a conventionally **informative** section - `Out of Scope`, `Non-Goals`, and their spellings - is tracked in the sidecar but excluded from edge coverage verdicts (§4.1), since a statement of what the project will not build cannot be satisfied by a test that asserts it
- A heading is matched against the informative set by its numbering-stripped, case-folded title, so `## 7. Out of Scope` and `## Out-of-Scope *(mandatory)*` are both recognised
- Parsing is deterministic: the same file bytes always produce the same groups, atoms, and hashes

### 3.2 Sidecar

- Claim identities live in `.tripact/claims.json`, committed to the repository, so deleting the working tree and re-cloning loses nothing
- Each sidecar entry records a stable id, layer, group path, content hash, and per-edge verified state
- The sidecar records the **acknowledged backlog** - the uncovered claim ids and section slugs as of the last accept - so coverage debt only grows deliberately, through an accept (§5.1)
- Ids are human-readable slugs derived from the group and atom at creation (e.g. `addition.adda-b-returns-sum`), unique within the repository
- When two atoms in the same group would mint the same base slug, each colliding atom receives a distinct disambiguating suffix derived from its own identity; a non-colliding atom keeps its bare slug
- The disambiguating suffix depends only on the atom's own identity, never on minting order - adding, removing, or reordering a colliding sibling never changes an already-distinct atom's id
- Id assignment is a pure function of the new-atom set: the same set yields the same ids regardless of parse or iteration order
- Order-independent minting governs only the first assignment of a fresh atom; re-anchoring an existing repository reuses the persisted sidecar id and never rewrites it
- An id, once assigned, is never reused - a deleted claim's entry is marked dead, not removed
- Sidecar serialisation is stable: entries are sorted by id with fixed formatting, so an unchanged repository state always produces a byte-identical file and minimal git diffs
- A sidecar left carrying version-control conflict markers is reported as an unresolved merge naming the file and the resolution, not as a parse error, since a committed ledger that two branches both accepted into is the ordinary way this file breaks
- Any other unreadable sidecar is reported with the file path and the underlying reason, so the failure is attributable to a file rather than to the tool

### 3.3 Re-anchoring

- When artefacts change, atoms are re-matched to existing identities by a deterministic cascade: exact normalised match within the aligned group, exact match across groups, group alignment, similarity match within the group, then similarity match across groups at a stricter threshold, then a containment pass
- The containment pass matches an atom whose earlier text is preserved verbatim inside an extended rewrite
- Similarity is computed with autojunk disabled at every string length, so a long atom's same-meaning reword scores on its full text and length alone never causes a fork
- A match at or above the auto-accept threshold (0.9) is taken without asking; a weaker match becomes a `reanchor` escalation question (§7.1) instead of being linked
- One atom matching several successors (split) or several atoms collapsing into one (merge) is detected and always escalated as a `split-merge` question - never auto-resolved
- Unmatched new atoms receive fresh ids and unmatched old atoms are marked dead - identity is forked rather than guessed
- A group that in one transition loses an unmatched atom and gains an unmatched atom is a **fork**: it additionally emits an advisory `fork-review` question (§7.1), so identity never forks without raising one

### 3.4 SDOC parsing

- A layer file is dispatched to a parser by extension: a `.sdoc` file uses the StrictDoc parser, a `.feature` file uses the Gherkin parser, and every other extension uses the markdown parser
- StrictDoc `.sdoc` files parse by typed node, not by markdown list item: each node with a `STATEMENT` field contributes exactly one atom whose text is that statement
- A node `STATEMENT` may be inline or a multi-line block delimited by `>>>` and `<<<`; a multi-line statement is joined into a single atom
- `[DOCUMENT]` and `[GRAMMAR]` nodes carry no statement and yield no atoms, so a requirements file's grammar definition is never turned into pseudo-atoms
- Non-statement fields such as `RATIONALE`, `COMMENT`, `UID`, and `TITLE` never contribute atom text, and a multi-line non-statement block is consumed without being atomised
- SDOC atoms are grouped by their enclosing `[[SECTION]]` nesting, keyed by the section title path

### 3.5 Gherkin parsing

- A `.feature` file uses the Gherkin parser
- Gherkin files parse by keyword, not by markdown list item: each `Scenario`, `Scenario Outline`, `Scenario Template`, or singular `Example` contributes exactly one atom whose text is that scenario's name
- A scenario with no name contributes no atom, since there is no requirement statement to track
- `Feature` and `Rule` are structural: they name the groups their scenarios are grouped under, and contribute no atoms of their own
- `Background` contributes no atom - it is shared setup, not a requirement
- Step lines (`Given`, `When`, `Then`, `And`, `But`, `*`) never contribute atom text, so a scenario's body cannot leak into its atom
- `Examples` tables, data tables, tag lines, and comment lines never contribute atoms
- A docstring delimited by `"""` or triple backticks is consumed whole, so a keyword written inside example content is never read as a scenario
- Gherkin atoms are grouped by their `Feature`, and by `Rule` within it where one is declared

---

## 4. Edges

### 4.1 Prescriptive ↔ Verificatory (`P↔V`)

- Verificatory layer files are scanned for tags matching the layer's `tagPattern`; each tag names a claim id
- Every non-(TBD) prescriptive atom receives exactly one P↔V verdict: **covered** (a tag references it and its hash matches the recorded verified state), **pending** (tagged, but no verified state has ever been recorded for it on this edge), **stale** (a verified state exists and either side's hash no longer matches), or **uncovered** (no tag references it)
- The lifecycle is uncovered → pending when the first tag lands → covered when an accept records the verified state - a claim is never stale before it has been verified once
- A tag referencing an id that no live claim owns is reported as an **orphan tag** with its file and line; a tag referencing a dead claim id is reported as an orphan with a hint naming the claim's last text
- Verified state records the claim hash and the tagged test file's content hash at acceptance time (§8.1), so a change to either side makes the verdict **stale**
- A stale verdict is test-side-only when the claim's text still matches its verified state and only a tagged file's hash moved - the class an accept re-verifies without judgement; a stale verdict whose claim text moved is a reworded re-baseline

### 4.2 Descriptive ↔ Verificatory (`D↔V`)

- Descriptive groups (docs sections) are linked to tests via section tags matching the layer's `sectionTagPattern` (default `@docs:<group-slug>`)
- Every descriptive group receives a D↔V verdict - **covered**, **pending**, **stale** (any atom in the section changed since verification), or **uncovered** - evaluated at group level, so individual descriptive atoms are tracked for identity but not individually required to have tests
- Orphan section tags are reported identically to §4.1

Section §4.3 (Prescriptive ↔ Descriptive) is not implemented: direct spec-to-docs comparison is a
judgement task offered as a reconciliation task (§10.3), not a checked edge.

---

## 5. Checking

### 5.1 `tripact check` core behaviour

- `check` parses all declared layers, re-anchors identities in memory, evaluates all declared edges, and reports - it never mutates artefacts or the sidecar, apart from replacing the escalation queue it writes (§7.1)
- `check` makes no network calls and invokes no LLM under any configuration
- Exit code is 0 when the repository is **level** - no pending, stale, or new-uncovered verdicts, no orphans, no open escalations, no stale derived outputs, and the check was not vacuous (§5.4) - 1 when drift exists, 2 on config or environment error
- Uncovered claims and sections acknowledged at the last accept are **backlog**: reported as a count pointing at `tripact tasks`, never driving exit 1
- An uncovered claim or section not acknowledged at the last accept is **new-uncovered** - drift, driving exit 1
- `check --strict` treats acknowledged backlog and layer-diagnostic warnings (§5.4) as drift too, restoring coverage gating for release pipelines
- A level report ends with `✓ level`, naming the acknowledged backlog count when it is non-zero
- Running `check` twice on the same tree produces byte-identical output

### 5.2 Output

- Default output is a human-readable report that groups non-covered verdicts under their group heading path within each edge
- Each reported verdict line carries the claim id and a location - the tag's file:line for tagged verdicts, the claim's own declaring file:line for uncovered ones - plus a text excerpt whenever the width budget leaves room for one
- Report counts include a **forks** metric (§3.3) in both the human report and `check --json`
- `check --json` emits a single machine-readable report on stdout with nothing else, carrying a `schemaVersion` field
- `check --long` prints every listing in full instead of truncating past a fixed threshold
- The report opens with a headline naming the verdict and the counts behind it, and closes with the same verdict, so a long report states its outcome without being scrolled to the end
- Advisory three-way gaps collapse to a single line naming their counts; `--long` lists them in full
- Verdict lines render as aligned columns - kind, claim id, text excerpt, location - so one column can be read down
- A verdict line is budgeted to the terminal's width, shortening the text excerpt rather than wrapping the line; when too little room remains the excerpt is dropped before the id or the location is
- When colour is on, a verdict kind is tinted by whether it drives drift or is merely acknowledged; the tint is added to the word and never replaces it

### 5.3 Scoping

- With a sync-point present (§8.1), `check` reports which claims the code diff since it may affect, using `pathMap` globs to narrow candidates
- Without any sync-point, `check` audits everything and says so in the report header
- `check --all` forces a full audit regardless of sync-point

### 5.4 Layer diagnostics

- A declared layer whose paths match no files is reported as a `zeroFileLayers` warning in both the human report and `check --json`, distinguishing a mis-declared or unmatched glob from a populated layer
- The zero-file warning names the globs the layer declared, so a wrong glob is distinguishable from an unpopulated layer without opening the config
- The atoms excluded from coverage as placeholder or informative text are reported as an `excludedAtoms` count in both the human report and `check --json`, so text dropped from the coverage denominator is never dropped silently
- A prescriptive or descriptive layer that matches files but parses to zero atoms is reported as a `zeroAtomLayers` warning, surfacing an unparsable format or a wrong glob
- Layer-diagnostic warnings are advisory: an individual mis-declared layer is surfaced without, on its own, changing the exit code, so a layer may be declared before it is populated
- A check that parsed **zero atoms across every prescriptive and descriptive layer** is **vacuous** - there is nothing to check, so it never reports level: it is drift, driving exit 1, and reports `vacuous: true` in `check --json`
- A vacuous check names the empty layers and points at the glob and format as the likely cause, rather than reporting `✓ level` over a configuration that verifies nothing
- `check --strict` additionally treats any `zeroFileLayers` or `zeroAtomLayers` warning as drift, so a release pipeline gates on every layer being populated

### 5.5 Content lint

- A prescriptive or descriptive atom whose text carries a prompt-injection signature - an override directive such as ignore-previous-instructions, a new-instructions marker, a chat role tag, or a role-override - is reported as a `suspiciousAtoms` warning in both the human report and `check --json`, naming each atom's file, line, and matched signal
- The content lint is advisory and deterministic: it flags atoms for review, ordered by file then line, without changing the exit code, since a planted directive still flows verbatim into task payloads and agent prompts (§10.1)

---

## 6. Status & Reporting

### 6.1 `tripact status`

- `status` prints a per-layer summary - alive, dead, and TBD atom counts - and a per-edge coverage percentage
- `status` reports the orphan-tag and open-escalation counts
- `status` marks any zero-file layer, and any prescriptive or descriptive layer with zero atoms, as a warning alongside its per-layer counts
- `status --json` emits the same report document the check surface produces

### 6.2 Claim listing

- `tripact claims` lists every alive claim - id, layer, group path, normalised text, and its best edge verdict across all edges - the discovery command for writing tags
- Each listed claim carries its declaring file and line, so a claim can be opened directly from the listing and used as a navigation target (§20)
- `claims --json` emits the same listing machine-readably with a `schemaVersion` field, including each claim's file and line
- Dead claims are excluded by default and included with `claims --all`, each marked dead with its last text
- A claim excluded from coverage as informative text is marked `informative` in the listing, as a TBD claim is marked `tbd`, so text outside the coverage denominator is visible in the discovery command rather than reading as an ordinary uncovered claim
- Listing order is deterministic: layer order, then document order, with dead entries sorted by id
- `claims` prints its full listing and exits 0 rather than following the drift convention, so a large listing survives being piped

Section §6.3 (bare-invocation orientation) is out of scope: invoking `tripact` with no arguments
prints command help, not a repo orientation - orientation is a harness affordance.

### 6.4 Three-way pact

- The three-way pact correlates the spec↔tests and docs↔tests edges into one reading per spec claim: **complete** where a documented section is bridged to it, **tested but undocumented** where none is, and **untied** for a test-covered doc section no spec claim reaches
- The bridge from a spec claim to a doc section is a single test that tags both: a `@specs:` tag and a `@docs:` tag on the same line, in the same file
- Tags merely sharing a test file do not bridge, so a documented section cannot mark a claim documented that it never describes, and adding one `@docs:` tag to a file of unrelated tests raises no claim's reading
- The pact is advisory: it feeds no verdict and no exit code, and an untested claim is not part of it, since it already reports as uncovered on the spec↔tests edge
- The pact is empty unless the config declares both a spec↔tests and a docs↔tests edge, because "is this documented?" has no meaning without a descriptive layer to answer it

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
- Resolving one atom of a multi-atom question shrinks the question in place - the remaining atoms keep the same question id, and the question leaves the queue only when no atoms remain
- Resolving every question and re-running `check` yields no `reanchor` or `split-merge` escalations for unchanged content
- Every resolution is appended to `.tripact/journal.jsonl` with a timestamp and the question id

---

## 8. Sync-Point & Acceptance

### 8.1 Sync-point convention

- A commit whose message body carries a `tripact-sync-id:` trailer marks a sync-point; `check` finds the most recent one via git log
- The trailer value is the sidecar's content hash at commit time, letting `check` detect a moved or hand-edited sidecar

### 8.2 Trailer verification

- `tripact verify <hash>` compares a supplied trailer value against the current sidecar's content hash: exit 0 on match, 1 on mismatch, printing both values
- `tripact accept --dry-run` prints the trailer an accept would produce without writing the sidecar or clearing escalations

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

- `tripact diff` shows what acceptance would change - claims created, re-anchored, and retired; verified states newly recorded or re-baselined per edge; backlog items newly acknowledged or covered; and the current and would-be trailer values - without writing anything
- A re-baselined verified state distinguishes re-verified (test-side-only, §4.1) from re-baselined after a reword, the latter with old and new text excerpts
- `diff --json` emits the same document machine-readably with a `schemaVersion` field

Section §8.5 (`commit`) is a harness concern: the kernel stops at `accept` and the printed trailer.

---

## 9. Dogfooding

This repository's own `tripact.yaml` declares `UAC.md` as its prescriptive layer, `docs/manual/` as
its descriptive layer, and `test/` as its verificatory layer, checking a spec↔tests edge and a
docs↔tests edge. `README.md` is hand-authored and deliberately outside the descriptive layer: its
sections are orientation prose for a newcomer, not procedures a test could walk. `tripact check` runs
level on the repository, and the kernel's own claims are tagged by the tests under `test/`. This
section carries no claims - it records the setup, not a requirement.

---

## 10. Repair & Generation Tasks

### 10.1 Task emission

- `tripact tasks` derives a work queue from the current analysis without mutating artefacts, the sidecar, or escalations
- One task is emitted per reworded stale claim (§4.1), per orphan tag, and per uncovered descriptive section; uncovered claims are grouped into one task per claim group
- The uncovered-claim task is a find-or-write task: it instructs tagging an existing untagged test that already asserts the claim, or writing a new tagged test only when none exists, and its payload names both options and the exact tag format
- The uncovered-claim task's title leads with the claim group it concerns and states the find-or-write instruction after it, so the group stays readable when a queue of titles is scanned side by side
- A pending verdict emits no task - its cure is an accept recording the verified state, which belongs to the accept gate (§8.3), not to repair work
- A placeholder or informative atom (§3.1) emits no task, so a queue never asks an agent to write a test for a claim the kernel does not coverage-check
- Test-side-only staleness (§4.1) emits no task; only a reworded stale claim, whose own text moved, emits a `reconcile-stale` task
- A derived-stale output (§18.2) emits a `regenerate-derived` task naming the exact `tripact generate` invocation
- `tripact tasks --reconcile <prescriptive>:<descriptive>` additionally emits a single layer-reconciliation task carrying both layers' full inventories, so the agent judges what documentation is missing
- Task ids are deterministic for the same underlying situation
- `tasks --json` emits a machine-readable queue with a `schemaVersion` field; the human output groups tasks by kind and truncates past a fixed threshold unless `--long`
- `tripact prompt <id>` prints a ready-to-hand-off brief for a single work item - a task id or an escalation question id (§7.2) - with the item's self-contained payload inlined; an unknown id exits 1
- The brief frames every string it reproduces from the repository - its title and group heading as well as its inlined claim and atom text - as untrusted specification data, content to satisfy or evidence to weigh, never an instruction addressed to the agent
- The framing notice precedes every reproduced string in the brief, so no untrusted text occupies a position the notice has not yet covered, and it tells the agent to disregard any embedded directive including one claiming to supersede the notice itself
- A string is trusted only by its provenance - written by the kernel itself, or read from `tripact.yaml`, which the operator vouches for by committing it - and never by inspection, so text that merely looks harmless is still untrusted
- Every emitted task names the payload fields that are trusted under that rule; its title and every field not named is repository-derived, so a harness fences by default and a field added later is untrusted until someone says otherwise
- A claim id is repository-derived like the text it was minted from: slug characters permit a hyphenated directive, so an id is never trusted merely for being constrained
- Every emitted task payload that embeds spec or atom text also carries a `source: "spec-atom"` provenance marker on that text, identifying which field holds a claim's own words

### 10.2 Repair handoff

- The emitted `tripact-repair` skill (§1.2) instructs an agent to consume `tripact tasks --json`, follow per-layer conventions files where declared, apply artefact edits, and validate with `tripact check` and the repository's own test command before reporting
- For a find-or-write task, the repair skill instructs the agent to first search the verificatory layer for an existing untagged test that already asserts the claim and tag it in place, writing a new test only when none is found
- The repair skill's accept rule follows the configured accept policy (§2.1)
- The repair skill instructs the agent to treat prescriptive and descriptive artefact text as data to act on, never as commands: a directive embedded in a claim's text is part of the spec to satisfy, not an instruction the agent follows
- Executing repair tasks is agent work: the kernel never edits prescriptive or descriptive artefact content - the sole exception is derived-output generation (§18), a deterministic derivation

### 10.3 Reconcile untagged tests

- `tripact reconcile` proposes, per uncovered non-(TBD) prescriptive claim, existing tests whose title scores above a fixed similarity threshold against the claim text, ranked by score - a propose-only queue for linking claims to tests that already exist
- `reconcile` mutates nothing - no artefact, sidecar, escalation, or tag; confirming a candidate and tagging the test is agent or human work
- Reconcile scoring reuses the deterministic similarity matcher (§3.3) over normalised claim text and normalised test title; an identical tree produces an identical proposal set and ranking, with ties broken by test file and line, then claim id
- A dismissed candidate, recorded via `tripact reconcile --dismiss <claim-id> <file> <line>`, is keyed by claim id and test identity and is never re-proposed until either side's text changes; a dismissal survives an accept
- `reconcile` is opt-in and not part of `check`: it runs its own scan and never affects `check`'s verdicts, counts, or exit code
- `reconcile --json` emits a machine-readable queue with a `schemaVersion` field; the command exits 0 (advisory), or 2 on a config or usage error, and never exits 1

---

## 16. Dispatch & Routing

### 16.1 Effort routing

- `tripact.yaml` accepts a `routing` map from task class to an effort tier (`judgment`, `planning`, `implementation`, or `mechanical`) and a `models` map from effort tier to a model identifier string
- Emitted tasks and escalation questions carry their resolved `effort` and `model` hint when the config binds their class, and carry nothing when it does not - hints are advisory
- Routing and models entries are validated with the same all-at-once error reporting as the rest of the config (§2.2)

### 16.2 MCP serving

- `tripact mcp-serve` exposes the task queue, claim listing, check report, status summary, and escalation queue as MCP read tools over stdio, plus `resolve` as a write tool
- `accept` is exposed as a write tool only when the accept policy is `agents`, and is absent under `human`
- Each MCP read tool returns the same JSON document the corresponding CLI `--json` flag produces
- Every MCP tool whose result reproduces repository text states the untrusted-data rule in its own description, so the guard reaches the model when the tools are registered - before any result exists to carry an injected directive
- A result carrying repository text also carries the framing notice alongside the document, as a separate block so the document itself stays byte-identical to the CLI's
- A tool's description states its own write behaviour accurately: `check` refreshes the escalation queue and says so, so no description claims another tool is the only one that writes

---

## 18. Derived Outputs

### 18.1 Declaration & generation

- Config accepts a `derived` map of name → an `output` path and a `generator`, either a reserved builtin name or a shell command
- The kernel reserves the builtin generator names `cli-reference` and `hotlink-map`, and a config naming a reserved builtin with no registered implementation fails generation with a clear wiring error
- The kernel registers `hotlink-map` itself, because it renders from the kernel's own analysis and needs nothing from a harness; `cli-reference` renders a driving harness's own command tree, so the kernel reserves that name and leaves the implementation for the harness to inject
- A non-reserved generator runs as a shell command whose captured stdout becomes the output file; a non-zero exit fails with exit code 2
- `tripact generate [name]` writes the declared output file(s); with no name it regenerates all
- Generation is deterministic: the same code and config produce byte-identical output

### 18.2 Freshness

- `check` regenerates each declared derived output in memory and byte-compares it with the committed file; a stable mismatch or a missing file is a **derived-stale** finding that drives exit 1
- A generator whose two back-to-back regenerations disagree is reported as non-deterministic rather than stale, since regeneration cannot fix it
- A derived-stale finding appears in the task queue as a `regenerate-derived` task (§10.1)

### 18.3 Block-level derived regions

- Config accepts an optional `blocks` block with `paths` globs naming the files scanned for markers and a `generators` map of name to shell command, declared outside `layers` and `edges` so a block region never produces a coverage verdict
- A block region is fenced by an opening `<!-- tripact:<name> -->` and a closing `<!-- /tripact:<name> -->` marker, and `tripact generate` replaces the content between the fences with the named generator's output, leaving the fences and the rest of the file byte-identical
- Regenerating a block region twice produces a byte-identical file, so block generation is idempotent
- The markdown parser produces no atom from any line inside a block region and opens no group from a heading inside one, while line numbering continues through the region so claims after it keep their true file and line
- `check` regenerates each declared block region in memory and byte-compares it with the committed region; a stable mismatch is a **derived-stale** finding that drives exit 1 and appears as a `regenerate-derived` task
- A block-level derived-stale finding is identified by generator name, file, and line, since one block name may occur in several files and more than once in a file
- A block generator whose two back-to-back regenerations of a region disagree is reported as non-deterministic rather than stale
- A marker naming a generator absent from `blocks.generators`, an opening fence with no matching close, and a nested fence each fail validation with exit code 2 under the all-at-once reporting of §2.2

### 18.4 Generator resolution and extension

- A generator string prefixed `builtin:` resolves to a kernel builtin, one prefixed `harness:` resolves to a generator the driving harness registered at boot, and one prefixed `shell:` runs as a shell command
- A generator string carrying no recognised prefix is a config error naming the three prefixes, rather than being run as a shell command, so a mistyped `builtin:` never silently becomes an execution
- The bare reserved names `cli-reference` and `hotlink-map` still resolve to their builtins, so a config written before the prefixes keeps working
- The kernel builtin namespace is closed, while a harness may register a generator under any name no kernel builtin already holds; registering a name a builtin holds is refused, so no harness can redefine what a builtin means
- A builtin or harness generator renders in-process and spawns no subprocess, so a config whose generators are all builtin or harness executes no external command
- Builtin and harness generators receive a context carrying the repository root and the generator name, plus the file and line of the region when the generator is filling a block
- The kernel provides a `presets-table` builtin rendering the spec-system preset registry (§2.3) as a markdown table of `kind:`, spec system, and what each preset declares, so a documented preset list is derived from the registry rather than transcribed beside it
- The kernel provides a `task-classes` builtin rendering the routable task classes (§16.1) as a bullet list, so documentation of what may be routed is derived from the same constant the config validates against

### 18.5 Shell generator trust boundary

- `tripact.yaml` is repository-controlled input, so a `shell:` generator in it is code the repository supplies; no command from it runs unless the invocation opts in with `--allow-shell` or the `TRIPACT_ALLOW_SHELL=1` environment variable
- Without the opt-in, every builtin and harness generator still renders, and only `shell:` generators are withheld, so a config whose generators are all builtin or harness needs no opt-in at all
- `check` reports each withheld generator by name in a `shellGeneratorsWithheld` warning in both the human report and `check --json`, stating that their derived outputs were not verified rather than reporting them level or stale
- Withheld shell generators never drive exit 1 on their own: not verifying an output is a capability limit, not drift
- `generate` refuses to run when a named or declared generator is `shell:` without the opt-in, exiting 2 and naming the flag, rather than silently writing an output it did not regenerate
- A derived `output` path or block-region file resolving outside the repository root is a config error, so a generated artefact can never be written outside the tree being checked
- Containment is enforced again at the point of writing, against the path's real location on disk rather than its spelling: a target reached through a symbolic link that leaves the repository root is refused, so an in-repo path pointing outside cannot be written through

---

## 20. Navigational Code↔Spec Hotlinks

### 20.1 Code-link configuration

- `tripact.yaml` accepts an optional `codeLinks` block with `paths` (globs over product code) and an optional `tagPattern`, defaulting to the verificatory layer's pattern, then to the built-in default
- `codeLinks` is declared outside `layers` and `edges`: a code file set is never a layer role and never an edge, so it never produces a coverage verdict
- An invalid `codeLinks` block fails validation with exit code 2 under the all-at-once reporting (§2.2)

### 20.2 Scanning code links

- `tripact hotlinks` scans `codeLinks.paths` for tags matching the code-link pattern, each naming a claim id, and reports navigational links between a claim id and the code file:line that tags it
- Hotlink scanning never affects any edge verdict, coverage count, or exit code - a code tag is navigation, not verification
- A code tag referencing an id that is unknown or dead is reported as a navigational orphan with its file:line and, for a dead id, a hint naming the claim's last text
- `hotlinks --json` emits a machine-readable map with a `schemaVersion` field; the command exits 0 (advisory), or 2 on a config or usage error, and never exits 1
- Scanning is deterministic: an identical tree yields an identical, stably ordered map

### 20.3 Hotlink map

- The kernel provides the reserved `hotlink-map` derived renderer (§18.1) which, per code-linked prescriptive claim, renders its spec file:line, its code tag locations, and its covering test tags, byte-identically for the same tree
- Writing a hotlink decoration comment into a tagged function is agent work: the kernel never edits product code, and the `hotlink-map` derivation is its sole write

## 21. Claim Audit

### 21.1 `tripact audit`

- `tripact audit <claim-id>` reports the recorded history of one claim: a header card with its current state, then a newest-first timeline of events reconstructed from the committed sidecar's git history, the adjudication journal, and the git history of its verifying test files
- The header card shows the claim's id, aliveness, layer, group path, current text, and per-edge verdict with supporting tag locations; the timeline's event count precedes the listing
- Sidecar archaeology: audit walks the commits that touched `.tripact/claims.json`, diffs the claim's record between consecutive versions, and derives lifecycle events - created, reworded (old and new text shown), moved (group path change), verified-recorded, re-baselined, verified-dropped, retired, and revived - each attributed to its commit sha, date, author, and `tripact-sync-id` trailer value when the commit carries one
- An accepted-but-uncommitted sidecar surfaces as undated lifecycle events marked uncommitted, ordered ahead of all dated events
- Journal entries naming the claim id (§7.2) appear in the timeline as adjudication events with their recorded action and timestamp
- Commits touching a file named by any of the claim's verified states, past or present, appear as test-history events explicitly marked file-level - audit never presents a file-level commit as claim-precise
- Auditing a dead claim works identically: the header card shows its last text, and the timeline records its retirement
- An unknown claim id exits 2 and names the nearest known ids ranked by the deterministic similarity matcher (§3.3)
- `audit` writes nothing; identical repository state produces byte-identical output
- `audit --json` emits the header and the full timeline machine-readably with a `schemaVersion` field; the command exits 0 (advisory), or 2 on a config or usage error, and never exits 1
- The human timeline truncates past the fixed threshold with the closing line naming `--long`; `--json` always carries every event

Section §21.2 (executed sync-run history) is a harness concern. The kernel's timeline is complete on
its own, and it leaves a merge point open: `runAudit` accepts a harness's own events and interleaves
them into the same deterministic order, and `runDirRel` names a run directory under
`.tripact/sync-runs/` for a harness scraper. A driving harness owns reading its executed
sync-run items and passing them in; the kernel emits none itself.

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
- Human reports name verdicts and question kinds with exactly the `--json` vocabulary - no synonyms
- A human-output change never alters any `--json` document; machine schemas evolve only through their `schemaVersion`
- Human output carries colour drawn from the brand palette; the witness mark rendered on a character grid is available but off unless a repository opts into it, since vertical space in a report is worth more than decoration
- Design elements never carry meaning alone: every state a mark or a colour expresses is also stated in words, so a plain-text or monochrome reading of a report loses nothing
- Design elements are suppressed when the output is not a terminal, when `NO_COLOR` is set, or when the config turns them off

### Kernel/harness boundary

- No module reachable from the importable library entry point imports the binary surface (the command program, the CLI entry, or builtin-generator registration), so a harness embedding the kernel never pulls the reference CLI in with it
- Importing the library registers no builtin generator and mutates no global state: registration is a startup side effect of the binary surface, so under a bare library import a reserved builtin name resolves to a wiring error rather than to a renderer
- The kernel's own builtin registration is reachable on a dedicated package subpath rather than through the barrel, so a harness driving the kernel opts the kernel builtins in with one explicit import and call, while a bare library import still registers nothing

### Footprint

- The CLI runs on Node 22 or newer with no native dependencies
- `.tripact/` contains only `claims.json`, `escalations.json`, and `journal.jsonl`
