// Descriptive ↔ Verificatory edge: docs sections ↔ section tags, group-level. UAC §4.2.

import { createHash } from "node:crypto";
import type { EdgeVerdict, Group, OrphanTag } from "../types.js";
import type { SidecarGroup } from "../sidecar.js";
import { scanTags, type TagHit } from "./pv.js";

/** Hash over the group's atom hashes: any atom edit changes it (UAC §4.2). */
export function groupHash(group: Group): string {
  const h = createHash("sha256");
  for (const a of group.atoms) h.update(a.hash);
  return h.digest("hex").slice(0, 16);
}

export function scanSectionTags(files: Map<string, string>, sectionTagPattern: string): TagHit[] {
  return scanTags(files, sectionTagPattern);
}

export function checkDV(
  edge: [string, string],
  groups: Group[],
  tags: TagHit[],
  sidecarGroups: Map<string, SidecarGroup>,
  fileHash: (file: string) => string | null,
): { verdicts: EdgeVerdict[]; orphans: OrphanTag[] } {
  const tagsBySlug = new Map<string, TagHit[]>();
  for (const t of tags) {
    const arr = tagsBySlug.get(t.id);
    if (arr) arr.push(t);
    else tagsBySlug.set(t.id, [t]);
  }
  const verdicts: EdgeVerdict[] = [];
  const liveSlugs = new Set<string>();
  for (const g of groups) {
    liveSlugs.add(g.slug);
    // UAC §3.1: a TBD or informative section is tracked but never coverage-checked.
    if (g.tbd || g.informative) continue;
    const gh = groupHash(g);
    const gTags = tagsBySlug.get(g.slug) ?? [];
    let kind: EdgeVerdict["kind"];
    if (gTags.length === 0) {
      kind = "uncovered";
    } else {
      const rec = sidecarGroups.get(`${g.layer}:${g.slug}`);
      const onEdge = (rec?.verified ?? []).filter(
        (v) => v.edge[0] === edge[0] && v.edge[1] === edge[1],
      );
      if (onEdge.length === 0) {
        // Tagged, but never yet verified on this edge (§4.2): `pending`, never `stale`. A group is
        // never stale before it has been verified once. Its lifecycle mirrors P↔V's (§4.1).
        kind = "pending";
      } else {
        const verified = onEdge.filter((v) => v.claimHash === gh);
        const allVerified = gTags.every((t) =>
          verified.some((v) => v.file === t.file && v.targetFileHash === fileHash(t.file)),
        );
        kind = verified.length && allVerified ? "covered" : "stale";
      }
    }
    verdicts.push({ edge, subject: g.slug, kind, tags: gTags.map((t) => ({ file: t.file, line: t.line })) });
  }
  const orphans: OrphanTag[] = [];
  for (const t of tags) {
    if (!liveSlugs.has(t.id)) orphans.push({ tag: t.id, file: t.file, line: t.line });
  }
  return { verdicts, orphans };
}
