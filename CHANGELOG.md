# Changelog

All notable changes to tripact are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
aims to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html). While tripact is in
**0.x (pre-alpha)**, the public contract (`--json` schemas, exit codes, MCP tools) is versioned but
still evolving, and breaking changes may land in minor 0.x releases — pin an exact version.

## [Unreleased]

This is the first public release of tripact, extracted as a standalone deterministic traceability
kernel. There is no prior published history to summarise; earlier development happened inside a
private monorepo and is not reproduced here.

The initial release surface:

### Added

- **`tripact check`** — re-derives claims from the prescriptive (spec) and descriptive (docs)
  layers, re-anchors each to its previous identity, and reports every spec↔test and docs↔test
  edge as covered, newly uncovered, or stale. Deterministic; no LLM.
- **Structured queues** — `tripact tasks`, `tripact claims`, `tripact prompt <id>`, and
  `tripact skills` emit the repair/generation work and per-task briefs for a harness or agent.
- **Escalations** — reworded claims the engine won't guess at are surfaced as a queue and resolved
  with `tripact resolve <id> --match | --new | --dead`.
- **Baselining** — `tripact accept` records a sync point (under the configured accept policy).
- **Versioned public contract** — a `--json` document surface (check/status, tasks, claims,
  escalations), an exit-code convention (0 level / 1 drift / 2 usage or environment error), and a
  Model Context Protocol server (`tripact mcp-serve`) whose read tools return byte-identical JSON
  to the CLI. Defined and shape-pinned by `src/contract.ts`; documented in
  `docs/architecture/public-contract.md`.
- Apache-2.0 license and `NOTICE`.

_The version heading and date for the first tagged release will be added when it is published._

[Unreleased]: https://github.com/Le0C/tripact/commits/main
