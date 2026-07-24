<!--
  The <source> stays a relative path: only GitHub reads it, and GitHub renders repo-relative SVGs
  correctly. The <img> fallback is an absolute PNG because npm's renderer drops <picture>/<source>
  entirely, and an SVG served from raw.githubusercontent arrives as text/plain and never renders.
-->
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/tripact-lockup-dark.svg">
  <img src="https://raw.githubusercontent.com/Le0C/tripact/main/docs/assets/tripact-lockup.png" alt="tripact" width="340">
</picture>

[![npm](https://img.shields.io/npm/v/tripact?color=DD6320)](https://www.npmjs.com/package/tripact)
[![CI](https://github.com/Le0C/tripact/actions/workflows/ci.yml/badge.svg)](https://github.com/Le0C/tripact/actions/workflows/ci.yml)
[![licence: Apache-2.0](https://img.shields.io/badge/licence-Apache--2.0-blue)](./LICENSE)
[![node](https://img.shields.io/node/v/tripact)](https://nodejs.org)

**tripact** is a deterministic traceability engine that keeps your spec, your docs and your tests in sync. It turns requirements and documentation into _claims_ with stable, content-derived ids, links those claims to tests through explicit tags, and reports when any side stops agreeing with the others.

```console
$ tripact check                 # a spec claim exists, but no test references it
✗ drift detected — 1 new-uncovered
edge specs ↔ tests: 0/1 covered
  NEW-UNCOVERED addition.adda-b-returns-sum "add(a, b) returns the sum of two integers"
✗ drift detected                # exit 1

# …tag the test with @specs:addition.adda-b-returns-sum, baseline once…
$ tripact check
edge specs ↔ tests: 1/1 covered
✓ level                         # exit 0 - the requirement is provably tested
```

No LLM is used in any of that, so the output is deterministic. The questions it cannot answer without
judgement - "is this reworded requirement the same one as before, or a new one?" - are surfaced as a
structured queue for you or your agent to answer.

tripact is an **engine** that any agent or harness can drive through `--json` and exit codes. It
emits claims, queues and ready-to-hand-off briefs, and spawns no agents of its own.

## Install

Requires Git and Node.js ≥ 22. Tested in CI on Linux, macOS and Windows. One platform nuance: a
`shell:` generator runs under the OS's own shell, so a generator command in your `tripact.yaml` must
be valid for the platform it runs on (a Unix command won't run on Windows, and vice versa).

```bash
npm install -D tripact       # or: pnpm add -D tripact · yarn add -D tripact
npx tripact --version
```

The [quickstart](./docs/overview.md#quickstart) goes from zero to one passing check on an example repository in five minutes.

## Documentation

[docs/overview.md](./docs/overview.md) is the full documentation:

- [Quickstart](./docs/overview.md#quickstart) - install, a config, a first green check
- [Concepts](./docs/overview.md#concepts) - layers, claims, verdicts, edges
- [How it works](./docs/overview.md#how-it-works) - the repair loop, rewording, escalations
- [Supported specification styles](./docs/overview.md#supported-specification-styles) - what parses
  as a claim, spec-system presets, `(TBD)`
- [Configuration](./docs/overview.md#configuration) - every `tripact.yaml` key
- [Derived outputs and generators](./docs/overview.md#derived-outputs-and-generators) - `derived`,
  `blocks`, generator prefixes, `--allow-shell`
- [CLI reference](./docs/overview.md#cli-reference) - every command, flag and exit code
- [Usage](./docs/overview.md#usage) - agent instructions, loops, harnesses, CI, merging on a team,
  the library API

## Project

- [CONTRIBUTING.md](./CONTRIBUTING.md) - development setup, and how a change to behaviour flows
  through the spec and the tests
- [SECURITY.md](./SECURITY.md) - threat model, the `tripact.yaml` trust boundary, and how to report
  a vulnerability privately
- [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md)
- [CHANGELOG.md](./CHANGELOG.md)
- [UAC.md](./UAC.md) - tripact's own acceptance criteria; the prescriptive layer it checks itself
  against
- [docs/architecture/public-contract.md](./docs/architecture/public-contract.md) - the versioned
  `--json` and MCP shapes
- Licensed under [Apache-2.0](./LICENSE); see [NOTICE](./NOTICE)
