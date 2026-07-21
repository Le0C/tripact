// The three-way "pact" join (UAC: read-surface). A pure projection over `analysis.verdicts` that
// correlates the prescriptive↔verificatory (spec↔tests) and descriptive↔verificatory (docs↔tests)
// edges on their one shared handle: the test file. A test that tags both `@specs:X` and `@docs:S`
// bridges spec claim X to doc section S, so the triangle is derivable from existing verdicts with
// no new scanning. Advisory only: it never feeds a verdict or the exit code.
//
// Join semantics are test-mediated. The bridge from a claim to a section IS a test that tags both;
// a doc section written for an untested claim has no bridging test and is invisible here. Untested
// claims are not part of the pact (they already surface as `uncovered` on the P↔V edge).

import type { Analysis } from "./engine.js";

export interface PactReport {
  /** Spec claim + doc section(s) + test(s), all bridged by a shared test file. */
  complete: Array<{ claim: string; sections: string[]; tests: string[] }>;
  /** Claim has a test, but no doc section is bridged to it via any of those tests. */
  testedUndocumented: Array<{ claim: string; tests: string[] }>;
  /** Doc sections that are test-covered but reachable from no spec claim. */
  untiedSections: string[];
}

/** Add `value` to the set stored under `key`, creating the set on first use. */
function addTo<K, V>(map: Map<K, Set<V>>, key: K, value: V): void {
  const set = map.get(key);
  if (set) set.add(value);
  else map.set(key, new Set([value]));
}

const sorted = (xs: Iterable<string>): string[] => [...xs].sort();

/**
 * Derive the three-way pact from the analysis. Returns all-empty (with every top-level key present)
 * unless the config declares BOTH a prescriptive↔verificatory and a descriptive↔verificatory edge.
 * Without both, a "documented?" question has no meaning and every tested claim would look
 * undocumented.
 */
export function derivePact(analysis: Analysis): PactReport {
  const roleOf = (name: string) => analysis.layers.get(name)?.role;

  // Classify each declared edge by the role of its non-verificatory endpoint. A checkable edge
  // pairs exactly one verificatory layer with one prescriptive or descriptive layer.
  const nonVerifRole = (edge: [string, string]) => {
    const [ra, rb] = [roleOf(edge[0]), roleOf(edge[1])];
    if (ra === "verificatory" && rb !== "verificatory") return rb;
    if (rb === "verificatory" && ra !== "verificatory") return ra;
    return undefined;
  };

  let hasPV = false;
  let hasDV = false;
  for (const edge of analysis.config.edges) {
    const role = nonVerifRole(edge);
    if (role === "prescriptive") hasPV = true;
    else if (role === "descriptive") hasDV = true;
  }
  if (!hasPV || !hasDV) return { complete: [], testedUndocumented: [], untiedSections: [] };

  const specClaimsWithTests = new Map<string, Set<string>>(); // claim id -> test files tagging it
  const sectionTagsByTest = new Map<string, Set<string>>(); // test file -> section slugs it tags
  const sectionsWithTests = new Map<string, Set<string>>(); // slug -> test files tagging it

  // The join handle is the tag's own line, not its file (UAC §6.4). tripact scans tests as text in
  // any language and has no notion of a test block, so the line is the finest handle it can honestly
  // claim — and since the convention is that tags live in the test's title, one line IS one test.
  //
  // Joining on the file instead would let a single `@docs:` tag anywhere in a file mark every claim
  // tagged in that file as documented, including claims the section never mentions. That is the
  // false-coverage failure this tool exists to prevent, and it would be reporting it about itself.
  const siteOf = (t: { file: string; line: number }) => `${t.file}:${t.line}`;
  const fileOfSite = (site: string) => site.slice(0, site.lastIndexOf(":"));

  for (const v of analysis.verdicts) {
    const role = nonVerifRole(v.edge);
    for (const t of v.tags) {
      if (role === "prescriptive") {
        addTo(specClaimsWithTests, v.subject, siteOf(t));
      } else if (role === "descriptive") {
        addTo(sectionTagsByTest, siteOf(t), v.subject);
        addTo(sectionsWithTests, v.subject, t.file);
      }
    }
  }

  const complete: PactReport["complete"] = [];
  const testedUndocumented: PactReport["testedUndocumented"] = [];
  const reachableSections = new Set<string>();

  for (const claim of sorted(specClaimsWithTests.keys())) {
    const sites = specClaimsWithTests.get(claim) ?? new Set<string>();
    const sections = new Set<string>();
    for (const site of sites) for (const s of sectionTagsByTest.get(site) ?? []) sections.add(s);
    // Reported as files, not sites: the join tightened, the emitted shape did not. A consumer of
    // `tests` still gets the files that tag the claim.
    const tests = sorted(new Set([...sites].map(fileOfSite)));
    if (sections.size > 0) {
      for (const s of sections) reachableSections.add(s);
      complete.push({ claim, sections: sorted(sections), tests });
    } else {
      testedUndocumented.push({ claim, tests });
    }
  }

  const untiedSections = sorted(
    [...sectionsWithTests.keys()].filter((s) => !reachableSections.has(s)),
  );

  return { complete, testedUndocumented, untiedSections };
}
