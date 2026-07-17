// Git integration: sync-point discovery, diff scoping. UAC §5.3, §8.1.

import { spawnSync } from "node:child_process";

export const SYNC_POINT_TRAILER = "tripact-sync-id";

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

/** Most recent commit carrying a real `tripact-sync-id:` trailer (UAC §8.1). `--grep` narrows to
 * commits whose message *mentions* the string, but a commit that only names it in prose (no actual
 * trailer) yields an empty trailer value — so we scan the newest matches and return the first with a
 * genuine trailer, rather than stopping at `-1` and masking an older real sync-point. */
export function findSyncPoint(repoRoot: string): SyncPoint | null {
  const r = git(repoRoot, [
    "log",
    `--grep=${SYNC_POINT_TRAILER}:`,
    "-n",
    "20",
    "--format=%H%x1f%(trailers:key=" + SYNC_POINT_TRAILER + ",valueonly)%x1e",
  ]);
  if (!r.ok || !r.out) return null;
  for (const record of r.out.split("\x1e")) {
    const [commit, value] = record.split("\x1f");
    const c = (commit ?? "").trim();
    const v = (value ?? "").trim();
    if (c && v) return { commit: c, sidecarHash: v };
  }
  return null;
}

/** Stage the given paths (UAC §8.5). Returns git's stderr on failure so the caller can report it. */
export function stage(repoRoot: string, paths: string[]): { ok: boolean; err: string } {
  const r = git(repoRoot, ["add", "--", ...paths]);
  return { ok: r.ok, err: r.err };
}

/**
 * Create a commit with the given full message (UAC §8.5). The caller supplies the message body
 * already carrying the `tripact-sync-id:` trailer; this only commits the current index and never
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

/** One commit as audit evidence (UAC §21.1). `date` is the author date, strict ISO 8601. */
export interface CommitInfo {
  sha: string;
  shortSha: string;
  author: string;
  date: string;
  subject: string;
  /** `tripact-sync-id` trailer value, empty when the commit carries none. */
  syncId: string;
}

const COMMIT_FORMAT = `%H%x1f%h%x1f%an%x1f%aI%x1f%s%x1f%(trailers:key=${SYNC_POINT_TRAILER},valueonly)%x1e`;

function parseCommits(out: string): CommitInfo[] {
  const commits: CommitInfo[] = [];
  for (const record of out.split("\x1e")) {
    const [sha, shortSha, author, date, subject, syncId] = record.split("\x1f");
    if (!sha?.trim()) continue;
    commits.push({
      sha: sha.trim(),
      shortSha: (shortSha ?? "").trim(),
      author: (author ?? "").trim(),
      date: (date ?? "").trim(),
      subject: (subject ?? "").trim(),
      syncId: (syncId ?? "").trim(),
    });
  }
  return commits;
}

/** Commits that touched `relPath` (file or directory), newest first (UAC §21.1). */
export function commitsTouching(repoRoot: string, relPath: string): CommitInfo[] {
  const r = git(repoRoot, ["log", `--format=${COMMIT_FORMAT}`, "--", relPath]);
  if (!r.ok || !r.out) return [];
  return parseCommits(r.out);
}

/** Content of `relPath` as committed at `sha`, or null when absent from that tree. */
export function fileAtCommit(repoRoot: string, sha: string, relPath: string): string | null {
  const r = spawnSync("git", ["show", `${sha}:${relPath}`], { cwd: repoRoot, encoding: "utf8" });
  return r.status === 0 ? (r.stdout ?? "") : null;
}
