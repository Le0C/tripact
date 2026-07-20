// `audit <claim-id>`: the recorded history of one claim (UAC §21). Reconstructs a newest-first
// timeline from three evidence sources, none of which requires new state: the committed sidecar's
// git history (lifecycle events at each accept), the adjudication journal (§7.2), and the git
// history of the claim's verifying test files (file-level evidence, marked as such). A harness may
// interleave extra events it owns (e.g. executed sync-run items, §21.2) via `extraEvents`; the
// kernel timeline is complete without them.
//
// Everything here is read-only and deterministic: dates come from commits and journal entries
// (repo state), never from a clock, so identical repo state renders byte-identical output.

import { readFileSync } from "node:fs";
import path from "node:path";
import { AUDIT_SCHEMA_VERSION } from "./contract.js";
import type { Analysis } from "./engine.js";
import { journalPath } from "./escalation.js";
import { commitsTouching, fileAtCommit, type CommitInfo } from "./git.js";
import { truncateListing } from "./report.js";
import type { Sidecar, SidecarEntry } from "./sidecar.js";
import { SIDECAR_DIR } from "./sidecar.js";
import { similarityRatio } from "./similarity.js";
import type { EdgeVerdict } from "./types.js";

/** Repo-relative sidecar path, which is what the archaeology walk asks git about. */
const SIDECAR_REL = `${SIDECAR_DIR}/claims.json`;

export type AuditSource = "sync-point" | "adjudication" | "test-history" | "task";

/**
 * One timeline event. `date` absent means the evidence is not yet committed (an accepted-but-
 * uncommitted sidecar, an uncommitted run directory); undated events order ahead of all dated ones
 * (UAC §21.2). Human rendering uses `kind` verbatim, so one vocabulary covers human and JSON output
 * (Cross-Cutting: Human output).
 */
export interface AuditEvent {
  source: AuditSource;
  kind: string;
  /** One-line human description. */
  detail: string;
  date?: string;
  commit?: string;
  author?: string;
  subject?: string;
  /** `tripact-sync-id` trailer value when the commit carries one (UAC §21.1). */
  syncId?: string;
  edge?: [string, string];
  file?: string;
  oldText?: string;
  newText?: string;
  /** Sync-run number for harness task events (UAC §21.2). */
  run?: number;
  itemId?: string;
}

export interface AuditClaimCard {
  id: string;
  alive: boolean;
  layer: string;
  groupPath: string;
  text: string;
  /** Current anchor, present while the claim is alive in the tree. */
  file?: string;
  line?: number;
  verdicts: Array<{ edge: [string, string]; kind: string; tags: Array<{ file: string; line: number }> }>;
}

export interface AuditReport {
  schemaVersion: number;
  claim: AuditClaimCard;
  events: AuditEvent[];
}

/** Unknown claim id (UAC §21.1): exit 2 at the CLI, carrying ranked suggestions. */
export class AuditError extends Error {
  suggestions: string[];
  constructor(message: string, suggestions: string[]) {
    super(message);
    this.suggestions = suggestions;
  }
}

/** Order within one instant: lifecycle before harness tasks before adjudications before file edits. */
const SOURCE_RANK: Record<AuditSource, number> = { "sync-point": 0, task: 1, adjudication: 2, "test-history": 3 };

/** Order among lifecycle events sharing one accept commit: birth first, death last. */
const KIND_RANK = ["created", "revived", "reworded", "moved", "verified-recorded", "re-baselined", "verified-dropped", "retired"];

function eventInstant(e: AuditEvent): number {
  return e.date ? Date.parse(e.date) : Number.POSITIVE_INFINITY;
}

/** Newest first; undated events first; fully deterministic tie-breaks (Cross-Cutting: Determinism). */
export function compareEvents(a: AuditEvent, b: AuditEvent): number {
  const ta = eventInstant(a);
  const tb = eventInstant(b);
  if (ta !== tb) return ta > tb ? -1 : 1;
  const sr = SOURCE_RANK[a.source] - SOURCE_RANK[b.source];
  if (sr) return sr;
  const ka = KIND_RANK.indexOf(a.kind);
  const kb = KIND_RANK.indexOf(b.kind);
  if (ka !== kb) return kb - ka; // newest-first listing: later lifecycle stages print above earlier ones
  if (a.detail !== b.detail) return a.detail < b.detail ? -1 : 1;
  return 0;
}

interface VerifiedKeyed {
  edge: [string, string];
  file: string;
  claimHash: string;
  targetFileHash: string;
}

function verifiedByKey(rec: SidecarEntry): Map<string, VerifiedKeyed> {
  const m = new Map<string, VerifiedKeyed>();
  for (const v of rec.verified) m.set(`${v.edge.join("↔")} ${v.file}`, { edge: v.edge, file: v.file, claimHash: v.claimHash, targetFileHash: v.targetFileHash });
  return m;
}

function excerpt(text: string, max = 48): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** Lifecycle events for this claim between two consecutive sidecar versions (UAC §21.1). */
function diffRecords(prev: SidecarEntry | undefined, cur: SidecarEntry | undefined): Array<Pick<AuditEvent, "kind" | "detail" | "edge" | "file" | "oldText" | "newText">> {
  const events: Array<Pick<AuditEvent, "kind" | "detail" | "edge" | "file" | "oldText" | "newText">> = [];
  if (!cur) return events; // never removed outright: retirement flips `alive`, the record stays
  if (!prev) {
    events.push({ kind: "created", detail: `claim created — "${excerpt(cur.text)}"` });
    return events;
  }
  if (!prev.alive && cur.alive) events.push({ kind: "revived", detail: "claim revived" });
  if (cur.text !== prev.text) {
    events.push({ kind: "reworded", detail: `reworded — "${excerpt(prev.text)}" → "${excerpt(cur.text)}"`, oldText: prev.text, newText: cur.text });
  }
  if (cur.groupPath !== prev.groupPath) {
    events.push({ kind: "moved", detail: `moved — "${prev.groupPath}" → "${cur.groupPath}"` });
  }
  const before = verifiedByKey(prev);
  const after = verifiedByKey(cur);
  for (const [key, v] of [...after].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const was = before.get(key);
    const edgeName = v.edge.join("↔");
    if (!was) events.push({ kind: "verified-recorded", detail: `verified-recorded on ${edgeName} — ${v.file}`, edge: v.edge, file: v.file });
    else if (was.claimHash !== v.claimHash || was.targetFileHash !== v.targetFileHash) {
      events.push({ kind: "re-baselined", detail: `re-baselined on ${edgeName} — ${v.file}`, edge: v.edge, file: v.file });
    }
  }
  for (const [key, v] of [...before].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (!after.has(key)) events.push({ kind: "verified-dropped", detail: `verified-dropped on ${v.edge.join("↔")} — ${v.file}`, edge: v.edge, file: v.file });
  }
  if (prev.alive && !cur.alive) events.push({ kind: "retired", detail: `claim retired — last text "${excerpt(cur.lastText ?? cur.text)}"` });
  return events;
}

function parseSidecarAt(root: string, sha: string): Sidecar | null {
  const raw = fileAtCommit(root, sha, SIDECAR_REL);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as Sidecar;
  } catch {
    return null; // a malformed historical sidecar is skipped, never fatal
  }
}

/**
 * Sidecar archaeology (UAC §21.1): walk every commit that touched the sidecar oldest-first, diff
 * this claim's record between consecutive versions, then diff the last committed version against
 * the sidecar on disk, so an accepted-but-uncommitted baseline surfaces as undated events.
 */
function lifecycleEvents(root: string, claimId: string, current: Sidecar): { events: AuditEvent[]; texts: Set<string>; syncCommits: Set<string> } {
  const events: AuditEvent[] = [];
  const texts = new Set<string>();
  const syncCommits = new Set<string>();
  const commits = commitsTouching(root, SIDECAR_REL).reverse();
  let prev: SidecarEntry | undefined;
  for (const c of commits) {
    const sidecar = parseSidecarAt(root, c.sha);
    if (!sidecar) continue;
    syncCommits.add(c.sha);
    const rec = (sidecar.claims ?? []).find((e) => e.id === claimId);
    if (rec) texts.add(rec.text);
    for (const d of diffRecords(prev, rec)) {
      events.push({ source: "sync-point", date: c.date, commit: c.shortSha, author: c.author, subject: c.subject, ...(c.syncId ? { syncId: c.syncId } : {}), ...d });
    }
    prev = rec ?? prev;
  }
  const onDisk = current.claims.find((e) => e.id === claimId);
  if (onDisk) texts.add(onDisk.text);
  for (const d of diffRecords(prev, onDisk)) {
    events.push({ source: "sync-point", ...d, detail: `${d.detail} (uncommitted)` });
  }
  return { events, texts, syncCommits };
}

/** Journal entries naming the claim (UAC §21.1): by id, or by exact text for `resolve-new`. */
function journalEvents(root: string, claimId: string, knownTexts: Set<string>): AuditEvent[] {
  let raw: string;
  try {
    raw = readFileSync(journalPath(root), "utf8");
  } catch {
    return [];
  }
  const events: AuditEvent[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const oldId = typeof entry.oldId === "string" ? entry.oldId : undefined;
    const text = typeof entry.text === "string" ? entry.text : undefined;
    const newText = typeof entry.newText === "string" ? entry.newText : undefined;
    const names = oldId === claimId || (text !== undefined && knownTexts.has(text)) || (newText !== undefined && knownTexts.has(newText));
    if (!names) continue;
    const action = typeof entry.action === "string" ? entry.action : "journal";
    const question = typeof entry.questionId === "string" ? ` (${entry.questionId})` : "";
    const reword = newText !== undefined ? ` — "${excerpt(newText)}"` : "";
    events.push({
      source: "adjudication",
      kind: action,
      detail: `${action}${question}${reword}`,
      ...(typeof entry.at === "string" ? { date: entry.at } : {}),
    });
  }
  return events;
}

/**
 * File-level evidence (UAC §21.1): commits touching any file this claim's verified states have
 * ever named. Accept commits already shown as sync-point events are skipped; commits predating the
 * claim's creation are noise and get filtered out when the creation date is known.
 */
function testHistoryEvents(root: string, files: Set<string>, syncCommits: Set<string>, createdAt: number | null): AuditEvent[] {
  const events: AuditEvent[] = [];
  for (const file of [...files].sort()) {
    for (const c of commitsTouching(root, file)) {
      if (syncCommits.has(c.sha)) continue;
      if (createdAt !== null && Date.parse(c.date) < createdAt) continue;
      events.push({
        source: "test-history",
        kind: "file-edited",
        detail: `${file} edited (file-level) — ${c.subject}`,
        date: c.date,
        commit: c.shortSha,
        author: c.author,
        subject: c.subject,
        file,
      });
    }
  }
  return events;
}

function knownIds(analysis: Analysis): string[] {
  const ids = new Set<string>(analysis.sidecar.claims.map((c) => c.id));
  for (const layer of analysis.layers.values()) for (const atom of layer.atoms) ids.add(atom.id);
  return [...ids].sort();
}

/** Nearest known ids for an unknown one (UAC §21.1), ranked by the deterministic matcher (§3.3). */
export function suggestIds(analysis: Analysis, claimId: string, limit = 3): string[] {
  return knownIds(analysis)
    .map((id) => ({ id, ratio: similarityRatio(claimId, id) }))
    .sort((a, b) => b.ratio - a.ratio || (a.id < b.id ? -1 : 1))
    .slice(0, limit)
    .filter((s) => s.ratio >= 0.4)
    .map((s) => s.id);
}

function buildCard(analysis: Analysis, claimId: string): AuditClaimCard | null {
  for (const layer of analysis.layers.values()) {
    const atom = layer.atoms.find((a) => a.id === claimId);
    if (atom) {
      return {
        id: claimId,
        alive: true,
        layer: atom.layer,
        groupPath: atom.groupPath,
        text: atom.norm,
        file: atom.file,
        line: atom.line,
        verdicts: analysis.verdicts.filter((v) => v.subject === claimId).map(cardVerdict),
      };
    }
  }
  const rec = analysis.sidecar.claims.find((c) => c.id === claimId);
  if (!rec) return null;
  return {
    id: claimId,
    alive: rec.alive,
    layer: rec.layer,
    groupPath: rec.groupPath,
    text: rec.lastText ?? rec.text,
    verdicts: analysis.verdicts.filter((v) => v.subject === claimId).map(cardVerdict),
  };
}

function cardVerdict(v: EdgeVerdict): AuditClaimCard["verdicts"][number] {
  return { edge: v.edge, kind: v.kind, tags: v.tags.map((t) => ({ file: t.file, line: t.line })) };
}

/**
 * Assemble the audit report (UAC §21.1). `extraEvents` lets a harness interleave events it owns
 * (run history, §21.2); they are merged into the same deterministic order.
 */
export function runAudit(root: string, analysis: Analysis, claimId: string, extraEvents: AuditEvent[] = []): AuditReport {
  const card = buildCard(analysis, claimId);
  if (!card) {
    throw new AuditError(`unknown claim id "${claimId}"`, suggestIds(analysis, claimId));
  }
  const { events, texts, syncCommits } = lifecycleEvents(root, claimId, analysis.sidecar);

  const files = new Set<string>();
  for (const e of events) if (e.file) files.add(e.file);
  const rec = analysis.sidecar.claims.find((c) => c.id === claimId);
  for (const v of rec?.verified ?? []) files.add(v.file);

  const created = events.find((e) => e.kind === "created" && e.date);
  const createdAt = created?.date ? Date.parse(created.date) : null;

  const all = [
    ...events,
    ...journalEvents(root, claimId, texts),
    ...testHistoryEvents(root, files, syncCommits, createdAt),
    ...extraEvents,
  ].sort(compareEvents);

  return { schemaVersion: AUDIT_SCHEMA_VERSION, claim: card, events: all };
}

const DATE_COL = "uncommitted".length;

function eventLine(e: AuditEvent): string {
  const date = (e.date ? e.date.slice(0, 10) : "uncommitted").padEnd(DATE_COL);
  const commit = (e.commit ?? "").padEnd(9);
  const source = e.source.padEnd(12);
  return `  ${date}  ${commit} ${source} ${e.detail}`;
}

/** Human report (UAC §21.1): counts first, claim card, then the truncatable timeline. */
export function renderAuditHuman(report: AuditReport, opts: { long?: boolean } = {}): string {
  const c = report.claim;
  const lines: string[] = [];
  lines.push(`tripact audit ${c.id} — ${report.events.length} event(s)`);
  lines.push("");
  lines.push(`CLAIM ${c.id}  [${c.alive ? "alive" : "dead"}]`);
  const anchor = c.file !== undefined ? ` · ${c.file}:${c.line}` : "";
  lines.push(`  ${c.layer} › ${c.groupPath}${anchor}`);
  lines.push(`  ${c.alive ? `"${c.text}"` : `last text: "${c.text}"`}`);
  for (const v of c.verdicts) {
    const tags = v.tags.length ? ` — ${v.tags.map((t) => `${t.file}:${t.line}`).join(", ")}` : "";
    lines.push(`  ${v.edge.join("↔")}  ${v.kind}${tags}`);
  }
  lines.push("");
  lines.push("TIMELINE");
  if (!report.events.length) lines.push("  no recorded events — the claim has never been baselined");
  else lines.push(...truncateListing(report.events.map(eventLine), opts.long === true, "  "));
  return lines.join("\n");
}

/** Repo-relative path of a run directory (UAC §21.2), exported for harness scrapers. */
export function runDirRel(run: number): string {
  return path.posix.join(SIDECAR_DIR, "sync-runs", String(run));
}
