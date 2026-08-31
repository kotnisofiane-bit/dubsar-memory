import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { encodeFrame, createFrameParser } from "../packages/dubsar-my-work-mcp/src/server.mjs";
import { readTickets } from "../packages/dubsar-workbench-launcher/src/registry-store.mjs";
import { CONTROLLER_ARGUMENT_KEYS } from "../packages/dubsar-my-work-mcp/src/mission-args.mjs";

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

function startServer() {
  const child = spawn(process.execPath, [bin], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { PATH: process.env.PATH, TMPDIR: tmpdir() },
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
    assert.equal(tools.result.tools.length, 5);
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
