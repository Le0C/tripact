// Markdown parsing → groups/atoms. UAC §3.1.
// @uac:markdown-parsing.prescriptive-descriptive-layer-files
// @uac:markdown-parsing.non-checkbox-list-items-prose
// @uac:markdown-parsing.atom-normalisation-lowercases-collapses
// @uac:markdown-parsing.parsing-deterministic-same-file
import { describe, expect, it } from "vitest";
import { normalizeText, parseMarkdownLayer } from "../src/parser.js";

const DOC = `# Spec — Example

## 1. Calculator

### 1.1 Addition

- **addNumbers** returns the sum of two numbers
- [ ] Entering two numbers and clicking **Add** shows the sum
  - a nested bullet is not an atom

Some prose that is not an atom.

\`\`\`
- a bullet inside a code fence is not an atom
\`\`\`

### 1.2 History (TBD)

- Past calculations are listed
`;

describe("parseMarkdownLayer", () => {
  it("parses headings into groups and top-level bullets into atoms", () => {
    const { groups, atoms } = parseMarkdownLayer("uac", "UAC.md", DOC);
    // two plain bullets + one legacy checkbox = 3 atoms
    expect(atoms).toHaveLength(3);
    expect(groups.map((g) => g.slug)).toEqual(["addition", "history-tbd"]);
    const first = atoms[0]!;
    expect(first.groupPath).toBe("1. Calculator > 1.1 Addition");
    expect(first.groupKey).toBe("calculator > addition");
    expect(first.norm).toBe("addnumbers returns the sum of two numbers");
    expect(first.tbd).toBe(false);
  });

  it("plain bullets are atoms; nested bullets and fenced code are not", () => {
    const { atoms } = parseMarkdownLayer("uac", "UAC.md", DOC);
    // plain bullet is now an atom by design (§3.1)
    expect(atoms.some((a) => a.raw === "**addNumbers** returns the sum of two numbers")).toBe(true);
    // indented/nested list items never become atoms
    expect(atoms.some((a) => a.raw.includes("nested bullet"))).toBe(false);
    // code-fence exclusion still holds
    expect(atoms.some((a) => a.raw.includes("code fence"))).toBe(false);
  });

  it("normalisation strips emphasis, whitespace, trailing punctuation", () => {
    expect(normalizeText("**Bold**   text,  with `code`. ")).toBe("bold text, with code");
    const a = parseMarkdownLayer("uac", "f.md", "## H\n- Some   **requirement**.\n").atoms[0]!;
    const b = parseMarkdownLayer("uac", "f.md", "## H\n- Some requirement\n").atoms[0]!;
    expect(a.hash).toBe(b.hash);
  });

  it("legacy checkbox syntax parses identically to a plain bullet — same hash, marker ignored", () => {
    const plain = parseMarkdownLayer("uac", "f.md", "## H\n- done thing\n").atoms[0]!;
    const unchecked = parseMarkdownLayer("uac", "f.md", "## H\n- [ ] done thing\n").atoms[0]!;
    const checked = parseMarkdownLayer("uac", "f.md", "## H\n- [x] done thing\n").atoms[0]!;
    expect(plain.raw).toBe("done thing");
    expect(unchecked.raw).toBe("done thing");
    expect(checked.raw).toBe("done thing");
    expect(unchecked.hash).toBe(plain.hash);
    expect(checked.hash).toBe(plain.hash);
  });

  it("marks (TBD) atoms via their heading", () => {
    const { atoms } = parseMarkdownLayer("uac", "UAC.md", DOC);
    const past = atoms.find((a) => a.raw.includes("Past calculations"))!;
    expect(past.tbd).toBe(true);
  });

  it("is deterministic", () => {
    const one = JSON.stringify(parseMarkdownLayer("uac", "UAC.md", DOC));
    const two = JSON.stringify(parseMarkdownLayer("uac", "UAC.md", DOC));
    expect(one).toBe(two);
  });
});
