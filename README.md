# tripact

**The deterministic traceability kernel — keep spec, docs, and tests describing the same
behaviour.**

tripact is a three-way pact between your product specification, your user documentation, and your
tests. It turns requirements and docs into *claims* with stable identities, links those claims to
tests through explicit tags, and reports when any side drifts out of accord with the others.

Everything tripact does is **pure and deterministic** — no LLM, no network, byte-identical output
for the same repository state. The questions that genuinely need judgement (has a reworded
requirement stayed the *same* requirement, or become a new one?) are not guessed: they surface as a
structured queue for a human or a coding agent to answer, and the answer is persisted.

That determinism is the point. tripact is the **kernel** any harness can drive — a coding agent, an
Archon or Spec Kit workflow, a GitHub Action, a pre-commit hook — because it is a callable that
computes truth, not a workflow that orchestrates one.

> **Status: pre-alpha, extracted from [prodsync](../prodsync).** tripact is the kernel that prodsync
> was built around; prodsync is now becoming one harness that drives it. See
> `prodsync/docs/architecture/kernel-harness.md` for the decomposition.

## Install

Requires Git and Node.js ≥ 22.

```bash
# once published:
npm install tripact
# for now, from a sibling checkout:
#   "tripact": "link:../tripact"
```

## Two ways to use it

### 1. As a CLI a harness shells out to

The thin `tripact` binary exposes the kernel commands. Each `--json` document is a versioned public
contract (see [docs/architecture/public-contract.md](./docs/architecture/public-contract.md)):

```bash
tripact check --json        # deterministic drift check → exit 0 level, 1 drift, 2 error
tripact tasks --json        # the repair/generation work queue
tripact claims --json       # every alive claim + its id (use these ids when tagging tests)
tripact resolve <id> --match 'old-id="new text"'   # adjudicate a reworded requirement
tripact diff                # preview what accept would baseline; writes nothing
tripact accept --yes        # baseline the tree; prints the Prodsync-Point trailer
tripact verify <hash>       # check a trailer against the current sidecar
tripact mcp-serve           # serve the read tools + resolve over MCP stdio
```

The canonical agent loop: **`check` → adjudicate any `escalations` → `tasks` → repair each →
re-check → `accept`.** Adjudication comes before repair (accept refuses while identity questions are
open). This is exactly the control flow a foreign harness encodes — the kernel commands stay
identical whether prodsync's own runner, an Archon workflow, or a shell script drives them.

### 2. As a library

```ts
import { analyze, toJsonReport, deriveTasks } from "tripact";

const analysis = analyze(process.cwd());
const report = toJsonReport(analysis);   // the same document `check --json` prints
const queue = deriveTasks(analysis);     // the same document `tasks --json` prints
```

`buildServer` / `serveMcp` are exported too, so a harness can embed the MCP server under its own
identity.

## Configuration

tripact reads `prodsync.yaml` from the repository root — a declaration of the layers it tracks
(prescriptive / descriptive / verificatory) and the edges to check between them. Minimal example:

```yaml
schemaVersion: 1
layers:
  uac:
    role: prescriptive
    paths: [UAC.md]
  manual:
    role: descriptive
    paths: [docs/manual/**/*.md]
  tests:
    role: verificatory
    paths: [tests/**/*.spec.ts]
edges:
  - [uac, tests]
  - [manual, tests]
```

tripact ships no `init` command — scaffolding the config and emitting agent skills are harness
concerns. Author the config directly, or use a full harness (prodsync) to generate it.

## Transitional notes

Extracted pre-alpha; some names still carry prodsync branding and will be migrated deliberately:

- **On-disk names**: the config file is `prodsync.yaml`, the committed sidecar is `.prodsync/`, and
  the baseline trailer is `Prodsync-Point:`. Renaming these (with back-compat) is a separate
  migration — it touches committed sidecars and every consumer's config.
- **No `init` / no skill emission / no run-book execution** — those are harness surface, not kernel.
- **Not yet published** — consumed via a local `link:` dependency for now.
