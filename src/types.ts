// Core data model. UAC §3.

import type { EffortTier } from "./config.js";

export type LayerRole = "prescriptive" | "descriptive" | "verificatory";

export interface Atom {
  /** Stable slug id from the sidecar, e.g. "init.requires-git" (UAC §3.2). */
  id: string;
  layer: string;
  /** Full heading path, e.g. "1. Project Initialisation > 1.1 Project Setup". */
  groupPath: string;
  /** Numbering-stripped, normalised heading path, stable across renumbering (UAC §3.1). */
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
  /** Text still carrying an unfilled template placeholder (UAC §3.1). Implies `tbd`; kept as its
   * own flag so the report can name why an atom left the coverage denominator. */
  placeholder: boolean;
  /** Under an informative heading — Out of Scope, Non-Goals (UAC §3.1). Tracked, never coverage-
   * checked: a statement of what will not be built cannot be satisfied by a test asserting it. */
  informative: boolean;
}

export interface Group {
  layer: string;
  groupPath: string;
  /** Slug used by section tags (UAC §4.2). */
  slug: string;
  file: string;
  line: number;
  tbd: boolean;
  /** Under an informative heading (UAC §3.1) — excluded from D↔V section coverage like a TBD group. */
  informative: boolean;
  atoms: Atom[];
}

// Lifecycle (UAC §4.1): uncovered → pending (first tag lands) → covered (accept records the
// verified state). `stale` is the drift kind. A claim is never stale before it has been verified
// once, so `pending` is the tagged-but-never-verified state, kept distinct from `stale` so repair
// can tell "awaiting the accept gate" (emits no task, UAC §10.1) apart from "verified then
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
