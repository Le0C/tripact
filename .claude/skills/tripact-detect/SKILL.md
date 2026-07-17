---
name: tripact-detect
description: >
  Scaffold a tripact.yaml for this repository — classify its files into prescriptive (spec),
  descriptive (docs), and verificatory (test) layers and declare the edges to check between them.
  Use when the user says "set up tripact", "detect the layers", "scaffold the tripact config",
  or when `tripact check` reports that tripact.yaml is missing.
metadata:
  generatedBy: tripact@0.0.1
---

# Scaffold a tripact.yaml

tripact needs a `tripact.yaml` declaring which files hold requirements, which hold user
documentation, and which hold tests — and which of those must agree. Deciding that is a judgement
call, so it is your job, not a fixed heuristic. Propose the config, confirm with the user, write it.

## Steps

1. **Survey the repository.** Look for each role — do not assume conventional paths:
   - **prescriptive** (the source of truth): a product spec, acceptance criteria, PRD, or
     requirements checklist. Common names: `SPECS.md`, `UAC.md`, `REQUIREMENTS.md`, `docs/spec/**`.
     The unit tracked is each Markdown list item.
   - **descriptive** (user-facing docs): manuals, guides, tutorials. Common: `docs/**/*.md`,
     `README` sections, a `manual/` tree. Coverage is evaluated per section.
   - **verificatory** (tests): end-to-end, integration, or unit tests. Detect the framework from
     the repo (Playwright `*.spec.ts`, Vitest/Jest `*.test.ts`, pytest `test_*.py`, …).
2. **Choose layers and globs.** Give each layer a short name and the narrowest glob that captures its
   files. A repo need not have all three — tripact checks only the edges you declare.
3. **Declare edges.** Supported edges are prescriptive↔verificatory and descriptive↔verificatory —
   e.g. `[specs, tests]`, `[manual, tests]`. (Direct spec↔docs is a reconciliation task, not an edge.)
4. **Write `tripact.yaml`** at the repository root. Minimal shape:
   ```yaml
   schemaVersion: 1
   layers:
     specs:  { role: prescriptive, paths: [SPECS.md] }
     manual: { role: descriptive,  paths: ['docs/**/*.md'] }
     tests:  { role: verificatory, paths: ['tests/**/*.spec.ts'] }
   edges:
     - [specs, tests]
     - [manual, tests]
   ```
5. **Verify.** Run `tripact check` — it should parse without a config error and report the initial
   drift (everything uncovered until tests are tagged). Then emit the working skills with
   `tripact skills` and hand off to the tripact-repair skill.

## Rules

- Tag conventions: tests reference spec claims with `@specs:<id>` and doc sections with
  `@manual:<slug>` (override per layer with `tagPattern` / `sectionTagPattern` if your repo differs).
- Propose, then confirm: show the user the layers and edges you inferred before writing the file.
- Do not invent artefacts. If a role has no files, leave that layer out rather than pointing at
  something that is not really a spec / doc / test.
