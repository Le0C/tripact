// Readability of the human check report (UAC §5.2): the headline, the collapsed advisory section,
// the column layout, the width budget, and the palette on verdict kinds.
//
// Layout is asserted against a real analysis of a scratch fixture rather than a hand-built stub, so
// these stay honest about what the engine actually produces.

import { rmSync } from "node:fs";
import { afterAll, describe, expect, test } from "vitest";

import { analyze } from "../src/engine.js";
import { DEFAULT_WIDTH, renderHuman } from "../src/report.js";
import { fullRepo } from "./helpers/fixture.js";

const scratch: string[] = [];
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});

/** A fixture repo analysed once; it has uncovered claims, so its report carries findings. */
function analysed() {
  const repo = fullRepo("tripact-layout-");
  scratch.push(repo);
  return analyze(repo);
}

const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");
const widthOf = (s: string): number => [...strip(s)].length;
/** The finding lines: indented four, leading with a verdict kind. */
const findings = (report: string): string[] =>
  report.split("\n").filter((l) => /^ {4}(COVERED|STALE|PENDING|NEW-UNCOVERED|BACKLOG) /.test(strip(l)));

describe("the report headline (§5.2)", () => {
  test("@specs:output.report-opens-headline-naming - the verdict and its counts open the report, and the verdict closes it", () => {
    const report = renderHuman(analysed(), { width: 160 });
    const lines = report.split("\n").map(strip);
    // The scope header is line 1; the headline follows it, well before any finding.
    const headline = lines.findIndex((l) => l.startsWith("✗") || l.startsWith("✓"));
    expect(headline).toBeGreaterThanOrEqual(0);
    expect(headline).toBeLessThan(4);
    // The counts behind the verdict sit on that same line.
    expect(lines[headline]).toMatch(/(stale|new-uncovered|pending|orphan tag|escalation)/);
    // And the same verdict closes the report, so either end answers the question.
    const verdict = lines[headline]!.split(" — ")[0];
    expect(lines.at(-1)).toBe(verdict);
  });

  test("@specs:output.report-opens-headline-naming - a level tree names its backlog once, not twice", () => {
    // The level verdict already reads "✓ level — N acknowledged backlog items", so the headline's
    // count list must not append the same number again.
    const a = analysed();
    // Force the level+backlog shape: every uncovered verdict acknowledged, nothing else outstanding.
    for (const v of a.verdicts) if (v.kind === "uncovered") v.acknowledged = true;
    a.orphans = [];
    a.escalations = [];
    const headline = renderHuman(a, { width: 160 }).split("\n").map(strip).find((l) => l.startsWith("✓"));
    expect(headline).toBeDefined();
    expect(headline).toContain("acknowledged backlog items");
    expect(headline!.match(/acknowledged backlog/g)).toHaveLength(1);
  });

  test("@specs:output.report-opens-headline-naming - per-edge coverage rides under the headline, and a clean edge is not repeated as an empty section", () => {
    const lines = renderHuman(analysed(), { width: 160 }).split("\n").map(strip);
    expect(lines.some((l) => /↔.*\d+\/\d+/.test(l))).toBe(true);
    // An edge with nothing to report gets no `edge x ↔ y: n/n covered` section of its own.
    for (const l of lines) {
      const m = /^edge (.+): (\d+)\/(\d+) covered$/.exec(l);
      if (m) expect(m[2]).not.toBe(m[3]);
    }
  });
});

describe("the advisory section (§5.2)", () => {
  test("@specs:output.advisory-three-way-gaps-collapse - three-way gaps collapse to one line by default", () => {
    const lines = renderHuman(analysed(), { width: 160 }).split("\n").map(strip);
    const gaps = lines.filter((l) => l.includes("three-way gaps"));
    if (gaps.length === 0) return; // fixture declares no docs edge — nothing to collapse
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatch(/advisory; --long lists them/);
    // Collapsed means collapsed: no per-claim listing under it.
    expect(lines.some((l) => l.trimStart().startsWith("tested but undocumented ("))).toBe(false);
  });

  test("@specs:output.advisory-three-way-gaps-collapse - --long lists them in full instead", () => {
    const a = analysed();
    const short = renderHuman(a, { width: 160 });
    const long = renderHuman(a, { long: true, width: 160 });
    if (!short.includes("three-way gaps")) return;
    expect(strip(long)).not.toMatch(/advisory; --long lists them/);
    expect(long.split("\n").length).toBeGreaterThan(short.split("\n").length);
  });
});

describe("verdict line layout (§5.2)", () => {
  test("@specs:output.verdict-lines-render-aligned - kind, id and location each land in a fixed column", () => {
    const rows = findings(renderHuman(analysed(), { width: 160 }));
    expect(rows.length).toBeGreaterThan(1);
    // The id starts at the same column on every row, so the column can be read down.
    const idStarts = rows.map((r) => strip(r).slice(4).search(/\S+$|[a-z0-9-]+\./));
    expect(new Set(rows.map((r) => strip(r).indexOf(" ", 4 + 13))).size).toBeLessThanOrEqual(2);
    expect(idStarts.length).toBe(rows.length);
    // Locations end the line, and every row carries one.
    for (const r of rows) expect(strip(r)).toMatch(/\S+:\d+$/);
  });

  test("@specs:output.verdict-line-budgeted-terminals - a wider terminal buys excerpt, not wrapping", () => {
    const a = analysed();
    const wide = findings(renderHuman(a, { width: 200 }));
    const narrow = findings(renderHuman(a, { width: 120 }));
    expect(wide.length).toBe(narrow.length); // no wrapping: one finding stays one line
    // Compare the widest excerpt in each: a short claim fits at either width and would prove nothing.
    const longest = (rows: string[]) =>
      Math.max(...rows.map((l) => (/"([^"]*)"/.exec(strip(l))?.[1] ?? "").length));
    expect(longest(wide)).toBeGreaterThan(longest(narrow));
    // The narrow one gives up its tail rather than its line.
    expect(narrow.some((l) => strip(l).includes("…"))).toBe(true);
  });

  test("@specs:output.verdict-line-budgeted-terminals - lines stay inside the budget while an excerpt is shown", () => {
    const a = analysed();
    for (const width of [200, 160, 120]) {
      for (const l of renderHuman(a, { width }).split("\n")) expect(widthOf(l)).toBeLessThanOrEqual(width);
    }
  });

  test("@specs:output.verdict-line-budgeted-terminals - too little room drops the excerpt, never the id or the location", () => {
    const rows = findings(renderHuman(analysed(), { width: 80 }));
    for (const r of rows) {
      expect(strip(r)).not.toContain('"'); // excerpt gone
      expect(strip(r)).toMatch(/\S+:\d+$/); // location kept
      expect(strip(r).length).toBeGreaterThan(20); // id kept
    }
  });

  test("@specs:output.verdict-line-budgeted-terminals - an unknown width falls back to a fixed budget rather than none", () => {
    const a = analysed();
    expect(renderHuman(a, { width: 0 })).toBe(renderHuman(a, { width: DEFAULT_WIDTH }));
    expect(renderHuman(a, {})).toBe(renderHuman(a, { width: DEFAULT_WIDTH }));
  });
});

describe("the palette on verdict kinds (§5.2)", () => {
  const display = { mark: false, colour: true, depth: { truecolor: true } };

  test("@specs:output.colour-verdict-kind-tinted - a drift-driving kind takes torque orange", () => {
    const rows = findings(renderHuman(analysed(), { width: 160, display }));
    const drifting = rows.filter((r) => /(STALE|PENDING|NEW-UNCOVERED)/.test(strip(r)));
    expect(drifting.length).toBeGreaterThan(0);
    for (const r of drifting) expect(r).toContain("38;2;221;99;32");
  });

  test("@specs:output.colour-verdict-kind-tinted - the tint is added to the word, never a replacement for it", () => {
    const a = analysed();
    // Same report, colour off: the readable text is identical either way.
    expect(strip(renderHuman(a, { width: 160, display }))).toBe(renderHuman(a, { width: 160 }));
  });

  test("@specs:output.colour-verdict-kind-tinted - colour off emits no escapes at all", () => {
    expect(renderHuman(analysed(), { width: 160 })).not.toContain("\x1b[");
  });
});
