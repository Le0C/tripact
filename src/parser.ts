// Markdown → groups/atoms. UAC §3.1.

import { createHash } from "node:crypto";
import { blockSkipLines, findBlockRegions } from "./blocks.js";
import type { Atom, Group } from "./types.js";

// Atoms are top-level list items (UAC §3.1), column-0 only, so indented/nested items are NOT atoms:
// an unordered `- ` bullet, or an ordered `1. ` / `1) ` item. Ordered items let EARS/Kiro-style
// requirements (`1. THE system SHALL …`) atomise like bulleted acceptance criteria. The ordered
// marker itself is not part of the atom text, so renumbering an item never changes its content hash.
// A leading legacy checkbox marker `[ ]` / `[x]` / `[X]` is stripped so `- text` and `- [ ] text`
// (or `1. [ ] text`) parse identically to the same hash.
const BULLET_RE = /^- (.*)$/;
const ORDERED_RE = /^\d+[.)] (.*)$/;
const CHECKBOX_MARKER_RE = /^\[( |x|X)\] /;
// A prose paragraph (not a list item or heading) is an atom only when it reads as a requirement:
// either it leads with a bold label (`**User Story:** …`, `**Description:** …`) or it contains an
// UPPERCASE RFC-2119 / EARS keyword (`SHALL`, `MUST`, `SHOULD`). Case matters. Normative specs
// capitalise the keyword, so casual lowercase "must"/"should" prose is left as ordinary text.
const BOLD_LABEL_RE = /^\*\*[^*\n]+:\*\*/;
const NORMATIVE_RE = /\b(?:SHALL|MUST|SHOULD)\b/;
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

// NOTE (ASCII assumption, UAC §3.1): `slugify` keeps only lowercased `[a-z0-9\s-]` and does not
// transliterate. A heading in a non-Latin script slugs to "" (which `disambiguateSlugs` below then
// makes unique but un-mnemonic). Deterministic, but such sections are effectively un-taggable by a
// readable slug; a transliteration pass would lift this.
export function slugify(text: string, maxWords = 8): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .split(/\s+/)
    .slice(0, maxWords)
    .join("-");
}

/**
 * Make section slugs unique within a descriptive layer (UAC §4.2). `slugify` keeps only the first
 * few lowercased ASCII words, so two distinct sections (different files, or heading paths that
 * happen to share their leading words) can collapse to one slug. That is a correctness hole: a
 * single `@docs:<slug>` tag would mark BOTH sections covered, and one section's sidecar group
 * would overwrite the other's. When two or more groups share a base slug we append a short suffix
 * derived from each group's OWN identity (file + heading path), so a group's slug depends only on
 * itself, and adding or removing a colliding sibling never reshuffles which suffix belongs to which
 * section.
 * Groups whose slug is already unique keep their bare slug. Mutates the groups in place.
 */
export function disambiguateSlugs(groups: Group[]): void {
  const bySlug = new Map<string, Group[]>();
  for (const g of groups) {
    const arr = bySlug.get(g.slug);
    if (arr) arr.push(g);
    else bySlug.set(g.slug, [g]);
  }
  for (const gs of bySlug.values()) {
    if (gs.length < 2) continue;
    for (const g of gs) {
      g.slug = `${g.slug}-${contentHash(`${g.file} ${g.groupPath}`).slice(0, 6)}`;
    }
  }
}

export interface ParsedFile {
  groups: Group[];
  atoms: Atom[];
}

/**
 * Parse one markdown layer file into its heading groups and list-item atoms.
 *
 * Implements @specs:markdown-parsing.parsing-deterministic-same-file
 * - spec:  [UAC.md — §3.1 Markdown parsing]({@link ./../UAC.md})
 * - tests: [parser.test.ts]({@link ./../test/parser.test.ts})
 */
export function parseMarkdownLayer(layer: string, file: string, content: string): ParsedFile {
  const displayStack: Array<string | null> = [null, null, null, null, null, null];
  const keyStack: Array<string | null> = [null, null, null, null, null, null];
  const tbdStack: boolean[] = [false, false, false, false, false, false];
  const groups = new Map<string, Group>();
  const atoms: Atom[] = [];
  let inCodeFence = false;

  // Add one atom under the current heading path (shared by list items and requirement paragraphs).
  const addAtom = (body: string, lineNo: number) => {
    // skip the H1 document title (level 0) in paths, like the reference parser
    const groupPath = displayStack.slice(1).filter(Boolean).join(" > ");
    const groupKey = keyStack.slice(1).filter(Boolean).join(" > ");
    const tbd = tbdStack.some(Boolean);
    let group = groups.get(groupKey);
    if (!group) {
      const leafKey = [...keyStack].reverse().find(Boolean) ?? groupKey;
      group = { layer, groupPath, slug: slugify(leafKey), file, line: lineNo, tbd, atoms: [] };
      groups.set(groupKey, group);
    }
    const norm = normalizeText(body);
    const atom: Atom = {
      id: "", layer, groupPath, groupKey, index: group.atoms.length,
      file, line: lineNo, raw: body, norm, hash: contentHash(norm), tbd,
    };
    group.atoms.push(atom);
    atoms.push(atom);
  };

  // Prose-paragraph buffer (UAC §3.1): consecutive non-structural lines accumulate here and flush at
  // any blank line or structural boundary. A flushed paragraph becomes ONE atom only if it reads as a
  // requirement (a bold-label lead, or an UPPERCASE SHALL/MUST/SHOULD), so a wrapped requirement is a
  // single atom and ordinary prose is dropped.
  let proseBuf: string[] = [];
  let proseLine = 0;
  const flushProse = () => {
    if (proseBuf.length === 0) return;
    const text = proseBuf.join(" ").replace(/\s+/g, " ").trim();
    const start = proseLine;
    proseBuf = [];
    if (text !== "" && (BOLD_LABEL_RE.test(text) || NORMATIVE_RE.test(text))) addAtom(text, start);
  };

  // Generated block regions (UAC §18.3) contribute nothing: no atoms from their lines, no groups from
  // their headings. Their content is a generator's output, so parsing it would mint claims whose ids
  // churn every time the generator's input moved, and the churn would report as drift no author could
  // resolve. Malformed fences are a config-level error surfaced by the block scan itself, so a file
  // that cannot be scanned is parsed as if it declared no regions rather than failing the whole parse.
  let blockSkip: Set<number>;
  try {
    blockSkip = blockSkipLines(findBlockRegions(content, file));
  } catch {
    blockSkip = new Set<number>();
  }

  const lines = content.split(/\r?\n/);
  for (let ln = 0; ln < lines.length; ln++) {
    const line = lines[ln] as string;
    // Line numbering continues through a skipped region, so later claims keep their true line.
    if (blockSkip.has(ln + 1)) {
      flushProse();
      continue;
    }
    if (/^(```|~~~)/.test(line.trim())) {
      flushProse();
      inCodeFence = !inCodeFence;
      continue;
    }
    if (inCodeFence) continue;

    const hm = HEADING_RE.exec(line);
    if (hm) {
      flushProse();
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

    // A column-0 list item, unordered (`- `) or ordered (`1. ` / `1) `), is an atom.
    const lm = BULLET_RE.exec(line) ?? ORDERED_RE.exec(line);
    if (lm) {
      flushProse();
      // strip a legacy checkbox marker so plain and checkbox syntaxes hash identically
      const body = (lm[1] as string).replace(CHECKBOX_MARKER_RE, "").trim();
      if (body === "") continue;
      addAtom(body, ln + 1);
      continue;
    }

    if (line.trim() === "") {
      flushProse();
      continue;
    }
    // A non-structural, non-blank line accumulates as prose (may become a requirement atom on flush).
    if (proseBuf.length === 0) proseLine = ln + 1;
    proseBuf.push(line.trim());
  }
  flushProse();
  return { groups: [...groups.values()], atoms };
}

// --- StrictDoc `.sdoc` parsing (UAC §3.4) --------------------------------------------------------
// StrictDoc source is NOT markdown: content lives in typed nodes ([REQUIREMENT], [TEXT], [FEATURE],
// [DESIGN], …) whose normative content is the `STATEMENT` field, nested inside balanced
// [[SECTION]] … [[/SECTION]] blocks. A field value is either inline (`STATEMENT: text`) or a
// multi-line block delimited by `>>>` … `<<<`. One node with a STATEMENT yields one atom, and a
// node without one yields nothing, so [DOCUMENT] and [GRAMMAR] never contribute. That keeps the
// [GRAMMAR] schema's `- TITLE: …` bullets out of the atom set and lets a requirements file yield
// its requirements.

const SDOC_SECTION_OPEN_RE = /^\[\[?SECTION\]?\]$/;   // [[SECTION]] (current) or [SECTION] (legacy)
const SDOC_SECTION_CLOSE_RE = /^\[\[?\/SECTION\]?\]$/; // [[/SECTION]] or [/SECTION]
const SDOC_NODE_RE = /^\[([A-Z][A-Z0-9_]*)\]$/;       // [REQUIREMENT], [TEXT], [FEATURE], …
const SDOC_FIELD_RE = /^([A-Z][A-Z0-9_]*): ?(.*)$/;   // FIELD: value  (value may be `>>>` to open a block)
// Structural nodes: they carry no STATEMENT, so they never produce atoms.
const SDOC_SKIP_NODES = new Set(["DOCUMENT", "GRAMMAR"]);
const SDOC_BLOCK_OPEN = ">>>";
const SDOC_BLOCK_CLOSE = "<<<";

interface SdocNode {
  type: string;
  uid: string | null;
  title: string | null;
  statementLines: string[];
  line: number;
}

/**
 * Parse one StrictDoc `.sdoc` layer file into its section groups and STATEMENT atoms.
 *
 * Implements @specs:sdoc-parsing.strictdoc-sdoc-files-parse
 * - spec:  [UAC.md — §3.4 SDOC parsing]({@link ./../UAC.md})
 * - tests: [parser.test.ts]({@link ./../test/parser.test.ts})
 */
export function parseSdocLayer(layer: string, file: string, content: string): ParsedFile {
  const groups = new Map<string, Group>();
  const atoms: Atom[] = [];

  // Section nesting. Each open [[SECTION]] pushes a frame; its TITLE field (read before the section's
  // first child node) names it. groupPath/groupKey are the breadcrumb of section titles.
  const sectionStack: Array<{ title: string }> = [];
  let awaitingSectionTitle: { title: string } | null = null; // set between [[SECTION]] and its first node/blank

  let node: SdocNode | null = null;
  // Multi-line field capture. `capturing` names the field currently open between >>> and <<<;
  // only STATEMENT is retained, but every open block is consumed so a RATIONALE/COMMENT body can
  // never leak into an atom or be mistaken for a node marker.
  let capturing: string | null = null;

  const groupPathOf = () => sectionStack.map((s) => s.title).filter(Boolean).join(" > ");
  const groupKeyOf = () => sectionStack.map((s) => headingKey(s.title)).filter(Boolean).join(" > ");

  const emit = (n: SdocNode) => {
    if (SDOC_SKIP_NODES.has(n.type)) return;
    const raw = n.statementLines.join(" ").replace(/\s+/g, " ").trim();
    if (raw === "") return; // a node with no STATEMENT contributes no atom
    const groupPath = groupPathOf();
    const groupKey = groupKeyOf();
    let group = groups.get(groupKey);
    if (!group) {
      const leaf = sectionStack.length ? (sectionStack[sectionStack.length - 1] as { title: string }).title : "";
      group = { layer, groupPath, slug: slugify(headingKey(leaf) || leaf), file, line: n.line, tbd: false, atoms: [] };
      groups.set(groupKey, group);
    }
    const norm = normalizeText(raw);
    const tbd = TBD_RE.test(raw);
    const atom: Atom = {
      id: "", layer, groupPath, groupKey, index: group.atoms.length, file, line: n.line,
      raw, norm, hash: contentHash(norm), tbd,
    };
    group.atoms.push(atom);
    atoms.push(atom);
  };

  const finishNode = () => { if (node) { emit(node); node = null; } };

  const lines = content.split(/\r?\n/);
  for (let ln = 0; ln < lines.length; ln++) {
    const line = lines[ln] as string;

    // Inside an open multi-line field: capture (STATEMENT only) until the closing marker.
    if (capturing !== null) {
      if (line.trim() === SDOC_BLOCK_CLOSE) {
        capturing = null;
      } else if (capturing === "STATEMENT" && node) {
        node.statementLines.push(line);
      }
      continue;
    }

    const trimmed = line.trim();

    if (SDOC_SECTION_OPEN_RE.test(trimmed)) {
      finishNode();
      const frame = { title: "" };
      sectionStack.push(frame);
      awaitingSectionTitle = frame;
      continue;
    }
    if (SDOC_SECTION_CLOSE_RE.test(trimmed)) {
      finishNode();
      sectionStack.pop();
      awaitingSectionTitle = null;
      continue;
    }
    const nodeMatch = SDOC_NODE_RE.exec(trimmed);
    if (nodeMatch) {
      finishNode();
      awaitingSectionTitle = null; // a node marker ends the section header
      const type = nodeMatch[1] as string;
      node = { type, uid: null, title: null, statementLines: [], line: ln + 1 };
      continue;
    }

    const fieldMatch = SDOC_FIELD_RE.exec(line);
    if (fieldMatch) {
      const field = fieldMatch[1] as string;
      const value = (fieldMatch[2] as string).trim();
      // A section's own TITLE (before its first child node) names the section.
      if (field === "TITLE" && awaitingSectionTitle && !node) {
        awaitingSectionTitle.title = value;
        continue;
      }
      if (!node) continue; // stray field outside any node (e.g. inside DOCUMENT header) - ignore
      if (value === SDOC_BLOCK_OPEN) {
        // Opens a multi-line block; retain only STATEMENT.
        capturing = field;
        if (field === "STATEMENT") node.statementLines = [];
      } else if (field === "STATEMENT") {
        node.statementLines = [value];
      } else if (field === "UID") {
        node.uid = value;
      } else if (field === "TITLE") {
        node.title = value;
      }
      continue;
    }
    // Any other line (blank, `- ` relation bullet, prose outside a block) is structurally irrelevant.
  }
  finishNode();
  return { groups: [...groups.values()], atoms };
}

/**
 * Dispatch one layer file to the parser for its format (UAC §3.4): `.sdoc` → StrictDoc parser,
 * everything else → the markdown list parser. Extension match is case-insensitive.
 */
export function parseLayerFile(layer: string, file: string, content: string): ParsedFile {
  if (file.toLowerCase().endsWith(".sdoc")) return parseSdocLayer(layer, file, content);
  return parseMarkdownLayer(layer, file, content);
}
