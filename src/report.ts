// Human + JSON reporters. UAC §5.2, §6.1. Deterministic: no timestamps, stable ordering.

import { CHECK_SCHEMA_VERSION } from "./contract.js";
import type { Analysis } from "./engine.js";
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
  counts: Record<string, number>;
  exitCode: 0 | 1 | 2;
}

/** Uncovered subjects acknowledged at the last accept — backlog, not drift (UAC §5.1). */
function acknowledgedBacklogCount(analysis: Analysis): number {
  return analysis.verdicts.filter((v) => v.kind === "uncovered" && v.acknowledged).length;
}

/**
 * Groups that forked identity this transition — a dead and a created atom in the same group
 * (UAC §3.3, §5.2). A live re-anchoring-recall metric, counted structurally from the anchor
 * results (independent of whether the fork-review question was dismissed).
 */
function forkCount(analysis: Analysis): number {
  let n = 0;
  for (const r of analysis.anchorResults.values()) n += r.forks.length;
  return n;
}

/**
 * Exit code under level semantics (UAC §5.1, Cross-Cutting): the repo is **level** (0) when
 * no pending, stale, or new-uncovered verdicts, no orphans, no escalations, no stale derived
 * outputs. Acknowledged backlog is reported but never drives exit 1 — unless `--strict`, which
 * restores coverage-gating by treating acknowledged backlog as drift too.
 */
export function exitCodeFor(analysis: Analysis): 0 | 1 {
  const newUncovered = analysis.verdicts.some((v) => v.kind === "uncovered" && !v.acknowledged);
  const drift =
    analysis.verdicts.some((v) => v.kind === "stale" || v.kind === "pending") ||
    newUncovered ||
    (analysis.strict && acknowledgedBacklogCount(analysis) > 0) ||
    analysis.orphans.length > 0 ||
    analysis.escalations.length > 0 ||
    analysis.derivedStale.length > 0;
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
  // Fork count (UAC §5.2): re-anchoring recall as a live metric, not run-log archaeology.
  counts["forks"] = forkCount(analysis);
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
    counts,
    exitCode: exitCodeFor(analysis),
  };
}

/**
 * Human listings truncate past a fixed threshold (UAC Cross-Cutting: Human output) — the closing
 * line reports the remaining count and names `--long`, which prints everything. Only the human
 * rendering truncates: the `--json` document always carries the full list (a human-output change
 * never alters any `--json` document), so `LISTING_THRESHOLD` lives entirely on this side.
 */
export const LISTING_THRESHOLD = 12;

/**
 * A short, single-line excerpt of a claim's text for the human report (UAC §5.2) — each verdict
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
  lines.push(`prodsync check — ${head}`);
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
      // Acknowledged backlog is a count, not a line-by-line list (UAC §5.1) — unless --strict,
      // which lists them so a release pipeline sees exactly what still owes a test.
      if (acknowledged && !analysis.strict) {
        backlog++;
        continue;
      }
      listed.push(v);
    }
    // Group non-covered verdicts under their group heading path within the edge (UAC §5.2): humans
    // navigate the spec by section, not a flat id list. Bucket by heading (first-seen order) so each
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
    if (backlog > 0) lines.push(`  backlog: ${backlog} acknowledged items — see prodsync tasks`);
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
    lines.push(`escalations (${analysis.escalations.length}) — run the prodsync-adjudicate skill or \`prodsync resolve\`:`);
    const details = analysis.escalations.map(
      (e) => `  [${e.kind}] ${e.id} in "${e.groupPath}" — ${e.deleted.length} old / ${e.created.length} new`,
    );
    lines.push(...truncateListing(details, long, "  "));
    lines.push("");
  }
  if (analysis.derivedStale.length) {
    lines.push(
      `derived outputs stale (${analysis.derivedStale.length}) — regenerate with \`prodsync generate\`:`,
    );
    lines.push(...truncateListing(analysis.derivedStale.map((name) => `  ${name}`), long, "  "));
    lines.push("");
  }
  // Fork count (UAC §5.2): re-anchoring recall metric. Forked groups already surface as
  // fork-review questions above; this line reports the count even when they were dismissed.
  const forks = forkCount(analysis);
  if (forks > 0) {
    lines.push(`forks: ${forks} group(s) with a dead + created atom this transition (re-anchoring recall metric)`);
    lines.push("");
  }
  for (const u of analysis.unsupportedEdges) lines.push(`note: edge ${u}`);
  const code = exitCodeFor(analysis);
  if (code === 0) {
    // Level: no stale/new-uncovered/orphans/escalations/derived-stale (UAC §5.1). Name the
    // acknowledged backlog count when non-zero so the debt stays visible.
    const backlog = acknowledgedBacklogCount(analysis);
    lines.push(backlog > 0 ? `✓ level — ${backlog} acknowledged backlog items (see prodsync tasks)` : "✓ level");
  } else {
    lines.push("✗ drift detected");
  }
  return lines.join("\n");
}

export function renderStatus(analysis: Analysis): string {
  const lines: string[] = [];
  lines.push("prodsync status");
  lines.push("");
  for (const layer of analysis.layers.values()) {
    if (layer.role === "verificatory") {
      lines.push(`layer ${layer.name} (${layer.role}): ${layer.files.size} files`);
      continue;
    }
    const alive = layer.atoms.length;
    const tbd = layer.atoms.filter((a) => a.tbd).length;
    const dead = analysis.sidecar.claims.filter((c) => c.layer === layer.name && !c.alive).length;
    lines.push(`layer ${layer.name} (${layer.role}): ${alive} atoms (${tbd} TBD) · ${dead} dead ids retained`);
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
  lines.push("");
  lines.push(`orphan tags: ${analysis.orphans.length} · open escalations: ${analysis.escalations.length}`);
  return lines.join("\n");
}
