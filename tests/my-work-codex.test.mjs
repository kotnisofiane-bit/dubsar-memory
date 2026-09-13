import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";
import { executeTool, HERMES_TOOL_NAMES, TOOL_NAMES } from "../packages/dubsar-my-work-mcp/src/tools.mjs";
import { createFrameParser, encodeFrame, handleMessage, setMcpProfile } from "../packages/dubsar-my-work-mcp/src/server.mjs";
import { createHerdrCodexExecutor, resetTestCodexExecutor } from "../packages/dubsar-my-work-mcp/src/codex-executor.mjs";
import { listenHermesMcpSocket } from "../packages/dubsar-my-work-mcp/src/hermes-transport.mjs";
import { readTickets } from "../packages/dubsar-workbench-launcher/src/registry-store.mjs";

const herdrBin = fileURLToPath(new URL("./helpers/herdr-protocol/herdr.mjs", import.meta.url));
const previousHerdr = process.env.DUBSAR_HERDR_BIN;

function useProtocolHerdr() {
  process.env.DUBSAR_HERDR_BIN = herdrBin;
  resetTestCodexExecutor();
}

async function env() {
  const start = await mkdtemp(path.join(tmpdir(), "dubsar-codex-project-"));
  const allocationRoot = await mkdtemp(path.join(tmpdir(), "dubsar-codex-global-"));
  await mkdir(path.join(start, ".dubsar"));
  return { start, allocation_root: allocationRoot, project_id: "project-codex" };
}

function runProtocol(cwd, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [herdrBin, ...args], { cwd, env: process.env });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("close", (code) => {
      resolve({
        code,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}

function mission(extra = {}) {
  return {
    title: "Lot Codex local",
    objective: "Lancer une session Herdr bornée",
    criteria: ["Ticket unique", "Reprise par identifiant"],
    allowed_paths: ["packages/dubsar-my-work-mcp/**"],
    mission: "Ecrire le fichier de lancement",
    ...extra,
  };
}

test("production Herdr path persists one ticket, captured ids, and independent launch file", async (t) => {
  t.after(() => {
    if (previousHerdr == null) delete process.env.DUBSAR_HERDR_BIN;
    else process.env.DUBSAR_HERDR_BIN = previousHerdr;
  });
  useProtocolHerdr();
  const context = await env();
  const launched = await executeTool("launch_codex_mission", { ...context, ...mission() });
  assert.equal(launched.launched, true);
  assert.equal(launched.mission_success, false);
  assert.match(launched.herdr_id, /^ws_[0-9a-f]+\/pane_[0-9a-f]+$/u);
  assert.match(launched.codex_session_id, /^codex_[0-9a-f]+$/u);
  assert.equal(launched.herdr_id.startsWith("herdr-"), false);
  const fromDisk = await readFile(path.join(context.start, "codex-launch.txt"), "utf8");
  assert.equal(fromDisk, "Ecrire le fichier de lancement\n");
  const store = await readTickets({ start: context.start });
  assert.equal(store.tickets.length, 1);
  assert.equal(store.tickets[0].cursor_launch, null);
});

test("consultation finds contract, Herdr id and Codex id after reread", async (t) => {
  t.after(() => {
    if (previousHerdr == null) delete process.env.DUBSAR_HERDR_BIN;
    else process.env.DUBSAR_HERDR_BIN = previousHerdr;
  });
  useProtocolHerdr();
  const context = await env();
  await executeTool("launch_codex_mission", { ...context, ...mission() });
  const loaded = await executeTool("get_ticket", { ...context, ticket_id: "DUB-001" });
  assert.equal(loaded.prepared_codex_contract.format, "dubsar.codex-local-contract/1");
  assert.match(loaded.herdr_id, /^ws_/u);
  assert.match(loaded.codex_session_id, /^codex_/u);
  assert.ok(loaded.ticket.activity.some((row) => row.kind === "codex_trace"));
});

test("continuation reuses the Codex id and writes a second independent file", async (t) => {
  t.after(() => {
    if (previousHerdr == null) delete process.env.DUBSAR_HERDR_BIN;
    else process.env.DUBSAR_HERDR_BIN = previousHerdr;
  });
  useProtocolHerdr();
  const context = await env();
  const launched = await executeTool("launch_codex_mission", { ...context, ...mission() });
  const continued = await executeTool("continue_codex_mission", {
    ...context,
    ticket_id: "DUB-001",
    prompt: "Ecrire le fichier de continuation",
    codex_session_id: launched.codex_session_id,
  });
  assert.equal(continued.codex_session_id, launched.codex_session_id);
  assert.equal(continued.herdr_id, launched.herdr_id);
  assert.equal(await readFile(path.join(context.start, "codex-continue.txt"), "utf8"), "Ecrire le fichier de continuation\n");
});

test("stop interrupts the live protocol process and is not mission success", async (t) => {
  t.after(() => {
    if (previousHerdr == null) delete process.env.DUBSAR_HERDR_BIN;
    else process.env.DUBSAR_HERDR_BIN = previousHerdr;
  });
  useProtocolHerdr();
  const context = await env();
  await executeTool("launch_codex_mission", { ...context, ...mission() });
  const stopped = await executeTool("stop_codex_mission", { ...context, ticket_id: "DUB-001" });
  assert.equal(stopped.interrupted, true);
  assert.equal(stopped.mission_success, false);
  assert.equal(await readFile(path.join(context.start, "codex-interrupted.flag"), "utf8"), "interrupted\n");
  const launchFile = await readFile(path.join(context.start, "codex-launch.txt"), "utf8");
  assert.equal(launchFile, "Ecrire le fichier de lancement\n");
});

test("stop is ambiguous when execution stays running or observation is absent", async (t) => {
  t.after(() => {
    delete process.env.HERDR_PROTOCOL_STOP;
    if (previousHerdr == null) delete process.env.DUBSAR_HERDR_BIN;
    else process.env.DUBSAR_HERDR_BIN = previousHerdr;
  });
  useProtocolHerdr();
  const stillRunning = await env();
  await executeTool("launch_codex_mission", { ...stillRunning, ...mission() });
  process.env.HERDR_PROTOCOL_STOP = "still_running";
  await assert.rejects(executeTool("stop_codex_mission", { ...stillRunning, ticket_id: "DUB-001" }), {
    code: "MY_WORK_CODEX_STOP_AMBIGUOUS",
  });
  delete process.env.HERDR_PROTOCOL_STOP;
  const cleaned = await executeTool("stop_codex_mission", { ...stillRunning, ticket_id: "DUB-001" });
  assert.equal(cleaned.interrupted, true);

  const absent = await env();
  await executeTool("launch_codex_mission", { ...absent, ...mission() });
  process.env.HERDR_PROTOCOL_STOP = "no_observation";
  await assert.rejects(executeTool("stop_codex_mission", { ...absent, ticket_id: "DUB-001" }), {
    code: "MY_WORK_CODEX_STOP_AMBIGUOUS",
  });
  delete process.env.HERDR_PROTOCOL_STOP;
  const observed = await executeTool("stop_codex_mission", { ...absent, ticket_id: "DUB-001" });
  assert.equal(observed.interrupted, true);
  assert.equal(observed.mission_success, false);
});

test("omitted prompt, missing Herdr, fabricated ids, and out-of-scope cwd fail closed", async (t) => {
  t.after(() => {
    if (previousHerdr == null) delete process.env.DUBSAR_HERDR_BIN;
    else process.env.DUBSAR_HERDR_BIN = previousHerdr;
  });
  const context = await env();
  useProtocolHerdr();
  const executor = createHerdrCodexExecutor();
  await assert.rejects(executor.exec({ ticketId: "DUB-001", workspaceRoot: context.start, authorizedWorkspace: context.start }), {
    code: "MY_WORK_MISSION_INCOMPLETE",
  });
  process.env.DUBSAR_HERDR_BIN = path.join(context.start, "missing-herdr");
  await assert.rejects(
    createHerdrCodexExecutor().exec({
      ticketId: "DUB-001",
      workspaceRoot: context.start,
      authorizedWorkspace: context.start,
      prompt: "x",
    }),
    { code: "MY_WORK_HERDR_UNAVAILABLE" },
  );
  const protocolBare = await env();
  const created = await runProtocol(protocolBare.start, [
    "workspace",
    "create",
    "--cwd",
    protocolBare.start,
    "--label",
    "DUB-001",
    "--no-focus",
  ]);
  assert.equal(created.code, 0);
  const paneId = JSON.parse(created.stdout).result.root_pane.pane_id;
  const bare = await runProtocol(protocolBare.start, [
    "agent",
    "start",
    "d001",
    "--kind",
    "codex",
    "--pane",
    paneId,
    "--",
    "exec",
  ]);
  assert.notEqual(bare.code, 0);
  assert.match(bare.stderr, /No prompt provided/u);
  const missing = await runProtocol(protocolBare.start, ["agent", "get", "d001"]);
  assert.notEqual(missing.code, 0);
  assert.match(missing.stderr, /agent_not_found/u);
  const latePrompt = await runProtocol(protocolBare.start, ["agent", "prompt", "d001", "--", "too late"]);
  assert.notEqual(latePrompt.code, 0);
  assert.match(latePrompt.stderr, /too_late/u);
  const outside = await mkdtemp(path.join(tmpdir(), "dubsar-outside-"));
  await assert.rejects(
    createHerdrCodexExecutor().exec({
      ticketId: "DUB-001",
      workspaceRoot: outside,
      authorizedWorkspace: context.start,
      prompt: "x",
    }),
    { code: "MY_WORK_SCOPE_EXTENSION" },
  );
});

test("PROOF.md does not mark success; Hermes socket refuses docker/herdr sockets", async (t) => {
  t.after(() => {
    if (previousHerdr == null) delete process.env.DUBSAR_HERDR_BIN;
    else process.env.DUBSAR_HERDR_BIN = previousHerdr;
    setMcpProfile("default");
  });
  useProtocolHerdr();
  const context = await env();
  await writeFile(path.join(context.start, "PROOF.md"), "success");
  const launched = await executeTool("launch_codex_mission", { ...context, ...mission() });
  assert.equal(launched.mission_success, false);
  setMcpProfile("hermes");
  await assert.rejects(listenHermesMcpSocket("/tmp/docker.sock"), { code: "MY_WORK_HERMES_SOCKET_FORBIDDEN" });
  await assert.rejects(listenHermesMcpSocket("/tmp/herdr.sock"), { code: "MY_WORK_HERMES_SOCKET_FORBIDDEN" });
  const socketPath = path.join(context.start, "hermes.mcp.sock");
  if (process.platform === "win32") {
    await assert.rejects(listenHermesMcpSocket(socketPath), { code: "MY_WORK_HERMES_SOCKET_UNSUPPORTED" });
    assert.equal(TOOL_NAMES.includes("ssh"), false);
    return;
  }
  const server = await listenHermesMcpSocket(socketPath);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const listed = await new Promise((resolve, reject) => {
    const client = net.createConnection({ path: socketPath });
    const timer = setTimeout(() => {
      client.destroy();
      reject(new Error("hermes-socket-timeout"));
    }, 3000);
    const onChunk = createFrameParser((message) => {
      if (message.id !== 1) return;
      clearTimeout(timer);
      client.end();
      resolve(message);
    });
    client.on("data", onChunk);
    client.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    client.on("connect", () => {
      client.write(encodeFrame({ jsonrpc: "2.0", id: 1, method: "tools/list" }));
    });
  });
  assert.deepEqual(listed.result.tools.map((tool) => tool.name), [...HERMES_TOOL_NAMES]);
  assert.equal(TOOL_NAMES.includes("ssh"), false);
});
