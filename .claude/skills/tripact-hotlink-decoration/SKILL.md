---
name: tripact-hotlink-decoration
description: >
  Decorate product-code functions with navigational hotlinks to the spec claims they implement.
  Use when the user says "add hotlinks", "decorate the code with spec links", or after a
  `codeLinks` block is configured so a developer can jump from a function to its requirement.
metadata:
  generatedBy: tripact@0.0.1
---

# Decorate code with spec hotlinks

A `codeLinks` block declares which product-code files carry claim-id tags. Your job: place a
clickable hotlink comment in the docstring of each function that implements a claim, so a
developer hovering it in their editor can open the spec claim and its tests. tripact never edits
product code - you do; tripact only reads the tags back with `tripact hotlinks`.

## Steps

1. Run `tripact hotlinks --json` for the current code↔spec links and any orphan code tags, and
   `tripact claims --json` for each claim's declaring `file`/`line` and covering test tags.
2. In the docstring of each function that implements a claim, add:
   - the claim-id tag in the repo's `codeLinks.tagPattern` form, so `tripact hotlinks` links it
   - a back-link to the claim's spec FILE, and forward links to its covering test files, each written
     as a markdown link whose target is a `{@link}` tag:
     `- spec: [SPEC.md - §3.1 Section name]({@link ./../SPEC.md})`
     That combined form is the one that both renders as a label and navigates from an editor hover.
   - Link to the file, never to a line or a heading. A `#L42` or `#some-heading` fragment renders
     but refuses to navigate: JSDoc has no file-link support (microsoft/TypeScript#47718 is still
     open, and line numbers are an unmet ask in that thread). A line number would rot anyway -
     nothing re-checks the back-link text, so it goes wrong the moment the spec shifts and
     tells no one.
     Put the section name in the link label instead: it is greppable and survives edits.
3. Re-run `tripact hotlinks`: the function shows as a link, not an orphan. Fix any orphan code tag
   (unknown or dead id) by correcting it to a live id from `tripact claims`.
4. If a `hotlink-map` derived output is declared, refresh it with `tripact generate`.

## Rules

- Never invent a claim id - copy it from `tripact claims` / `tripact hotlinks` output.
- A code tag is navigation, not verification: it never makes a claim "covered" - only a tagged test
  does that.
- The accept policy is read from `tripact.yaml` (`accept.policy`, default `human`). If you change it, re-emit the skills with `tripact skills --force`.
