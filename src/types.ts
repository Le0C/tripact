// Core data model. UAC §3.

import type { EffortTier } from "./config.js";

export type LayerRole = "prescriptive" | "descriptive" | "verificatory";

export interface Atom {
  /** Stable slug id from the sidecar, e.g. "init.requires-git" (UAC §3.2). */
  id: string;
  layer: string;
  /** Full heading path, e.g. "1. Project Initialisation > 1.1 Project Setup". */
  groupPath: string;
  /** Numbering-stripped, normalised heading path — stable across renumbering (UAC §3.1). */
  groupKey: string;
  /** 0-based position within its group. */
  index: number;
  file: string;
  line: number;
  raw: string;
  /** Normalised text (UAC §3.1): lowercased, whitespace-collapsed, marker/punctuation-stripped. */
  norm: string;
  /** SHA-256 of `norm`. */
  hash: string;
  tbd: boolean;
}

export interface Group {
  layer: string;
  groupPath: string;
  /** Slug used by section tags (UAC §4.2). */
  slug: string;
  file: string;
  line: number;
  tbd: boolean;
  atoms: Atom[];
}

// Lifecycle (UAC §4.1): uncovered → pending (first tag lands) → covered (accept records the
// verified state). `stale` is the drift kind — a claim is never stale before it has been verified
// once. `pending` is therefore the tagged-but-never-verified state, split out from `stale` so
// repair can tell "awaiting the accept gate" (emits no task, UAC §10.1) apart from "verified then
// drifted" (emits a reconcile-stale task).
export type EdgeVerdictKind = "covered" | "stale" | "pending" | "uncovered";

export interface EdgeVerdict {
  edge: [string, string];
  /** Atom id (P↔V) or group slug (D↔V). */
  subject: string;
  kind: EdgeVerdictKind;
  /**
   * Set on an `uncovered` verdict whose subject was in the sidecar's acknowledged backlog
   * at the last accept (UAC §3.2, §5.1). Schema-additive: the kind stays `uncovered`; this
   * flag distinguishes acknowledged **backlog** (never drift) from **new-uncovered** (drift).
   */
  acknowledged?: boolean;
  /** Tag locations supporting the verdict. */
  tags: Array<{ file: string; line: number }>;
}

export interface OrphanTag {
  tag: string;
  file: string;
  line: number;
  /** Set when the tag references a dead claim (UAC §4.1). */
  deadClaimLastText?: string;
}

export type EscalationKind = "reanchor" | "split-merge" | "fork-review";

export interface Escalation {
  /** Deterministic for the same underlying situation (UAC §7.1). */
  id: string;
  kind: EscalationKind;
  groupPath: string;
  deleted: Array<{ id: string; text: string }>;
  created: Array<{ text: string; file: string; line: number }>;
  candidates: Array<{ oldId: string; newText: string; ratio: number }>;
  /** Advisory dispatch hints from `routing`/`models` config, class `adjudicate` (UAC §16.1). Absent without config. */
  effort?: EffortTier;
  model?: string;
}
