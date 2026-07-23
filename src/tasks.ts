// Repair & generation task derivation. UAC §10.1. Pure derivation from an Analysis: it never
// mutates artefacts, sidecar, or escalations.

import { createHash } from "node:crypto";
import {
  DEFAULT_SECTION_TAG_PATTERN,
  DEFAULT_TAG_PATTERN,
  hintsFor,
  KNOWN_TASK_CLASSES,
  tagFormatFromPattern,
  type EffortTier,
} from "./config.js";
import { TASKS_SCHEMA_VERSION } from "./contract.js";
import { deriveOutputs } from "./derived.js";
import type { Analysis } from "./engine.js";
import { truncateListing } from "./report.js";

// Provenance marker (UAC §10.1) tagging spec/atom text embedded in a task payload as untrusted,
// spec-derived content, so a harness can programmatically identify and fence it instead of relying
// on the brief's prose guard alone (skills.ts). Emitted alongside every payload field that carries
// atom text.
export const SPEC_ATOM_SOURCE = "spec-atom";

export type TaskKind =
  | "write-tests" // uncovered claims, grouped per claim group
  | "reconcile-stale" // claim or its test file changed since verification
  | "fix-orphan-tag"
  | "cover-section" // uncovered descriptive section
  | "reconcile-layers" // P↔D generation task (opt-in via --reconcile)
  | "regenerate-derived"; // stale derived output, regenerable deterministically (UAC §18.2)

export interface Task {
  id: string;
  kind: TaskKind;
  title: string;
  /** Everything an agent needs to act: self-contained, with no tripact internals required. */
  payload: Record<string, unknown>;
  /**
   * Payload keys that are trusted (UAC §10.1). An **allowlist**, deliberately: everything not named
   * here — including `title` and every nested field — is repository-derived and must be fenced.
   *
   * Trust is decided by provenance, never by inspection. A string qualifies two ways only:
   *   1. the kernel wrote it (a fixed instruction, an invocation it composed), or
   *   2. it was read from `tripact.yaml`, which the operator vouches for by committing it — the
   *      same act that trusts a Makefile.
   *
   * Nothing qualifies for looking harmless, which is why the content lint is advisory and cannot
   * confer trust. Claim ids in particular do NOT qualify: they are minted from repository headings,
   * and slug characters happily spell `ignore-all-previous-instructions`.
   *
   * An allowlist because it fails closed. A list of *untrusted* fields would silently pass a field
   * added later; this way the new field is fenced until someone deliberately vouches for it.
   */
  trustedFields: string[];
  /** Advisory dispatch hints from `routing`/`models` config (UAC §16.1). Absent without config. */
  effort?: EffortTier;
  model?: string;
}

export interface TaskQueue {
  schemaVersion: 1;
  tasks: Task[];
}

/** Deterministic task id: kind + sorted parts hashed (shared with bootstrap derivation, UAC §15.1). */
export function taskId(kind: string, ...parts: string[]): string {
  const h = createHash("sha256");
  h.update(kind);
  for (const p of [...parts].sort()) h.update(p);
  return `${kind}-${h.digest("hex").slice(0, 10)}`;
}

export function deriveTasks(analysis: Analysis, reconcile?: { prescriptive: string; descriptive: string }): TaskQueue {
  const tasks: Task[] = [];

  // uncovered claims, grouped per claim group (UAC §10.1). Keyed by (group, tagFormat) so the task
  // can name the exact tag the verificatory layer's scanner recognises. A group covered via two
  // edges with different tag patterns splits into two tasks rather than emitting one ambiguous tag.
  const uncoveredByGroup = new Map<string, { group: string; ids: string[]; tagFormat: string }>();
  const claimText = new Map(analysis.sidecar.claims.map((c) => [c.id, c.text]));
  for (const layer of analysis.layers.values()) {
    for (const atom of layer.atoms) claimText.set(atom.id, atom.norm);
  }
  const claimsById = new Map(analysis.sidecar.claims.map((c) => [c.id, c]));
  for (const v of analysis.verdicts) {
    const layer = analysis.layers.get(v.edge[0])?.role === "verificatory" ? v.edge[1] : v.edge[0];
    const source = analysis.layers.get(layer);
    if (!source || source.role !== "prescriptive") continue;
    if (v.kind === "uncovered") {
      const atom = source.atoms.find((a) => a.id === v.subject);
      const group = atom?.groupPath ?? "(unknown group)";
      const verif = v.edge[0] === layer ? v.edge[1] : v.edge[0];
      const pattern = analysis.config.layers[verif]?.tagPattern ?? DEFAULT_TAG_PATTERN;
      const tagFormat = tagFormatFromPattern(pattern, "<id>");
      const key = `${group} ${tagFormat}`;
      const entry = uncoveredByGroup.get(key);
      if (entry) entry.ids.push(v.subject);
      else uncoveredByGroup.set(key, { group, ids: [v.subject], tagFormat });
    } else if (v.kind === "stale") {
      // Only `stale` (verified once, then drifted) produces a reconcile task here. `pending`
      // (tagged, never verified) deliberately falls through and emits nothing; its only cure
      // is an accept recording the verified state, which belongs to the accept gate (UAC §10.1,
      // §8.3, §17.2) rather than to repair work.
      //
      // Of the two stale sub-classes (§4.1), only the **reworded** one (the claim's own text
      // moved) gets a reconcile-stale task, since judgment is needed to realign claim and test.
      // **Test-side-only** staleness (the claim text still matches its verified state and only a
      // tagged file's hash moved) emits no task: green validation plus the accept gate re-verify
      // it without semantic judgment (UAC §10.1, §17.2). It is test-side-only when a recorded
      // verified state on this edge still carries the current claim hash.
      const atom = source.atoms.find((a) => a.id === v.subject);
      const onEdge = (claimsById.get(v.subject)?.verified ?? []).filter(
        (vs) => vs.edge[0] === v.edge[0] && vs.edge[1] === v.edge[1],
      );
      const testSideOnly = atom !== undefined && onEdge.some((vs) => vs.claimHash === atom.hash);
      if (testSideOnly) continue;
      tasks.push({
        id: taskId("reconcile-stale", v.subject),
        kind: "reconcile-stale",
        title: `Claim "${v.subject}" or its test changed since verification — reconcile and re-verify`,
        payload: {
          claimId: v.subject,
          claimText: claimText.get(v.subject) ?? "",
          source: SPEC_ATOM_SOURCE, // `claimText` is untrusted spec-derived text (UAC §10.1)
          tags: v.tags,
          edge: v.edge,
        },
        trustedFields: ["source", "edge"],
      });
    }
  }
  const groupBuckets = [...uncoveredByGroup.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, bucket]) => bucket);
  for (const { group, ids, tagFormat } of groupBuckets) {
    tasks.push({
      id: taskId("write-tests", group, tagFormat, ...ids),
      kind: "write-tests",
      // Find-or-write (UAC §10.1): tag an existing untagged test that already asserts the claim, or
      // write a new one only when none exists. The payload names both options and the exact tag
      // format so the agent can search-then-tag before reaching for a fresh test.
      //
      // The group leads the title and the instruction trails it: every task in this kind repeats the
      // same instruction, so putting it first pushes the one part that differs between them — the
      // group — past where a scanned column of titles is still readable (UAC §10.1).
      title: `${group} — Tag or write a test for these claims`,
      payload: {
        group,
        claims: ids.sort().map((id) => ({ id, text: claimText.get(id) ?? "", source: SPEC_ATOM_SOURCE })),
        tagFormat,
        options: [
          "tag an existing untagged test that already asserts the claim",
          "write a new tagged test only when none exists",
        ],
      },
      trustedFields: ["tagFormat", "options"],
    });
  }

  // stale derived outputs (UAC §18.2): a mechanical regeneration task naming the exact
  // `generate` invocation. Routing hints (e.g. mechanical) attach below via hintsFor.
  const derivedByName = new Map(deriveOutputs(analysis.config).map((d) => [d.name, d]));
  for (const name of analysis.derivedStale) {
    const d = derivedByName.get(name);
    tasks.push({
      id: taskId("regenerate-derived", name),
      kind: "regenerate-derived",
      title: `Derived output "${name}" is stale — regenerate it`,
      payload: { name, output: d?.output ?? "", invocation: `tripact generate ${name}` },
      // All three are config-declared or kernel-composed — nothing here came from a spec file.
      trustedFields: ["name", "output", "invocation"],
    });
  }

  // stale block regions (UAC §18.3): the same mechanical regeneration task, keyed by name, file and
  // line so two regions of one generator produce two distinct tasks rather than colliding on one id.
  for (const b of analysis.blockStale) {
    tasks.push({
      id: taskId("regenerate-derived", b.name, b.file, String(b.line)),
      kind: "regenerate-derived",
      title: `Block region "${b.name}" in ${b.file} is stale - regenerate it`,
      payload: { name: b.name, output: b.file, line: b.line, invocation: `tripact generate ${b.name}` },
      // `output` is a repository file path discovered by glob, so unlike the derived-output task
      // above it is NOT trusted; the generator name and the invocation are.
      trustedFields: ["name", "line", "invocation"],
    });
  }

  for (const o of analysis.orphans) {
    tasks.push({
      id: taskId("fix-orphan-tag", o.tag, o.file, String(o.line)),
      kind: "fix-orphan-tag",
      title: `Tag @${o.tag} at ${o.file}:${o.line} references no live claim`,
      payload: { ...o },
      // Nothing: the tag text, the path, and the dead claim's last words are all repo-derived.
      trustedFields: [],
    });
  }

  for (const v of analysis.verdicts) {
    const layer = analysis.layers.get(v.edge[0])?.role === "verificatory" ? v.edge[1] : v.edge[0];
    const source = analysis.layers.get(layer);
    if (!source || source.role !== "descriptive" || v.kind !== "uncovered") continue;
    const group = source.groups.find((g) => g.slug === v.subject);
    const verif = v.edge[0] === layer ? v.edge[1] : v.edge[0];
    const pattern = analysis.config.layers[verif]?.sectionTagPattern ?? DEFAULT_SECTION_TAG_PATTERN;
    tasks.push({
      id: taskId("cover-section", layer, v.subject),
      kind: "cover-section",
      title: `Manual section "${v.subject}" has no test walking its steps`,
      payload: {
        layer,
        slug: v.subject,
        groupPath: group?.groupPath ?? "",
        file: group?.file ?? "",
        tagFormat: tagFormatFromPattern(pattern, "<slug>"),
      },
      // `layer` names a config-declared layer and `tagFormat` derives from its configured pattern.
      // The slug, heading path and file are all minted from or read out of the repository.
      trustedFields: ["layer", "tagFormat"],
    });
  }

  if (reconcile) {
    const p = analysis.layers.get(reconcile.prescriptive);
    const d = analysis.layers.get(reconcile.descriptive);
    if (p?.role === "prescriptive" && d?.role === "descriptive") {
      tasks.push({
        id: taskId("reconcile-layers", reconcile.prescriptive, reconcile.descriptive),
        kind: "reconcile-layers",
        title: `Reconcile documentation: does "${reconcile.descriptive}" document everything "${reconcile.prescriptive}" promises?`,
        payload: {
          prescriptiveLayer: reconcile.prescriptive,
          descriptiveLayer: reconcile.descriptive,
          claims: p.atoms
            .filter((a) => !a.tbd && !a.informative)
            .map((a) => ({ id: a.id, group: a.groupPath, text: a.raw, source: SPEC_ATOM_SOURCE })),
          sections: d.groups.map((g) => ({ slug: g.slug, groupPath: g.groupPath, file: g.file })),
          instruction:
            "Judge semantically which claims lack user-facing documentation. Document user-operable behaviour only; skip internals. Follow the descriptive layer's existing voice and checklist format.",
        },
        // The two layer names come from the config; the instruction is the kernel's own words.
        // `claims` and `sections` are the repository's, ids and headings included.
        trustedFields: ["prescriptiveLayer", "descriptiveLayer", "instruction"],
      });
    }
  }

  tasks.sort((a, b) => (a.id < b.id ? -1 : 1));
  // advisory dispatch hints (UAC §16.1), attached only when the config binds the task's class
  const hinted = tasks.map((t) => {
    const hints = hintsFor(analysis.config, t.kind);
    return hints ? { ...t, ...hints } : t;
  });
  return { schemaVersion: TASKS_SCHEMA_VERSION, tasks: hinted };
}

export function renderTasksHuman(queue: TaskQueue, opts: { long?: boolean } = {}): string {
  const long = opts.long === true;
  if (queue.tasks.length === 0) return "no tasks — all edges in accord";
  const lines: string[] = [`tripact tasks — ${queue.tasks.length} task(s)`];
  const byKind = new Map<string, Task[]>();
  for (const t of queue.tasks) {
    const arr = byKind.get(t.kind);
    if (arr) arr.push(t);
    else byKind.set(t.kind, [t]);
  }
  for (const [kind, ts] of [...byKind.entries()].sort()) {
    lines.push("", `${kind} (${ts.length}):`);
    lines.push(...truncateListing(ts.map((t) => `  ${t.id}  ${t.title}`), long, "  "));
  }
  return lines.join("\n");
}

/**
 * The routable task classes as a markdown bullet list (UAC §18.4), the `task-classes` builtin's
 * output. Rendered from KNOWN_TASK_CLASSES, the same constant `routing:` is validated against, so a
 * class added to the kernel cannot leave the documentation behind.
 *
 * Emitted in declaration order, which groups the classes as they were designed rather than
 * alphabetically, and is stable across runs.
 */
export function renderTaskClasses(): string {
  return KNOWN_TASK_CLASSES.map((c) => `- \`${c}\``).join("\n");
}
