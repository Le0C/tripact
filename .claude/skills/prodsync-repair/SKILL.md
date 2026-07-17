---
name: prodsync-repair
description: >
  Execute prodsync repair and generation tasks — write missing tagged tests, reconcile
  stale claims, fix orphan tags, cover undocumented manual sections, and reconcile a
  descriptive layer against its prescriptive layer. Use when the user says "work the
  prodsync backlog", "repair the drift", "reconcile the manual with the spec", or after
  `prodsync tasks` reports open work.
metadata:
  generatedBy: prodsync@0.0.1
---

# Execute prodsync repair tasks

prodsync detects drift; you repair it. The engine never edits artefact content — that
is your job, under human review.

## Steps

1. Run `prodsync tasks --json` (add `--reconcile <p>:<d>` if asked to reconcile
   documentation against the spec). Each task's `payload` is self-contained; for a
   ready-made brief on a single task run `prodsync prompt <task-id>`.
2. Before editing a layer, read its `conventions` file if `tripact.yaml` declares
   one, and match the existing voice and structure of the artefacts you touch.
3. Work task kinds like this:
   - **write-tests** (find-or-write): first search the verificatory layer for an existing
     untagged test that already asserts the claim and tag it in place; write a new test
     only when none is found. Tag in the test title using the task's `tagFormat`. Never
     tag a test that does not assert the claim.
   - **reconcile-stale**: read the claim and its tagged test; align whichever is wrong
     (test asserts the old behaviour → update the test; claim text drifted → flag to
     the user rather than editing the spec silently).
   - **fix-orphan-tag**: the tag references a retired or mistyped id — find the right
     live id with `prodsync status --json`, or remove the tag if the claim is gone.
   - **cover-section**: write or tag a test that walks the manual section's steps,
     tagged `@manual:<slug>`.
   - **reconcile-layers**: judge which claims lack user-facing documentation and write
     the missing sections in the descriptive layer's existing style. Document
     user-operable behaviour; skip internals.
   - **regenerate-derived**: run the payload's `invocation` to regenerate the stale
     derived output deterministically; never hand-edit a generated file.
4. Validate before reporting: run `prodsync check` AND the repo's own test command.
   New tests must pass; the check must not regress (no new orphans or escalations).
5. Report per task: what you changed, why, and anything you chose not to do.

## Rules

- Never run `prodsync accept` — under the configured `human` accept policy, baselining is a person's call.
- Never edit `.tripact/*` by hand.
- Never invent spec: if a claim seems wrong or missing, report it; do not add or
  reword prescriptive atoms unless the user explicitly asked.
- The accept policy is read from `tripact.yaml` (`accept.policy`, default `human`). If you change it, re-emit the skills with `prodsync init --force`.
