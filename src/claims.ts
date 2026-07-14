// `tripact claims` — alive-claim listing for tag discovery. UAC §6.2.
// Deterministic: layer order, then document order; dead entries sorted by id.

import { CLAIMS_SCHEMA_VERSION } from "./contract.js";
import type { Analysis } from "./engine.js";
import type { EdgeVerdictKind } from "./types.js";

export interface ClaimListing {
  id: string;
  layer: string;
  groupPath: string;
  /** Normalised claim text (the sidecar's `text`); for dead claims, the last known text. */
  text: string;
  /** Best verdict across all edges naming this claim; null when none applies (TBD, dead). */
  verdict: EdgeVerdictKind | null;
  tbd: boolean;
  alive: boolean;
  /** Set on dead claims only (UAC §6.2). */
  lastText?: string;
}

export interface ClaimsReportJson {
  schemaVersion: 1;
  claims: ClaimListing[];
}

// Lifecycle progress (UAC §4.1): uncovered < pending < covered, with `stale` above `pending`
// since a stale claim has been verified at least once. Used only to pick the best verdict per
// subject across edges, so relative order is all that matters.
const RANK: Record<EdgeVerdictKind, number> = { covered: 3, stale: 2, pending: 1, uncovered: 0 };

export function listClaims(analysis: Analysis, opts: { all?: boolean } = {}): ClaimsReportJson {
  // best verdict per subject (atom id for P↔V, group slug for D↔V) across all edges
  const bestBySubject = new Map<string, EdgeVerdictKind>();
  for (const v of analysis.verdicts) {
    const prev = bestBySubject.get(v.subject);
    if (prev === undefined || RANK[v.kind] > RANK[prev]) bestBySubject.set(v.subject, v.kind);
  }

  const claims: ClaimListing[] = [];
  for (const layer of analysis.layers.values()) {
    if (layer.role === "verificatory") continue;
    // descriptive verdicts are group-level: map each atom to its group's slug
    const slugByAtomId = new Map<string, string>();
    if (layer.role === "descriptive") {
      for (const g of layer.groups) for (const a of g.atoms) slugByAtomId.set(a.id, g.slug);
    }
    for (const atom of layer.atoms) {
      const subject = slugByAtomId.get(atom.id) ?? atom.id;
      claims.push({
        id: atom.id,
        layer: layer.name,
        groupPath: atom.groupPath,
        text: atom.norm,
        verdict: atom.tbd ? null : (bestBySubject.get(subject) ?? null),
        tbd: atom.tbd,
        alive: true,
      });
    }
  }

  if (opts.all) {
    // dead = retired in the sidecar, or anchored to nothing in the current tree —
    // but never an id that is merely escalation-pending (adjudication decides its fate)
    const deadNow = new Set<string>();
    for (const r of analysis.anchorResults.values()) for (const id of r.deadIds) deadNow.add(id);
    for (const e of analysis.escalations) for (const d of e.deleted) deadNow.delete(d.id);
    const dead = analysis.sidecar.claims
      .filter((c) => !c.alive || deadNow.has(c.id))
      .sort((a, b) => (a.id < b.id ? -1 : 1));
    for (const c of dead) {
      const lastText = c.lastText ?? c.text;
      claims.push({
        id: c.id,
        layer: c.layer,
        groupPath: c.groupPath,
        text: lastText,
        verdict: null,
        tbd: false,
        alive: false,
        lastText,
      });
    }
  }

  return { schemaVersion: CLAIMS_SCHEMA_VERSION, claims };
}

export function renderClaimsHuman(report: ClaimsReportJson): string {
  const alive = report.claims.filter((c) => c.alive);
  const dead = report.claims.filter((c) => !c.alive);
  const lines: string[] = [];
  lines.push(`tripact claims — ${alive.length} alive${dead.length ? ` · ${dead.length} dead` : ""}`);
  lines.push("");
  const byLayer = new Map<string, ClaimListing[]>();
  for (const c of report.claims) {
    const arr = byLayer.get(c.layer);
    if (arr) arr.push(c);
    else byLayer.set(c.layer, [c]);
  }
  for (const [layer, cs] of byLayer) {
    lines.push(`layer ${layer}: ${cs.filter((c) => c.alive).length} alive claims`);
    for (const c of cs) {
      const verdict = !c.alive ? "dead" : c.tbd ? "tbd" : (c.verdict ?? "-");
      lines.push(`  ${verdict.toUpperCase().padEnd(9)} ${c.id} · ${c.groupPath}`);
      lines.push(`            ${c.alive ? c.text : `last text: "${c.text}"`}`);
    }
    lines.push("");
  }
  lines.push("tag a test with the exact id shown here — ids come from this listing, never from claim text");
  return lines.join("\n");
}
