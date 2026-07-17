// MCP serving (UAC §16.2). Drives the real `mcp-serve` stdio server the way a foreign harness
// would: spawn the prebuilt CLI as an MCP server, connect a real MCP client over stdio, and compare
// each read tool's JSON against the corresponding `--json` CLI command. The server is loaded lazily
// by `mcp-serve` alone, so these are the only tests that touch the MCP SDK.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { cliInvocation, runCli } from "./helpers/cli.js";
import { CONFIG, fullRepo, MANUAL, SPECS, TESTS } from "./helpers/fixture.js";

const scratch: string[] = [];
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});

/** A full three-layer repo whose config sets `accept.policy: agents` (fullRepo defaults to human). */
function agentsRepo(): string {
  const repo = mkdtempSync(path.join(os.tmpdir(), "tripact-mcp-agents-"));
  scratch.push(repo);
  execFileSync("git", ["init", "-b", "main"], { cwd: repo });
  writeFileSync(path.join(repo, "SPECS.md"), SPECS);
  writeFileSync(path.join(repo, "tripact.yaml"), `${CONFIG}accept:\n  policy: agents\n`);
  mkdirSync(path.join(repo, "docs", "manual"), { recursive: true });
  writeFileSync(path.join(repo, "docs", "manual", "using.md"), MANUAL);
  mkdirSync(path.join(repo, "tests", "e2e"), { recursive: true });
  writeFileSync(path.join(repo, "tests", "e2e", "calc.spec.ts"), TESTS);
  runCli(["check"], { cwd: repo }); // materialise .tripact/escalations.json
  return repo;
}

/** Connect a real MCP client to `mcp-serve` in `repo` over stdio, resolving the CLI the shared way. */
async function connect(repo: string): Promise<{ client: Client; close: () => Promise<void> }> {
  const { command, baseArgs } = cliInvocation();
  const transport = new StdioClientTransport({ command, args: [...baseArgs, "mcp-serve"], cwd: repo });
  const client = new Client({ name: "test-harness", version: "0" });
  await client.connect(transport);
  return { client, close: () => transport.close() };
}

/** Return the single text block of a tool result. */
function toolText(result: { content: Array<{ type: string; text?: string }> }): string {
  const block = result.content[0];
  expect(block.type).toBe("text");
  return block.text ?? "";
}

describe("MCP serving (§16.2)", () => {
  // @specs:mcp-serving.tripact-mcp-serve-exposes-task
  it("exposes the queues and reports as read tools plus resolve over stdio", async () => {
    const repo = fullRepo("tripact-mcp-tools-");
    scratch.push(repo);
    const { client, close } = await connect(repo);
    try {
      const names = (await client.listTools()).tools.map((t) => t.name).sort();
      // task queue, claim listing, check report, status summary and escalation queue as read tools…
      for (const readTool of ["tasks", "claims", "check", "status", "escalations"]) {
        expect(names, `read tool ${readTool}`).toContain(readTool);
      }
      // …plus resolve as a write tool.
      expect(names, "resolve write tool").toContain("resolve");
    } finally {
      await close();
    }
  });

  // @specs:mcp-serving.accept-exposed-write-tool
  it("exposes accept only under the agents accept policy, absent under human", async () => {
    // fullRepo carries no accept block, so the policy defaults to human → accept absent.
    const human = fullRepo("tripact-mcp-human-");
    scratch.push(human);
    const humanConn = await connect(human);
    try {
      const humanNames = (await humanConn.client.listTools()).tools.map((t) => t.name);
      expect(humanNames, "accept absent under human").not.toContain("accept");
      // resolve is always available regardless of policy.
      expect(humanNames).toContain("resolve");
    } finally {
      await humanConn.close();
    }

    const agentsConn = await connect(agentsRepo());
    try {
      const agentsNames = (await agentsConn.client.listTools()).tools.map((t) => t.name);
      expect(agentsNames, "accept present under agents").toContain("accept");
    } finally {
      await agentsConn.close();
    }
  });

  // @specs:mcp-serving.each-mcp-read-tool
  it("returns from each read tool the same JSON document the matching cli --json flag produces", async () => {
    const repo = fullRepo("tripact-mcp-parity-");
    scratch.push(repo);
    const { client, close } = await connect(repo);
    try {
      for (const name of ["tasks", "claims", "check", "status"]) {
        const viaMcp = toolText(await client.callTool({ name, arguments: {} }));
        const viaCli = runCli([name, "--json"], { cwd: repo }).stdout;
        // The CLI prints via console.log (a trailing newline); the tool emits the bare document.
        // Same JSON document either way — identical once the CLI's trailing newline is trimmed…
        expect(viaMcp.trim(), `${name} text parity`).toBe(viaCli.trim());
        // …and structurally identical when parsed.
        expect(JSON.parse(viaMcp), `${name} parsed parity`).toEqual(JSON.parse(viaCli));
      }
    } finally {
      await close();
    }
  });

  // The other half of the same cross-cutting claim (its command-side is covered in
  // test/cross-cutting.test.ts): mcp-serve speaks only stdio and opens no socket.
  // @specs:determinism.no-checking-reporting-state-mutating
  it("speaks only stdio — serving a real client opens no socket", async () => {
    // Trap the server side (createServer/listen) and the client side (connect/DNS/http/fetch). The
    // trap only RECORDS here rather than throwing: a throw inside the served process would surface
    // as a transport failure and mask which primitive was reached. The log is the assertion.
    const trapDir = mkdtempSync(path.join(os.tmpdir(), "tripact-mcp-nosock-"));
    scratch.push(trapDir);
    const trap = path.join(trapDir, "trap.cjs");
    const netLog = path.join(trapDir, "net.log");
    writeFileSync(
      trap,
      [
        'const fs = require("node:fs");',
        "const log = process.env.TRIPACT_NET_LOG;",
        'function note(what) { try { fs.appendFileSync(log, what + "\\n"); } catch {} }',
        'const net = require("node:net");',
        'const listen = net.Server.prototype.listen;',
        'net.Server.prototype.listen = function (...a) { note("net.Server.listen"); return listen.apply(this, a); };',
        'const createServer = net.createServer;',
        'net.createServer = function (...a) { note("net.createServer"); return createServer.apply(this, a); };',
        'const connect = net.Socket.prototype.connect;',
        'net.Socket.prototype.connect = function (...a) { note("net.Socket.connect"); return connect.apply(this, a); };',
        'const dns = require("node:dns");',
        'const lookup = dns.lookup;',
        'dns.lookup = function (...a) { note("dns.lookup"); return lookup.apply(this, a); };',
        'const http = require("node:http");',
        'const hreq = http.request;',
        'http.request = function (...a) { note("http.request"); return hreq.apply(this, a); };',
        'const https = require("node:https");',
        'const sreq = https.request;',
        'https.request = function (...a) { note("https.request"); return sreq.apply(this, a); };',
        'const f = globalThis.fetch;',
        'globalThis.fetch = function (...a) { note("fetch"); return f && f.apply(this, a); };',
        "",
      ].join("\n"),
    );
    writeFileSync(netLog, "");

    const repo = fullRepo("tripact-mcp-nosock-repo-");
    scratch.push(repo);
    const { command, baseArgs } = cliInvocation();
    const transport = new StdioClientTransport({
      command,
      args: [...baseArgs, "mcp-serve"],
      cwd: repo,
      env: { ...process.env, TRIPACT_NET_LOG: netLog, NODE_OPTIONS: `--require ${trap}` } as Record<string, string>,
    });
    const client = new Client({ name: "test-harness", version: "0" });
    await client.connect(transport);
    try {
      // A real round trip over the transport: if the server were reaching the client over a socket
      // rather than stdio, serving this call is where it would have to happen.
      const names = (await client.listTools()).tools.map((t) => t.name);
      expect(names).toContain("check");
      expect(toolText(await client.callTool({ name: "status", arguments: {} })), "served over stdio").toContain(
        '"schemaVersion"',
      );
    } finally {
      await transport.close();
    }
    // Connected, listed and served entirely over stdio pipes — no listen, no socket, no egress.
    expect(readFileSync(netLog, "utf8"), "mcp-serve touched a socket or the network").toBe("");
  });
});
