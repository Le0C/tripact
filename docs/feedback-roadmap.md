# Feedback roadmap

A phased plan for the five points in `feedback.md`, ordered by cost, risk, and dependency. Each
phase is independently shippable. The gating decisions are called out per phase; nothing here is a
spec yet — this is the sequencing scaffold the specs hang off.

## Anchoring tenets (every phase must honour these or explicitly propose overturning one)

1. **Determinism** — no LLM, no clock, no randomness in the kernel. The kernel *proposes*
   deterministically (text similarity, regex scans); judgement is externalised to *escalations* and
   *agent skills*.
2. **Read-only kernel** — tripact "emits claims and instructions rather than a complete harness" and
   "never mutates artefacts." It emits a *task queue*; a driving harness dispatches LLM work.
   Confirmed steer: even code decoration lives in a **skill at the harness layer**, never as kernel
   task-spawning.
3. **Versioned public surfaces** — id/tag format, layer roles, task kinds, and JSON schemas are
   public (`docs/architecture/public-contract.md`). Schema-affecting changes are batched
   deliberately, not bumped piecemeal.

---

## Phase 0 — Quick wins (no model change, no schema bump) — ready to spec now

Both are pure skill/task-framing changes with immediate value.

- **5a — "find-or-write" task reframe.** First check on an existing repo floods the queue with
  `write-tests` tasks for claims whose tests already exist but are untagged. Reframe the task title
  + payload + repair skill so the agent is instructed to *first search for an existing untagged test
  and tag it*, only writing a new one if none is found. Touches `src/tasks.ts` (title/instruction)
  and the repair skill in `src/skills.ts`. No kernel-model change.
- **2/3a — extend `detectSkill` conventions.** Enrich the "Common names" survey list in
  `detectSkill` (`src/skills.ts`) with modern spec/doc conventions: Spec-Kit `.specify/`, OpenSpec
  `openspec/`, `penspec/specs/**`, plus common docs trees (mkdocs/docusaurus/sphinx layouts). Pure
  skill text — respects the deliberate "layer detection is a judgement task, not a kernel heuristic"
  decision. **Open question deferred to Phase 4-adjacent:** *format* adapters (parsing Gherkin/RST/
  frontmatter specs that the list-item parser can't atomise) are a separate, larger decision — see
  "Parse adapters" below.

## Phase 1 — Deterministic reconcile (reuses `similarity.ts` + escalation pattern)

- **5b — `tripact reconcile`.** Propose claim↔existing-test candidate pairings by text similarity
  (test title/description vs claim norm), reusing `src/similarity.ts` (already powering anchoring).
  Surface candidates as an **escalation-style queue**; the agent/human decides and tags. Deterministic
  *proposal*, externalised *judgement* — mirrors the existing reanchor/escalation flow exactly.
- Decisions: the resolve verbs for a proposed pairing (accept→tag / reject); whether reconcile is a
  new command or a `check` mode; whether the candidate queue is a new read surface (additive schema
  change) or folds into escalations.

## Phase 2 — Hash id modality (tag-format / schema-affecting)

- **1 — `idStyle: slug | hash`** (mutually exclusive; primary goal = **clash avoidance**).
  - Hash must be a **minted-once, persisted, deterministic** id (truncated SHA of `groupKey+norm` at
    creation, deduped against the `taken` set like `mintId` already does) — **not** a re-derived
    content hash (which would change on every reword and orphan every tag). Held stable across
    rewording by the existing anchor step, same as slugs.
  - Applies to spec ids (`@specs:<id>`); **decide whether it also covers section slugs**
    (`@manual:<slug>`), since `disambiguateSlugs` is where clashes actually bite.
  - Migration: switching modality is a one-time repo decision, but existing slug tags in tests + the
    sidecar must be handled (rewrite vs. keep-stored-id-and-only-mint-new).
  - **Competing option to spec alongside:** since clash-avoidance is the real goal, a *better
    deterministic disambiguation* of slugs is a cheaper alternative that keeps human-readable ids.
    The spec should weigh hash-vs-disambiguation, not assume hash.
  - Contract impact: id format is public (appears in tags, the claims surface). Batch with any other
    schema-affecting change.

## Phase 3 — Tagging module extraction + config (groundwork)

- **4c — first-class tagging module.** Extract tag handling (the non-trivial `tagFormatFromPattern`
  logic in `config.ts`, the scanners in `edges/pv.ts`/`edges/dv.ts`) into a dedicated module.
  Disambiguate the proposed `tag_spec` / `tag_test` config against the *existing* `tagPattern` /
  `sectionTagPattern` — is `tag_spec` a rename, and is there a new `tag_code` dimension? This phase
  is prerequisite groundwork for code-linking without yet committing to a code layer.

## Phase 4 — Code linking / function decoration (gated; harness-side)

Covers **4a/4b** (tags in function docs, IntelliSense hotlinks) and **5c** (back-propagate tags to
covered code paths). Highest cost, most dependencies, most open questions.

- **The gating fork (still open):**
  - **Option A — navigational relationship only.** Code↔spec is traceability metadata that the
    kernel *scans* (like it scans test tags) but that **never feeds the covered/uncovered verdict**.
    Preserves the "spec↔*test* proves behaviour / provably tested" thesis — a tagged function proves
    *intent to implement*, not verification. Keeps the 3-role model.
  - **Option B — a fourth `code`/`implementation` layer role.** Touches `LayerRole`, edges, verdict
    kinds, and every versioned contract surface. Bigger schema expansion.
  - Confirmed constraint on *both* options: the **decoration work is a harness-layer skill**, and
    the kernel does not spawn the LLM tasks — at most it scans code tags deterministically and emits
    a queue/skill.
- **Hotlink feasibility spike (do before committing to the UX):** TS/VSCode `{@link}` resolves to
  symbols, not arbitrary `file#L123`. Confirm what IntelliSense actually renders as a *clickable*
  link before speccing the hover experience. tripact already knows every atom's `file:line`.
- **5c back-propagation — separate, latest sub-phase.** Requires (i) a code surface (this phase) and
  (ii) **runtime coverage data** (which functions a test executes) — crossing the explicit "no
  test-runner integration in v0" line and adding a coverage dependency (c8/istanbul/coverage.py).
  Deterministic *only* if coverage is fed in as an input artefact. Gate on a coverage-ingestion
  decision; do not bundle with 4a/4b.

---

## Cross-cutting open questions (resolve as specs are written)

- **Parse adapters vs path adapters (points 2/3).** "Detect more spec/doc patterns" is ambiguous
  between *finding* files (a glob/convention list — Phase 0) and *understanding* non-list-item
  formats (Gherkin/RST/frontmatter — a parser change). The Phase 0 work assumes the former; if
  non-markdown-list formats are in scope, that's its own spec with its own phase.
- **Version batching.** Points 1, 2/3-format, 4B, and 5b/5c all can touch versioned surfaces.
  Sequence so schema-version bumps are batched, not incremental.
- **Ready-to-spec now:** Phase 0 (both items) and Phase 1 need no upstream decision. Phase 2 needs
  the hash-vs-disambiguation call. Phase 4 needs the A/B code-surface fork.
