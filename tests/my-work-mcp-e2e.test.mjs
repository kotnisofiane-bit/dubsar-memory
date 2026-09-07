import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { encodeFrame, createFrameParser } from "../packages/dubsar-my-work-mcp/src/server.mjs";
import { applyTicketChange, previewTicketChange, readTickets } from "../packages/dubsar-workbench-launcher/src/registry-store.mjs";
import { CONTROLLER_ARGUMENT_KEYS, CONTROLLER_RUN_ARGUMENT_KEYS, CONTROLLER_RUN_TOOL, CONTROLLER_TOOL, controllerRunToolCall } from "../packages/dubsar-my-work-mcp/src/mission-args.mjs";
import { CREDENTIALS_FORMAT } from "../packages/dubsar-my-work-mcp/src/oauth-store.mjs";
import {
  controllerToolsCallBody,
  legacyControllerLaunchHeaders,
  parseSseJsonRpc,
  streamableMcpLaunchHeaders,
} from "../packages/dubsar-my-work-mcp/src/controller-client.mjs";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

const bin = fileURLToPath(new URL("../packages/dubsar-my-work-mcp/bin/dubsar-my-work-mcp.mjs", import.meta.url));
const vectorPath = fileURLToPath(
  new URL("../packages/dubsar-my-work-mcp/vectors/controller-canonical-pr26.json", import.meta.url),
);
const legacyVectorPath = fileURLToPath(
  new URL("../packages/dubsar-my-work-mcp/vectors/controller-canonical-v1.json", import.meta.url),
);
const FROZEN_CONTROLLER_FINGERPRINT =
  "sha256:0f70c44c67c84c156eca8d8fcf57cf25340447d5e4d19867377ee2e3be87e3b6";

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
    assert.equal(tools.result.tools.length, 7);
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
        correction_budget: "uncapped",
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
    correction_budget: "uncapped",
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
    assert.equal(args.correction_budget, "uncapped");
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

async function servePinnedController({ receipt, runReceipts = new Map(), onCall }) {
  const handler = createMcpHandler(() => {
    const server = new McpServer({ name: "dubsar-controller-pin", version: "2.0.0" });
    server.registerTool(
      CONTROLLER_TOOL,
      {
        description: "Pinned createMcpHandler Controller launch",
        inputSchema: z.object({ ticket_id: z.string() }).passthrough(),
      },
      async (args) => {
        onCall?.({ tool: CONTROLLER_TOOL, args });
        return {
          content: [{ type: "text", text: JSON.stringify(receipt) }],
          structuredContent: receipt,
        };
      },
    );
    server.registerTool(
      CONTROLLER_RUN_TOOL,
      {
        description: "Pinned createMcpHandler Controller run",
        inputSchema: z.object({ ticket_id: z.string(), agent_url_or_id: z.string(), correction_number: z.number(), prompt: z.string() }).passthrough(),
      },
      async (args) => {
        onCall?.({ tool: CONTROLLER_RUN_TOOL, args });
        const runReceipt = runReceipts.get(args.correction_number);
        return {
          content: [{ type: "text", text: JSON.stringify(runReceipt) }],
          structuredContent: runReceipt,
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
      assert.equal(calls[0].tool, CONTROLLER_TOOL);
      assert.equal("contract_fingerprint" in calls[0].args, false);
      assert.equal("receipt_bounds" in calls[0].args, false);
      assert.deepEqual(Object.keys(calls[0].args).sort(), [...CONTROLLER_ARGUMENT_KEYS].sort());
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

test("pinned Controller run schema rejects agent_id-only and accepts agent_url_or_id", async () => {
  const vector = JSON.parse(await readFile(vectorPath, "utf8"));
  const runReceipts = new Map([
    [4, vector.follow_up_4_receipt],
  ]);
  const calls = [];
  const pinned = await servePinnedController({
    receipt: vector.realistic_receipt,
    runReceipts,
    onCall(entry) {
      calls.push(entry);
    },
  });
  try {
    const corrected = controllerRunToolCall(vector.unsigned_arguments, {
      agentId: vector.realistic_receipt.agent_id,
      correctionNumber: 4,
      prompt: "Correction 4",
    }).arguments;
    const legacy = { ...corrected, agent_id: vector.realistic_receipt.agent_id };
    delete legacy.agent_url_or_id;
    const rejected = await fetch(pinned.url, {
      method: "POST",
      headers: streamableMcpLaunchHeaders("e2e-access-token"),
      body: JSON.stringify(controllerToolsCallBody(legacy, CONTROLLER_RUN_TOOL)),
    });
    assert.equal(rejected.status, 200);
    const rejectedPayload = parseSseJsonRpc(await rejected.text());
    assert.equal(rejectedPayload.result?.isError === true || Boolean(rejectedPayload.error), true);
    assert.equal(calls.some((item) => item.tool === CONTROLLER_RUN_TOOL), false);
    const accepted = await fetch(pinned.url, {
      method: "POST",
      headers: streamableMcpLaunchHeaders("e2e-access-token"),
      body: JSON.stringify(controllerToolsCallBody(corrected, CONTROLLER_RUN_TOOL)),
    });
    assert.equal(accepted.status, 200);
    const acceptedPayload = parseSseJsonRpc(await accepted.text());
    assert.notEqual(acceptedPayload.result?.isError, true);
    assert.equal(acceptedPayload.error, undefined);
    assert.equal(acceptedPayload.result?.structuredContent?.agent_id, vector.follow_up_4_receipt.agent_id);
    assert.equal(calls.filter((item) => item.tool === CONTROLLER_RUN_TOOL).length, 1);
    assert.equal(calls.at(-1).args.agent_url_or_id, vector.realistic_receipt.agent_id);
    assert.equal("agent_id" in calls.at(-1).args, false);
  } finally {
    pinned.server.close();
  }
});

test("E2E legacy budget-3 receipt survives MCP restart without rewrite", async () => {
  const start = await mkdtemp(path.join(tmpdir(), "dubsar-mcp-e2e-legacy-"));
  const allocationRoot = await mkdtemp(path.join(tmpdir(), "dubsar-mcp-e2e-legacy-global-"));
  await mkdir(path.join(start, ".dubsar"));
  const context = { start, allocation_root: allocationRoot, project_id: "project-e2e-legacy" };
  const vector = JSON.parse(await readFile(legacyVectorPath, "utf8"));
  const envelope = {
    arguments: vector.unsigned_arguments,
    contract_fingerprint: vector.expected_contract_fingerprint,
    receipt_bounds: vector.receipt_bounds,
  };
  async function apply(operation) {
    const preview = await previewTicketChange({
      start,
      allocationRoot,
      projectId: context.project_id,
      operation,
    });
    await applyTicketChange({
      start,
      allocationRoot,
      projectId: context.project_id,
      operation,
      expectedChange: preview.change_sha256,
    });
  }
  await apply({
    type: "create",
    title: "Legacy",
    objective: "Budget 3",
    criteria: ["Ticket persisté"],
    references: [envelope.contract_fingerprint, envelope.arguments.target_repository_url],
  });
  await apply({
    type: "activity",
    id: "DUB-001",
    kind: "cursor_contract",
    summary: "create_dubsar_work_cursor_agent arguments persisted",
    evidence: envelope,
  });
  const server = startServer();
  try {
    await server.call("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "test" },
    });
    const attached = await server.call("tools/call", {
      name: "attach_cursor_receipt",
      arguments: { ...context, ticket_id: "DUB-001", receipt: vector.realistic_receipt },
    });
    assert.equal(attached.result.structuredContent.state, "In Progress");
  } finally {
    await stopServer(server.child);
  }
  const restarted = startServer();
  try {
    await restarted.call("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "test" },
    });
    const reread = await restarted.call("tools/call", {
      name: "get_ticket",
      arguments: { ...context, ticket_id: "DUB-001" },
    });
    const body = reread.result.structuredContent;
    assert.equal(body.prepared_contract.arguments.correction_budget, 3);
    assert.equal(body.attached_receipt.bounds.correction_budget, 3);
    assert.equal("correction_policy" in body.attached_receipt.bounds, false);
    assert.equal(body.attached_receipt.run_id, vector.realistic_receipt.run_id);
  } finally {
    await stopServer(restarted.child);
  }
});

test("E2E public launch then continuations 4/5 persist history across restart without extra create", async () => {
  const start = await mkdtemp(path.join(tmpdir(), "dubsar-mcp-e2e-continue-"));
  const allocationRoot = await mkdtemp(path.join(tmpdir(), "dubsar-mcp-e2e-continue-global-"));
  const configDir = await mkdtemp(path.join(tmpdir(), "dubsar-mcp-e2e-continue-oauth-"));
  await mkdir(path.join(start, ".dubsar"));
  const context = { start, allocation_root: allocationRoot, project_id: "project-e2e-continue" };
  const vector = JSON.parse(await readFile(vectorPath, "utf8"));
  const calls = [];
  const mock = await listenMock(({ body, response }) => {
    const parsed = JSON.parse(body);
    calls.push(parsed);
    const name = parsed.params.name;
    const args = parsed.params.arguments;
    assert.equal("contract_fingerprint" in args, false);
    if (name === CONTROLLER_TOOL) {
      assert.deepEqual(Object.keys(args).sort(), [...CONTROLLER_ARGUMENT_KEYS].sort());
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: { structuredContent: vector.realistic_receipt, isError: false },
      }));
      return;
    }
    assert.equal(name, CONTROLLER_RUN_TOOL);
    assert.deepEqual(Object.keys(args).sort(), [...CONTROLLER_RUN_ARGUMENT_KEYS].sort());
    assert.equal(args.agent_url_or_id, vector.realistic_receipt.agent_id);
    assert.equal("agent_id" in args, false);
    const receipt = args.correction_number === 4 ? vector.follow_up_4_receipt : vector.follow_up_5_receipt;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: { structuredContent: receipt, isError: false },
    }));
  });
  await writeLocalCredentials(configDir, mock.url);
  const env = { DUBSAR_MY_WORK_CONFIG_DIR: configDir };
  try {
    const first = startServer(env);
    try {
      await first.call("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test" } });
      const launched = await first.call("tools/call", {
        name: "launch_cursor_mission",
        arguments: frozenMission(context, vector),
      });
      assert.equal(launched.result.structuredContent.ticket_id, "DUB-001");
      const four = await first.call("tools/call", {
        name: "continue_cursor_mission",
        arguments: { ...context, ticket_id: "DUB-001", correction_number: 4, prompt: "Correction 4" },
      });
      assert.equal(four.result.structuredContent.run_id, vector.follow_up_4_receipt.run_id);
      const five = await first.call("tools/call", {
        name: "continue_cursor_mission",
        arguments: { ...context, ticket_id: "DUB-001", correction_number: 5, prompt: "Correction 5" },
      });
      assert.equal(five.result.structuredContent.run_id, vector.follow_up_5_receipt.run_id);
      assert.equal(calls.filter((item) => item.params.name === CONTROLLER_TOOL).length, 1);
      assert.equal(calls.filter((item) => item.params.name === CONTROLLER_RUN_TOOL).length, 2);
    } finally {
      await stopServer(first.child);
    }

    const second = startServer(env);
    try {
      await second.call("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test" } });
      const reread = await second.call("tools/call", {
        name: "get_ticket",
        arguments: { ...context, ticket_id: "DUB-001" },
      });
      const body = reread.result.structuredContent;
      assert.equal(body.attached_launch_receipt.run_id, vector.realistic_receipt.run_id);
      assert.equal(body.attached_receipt.run_id, vector.follow_up_5_receipt.run_id);
      assert.equal(body.attached_run_receipts.length, 2);
      const synced = await second.call("tools/call", {
        name: "sync_cursor_status",
        arguments: {
          ...context,
          ticket_id: "DUB-001",
          cursor_observation: {
            source: "trusted_cursor_observer",
            ticket_id: "DUB-001",
            agent_id: vector.follow_up_5_receipt.agent_id,
            run_id: vector.follow_up_5_receipt.run_id,
            lifecycle: "running",
            pr: null,
          },
          github_observation: null,
        },
      });
      assert.equal(synced.result.structuredContent.ticket.state, "In Progress");
      const again = await second.call("tools/call", {
        name: "continue_cursor_mission",
        arguments: { ...context, ticket_id: "DUB-001", correction_number: 5, prompt: "Correction 5" },
      });
      assert.equal(again.result.structuredContent.continued, false);
      assert.equal(calls.filter((item) => item.params.name === CONTROLLER_TOOL).length, 1);
      assert.equal(calls.filter((item) => item.params.name === CONTROLLER_RUN_TOOL).length, 2);
    } finally {
      await stopServer(second.child);
    }
  } finally {
    mock.server.close();
  }
});

test("E2E continuation ambiguity does not retry and keeps the launch receipt", async () => {
  const start = await mkdtemp(path.join(tmpdir(), "dubsar-mcp-e2e-cont-amb-"));
  const allocationRoot = await mkdtemp(path.join(tmpdir(), "dubsar-mcp-e2e-cont-amb-global-"));
  const configDir = await mkdtemp(path.join(tmpdir(), "dubsar-mcp-e2e-cont-amb-oauth-"));
  await mkdir(path.join(start, ".dubsar"));
  const context = { start, allocation_root: allocationRoot, project_id: "project-e2e-cont-amb" };
  const vector = JSON.parse(await readFile(vectorPath, "utf8"));
  const posts = [];
  const mock = await listenMock(({ body, response }) => {
    const parsed = JSON.parse(body);
    posts.push(parsed.params.name);
    if (parsed.params.name === CONTROLLER_TOOL) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: { structuredContent: vector.realistic_receipt, isError: false },
      }));
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "not-json" }] } }));
  });
  await writeLocalCredentials(configDir, mock.url);
  try {
    const first = startServer({ DUBSAR_MY_WORK_CONFIG_DIR: configDir });
    try {
      await first.call("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test" } });
      await first.call("tools/call", { name: "launch_cursor_mission", arguments: frozenMission(context, vector) });
      const failed = await first.call("tools/call", {
        name: "continue_cursor_mission",
        arguments: { ...context, ticket_id: "DUB-001", correction_number: 4, prompt: "Correction 4" },
      });
      assert.equal(failed.result.isError, true);
      assert.equal(failed.result.structuredContent.code, "MY_WORK_CONTINUE_AMBIGUOUS");
      const retry = await first.call("tools/call", {
        name: "continue_cursor_mission",
        arguments: { ...context, ticket_id: "DUB-001", correction_number: 4, prompt: "Correction 4" },
      });
      assert.equal(retry.result.isError, true);
      assert.equal(retry.result.structuredContent.code, "MY_WORK_CONTINUE_NOT_RETRYABLE");
      const skip = await first.call("tools/call", {
        name: "continue_cursor_mission",
        arguments: { ...context, ticket_id: "DUB-001", correction_number: 5, prompt: "Correction 5" },
      });
      assert.equal(skip.result.isError, true);
      assert.equal(skip.result.structuredContent.code, "MY_WORK_CONTINUE_NOT_RETRYABLE");
      assert.equal(posts.filter((name) => name === CONTROLLER_RUN_TOOL).length, 1);
    } finally {
      await stopServer(first.child);
    }
    const persisted = (await readTickets({ start })).tickets[0];
    assert.equal(persisted.cursor_launch.run_id, vector.realistic_receipt.run_id);
    assert.equal(persisted.cursor_run, null);
  } finally {
    mock.server.close();
  }
});
