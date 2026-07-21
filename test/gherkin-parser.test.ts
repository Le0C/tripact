// Gherkin `.feature` parsing → Feature/Rule groups and scenario atoms. UAC §3.5.
//
// The model mirrors the `.sdoc` parser: one construct carries the requirement (the scenario name),
// and everything else is structure or body that must never leak into it.

import { describe, expect, test } from "vitest";

import { parseGherkinLayer, parseLayerFile } from "../src/parser.js";

/** A feature exercising every construct the parser has to tell apart. */
const FEATURE = [
  "@javascript @wip",
  "# language: en",
  "Feature: preview posts in the stream",
  "    In order to test markdown without posting",
  "    As a user",
  "    I want to see a preview of my posts",
  "",
  "    Background:",
  "      Given following users exist:",
  "        | username  | email       |",
  "        | Bob Jones | bob@bob.bob |",
  "      And a user is connected",
  "",
  "    Scenario: preview and post a text-only message",
  "      Given I am on the stream page",
  "      When I write a post",
  "      Then I should see a preview",
  "",
  "    Scenario Outline: preview a post with <kind>",
  "      Given I attach a <kind>",
  "      Then the preview shows it",
  "",
  "      Examples:",
  "        | kind  |",
  "        | photo |",
  "        | video |",
  "",
  "    Example: a Gherkin 6 singular example",
  "      Then it is an atom",
  "",
  "    Scenario:",
  "      Then an unnamed scenario states nothing",
].join("\n");

const parse = (content: string) => parseGherkinLayer("spec", "features/posts.feature", content);

describe("Gherkin parsing (§3.5)", () => {
  test("@specs:gherkin-parsing.gherkin-files-parse-keyword - each scenario contributes one atom, named by the scenario", () => {
    const { atoms } = parse(FEATURE);
    expect(atoms.map((a) => a.raw)).toEqual([
      "preview and post a text-only message",
      "preview a post with <kind>",
      "a Gherkin 6 singular example",
    ]);
  });

  test("@specs:gherkin-parsing.scenario-no-name-contributes - an unnamed scenario contributes no atom", () => {
    const { atoms } = parse(FEATURE);
    expect(atoms.some((a) => a.raw === "")).toBe(false);
    // The bare `Scenario:` at the end of the fixture is the one being dropped.
    expect(atoms).toHaveLength(3);
  });

  test("@specs:gherkin-parsing.step-lines-given-then - step lines never contribute atom text", () => {
    const { atoms } = parse(FEATURE);
    const all = atoms.map((a) => a.raw).join(" | ");
    for (const step of ["Given", "When", "Then", "And", "But"]) expect(all).not.toContain(step);
    expect(all).not.toContain("I should see a preview");
  });

  test("@specs:gherkin-parsing.background-contributes-no-atom - Background is setup, not a requirement", () => {
    const { atoms } = parse(FEATURE);
    expect(atoms.some((a) => /following users exist|Background/i.test(a.raw))).toBe(false);
  });

  test("@specs:gherkin-parsing.examples-tables-data-tables - Examples tables, data rows, tags and comments yield no atoms", () => {
    const { atoms } = parse(FEATURE);
    for (const a of atoms) expect(a.raw).not.toContain("|"); // no table row leaked
    const all = atoms.map((a) => a.raw).join(" ~ ");
    expect(all).not.toContain("photo");
    expect(all).not.toContain("@javascript");
    expect(all).not.toContain("language");
    // `Examples:` must not be mistaken for the singular `Example:` scenario synonym.
    expect(atoms.some((a) => a.raw === "")).toBe(false);
  });

  test("@specs:gherkin-parsing.feature-rule-structural-they - Feature and Rule name the groups and contribute no atoms of their own", () => {
    const { atoms, groups } = parse(FEATURE);
    expect(atoms.some((a) => a.raw.includes("preview posts in the stream"))).toBe(false);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.groupPath).toBe("preview posts in the stream");
    // The Feature's prose description ("As a user", …) is body, not an atom.
    expect(atoms.some((a) => a.raw.startsWith("As a user"))).toBe(false);
  });

  test("@specs:gherkin-parsing.gherkin-atoms-grouped-their - a Rule nests its scenarios under the Feature", () => {
    const { atoms, groups } = parse(
      [
        "Feature: billing",
        "  Scenario: an invoice is issued",
        "    Then it exists",
        "  Rule: refunds",
        "    Scenario: a refund is issued",
        "      Then it exists",
        "    Scenario: a refund is declined",
        "      Then it does not",
      ].join("\n"),
    );
    expect(groups.map((g) => g.groupPath)).toEqual(["billing", "billing > refunds"]);
    expect(atoms.filter((a) => a.groupPath === "billing > refunds")).toHaveLength(2);
    // A new Feature closes an open Rule rather than inheriting it.
    const { groups: g2 } = parse(
      ["Feature: a", "  Rule: r", "    Scenario: one", "Feature: b", "  Scenario: two"].join("\n"),
    );
    expect(g2.map((g) => g.groupPath)).toEqual(["a > r", "b"]);
  });

  test("@specs:gherkin-parsing.docstring-delimited-triple-backticks - a docstring is consumed whole, so a keyword inside content is not read as a scenario", () => {
    for (const fence of ['"""', "```"]) {
      const { atoms } = parse(
        [
          "Feature: docs",
          "  Scenario: the real one",
          "    Given a payload",
          `      ${fence}`,
          "      Scenario: not a scenario, this is example content",
          "      Feature: nor this",
          `      ${fence}`,
          "    Then it parses",
        ].join("\n"),
      );
      expect(atoms.map((a) => a.raw)).toEqual(["the real one"]);
    }
  });

  test("@specs:gherkin-parsing.feature-file-uses-gherkin - dispatch sends .feature to the Gherkin parser, case-insensitively", () => {
    const src = ["Feature: f", "  Scenario: s", "    Then t"].join("\n");
    expect(parseLayerFile("spec", "a/b.feature", src).atoms.map((a) => a.raw)).toEqual(["s"]);
    expect(parseLayerFile("spec", "a/B.FEATURE", src).atoms.map((a) => a.raw)).toEqual(["s"]);
    // The same content as markdown finds nothing — which is exactly the diaspora trial result, and
    // why this needed a parser rather than a glob.
    expect(parseLayerFile("spec", "a/b.md", src).atoms).toHaveLength(0);
  });

  test("@specs:gherkin-parsing.gherkin-files-parse-keyword - parsing is deterministic and ids anchor on the scenario name", () => {
    const a = parse(FEATURE);
    const b = parse(FEATURE);
    expect(a.atoms.map((x) => x.hash)).toEqual(b.atoms.map((x) => x.hash));
    // Renaming a scenario changes its hash; reordering the file does not change a kept scenario's.
    const renamed = parse(FEATURE.replace("preview and post a text-only message", "post a text message"));
    expect(renamed.atoms[0]!.hash).not.toBe(a.atoms[0]!.hash);
    expect(renamed.atoms[1]!.hash).toBe(a.atoms[1]!.hash);
  });
});
