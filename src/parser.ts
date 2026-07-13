// Markdown → groups/atoms. UAC §3.1. Port of sync-spike/uac_parser.py.

import { createHash } from "node:crypto";
import type { Atom, Group } from "./types.js";

// Atoms are top-level `- ` list items (column-0 only; indented/nested bullets are
// NOT atoms — UAC §3.1). A leading legacy checkbox marker `[ ]` / `[x]` / `[X]` is
// stripped so `- text` and `- [ ] text` parse identically to the same hash.
const BULLET_RE = /^- (.*)$/;
const CHECKBOX_MARKER_RE = /^\[( |x|X)\] /;
const HEADING_RE = /^(#{1,6}) (.*)$/;
const NUMBERING_RE = /^\d+(\.\d+)*\.?\s+/;
const TBD_RE = /\(tbd\)/i;

export function normalizeText(raw: string): string {
  let t = raw.toLowerCase();
  t = t.replace(/[*_`]/g, "");
  t = t.replace(/\s+/g, " ").trim();
  t = t.replace(/[.,;:!?]+$/g, "").trim();
  return t;
}

export function headingKey(text: string): string {
  return normalizeText(text.trim().replace(NUMBERING_RE, ""));
}

export function contentHash(norm: string): string {
  return createHash("sha256").update(norm, "utf8").digest("hex").slice(0, 16);
}

export function slugify(text: string, maxWords = 8): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .split(/\s+/)
    .slice(0, maxWords)
    .join("-");
}

export interface ParsedFile {
  groups: Group[];
  atoms: Atom[];
}

export function parseMarkdownLayer(layer: string, file: string, content: string): ParsedFile {
  const displayStack: Array<string | null> = [null, null, null, null, null, null];
  const keyStack: Array<string | null> = [null, null, null, null, null, null];
  const tbdStack: boolean[] = [false, false, false, false, false, false];
  const groups = new Map<string, Group>();
  const atoms: Atom[] = [];
  let inCodeFence = false;

  const lines = content.split(/\r?\n/);
  for (let ln = 0; ln < lines.length; ln++) {
    const line = lines[ln] as string;
    if (/^(```|~~~)/.test(line.trim())) {
      inCodeFence = !inCodeFence;
      continue;
    }
    if (inCodeFence) continue;

    const hm = HEADING_RE.exec(line);
    if (hm) {
      const level = (hm[1] as string).length - 1;
      const title = (hm[2] as string).trim();
      displayStack[level] = title;
      keyStack[level] = headingKey(title);
      tbdStack[level] = TBD_RE.test(title);
      for (let i = level + 1; i < 6; i++) {
        displayStack[i] = null;
        keyStack[i] = null;
        tbdStack[i] = false;
      }
      continue;
    }

    const bm = BULLET_RE.exec(line);
    if (bm) {
      // strip a legacy checkbox marker so plain and checkbox syntaxes hash identically
      const body = (bm[1] as string).replace(CHECKBOX_MARKER_RE, "").trim();
      if (body === "") continue;
      // skip the H1 document title (level 0) in paths, like the reference parser
      const groupPath = displayStack.slice(1).filter(Boolean).join(" > ");
      const groupKey = keyStack.slice(1).filter(Boolean).join(" > ");
      const tbd = tbdStack.some(Boolean);
      let group = groups.get(groupKey);
      if (!group) {
        const leafKey = [...keyStack].reverse().find(Boolean) ?? groupKey;
        group = {
          layer,
          groupPath,
          slug: slugify(leafKey),
          file,
          line: ln + 1,
          tbd,
          atoms: [],
        };
        groups.set(groupKey, group);
      }
      const norm = normalizeText(body);
      const atom: Atom = {
        id: "", // assigned by the anchorer / sidecar
        layer,
        groupPath,
        groupKey,
        index: group.atoms.length,
        file,
        line: ln + 1,
        raw: body,
        norm,
        hash: contentHash(norm),
        tbd,
      };
      group.atoms.push(atom);
      atoms.push(atom);
    }
  }
  return { groups: [...groups.values()], atoms };
}
