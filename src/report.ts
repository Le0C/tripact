// Human + JSON reporters. UAC §5.2, §6.1. Deterministic: no timestamps, stable ordering.

import { CHECK_SCHEMA_VERSION } from "./contract.js";
import type { Analysis } from "./engine.js";
import { derivePact, type PactReport } from "./triangle.js";
import type { Atom, EdgeVerdict, Group } from "./types.js";

export interface CheckReportJson {
  schemaVersion: 1;
  scope: "diff" | "full";
  syncPoint: { commit: string; sidecarHash: string } | null;
  changedPaths: string[];
  verdicts: EdgeVerdict[];
  orphans: Analysis["orphans"];
  escalations: Analysis["escalations"];
  affectedLayers: string[];
  unsupportedEdges: string[];
  /** Declared derived outputs whose committed file is stale versus a fresh regeneration (UAC §18.2). */
  derivedStale: string[];
  /** Block regions whose committed content is stale versus a fresh regeneration (UAC §18.3). Carries
   *  file and line as well as the name, since one block name may occur in several places. */
  blockStale: Analysis["blockStale"];
  /** Declared generators whose back-to-back regenerations disagreed (non-deterministic, UAC §18). */
  nonDeterministicGenerators: string[];
  /** Declared layers whose paths matched no files (advisory warning, UAC §5.4). */
  zeroFileLayers: string[];
  /** Prescriptive/descriptive layers that matched files but parsed to zero atoms (advisory, UAC §5.4). */
  zeroAtomLayers: string[];
  /** Atoms whose text carries a prompt-injection signature (advisory content-lint, UAC §5.5). */
  suspiciousAtoms: Analysis["suspiciousAtoms"];
  /**
   * The three-way pact: spec claims, doc sections, and tests correlated on their shared test file
   * (a test tagging both `@specs:` and `@docs:`). Advisory: it feeds no verdict or exit code, and
   * is all-empty unless both a spec↔tests and a docs↔tests edge are declared. Additive field.
   */
  pact: PactReport;
  counts: Record<string, number>;
  exitCode: 0 | 1 | 2;
}

/** Uncovered subjects acknowledged at the last accept; backlog, exempt from drift (UAC §5.1). */
function acknowledgedBacklogCount(analysis: Analysis): number {
  return analysis.verdicts.filter((v) => v.kind === "uncovered" && v.acknowledged).length;
}

/**
 * Groups that forked identity this transition, meaning a dead and a created atom in the same
 * group (UAC §3.3, §5.2). A live re-anchoring-recall metric, counted structurally from the anchor
 * results, independent of whether the fork-review question was dismissed.
 */
function forkCount(analysis: Analysis): number {
  let n = 0;
  for (const r of analysis.anchorResults.values()) n += r.forks.length;
  return n;
}

/**
 * Exit code under level semantics (UAC §5.1, Cross-Cutting): the repo is **level** (0) when it has
 * no pending, stale, or new-uncovered verdicts, no orphans, no escalations, and no stale derived
 * outputs. Acknowledged backlog is reported but never drives exit 1, unless `--strict`, which
 * gates on coverage by treating acknowledged backlog as drift too.
 *
 * Implements @specs:tripact-check-core.exit-code-0-repository
 * - spec:  [UAC.md — §5.1 tripact check core behaviour]({@link ./../UAC.md})
 * - tests: [cli.test.ts]({@link ./../test/cli.test.ts})
 */
export function exitCodeFor(analysis: Analysis): 0 | 1 {
  const newUncovered = analysis.verdicts.some((v) => v.kind === "uncovered" && !v.acknowledged);
  const drift =
    analysis.verdicts.some((v) => v.kind === "stale" || v.kind === "pending") ||
    newUncovered ||
    (analysis.strict && acknowledgedBacklogCount(analysis) > 0) ||
    analysis.orphans.length > 0 ||
    analysis.escalations.length > 0 ||
    analysis.derivedStale.length > 0 ||
    analysis.blockStale.length > 0 ||
    analysis.nonDeterministicGenerators.length > 0;
  return drift ? 1 : 0;
}

export function toJsonReport(analysis: Analysis): CheckReportJson {
  const counts: Record<string, number> = { covered: 0, pending: 0, stale: 0, uncovered: 0 };
  for (const v of analysis.verdicts) counts[v.kind] = (counts[v.kind] ?? 0) + 1;
  // Split the uncovered total into acknowledged backlog vs new-uncovered (UAC §5.1). Additive:
  // the `uncovered` total is retained so existing consumers keep working.
  const acknowledged = acknowledgedBacklogCount(analysis);
  counts["acknowledged"] = acknowledged;
  counts["new-uncovered"] = (counts["uncovered"] ?? 0) - acknowledged;
  counts["orphans"] = analysis.orphans.length;
  counts["escalations"] = analysis.escalations.length;
  counts["derivedStale"] = analysis.derivedStale.length;
  counts["blockStale"] = analysis.blockStale.length;
  counts["nonDeterministicGenerators"] = analysis.nonDeterministicGenerators.length;
  // Fork count (UAC §5.2): re-anchoring recall as a live metric counted from the anchor results.
  counts["forks"] = forkCount(analysis);
  const pact = derivePact(analysis);
  // Pact tallies (advisory; they never drive the exit code). Inner count keys are not contract-pinned.
  counts["pactComplete"] = pact.complete.length;
  counts["pactTestedUndocumented"] = pact.testedUndocumented.length;
  counts["pactUntiedSections"] = pact.untiedSections.length;
  counts["zeroFileLayers"] = analysis.zeroFileLayers.length;
  counts["zeroAtomLayers"] = analysis.zeroAtomLayers.length;
  counts["suspiciousAtoms"] = analysis.suspiciousAtoms.length;
  return {
    schemaVersion: CHECK_SCHEMA_VERSION,
    scope: analysis.scope,
    syncPoint: analysis.syncPoint,
    changedPaths: analysis.changedPaths,
    verdicts: analysis.verdicts,
    orphans: analysis.orphans,
    escalations: analysis.escalations,
    affectedLayers: analysis.affectedLayers,
    unsupportedEdges: analysis.unsupportedEdges,
    derivedStale: analysis.derivedStale,
    blockStale: analysis.blockStale,
    nonDeterministicGenerators: analysis.nonDeterministicGenerators,
    zeroFileLayers: analysis.zeroFileLayers,
    zeroAtomLayers: analysis.zeroAtomLayers,
    suspiciousAtoms: analysis.suspiciousAtoms,
    pact,
    counts,
    exitCode: exitCodeFor(analysis),
  };
}

/**
 * Human listings truncate past a fixed threshold (UAC Cross-Cutting: Human output). The closing
 * line reports the remaining count and names `--long`, which prints everything. Only the human
 * rendering truncates: the `--json` document always carries the full list (a human-output change
 * never alters any `--json` document), so `LISTING_THRESHOLD` lives entirely on this side.
 */
export const LISTING_THRESHOLD = 12;

/**
 * A short, single-line excerpt of a claim's text for the human report (UAC §5.2). Each verdict
 * line carries the claim's own words so a reader recognises it without opening the spec.
 */
export function excerpt(text: string, max = 60): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Truncate a rendered listing to LISTING_THRESHOLD items unless `long`, appending a closing
 * "… and N more" line naming `--long`. `indent` matches the surrounding listing's indentation so
 * the closing line aligns with the items it summarises.
 */
export function truncateListing(items: string[], long: boolean, indent = ""): string[] {
  if (long || items.length <= LISTING_THRESHOLD) return items;
  const shown = items.slice(0, LISTING_THRESHOLD);
  shown.push(`${indent}… and ${items.length - LISTING_THRESHOLD} more — run with --long to see all`);
  return shown;
}

export function renderHuman(analysis: Analysis, opts: { long?: boolean } = {}): string {
  const long = opts.long === true;
  const lines: string[] = [];
  const head = analysis.syncPoint
    ? `sync-point ${analysis.syncPoint.commit.slice(0, 8)} · scope: diff (${analysis.changedPaths.length} changed paths)`
    : "no sync-point found — full audit";
  lines.push(`tripact check — ${head}`);
  if (analysis.affectedLayers.length) {
    lines.push(
      `⚠ changed code maps to layers via pathMap: ${analysis.affectedLayers.join(", ")} — their claims may no longer describe the product; re-run their tests`,
    );
  }
  lines.push("");

  // Subject → its declaring atom/group, so each verdict line can carry the claim's text excerpt and
  // its own declaring file:line (UAC §5.2). Atoms key by id (P↔V subjects), groups by slug (D↔V
  // subjects). Uncovered verdicts have no tag, so the declaring location resolved here is their only
  // location; a group's excerpt is its leaf heading, the closest thing a section has to a claim text.
  const atomById = new Map<string, Atom>();
  const groupBySlug = new Map<string, Group>();
  for (const layer of analysis.layers.values()) {
    if (layer.role === "verificatory") continue;
    for (const a of layer.atoms) atomById.set(a.id, a);
    for (const g of layer.groups) groupBySlug.set(g.slug, g);
  }
  const subjectOf = (
    v: EdgeVerdict,
  ): { groupPath: string; text: string; declaredAt?: { file: string; line: number } } => {
    const a = atomById.get(v.subject);
    if (a) return { groupPath: a.groupPath, text: a.raw, declaredAt: { file: a.file, line: a.line } };
    const g = groupBySlug.get(v.subject);
    if (g) return { groupPath: g.groupPath, text: g.groupPath.split(" > ").pop() ?? g.groupPath, declaredAt: { file: g.file, line: g.line } };
    return { groupPath: "", text: "" };
  };

  const byEdge = new Map<string, EdgeVerdict[]>();
  for (const v of analysis.verdicts) {
    const k = `${v.edge[0]} ↔ ${v.edge[1]}`;
    const arr = byEdge.get(k);
    if (arr) arr.push(v);
    else byEdge.set(k, [v]);
  }
  for (const [edge, verdicts] of byEdge) {
    const covered = verdicts.filter((v) => v.kind === "covered").length;
    lines.push(`edge ${edge}: ${covered}/${verdicts.length} covered`);
    let backlog = 0;
    const listed: EdgeVerdict[] = [];
    for (const v of verdicts) {
      if (v.kind === "covered") continue;
      const acknowledged = v.kind === "uncovered" && v.acknowledged;
      // Acknowledged backlog renders as a count (UAC §5.1), unless --strict, which lists each
      // item so a release pipeline sees exactly what still owes a test.
      if (acknowledged && !analysis.strict) {
        backlog++;
        continue;
      }
      listed.push(v);
    }
    // Group non-covered verdicts under their group heading path within the edge (UAC §5.2): humans
    // navigate the spec by section. Bucket by heading (first-seen order) so each
    // section's verdicts are contiguous even though verdicts arrive globally sorted by subject id.
    const buckets = new Map<string, EdgeVerdict[]>();
    for (const v of listed) {
      const heading = subjectOf(v).groupPath || "(no section)";
      const arr = buckets.get(heading);
      if (arr) arr.push(v);
      else buckets.set(heading, [v]);
    }
    const ordered: Array<{ heading: string; v: EdgeVerdict }> = [];
    for (const [heading, vs] of buckets) for (const v of vs) ordered.push({ heading, v });
    // Truncation counts verdict lines only (not the section headings), preserving the fixed threshold
    // and the closing "… and N more" line naming --long.
    const shown = long ? ordered : ordered.slice(0, LISTING_THRESHOLD);
    let lastGroup: string | undefined;
    for (const { heading, v } of shown) {
      if (heading !== lastGroup) {
        lines.push(`  ${heading}`);
        lastGroup = heading;
      }
      const info = subjectOf(v);
      const label = v.kind === "uncovered" ? (v.acknowledged ? "BACKLOG" : "NEW-UNCOVERED") : v.kind.toUpperCase();
      // Each line carries the claim id, a text excerpt, and a location: the tag's file:line for
      // tagged verdicts, the claim's own declaring file:line for uncovered ones (UAC §5.2).
      const loc = v.tags[0]
        ? `${v.tags[0].file}:${v.tags[0].line}`
        : info.declaredAt
          ? `${info.declaredAt.file}:${info.declaredAt.line}`
          : "?";
      lines.push(`    ${label.padEnd(13)} ${v.subject} — "${excerpt(info.text)}" (${loc})`);
    }
    if (!long && ordered.length > LISTING_THRESHOLD) {
      lines.push(`    … and ${ordered.length - LISTING_THRESHOLD} more — run with --long to see all`);
    }
    if (backlog > 0) lines.push(`  backlog: ${backlog} acknowledged items — see tripact tasks`);
    lines.push("");
  }
  if (analysis.orphans.length) {
    lines.push(`orphan tags (${analysis.orphans.length}):`);
    const details = analysis.orphans.map((o) => {
      const hint = o.deadClaimLastText ? ` — dead claim, last text: "${o.deadClaimLastText}"` : "";
      return `  @${o.tag} at ${o.file}:${o.line}${hint}`;
    });
    lines.push(...truncateListing(details, long, "  "));
    lines.push("");
  }
  if (analysis.escalations.length) {
    lines.push(`escalations (${analysis.escalations.length}) — run the tripact-adjudicate skill or \`tripact resolve\`:`);
    const details = analysis.escalations.map(
      (e) => `  [${e.kind}] ${e.id} in "${e.groupPath}" — ${e.deleted.length} old / ${e.created.length} new`,
    );
    lines.push(...truncateListing(details, long, "  "));
    lines.push("");
  }
  if (analysis.derivedStale.length) {
    lines.push(
      `derived outputs stale (${analysis.derivedStale.length}) — regenerate with \`tripact generate\`:`,
    );
    lines.push(...truncateListing(analysis.derivedStale.map((name) => `  ${name}`), long, "  "));
    lines.push("");
  }
  if (analysis.blockStale.length) {
    // Each line names the region's file and line, not just the generator: one block name may fill
    // several regions, and the name alone would not say which one went stale (UAC §18.3).
    lines.push(
      `block regions stale (${analysis.blockStale.length}) - regenerate with \`tripact generate\`:`,
    );
    lines.push(
      ...truncateListing(
        analysis.blockStale.map((b) => `  ${b.name} (${b.file}:${b.line})`),
        long,
        "  ",
      ),
    );
    lines.push("");
  }
  if (analysis.nonDeterministicGenerators.length) {
    lines.push(
      `non-deterministic generators (${analysis.nonDeterministicGenerators.length}) — two back-to-back regenerations disagreed; make the generator deterministic (no clock/network/host state):`,
    );
    lines.push(...truncateListing(analysis.nonDeterministicGenerators.map((name) => `  ${name}`), long, "  "));
    lines.push("");
  }
  // Fork count (UAC §5.2): re-anchoring recall metric. Forked groups already surface as
  // fork-review questions above; this line reports the count even when they were dismissed.
  const forks = forkCount(analysis);
  if (forks > 0) {
    lines.push(`forks: ${forks} group(s) with a dead + created atom this transition (re-anchoring recall metric)`);
    lines.push("");
  }
  // Three-way pact gaps (advisory; they never affect the level/drift footer). Show only the holes:
  // complete triangles are the healthy case and would pad a drift-focused report. A claim's
  // text excerpt comes from its declaring atom; the location is the tagging test's file:line.
  const pact = derivePact(analysis);
  if (pact.testedUndocumented.length || pact.untiedSections.length) {
    lines.push("three-way gaps:");
    if (pact.testedUndocumented.length) {
      lines.push(`  tested but undocumented (${pact.testedUndocumented.length}):`);
      const details = pact.testedUndocumented.map((t) => {
        const info = subjectOf({ subject: t.claim } as EdgeVerdict);
        const loc = t.tests[0] ?? info.declaredAt?.file ?? "?";
        return `    ${t.claim} — "${excerpt(info.text)}" (${loc})`;
      });
      lines.push(...truncateListing(details, long, "    "));
    }
    if (pact.untiedSections.length) {
      lines.push(`  untied sections (${pact.untiedSections.length}):`);
      const details = pact.untiedSections.map((s) => `    ${s} — test-covered but tied to no spec claim`);
      lines.push(...truncateListing(details, long, "    "));
    }
    lines.push("");
  }
  // Layer diagnostics (UAC §5.4): advisory warnings about a mis-declared layer. They never change
  // the exit code: a spec that resolves to no files or no atoms is a config smell.
  if (analysis.zeroFileLayers.length) {
    lines.push(`warning: ${analysis.zeroFileLayers.length} layer(s) matched no files — check the glob: ${analysis.zeroFileLayers.join(", ")}`);
    lines.push("");
  }
  if (analysis.zeroAtomLayers.length) {
    lines.push(`warning: ${analysis.zeroAtomLayers.length} layer(s) matched files but parsed to 0 atoms — wrong glob or unparsable format: ${analysis.zeroAtomLayers.join(", ")}`);
    lines.push("");
  }
  if (analysis.suspiciousAtoms.length) {
    lines.push(`warning: ${analysis.suspiciousAtoms.length} atom(s) carry a prompt-injection signature — review before an agent works them:`);
    lines.push(...truncateListing(analysis.suspiciousAtoms.map((s) => `  [${s.signal}] ${s.file}:${s.line} — "${excerpt(s.excerpt)}"`), long, "  "));
    lines.push("");
  }
  for (const u of analysis.unsupportedEdges) lines.push(`note: edge ${u}`);
  const code = exitCodeFor(analysis);
  if (code === 0) {
    // Level: no stale/new-uncovered/orphans/escalations/derived-stale (UAC §5.1). Name the
    // acknowledged backlog count when non-zero so the debt stays visible.
    const backlog = acknowledgedBacklogCount(analysis);
    lines.push(backlog > 0 ? `✓ level — ${backlog} acknowledged backlog items (see tripact tasks)` : "✓ level");
  } else {
    lines.push("✗ drift detected");
  }
  return lines.join("\n");
}

export function renderStatus(analysis: Analysis): string {
  const lines: string[] = [];
  lines.push("tripact status");
  lines.push("");
  // Layer-diagnostic warnings (UAC §5.4/§6.1): a zero-file layer, or a zero-atom prescriptive/
  // descriptive layer, is marked inline alongside its counts.
  const zeroFile = new Set(analysis.zeroFileLayers);
  const zeroAtom = new Set(analysis.zeroAtomLayers);
  for (const layer of analysis.layers.values()) {
    const warn = zeroFile.has(layer.name) ? "  ⚠ no files — check the glob" : zeroAtom.has(layer.name) ? "  ⚠ 0 atoms — wrong glob or unparsable format" : "";
    if (layer.role === "verificatory") {
      lines.push(`layer ${layer.name} (${layer.role}): ${layer.files.size} files${warn}`);
      continue;
    }
    const alive = layer.atoms.length;
    const tbd = layer.atoms.filter((a) => a.tbd).length;
    const dead = analysis.sidecar.claims.filter((c) => c.layer === layer.name && !c.alive).length;
    lines.push(`layer ${layer.name} (${layer.role}): ${alive} atoms (${tbd} TBD) · ${dead} dead ids retained${warn}`);
  }
  lines.push("");
  const byEdge = new Map<string, EdgeVerdict[]>();
  for (const v of analysis.verdicts) {
    const k = `${v.edge[0]} ↔ ${v.edge[1]}`;
    (byEdge.get(k) ?? byEdge.set(k, []).get(k))?.push(v);
  }
  for (const [edge, verdicts] of byEdge) {
    const covered = verdicts.filter((v) => v.kind === "covered").length;
    const stale = verdicts.filter((v) => v.kind === "stale").length;
    const uncovered = verdicts.filter((v) => v.kind === "uncovered").length;
    const pct = verdicts.length ? Math.round((covered / verdicts.length) * 100) : 100;
    lines.push(`edge ${edge}: ${pct}% covered (${covered} covered, ${stale} stale, ${uncovered} uncovered)`);
  }
  const pact = derivePact(analysis);
  if (pact.complete.length || pact.testedUndocumented.length || pact.untiedSections.length) {
    lines.push("");
    lines.push(
      `three-way: ${pact.complete.length} complete · ${pact.testedUndocumented.length} tested-undocumented · ${pact.untiedSections.length} untied section(s)`,
    );
  }
  lines.push("");
  lines.push(`orphan tags: ${analysis.orphans.length} · open escalations: ${analysis.escalations.length}`);
  return lines.join("\n");
}
