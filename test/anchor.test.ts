// Re-anchoring cascade semantics. UAC §3.3.
// @specs:re-anchoring.artefacts-change-atoms-re-matched
// @specs:re-anchoring.match-above-auto-accept-threshold
// @specs:re-anchoring.containment-pass-matches-atom
// @specs:re-anchoring.one-atom-matching-several
// @specs:re-anchoring.unmatched-new-atoms-receive
import { describe, expect, it } from "vitest";
import { anchor, DEFAULT_ANCHOR_CONFIG, type AnchorAtom } from "../src/anchor.js";
import { normalizeText } from "../src/parser.js";

let line = 0;
function atom(id: string, norm: string, groupKey = "g"): AnchorAtom {
  line += 1;
  return { id, norm, raw: norm, groupKey, groupPath: groupKey, line };
}
/** Build an atom from raw prose, normalising it the way the real pipeline does. */
function prose(id: string, raw: string, groupKey = "g"): AnchorAtom {
  line += 1;
  return { id, norm: normalizeText(raw), raw, groupKey, groupPath: groupKey, line };
}

describe("anchor cascade", () => {
  it("a1: exact match within group survives reordering", () => {
    const prev = [atom("one", "alpha beta gamma"), atom("two", "delta epsilon zeta")];
    const next = [atom("", "delta epsilon zeta"), atom("", "alpha beta gamma")];
    const r = anchor(prev, next, DEFAULT_ANCHOR_CONFIG);
    expect(r.matched.map((m) => m.oldId).sort()).toEqual(["one", "two"]);
    expect(r.candidates).toHaveLength(0);
    expect(r.created).toHaveLength(0);
  });

  it("a2: exact match across groups records a move", () => {
    const prev = [atom("one", "the user can export results as csv", "section a")];
    const next = [atom("", "the user can export results as csv", "section b")];
    const r = anchor(prev, next, DEFAULT_ANCHOR_CONFIG);
    expect(r.matched[0]!.oldId).toBe("one");
    expect(r.matched[0]!.moved).toBe(true);
  });

  it("auto-accepts high-similarity rewording (>= 0.9)", () => {
    const prev = [atom("one", "user can log out via the sign out link in the sidebar")];
    const next = [atom("", "user can log out via the sign out link in the side bar")];
    const r = anchor(prev, next, DEFAULT_ANCHOR_CONFIG);
    expect(r.matched[0]!.oldId).toBe("one");
    expect(r.matched[0]!.reworded).toBe(true);
    expect(r.candidates).toHaveLength(0);
  });

  it("escalates sub-0.9 similarity instead of silently linking", () => {
    // ratio ≈ 0.727 — inside the candidate band [0.65, 0.9)
    const prev = [atom("one", "addnumbers returns the sum of two integer inputs")];
    const next = [atom("", "addnumbers computes the total of two integer values")];
    const r = anchor(prev, next, DEFAULT_ANCHOR_CONFIG);
    expect(r.matched).toHaveLength(0);
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0]!.oldId).toBe("one");
    expect(r.candidates[0]!.ratio).toBeLessThan(0.9);
  });

  it("containment pass: old text preserved verbatim inside an extension", () => {
    const old = "the top of the rail shows a reconstruction data-status indicator";
    const extended = old + " which lists each reconstruction with its processing state and refresh time";
    const prev = [atom("one", old)];
    const next = [atom("", extended)];
    const r = anchor(prev, next, DEFAULT_ANCHOR_CONFIG);
    expect(r.matched).toHaveLength(1);
    expect(r.matched[0]!.pass).toBe("e");
  });

  it("detects splits and never auto-resolves them", () => {
    const prev = [atom("one", "on invalid credentials or server error, an error toast is displayed")];
    const next = [
      atom("", "on invalid credentials (400), a toast error message is displayed"),
      atom("", "on server error, a generic error toast is displayed"),
    ];
    const r = anchor(prev, next, DEFAULT_ANCHOR_CONFIG);
    expect(r.matched).toHaveLength(0);
    expect(r.splitMerges.some((s) => s.kind === "split" && s.subject === "one")).toBe(true);
  });

  it("unmatched atoms fork identity: created + dead, no guessing", () => {
    const prev = [atom("one", "completely unrelated old requirement about detectors")];
    const next = [atom("", "a brand new requirement about exports")];
    const r = anchor(prev, next, DEFAULT_ANCHOR_CONFIG);
    expect(r.matched).toHaveLength(0);
    expect(r.deadIds).toEqual(["one"]);
    expect(r.created).toHaveLength(1);
  });

  it("a group that loses an unmatched atom and gains one forks — advisory fork-review @specs:re-anchoring.group-one-transition-loses", () => {
    // Sub-0.65 reword in the same group: no candidate, no split/merge → silent identity fork.
    const prev = [prose("one", "the dashboard shows a bar chart of weekly active users")];
    const next = [prose("", "operators can export the full audit log as a signed csv file")];
    const r = anchor(prev, next, DEFAULT_ANCHOR_CONFIG);
    expect(r.candidates).toHaveLength(0);
    expect(r.splitMerges).toHaveLength(0);
    expect(r.forks).toHaveLength(1);
    expect(r.forks[0]!.deleted.map((d) => d.id)).toEqual(["one"]);
    expect(r.forks[0]!.created[0]!.text).toContain("audit log");
    // Still recorded as dead + created — the fork question is additive, not a re-link.
    expect(r.deadIds).toEqual(["one"]);
    expect(r.created).toHaveLength(1);
  });

  it("dead + created in DIFFERENT (non-aligning) groups is not a fork", () => {
    const prev = [prose("one", "the dashboard shows a bar chart of weekly active users", "rendering")];
    const next = [prose("", "operators can export the full audit log as a signed csv file", "data exports")];
    const r = anchor(prev, next, DEFAULT_ANCHOR_CONFIG);
    expect(r.forks).toHaveLength(0);
    expect(r.deadIds).toEqual(["one"]);
    expect(r.created).toHaveLength(1);
  });

  it("a candidate-paired reword is a reanchor question, never a fork", () => {
    // ratio ≈ 0.73 ∈ [0.65, 0.9): a visible reanchor candidate, so not a silent fork.
    const prev = [prose("one", "addNumbers returns the sum of two integer inputs")];
    const next = [prose("", "addNumbers computes the total of two integer values")];
    const r = anchor(prev, next, DEFAULT_ANCHOR_CONFIG);
    expect(r.candidates).toHaveLength(1);
    expect(r.forks).toHaveLength(0);
  });

  it("a ~250-char atom reworded ~15% escalates or matches — never forks on length @specs:re-anchoring.similarity-computed-autojunk-disabled", () => {
    const base =
      "The reconstruction rail lists every scan in the current project together with its processing state, the muon count captured so far, the elapsed acquisition time, and a refresh control that re-fetches the latest status from the control unit without reloading the whole page";
    const reword =
      "The reconstruction sidebar lists each scan in the active project together with its processing state, the muon total captured so far, the elapsed acquisition duration, and a refresh button that re-fetches the latest status from the control unit without reloading the entire page";
    expect(normalizeText(base).length).toBeGreaterThan(200);
    const prev = [prose("one", base)];
    const next = [prose("", reword)];
    const r = anchor(prev, next, DEFAULT_ANCHOR_CONFIG);
    // Autojunk off (measured ratio ≈ 0.90): the atom auto-matches or escalates, but NEVER forks.
    // (With autojunk on it scored ~0.58 and forked — the ceiling this round removed.)
    expect(r.forks).toHaveLength(0);
    expect(r.matched.length + r.candidates.length).toBeGreaterThanOrEqual(1);
  });

  it("respects rejected pairs from resolve --new", () => {
    const prev = [atom("one", "addnumbers returns the sum of two integer inputs")];
    const next = [atom("", "addnumbers computes the total of two integer values")];
    const rejected = () => true;
    const r = anchor(prev, next, DEFAULT_ANCHOR_CONFIG, rejected, (s) => s);
    expect(r.candidates).toHaveLength(0);
    expect(r.deadIds).toEqual(["one"]);
    expect(r.created).toHaveLength(1);
  });
});
