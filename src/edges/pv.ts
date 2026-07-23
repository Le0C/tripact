// Prescriptive ↔ Verificatory edge: claim ids ↔ test tags. UAC §4.1.
// Pure text scan of the verificatory layer, with no test-runner integration in v0.

import type { Atom, EdgeVerdict, OrphanTag } from "../types.js";
import type { SidecarEntry } from "../sidecar.js";

export interface TagHit {
  id: string;
  file: string;
  line: number;
}

export function scanTags(files: Map<string, string>, tagPattern: string): TagHit[] {
  const hits: TagHit[] = [];
  for (const [file, content] of [...files.entries()].sort()) {
    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const re = new RegExp(tagPattern, "g");
      let m: RegExpExecArray | null;
      while ((m = re.exec(lines[i] as string)) !== null) {
        const id = m[1];
        if (id) hits.push({ id, file, line: i + 1 });
      }
    }
  }
  return hits;
}

export function checkPV(
  edge: [string, string],
  atoms: Atom[],
  tags: TagHit[],
  claimsById: Map<string, SidecarEntry>,
  fileHash: (file: string) => string | null,
): { verdicts: EdgeVerdict[]; orphans: OrphanTag[] } {
  const tagsById = new Map<string, TagHit[]>();
  for (const t of tags) {
    const arr = tagsById.get(t.id);
    if (arr) arr.push(t);
    else tagsById.set(t.id, [t]);
  }
  const verdicts: EdgeVerdict[] = [];
  const liveIds = new Set<string>();
  for (const atom of atoms) {
    liveIds.add(atom.id);
    // UAC §3.1: TBD atoms (including unfilled template placeholders) and informative atoms are
    // tracked but excluded from coverage — there is no test that could move either verdict.
    if (atom.tbd || atom.informative) continue;
    const atomTags = tagsById.get(atom.id) ?? [];
    let kind: EdgeVerdict["kind"];
    if (atomTags.length === 0) {
      kind = "uncovered";
    } else {
      const entry = claimsById.get(atom.id);
      const onEdge = (entry?.verified ?? []).filter(
        (v) => v.edge[0] === edge[0] && v.edge[1] === edge[1],
      );
      if (onEdge.length === 0) {
        // Tagged, but no verified state has ever been recorded for this atom on this edge (§4.1):
        // the verdict is `pending`, never `stale`. The lifecycle is uncovered → pending on the
        // first tag → covered once an accept records the verified state, and a claim is never stale
        // before it has been verified once.
        kind = "pending";
      } else {
        // A verified state exists on this edge. It stays `covered` only while both sides' hashes
        // still match; any drift on either side makes it `stale` (§4.1, §8.2).
        const verified = onEdge.filter((v) => v.claimHash === atom.hash);
        const allTagFilesVerified = atomTags.every((t) =>
          verified.some((v) => v.file === t.file && v.targetFileHash === fileHash(t.file)),
        );
        kind = verified.length && allTagFilesVerified ? "covered" : "stale";
      }
    }
    verdicts.push({
      edge,
      subject: atom.id,
      kind,
      tags: atomTags.map((t) => ({ file: t.file, line: t.line })),
    });
  }
  const orphans: OrphanTag[] = [];
  for (const t of tags) {
    if (liveIds.has(t.id)) continue;
    const dead = claimsById.get(t.id);
    orphans.push({
      tag: t.id,
      file: t.file,
      line: t.line,
      ...(dead && !dead.alive && dead.lastText !== undefined ? { deadClaimLastText: dead.lastText } : {}),
    });
  }
  return { verdicts, orphans };
}
