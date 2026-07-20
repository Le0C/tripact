# Contributing to tripact

Thanks for your interest in tripact — a deterministic traceability kernel that keeps a
project's spec, docs, and tests in agreement. This guide covers how to get set up, the one
rule that is specific to a traceability tool (keep our own `tripact check` level), and what a
good pull request looks like.

## Prerequisites

- **Node.js >= 22** (see `engines` in `package.json`)
- **Git** — tripact reads git to determine what changed since the last sync point; it will not
  run outside a git repository.

## Getting set up

```bash
git clone https://github.com/Le0C/tripact.git
cd tripact
pnpm install        # see the lockfile note below
pnpm run build      # tsc → dist/
pnpm test           # vitest
pnpm run typecheck  # tsc --noEmit
```

The core scripts:

| Command | What it does |
|---|---|
| `pnpm run build` | Compile `src/` to `dist/` with `tsc`. |
| `pnpm test` | Run the vitest suite once. |
| `pnpm run test:watch` | Run vitest in watch mode. |
| `pnpm run typecheck` | Type-check without emitting. The contract shape-pins live here. |
| `pnpm run dev -- <args>` | Run the CLI from source via `tsx` (e.g. `pnpm run dev -- check`). |

### A note on the lockfile

The repo ships a **`pnpm-lock.yaml`**, so we recommend **pnpm** for a reproducible install that
matches CI (`.github/workflows/ci.yml` installs with `--frozen-lockfile`). The `package.json` `scripts` and `bin` are plain and run under either package
manager — `npm install` / `npm test` work too — but only the pnpm lockfile is committed, so npm
will resolve its own tree. Use pnpm unless you have a reason not to, and don't commit an
`npm`/`yarn` lockfile alongside it.

## Keep `tripact check` level (dogfooding)

tripact uses itself. The repo has a `tripact.yaml` and a `.tripact/` sidecar, and its spec
(`UAC.md`) is linked to its own tests through `@specs:` tags. A traceability tool must not ship
with drift in its own spec, so **before you open a PR, run `tripact check` and make sure the tree
is level (exit 0):**

```bash
pnpm run build && node dist/cli.js check    # against the built CLI
# or, straight from source:
pnpm run dev -- check
```

If `check` reports drift (exit 1):

- **NEW-UNCOVERED** — you added or changed a spec claim without a test proving it. Add a test and
  tag it with `@specs:<id>`.
- **STALE** — a claim or its test changed since it was baselined. Re-verify, then baseline with
  `tripact accept`.
- **Escalations** — a reworded claim the engine won't guess at. Resolve each with
  `tripact resolve <id> --match | --new | --dead`.

A PR that leaves our own `check` in drift will not be merged.

## Changing the public contract

`docs/architecture/public-contract.md` describes the versioned surface every downstream harness
depends on: the `--json` document shapes, the exit-code convention (0 level / 1 drift / 2 usage or
environment error), and the MCP tools. `src/contract.ts` is the single source of truth.

If your change touches that surface:

- **Additive change** (a new top-level field) is backward-compatible. It does **not** bump a
  schema version, but you **must** update the surface's `fields` list in `src/contract.ts` — the
  shape-pin test fails until they agree.
- **Breaking change** (removing/renaming a field, or changing the type or meaning of one) **must
  bump** the relevant `*_SCHEMA_VERSION` constant in `src/contract.ts`. The type checker forces
  this — a version event can never be silent.
- Either way, update `docs/architecture/public-contract.md` in the same PR so the doc and the code
  stay in agreement.

Treat the contract as public API even in 0.x: breaking it breaks every harness that drives the
kernel.

## Commit and pull-request expectations

- Keep commits focused; write imperative-mood subject lines ("Add stale-edge counter", not
  "Added…").
- Every behavioural change needs a test. New or changed spec claims need a tagged test — that's
  what keeps `check` level.
- Add a `## [Unreleased]` entry to `CHANGELOG.md` describing user-visible changes.
- Before opening the PR, confirm: `pnpm run build`, `pnpm test`, `pnpm run typecheck`, and
  `tripact check` all pass.
- Fill out the pull-request template checklist honestly.

## Licensing of contributions (inbound = outbound)

tripact is licensed under **Apache-2.0** (see `LICENSE` and `NOTICE`). By submitting a
contribution, you agree that it is licensed under the **same Apache-2.0** terms as the project
(inbound = outbound), and that you have the right to submit it under that license. We follow a
DCO-style norm: keep contributions your own work, and don't paste in code you can't license this
way. No separate CLA is required.

## Security and conduct

Please report security issues privately — see `SECURITY.md`. All participation is governed by our
`CODE_OF_CONDUCT.md`. For either, the contact is Leo Coleman <leoacoleman@proton.me>.
