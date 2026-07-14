// MCP stdio server. UAC §16.2. Loaded lazily by the `mcp-serve` command only, so no
// other command ever touches the SDK. Stdio transport exclusively — no socket is
// opened and no network I/O happens (UAC Cross-Cutting: Determinism).
//
// Every read tool returns EXACTLY the JSON document the corresponding CLI `--json`
// flag prints — same builders (toJsonReport, listClaims, deriveTasks), same
// serialisation. `resolve` is always a write tool; `accept` is exposed only when the
// configured accept policy is `agents`, and is absent under `human` (UAC §16.2).

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { listClaims } from "./claims.js";
import { acceptPolicy, ConfigError, loadConfig } from "./config.js";
import { ESCALATIONS_SCHEMA_VERSION } from "./contract.js";
import { computeAcceptanceDelta, renderDeltaHuman } from "./diff.js";
import { analyze, buildAcceptedSidecar, type Analysis } from "./engine.js";
import {
  resolve as applyResolution,
  ResolveError,
  writeEscalations,
  type EscalationFile,
  type Resolution,
} from "./escalation.js";
import { SYNC_POINT_TRAILER } from "./git.js";
import { toJsonReport } from "./report.js";
import { saveSidecar, sidecarContentHash } from "./sidecar.js";
import { deriveTasks } from "./tasks.js";
import { TRIPACT_VERSION } from "./version.js";

/**
 * How the MCP server names itself in the initialize handshake. Defaults to tripact's own identity;
 * a harness embedding the kernel (e.g. a harness serving `mcp-serve`) passes its own name/version so
 * the server advertises under the harness the operator actually invoked.
 */
export interface ServerIdentity {
  name?: string;
  version?: string;
}

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

/** Serialise exactly as the CLI does: `JSON.stringify(doc, null, 2)`. */
function jsonDoc(doc: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(doc, null, 2) }] };
}

function errorResult(message: string): ToolResult {
  return { content: [{ type: "text", text: `tripact: ${message}` }], isError: true };
}

/** Runs a handler, converting known tripact errors into MCP tool errors. */
function guarded(fn: () => ToolResult): ToolResult {
  try {
    return fn();
  } catch (e) {
    if (e instanceof ConfigError || e instanceof ResolveError) return errorResult(e.message);
    throw e;
  }
}

export function buildServer(repoRoot: string, identity: ServerIdentity = {}): McpServer {
  const server = new McpServer({
    name: identity.name ?? "tripact",
    version: identity.version ?? TRIPACT_VERSION,
  });

  server.registerTool(
    "tasks",
    {
      description:
        "Derive the repair/generation work queue from the current repository state — the same JSON `tripact tasks --json` prints. Each task's payload is self-contained; tasks may carry advisory `effort`/`model` dispatch hints when the config binds them. Optionally pass a reconcile pair to also emit a layer-reconciliation task.",
      inputSchema: {
        reconcile: z
          .string()
          .optional()
          .describe('Optional "<prescriptive-layer>:<descriptive-layer>" pair, e.g. "uac:manual"'),
      },
    },
    ({ reconcile }) =>
      guarded(() => {
        const analysis = analyze(repoRoot);
        let pair: { prescriptive: string; descriptive: string } | undefined;
        if (reconcile !== undefined) {
          const [p, d] = reconcile.split(":");
          if (!p || !d) return errorResult('reconcile expects "<prescriptive-layer>:<descriptive-layer>"');
          if (!analysis.layers.has(p) || !analysis.layers.has(d)) {
            return errorResult(
              `reconcile: unknown layer in "${reconcile}" (declared: ${[...analysis.layers.keys()].join(", ")})`,
            );
          }
          pair = { prescriptive: p, descriptive: d };
        }
        return jsonDoc(deriveTasks(analysis, pair));
      }),
  );

  server.registerTool(
    "claims",
    {
      description:
        "List every alive claim with id, layer, group path, normalised text, and best edge verdict — the same JSON `tripact claims --json` prints. Use these exact ids when tagging tests; never derive an id from claim text. Set `all` to include dead claims with their last known text.",
      inputSchema: {
        all: z.boolean().optional().describe("Include dead (retired) claims, marked with their last text"),
      },
    },
    ({ all }) =>
      guarded(() => jsonDoc(listClaims(analyze(repoRoot), { all: all === true }))),
  );

  server.registerTool(
    "check",
    {
      description:
        "Run the deterministic drift check across declared edges and refresh the escalation queue — the same JSON `tripact check --json` prints (verdicts, orphan tags, escalations, exitCode: 0 clean / 1 drift).",
    },
    () =>
      guarded(() => {
        const analysis = analyze(repoRoot);
        writeEscalations(repoRoot, analysis.escalations); // same side effect as `tripact check`
        return jsonDoc(toJsonReport(analysis));
      }),
  );

  server.registerTool(
    "status",
    {
      description:
        "Read-only traceability summary of the current state — the same JSON `tripact status --json` prints. Never writes anything.",
    },
    () => guarded(() => jsonDoc(toJsonReport(analyze(repoRoot)))),
  );

  server.registerTool(
    "escalations",
    {
      description:
        "List the open escalation questions the engine could not decide deterministically — the same JSON document `tripact check` writes to .tripact/escalations.json. Answer them with the `resolve` tool.",
    },
    () =>
      guarded(() => {
        const analysis: Analysis = analyze(repoRoot);
        const file: EscalationFile = { schemaVersion: ESCALATIONS_SCHEMA_VERSION, questions: analysis.escalations };
        return jsonDoc(file);
      }),
  );

  server.registerTool(
    "resolve",
    {
      description:
        "Apply an adjudication answer to one escalation question (the only write tool; baselining via `accept` is not available over MCP). Pass exactly one of `match` (same requirement restated — the old claim keeps its id), `new` (genuinely new requirement), `dead` (requirement removed — the id is retired), or `dismiss` (accept an advisory fork-review fork so it is not re-emitted).",
      inputSchema: {
        questionId: z.string().describe("Escalation question id from the `escalations` or `check` tool"),
        match: z
          .object({
            oldId: z.string().describe("Id of the old claim that survives"),
            newAtomText: z.string().describe("Exact text of the created atom it matches"),
          })
          .optional()
          .describe("The old claim and the new text are the same requirement restated"),
        new: z
          .object({ atomText: z.string().describe("Exact text of the created atom") })
          .optional()
          .describe("The created atom is a genuinely new requirement"),
        dead: z
          .object({ oldId: z.string().describe("Id of the claim to retire") })
          .optional()
          .describe("The old claim's requirement is gone"),
        dismiss: z
          .boolean()
          .optional()
          .describe("Accept an advisory fork-review fork — records the dismissal so it is not re-emitted"),
      },
    },
    ({ questionId, match, new: asNew, dead, dismiss }) =>
      guarded(() => {
        const given = [match, asNew, dead, dismiss ? "dismiss" : undefined].filter((x) => x !== undefined);
        if (given.length !== 1) {
          return errorResult("resolve takes exactly one of match, new, dead, dismiss");
        }
        let resolution: Resolution;
        if (match !== undefined) {
          resolution = { kind: "match", oldId: match.oldId, newAtomText: match.newAtomText };
        } else if (asNew !== undefined) {
          resolution = { kind: "new", atomText: asNew.atomText };
        } else if (dead !== undefined) {
          resolution = { kind: "dead", oldId: dead.oldId };
        } else {
          resolution = { kind: "dismiss" };
        }
        applyResolution(repoRoot, questionId, resolution);
        return { content: [{ type: "text" as const, text: `resolved ${questionId}` }] };
      }),
  );

  // accept is exposed only under the `agents` accept policy (UAC §16.2). Read the policy
  // once at serve time; a missing/invalid config falls back to `human` (accept absent).
  let policy: "human" | "agents" = "human";
  try {
    policy = acceptPolicy(loadConfig(repoRoot));
  } catch {
    policy = "human";
  }
  if (policy === "agents") {
    server.registerTool(
      "accept",
      {
        description:
          "Baseline the current tree: write claim anchoring + verified states into .tripact/claims.json and clear the escalation queue, returning the tripact-sync-id trailer. Exposed only under the `agents` accept policy. Refuses while reanchor/split-merge escalations are open. Runs with no prompt.",
      },
      () =>
        guarded(() => {
          const analysis = analyze(repoRoot);
          const blocking = analysis.escalations.filter((e) => e.kind === "reanchor" || e.kind === "split-merge");
          if (blocking.length) {
            return errorResult(
              `cannot accept — ${blocking.length} open escalation(s); adjudicate them first: ` +
                blocking.map((e) => `[${e.kind}] ${e.id}`).join(", "),
            );
          }
          const accepted = buildAcceptedSidecar(repoRoot, analysis);
          const delta = computeAcceptanceDelta(analysis.sidecar, accepted);
          saveSidecar(repoRoot, accepted);
          writeEscalations(repoRoot, []);
          const trailer = `${SYNC_POINT_TRAILER}: ${sidecarContentHash(accepted)}`;
          return { content: [{ type: "text" as const, text: `${renderDeltaHuman(delta)}\n\n${trailer}` }] };
        }),
    );
  }

  return server;
}

/** Serve the kernel over stdio until the client disconnects (UAC §16.2). */
export async function serveMcp(repoRoot: string, identity: ServerIdentity = {}): Promise<void> {
  const server = buildServer(repoRoot, identity);
  await server.connect(new StdioServerTransport());
}
