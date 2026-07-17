---
name: tripact-adjudicate
description: >
  Adjudicate tripact escalation questions in .tripact/escalations.json - ambiguous
  claim re-anchorings and split/merge cases the deterministic engine will not guess at.
  Use when the user says "resolve the tripact escalations", "adjudicate the sync
  questions", after `tripact check` reports open escalations, or before `tripact accept`.
metadata:
  generatedBy: tripact@0.0.1
---

# Adjudicate tripact escalations

tripact tracks requirement/doc checklist items ("claims") with stable identities.
When a claim is reworded beyond mechanical recognition, tripact asks instead of
guessing. Your job: answer those questions with semantic judgment.

## Steps

1. Read `.tripact/escalations.json` (or run `tripact prompt <question-id>` for a
   ready-made per-question brief). Each question has:
   - `kind`: `reanchor` (old claims vs new texts in one section), `split-merge`, or
     `fork-review` (a group lost an old atom and gained a new one - identity forked;
     advisory, never blocks `accept`)
   - `deleted`: old claims (id + text) that no longer match anything
   - `created`: new texts that match no existing claim
   - `candidates`: possible pairings with similarity ratios
2. For each question, decide per atom, using the texts (not the ratios) as evidence:
   - Same requirement restated → `tripact resolve <question-id> --match <old-id>="<new text>"`
   - Genuinely new requirement → `tripact resolve <question-id> --new "<new text>"`
   - Requirement removed → `tripact resolve <question-id> --dead <old-id>`
   - Forked identity is genuinely two different requirements (fork-review) →
     `tripact resolve <question-id> --dismiss` to accept the fork; or `--match` to
     reunite the old id with the new text if it was the same requirement all along.
   Resolving one atom shrinks a multi-atom question in place - the remaining atoms keep
   the same question id, so answer them one at a time without re-running `check`.
   A split (one old → several new) is expressed as one `--match` for the closest
   successor plus `--new` for the others; a merge as `--match` for the surviving
   text's closest ancestor plus `--dead` for the rest.
3. Re-run `tripact check`. Repeat until no `reanchor`/`split-merge` escalations remain
   (`fork-review` questions are advisory - dismiss or match them, but they never gate accept).
4. Report to the user what you decided and why, per question - they review before
   `tripact accept`.

## Rules

- Run `tripact accept` only after validation passes (`tripact check` and the repo's test command) with no open escalations - the configured `agents` accept policy permits it. Never accept while validation is red or escalations remain.
- When genuinely uncertain, ask the user rather than deciding.
- Do not edit `.tripact/*.json` by hand - always go through `tripact resolve`.
- The accept policy is read from `tripact.yaml` (`accept.policy`, default `human`). If you change it, re-emit the skills with `tripact skills --force`.
