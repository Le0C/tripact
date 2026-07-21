# Adopting tripact on an existing repository

Your repository already has a specification of some kind and a test suite. Neither knows about the
other. This page takes you from that to a first honest `tripact check`.

Expect the first check to fail. A repository that has never been baselined has no links between its
claims and its tests, and reporting that as a clean tree would be the one thing this tool must never
do. The goal of a first run is an accurate picture, not a green one.

## Detecting your spec system

Before writing any config, ask tripact whether it recognises the layout you already have:

- Run `tripact detect`. It matches known spec systems by the files present on disk, never by reading
  their contents, and it writes nothing at all - no config, no `.tripact/` directory.
- Take a single named system as the answer: it is reported only when exactly one system matches.
- Treat two or more reported systems as a question for you, not a defect. tripact reports every
  system whose signature is present and assigns none of them, because guessing between two layouts
  would silently pick your spec for you.
- Treat no match as the normal case for a repository that predates any spec-driven convention, and
  declare the layers by hand using the next section.

## Declaring layers when nothing matches

A config names your layers, gives each a role, and declares which pairs get checked:

- Set `kind:` to a detected system and stop there. Preset expansion supplies that system's layers,
  edges, and excludes, so `schemaVersion` plus `kind` is a complete config.
- Declare any layer, edge list, or exclude you want to differ. Preset expansion is user-first: what
  you spell out is kept exactly as written, and the preset fills only what you left out.
- Declare two layers yourself when no preset applies - one authoring layer, one test layer - and an
  edge between them. Two layers is the floor, and a `kind:`-only config clears it through the
  preset's own layers rather than needing you to restate them.
- Check the spelling of `kind:` if validation fails. An unknown spec system exits 2 with a message
  naming the ones tripact accepts.

## Reading the layer diagnostics

The first check on a real repository usually reports a warning before it reports any claims. Each
one distinguishes a different mistake:

- Read `matched no files` as a wrong path. The glob found nothing on disk, so the layer is declared
  but empty.
- Read `parsed to 0 atoms` as a wrong format. The glob found files, but nothing in them looked like
  a requirement - the usual cause is a spec whose statements are prose without list items.
- Ignore either warning for now if the layer is deliberately empty. Both are advisory, and neither
  on its own changes the exit code.
- Treat a `vacuous check` differently: it means no authoring layer produced a single claim, so the
  run verified nothing, and it is reported as drift rather than as a level tree.
- Add `--strict` once your layers are populated, which promotes both warnings to drift so a release
  pipeline gates on every declared layer actually being read.

## Linking tests you already have

Most adopted repositories already test much of what their spec claims. `reconcile` finds those
pairings so you do not start from zero coverage:

- Run `tripact reconcile`. For each uncovered claim it proposes existing tests whose titles score
  above a fixed similarity threshold against the claim's text.
- Read each proposal and tag only the tests that genuinely assert the claim. reconcile mutates
  nothing - no tag, no sidecar, no escalation - because deciding whether a test proves a claim is a
  judgement, and a wrong tag is worse than a missing one.
- Dismiss a proposal you have rejected with `tripact reconcile --dismiss <claim-id> <file> <line>`,
  which records it against that claim and test so it is never proposed again.
- Run it whenever you like: reconcile is opt-in and separate from `check`, and never affects its
  verdicts, counts, or exit code.
- Use `reconcile --json` to drive an agent through the queue instead; it carries a `schemaVersion`
  and exits 0 because a proposal is advice, not a failure.
