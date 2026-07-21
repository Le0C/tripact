// The witness mark on a character grid, and the palette it is drawn in (UAC Cross-Cutting: Human
// output). Source of truth for the artwork is the design brief's `assets/ascii.txt`; the rows are
// encoded here rather than read from disk so the kernel keeps its no-runtime-asset footprint.
//
// The mark is three solid bands with a single diagonal cut struck through them. On a character grid
// the cut is one cell per row and the diagonal is carried by the cut's column: 9, 6, 3. Drift is a
// column stepping out of that progression — the one displacement a character grid represents
// exactly, which is why this direction survived and a curve-based one did not.
//
// Nothing here may be the sole carrier of a state: every mark is captioned in words by its caller,
// so a monochrome terminal or a piped log loses the decoration and keeps the meaning.

/** Heavy horizontal, U+2501 — a band that is struck. */
const BAND = "━";
/** Box drawings light quadruple dash horizontal, U+2504 — a band that was never struck. */
const UNSTRUCK = "┄";
/** Box drawings light diagonal upper right to lower left, U+2572 — the cut. */
const CUT = "╲";

/** Every row of the mark is exactly this many cells. */
export const MARK_WIDTH = 13;

/** The four conditions a witness mark can be in. Named for the report vocabulary, not the artwork. */
export type MarkState = "level" | "drifted" | "uncovered" | "unbaselined";

/** How one band renders: `live` is in agreement, `moved` is the band that broke the mark. */
type BandTone = "live" | "moved";

interface BandRow {
  /** Column of the cut, 0-indexed; null when the band is unstruck entirely. */
  cut: number | null;
  tone: BandTone;
}

// The diagonal: cuts at 9, 6, 3 reading top to bottom. `drifted` moves the middle cut to 11, out of
// the progression. `uncovered` removes the middle band's cut altogether — there is nothing to align.
// `unbaselined` is byte-identical to `level`; it is distinguished by tone alone, deliberately, since
// an invented glyph would imply a fourth kind of breakage that does not exist.
const STATES: Record<MarkState, BandRow[]> = {
  level: [
    { cut: 9, tone: "live" },
    { cut: 6, tone: "live" },
    { cut: 3, tone: "live" },
  ],
  drifted: [
    { cut: 9, tone: "live" },
    { cut: 11, tone: "moved" },
    { cut: 3, tone: "live" },
  ],
  uncovered: [
    { cut: 9, tone: "live" },
    { cut: null, tone: "moved" },
    { cut: 3, tone: "live" },
  ],
  unbaselined: [
    { cut: 9, tone: "moved" },
    { cut: 6, tone: "moved" },
    { cut: 3, tone: "moved" },
  ],
};

/** One band as plain text: `cut: null` leaves the band unstruck across its full width. */
function bandText(row: BandRow): string {
  if (row.cut === null) return UNSTRUCK.repeat(MARK_WIDTH);
  return BAND.repeat(row.cut) + CUT + BAND.repeat(MARK_WIDTH - row.cut - 1);
}

// Palette (design brief). Torque-seal lacquer is what aircraft fasteners are marked with, in a
// vivid orange chosen so a broken mark is impossible to miss on a walkaround.
//
// The logo is ink; orange is reserved for state. A coloured band therefore always *means*
// something rather than being decoration, and the mark stays monochrome-safe.
const TORQUE = [221, 99, 32] as const; // #DD6320 — a band still in agreement
const STEEL = [124, 132, 140] as const; // #7C848C — a band that moved, or an unbaselined tree

/** Nearest xterm-256 index, for terminals that do not take 24-bit colour. */
const TORQUE_256 = 166;
const STEEL_256 = 245;

export interface ColourDepth {
  /** True when the terminal takes 24-bit colour (COLORTERM advertises truecolor). */
  truecolor: boolean;
}

function fg(rgb: readonly [number, number, number], fallback: number, depth: ColourDepth): string {
  return depth.truecolor ? `\x1b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m` : `\x1b[38;5;${fallback}m`;
}

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";

/**
 * The mark for one state, as an array of rows.
 *
 * With `colour` false the rows are plain text and the state is carried by the cut's column alone —
 * which is the whole reason the artwork is built on a column shift. `unbaselined` is the one state
 * that is not distinguishable without colour, and its caller always captions it.
 */
export function renderMark(
  state: MarkState,
  opts: { colour: boolean; depth?: ColourDepth } = { colour: false },
): string[] {
  const rows = STATES[state];
  const depth = opts.depth ?? { truecolor: true };
  return rows.map((row) => {
    const text = bandText(row);
    if (!opts.colour) return text;
    const ink = row.tone === "live" ? fg(TORQUE, TORQUE_256, depth) : fg(STEEL, STEEL_256, depth);
    // Unbaselined is the whole mark dimmed: nothing has been recorded yet, so the mark is present
    // but not yet asserting anything.
    const prefix = state === "unbaselined" ? DIM + ink : ink;
    return `${prefix}${text}${RESET}`;
  });
}

/**
 * The banner: the mark set beside the wordmark, for the head of a human report.
 *
 * The wordmark is ink, never orange — orange is state, and a banner asserts no state. In practice
 * that means the wordmark takes the terminal's own foreground colour and is left alone.
 */
export function renderBanner(opts: { colour: boolean; depth?: ColourDepth } = { colour: false }): string[] {
  // The banner mark is drawn in the `level` geometry because it is the logo, not a reading — so it
  // is rendered uncoloured even when colour is on, keeping "orange means state" honest.
  const mark = renderMark("level", { colour: false });
  const wordmark = ["", "tripact", ""];
  const bold = opts.colour ? "\x1b[1m" : "";
  const reset = opts.colour ? RESET : "";
  return mark.map((row, i) => {
    const word = wordmark[i] ?? "";
    return word ? `${row}  ${bold}${word}${reset}` : row;
  });
}

/**
 * Tint one run of text (UAC §5.2). `attention` is for a state the reader must act on, `inert` for
 * one that is acknowledged or advisory. Colour is always *added* to text that already reads
 * correctly without it — never a substitute for the word.
 */
export function tint(
  text: string,
  tone: "attention" | "inert",
  opts: { colour: boolean; depth?: ColourDepth },
): string {
  if (!opts.colour) return text;
  const depth = opts.depth ?? { truecolor: true };
  const ink = tone === "attention" ? fg(TORQUE, TORQUE_256, depth) : fg(STEEL, STEEL_256, depth);
  return `${ink}${text}${RESET}`;
}

/** Dim one run of text — for detail that should recede rather than be read. */
export function dim(text: string, opts: { colour: boolean }): string {
  return opts.colour ? `${DIM}${text}${RESET}` : text;
}

/** Printable cell count, ignoring any SGR sequences the string carries. */
export function displayWidth(text: string): number {
  return [...text.replace(/\x1b\[[0-9;]*m/g, "")].length;
}

/** Config shape this module reads; kept structural so it does not import the config schema. */
export interface DisplayConfig {
  display?: { mark?: boolean | undefined; colour?: boolean | undefined } | undefined;
}

export interface DisplayOptions {
  /** Draw the witness mark (banner and state mark). */
  mark: boolean;
  /** Emit ANSI colour. */
  colour: boolean;
  depth: ColourDepth;
}

/**
 * Whether to draw design elements, and in what colour depth (UAC Cross-Cutting: Human output).
 *
 * The two classes have opposite defaults, because they earn their space differently. Colour is
 * **on**: it rides along the lines a reader is already reading and costs no room. The mark is
 * **off**: it is six lines of decoration per report, which reads as noise in the common case of
 * running `check` repeatedly, so it is opted into by a repository that wants it.
 *
 * Precedence, strongest first: the repository's own config, then `NO_COLOR`, then `FORCE_COLOR`,
 * then whether the stream is a terminal. Config wins over the environment because it is the
 * repository stating an intent, not the invocation stating a capability — a repo that has turned
 * colour off should not have it forced back on by a CI variable.
 *
 * Non-terminal output is plain, so a piped or redirected report carries no escapes. Set
 * `FORCE_COLOR` to capture a decorated report into a file deliberately.
 */
export function resolveDisplay(
  config: DisplayConfig | undefined,
  env: NodeJS.ProcessEnv,
  isTTY: boolean,
): DisplayOptions {
  const declared = config?.display;
  const forced = env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== "0";
  // NO_COLOR is honoured by presence, whatever its value, per the no-color.org convention.
  const noColour = env.NO_COLOR !== undefined;
  const depth: ColourDepth = {
    truecolor: env.COLORTERM === "truecolor" || env.COLORTERM === "24bit",
  };

  // Opt-in: absent or false leaves the mark undrawn. It still answers to the stream, so opting in
  // does not put escapes into a pipe.
  const mark = declared?.mark === true ? forced || isTTY : false;
  const colour = declared?.colour === false ? false : noColour ? false : forced || isTTY;
  return { mark, colour, depth };
}

/** Design elements fully off — the reading a pipe, a log, or `--json` gets. */
export const PLAIN: DisplayOptions = { mark: false, colour: false, depth: { truecolor: false } };
