// .prodsync/escalations.json + resolve semantics + journal. UAC §7.

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ESCALATIONS_SCHEMA_VERSION } from "./contract.js";
import type { Escalation } from "./types.js";
import { SIDECAR_DIR, loadSidecar, saveSidecar } from "./sidecar.js";
import { contentHash, normalizeText } from "./parser.js";

export interface EscalationFile {
  schemaVersion: 1;
  questions: Escalation[];
}

export function escalationsPath(repoRoot: string): string {
  return path.join(repoRoot, SIDECAR_DIR, "escalations.json");
}

export function journalPath(repoRoot: string): string {
  return path.join(repoRoot, SIDECAR_DIR, "journal.jsonl");
}

/** Deterministic question id for the same underlying situation (UAC §7.1). */
export function escalationId(kind: string, groupPath: string, deletedIds: string[], createdNorms: string[]): string {
  const h = createHash("sha256");
  h.update(kind);
  h.update(groupPath);
  for (const id of [...deletedIds].sort()) h.update(id);
  for (const n of [...createdNorms].sort()) h.update(n);
  return `${kind}-${h.digest("hex").slice(0, 10)}`;
}

export function writeEscalations(repoRoot: string, questions: Escalation[]): void {
  const p = escalationsPath(repoRoot);
  mkdirSync(path.dirname(p), { recursive: true });
  const sorted = [...questions].sort((a, b) => (a.id < b.id ? -1 : 1));
  const file: EscalationFile = { schemaVersion: ESCALATIONS_SCHEMA_VERSION, questions: sorted };
  writeFileSync(p, JSON.stringify(file, null, 2) + "\n", "utf8");
}

export function readEscalations(repoRoot: string): EscalationFile {
  const p = escalationsPath(repoRoot);
  if (!existsSync(p)) return { schemaVersion: ESCALATIONS_SCHEMA_VERSION, questions: [] };
  return JSON.parse(readFileSync(p, "utf8")) as EscalationFile;
}

export type Resolution =
  | { kind: "match"; oldId: string; newAtomText: string }
  | { kind: "new"; atomText: string }
  | { kind: "dead"; oldId: string }
  | { kind: "dismiss" };

function journal(repoRoot: string, record: Record<string, unknown>): void {
  appendFileSync(journalPath(repoRoot), JSON.stringify({ at: new Date().toISOString(), ...record }) + "\n", "utf8");
}

export class ResolveError extends Error {}

/** Applies an adjudication answer to the sidecar and journals it (UAC §7.2). */
export function resolve(repoRoot: string, questionId: string, answer: Resolution): void {
  const file = readEscalations(repoRoot);
  const q = file.questions.find((x) => x.id === questionId);
  if (!q) {
    throw new ResolveError(`unknown question id "${questionId}" — see ${escalationsPath(repoRoot)}`);
  }

  // dismiss: accept an advisory fork-review fork. Records the dismissal so subsequent checks do
  // not re-emit it for the same dead/created pair, journals it, and drops the whole question.
  if (answer.kind === "dismiss") {
    if (q.kind !== "fork-review") {
      throw new ResolveError(`--dismiss is only valid for a fork-review question, not a ${q.kind} question`);
    }
    const sidecar = loadSidecar(repoRoot);
    sidecar.dismissedForks = [...new Set([...(sidecar.dismissedForks ?? []), q.id])];
    saveSidecar(repoRoot, sidecar);
    journal(repoRoot, { action: "resolve-dismiss", questionId });
    writeEscalations(repoRoot, file.questions.filter((x) => x.id !== questionId));
    return;
  }

  const sidecar = loadSidecar(repoRoot);
  const byId = new Map(sidecar.claims.map((c) => [c.id, c]));

  // The single atom (old and/or created) this answer disposes — used to shrink the question.
  let disposedOld: string | null = null;
  let disposedCreatedNorm: string | null = null;

  if (answer.kind === "match") {
    if (q.kind !== "reanchor" && q.kind !== "split-merge" && q.kind !== "fork-review") {
      throw new ResolveError(`--match is not valid for a ${q.kind} question`);
    }
    const entry = byId.get(answer.oldId);
    if (!entry) throw new ResolveError(`--match: unknown claim id "${answer.oldId}"`);
    const inQuestion = q.deleted.some((d) => d.id === answer.oldId);
    if (!inQuestion) throw new ResolveError(`--match: claim "${answer.oldId}" is not part of question ${questionId}`);
    const target = q.created.find((c) => normalizeText(c.text) === normalizeText(answer.newAtomText));
    if (!target) {
      throw new ResolveError(`--match: no created atom in question ${questionId} matches the given text`);
    }
    entry.text = normalizeText(target.text);
    entry.hash = contentHash(entry.text);
    entry.alive = true;
    journal(repoRoot, { action: "resolve-match", questionId, oldId: answer.oldId, newText: target.text });
    disposedOld = answer.oldId;
    disposedCreatedNorm = normalizeText(target.text);
  } else if (answer.kind === "dead") {
    const entry = byId.get(answer.oldId);
    if (!entry) throw new ResolveError(`--dead: unknown claim id "${answer.oldId}"`);
    if (!q.deleted.some((d) => d.id === answer.oldId)) {
      throw new ResolveError(`--dead: claim "${answer.oldId}" is not part of question ${questionId}`);
    }
    entry.alive = false;
    entry.lastText = entry.text;
    journal(repoRoot, { action: "resolve-dead", questionId, oldId: answer.oldId });
    disposedOld = answer.oldId;
  } else {
    // "new": the created atom is genuinely new — reject its candidate pairings so
    // they never re-escalate (UAC §7.2); the atom itself is minted at accept.
    const created = q.created.find((c) => normalizeText(c.text) === normalizeText(answer.atomText));
    if (!created) {
      throw new ResolveError(`--new: no created atom in question ${questionId} matches the given text`);
    }
    const newHash = contentHash(normalizeText(created.text));
    for (const cand of q.candidates) {
      if (normalizeText(cand.newText) !== normalizeText(created.text)) continue;
      const entry = byId.get(cand.oldId);
      if (!entry) continue;
      entry.rejectedMatches = [...new Set([...(entry.rejectedMatches ?? []), newHash])];
    }
    journal(repoRoot, { action: "resolve-new", questionId, text: created.text });
    disposedCreatedNorm = normalizeText(created.text);
  }

  saveSidecar(repoRoot, sidecar);

  // Partial disposition (UAC §7.2): shrink the question in place — drop only the atom(s) this
  // answer disposed, and the candidate pairings that reference them. The remaining atoms keep
  // the SAME question id; the question leaves the queue only when no atoms remain. No re-check
  // is needed to dispose the siblings.
  if (disposedOld !== null) q.deleted = q.deleted.filter((d) => d.id !== disposedOld);
  if (disposedCreatedNorm !== null) q.created = q.created.filter((c) => normalizeText(c.text) !== disposedCreatedNorm);
  q.candidates = q.candidates.filter(
    (c) => c.oldId !== disposedOld && (disposedCreatedNorm === null || normalizeText(c.newText) !== disposedCreatedNorm),
  );
  const empty = q.deleted.length === 0 && q.created.length === 0;
  const remaining = empty ? file.questions.filter((x) => x.id !== questionId) : file.questions;
  writeEscalations(repoRoot, remaining);
}
