---
name: Feature request
about: Suggest a capability or improvement for tripact
title: ""
labels: enhancement
assignees: ""
---

## Problem / motivation

What are you trying to do that tripact doesn't support today? Describe the traceability workflow or
harness integration you're missing, not just the feature.

## Proposed solution

What you'd like tripact to do. If it's a new command, option, or output, sketch the shape.

## Does this touch the public contract?

tripact keeps a versioned public surface (`--json` schemas, exit codes, MCP tools) documented in
`docs/architecture/public-contract.md`. Check any that apply:

- [ ] Adds or changes a `--json` document field
- [ ] Changes an exit code's meaning
- [ ] Adds or changes an MCP tool
- [ ] No public-contract impact (internal behaviour only)

## Determinism

tripact is deterministic and contains no LLM — the same inputs always produce the same output.
Please confirm your proposal preserves that. If it needs a judgement call, describe how it would be
surfaced as a structured escalation for a harness/agent to resolve, rather than guessed at.

## Alternatives considered

Other approaches you've thought about, and why they fall short.

## Anything else

Links, prior art, or example configs.
