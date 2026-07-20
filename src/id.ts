// Human-readable stable claim ids, e.g. "tripact-init.requires-git". UAC §3.2.

import { contentHash } from "./parser.js";

const STOPWORDS = new Set([
  "the", "a", "an", "is", "are", "to", "of", "and", "or", "in", "with", "for",
  "its", "it", "on", "at", "by", "be", "as", "that", "this", "via", "when",
]);

// ASCII assumption (UAC §3.2): `words` keeps only lowercased `[a-z0-9\s-]` and does not
// transliterate. Text with no Latin word characters (a heading in another script) yields an empty
// list, so `baseSlug` falls back to the generic "root"/"atom" parts and the disambiguation pass
// relies on the self-derived suffix for uniqueness, which stays deterministic but leaves the id
// with no mnemonic.
// A future transliteration pass would lift this; the same assumption governs parser.ts `slugify`.
function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

/** The bare slug (group leaf + significant atom words) before any disambiguation. Pure per-atom. */
function baseSlug(groupLeafKey: string, norm: string): string {
  const groupPart = words(groupLeafKey).slice(0, 3).join("-") || "root";
  const significant = words(norm).filter((w) => !STOPWORDS.has(w));
  const textPart = (significant.length ? significant : words(norm)).slice(0, 4).join("-") || "atom";
  return `${groupPart}.${textPart}`;
}

/** The minimum an atom needs to be assigned a stable id. */
interface Mintable {
  id: string;
  groupKey: string;
  norm: string;
}

/**
 * Assign stable, order-independent ids to a batch of newly-created atoms, deduped against `taken`
 * (the ids already persisted in the sidecar). UAC §3.2:
 *
 * A base slug that is unique within the batch AND not already taken is kept **bare**. Any base that
 * collides (with another new atom in the batch, or with an existing id) makes every colliding atom
 * take a suffix derived from its OWN identity (`groupKey + norm`), mirroring parser.ts
 * `disambiguateSlugs`. Because the collision decision is a frequency count over the batch plus a
 * lookup in the pre-existing `taken` set (never a lookup of an id assigned earlier in this same
 * pass), an atom's id depends only on its own identity and the set of atoms present, never on the
 * order they are visited. Adding, removing, or reordering a colliding sibling leaves an
 * already-distinct atom's id untouched.
 *
 * The trailing numeric guard fires only for duplicate claims (byte-identical `norm` in the same
 * group), whose suffixes collide; any assignment among indistinguishable atoms is equivalent.
 * Mutates each atom's `.id` and records it in `taken`.
 */
export function assignIds(created: Mintable[], taken: Set<string>): void {
  const bases = created.map((a) => baseSlug(leafOf(a.groupKey), a.norm));
  const freq = new Map<string, number>();
  for (const b of bases) freq.set(b, (freq.get(b) ?? 0) + 1);
  created.forEach((atom, i) => {
    const base = bases[i] as string;
    const collides = (freq.get(base) ?? 0) > 1 || taken.has(base);
    const id = collides ? `${base}-${contentHash(`${atom.groupKey} ${atom.norm}`).slice(0, 6)}` : base;
    let unique = id;
    let n = 2;
    while (taken.has(unique)) {
      unique = `${id}-${n}`;
      n++;
    }
    atom.id = unique;
    taken.add(unique);
  });
}

/** Leaf (last segment) of a " > "-joined group key. */
export function leafOf(groupKey: string): string {
  const parts = groupKey.split(" > ");
  return parts[parts.length - 1] ?? groupKey;
}
