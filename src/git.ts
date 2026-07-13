// Git integration: sync-point discovery, diff scoping. UAC §5.3, §8.1.

import { spawnSync } from "node:child_process";

export const SYNC_POINT_TRAILER = "Prodsync-Point";

function git(repoRoot: string, args: string[]): { ok: boolean; out: string; err: string } {
  const r = spawnSync("git", args, { cwd: repoRoot, encoding: "utf8" });
  return { ok: r.status === 0, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() };
}

export function isGitRepo(dir: string): boolean {
  return git(dir, ["rev-parse", "--git-dir"]).ok;
}

export function repoRootOf(dir: string): string | null {
  const r = git(dir, ["rev-parse", "--show-toplevel"]);
  return r.ok ? r.out : null;
}

/** Current HEAD sha, or "worktree" before the first commit. */
export function headSha(repoRoot: string): string {
  const r = git(repoRoot, ["rev-parse", "--short", "HEAD"]);
  return r.ok ? r.out : "worktree";
}

export interface SyncPoint {
  commit: string;
  sidecarHash: string;
}

/** Most recent commit carrying a `Prodsync-Point:` trailer (UAC §8.1). */
export function findSyncPoint(repoRoot: string): SyncPoint | null {
  const r = git(repoRoot, [
    "log",
    `--grep=${SYNC_POINT_TRAILER}:`,
    "-1",
    "--format=%H%n%(trailers:key=" + SYNC_POINT_TRAILER + ",valueonly)",
  ]);
  if (!r.ok || !r.out) return null;
  const [commit, ...rest] = r.out.split("\n");
  const value = rest.join("").trim();
  if (!commit || !value) return null;
  return { commit, sidecarHash: value };
}

/** Stage the given paths (UAC §8.5). Returns git's stderr on failure so the caller can report it. */
export function stage(repoRoot: string, paths: string[]): { ok: boolean; err: string } {
  const r = git(repoRoot, ["add", "--", ...paths]);
  return { ok: r.ok, err: r.err };
}

/**
 * Create a commit with the given full message (UAC §8.5). The caller supplies the message body
 * already carrying the `Prodsync-Point:` trailer; this only commits the current index and never
 * stages anything itself. Returns git's stderr on failure (e.g. nothing staged → empty commit).
 */
export function commit(repoRoot: string, message: string): { ok: boolean; err: string } {
  const r = git(repoRoot, ["commit", "-m", message]);
  return { ok: r.ok, err: r.err || r.out };
}

/** Changed paths since a commit (for pathMap narrowing, UAC §5.3). Includes uncommitted changes. */
export function changedPathsSince(repoRoot: string, commit: string): string[] {
  const r = git(repoRoot, ["diff", "--name-only", commit]);
  if (!r.ok) return [];
  return r.out ? r.out.split("\n").filter(Boolean).sort() : [];
}
