// Repair & generation task derivation. UAC §10.1. Pure derivation from an Analysis —
// never mutates artefacts, sidecar, or escalations.

import { createHash } from "node:crypto";
import {
  DEFAULT_SECTION_TAG_PATTERN,
  DEFAULT_TAG_PATTERN,
  hintsFor,
  tagFormatFromPattern,
  type EffortTier,
} from "./config.js";
import { TASKS_SCHEMA_VERSION } from "./contract.js";
import { deriveOutputs } from "./derived.js";
import type { Analysis } from "./engine.js";
import { truncateListing } from "./report.js";

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
  /** Everything an agent needs to act — self-contained, no tripact internals required. */
  payload: Record<string, unknown>;
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
  // can name the exact tag the verificatory layer's scanner recognises — a group covered via two
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
      // Only `stale` (verified once, then drifted) earns a reconcile task here. `pending`
      // (tagged, never verified) deliberately falls through and emits nothing — its only cure
      // is an accept recording the verified state, which belongs to the accept gate (UAC §10.1,
      // §8.3, §17.2), not to repair work.
      //
      // Of the two stale sub-classes (§4.1), only the **reworded** one — the claim's own text
      // moved — earns a reconcile-stale task; judgment is needed to realign claim and test.
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
          tags: v.tags,
          edge: v.edge,
        },
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
      title: `Tag an existing test or write one for ${ids.length} uncovered claim(s) in "${group}"`,
      payload: {
        group,
        claims: ids.sort().map((id) => ({ id, text: claimText.get(id) ?? "" })),
        tagFormat,
        options: [
          "tag an existing untagged test that already asserts the claim",
          "write a new tagged test only when none exists",
        ],
      },
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
    });
  }

  for (const o of analysis.orphans) {
    tasks.push({
      id: taskId("fix-orphan-tag", o.tag, o.file, String(o.line)),
      kind: "fix-orphan-tag",
      title: `Tag @${o.tag} at ${o.file}:${o.line} references no live claim`,
      payload: { ...o },
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
            .filter((a) => !a.tbd)
            .map((a) => ({ id: a.id, group: a.groupPath, text: a.raw })),
          sections: d.groups.map((g) => ({ slug: g.slug, groupPath: g.groupPath, file: g.file })),
          instruction:
            "Judge semantically which claims lack user-facing documentation. Document user-operable behaviour only; skip internals. Follow the descriptive layer's existing voice and checklist format.",
        },
      });
    }
  }

  tasks.sort((a, b) => (a.id < b.id ? -1 : 1));
  // advisory dispatch hints (UAC §16.1) — attached only when the config binds the task's class
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
