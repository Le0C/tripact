---
name: prodsync-sync
description: >
  Run one full prodsync loop from a single command — orient, adjudicate, repair, validate,
  and honour the accept policy at the final gate. Use when the user says "sync prodsync", "run
  the full loop", "bring the spec, docs, and tests back into agreement", or after a feature
  change when you want prodsync to hand you an ordered run-book to work through.
metadata:
  generatedBy: prodsync@0.0.1
---

# Run a prodsync sync

`prodsync sync` computes the whole loop — orient, adjudicate, repair, validate, accept —
as an ordered run-book. You execute the run-book stage by stage yourself; prodsync derives,
you edit, and acceptance happens as the configured accept policy allows.

## Steps

1. Run `prodsync sync` (add `--json` for the machine-readable run-book with its
   `schemaVersion`). Read the stages in order:
   - **orient**: sync-point, changed paths, affected layers, and — for any declared layer
     with no files — a bootstrap on-ramp suggestion. Treat the on-ramp as a suggestion; run
     `prodsync bootstrap` only if you actually mean to seed that layer.
   - **adjudicate**: open escalation questions with their routing hints.
   - **repair**: derived tasks with their routing hints.
   - **validate**: the configured test command.
   - **accept**: the checklist you stop before.
2. Work the **adjudicate** stage first: answer each question with the **prodsync-adjudicate**
   skill (or `prodsync resolve` directly). Then re-run `prodsync check` before moving on.
3. Work the **repair** stage: execute each task with the **prodsync-repair** skill, matching
   the declared layer conventions. Re-run `prodsync check` between stages and stop early if
   the open work is not going down.
4. Run the configured **validate** command; new tests must pass and the check must not regress.
5. **Honour the accept policy at the final gate.** Under the configured `human` policy, stop before accept: present the diff versus the sync-point and leave baselining to a person. Report per stage what you did.

## Rules

- Never run `prodsync accept` — under the configured `human` accept policy, baselining is a person's call.
- Never edit the spec silently: if a claim seems wrong or missing, report it; do not add or
  reword prescriptive atoms unless the user explicitly asked.
- Never edit `.tripact/*` by hand — go through `prodsync resolve`.
- Report per stage (orient, adjudicate, repair, validate): what you changed and why.
- The accept policy is read from `tripact.yaml` (`accept.policy`, default `human`). If you change it, re-emit the skills with `prodsync init --force`.
