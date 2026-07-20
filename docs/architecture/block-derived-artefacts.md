# Block-level derived artefacts

**Status: proposal.** Nothing here is implemented. The UAC claims in the last section are drafted
ready to promote into `UAC.md` when the work starts, and are deliberately not there yet: adding them
early would register as new-uncovered drift against a repo that is otherwise at full coverage.

## Why

Derived outputs today are whole files. A generator writes one file, `check` regenerates it in memory
and byte-compares, and a mismatch is derived-stale (§18). That works when the generated thing is the
entire artefact, and it does nothing for a generated fragment sitting inside a hand-written document.

The README is the standing example. The five spec-system presets are defined once in
`src/presets.ts`, and until recently they were described in four places in `README.md`: a prose
table, the `kind` row of the configuration table, a comment in a YAML example, and the section
introduction. The `cursor` preset was added to the source with tests and never reached any of the
four, so a shipped feature was invisible to users for as long as it took someone to read the source.
Consolidating those four copies into one table fixed the instance. It did not fix the mechanism, and
the next preset is exposed to exactly the same failure.

This is drift between a specification and a description of it, which is the thing tripact exists to
catch, occurring inside tripact's own documentation. The whole-file derived machinery cannot reach it
because the README is a hand-written file that happens to contain one generated region.

## The shape

A marker in a document names a generator. The region it fences is replaced by that generator's
output, in place, leaving the rest of the file untouched.

```markdown
Setting a top-level `kind:` fills in the layers, edges, and excludes for a system tripact knows.

<!-- tripact:presets-table -->
| `kind:`     | Spec system     | What the preset declares                          |
| ----------- | --------------- | ------------------------------------------------- |
| `spec-kit`  | GitHub spec-kit | prescriptive `specs/*/spec.md`; excludes `.specify/` |
<!-- /tripact:presets-table -->

Each preset also seeds a conventional verificatory `tests` layer.
```

`tripact generate` rewrites the region. `tripact check` regenerates it in memory and compares,
reporting a stale region the same way it reports a stale file.

### Why HTML comment fences

The obvious syntax is the one that reads best, `<presets-table>` as a bare tag or a
`<presets-table>…</presets-table>` pair. Both lose on rendering. GitHub's markdown sanitiser strips
unknown tags, so a bare tag is invisible but marks only a point, and a region needs a start and an
end to be replaceable more than once. A paired custom tag makes its contents an HTML block, and
CommonMark does not parse markdown inside an HTML block, so the generated table would render as
literal pipes.

HTML comments render as nothing in every markdown implementation, and the content between them stays
ordinary markdown that renders normally. The cost is a wordier marker. This is the same mechanism
doctoc and prettier's range markers use, so it is familiar to anyone who has seen a generated
table-of-contents.

The ergonomic short form is still available later: `generate` could expand a bare
`<!-- tripact:presets-table -->` with no closing fence into a full fenced region on first run, so an
author types one line and tripact completes it. That is additive and is not specified here.

## The parsing rule

This is the requirement the feature stands on.

Whole-file derived outputs stay out of every layer through `exclude`, so their content never parses
as claims. `src/config.ts` says as much where `exclude` is defined. A block has no such escape: the
file is a source artefact and only a region of it is generated.

Left alone, a generated region inside a prescriptive or descriptive layer file would parse as
claims. Generated bullets would become atoms with content-derived ids, and generated headings would
open groups and take part in slug disambiguation. Every time the generator's input changed, those
claims would change identity, and the resulting churn would be reported as drift the author cannot
resolve by editing anything they wrote. tripact would be manufacturing the failure it exists to
detect.

So the markdown parser skips content between block fences. Specifically:

- No atom is produced from a line inside a block region.
- No group is opened by a heading inside a block region.
- Line numbers keep counting through the region, so claims after it keep their true `file:line`.
- The fences themselves produce nothing.

The `.sdoc` parser needs no equivalent. StrictDoc content lives in typed nodes and a comment fence is
not one, so a block region in a `.sdoc` file yields no atoms already. Whether blocks are worth
supporting in `.sdoc` at all is left open below.

## Configuration

Marker scanning needs a declared file set, because sweeping every markdown file in a repository to
look for fences is both slow and surprising. A new top-level `blocks` key:

```yaml
blocks:
  paths:
    - README.md
    - docs/**/*.md
  generators:
    presets-table: presets-table # a reserved builtin
    changelog: node scripts/changelog.js # or any shell command
```

`generators` mirrors the `derived` map's generator semantics exactly: a reserved builtin name renders
in-process through the harness-injected registry, and anything else runs as a shell command whose
stdout becomes the region content. Reusing those semantics means block generators inherit the
determinism contract, the wiring-error behaviour for an unregistered builtin, and the exit-2 shell
failure path without restating any of it.

`blocks` sits outside `layers` and `edges`, like `codeLinks`. A block region never produces a
verdict, and declaring one never makes a claim covered.

The existing `derived` key keeps its meaning of a whole generated file. A block target is a region,
which is a different enough thing that folding both into one key would make `output` conditional on a
sibling field. Two keys, one concept each.

## Generation and freshness

`tripact generate [name]` extends to blocks. With no name it regenerates every declared derived
output and every block region in the declared paths. Regeneration is idempotent: running it twice
leaves the file byte-identical, which is worth an explicit test rather than an assumption, because
the fence-preservation and trailing-newline handling are exactly where an off-by-one lands.

`check` regenerates each region in memory and byte-compares it with the committed region, mirroring
§18.2. A mismatch or an unrunnable generator is a derived-stale finding driving exit 1, and it
appears in the queue as a `regenerate-derived` task. The double-regeneration test for
non-determinism carries over unchanged: two regenerations that disagree mean the generator is
non-deterministic, and reporting it as stale would be a permanent misdiagnosis that regeneration
could never clear.

One thing genuinely differs. A whole-file finding is keyed by the output name, because a name maps to
one path. A block name can appear in several files, and more than once in a file, so a block finding
is keyed by name, file, and line. A reader needs to know which region went stale, and the name alone
does not say.

## The "never edits artefacts" boundary

`UAC.md` opens by saying the kernel never edits artefacts. `generate` already writes derived output
files, so that invariant has always meant it never edits *source* artefacts: the spec, docs, and test
files that carry claims.

A block region inside a layer file looks like a violation, since generate would write into a file
that carries claims. It is not one, and the reason is the parsing rule above. The region is excluded
from parsing, so no claim, group slug, or verdict can depend on a single byte inside it. Rewriting it
cannot change any claim id, cannot move a group, and cannot alter any edge's result. The bytes tripact
writes and the bytes tripact reads as claims are disjoint sets.

That argument only holds while the parsing rule holds, which is why it is the load-bearing
requirement rather than an optimisation. If the parser ever stopped skipping block regions, generate
would begin rewriting claim text, with nothing in the output to say so.

## Failure modes to specify

- A marker naming a generator absent from `blocks.generators` fails validation with exit code 2,
  reported all-at-once with every other config problem per §2.2.
- An opening fence with no matching close fails with exit code 2, naming the file and line. Guessing
  where the author meant the region to end would risk eating hand-written prose.
- A nested fence fails with exit code 2. Regions do not compose and a nested one is a typo.
- Two regions with the same name in one file are allowed. They are independent, and both receive the
  same content.
- A reserved builtin with no registered implementation is a wiring error, matching §18.1.
- A shell generator exiting non-zero fails with exit code 2, matching §18.1.

A marker sitting in a file outside `blocks.paths` is invisible, because nothing scans there. It
cannot be diagnosed without the sweep the declared path set exists to avoid, so it is accepted as a
known blind spot rather than papered over.

## User-defined generators

A user of tripact should be able to declare their own generated block without patching the kernel,
and a harness should be able to ship generators to all of its users without each of them writing a
script. Those are different needs and they want different mechanisms.

### Three tiers

**A shell command, which already works.** `blocks.generators` inherits the `derived` map's generator
semantics, so `my-table: node scripts/my-table.js` needs nothing new. This is the full-power tier and
it covers any case the other two miss. It costs the user a script file and a process spawn per
check.

**A harness-registered generator.** A harness registers named renderers at boot and its users
reference them by name. This is how a harness ships a house table to every repo it drives without
each repo carrying a script. It needs the kernel's registry to open up, which is the next subsection.

**One declarative builtin for the common case.** Most of what people want is a table over structured
data they already keep in the repo. A `table` builtin covers that with no code at all:

```yaml
blocks:
  paths: [README.md, docs/**/*.md]
  generators:
    supported-browsers:
      builtin: table
      source: data/browsers.yaml # json, yaml, or csv
      sort: name # a field name, or omit to keep source order
      columns:
        - { field: name, header: Browser }
        - { field: minVersion, header: Minimum }
```

The line to hold is that this builtin has no expression language. No conditionals, no computed
columns, no formatting callbacks, no partials. A field name selects a value and a header labels it.
The moment a case wants more than that it drops to a shell command, which is why the shell tier
exists. tripact is a traceability kernel, and a table renderer with a DSL in it is the first step
toward being a static site generator instead.

### Opening the registry

`registerGenerator` currently throws for any name outside `RESERVED_BUILTINS`, and the comment on it
says the closed namespace is the point. That is right for kernel builtins and wrong as the only
option, because it leaves a harness no way to offer generators of its own.

Two registries, with different rules:

- **Kernel builtins** stay closed. `cli-reference`, `hotlink-map`, and `table` are kernel-owned names
  whose meaning is the same under every harness.
- **Harness generators** are open. A harness registers any name it likes, and a name already held by
  a kernel builtin is refused, so no harness can change what `table` means in someone's config.

Which one a config entry means should be explicit rather than inferred:

```yaml
generator: builtin:table # kernel builtin
generator: harness:changelog # registered by the driving harness
generator: node scripts/x.js # anything else is a shell command
```

The alternative is bare names resolved by precedence, checking the builtins, then the harness
registry, then falling back to shell. It reads better and it has a failure mode worth avoiding: a
harness that later registers `make` would capture every config whose generator was the shell command
`make`, turning a working build into a different artefact with nothing at the call site to show it
changed. A prefix costs seven characters and removes the class.

tripact is at `0.0.1`, so this is the cheapest it will ever be to settle. Bare `cli-reference` and
`hotlink-map` should keep working through 0.x as aliases, since they are a closed set of two and
already documented.

### The generator signature is public contract

Builtin renderers are `(root: string) => string` today. A block generator can reasonably want to know
which region it is filling, because a table of links rendered into `README.md` and into
`docs/manual/x.md` needs different relative paths. That argues for a context object:

```ts
type GeneratorContext = { root: string; name: string; file?: string; line?: number };
```

`file` and `line` are absent when the generator is filling a whole-file derived output rather than a
block. This is a breaking change to a surface `docs/architecture/public-contract.md` governs, and it
should go in with the rest of the work rather than after, so harnesses adopt one signature.

### Determinism is where user generators will actually break

A user-written generator is far more likely to be accidentally non-deterministic than a kernel one.
Timestamps, hostnames, absolute paths, unsorted map iteration, and a version string read from the
environment are all easy to reach for and all produce a file that never stops being stale.

The existing double-regeneration check in `analyze()` already catches this, and it becomes the
feature's main safety net rather than an edge case. It deserves to be documented as a user-facing
guarantee: a generator whose two back-to-back runs disagree is reported as non-deterministic with its
name, so the author is told their generator is the problem instead of watching `check` fail forever
on a file they keep regenerating.

Worth adding alongside it: `tripact generators` listing every declared generator, its tier, and
whether it resolves, so a user can see that `harness:changelog` is unregistered before they hit it
during a check.

### Executing user code during `check`

`check` runs every declared generator. `runAnalysis` in `src/program.ts` calls `analyze(root)`
without `skipDerived`, and `generateContent` spawns shell commands with `shell: true`. Cloning a
repository and running `tripact check` therefore executes whatever that repository's `tripact.yaml`
puts in a generator field, with no prompt and nothing in the output naming it as executed code.

This is already true of `derived` today and is not introduced by blocks. Blocks make it matter more,
because the whole point of this feature is that many more repositories will have generators, and
because agents run `check` unattended in exactly the loop the README describes.

It should be settled before this ships rather than inherited:

- A flag that skips generator execution and reports derived and block freshness as unverified rather
  than passing them, so a cautious caller has a safe mode that does not lie about coverage.
- The kernel builtins and the declarative `table` need no subprocess at all, so a repo using only
  those is safe by construction. That is a decent argument for the `table` tier existing.

Whether the safe mode is the default is a judgement call about who tripact's cautious caller is. My
read is that a default-safe `check` with an explicit opt-in to run generators would be the wrong
trade for the common case, where the user owns the repo, and the right one for an agent working in a
tree it just cloned.

## Proposed UAC claims

Drafted as §18.3, extending Derived Outputs. Not yet in `UAC.md`.

### 18.3 Block-level derived regions

- Config accepts a `blocks` map of `paths` globs and a `generators` map of name → reserved builtin or shell command, declared outside `layers` and `edges` so a region never produces a coverage verdict
- A block region is fenced by `<!-- tripact:<name> -->` and `<!-- /tripact:<name> -->`, and `tripact generate` replaces the content between the fences with the named generator's output while leaving the fences and the rest of the file byte-identical
- Regenerating a block region twice produces a byte-identical file, so generation is idempotent
- The markdown parser produces no atom from any line inside a block region and opens no group from any heading inside one, while line numbering continues through the region so claims after it keep their true file and line
- `check` regenerates each declared block region in memory and byte-compares it with the committed region; a stable mismatch is a derived-stale finding that drives exit 1 and appears as a `regenerate-derived` task
- A block-level derived-stale finding is identified by name, file, and line, since one block name may occur in several files and more than once per file
- A generator whose two back-to-back regenerations of a region disagree is reported as non-deterministic rather than stale
- A marker naming an undeclared generator, an opening fence with no matching close, and a nested fence each fail validation with exit code 2 under the all-at-once reporting of §2.2

### 18.4 Generator resolution and extension

- A generator string prefixed `builtin:` resolves to a kernel builtin, one prefixed `harness:` resolves to a generator the driving harness registered at boot, and any other string runs as a shell command
- The kernel builtin namespace is closed; a harness may register a generator under any name it does not already hold, and registering a name held by a kernel builtin is refused so no harness can redefine a builtin's meaning
- The kernel provides a `table` builtin rendering a markdown table from a JSON, YAML, or CSV source file with declared columns and an optional sort field, and it evaluates no expressions
- A builtin or harness generator renders in-process and spawns no subprocess, so a config using only these executes no external code during `check`
- Builtin and harness generators receive a context carrying the repo root, the generator name, and, when filling a block region, the file and line of that region
- `tripact generators` lists every declared generator with its tier and whether it resolves
- A generator whose two back-to-back runs disagree is reported as non-deterministic by name, so the author is pointed at the generator rather than at a file that will not stop being stale
- `check` accepts a flag that skips generator execution and reports derived and block freshness as unverified rather than as fresh

## Prerequisites and open questions

**The presets-table builtin needs `SpecSystemPreset` restructured.** Each preset carries a single
`description` string that fuses the system's display name with what the preset declares, for example
`"GitHub spec-kit — product spec at specs/<feature>/spec.md, scaffolding under .specify/"`. The
README table wants those as separate columns, so rendering it means splitting `description` into a
label and a declaration field. That is a small change to a public-ish type, and it should land before
the generator rather than being worked around by parsing the string.

**Should blocks carry arguments?** A marker could take attributes, letting one generator render a
compact and a full variant. Arguments in the marker are part of the generator's input so determinism
survives, but nothing needs it yet and the syntax is hard to withdraw once shipped. Left out.

**Should `.sdoc` files support blocks?** They get the behaviour free, since a comment fence is not a
typed node and yields no atoms. Whether a StrictDoc requirements file is somewhere anyone wants a
generated table is a different question, and answering it needs a user rather than a design note.

**Is the README the right first target, or the manual?** The README is the motivating case and sits
outside every layer, which makes it the low-risk place to prove the mechanism. Putting the first
block in `docs/manual/`, inside a declared descriptive layer, would exercise the parsing rule that
the whole design rests on. Doing the README first and the manual immediately after gets both.
