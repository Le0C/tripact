// Navigational code↔spec hotlinks (UAC §20). Scans the configured `codeLinks` file set for claim-id
// tags placed in product-code docstrings and reports navigational links (claim ↔ code file:line) plus
// orphan code tags. This is navigation, not verification: it produces no coverage verdict and never
// gates. Also renders the deterministic `hotlink-map` derived output (§20.3).

import { DEFAULT_TAG_PATTERN } from "./config.js";
import { HOTLINKS_SCHEMA_VERSION } from "./contract.js";
import { scanTags } from "./edges/pv.js";
import { collectFiles, type Analysis } from "./engine.js";

export interface HotlinkLink {
  claimId: string;
  file: string;
  line: number;
}
export interface HotlinkOrphan {
  tag: string;
  file: string;
  line: number;
  /** Set when the tag references a dead claim (UAC §20.2). */
  deadClaimLastText?: string;
}
export interface HotlinksReport {
  schemaVersion: typeof HOTLINKS_SCHEMA_VERSION;
  links: HotlinkLink[];
  orphans: HotlinkOrphan[];
}

/** The tag pattern the code scan uses: an explicit override, else the verificatory layer's, else default. */
function codeLinkPattern(analysis: Analysis): string {
  const cl = analysis.config.codeLinks;
  if (cl?.tagPattern) return cl.tagPattern;
  const verif = Object.values(analysis.config.layers).find((l) => l.role === "verificatory");
  return verif?.tagPattern ?? DEFAULT_TAG_PATTERN;
}

const byFileLine = (a: { file: string; line: number }, b: { file: string; line: number }) =>
  a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line;

/**
 * Scan the configured code file set for claim-id tags and report navigational links (claim ↔ code
 * file:line) plus orphan code tags (unknown or dead ids). Deterministic and stably ordered; never a
 * coverage verdict, never gating (UAC §20.2).
 */
export function scanHotlinks(analysis: Analysis, repoRoot: string): HotlinksReport {
  const cl = analysis.config.codeLinks;
  if (!cl) return { schemaVersion: HOTLINKS_SCHEMA_VERSION, links: [], orphans: [] };
  const files = collectFiles(repoRoot, cl.paths, analysis.config.exclude ?? []);
  const tags = scanTags(files, codeLinkPattern(analysis));
  const liveIds = new Set<string>();
  for (const layer of analysis.layers.values()) for (const a of layer.atoms) liveIds.add(a.id);
  const claimsById = new Map(analysis.sidecar.claims.map((c) => [c.id, c]));
  const links: HotlinkLink[] = [];
  const orphans: HotlinkOrphan[] = [];
  for (const t of tags) {
    if (liveIds.has(t.id)) {
      links.push({ claimId: t.id, file: t.file, line: t.line });
    } else {
      const dead = claimsById.get(t.id);
      orphans.push({
        tag: t.id,
        file: t.file,
        line: t.line,
        ...(dead && !dead.alive && dead.lastText !== undefined ? { deadClaimLastText: dead.lastText } : {}),
      });
    }
  }
  links.sort((a, b) => byFileLine(a, b) || (a.claimId < b.claimId ? -1 : a.claimId > b.claimId ? 1 : 0));
  orphans.sort((a, b) => byFileLine(a, b) || (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0));
  return { schemaVersion: HOTLINKS_SCHEMA_VERSION, links, orphans };
}

export function renderHotlinksHuman(report: HotlinksReport): string {
  if (!report.links.length && !report.orphans.length) {
    return "no code links — no code tags found (declare codeLinks.paths and tag functions in their docstrings)";
  }
  const lines: string[] = [`tripact hotlinks — ${report.links.length} link(s), ${report.orphans.length} orphan(s)`, ""];
  for (const l of report.links) lines.push(`  ${l.file}:${l.line} → ${l.claimId}`);
  for (const o of report.orphans) {
    lines.push(`  ORPHAN ${o.file}:${o.line} → ${o.tag}${o.deadClaimLastText ? ` (dead: "${o.deadClaimLastText}")` : " (unknown claim)"}`);
  }
  return lines.join("\n");
}

/**
 * Render the deterministic `hotlink-map` derived output (UAC §20.3): per code-linked prescriptive
 * claim, its spec file:line, its code tag locations, and its covering test tags. Byte-identical for
 * the same tree.
 */
export function renderHotlinkMap(analysis: Analysis, repoRoot: string): string {
  const hot = scanHotlinks(analysis, repoRoot);
  const codeByClaim = new Map<string, Array<{ file: string; line: number }>>();
  for (const l of hot.links) {
    const arr = codeByClaim.get(l.claimId) ?? [];
    arr.push({ file: l.file, line: l.line });
    codeByClaim.set(l.claimId, arr);
  }
  const testsByClaim = new Map<string, Array<{ file: string; line: number }>>();
  for (const v of analysis.verdicts) {
    if (!v.tags.length) continue;
    const arr = testsByClaim.get(v.subject) ?? [];
    for (const t of v.tags) arr.push({ file: t.file, line: t.line });
    testsByClaim.set(v.subject, arr);
  }
  const specById = new Map<string, { file: string; line: number }>();
  for (const layer of analysis.layers.values()) {
    if (layer.role !== "prescriptive") continue;
    for (const a of layer.atoms) specById.set(a.id, { file: a.file, line: a.line });
  }
  const claims = [...codeByClaim.keys()]
    .filter((id) => specById.has(id))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((id) => ({
      claimId: id,
      spec: specById.get(id)!,
      code: (codeByClaim.get(id) ?? []).slice().sort(byFileLine),
      tests: (testsByClaim.get(id) ?? []).slice().sort(byFileLine),
    }));
  return JSON.stringify({ schemaVersion: HOTLINKS_SCHEMA_VERSION, claims }, null, 2) + "\n";
}
