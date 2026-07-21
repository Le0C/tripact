// Human-output design elements: the witness mark on a character grid, the palette, and the config
// and environment switches that turn them off (UAC Cross-Cutting: Human output, §2.1).

import { describe, expect, test } from "vitest";

import { MARK_WIDTH, PLAIN, renderBanner, renderMark, resolveDisplay } from "../src/ascii.js";
import { ConfigSchema } from "../src/config.js";

/** Cells, not bytes — every glyph in the mark is multi-byte in UTF-8. */
const cells = (s: string): number => [...s].length;
/** Strip SGR sequences so a coloured row can be measured and compared as text. */
const plainText = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

describe("the witness mark (Cross-Cutting: Human output)", () => {
  test("@specs:human-output.human-output-carries-visual - renders the mark as three 13-cell bands, cut on the 9/6/3 diagonal", () => {
    const rows = renderMark("level", { colour: false });
    expect(rows).toHaveLength(3);
    for (const row of rows) expect(cells(row)).toBe(MARK_WIDTH);
    // The diagonal is carried by the cut's column, top to bottom.
    expect(rows.map((r) => [...r].indexOf("╲"))).toEqual([9, 6, 3]);
  });

  test("@specs:human-output.human-output-carries-visual - drift steps one cut out of the diagonal, leaving the other two in place", () => {
    const level = renderMark("level", { colour: false });
    const drifted = renderMark("drifted", { colour: false });
    expect(drifted.map((r) => [...r].indexOf("╲"))).toEqual([9, 11, 3]);
    // Only the middle band differs: a whole band moving would read as a wonky drawing, not a
    // broken mark.
    expect(drifted[0]).toBe(level[0]);
    expect(drifted[2]).toBe(level[2]);
    expect(drifted[1]).not.toBe(level[1]);
    for (const row of drifted) expect(cells(row)).toBe(MARK_WIDTH);
  });

  test("@specs:human-output.human-output-carries-visual - uncovered leaves the middle band unstruck, with no cut to align", () => {
    const rows = renderMark("uncovered", { colour: false });
    expect(rows[1]).toBe("┄".repeat(MARK_WIDTH));
    expect([...rows[1]!].includes("╲")).toBe(false);
    for (const row of rows) expect(cells(row)).toBe(MARK_WIDTH);
  });

  test("@specs:human-output.human-output-carries-visual - the banner sets the mark beside the wordmark", () => {
    const rows = renderBanner({ colour: false });
    expect(rows).toHaveLength(3);
    expect(rows[1]).toContain("tripact");
    // The logo is ink, never state colour — so the banner carries no palette even in colour.
    expect(renderBanner({ colour: true }).join("\n")).not.toContain("38;2;221;99;32");
  });

  test("@specs:human-output.design-elements-never-carry - every state is legible in plain text, except unbaselined which is captioned instead", () => {
    const text = (s: Parameters<typeof renderMark>[0]) => renderMark(s, { colour: false }).join("\n");
    // Three of the four states differ from each other as bare characters, so a monochrome or piped
    // reading keeps the signal.
    expect(new Set([text("level"), text("drifted"), text("uncovered")]).size).toBe(3);
    // Unbaselined is deliberately identical to level in text: there is no fourth kind of breakage,
    // so it takes tone plus a caption rather than an invented glyph.
    expect(text("unbaselined")).toBe(text("level"));
  });

  test("@specs:human-output.design-elements-never-carry - colour is added over the text, never in place of it", () => {
    for (const state of ["level", "drifted", "uncovered", "unbaselined"] as const) {
      const coloured = renderMark(state, { colour: true, depth: { truecolor: true } });
      const plain = renderMark(state, { colour: false });
      expect(coloured.map(plainText)).toEqual(plain);
    }
  });

  test("@specs:human-output.human-output-carries-visual - a band in agreement takes torque orange; the band that moved takes steel", () => {
    const [top, middle, bottom] = renderMark("drifted", { colour: true, depth: { truecolor: true } });
    expect(top).toContain("38;2;221;99;32"); // #DD6320
    expect(bottom).toContain("38;2;221;99;32");
    expect(middle).toContain("38;2;124;132;140"); // #7C848C
  });

  test("@specs:human-output.human-output-carries-visual - a terminal without truecolor gets the 256-colour palette instead", () => {
    const rows = renderMark("level", { colour: true, depth: { truecolor: false } });
    expect(rows[0]).toContain("38;5;166");
    expect(rows[0]).not.toContain("38;2;");
  });
});

describe("turning design elements off (Cross-Cutting: Human output, §2.1)", () => {
  const tty = (env: NodeJS.ProcessEnv = {}) => resolveDisplay(undefined, env, true);

  test("@specs:tripactyaml-schema.config-accepts-optional-display - the config accepts a display block with mark and colour", () => {
    const parsed = ConfigSchema.parse({ schemaVersion: 1, display: { mark: false, colour: false } });
    expect(parsed.display).toEqual({ mark: false, colour: false });
    // Both keys are optional, and so is the block.
    expect(ConfigSchema.parse({ schemaVersion: 1 }).display).toBeUndefined();
    expect(ConfigSchema.parse({ schemaVersion: 1, display: {} }).display).toEqual({});
  });

  test("@specs:tripactyaml-schema.config-accepts-optional-display - a non-boolean display value is rejected", () => {
    expect(() => ConfigSchema.parse({ schemaVersion: 1, display: { mark: "no" } })).toThrow();
  });

  test("@specs:human-output.design-elements-suppressed-output - config off beats a terminal, and each key turns off only its own class", () => {
    expect(resolveDisplay({ display: { mark: false } }, {}, true)).toMatchObject({ mark: false, colour: true });
    expect(resolveDisplay({ display: { colour: false } }, {}, true)).toMatchObject({ mark: true, colour: false });
    expect(resolveDisplay({ display: { mark: false, colour: false } }, {}, true)).toMatchObject({
      mark: false,
      colour: false,
    });
  });

  test("@specs:human-output.design-elements-suppressed-output - config off beats FORCE_COLOR, because the repository outranks the invocation", () => {
    const d = resolveDisplay({ display: { mark: false, colour: false } }, { FORCE_COLOR: "1" }, true);
    expect(d).toMatchObject({ mark: false, colour: false });
  });

  test("@specs:human-output.design-elements-suppressed-output - NO_COLOR suppresses colour by presence, whatever its value", () => {
    expect(tty({ NO_COLOR: "1" }).colour).toBe(false);
    expect(tty({ NO_COLOR: "" }).colour).toBe(false);
    // It is a colour switch, so the mark itself survives it.
    expect(tty({ NO_COLOR: "1" }).mark).toBe(true);
  });

  test("@specs:human-output.design-elements-suppressed-output - a non-terminal stream suppresses both classes", () => {
    const piped = resolveDisplay(undefined, {}, false);
    expect(piped).toMatchObject({ mark: false, colour: false });
    // FORCE_COLOR is the deliberate override, for capturing a decorated report into a file.
    expect(resolveDisplay(undefined, { FORCE_COLOR: "1" }, false)).toMatchObject({ mark: true, colour: true });
    expect(resolveDisplay(undefined, { FORCE_COLOR: "0" }, false)).toMatchObject({ mark: false, colour: false });
  });

  test("@specs:human-output.design-elements-suppressed-output - truecolor is taken from COLORTERM", () => {
    expect(tty({ COLORTERM: "truecolor" }).depth.truecolor).toBe(true);
    expect(tty({ COLORTERM: "24bit" }).depth.truecolor).toBe(true);
    expect(tty({}).depth.truecolor).toBe(false);
  });

  test("@specs:human-output.design-elements-suppressed-output - PLAIN is the fully-off reading", () => {
    expect(PLAIN).toMatchObject({ mark: false, colour: false });
  });
});
