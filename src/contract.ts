// The kernel's public contract (docs/architecture/public-contract.md). These are the machine-
// readable documents any foreign harness (the reference CLI, an Archon workflow, a Spec Kit
// extension, a GitHub Action) reads to drive tripact without understanding claims, hashes, or
// re-anchoring. They are the kernel's API, and they are versioned deliberately: this file is the
// single source of truth for the schema versions.
//
// Kernel/harness boundary: this module is kernel and imports nothing, just constants describing
// the surface. The builders (report.ts, tasks.ts, claims.ts, escalation.ts) stamp these versions;
// because the MCP read tools return those builder documents verbatim (see src/mcp.ts), versioning
// the builders versions the MCP surface at the same time.
//
// Compatibility policy (semantic-versioning of the payload shape):
//   - ADDITIVE change (a new top-level field) is backward-compatible; consumers that ignore unknown
//     fields keep working. It does NOT bump the version, but it DOES update the surface's `fields`
//     list below (and the shape-pin test enforces that the two stay in step).
//   - BREAKING change (removing/renaming a field, or changing the meaning or type of an existing
//     one) bumps the surface's schema version. Bumping requires updating both the constant here and
//     the corresponding interface literal (e.g. `schemaVersion: 1` in report.ts), so the type
//     checker forces both edits and a version event always lands in the diff.
// The 0/1/2 exit-code convention (0 level, 1 drift, 2 usage/environment error) is part of the same
// contract and is exercised by test/machine-readability.test.ts.

/** `check` / `status` → CheckReportJson (src/report.ts). */
export const CHECK_SCHEMA_VERSION = 1;

/** `tasks` → TaskQueue (src/tasks.ts). */
export const TASKS_SCHEMA_VERSION = 1;

/** `claims` → ClaimsReportJson (src/claims.ts). */
export const CLAIMS_SCHEMA_VERSION = 1;

/** `escalations` (MCP) / `.tripact/escalations.json` → EscalationFile (src/escalation.ts). */
export const ESCALATIONS_SCHEMA_VERSION = 1;

/** `reconcile` → ReconcileReport (src/reconcile.ts). Propose-only; advisory (never exit 1). */
export const RECONCILE_SCHEMA_VERSION = 1;

/** `hotlinks` → HotlinksReport (src/hotlinks.ts). Navigational code↔spec links; advisory (never exit 1). */
export const HOTLINKS_SCHEMA_VERSION = 1;

/** `audit <claim-id>` → AuditReport (src/audit.ts). Advisory (never exit 1). Not a PUBLIC_CONTRACT
 * surface: like `resolve` and `verify` it takes an argument, so there is no argument-free
 * invocation for the shape-pin test to drive. The version constant still lives here so a bump is
 * a deliberate contract event. */
export const AUDIT_SCHEMA_VERSION = 1;

/** One public read surface: the same document under one or more CLI `--json` commands and MCP tools. */
export interface ContractSurface {
  /** Stable identifier for the surface. */
  readonly key: "check" | "tasks" | "claims" | "escalations" | "reconcile" | "hotlinks";
  /** CLI invocations (beyond the leading command) that emit this exact document; all share the schema. */
  readonly cli: readonly (readonly string[])[];
  /** MCP read tools that return this document verbatim (byte-identical to the CLI `--json`). */
  readonly mcpTools: readonly string[];
  /** The schema version carried in the payload's `schemaVersion`. */
  readonly schemaVersion: number;
  /** Guaranteed top-level keys, sorted. Adding or removing one is a contract event (see policy above). */
  readonly fields: readonly string[];
}

/**
 * The formal manifest of the kernel's public read contract. Consumed by
 * test/public-contract.test.ts, which runs each CLI surface and asserts the live payload's
 * `schemaVersion` and top-level key set match what is declared here, so any drift between the code
 * and this contract fails the build and forces a deliberate version decision.
 */
export const PUBLIC_CONTRACT: readonly ContractSurface[] = [
  {
    key: "check",
    cli: [["check", "--json"], ["status", "--json"]],
    mcpTools: ["check", "status"],
    schemaVersion: CHECK_SCHEMA_VERSION,
    fields: [
      "affectedLayers",
      "blockStale",
      "changedPaths",
      "counts",
      "derivedStale",
      "escalations",
      "excludedAtoms",
      "exitCode",
      "nonDeterministicGenerators",
      "orphans",
      "pact",
      "schemaVersion",
      "scope",
      "shellGeneratorsWithheld",
      "suspiciousAtoms",
      "syncPoint",
      "unsupportedEdges",
      "vacuous",
      "verdicts",
      "zeroAtomLayers",
      "zeroFileLayers",
    ],
  },
  {
    key: "tasks",
    cli: [["tasks", "--json"]],
    mcpTools: ["tasks"],
    schemaVersion: TASKS_SCHEMA_VERSION,
    fields: ["schemaVersion", "tasks"],
  },
  {
    key: "claims",
    cli: [["claims", "--json"]],
    mcpTools: ["claims"],
    schemaVersion: CLAIMS_SCHEMA_VERSION,
    fields: ["claims", "schemaVersion"],
  },
  {
    key: "reconcile",
    cli: [["reconcile", "--json"]],
    mcpTools: [],
    schemaVersion: RECONCILE_SCHEMA_VERSION,
    fields: ["candidates", "schemaVersion", "trustedFields"],
  },
  {
    key: "hotlinks",
    cli: [["hotlinks", "--json"]],
    mcpTools: [],
    schemaVersion: HOTLINKS_SCHEMA_VERSION,
    fields: ["links", "orphans", "schemaVersion"],
  },
  {
    key: "escalations",
    // No dedicated read command: the document `check` writes to .tripact/escalations.json, exposed
    // over MCP as the `escalations` read tool. Pinned via that file / tool rather than a `--json` flag.
    cli: [],
    mcpTools: ["escalations"],
    schemaVersion: ESCALATIONS_SCHEMA_VERSION,
    fields: ["questions", "schemaVersion"],
  },
];
