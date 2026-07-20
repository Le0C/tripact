// Generator resolution and extension (UAC §18.4): how a generator string picks a registry, who may
// register what, and the `presets-table` builtin.
//
// The prefixes exist to stop a silent capture. With bare-name precedence, a harness that later
// registered `make` would take over every config whose generator was the shell command `make`,
// changing what gets built with nothing at the call site to show it.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  CLI_REFERENCE,
  generateContent,
  GenerateError,
  HOTLINK_MAP,
  PRESETS_TABLE,
  registerGenerator,
  TASK_CLASSES,
  registerHarnessGenerator,
  RESERVED_BUILTINS,
  resolveGenerator,
} from "../src/derived.js";
import { KNOWN_TASK_CLASSES } from "../src/config.js";
import { renderPresetsTable, SPEC_SYSTEM_PRESETS } from "../src/presets.js";
import { renderTaskClasses } from "../src/tasks.js";
import { runCli } from "./helpers/cli.js";

const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

describe("generator resolution (UAC §18.4)", () => {
  it("a builtin:, harness: and shell: prefix pick different tiers, and an unprefixed string picks none", () => {
    // Implements @specs:generator-resolution-and.generator-string-prefixed-builtin
    expect(resolveGenerator("builtin:presets-table")).toEqual({ kind: "builtin", name: "presets-table" });
    expect(resolveGenerator("harness:changelog")).toEqual({ kind: "harness", name: "changelog" });
    expect(resolveGenerator("shell:node scripts/x.js")).toEqual({ kind: "shell", name: "node scripts/x.js" });
    // An unprefixed string resolves to no tier at all, which is what makes it a config error rather
    // than a silent trip into the shell.
    expect(resolveGenerator("node scripts/x.js")).toEqual({ kind: "unknown", name: "node scripts/x.js" });
    // The capture this design exists to prevent: `shell:make` stays the build tool even once a
    // harness has registered a generator by that name.
    registerHarnessGenerator("make", () => "not the build tool");
    expect(resolveGenerator("shell:make")).toEqual({ kind: "shell", name: "make" });
  });

  it("the bare reserved names still resolve to their builtins", () => {
    // Implements @specs:generator-resolution-and.bare-reserved-names-cli-reference
    expect(resolveGenerator(CLI_REFERENCE)).toEqual({ kind: "builtin", name: CLI_REFERENCE });
    expect(resolveGenerator(HOTLINK_MAP)).toEqual({ kind: "builtin", name: HOTLINK_MAP });
  });

  it("the builtin namespace is closed and a harness may not shadow it", () => {
    // Implements @specs:generator-resolution-and.kernel-builtin-namespace-closed
    expect(() => registerGenerator("not-reserved", () => "")).toThrow(/unknown builtin generator/);
    for (const reserved of RESERVED_BUILTINS) {
      expect(() => registerHarnessGenerator(reserved, () => "")).toThrow(/reserved kernel builtin/);
    }
    // Any name a builtin does not hold is open to a harness.
    expect(() => registerHarnessGenerator("changelog", () => "ok")).not.toThrow();
  });

  it("a builtin or harness generator renders in-process and spawns nothing", () => {
    // Implements @specs:generator-resolution-and.builtin-harness-generator-renders
    // A shell command would have to exist on PATH; this one does not, and rendering still succeeds,
    // which is only possible if no subprocess was involved.
    registerHarnessGenerator("in-process", () => "rendered without a shell");
    const out = generateContent(process.cwd(), {
      name: "probe",
      output: "probe.md",
      generator: "harness:in-process",
    });
    expect(out).toBe("rendered without a shell");
  });

  it("a generator receives the repo root, its name, and a block region's file and line", () => {
    // Implements @specs:generator-resolution-and.builtin-harness-generators-receive
    registerHarnessGenerator("echo-ctx", (ctx) => JSON.stringify(ctx));
    const whole = JSON.parse(
      generateContent("/tmp/root", { name: "whole", output: "o.md", generator: "harness:echo-ctx" }),
    );
    expect(whole).toEqual({ root: "/tmp/root", name: "whole" });
    // Filling a block adds the region's location; a whole-file output has none to report.
    const inBlock = JSON.parse(
      generateContent(
        "/tmp/root",
        { name: "blocky", output: "DOC.md", generator: "harness:echo-ctx" },
        { file: "DOC.md", line: 12 },
      ),
    );
    expect(inBlock).toEqual({ root: "/tmp/root", name: "blocky", file: "DOC.md", line: 12 });
  });

  it("an unregistered builtin or harness name is a wiring error, not a shell command", () => {
    expect(() =>
      generateContent(process.cwd(), { name: "x", output: "o.md", generator: "harness:never-registered" }),
    ).toThrow(GenerateError);
    // cli-reference is reserved but implemented by a driving harness, so the kernel alone cannot render it.
    expect(() =>
      generateContent(process.cwd(), { name: "x", output: "o.md", generator: CLI_REFERENCE }),
    ).toThrow(GenerateError);
  });
});

describe("the presets-table builtin (UAC §18.4)", () => {
  it("renders every registered preset as a markdown table, so docs follow the registry", () => {
    // Implements @specs:generator-resolution-and.kernel-provides-presets-table-builtin
    const table = renderPresetsTable();
    const rows = table.split("\n");
    // Header, separator, then one row per preset. No preset can be left out by hand.
    expect(rows).toHaveLength(Object.keys(SPEC_SYSTEM_PRESETS).length + 2);
    for (const preset of Object.values(SPEC_SYSTEM_PRESETS)) {
      expect(table).toContain(`\`${preset.name}\``);
      expect(table).toContain(preset.label);
      expect(table).toContain(preset.declares);
    }
    // `cursor` is the preset that was shipped with tests and never reached the README. It cannot
    // go missing again without this failing.
    expect(table).toContain("`cursor`");
    // Every row is padded to the same width, so the committed markdown reads as a table in source.
    expect(new Set(rows.map((r) => r.length)).size).toBe(1);
    expect(PRESETS_TABLE).toBe("presets-table");
  });

  it("is deterministic across runs", () => {
    expect(renderPresetsTable()).toBe(renderPresetsTable());
  });

  it("the task-classes builtin renders every routable class as a bullet list", () => {
    // Implements @specs:generator-resolution-and.kernel-provides-task-classes-builtin
    const list = renderTaskClasses();
    const rows = list.split("\n");
    expect(rows).toHaveLength(KNOWN_TASK_CLASSES.length);
    for (const c of KNOWN_TASK_CLASSES) expect(list).toContain(`- \`${c}\``);
    // Bullets at column 0, which is what makes this the projection that exercises the parser skip:
    // an unskipped region here would mint one claim per generated class.
    expect(rows.every((r) => r.startsWith("- "))).toBe(true);
    expect(renderTaskClasses()).toBe(list);
    expect(TASK_CLASSES).toBe("task-classes");
  });

  it("fills a block region end to end through the CLI", () => {
    const repo = mkdtempSync(path.join(os.tmpdir(), "tripact-presets-block-"));
    scratch.push(repo);
    execFileSync("git", ["init", "-b", "main"], { cwd: repo });
    writeFileSync(path.join(repo, "SPECS.md"), "# Spec\n\n## One\n\n- a claim\n");
    mkdirSync(path.join(repo, "tests"), { recursive: true });
    writeFileSync(path.join(repo, "tests", "a.test.ts"), 'test("x", () => {});\n');
    writeFileSync(path.join(repo, "DOC.md"), "# Doc\n\n<!-- tripact:presets-table -->\n<!-- /tripact:presets-table -->\n");
    writeFileSync(
      path.join(repo, "tripact.yaml"),
      [
        "schemaVersion: 1",
        "layers:",
        "  spec:",
        "    role: prescriptive",
        "    paths: [SPECS.md]",
        "  tests:",
        "    role: verificatory",
        "    paths: [tests/**/*.test.ts]",
        "edges:",
        "  - [spec, tests]",
        "blocks:",
        "  paths: [DOC.md]",
        "  generators:",
        "    presets-table: builtin:presets-table",
        "",
      ].join("\n"),
    );
    expect(runCli(["generate"], { cwd: repo }).status).toBe(0);
    const doc = readFileSync(path.join(repo, "DOC.md"), "utf8");
    expect(doc).toContain("| `cursor`");
    expect(doc).toContain("<!-- tripact:presets-table -->");
    // The region is now fresh, so the block contributes no drift.
    const json = JSON.parse(runCli(["check", "--json"], { cwd: repo }).stdout);
    expect(json.blockStale).toEqual([]);
  });
});
