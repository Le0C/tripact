// Analysis pipeline shared by check/status/accept. UAC §5, §6, §8.
// Deterministic: no network, no clock, stable ordering throughout.

import { createHash } from "node:crypto";
import { existsSync, globSync, readFileSync } from "node:fs";
import path from "node:path";
import { anchor, DEFAULT_ANCHOR_CONFIG, type AnchorResult } from "./anchor.js";
import { DEFAULT_SECTION_TAG_PATTERN, DEFAULT_TAG_PATTERN, hintsFor, loadConfig, type Config } from "./config.js";
import { deriveOutputs, generateContent } from "./derived.js";
import { checkDV, groupHash, scanSectionTags } from "./edges/dv.js";
import { checkPV, scanTags, type TagHit } from "./edges/pv.js";
import { escalationId } from "./escalation.js";
import { changedPathsSince, findSyncPoint, headSha, type SyncPoint } from "./git.js";
import { leafOf, mintId } from "./id.js";
import { contentHash, parseMarkdownLayer } from "./parser.js";
import {
  loadSidecar,
  type Sidecar,
  type SidecarEntry,
  type SidecarGroup,
  type VerifiedState,
} from "./sidecar.js";
import type { Atom, EdgeVerdict, Escalation, Group, OrphanTag } from "./types.js";

export interface LayerData {
  name: string;
  role: "prescriptive" | "descriptive" | "verificatory";
  files: Map<string, string>; // repo-relative posix path -> content
  atoms: Atom[];
  groups: Group[];
}

export interface Analysis {
  config: Config;
  sidecar: Sidecar;
  layers: Map<string, LayerData>;
  verdicts: EdgeVerdict[];
  orphans: OrphanTag[];
  escalations: Escalation[];
  anchorResults: Map<string, AnchorResult<Atom>>;
  syncPoint: SyncPoint | null;
  syncPointMismatch: boolean;
  scope: "diff" | "full";
  /** When true, acknowledged backlog drives exit 1 too — `check --strict` (UAC §5.1). */
  strict: boolean;
  changedPaths: string[];
  /** Layers whose pathMap globs match a changed path — claims possibly affected by code drift (UAC §5.3). */
  affectedLayers: string[];
  unsupportedEdges: string[];
  /** Names of declared derived outputs whose committed file no longer matches a fresh regeneration (UAC §18.2). */
  derivedStale: string[];
}

export function collectFiles(repoRoot: string, globs: string[]): Map<string, string> {
  const files = new Map<string, string>();
  const seen = new Set<string>();
  for (const g of globs) {
    for (const rel of globSync(g, { cwd: repoRoot })) {
      const p = rel.split(path.sep).join("/");
      if (p.startsWith("node_modules/") || p.startsWith(".git/") || seen.has(p)) continue;
      seen.add(p);
      files.set(p, readFileSync(path.join(repoRoot, rel), "utf8"));
    }
  }
  return new Map([...files.entries()].sort());
}

export function fileHasher(layers: Map<string, LayerData>): (file: string) => string | null {
  const cache = new Map<string, string>();
  for (const layer of layers.values()) {
    for (const [f, content] of layer.files) {
      if (!cache.has(f)) cache.set(f, createHash("sha256").update(content, "utf8").digest("hex").slice(0, 16));
    }
  }
  return (file) => cache.get(file) ?? null;
}

export function analyze(repoRoot: string): Analysis {
  const config = loadConfig(repoRoot);
  const sidecar = loadSidecar(repoRoot);
  const claimsById = new Map(sidecar.claims.map((c) => [c.id, c]));

  // 1. read + parse layers
  const layers = new Map<string, LayerData>();
  for (const [name, lc] of Object.entries(config.layers).sort()) {
    const files = collectFiles(repoRoot, lc.paths);
    const atoms: Atom[] = [];
    const groups: Group[] = [];
    if (lc.role !== "verificatory") {
      for (const [file, content] of files) {
        const parsed = parseMarkdownLayer(name, file, content);
        atoms.push(...parsed.atoms);
        groups.push(...parsed.groups);
      }
    }
    layers.set(name, { name, role: lc.role, files, atoms, groups });
  }

  // 2. re-anchor markdown layers against the sidecar (in memory only — UAC §5.1)
  const taken = new Set(sidecar.claims.map((c) => c.id));
  // adjudicating an escalation is the `adjudicate` task class (UAC §16.1); hints are
  // advisory and absent entirely when no routing config binds the class
  const adjudicateHints = hintsFor(config, "adjudicate") ?? {};
  // Fork-review questions the operator has already dismissed are not re-emitted (UAC §7.2).
  const dismissedForks = new Set(sidecar.dismissedForks ?? []);
  const escalations: Escalation[] = [];
  const anchorResults = new Map<string, AnchorResult<Atom>>();
  for (const layer of layers.values()) {
    if (layer.role === "verificatory") continue;
    const prev = sidecar.claims
      .filter((c) => c.layer === layer.name && c.alive)
      .map((c) => ({ id: c.id, norm: c.text, raw: c.text, groupKey: c.groupKey, groupPath: c.groupPath, line: 0 }));
    const rejected = (oldId: string, newNormHash: string) =>
      (claimsById.get(oldId)?.rejectedMatches ?? []).includes(newNormHash);
    const result = anchor(prev, layer.atoms, DEFAULT_ANCHOR_CONFIG, rejected, contentHash);
    anchorResults.set(layer.name, result);
    for (const m of result.matched) m.next.id = m.oldId;
    for (const created of result.created) {
      created.id = mintId(leafOf(created.groupKey), created.norm, taken);
    }

    // reanchor escalations: group unresolved candidate pairs by group path (UAC §7.1)
    const byGroup = new Map<string, typeof result.candidates>();
    for (const cand of result.candidates) {
      const key = cand.newGroupPath || cand.oldGroupPath;
      const arr = byGroup.get(key);
      if (arr) arr.push(cand);
      else byGroup.set(key, [cand]);
    }
    for (const [groupPath, cands] of [...byGroup.entries()].sort()) {
      const deletedIds = [...new Set(cands.map((c) => c.oldId))];
      const createdTexts = [...new Set(cands.map((c) => c.newText))];
      escalations.push({
        id: escalationId("reanchor", groupPath, deletedIds, createdTexts),
        kind: "reanchor",
        groupPath,
        deleted: deletedIds.map((id) => ({ id, text: claimsById.get(id)?.text ?? "" })),
        created: createdTexts.map((text) => {
          const c = cands.find((x) => x.newText === text);
          const atom = layer.atoms.find((a) => a.raw === text);
          return { text, file: atom?.file ?? "", line: c?.newLine ?? 0 };
        }),
        candidates: cands.map((c) => ({ oldId: c.oldId, newText: c.newText, ratio: c.ratio })),
        ...adjudicateHints,
      });
    }
    for (const sm of result.splitMerges) {
      escalations.push({
        id: escalationId("split-merge", sm.subjectGroupPath, [sm.subject], sm.parts.map((p) => p.idOrText)),
        kind: "split-merge",
        groupPath: sm.subjectGroupPath,
        deleted: sm.kind === "split" ? [{ id: sm.subject, text: claimsById.get(sm.subject)?.text ?? "" }] : sm.parts.map((p) => ({ id: p.idOrText, text: claimsById.get(p.idOrText)?.text ?? "" })),
        created: sm.kind === "split" ? sm.parts.map((p) => ({ text: p.idOrText, file: "", line: 0 })) : [{ text: sm.subject, file: "", line: 0 }],
        candidates: sm.parts.map((p) => ({
          oldId: sm.kind === "split" ? sm.subject : p.idOrText,
          newText: sm.kind === "split" ? p.idOrText : sm.subject,
          ratio: p.containment,
        })),
        ...adjudicateHints,
      });
    }
    // fork-review escalations: advisory questions naming a forked group's dead + created atoms
    // (UAC §3.3, §7.1). Suppressed once dismissed for the same dead/created pair (UAC §7.2).
    for (const fork of result.forks) {
      const id = escalationId("fork-review", fork.groupPath, fork.deleted.map((d) => d.id), fork.created.map((c) => c.text));
      if (dismissedForks.has(id)) continue;
      escalations.push({
        id,
        kind: "fork-review",
        groupPath: fork.groupPath,
        deleted: fork.deleted.map((d) => ({ id: d.id, text: d.text })),
        created: fork.created.map((c) => ({ text: c.text, file: layer.atoms.find((a) => a.raw === c.text)?.file ?? "", line: c.line })),
        candidates: [],
        ...adjudicateHints,
      });
    }
  }

  // 3. edges
  const hashOf = fileHasher(layers);
  const sidecarGroups = new Map(sidecar.groups.map((g) => [`${g.layer}:${g.slug}`, g]));
  const verdicts: EdgeVerdict[] = [];
  const orphans: OrphanTag[] = [];
  const unsupportedEdges: string[] = [];
  for (const [a, b] of config.edges) {
    const la = layers.get(a);
    const lb = layers.get(b);
    if (!la || !lb) continue;
    const [source, verif] = la.role === "verificatory" ? [lb, la] : [la, lb];
    if (verif.role !== "verificatory" || source.role === "verificatory") {
      unsupportedEdges.push(`${a}↔${b} (${la.role}↔${lb.role}) — not checkable in v0`);
      continue;
    }
    const verifCfg = config.layers[verif.name];
    if (source.role === "prescriptive") {
      const tags: TagHit[] = scanTags(verif.files, verifCfg?.tagPattern ?? DEFAULT_TAG_PATTERN);
      const r = checkPV([a, b], source.atoms, tags, claimsById, hashOf);
      verdicts.push(...r.verdicts);
      orphans.push(...r.orphans);
    } else {
      const tags = scanSectionTags(verif.files, verifCfg?.sectionTagPattern ?? DEFAULT_SECTION_TAG_PATTERN);
      const r = checkDV([a, b], source.groups, tags, sidecarGroups, hashOf);
      verdicts.push(...r.verdicts);
      orphans.push(...r.orphans);
    }
  }
  verdicts.sort((x, y) => x.edge.join() < y.edge.join() ? -1 : x.edge.join() > y.edge.join() ? 1 : x.subject < y.subject ? -1 : 1);

  // Classify uncovered verdicts against the acknowledged backlog (UAC §3.2, §5.1): a subject
  // snapshotted at the last accept is backlog (acknowledged), any other is new-uncovered.
  const backlogClaims = new Set(sidecar.backlog.claims);
  const backlogSections = new Set(sidecar.backlog.sections);
  for (const v of verdicts) {
    if (v.kind !== "uncovered") continue;
    const srcRole = layers.get(v.edge[0])?.role === "verificatory" ? layers.get(v.edge[1])?.role : layers.get(v.edge[0])?.role;
    const acknowledged = srcRole === "prescriptive" ? backlogClaims.has(v.subject) : backlogSections.has(v.subject);
    if (acknowledged) v.acknowledged = true;
  }

  orphans.sort((x, y) => (x.file + x.line < y.file + y.line ? -1 : 1));
  escalations.sort((x, y) => (x.id < y.id ? -1 : 1));

  // 4. scope (UAC §5.3)
  const syncPoint = findSyncPoint(repoRoot);
  const changedPaths = syncPoint ? changedPathsSince(repoRoot, syncPoint.commit) : [];
  const affectedLayers = new Set<string>();
  for (const [glob, layerNames] of Object.entries(config.pathMap ?? {})) {
    if (changedPaths.some((p) => path.matchesGlob(p, glob))) {
      for (const l of layerNames) affectedLayers.add(l);
    }
  }

  // 5. derived-output freshness (UAC §18.2): regenerate each declared output in memory and
  //    byte-compare with the committed file. A missing file, or any mismatch, is derived-stale.
  const derivedStale: string[] = [];
  for (const d of deriveOutputs(config)) {
    const abs = path.join(repoRoot, d.output);
    const committed = existsSync(abs) ? readFileSync(abs, "utf8") : null;
    let expected: string;
    try {
      expected = generateContent(repoRoot, d);
    } catch {
      // a generator that cannot run leaves the committed file unverifiable → treat as stale
      derivedStale.push(d.name);
      continue;
    }
    if (committed === null || committed !== expected) derivedStale.push(d.name);
  }

  return {
    config,
    sidecar,
    layers,
    verdicts,
    orphans,
    escalations,
    anchorResults,
    syncPoint,
    syncPointMismatch: false, // computed by caller against current serialisation when needed
    scope: syncPoint ? "diff" : "full",
    strict: false, // set by the check action when --strict is passed
    changedPaths,
    affectedLayers: [...affectedLayers].sort(),
    unsupportedEdges,
    derivedStale,
  };
}

/** Build the accepted sidecar from an analysis (UAC §8.2). Pure — caller saves. */
export function buildAcceptedSidecar(repoRoot: string, analysis: Analysis): Sidecar {
  const sha = headSha(repoRoot);
  const hashOf = fileHasher(analysis.layers);
  const old = new Map(analysis.sidecar.claims.map((c) => [c.id, c]));
  const claims: SidecarEntry[] = [];
  const deadIds = new Set<string>();
  for (const r of analysis.anchorResults.values()) for (const id of r.deadIds) deadIds.add(id);

  // verified states from current tags (the tag is the confirmation in v0; running tests is CI's job)
  const verifiedByAtom = new Map<string, VerifiedState[]>();
  const verifiedByGroup = new Map<string, VerifiedState[]>();
  for (const v of analysis.verdicts) {
    if (v.tags.length === 0) continue;
    const layer = analysis.layers.get(v.edge[0])?.role === "verificatory" ? v.edge[1] : v.edge[0];
    const source = analysis.layers.get(layer);
    if (!source) continue;
    const isPV = source.role === "prescriptive";
    const states: VerifiedState[] = v.tags.map((t) => ({
      edge: v.edge,
      claimHash: "", // filled below per subject
      file: t.file,
      targetFileHash: hashOf(t.file) ?? "",
    }));
    if (isPV) verifiedByAtom.set(v.subject, states);
    else verifiedByGroup.set(`${layer}:${v.subject}`, states);
  }

  for (const layer of analysis.layers.values()) {
    if (layer.role === "verificatory") continue;
    for (const atom of layer.atoms) {
      const prev = old.get(atom.id);
      const verified = (verifiedByAtom.get(atom.id) ?? []).map((v) => ({ ...v, claimHash: atom.hash }));
      claims.push({
        id: atom.id,
        layer: layer.name,
        groupPath: atom.groupPath,
        groupKey: atom.groupKey,
        text: atom.norm,
        hash: atom.hash,
        firstSeen: prev?.firstSeen ?? sha,
        lastSeen: sha,
        alive: true,
        ...(prev?.rejectedMatches ? { rejectedMatches: prev.rejectedMatches } : {}),
        verified,
      });
    }
  }
  // dead claims retained (UAC §3.2: never reuse ids)
  for (const c of analysis.sidecar.claims) {
    if (claims.some((x) => x.id === c.id)) continue;
    claims.push({
      ...c,
      alive: false,
      lastText: c.lastText ?? c.text,
      verified: [],
    });
  }

  const groups: SidecarGroup[] = [];
  for (const layer of analysis.layers.values()) {
    if (layer.role !== "descriptive") continue;
    for (const g of layer.groups) {
      const gh = groupHash(g);
      const verified = (verifiedByGroup.get(`${layer.name}:${g.slug}`) ?? []).map((v) => ({ ...v, claimHash: gh }));
      groups.push({ layer: layer.name, slug: g.slug, groupPath: g.groupPath, hash: gh, verified });
    }
  }

  // Snapshot the acknowledged backlog (UAC §3.2, §8.3): the uncovered claim ids and section
  // slugs as of this accept. Coverage debt can only grow deliberately, through an accept.
  const backlogClaims = new Set<string>();
  const backlogSections = new Set<string>();
  for (const v of analysis.verdicts) {
    if (v.kind !== "uncovered") continue;
    const srcRole = analysis.layers.get(v.edge[0])?.role === "verificatory"
      ? analysis.layers.get(v.edge[1])?.role
      : analysis.layers.get(v.edge[0])?.role;
    if (srcRole === "prescriptive") backlogClaims.add(v.subject);
    else backlogSections.add(v.subject);
  }
  const backlog = { claims: [...backlogClaims].sort(), sections: [...backlogSections].sort() };
  return { schemaVersion: 1, claims, groups, backlog };
}
