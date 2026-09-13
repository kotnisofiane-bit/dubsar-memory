import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { encodeFrame, createFrameParser } from "../packages/dubsar-my-work-mcp/src/server.mjs";
import { readSupervisorRun } from "../packages/dubsar-my-work-mcp/src/codex-supervisor.mjs";

const bin = fileURLToPath(new URL("../packages/dubsar-my-work-mcp/bin/dubsar-my-work-mcp.mjs", import.meta.url));
const herdrBin = fileURLToPath(new URL("./helpers/herdr-protocol/herdr.mjs", import.meta.url));
const codexBin = fileURLToPath(new URL("./helpers/codex-protocol/codex.mjs", import.meta.url));

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
    child.stdin.write(encodeFrame({ jsonrpc: "2.0", id, method, params }));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout:${method}`)), 15_000);
      pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
    });
  };
}

function startServer(workspace, extraEnv = {}) {
  const child = spawn(process.execPath, [bin, "--profile", extraEnv.PROFILE ?? "default"], {
    cwd: workspace,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      DUBSAR_HERDR_BIN: herdrBin,
      DUBSAR_CODEX_BIN: codexBin,
      ...extraEnv,
    },
  });
  return { child, call: rpc(child) };
}

async function stopServer(child) {
  child.stdin.end();
  child.kill("SIGTERM");
  await new Promise((resolve) => child.once("exit", resolve));
}

test("E2E Herdr protocol: launch file, restart, continue file, observed stop", async () => {
  const start = await mkdtemp(path.join(tmpdir(), "dubsar-codex-e2e-project-"));
  const allocationRoot = await mkdtemp(path.join(tmpdir(), "dubsar-codex-e2e-global-"));
  await mkdir(path.join(start, ".dubsar"));
  const context = { start, allocation_root: allocationRoot, project_id: "project-e2e-codex" };

  const first = startServer(start);
  let sessionId;
  let herdrId;
  try {
    await first.call("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test" } });
    const launched = await first.call("tools/call", {
      name: "launch_codex_mission",
      arguments: {
        ...context,
        title: "E2E Codex",
        objective: "Un seul lancement",
        criteria: ["Fichier attendu"],
        allowed_paths: ["packages/dubsar-my-work-mcp/**"],
        mission: "Contenu de lancement E2E",
      },
    });
    assert.equal(launched.result.isError, false, JSON.stringify(launched.result));
    const body = launched.result.structuredContent;
    assert.equal(body.ticket_id, "DUB-001");
    assert.equal(body.launched, true);
    assert.equal(body.mission_success, false);
    sessionId = body.codex_session_id;
    herdrId = body.herdr_id;
    assert.match(herdrId, /^ws_/u);
    assert.equal(herdrId.startsWith("herdr-"), false);
  } finally {
    await stopServer(first.child);
  }

  assert.equal(await readFile(path.join(start, "codex-launch.txt"), "utf8"), "Contenu de lancement E2E\n");

  const afterRestart = startServer(start);
  try {
    await afterRestart.call("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test" } });
    const loaded = await afterRestart.call("tools/call", {
      name: "get_ticket",
      arguments: { ...context, ticket_id: "DUB-001" },
    });
    const ticket = loaded.result.structuredContent;
    assert.equal(ticket.codex_session_id, sessionId);
    assert.equal(ticket.herdr_id, herdrId);
    const continued = await afterRestart.call("tools/call", {
      name: "continue_codex_mission",
      arguments: { ...context, ticket_id: "DUB-001", prompt: "Contenu de continuation E2E" },
    });
    assert.equal(continued.result.structuredContent.codex_session_id, sessionId);
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const run = await readSupervisorRun(allocationRoot, "DUB-001");
      if (run?.status === "exited") break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const stopped = await afterRestart.call("tools/call", {
      name: "stop_codex_mission",
      arguments: { ...context, ticket_id: "DUB-001" },
    });
    assert.equal(stopped.result.structuredContent.mission_success, false);
    assert.equal(stopped.result.structuredContent.already_finished, true);
    assert.equal(stopped.result.structuredContent.interrupted, false);
  } finally {
    await stopServer(afterRestart.child);
  }

  assert.equal(await readFile(path.join(start, "codex-continue.txt"), "utf8"), "Contenu de continuation E2E\n");

  const hermes = startServer(start, { PROFILE: "hermes" });
  try {
    await hermes.call("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "hermes" } });
    const tools = await hermes.call("tools/list");
    assert.deepEqual(tools.result.tools.map((tool) => tool.name), [
      "list_tickets",
      "get_ticket",
      "launch_codex_mission",
      "continue_codex_mission",
      "stop_codex_mission",
    ]);
  } finally {
    await stopServer(hermes.child);
  }
});
