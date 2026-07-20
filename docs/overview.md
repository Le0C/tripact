# Overview

This page used to hold a second copy of the README. It drifted, so it no longer does.

The single narrative overview of tripact — concepts, quickstart, configuration, the CLI reference,
and worked integrations for agents, loops, harnesses, and CI — lives in the
[README](../README.md).

Jump straight to:

- [Quickstart](../README.md#quickstart) — install, a config, a first green check
- [Concepts](../README.md#concepts) — layers, claims, verdicts, edges
- [Supported specification styles](../README.md#supported-specification-styles) — what parses as a
  claim, the spec-system presets, and the `(TBD)` marker
- [Configuration](../README.md#configuration) — every `tripact.yaml` key
- [Derived outputs and generators](../README.md#derived-outputs-and-generators) — `derived`,
  `blocks`, generator prefixes, and the `--allow-shell` trust boundary
- [CLI reference](../README.md#cli-reference) — every command, flag, and exit code

## Deeper reference

- [architecture/public-contract.md](./architecture/public-contract.md) — the versioned `--json` and
  MCP shapes, and the compatibility policy that governs them
- [architecture/block-derived-artefacts.md](./architecture/block-derived-artefacts.md) — the design
  behind generated regions inside hand-written files
- [manual/routing.md](./manual/routing.md) — routing task classes to effort tiers
- [../UAC.md](../UAC.md) — tripact's own acceptance criteria, the prescriptive layer it checks
  itself against
- [../SECURITY.md](../SECURITY.md) — threat model and the `tripact.yaml` trust boundary
