import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { encodeFrame, createFrameParser } from "../packages/dubsar-my-work-mcp/src/server.mjs";
import { readTickets } from "../packages/dubsar-workbench-launcher/src/registry-store.mjs";

const bin = fileURLToPath(new URL("../packages/dubsar-my-work-mcp/bin/dubsar-my-work-mcp.mjs", import.meta.url));
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

test("E2E subprocess initialize, list, prepare, attach, sync on temporary stores", async () => {
  const start = await mkdtemp(path.join(tmpdir(), "dubsar-mcp-e2e-project-"));
  const allocationRoot = await mkdtemp(path.join(tmpdir(), "dubsar-mcp-e2e-global-"));
  await mkdir(path.join(start, ".dubsar"));
  const child = spawn(process.execPath, [bin], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { PATH: process.env.PATH, TMPDIR: tmpdir() },
  });
  const call = rpc(child);
  try {
    const initialized = await call("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test" } });
    assert.equal(initialized.result.serverInfo.name, "dubsar-my-work");
    child.stdin.write(encodeFrame({ jsonrpc: "2.0", method: "notifications/initialized" }));
    const tools = await call("tools/list");
    assert.equal(tools.result.tools.length, 5);
    const context = { start, allocation_root: allocationRoot, project_id: "project-e2e" };
    const listed = await call("tools/call", { name: "list_tickets", arguments: context });
    assert.equal(listed.result.isError, false);
    assert.equal(JSON.parse(listed.result.content[0].text).tickets.length, 0);
    const prepared = await call("tools/call", {
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
    const mission = prepared.result.structuredContent;
    assert.equal(mission.ticket_id, "DUB-001");
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));
    const restarted = spawn(process.execPath, [bin], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { PATH: process.env.PATH, TMPDIR: tmpdir() },
    });
    const callAgain = rpc(restarted);
    try {
      await callAgain("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test" } });
      const reread = await callAgain("tools/call", { name: "get_ticket", arguments: { ...context, ticket_id: "DUB-001" } });
      assert.equal(reread.result.structuredContent.ticket.state, "Backlog");
      const receipt = {
        receipt_version: "dubsar.cursor-launch-receipt/1",
        target_repository_url: mission.envelope.target_repository_url,
        contract_fingerprint: mission.envelope.contract_fingerprint,
        repository_refs: mission.envelope.repository_refs,
        ticket_id: "DUB-001",
        agent_id: "agent-1",
        run_id: "run-1",
        source_url: "https://cursor.example/runs/1",
        status: "launched",
        bounds: mission.envelope.bounds,
      };
      const attached = await callAgain("tools/call", {
        name: "attach_cursor_receipt",
        arguments: { ...context, ticket_id: "DUB-001", receipt },
      });
      assert.equal(attached.result.structuredContent.state, "In Progress");
      const synced = await callAgain("tools/call", {
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
      assert.equal(persisted.references[0], mission.envelope.contract_fingerprint);
    } finally {
      restarted.stdin.end();
      restarted.kill("SIGTERM");
    }
  } finally {
    if (!child.killed) child.kill("SIGTERM");
  }
});
