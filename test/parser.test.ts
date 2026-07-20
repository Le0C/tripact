// Markdown parsing → groups/atoms. UAC §3.1.
// @specs:markdown-parsing.prescriptive-descriptive-layer-files
// @specs:markdown-parsing.prose-paragraphs-code-blocks
// @specs:markdown-parsing.atom-normalisation-lowercases-collapses
// @specs:markdown-parsing.heading-marked-tbd-parses
// @specs:markdown-parsing.parsing-deterministic-same-file
// @specs:markdown-parsing.column-0-ordered-list-item
// SDOC parsing → nodes/atoms. UAC §3.4.
// @specs:sdoc-parsing.layer-file-dispatched-parser
// @specs:sdoc-parsing.strictdoc-sdoc-files-parse
// @specs:sdoc-parsing.node-statement-may-inline
// @specs:sdoc-parsing.document-grammar-nodes-carry
// @specs:sdoc-parsing.non-statement-fields-such-rationale
// @specs:sdoc-parsing.sdoc-atoms-grouped-their
import { describe, expect, it } from "vitest";
import { normalizeText, parseLayerFile, parseMarkdownLayer, parseSdocLayer } from "../src/parser.js";

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

  it("atomises column-0 ordered list items (1. / 1)) like bullets — EARS/Kiro criteria", () => {
    const doc = `## Requirement 1

### Acceptance Criteria

1. THE system SHALL display a list of drivers
2. WHEN the app loads, THE system SHALL retrieve driver data
3) THE system SHALL present each driver with a name
`;
    const { atoms } = parseMarkdownLayer("spec", "requirements.md", doc);
    expect(atoms).toHaveLength(3);
    expect(atoms[0]?.raw).toBe("THE system SHALL display a list of drivers"); // marker not in text
    expect(atoms[2]?.raw).toBe("THE system SHALL present each driver with a name"); // `1)` marker too
    expect(atoms.every((a) => a.groupPath === "Requirement 1 > Acceptance Criteria")).toBe(true);
  });

  it("renumbering an ordered item does not change its content hash", () => {
    const a = parseMarkdownLayer("s", "f.md", "## G\n\n1. the system shall do the thing\n");
    const b = parseMarkdownLayer("s", "f.md", "## G\n\n7. the system shall do the thing\n");
    expect(a.atoms[0]?.hash).toBe(b.atoms[0]?.hash);
  });

  it("nested (indented) ordered items are not atoms", () => {
    const { atoms } = parseMarkdownLayer("s", "f.md", "## G\n\n1. top level item\n  2. nested item is not an atom\n");
    expect(atoms).toHaveLength(1);
    expect(atoms[0]?.raw).toBe("top level item");
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

// A StrictDoc document exercising: the [GRAMMAR]/[DOCUMENT] skip, an inline vs multi-line STATEMENT,
// a RATIONALE block that must not leak, and [[SECTION]] nesting.
const SDOC = `[DOCUMENT]
MID: doc123
TITLE: Requirements Tool Specification

[GRAMMAR]
ELEMENTS:
- TAG: REQUIREMENT
  FIELDS:
  - TITLE: STATEMENT
    TYPE: String

[TEXT]
STATEMENT: >>>
This document delineates the requirements for the tool.
It spans two lines that join into one atom.
<<<

[[SECTION]]
MID: sec1
TITLE: Data model

[REQUIREMENT]
UID: SDOC-SRS-18
TITLE: Data model
STATEMENT: >>>
StrictDoc shall be based on a data model.
<<<
RATIONALE: >>>
A consistent data model supports rich use cases.
<<<

[[SECTION]]
MID: sec1a
TITLE: Requirement model

[REQUIREMENT]
UID: SDOC-SRS-26
STATEMENT: The data model shall support modeling requirements.

[[/SECTION]]

[[/SECTION]]
`;

describe("parseSdocLayer", () => {
  it("parses each node's STATEMENT into one atom, skipping DOCUMENT and GRAMMAR", () => {
    const { atoms } = parseSdocLayer("spec", "reqs.sdoc", SDOC);
    const texts = atoms.map((a) => a.raw);
    // 1 [TEXT] + 2 [REQUIREMENT] = 3 atoms; the [GRAMMAR] `- TITLE: STATEMENT` bullet is NOT an atom.
    expect(atoms).toHaveLength(3);
    expect(texts).toContain("StrictDoc shall be based on a data model.");
    expect(texts).toContain("The data model shall support modeling requirements.");
    expect(texts.some((t) => /TAG: REQUIREMENT|delineates/.test(t) && t.includes("TAG"))).toBe(false);
  });

  it("joins a multi-line STATEMENT into one atom and never leaks a RATIONALE block", () => {
    const { atoms } = parseSdocLayer("spec", "reqs.sdoc", SDOC);
    const multi = atoms.find((a) => a.raw.startsWith("This document delineates"));
    expect(multi?.raw).toBe("This document delineates the requirements for the tool. It spans two lines that join into one atom.");
    const dataModel = atoms.find((a) => a.raw.includes("based on a data model"));
    expect(dataModel?.raw).toBe("StrictDoc shall be based on a data model.");
    expect(dataModel?.raw).not.toContain("rich use cases"); // RATIONALE must not leak
  });

  it("parses an inline STATEMENT (no >>> block) as an atom", () => {
    const { atoms } = parseSdocLayer("spec", "reqs.sdoc", SDOC);
    expect(atoms.map((a) => a.raw)).toContain("The data model shall support modeling requirements.");
  });

  it("groups atoms by enclosing [[SECTION]] title path", () => {
    const { atoms } = parseSdocLayer("spec", "reqs.sdoc", SDOC);
    const req18 = atoms.find((a) => a.raw.includes("based on a data model"));
    const req26 = atoms.find((a) => a.raw.includes("support modeling requirements"));
    const intro = atoms.find((a) => a.raw.startsWith("This document"));
    expect(req18?.groupPath).toBe("Data model");
    expect(req26?.groupPath).toBe("Data model > Requirement model"); // nested section
    expect(intro?.groupPath).toBe(""); // before any section
  });

  it("dispatches by extension: .sdoc → SDOC parser, .md → markdown parser", () => {
    const sdoc = parseLayerFile("spec", "reqs.sdoc", SDOC);
    const md = parseLayerFile("spec", "UAC.md", DOC);
    // SDOC yields the requirement statement; the markdown parser would find no `- ` atoms in SDOC.
    expect(sdoc.atoms.map((a) => a.raw)).toContain("StrictDoc shall be based on a data model.");
    expect(md.atoms.length).toBeGreaterThan(0);
    // The `- TAG:`/`- TITLE:` GRAMMAR bullets would become atoms under the markdown parser — proving
    // the extension dispatch matters: markdown-parsing SDOC is exactly the grammar-noise bug.
    const asMarkdown = parseMarkdownLayer("spec", "reqs.sdoc", SDOC);
    expect(asMarkdown.atoms.some((a) => a.raw.startsWith("TAG:") || a.raw.startsWith("TITLE:"))).toBe(true);
    expect(sdoc.atoms.some((a) => a.raw.startsWith("TAG:") || a.raw.startsWith("TITLE:"))).toBe(false);
  });

  it("is deterministic", () => {
    expect(JSON.stringify(parseSdocLayer("spec", "reqs.sdoc", SDOC))).toBe(JSON.stringify(parseSdocLayer("spec", "reqs.sdoc", SDOC)));
  });
});
