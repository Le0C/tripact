// .prodsync/claims.json — committed, stable-serialised. UAC §3.2, §8.2.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface VerifiedState {
  edge: [string, string];
  claimHash: string;
  file: string;
  targetFileHash: string;
}

export interface SidecarEntry {
  id: string;
  layer: string;
  groupPath: string;
  groupKey: string;
  /** Normalised text — needed to re-anchor future edits (UAC §3.3). */
  text: string;
  hash: string;
  firstSeen: string;
  lastSeen: string;
  alive: boolean;
  /** Retained when dead, for orphan-tag hints (UAC §4.1). */
  lastText?: string;
  /** Norm-hashes this claim must never candidate-pair with (`resolve --new`, UAC §7.2). */
  rejectedMatches?: string[];
  verified: VerifiedState[];
}

export interface SidecarGroup {
  layer: string;
  slug: string;
  groupPath: string;
  /** Hash over the group's atom hashes — any atom edit changes it (UAC §4.2). */
  hash: string;
  verified: VerifiedState[];
}

/**
 * The acknowledged backlog (UAC §3.2, §5.1): the uncovered claim ids and section slugs as
 * of the last accept. A subject present here is **backlog** (reported, never drift); one
 * absent is **new-uncovered** (drift). Absent or empty on an old sidecar means nothing is
 * acknowledged — the safe default, where every uncovered subject reads as new-uncovered.
 */
export interface AcknowledgedBacklog {
  claims: string[];
  sections: string[];
}

export interface Sidecar {
  schemaVersion: 1;
  claims: SidecarEntry[];
  groups: SidecarGroup[];
  backlog: AcknowledgedBacklog;
  /**
   * Fork-review question ids the operator has dismissed with `resolve --dismiss` (UAC §7.2).
   * A dismissed id is not re-emitted by `check` for the same dead/created pair (the id is
   * deterministic in that pair). Absent when nothing has been dismissed — additive, sorted.
   */
  dismissedForks?: string[];
}

export function emptyBacklog(): AcknowledgedBacklog {
  return { claims: [], sections: [] };
}

export const SIDECAR_DIR = ".prodsync";

export function sidecarPath(repoRoot: string): string {
  return path.join(repoRoot, SIDECAR_DIR, "claims.json");
}

export function emptySidecar(): Sidecar {
  return { schemaVersion: 1, claims: [], groups: [], backlog: emptyBacklog() };
}

export function loadSidecar(repoRoot: string): Sidecar {
  const p = sidecarPath(repoRoot);
  if (!existsSync(p)) return emptySidecar();
  const raw = JSON.parse(readFileSync(p, "utf8")) as Sidecar;
  if (raw.schemaVersion !== 1) {
    throw new Error(`unsupported sidecar schemaVersion in ${p}: ${String(raw.schemaVersion)}`);
  }
  raw.claims ??= [];
  raw.groups ??= [];
  // Old sidecars predate the acknowledged backlog (UAC §3.2). Tolerate the missing field:
  // an empty backlog makes every uncovered subject read as new-uncovered — the safe default.
  raw.backlog ??= emptyBacklog();
  raw.backlog.claims ??= [];
  raw.backlog.sections ??= [];
  return raw;
}

/** Stable serialisation: sorted entries, fixed key order via replacer-free canonical objects. */
export function serializeSidecar(sidecar: Sidecar): string {
  const claims = [...sidecar.claims]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((c) => ({
      id: c.id,
      layer: c.layer,
      groupPath: c.groupPath,
      groupKey: c.groupKey,
      text: c.text,
      hash: c.hash,
      firstSeen: c.firstSeen,
      lastSeen: c.lastSeen,
      alive: c.alive,
      ...(c.lastText !== undefined ? { lastText: c.lastText } : {}),
      ...(c.rejectedMatches && c.rejectedMatches.length ? { rejectedMatches: [...c.rejectedMatches].sort() } : {}),
      verified: [...c.verified].sort((a, b) => (a.file < b.file ? -1 : 1)),
    }));
  const groups = [...sidecar.groups]
    .sort((a, b) => (a.layer + a.slug < b.layer + b.slug ? -1 : 1))
    .map((g) => ({
      layer: g.layer,
      slug: g.slug,
      groupPath: g.groupPath,
      hash: g.hash,
      verified: [...g.verified].sort((a, b) => (a.file < b.file ? -1 : 1)),
    }));
  const backlog = {
    claims: [...sidecar.backlog.claims].sort(),
    sections: [...sidecar.backlog.sections].sort(),
  };
  const dismissedForks = [...new Set(sidecar.dismissedForks ?? [])].sort();
  return (
    JSON.stringify(
      { schemaVersion: 1, claims, groups, backlog, ...(dismissedForks.length ? { dismissedForks } : {}) },
      null,
      2,
    ) + "\n"
  );
}

export function saveSidecar(repoRoot: string, sidecar: Sidecar): void {
  const p = sidecarPath(repoRoot);
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, serializeSidecar(sidecar), "utf8");
}

/** Content hash of the serialised sidecar — the tripact-sync-id trailer value (UAC §8.1). */
export function sidecarContentHash(sidecar: Sidecar): string {
  return createHash("sha256").update(serializeSidecar(sidecar), "utf8").digest("hex").slice(0, 16);
}
