// Acceptance preview (UAC §8.4) + the pre-write summary `tripact accept` prints (§8.3).
// Computes the delta between the committed sidecar (loadSidecar) and the sidecar an accept
// would write (buildAcceptedSidecar): claims created / re-anchored / retired, and
// per-edge verified-state changes (newly recorded vs re-baselined). Pure; it writes nothing.
// Deterministic: sorted ids throughout, no clock.

import { excerpt } from "./report.js";
import { type Sidecar, type VerifiedState, sidecarContentHash } from "./sidecar.js";

export interface EdgeVerifiedDelta {
  edge: [string, string];
  /** Subjects (atom id for P↔V, group slug for D↔V) gaining a verified state that had none. */
  newlyRecorded: string[];
  /** Subjects whose verified state changed (target-file or claim hash moved) under an existing baseline. */
  reBaselined: string[];
}

/**
 * A re-baseline where the claim's own text moved: the reword class of §4.1 (as opposed to a
 * test-side-only re-verify, where only a tagged file's hash shifted). This is the one re-baseline
 * that satisfies the hash machinery while the tagged test may still assert the old meaning, so it
 * is surfaced on its own with old and new text excerpts (UAC §8.3, §8.4).
 */
export interface RewordRebaseline {
  edge: [string, string];
  /** Claim id whose verified state re-baselines onto reworded text. */
  subject: string;
  /** Recorded (old) claim text the current baseline was verified against. */
  oldText: string;
  /** Current (new) claim text an accept would re-baseline onto. */
  newText: string;
}

export interface AcceptanceDelta {
  schemaVersion: 1;
  /** Ids alive in the would-be sidecar that the committed sidecar never held. */
  created: string[];
  /** Ids alive in both whose normalised text or group anchoring changed. */
  reAnchored: string[];
  /** Ids alive in the committed sidecar that the would-be sidecar retires (marks dead). */
  retired: string[];
  /** Per-edge verified-state changes, edges sorted. */
  verified: EdgeVerifiedDelta[];
  /**
   * The subset of re-baselined verified states whose claim text was reworded (§4.1), each with old
   * and new text excerpts. Sorted by subject. It narrows down the reword class that the plain
   * `reBaselined` list lumps in with test-side-only re-verifies.
   */
  rewordRebaselines: RewordRebaseline[];
  /** Acknowledged-backlog delta (UAC §8.4): what this accept would add to / clear from the backlog. */
  backlog: {
    /** Subjects (claim ids + section slugs) this accept would newly acknowledge as backlog. */
    newlyAcknowledged: string[];
    /** Subjects that were backlog and are now covered, the ratchet moving down. */
    coveredSince: string[];
  };
  /** Content hash of the committed sidecar (the current tripact-sync-id trailer). */
  currentTrailer: string;
  /** Content hash an accept would print. */
  wouldBeTrailer: string;
}

const edgeKey = (e: [string, string]) => `${e[0]}↔${e[1]}`;
const sortIds = (ids: Iterable<string>) => [...new Set(ids)].sort();

/** Fingerprint a set of verified states so a changed baseline is detectable, order-independent. */
function verifiedFingerprint(states: VerifiedState[]): string {
  return states
    .map((v) => `${v.file}|${v.targetFileHash}|${v.claimHash}`)
    .sort()
    .join(";");
}

/** Index verified states by edge → subject. PV states live on claims (subject = id), DV on groups (subject = slug). */
function verifiedIndex(sc: Sidecar): Map<string, Map<string, VerifiedState[]>> {
  const byEdge = new Map<string, Map<string, VerifiedState[]>>();
  const add = (subject: string, states: VerifiedState[]) => {
    for (const v of states) {
      const k = edgeKey(v.edge);
      let bySubject = byEdge.get(k);
      if (!bySubject) byEdge.set(k, (bySubject = new Map()));
      const arr = bySubject.get(subject);
      if (arr) arr.push(v);
      else bySubject.set(subject, [v]);
    }
  };
  for (const c of sc.claims) add(c.id, c.verified);
  for (const g of sc.groups) add(g.slug, g.verified);
  return byEdge;
}

/**
 * Compute what an accept would change, comparing the committed sidecar (`current`)
 * against the sidecar that accept would write (`would`). Pure; caller renders or serialises.
 */
export function computeAcceptanceDelta(current: Sidecar, would: Sidecar): AcceptanceDelta {
  const curById = new Map(current.claims.map((c) => [c.id, c]));
  const wouldById = new Map(would.claims.map((c) => [c.id, c]));

  const created: string[] = [];
  const reAnchored: string[] = [];
  for (const c of would.claims) {
    if (!c.alive) continue;
    const prev = curById.get(c.id);
    if (!prev) {
      created.push(c.id);
    } else if (prev.text !== c.text || prev.groupPath !== c.groupPath || prev.groupKey !== c.groupKey) {
      reAnchored.push(c.id);
    }
  }
  const retired: string[] = [];
  for (const c of current.claims) {
    if (!c.alive) continue;
    const next = wouldById.get(c.id);
    if (!next || !next.alive) retired.push(c.id);
  }

  // per-edge verified-state changes
  const curV = verifiedIndex(current);
  const wouldV = verifiedIndex(would);
  const verified: EdgeVerifiedDelta[] = [];
  const rewordRebaselines: RewordRebaseline[] = [];
  for (const k of [...new Set([...curV.keys(), ...wouldV.keys()])].sort()) {
    const cur = curV.get(k) ?? new Map<string, VerifiedState[]>();
    const nxt = wouldV.get(k) ?? new Map<string, VerifiedState[]>();
    const newlyRecorded: string[] = [];
    const reBaselined: string[] = [];
    const [a, b] = k.split("↔");
    for (const [subject, states] of nxt) {
      const before = cur.get(subject);
      if (!before || before.length === 0) {
        newlyRecorded.push(subject);
      } else if (verifiedFingerprint(before) !== verifiedFingerprint(states)) {
        reBaselined.push(subject);
        // Split the reword class out of the plain re-baseline list: a re-baseline whose claim text
        // itself moved (not just a tagged file's hash) is the one where the hash machinery lands
        // while the tag may still assert the old meaning. Old text is the committed claim, new text
        // the one this accept would re-baseline onto. Only claims carry text; sections are skipped.
        const prev = curById.get(subject);
        const next = wouldById.get(subject);
        if (prev && next && prev.text !== next.text) {
          rewordRebaselines.push({ edge: [a as string, b as string], subject, oldText: prev.text, newText: next.text });
        }
      }
    }
    if (newlyRecorded.length === 0 && reBaselined.length === 0) continue;
    verified.push({ edge: [a as string, b as string], newlyRecorded: sortIds(newlyRecorded), reBaselined: sortIds(reBaselined) });
  }
  rewordRebaselines.sort((x, y) => (x.subject < y.subject ? -1 : x.subject > y.subject ? 1 : 0));

  // Acknowledged-backlog delta (UAC §8.4): compare the committed backlog with the one this
  // accept would snapshot. Newly acknowledged = grew the backlog; covered since = ratchet down.
  const curBacklog = new Set([...current.backlog.claims, ...current.backlog.sections]);
  const wouldBacklog = new Set([...would.backlog.claims, ...would.backlog.sections]);
  const newlyAcknowledged = sortIds([...wouldBacklog].filter((s) => !curBacklog.has(s)));
  const coveredSince = sortIds([...curBacklog].filter((s) => !wouldBacklog.has(s)));

  return {
    schemaVersion: 1,
    created: sortIds(created),
    reAnchored: sortIds(reAnchored),
    retired: sortIds(retired),
    verified,
    rewordRebaselines,
    backlog: { newlyAcknowledged, coveredSince },
    currentTrailer: sidecarContentHash(current),
    wouldBeTrailer: sidecarContentHash(would),
  };
}

/** Whether an accept would change anything at all. */
export function deltaIsEmpty(d: AcceptanceDelta): boolean {
  return (
    d.created.length === 0 &&
    d.reAnchored.length === 0 &&
    d.retired.length === 0 &&
    d.verified.length === 0 &&
    d.backlog.newlyAcknowledged.length === 0 &&
    d.backlog.coveredSince.length === 0 &&
    d.currentTrailer === d.wouldBeTrailer
  );
}

function idList(label: string, ids: string[], lines: string[]): void {
  lines.push(`  ${label}: ${ids.length}`);
  for (const id of ids) lines.push(`    ${id}`);
}

/**
 * Human render of the acceptance delta. `trailers` toggles the current→would-be trailer
 * footer: on for `tripact diff` (§8.4), off for the `accept` pre-write summary (§8.3),
 * which prints its own official trailer line afterwards.
 */
export function renderDeltaHuman(d: AcceptanceDelta, opts: { trailers?: boolean } = {}): string {
  const lines: string[] = ["tripact diff — what acceptance would change", ""];
  if (deltaIsEmpty(d)) {
    lines.push("  nothing would change — the sidecar already reflects the current tree.");
  } else {
    idList("claims created", d.created, lines);
    idList("claims re-anchored", d.reAnchored, lines);
    idList("claims retired", d.retired, lines);
    lines.push("  verified states:");
    if (d.verified.length === 0) lines.push("    (no changes)");
    for (const e of d.verified) {
      lines.push(`    edge ${e.edge[0]} ↔ ${e.edge[1]}: ${e.newlyRecorded.length} newly recorded, ${e.reBaselined.length} re-baselined`);
      for (const id of e.newlyRecorded) lines.push(`      + ${id}`);
      for (const id of e.reBaselined) lines.push(`      ~ ${id}`);
    }
    // Reworded re-baselines (UAC §8.3, §8.4): the re-baseline class where the claim text itself
    // moved, so the hash machinery is satisfied while the tagged test may still assert the old
    // meaning. Called out on its own with old and new text excerpts so a human confirming (or a
    // --yes run) sees exactly which meanings are being re-baselined without re-reading the tests.
    if (d.rewordRebaselines.length > 0) {
      lines.push(`  re-baselined after reword: ${d.rewordRebaselines.length}`);
      for (const r of d.rewordRebaselines) {
        lines.push(`    ~ ${r.subject} (edge ${r.edge[0]} ↔ ${r.edge[1]})`);
        lines.push(`        old: "${excerpt(r.oldText)}"`);
        lines.push(`        new: "${excerpt(r.newText)}"`);
      }
    }
    // Acknowledged-backlog delta (UAC §8.4): what this accept adds to / clears from the backlog.
    lines.push(`  backlog: ${d.backlog.newlyAcknowledged.length} newly acknowledged, ${d.backlog.coveredSince.length} covered since`);
    for (const id of d.backlog.newlyAcknowledged) lines.push(`    + ${id}`);
    for (const id of d.backlog.coveredSince) lines.push(`    - ${id}`);
  }
  if (opts.trailers) {
    lines.push("");
    lines.push(`  current trailer:  ${d.currentTrailer}`);
    lines.push(`  would-be trailer: ${d.wouldBeTrailer}`);
  }
  return lines.join("\n");
}
