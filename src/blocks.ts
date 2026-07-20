// Block-level derived regions (UAC §18.3). A generated fragment living inside a hand-written file,
// fenced by a pair of HTML comments:
//
//   <!-- tripact:presets-table -->
//   ...generated content...
//   <!-- /tripact:presets-table -->
//
// Whole-file derived outputs (§18) stay out of every layer through `exclude`, so their content never
// parses as claims. A block has no such escape: the file is a source artefact and only a region of it
// is generated. The markdown parser therefore skips these regions (see parser.ts), which is what lets
// `generate` write into a layer file without touching anything claim-bearing.
//
// HTML comments are the fence because they render as nothing in every markdown implementation while
// leaving the content between them ordinary markdown that still renders. A bare custom tag marks only
// a point, and a paired custom tag makes its contents an HTML block that CommonMark will not parse as
// markdown.
//
// Fences inside a fenced code block are content, not markers: documentation that shows the syntax
// must not be mistaken for a region to fill. Both the scan here and the parser skip code fences first.

/** One block region found in a file. Line numbers are 1-based and name the fence lines themselves. */
export interface BlockRegion {
  name: string;
  openLine: number;
  closeLine: number;
  /** Current text between the fences, excluding both fence lines. Empty when the region is empty. */
  body: string;
}

/** A malformed fence: unclosed, nested, mismatched, or a close with no open. CLI maps this to exit 2. */
export class BlockError extends Error {}

const OPEN_RE = /^\s*<!--\s*tripact:([A-Za-z0-9][A-Za-z0-9._-]*)\s*-->\s*$/;
const CLOSE_RE = /^\s*<!--\s*\/tripact:([A-Za-z0-9][A-Za-z0-9._-]*)\s*-->\s*$/;
const CODE_FENCE_RE = /^(```|~~~)/;

/**
 * Every block region in one file's content, in source order. Throws BlockError naming the file and
 * line on an open fence with no matching close, a nested open, a close whose name does not match the
 * open it would pair with, or a close with no open. Guessing an author's intent for a malformed fence
 * risks `generate` eating hand-written prose, so each case is refused rather than repaired.
 */
export function findBlockRegions(content: string, file: string): BlockRegion[] {
  const lines = content.split(/\r?\n/);
  const regions: BlockRegion[] = [];
  let inCodeFence = false;
  let open: { name: string; line: number } | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    if (CODE_FENCE_RE.test(line.trim())) {
      inCodeFence = !inCodeFence;
      continue;
    }
    if (inCodeFence) continue;

    const om = OPEN_RE.exec(line);
    if (om) {
      const name = om[1] as string;
      if (open) {
        throw new BlockError(
          `${file}:${i + 1}: block "${name}" opens inside block "${open.name}" (opened at line ${open.line}); regions do not nest`,
        );
      }
      open = { name, line: i + 1 };
      continue;
    }

    const cm = CLOSE_RE.exec(line);
    if (cm) {
      const name = cm[1] as string;
      if (!open) {
        throw new BlockError(`${file}:${i + 1}: closing fence for block "${name}" has no opening fence`);
      }
      if (open.name !== name) {
        throw new BlockError(
          `${file}:${i + 1}: closing fence for block "${name}" does not match the open block "${open.name}" (opened at line ${open.line})`,
        );
      }
      regions.push({
        name,
        openLine: open.line,
        closeLine: i + 1,
        body: lines.slice(open.line, i).join("\n"),
      });
      open = null;
    }
  }

  if (open) {
    throw new BlockError(`${file}:${open.line}: block "${open.name}" is never closed; expected <!-- /tripact:${open.name} -->`);
  }
  return regions;
}

/**
 * Normalise a generator's output to the body lines that sit between the fences. Trailing newlines are
 * stripped so that a generator ending its output with a newline and one that does not produce the same
 * file, which is what makes regenerating twice byte-identical (§18.3).
 */
export function normalizeBlockBody(rendered: string): string {
  return rendered.replace(/\r?\n+$/, "");
}

/**
 * Rewrite every region in `content` with the output of `render`, leaving the fences and every line
 * outside them byte-identical. Regions are replaced from the last to the first so that earlier line
 * numbers stay valid as the content shifts.
 */
export function replaceBlockRegions<T extends BlockRegion>(
  content: string,
  regions: T[],
  render: (region: T) => string,
): string {
  const lines = content.split(/\r?\n/);
  for (const region of [...regions].reverse()) {
    const body = normalizeBlockBody(render(region));
    const bodyLines = body === "" ? [] : body.split("\n");
    lines.splice(region.openLine, region.closeLine - region.openLine - 1, ...bodyLines);
  }
  return lines.join("\n");
}

/**
 * Line numbers (1-based) the markdown parser must ignore for a set of regions: the generated interior
 * and both fence lines. The fences are included because an HTML comment is otherwise ordinary prose,
 * and a fence landing mid-paragraph would join the buffer the parser is accumulating.
 *
 * The parser skips these lines while still counting them, so a claim after a region keeps its true
 * file and line (§18.3).
 */
export function blockSkipLines(regions: BlockRegion[]): Set<number> {
  const skip = new Set<number>();
  for (const r of regions) {
    for (let ln = r.openLine; ln <= r.closeLine; ln++) skip.add(ln);
  }
  return skip;
}
