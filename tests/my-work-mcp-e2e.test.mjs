import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { encodeFrame, createFrameParser } from "../packages/dubsar-my-work-mcp/src/server.mjs";
import { readTickets } from "../packages/dubsar-workbench-launcher/src/registry-store.mjs";

const bin = fileURLToPath(new URL("../packages/dubsar-my-work-mcp/bin/dubsar-my-work-mcp.mjs", import.meta.url));
const vectorPath = fileURLToPath(
  new URL("../packages/dubsar-my-work-mcp/vectors/controller-canonical-v1.json", import.meta.url),
);
const sha = "a".repeat(40);
const repo = "https://github.com/owner/repo";

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

test("E2E subprocess restarts after prepare and after attach, then rereads contract and receipt", async () => {
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
        title: "E2E",
        objective: "Parcours stdio",
        criteria: ["Sous-processus"],
        target_repository_url: repo,
        starting_sha: sha,
        allowed_paths: ["packages/dubsar-my-work-mcp/**"],
      },
    });
    mission = prepared.result.structuredContent;
    assert.equal(mission.ticket_id, "DUB-001");
    assert.equal(mission.tool, "create_dubsar_work_cursor_agent");
    assert.equal(mission.arguments.correction_budget, 3);
    assert.equal(mission.arguments.ticket_id, "DUB-001");
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
    assert.equal(body.prepared_contract.contract_fingerprint, mission.arguments.contract_fingerprint);
    assert.equal(body.prepared_contract.pr_repository_url, repo);
    assert.equal(body.attached_receipt, null);
    const receipt = {
      receipt_version: "dubsar.cursor-launch-receipt/1",
      target_repository_url: mission.arguments.target_repository_url,
      contract_fingerprint: mission.arguments.contract_fingerprint,
      repository_refs: mission.arguments.repository_refs,
      ticket_id: "DUB-001",
      agent_id: "agent-1",
      run_id: "run-1",
      source_url: "https://cursor.example/runs/1",
      status: "launched",
      bounds: mission.arguments.bounds,
    };
    const attached = await afterPrepare.call("tools/call", {
      name: "attach_cursor_receipt",
      arguments: { ...context, ticket_id: "DUB-001", receipt },
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
    assert.equal(body.prepared_contract.contract_fingerprint, mission.arguments.contract_fingerprint);
    assert.equal(body.attached_receipt.run_id, "run-1");
    const synced = await afterAttach.call("tools/call", {
      name: "sync_cursor_status",
      arguments: {
        ...context,
        ticket_id: "DUB-001",
        cursor_observation: {
          source: "trusted_cursor_observer",
          ticket_id: "DUB-001",
          agent_id: "agent-1",
          run_id: "run-1",
          lifecycle: "running",
          pr: null,
        },
        github_observation: null,
      },
    });
    assert.equal(synced.result.structuredContent.ticket.state, "In Progress");
    const persisted = (await readTickets({ start })).tickets[0];
    assert.equal(persisted.cursor_launch.run_id, "run-1");
    assert.equal(persisted.references[0], mission.arguments.contract_fingerprint);
    assert.equal(vector.controller_tool, "create_dubsar_work_cursor_agent");
  } finally {
    await stopServer(afterAttach.child);
  }
});
