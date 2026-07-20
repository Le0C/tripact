// `tripact reconcile` - propose existing untagged tests that may already assert an uncovered claim.
// Deterministic and propose-only (UAC §10.3): each uncovered non-(TBD) prescriptive claim is scored
// against extracted test titles via the §3.3 similarity matcher and the matches are ranked. The scan
// mutates nothing; recording a dismissal is a separate explicit write.

import { DEFAULT_TAG_PATTERN, tagFormatFromPattern } from "./config.js";
import { RECONCILE_SCHEMA_VERSION } from "./contract.js";
import type { Analysis } from "./engine.js";
import { contentHash, normalizeText } from "./parser.js";
import type { ReconcileDismissal } from "./sidecar.js";
import { similarityRatio } from "./similarity.js";

/** A candidate existing test that may already assert a claim. */
export interface ReconcileTest {
  file: string;
  line: number;
  title: string;
  score: number;
}
export interface ReconcileEntry {
  claimId: string;
  claimText: string;
  /** The exact tag to add if the agent confirms a candidate, in the verificatory layer's format. */
  tagFormat: string;
  candidates: ReconcileTest[];
}
export interface ReconcileReport {
  schemaVersion: typeof RECONCILE_SCHEMA_VERSION;
  candidates: ReconcileEntry[];
}

const DEFAULT_THRESHOLD = 0.5;

// Deterministic test-title extraction with no test runner. JS/TS: the string literal argument of an
// it()/test()/describe() call. pytest: a `def test_*` name, de-snaked into words.
const JS_TITLE = /\b(?:it|test|describe)\s*\(\s*(["'`])((?:\\.|(?!\1).)*)\1/g;
const PY_TEST = /^\s*(?:async\s+)?def\s+(test_\w+)\s*\(/;

export interface ExtractedTitle {
  file: string;
  line: number;
  title: string;
  norm: string;
}

export function extractTestTitles(file: string, content: string): ExtractedTitle[] {
  const out: ExtractedTitle[] = [];
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    if (file.endsWith(".py")) {
      const m = PY_TEST.exec(line);
      if (m) {
        const title = (m[1] as string).replace(/^test_/, "").replace(/_/g, " ");
        out.push({ file, line: i + 1, title, norm: normalizeText(title) });
      }
      continue;
    }
    const re = new RegExp(JS_TITLE.source, "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(line)) !== null) {
      const title = m[2] ?? "";
      if (title.trim()) out.push({ file, line: i + 1, title, norm: normalizeText(title) });
    }
  }
  return out;
}

/** Stable identity of a dismissal: a change on either the claim or the test text re-proposes it. */
function dismissalHash(claimNorm: string, testNorm: string): string {
  return contentHash(`${claimNorm}\n${testNorm}`);
}

/**
 * Propose, per uncovered non-(TBD) prescriptive claim, existing tests whose title scores above the
 * similarity threshold against the claim text, ranked by score (ties broken by test file, then line;
 * entries by claim id). Fully deterministic; identical trees yield identical proposals. UAC §10.3.
 */
export function reconcile(analysis: Analysis, opts: { threshold?: number } = {}): ReconcileReport {
  const threshold = opts.threshold ?? DEFAULT_THRESHOLD;
  const titles: ExtractedTitle[] = [];
  for (const layer of analysis.layers.values()) {
    if (layer.role !== "verificatory") continue;
    for (const [file, content] of layer.files) titles.push(...extractTestTitles(file, content));
  }
  const dismissed = analysis.sidecar.dismissedReconcile ?? [];
  const atomById = new Map<string, { norm: string; tbd: boolean }>();
  for (const layer of analysis.layers.values()) {
    for (const a of layer.atoms) atomById.set(a.id, { norm: a.norm, tbd: a.tbd });
  }
  const entries: ReconcileEntry[] = [];
  for (const v of analysis.verdicts) {
    if (v.kind !== "uncovered") continue;
    const [a, b] = v.edge;
    const srcName = analysis.layers.get(a)?.role === "verificatory" ? b : a;
    const verifName = srcName === a ? b : a;
    if (analysis.layers.get(srcName)?.role !== "prescriptive") continue;
    const atom = atomById.get(v.subject);
    if (!atom || atom.tbd) continue;
    const pattern = analysis.config.layers[verifName]?.tagPattern ?? DEFAULT_TAG_PATTERN;
    const tagFormat = tagFormatFromPattern(pattern, "<id>");
    const cands = titles
      .map((t) => ({ file: t.file, line: t.line, title: t.title, norm: t.norm, score: similarityRatio(atom.norm, t.norm) }))
      .filter((t) => t.score >= threshold)
      .filter(
        (t) =>
          !dismissed.some(
            (d) => d.claim === v.subject && d.file === t.file && d.line === t.line && d.hash === dismissalHash(atom.norm, t.norm),
          ),
      )
      .sort((x, y) => y.score - x.score || (x.file < y.file ? -1 : x.file > y.file ? 1 : x.line - y.line))
      .map(({ norm, ...rest }) => rest);
    if (cands.length) entries.push({ claimId: v.subject, claimText: atom.norm, tagFormat, candidates: cands });
  }
  entries.sort((x, y) => (x.claimId < y.claimId ? -1 : x.claimId > y.claimId ? 1 : 0));
  return { schemaVersion: RECONCILE_SCHEMA_VERSION, candidates: entries };
}

/**
 * Record a dismissal for a claim↔test pairing (the explicit write path, never a scan side effect,
 * UAC §10.3). Mutates `analysis.sidecar.dismissedReconcile`; the caller saves the sidecar. Returns an
 * error when the pairing is not a current candidate.
 */
export function recordDismissal(analysis: Analysis, claimId: string, file: string, line: number): { ok: boolean; error?: string } {
  const entry = reconcile(analysis).candidates.find((e) => e.claimId === claimId);
  const cand = entry?.candidates.find((c) => c.file === file && c.line === line);
  if (!entry || !cand) return { ok: false, error: `no reconcile candidate for claim "${claimId}" at ${file}:${line}` };
  const dismissal: ReconcileDismissal = { claim: claimId, file, line, hash: dismissalHash(entry.claimText, normalizeText(cand.title)) };
  const existing = analysis.sidecar.dismissedReconcile ?? [];
  if (!existing.some((d) => d.claim === dismissal.claim && d.file === dismissal.file && d.line === dismissal.line && d.hash === dismissal.hash)) {
    analysis.sidecar.dismissedReconcile = [...existing, dismissal];
  }
  return { ok: true };
}

export function renderReconcileHuman(report: ReconcileReport): string {
  if (report.candidates.length === 0) return "no reconcile candidates — every uncovered claim is unlike any existing test title";
  const lines: string[] = [`tripact reconcile — ${report.candidates.length} claim(s) with candidate tests`, ""];
  for (const e of report.candidates) {
    lines.push(`${e.claimId}  "${e.claimText}"`);
    for (const c of e.candidates) lines.push(`  ${(c.score * 100).toFixed(0)}%  ${c.file}:${c.line}  "${c.title}"`);
    lines.push(`  → tag the real match with ${e.tagFormat.replace("<id>", e.claimId)}, then baseline; dismiss the rest with \`tripact reconcile --dismiss ${e.claimId} <file> <line>\``);
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}
