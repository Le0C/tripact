// tripact — the deterministic traceability kernel, as an importable library.
//
// This barrel is the package's public entry (`import { analyze, toJsonReport, deriveTasks } from
// "tripact"`). It re-exports the kernel modules: parsing, claim identity and re-anchoring, edge
// verdicts, the drift report, the work queue, the claim listing, escalation/resolve, acceptance
// diffing, the sidecar, and the versioned public contract. The CLI (program.ts / cli.ts) and the
// MCP server are the binary surface and are not part of this barrel, except that buildServer /
// serveMcp are exported so a foreign harness can embed the MCP server directly.
//
// The whole surface is deterministic and does no network I/O — that is what makes it embeddable.
export * from "./anchor.js";
export * from "./audit.js";
export * from "./claims.js";
export * from "./config.js";
export * from "./contract.js";
export * from "./derived.js";
export * from "./diff.js";
export * from "./edges/dv.js";
export * from "./edges/pv.js";
export * from "./engine.js";
export * from "./escalation.js";
export * from "./git.js";
export * from "./hotlinks.js";
export * from "./id.js";
export * from "./parser.js";
export * from "./reconcile.js";
export * from "./report.js";
export * from "./sidecar.js";
export * from "./similarity.js";
export * from "./skills.js";
export * from "./tasks.js";
export * from "./types.js";
export * from "./version.js";
export { buildServer, serveMcp, type ServerIdentity } from "./mcp.js";
