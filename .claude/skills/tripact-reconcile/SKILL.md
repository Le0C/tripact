---
name: tripact-reconcile
description: >
  Work tripact's reconcile queue - existing untagged tests that may already assert an
  uncovered claim. Use when the user says "reconcile the untagged tests", "link claims to
  existing tests", or after `tripact check` shows a large uncovered backlog on a repo that
  already has tests.
metadata:
  generatedBy: tripact@0.1.0
---

# Reconcile untagged tests

On a repo with existing tests, many claims read uncovered only because no test carries a tag
yet. `tripact reconcile` proposes, per uncovered claim, existing tests whose title resembles
the claim - a propose-only queue. Your job: confirm the genuine matches and tag them, and
dismiss the rest. tripact never tags for you.

## Steps

1. Run `tripact reconcile --json`. Each entry has a `claimId`, the `claimText`, the exact
   `tagFormat` to use, and ranked `candidates` (each a test `file`, `line`, `title`, and
   similarity `score`).
2. For each candidate, open the test and read what it actually asserts - the score is a hint,
   not proof. Then either:
   - It genuinely asserts the claim → add the tag (`tagFormat` with the `claimId`) to that
     test's title, exactly as `tripact check` scans for it. Never tag a test that does not
     assert the claim.
   - It does not → `tripact reconcile --dismiss <claimId> <file> <line>` so it is not
     re-proposed until either side's text changes.
3. Re-run `tripact check`: newly tagged claims move uncovered → pending → covered once
   baselined. Write a genuine test for any claim still uncovered (see the repair skill).
4. Report per claim what you tagged, dismissed, or left for a fresh test.

## Rules

- Run `tripact accept` only after validation passes (`tripact check` and the repo's test command) with no open escalations - the configured `agents` accept policy permits it. Never accept while validation is red or escalations remain.
- `reconcile` proposes; you decide. Tag only a test that truly asserts the claim.
- The accept policy is read from `tripact.yaml` (`accept.policy`, default `human`). If you change it, re-emit the skills with `tripact skills --force`.
