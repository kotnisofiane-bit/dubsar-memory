import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { encodeFrame, createFrameParser } from "../packages/dubsar-my-work-mcp/src/server.mjs";
import { readTickets } from "../packages/dubsar-workbench-launcher/src/registry-store.mjs";
import { CONTROLLER_ARGUMENT_KEYS, CONTROLLER_TOOL } from "../packages/dubsar-my-work-mcp/src/mission-args.mjs";
import { CREDENTIALS_FORMAT } from "../packages/dubsar-my-work-mcp/src/oauth-store.mjs";
import {
  controllerToolsCallBody,
  legacyControllerLaunchHeaders,
  streamableMcpLaunchHeaders,
} from "../packages/dubsar-my-work-mcp/src/controller-client.mjs";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

const bin = fileURLToPath(new URL("../packages/dubsar-my-work-mcp/bin/dubsar-my-work-mcp.mjs", import.meta.url));
const vectorPath = fileURLToPath(
  new URL("../packages/dubsar-my-work-mcp/vectors/controller-canonical-v1.json", import.meta.url),
);
const FROZEN_CONTROLLER_FINGERPRINT =
  "sha256:56ada5fb957c3c84449688dc79169e093ee4b7d6d05dc0cfc64be9c0db89f574";

function rpc(child) {
  let nextId = 1;
  const pending = new Map();
  const onChunk = createFrameParser((message) => {
    const waiter = pending.get(message.id);
    if (waiter) {
      pending.delete(message.id);
      waiter(message);
    }
  });
  child.stdout.on("data", onChunk);
  return (method, params) => {
    const id = nextId++;
    const payload = { jsonrpc: "2.0", id, method, params };
    child.stdin.write(encodeFrame(payload));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout:${method}`)), 10_000);
      pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
    });
  };
}

function startServer(extraEnv = {}) {
  const child = spawn(process.execPath, [bin], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { PATH: process.env.PATH, TMPDIR: tmpdir(), ...extraEnv },
  });
  return { child, call: rpc(child) };
}

async function stopServer(child) {
  child.stdin.end();
  child.kill("SIGTERM");
  await new Promise((resolve) => child.once("exit", resolve));
}

test("E2E prepare, restart, attach realistic receipt, restart, read and sync", async () => {
  const start = await mkdtemp(path.join(tmpdir(), "dubsar-mcp-e2e-project-"));
  const allocationRoot = await mkdtemp(path.join(tmpdir(), "dubsar-mcp-e2e-global-"));
  await mkdir(path.join(start, ".dubsar"));
  const context = { start, allocation_root: allocationRoot, project_id: "project-e2e" };
  const vector = JSON.parse(await readFile(vectorPath, "utf8"));

  const first = startServer();
  let mission;
  try {
    const initialized = await first.call("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "test" },
    });
    assert.equal(initialized.result.serverInfo.name, "dubsar-my-work");
    first.child.stdin.write(encodeFrame({ jsonrpc: "2.0", method: "notifications/initialized" }));
    const tools = await first.call("tools/list");
    assert.equal(tools.result.tools.length, 6);
    const listed = await first.call("tools/call", { name: "list_tickets", arguments: context });
    assert.equal(listed.result.isError, false);
    assert.equal(JSON.parse(listed.result.content[0].text).tickets.length, 0);
    const prepared = await first.call("tools/call", {
      name: "prepare_cursor_mission",
      arguments: {
        ...context,
        title: "KOT-126",
        objective: "MCP local My Work",
        criteria: ["Ticket persisté"],
        target_repository_url: vector.unsigned_arguments.target_repository_url,
        starting_sha: vector.unsigned_arguments.repository_refs[0].starting_sha,
        allowed_paths: vector.unsigned_arguments.allowed_paths,
        mission: vector.unsigned_arguments.mission,
        acceptance_criteria: vector.unsigned_arguments.acceptance_criteria,
        expected_evidence: vector.unsigned_arguments.expected_evidence,
        required_capabilities: vector.unsigned_arguments.required_capabilities,
        preferred_plugins: vector.unsigned_arguments.preferred_plugins,
        required_plugins: vector.unsigned_arguments.required_plugins,
        human_gates: vector.unsigned_arguments.human_gates,
        correction_budget: 3,
      },
    });
    mission = prepared.result.structuredContent;
    assert.equal(mission.ticket_id, "DUB-001");
    assert.equal(mission.tool, "create_dubsar_work_cursor_agent");
    assert.deepEqual(Object.keys(mission.arguments).sort(), [...CONTROLLER_ARGUMENT_KEYS].sort());
    assert.equal(mission.contract_fingerprint, FROZEN_CONTROLLER_FINGERPRINT);
    assert.equal(JSON.stringify(mission.receipt_bounds), JSON.stringify(vector.receipt_bounds));
  } finally {
    await stopServer(first.child);
  }

  const afterPrepare = startServer();
  try {
    await afterPrepare.call("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "test" },
    });
    const reread = await afterPrepare.call("tools/call", {
      name: "get_ticket",
      arguments: { ...context, ticket_id: "DUB-001" },
    });
    const body = reread.result.structuredContent;
    assert.equal(body.ticket.state, "Backlog");
    assert.equal(body.prepared_contract.contract_fingerprint, FROZEN_CONTROLLER_FINGERPRINT);
    assert.equal(body.prepared_contract.arguments.pr_repository_url, vector.unsigned_arguments.pr_repository_url);
    assert.equal(body.attached_receipt, null);
    const attached = await afterPrepare.call("tools/call", {
      name: "attach_cursor_receipt",
      arguments: { ...context, ticket_id: "DUB-001", receipt: vector.realistic_receipt },
    });
    assert.equal(attached.result.structuredContent.state, "In Progress");
  } finally {
    await stopServer(afterPrepare.child);
  }

  const afterAttach = startServer();
  try {
    await afterAttach.call("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "test" },
    });
    const reread = await afterAttach.call("tools/call", {
      name: "get_ticket",
      arguments: { ...context, ticket_id: "DUB-001" },
    });
    const body = reread.result.structuredContent;
    assert.equal(body.ticket.state, "In Progress");
    assert.equal(body.prepared_contract.contract_fingerprint, mission.contract_fingerprint);
    assert.equal(body.attached_receipt.run_id, vector.realistic_receipt.run_id);
    const synced = await afterAttach.call("tools/call", {
      name: "sync_cursor_status",
      arguments: {
        ...context,
        ticket_id: "DUB-001",
        cursor_observation: {
          source: "trusted_cursor_observer",
          ticket_id: "DUB-001",
          agent_id: vector.realistic_receipt.agent_id,
          run_id: vector.realistic_receipt.run_id,
          lifecycle: "running",
          pr: null,
        },
        github_observation: null,
      },
    });
    assert.equal(synced.result.structuredContent.ticket.state, "In Progress");
    const persisted = (await readTickets({ start })).tickets[0];
    assert.equal(persisted.cursor_launch.run_id, vector.realistic_receipt.run_id);
    assert.equal(persisted.references[0], FROZEN_CONTROLLER_FINGERPRINT);
  } finally {
    await stopServer(afterAttach.child);
  }
});

function listenMock(handler) {
  return new Promise((resolve) => {
    const server = createServer((request, response) => {
      const chunks = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        handler({ request, body: Buffer.concat(chunks).toString("utf8"), response });
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, url: `http://127.0.0.1:${port}/mcp` });
    });
  });
}

function frozenMission(context, vector) {
  return {
    ...context,
    title: "KOT-126",
    objective: "MCP local My Work",
    criteria: ["Ticket persisté"],
    target_repository_url: vector.unsigned_arguments.target_repository_url,
    starting_sha: vector.unsigned_arguments.repository_refs[0].starting_sha,
    allowed_paths: vector.unsigned_arguments.allowed_paths,
    mission: vector.unsigned_arguments.mission,
    acceptance_criteria: vector.unsigned_arguments.acceptance_criteria,
    expected_evidence: vector.unsigned_arguments.expected_evidence,
    required_capabilities: vector.unsigned_arguments.required_capabilities,
    preferred_plugins: vector.unsigned_arguments.preferred_plugins,
    required_plugins: vector.unsigned_arguments.required_plugins,
    human_gates: vector.unsigned_arguments.human_gates,
    correction_budget: 3,
  };
}

async function writeLocalCredentials(configDir, controllerUrl) {
  await writeFile(
    path.join(configDir, "credentials.json"),
    `${JSON.stringify({
      format: CREDENTIALS_FORMAT,
      controller_url: controllerUrl,
      token_type: "Bearer",
      access_token: "e2e-access-token",
      refresh_token: null,
      expires_at: null,
    }, null, 2)}\n`,
  );
}

test("E2E public launch persists ticket and matching receipt across MCP restart", async () => {
  const start = await mkdtemp(path.join(tmpdir(), "dubsar-mcp-e2e-launch-"));
  const allocationRoot = await mkdtemp(path.join(tmpdir(), "dubsar-mcp-e2e-launch-global-"));
  const configDir = await mkdtemp(path.join(tmpdir(), "dubsar-mcp-e2e-oauth-"));
  await mkdir(path.join(start, ".dubsar"));
  const context = { start, allocation_root: allocationRoot, project_id: "project-e2e-launch" };
  const vector = JSON.parse(await readFile(vectorPath, "utf8"));
  const posts = [];
  const mock = await listenMock(({ body, response }) => {
    posts.push(JSON.parse(body));
    const args = JSON.parse(body).params.arguments;
    assert.equal("contract_fingerprint" in args, false);
    assert.equal("receipt_bounds" in args, false);
    assert.deepEqual(Object.keys(args).sort(), [...CONTROLLER_ARGUMENT_KEYS].sort());
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: { structuredContent: vector.realistic_receipt, isError: false },
    }));
  });
  await writeLocalCredentials(configDir, mock.url);
  const env = { DUBSAR_MY_WORK_CONFIG_DIR: configDir };
  try {
    const first = startServer(env);
    try {
      await first.call("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test" },
      });
      const launched = await first.call("tools/call", {
        name: "launch_cursor_mission",
        arguments: frozenMission(context, vector),
      });
      const body = launched.result.structuredContent;
      assert.equal(body.ticket_id, "DUB-001");
      assert.equal(body.agent_id, vector.realistic_receipt.agent_id);
      assert.equal(body.run_id, vector.realistic_receipt.run_id);
      assert.equal(posts.length, 1);
      assert.equal(posts[0].params.name, CONTROLLER_TOOL);
    } finally {
      await stopServer(first.child);
    }

    const second = startServer(env);
    try {
      await second.call("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test" },
      });
      const reread = await second.call("tools/call", {
        name: "get_ticket",
        arguments: { ...context, ticket_id: "DUB-001" },
      });
      const body = reread.result.structuredContent;
      assert.equal(body.ticket.state, "In Progress");
      assert.equal(body.attached_receipt.run_id, vector.realistic_receipt.run_id);
      const relaunch = await second.call("tools/call", {
        name: "launch_cursor_mission",
        arguments: frozenMission(context, vector),
      });
      assert.equal(relaunch.result.structuredContent.launched, false);
      assert.equal(posts.length, 1);
    } finally {
      await stopServer(second.child);
    }
  } finally {
    mock.server.close();
  }
});

test("E2E ambiguous launch is not retried and stores no receipt", async () => {
  const start = await mkdtemp(path.join(tmpdir(), "dubsar-mcp-e2e-amb-"));
  const allocationRoot = await mkdtemp(path.join(tmpdir(), "dubsar-mcp-e2e-amb-global-"));
  const configDir = await mkdtemp(path.join(tmpdir(), "dubsar-mcp-e2e-amb-oauth-"));
  await mkdir(path.join(start, ".dubsar"));
  const context = { start, allocation_root: allocationRoot, project_id: "project-e2e-amb" };
  const vector = JSON.parse(await readFile(vectorPath, "utf8"));
  const posts = [];
  const mock = await listenMock(({ response }) => {
    posts.push(true);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "not-json" }] } }));
  });
  await writeLocalCredentials(configDir, mock.url);
  const args = frozenMission(context, vector);
  try {
    const first = startServer({ DUBSAR_MY_WORK_CONFIG_DIR: configDir });
    try {
      await first.call("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test" } });
      const failed = await first.call("tools/call", { name: "launch_cursor_mission", arguments: args });
      assert.equal(failed.result.isError, true);
      assert.equal(failed.result.structuredContent.code, "MY_WORK_LAUNCH_AMBIGUOUS");
      assert.equal(posts.length, 1);
      const retry = await first.call("tools/call", { name: "launch_cursor_mission", arguments: args });
      assert.equal(retry.result.isError, true);
      assert.equal(retry.result.structuredContent.code, "MY_WORK_LAUNCH_NOT_RETRYABLE");
      assert.equal(posts.length, 1);
    } finally {
      await stopServer(first.child);
    }
    const persisted = (await readTickets({ start })).tickets[0];
    assert.equal(persisted.cursor_launch, null);
    assert.notEqual(persisted.state, "In Progress");
  } finally {
    mock.server.close();
  }
});

async function servePinnedController({ receipt, onCall }) {
  const handler = createMcpHandler(() => {
    const server = new McpServer({ name: "dubsar-controller-pin", version: "2.0.0" });
    server.registerTool(
      CONTROLLER_TOOL,
      {
        description: "Pinned createMcpHandler Controller launch",
        inputSchema: z.object({ ticket_id: z.string() }).passthrough(),
      },
      async (args) => {
        onCall?.(args);
        return {
          content: [{ type: "text", text: JSON.stringify(receipt) }],
          structuredContent: receipt,
        };
      },
    );
    return server;
  });
  const httpServer = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (typeof value === "string") headers.set(key, value);
      else if (Array.isArray(value)) headers.set(key, value.join(", "));
    }
    const request = new Request(`http://127.0.0.1${req.url}`, {
      method: req.method,
      headers,
      body: req.method === "GET" || req.method === "HEAD" ? undefined : Buffer.concat(chunks),
    });
    const response = await handler.fetch(request);
    const body = Buffer.from(await response.arrayBuffer());
    const out = {};
    response.headers.forEach((value, key) => {
      out[key] = value;
    });
    res.writeHead(response.status, out);
    res.end(body);
  });
  await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const { port } = httpServer.address();
  return { server: httpServer, url: `http://127.0.0.1:${port}/mcp` };
}

test("pinned createMcpHandler transport: legacy request is 406, launch decodes SSE receipt once", async () => {
  const start = await mkdtemp(path.join(tmpdir(), "dubsar-mcp-e2e-pin-"));
  const allocationRoot = await mkdtemp(path.join(tmpdir(), "dubsar-mcp-e2e-pin-global-"));
  const configDir = await mkdtemp(path.join(tmpdir(), "dubsar-mcp-e2e-pin-oauth-"));
  await mkdir(path.join(start, ".dubsar"));
  const context = { start, allocation_root: allocationRoot, project_id: "project-e2e-pin" };
  const vector = JSON.parse(await readFile(vectorPath, "utf8"));
  const calls = [];
  const pinned = await servePinnedController({
    receipt: vector.realistic_receipt,
    onCall(args) {
      calls.push(args);
    },
  });
  await writeLocalCredentials(configDir, pinned.url);
  const env = { DUBSAR_MY_WORK_CONFIG_DIR: configDir };
  try {
    const legacy = await fetch(pinned.url, {
      method: "POST",
      headers: legacyControllerLaunchHeaders("e2e-access-token"),
      body: JSON.stringify(controllerToolsCallBody({ ticket_id: "DUB-001" })),
    });
    assert.equal(legacy.status, 406);
    assert.equal(calls.length, 0);
    const compatible = await fetch(pinned.url, {
      method: "POST",
      headers: streamableMcpLaunchHeaders("e2e-access-token"),
      body: JSON.stringify(controllerToolsCallBody({ ticket_id: "DUB-001" })),
    });
    assert.equal(compatible.status, 200);
    assert.match(String(compatible.headers.get("content-type") ?? ""), /text\/event-stream/u);
    assert.equal(calls.length, 1);
    calls.length = 0;

    const first = startServer(env);
    try {
      await first.call("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test" },
      });
      const launched = await first.call("tools/call", {
        name: "launch_cursor_mission",
        arguments: frozenMission(context, vector),
      });
      const body = launched.result.structuredContent;
      assert.equal(body.ticket_id, "DUB-001");
      assert.equal(body.agent_id, vector.realistic_receipt.agent_id);
      assert.equal(body.run_id, vector.realistic_receipt.run_id);
      assert.equal(body.state, "In Progress");
      assert.equal(calls.length, 1);
      assert.equal("contract_fingerprint" in calls[0], false);
      assert.equal("receipt_bounds" in calls[0], false);
      assert.deepEqual(Object.keys(calls[0]).sort(), [...CONTROLLER_ARGUMENT_KEYS].sort());
    } finally {
      await stopServer(first.child);
    }

    const second = startServer(env);
    try {
      await second.call("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test" },
      });
      const reread = await second.call("tools/call", {
        name: "get_ticket",
        arguments: { ...context, ticket_id: "DUB-001" },
      });
      const body = reread.result.structuredContent;
      assert.equal(body.ticket.state, "In Progress");
      assert.equal(body.attached_receipt.agent_id, vector.realistic_receipt.agent_id);
      assert.equal(body.attached_receipt.run_id, vector.realistic_receipt.run_id);
      const relaunch = await second.call("tools/call", {
        name: "launch_cursor_mission",
        arguments: frozenMission(context, vector),
      });
      assert.equal(relaunch.result.structuredContent.launched, false);
      assert.equal(calls.length, 1);
    } finally {
      await stopServer(second.child);
    }
  } finally {
    pinned.server.close();
  }
});
