---
name: prodsync-hotlink-decoration
description: >
  Decorate product-code functions with navigational hotlinks to the spec claims they implement.
  Use when the user says "add hotlinks", "decorate the code with spec links", or after a
  `codeLinks` block is configured so a developer can jump from a function to its requirement.
metadata:
  generatedBy: prodsync@0.0.1
---

# Decorate code with spec hotlinks

A `codeLinks` block declares which product-code files carry claim-id tags. Your job: place a
clickable hotlink comment in the docstring of each function that implements a claim, so a
developer hovering it in their editor can open the spec claim and its tests. prodsync never edits
product code — you do; prodsync only reads the tags back with `prodsync hotlinks`.

## Steps

1. Run `prodsync hotlinks --json` for the current code↔spec links and any orphan code tags, and
   `prodsync claims --json` for each claim's declaring `file`/`line` and covering test tags.
2. In the docstring of each function that implements a claim, add:
   - the claim-id tag in the repo's `codeLinks.tagPattern` form, so `prodsync hotlinks` links it
   - a clickable back-link to the claim's spec `file:line`, and forward links to its covering tests
3. Re-run `prodsync hotlinks`: the function shows as a link, not an orphan. Fix any orphan code tag
   (unknown or dead id) by correcting it to a live id from `prodsync claims`.
4. If a `hotlink-map` derived output is declared, refresh it with `prodsync generate`.

## Rules

- Never invent a claim id — copy it from `prodsync claims` / `prodsync hotlinks` output.
- A code tag is navigation, not verification: it never makes a claim "covered" — only a tagged test
  does that.
- The accept policy is read from `tripact.yaml` (`accept.policy`, default `human`). If you change it, re-emit the skills with `prodsync init --force`.
