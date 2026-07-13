// Human-readable stable claim ids, e.g. "prodsync-init.requires-git". UAC §3.2.

const STOPWORDS = new Set([
  "the", "a", "an", "is", "are", "to", "of", "and", "or", "in", "with", "for",
  "its", "it", "on", "at", "by", "be", "as", "that", "this", "via", "when",
]);

function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

/** Deterministic slug id from group leaf + atom text; deduped against `taken`. */
export function mintId(groupLeafKey: string, norm: string, taken: Set<string>): string {
  const groupPart = words(groupLeafKey).slice(0, 3).join("-") || "root";
  const significant = words(norm).filter((w) => !STOPWORDS.has(w));
  const textPart = (significant.length ? significant : words(norm)).slice(0, 4).join("-") || "atom";
  const base = `${groupPart}.${textPart}`;
  let id = base;
  let i = 2;
  while (taken.has(id)) {
    id = `${base}-${i}`;
    i++;
  }
  taken.add(id);
  return id;
}

/** Leaf (last segment) of a " > "-joined group key. */
export function leafOf(groupKey: string): string {
  const parts = groupKey.split(" > ");
  return parts[parts.length - 1] ?? groupKey;
}
