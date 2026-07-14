# The public contract

tripact is designed to be driven by any harness — a coding agent, an Archon or Spec Kit workflow, a
GitHub Action, a Claude Code MCP client. What all of them depend on is a small, deliberately
versioned surface: a set of machine-readable JSON documents and an exit-code convention. This is
tripact's public API. Its internals are not.

`src/contract.ts` is the single source of truth. It defines the schema-version constants that the
builders stamp, and a `PUBLIC_CONTRACT` manifest that `test/public-contract.test.ts` enforces
against live CLI output.

## The read surfaces

Each surface is one document, reachable identically through the CLI `--json` flag and the
`mcp-serve` read tools — the MCP tools return byte-identical JSON to the CLI, so there is one
contract, not two.

| Surface | CLI | MCP read tool(s) | Schema | Top-level fields |
|---|---|---|---|---|
| **check** | `check --json`, `status --json` | `check`, `status` | `CHECK_SCHEMA_VERSION` = 1 | `schemaVersion`, `scope`, `syncPoint`, `changedPaths`, `verdicts`, `orphans`, `escalations`, `affectedLayers`, `unsupportedEdges`, `derivedStale`, `counts`, `exitCode` |
| **tasks** | `tasks --json` | `tasks` | `TASKS_SCHEMA_VERSION` = 1 | `schemaVersion`, `tasks` |
| **claims** | `claims --json` | `claims` | `CLAIMS_SCHEMA_VERSION` = 1 | `schemaVersion`, `claims` |
| **escalations** | — (the document `check` writes to `.tripact/escalations.json`) | `escalations` | `ESCALATIONS_SCHEMA_VERSION` = 1 | `schemaVersion`, `questions` |

The write tools — `resolve` (always) and `accept` (only under the `agents` accept policy) — are part
of the MCP surface but are not read documents.

## The exit-code convention

Every command follows one convention, and foreign harnesses branch on it:

| Code | Meaning |
|---|---|
| **0** | level — no drift |
| **1** | drift — findings exist (uncovered/stale/pending verdicts, orphans, escalations, stale derived outputs) |
| **2** | usage or environment error (unknown command/option, not a git repo, config error) |

## Compatibility policy

The payload shapes are versioned like a public API:

- **Additive change** — a new top-level field — is backward-compatible. It does **not** bump the
  schema version, but it **does** require updating the surface's `fields` list in `src/contract.ts`;
  the shape-pin test fails until the two agree.
- **Breaking change** — removing or renaming a field, or changing the type or meaning of an existing
  one — **bumps** that surface's schema version. Because each builder's return type carries the
  version as a literal and the value comes from the constant in `src/contract.ts`, the type checker
  forces both edits at once: a version event can never be silent.

Breaking this contract breaks every harness that drives the kernel, so treat the version as public
and bump it deliberately.
