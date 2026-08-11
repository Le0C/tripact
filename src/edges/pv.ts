// Prescriptive ↔ Verificatory edge: claim ids ↔ test tags. UAC §4.1.
// Pure text scan of the verificatory layer, with no test-runner integration in v0.

import type { Atom, EdgeVerdict, OrphanTag } from "../types.js";
import type { SidecarEntry } from "../sidecar.js";

export interface TagHit {
  id: string;
  file: string;
  line: number;
}

/** A verificatory scan split by tag recognition (UAC §4.4). */
export interface TagScan {
  /** Tags written as tags: they count towards a verdict. */
  declared: TagHit[];
  /** Tags written into prose: reported as a diagnostic (§5.4), never counted. */
  ignored: TagHit[];
}

/**
 * Any tag-shaped token, whatever its vocabulary. Recognition asks whether a comment holds nothing
 * but tags, and one dedicated line may carry an id tag and a section tag together (UAC §4.4), so
 * this deliberately does not reuse the caller's configured pattern - that would read a line
 * carrying both as prose while scanning for either one.
 */
const ANY_TAG = /@[A-Za-z][A-Za-z0-9_-]*:\S+/g;

type Region = "code" | "string" | "comment";

interface LineLex {
  /** Region per character index, so a tag can be placed by where its `@` sits. */
  regions: Region[];
  /** Block-comment state to carry into the next line. */
  inBlock: boolean;
  /** The line's comment text with its opening and closing markers blanked out. */
  comment: string;
}

/**
 * Classify one line into code, string and comment regions, carrying block-comment state across
 * lines. Deliberately a small lexer and not a language parser: it needs to tell a tag written as a
 * tag from one written into prose, and nothing more (UAC §4.4).
 */
function lexLine(line: string, inBlock: boolean): LineLex {
  const regions: Region[] = new Array<Region>(line.length).fill("code");
  let comment = "";
  let quote: string | null = null;
  let i = 0;
  while (i < line.length) {
    const c = line[i] as string;
    if (inBlock) {
      regions[i] = "comment";
      if (c === "*" && line[i + 1] === "/") {
        regions[i + 1] = "comment";
        inBlock = false;
        i += 2;
        continue;
      }
      comment += c;
      i++;
      continue;
    }
    if (quote) {
      regions[i] = "string";
      if (c === "\\") {
        if (i + 1 < line.length) regions[i + 1] = "string";
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      i++;
      continue;
    }
    if (c === "/" && line[i + 1] === "/") {
      for (let j = i; j < line.length; j++) regions[j] = "comment";
      comment += line.slice(i + 2);
      break;
    }
    if (c === "/" && line[i + 1] === "*") {
      regions[i] = "comment";
      regions[i + 1] = "comment";
      inBlock = true;
      i += 2;
      continue;
    }
    // `#` only opens a comment at the head of a line, which keeps a JS private field out of it
    // while still reading a Python or shell verificatory layer.
    if (c === "#" && line.slice(0, i).trim() === "") {
      for (let j = i; j < line.length; j++) regions[j] = "comment";
      comment += line.slice(i + 1);
      break;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      regions[i] = "string";
      i++;
      continue;
    }
    i++;
  }
  return { regions, inBlock, comment };
}

/** A comment holding nothing but tags is a declaration; any other word in it makes it prose. */
function isTagOnlyComment(comment: string): boolean {
  const body = comment.replace(/^[\s*]+/, "").replace(/[\s*]+$/, "");
  return body.length > 0 && body.replace(ANY_TAG, "").trim() === "";
}

/**
 * Whether the tag whose `@` sits at `index` was written as a tag (UAC §4.4). A tag inside a string
 * literal is a test title; a tag in a comment counts only when the comment is nothing but tags.
 */
function isDeclared(index: number, lex: LineLex): boolean {
  const region = lex.regions[index] ?? "code";
  if (region === "string") return true;
  if (region === "comment") return isTagOnlyComment(lex.comment);
  return false;
}

/**
 * Loose scan: every match anywhere on a line. This is the code-link scan (UAC §20.2), which is
 * exempt from recognition - a hotlink is written into prose by design (§20.3) and produces no
 * verdict, so a mention there cannot fabricate coverage. Verificatory layers use
 * {@link scanDeclaredTags} instead.
 */
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

/**
 * Verificatory scan with tag recognition applied (UAC §4.4): a tag counts only when written as a
 * tag, so documenting why a claim is untested no longer registers that claim as covered. Both sides
 * are returned - what counts, and what was ignored so §5.4 can name it rather than let a coverage
 * flip look mysterious.
 *
 * Implements @specs:tag-recognition.tag-verificatory-layer-file
 */
export function scanDeclaredTags(files: Map<string, string>, tagPattern: string): TagScan {
  const declared: TagHit[] = [];
  const ignored: TagHit[] = [];
  for (const [file, content] of [...files.entries()].sort()) {
    const lines = content.split(/\r?\n/);
    let inBlock = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] as string;
      const lex = lexLine(line, inBlock);
      inBlock = lex.inBlock;
      const re = new RegExp(tagPattern, "g");
      let m: RegExpExecArray | null;
      while ((m = re.exec(line)) !== null) {
        const id = m[1];
        if (!id) continue;
        (isDeclared(m.index, lex) ? declared : ignored).push({ id, file, line: i + 1 });
      }
    }
  }
  return { declared, ignored };
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
