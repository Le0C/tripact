// Minimal, deterministic glob matching for repo-relative POSIX paths (UAC §5.3). Used for pathMap
// narrowing and layer `exclude` so the kernel carries no dependency on `path.matchesGlob`, which is
// experimental and absent before Node 22.5 (the declared engines floor is >=22). Pure string work:
// no filesystem access, so it matches paths that no longer exist on disk (e.g. deletions in a diff).
//
// Supported syntax: `**` (any run of characters incl. `/`), `*` (any run of non-`/`), `?` (one
// non-`/`), and literals. `a/**/b` also matches `a/b` (the `**/` collapses to nothing).

/** Compile a glob to an anchored RegExp. Deterministic: same glob always yields the same source. */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] as string;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i++; // consume the second `*`
        if (glob[i + 1] === "/") {
          i++; // consume the `/` so `a/**/b` matches `a/b` as well as `a/x/b`
          re += "(?:.*/)?";
        } else {
          re += ".*";
        }
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${re}$`);
}

/** True when repo-relative POSIX path `p` matches `glob`. */
export function matchesGlob(p: string, glob: string): boolean {
  return globToRegExp(glob).test(p);
}
