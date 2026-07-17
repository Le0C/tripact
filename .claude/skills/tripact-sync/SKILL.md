---
name: tripact-sync
description: >
  Run one full tripact reconciliation loop - check, adjudicate, repair, validate, and honour
  the accept policy at the final gate. Use when the user says "sync tripact", "run the full
  loop", "bring the spec, docs, and tests back into agreement", or after a feature change.
metadata:
  generatedBy: tripact@0.0.1
---

# Run a tripact sync

Drive the whole loop from the kernel commands. tripact derives the work; you adjudicate
and edit; acceptance happens as the configured accept policy allows.

## Steps

1. **Check.** Run `tripact check --json`. Exit 0 means level - stop, nothing to do.
   Exit 1 means drift; read the report's `escalations` and `verdicts`.
2. **Adjudicate first.** If `escalations` is non-empty, work them with the
   **tripact-adjudicate** skill (or `tripact resolve` directly) before any repair -
   `accept` refuses while identity questions are open. Re-run `tripact check` after.
3. **Repair.** Run `tripact tasks --json` and execute each task with the
   **tripact-repair** skill, matching the declared layer conventions. Re-run
   `tripact check` between passes and stop early if the open work is not going down.
4. **Validate.** Run the repo's own test command; new tests must pass and the check must
   not regress.
5. **Accept.** Under the configured `agents` policy, run `tripact accept` once validation passes and no escalations remain, then present the printed trailer to commit with. Report per stage what you did.

## Rules

- Run `tripact accept` only after validation passes (`tripact check` and the repo's test command) with no open escalations - the configured `agents` accept policy permits it. Never accept while validation is red or escalations remain.
- Never edit the spec without saying so: if a claim seems wrong or missing, report it; do not add or
  reword prescriptive atoms unless the user explicitly asked.
- Never edit `.tripact/*` by hand - go through `tripact resolve`.
- The accept policy is read from `tripact.yaml` (`accept.policy`, default `human`). If you change it, re-emit the skills with `tripact skills --force`.
