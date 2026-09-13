import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, unlink, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";
import { executeTool, HERMES_TOOL_NAMES, TOOL_NAMES } from "../packages/dubsar-my-work-mcp/src/tools.mjs";
import { createFrameParser, encodeFrame, setMcpProfile } from "../packages/dubsar-my-work-mcp/src/server.mjs";
import { createHerdrCodexExecutor, resetTestCodexExecutor } from "../packages/dubsar-my-work-mcp/src/codex-executor.mjs";
import { listenHermesMcpSocket } from "../packages/dubsar-my-work-mcp/src/hermes-transport.mjs";
import { readSupervisorRun } from "../packages/dubsar-my-work-mcp/src/codex-supervisor.mjs";
import { readTickets } from "../packages/dubsar-workbench-launcher/src/registry-store.mjs";

const herdrBin = fileURLToPath(new URL("./helpers/herdr-protocol/herdr.mjs", import.meta.url));
const codexBin = fileURLToPath(new URL("./helpers/codex-protocol/codex.mjs", import.meta.url));
const previousHerdr = process.env.DUBSAR_HERDR_BIN;
const previousCodex = process.env.DUBSAR_CODEX_BIN;
const previousHold = process.env.CODEX_PROTOCOL_HOLD;

function useProtocolBins() {
  process.env.DUBSAR_HERDR_BIN = herdrBin;
  process.env.DUBSAR_CODEX_BIN = codexBin;
  delete process.env.CODEX_PROTOCOL_HOLD;
  resetTestCodexExecutor();
}

function restoreBins() {
  if (previousHerdr == null) delete process.env.DUBSAR_HERDR_BIN;
  else process.env.DUBSAR_HERDR_BIN = previousHerdr;
  if (previousCodex == null) delete process.env.DUBSAR_CODEX_BIN;
  else process.env.DUBSAR_CODEX_BIN = previousCodex;
  if (previousHold == null) delete process.env.CODEX_PROTOCOL_HOLD;
  else process.env.CODEX_PROTOCOL_HOLD = previousHold;
}

async function env() {
  const start = await mkdtemp(path.join(tmpdir(), "dubsar-codex-project-"));
  const allocationRoot = await mkdtemp(path.join(tmpdir(), "dubsar-codex-global-"));
  await mkdir(path.join(start, ".dubsar"));
  return { start, allocation_root: allocationRoot, project_id: "project-codex" };
}

function runCli(cwd, bin, args, extraEnv = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [bin, ...args], {
      cwd,
      env: { ...process.env, ...extraEnv },
    });
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

async function waitSupervisorStatus(allocationRoot, ticketId, status) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const run = await readSupervisorRun(allocationRoot, ticketId);
    if (run?.status === status) return run;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`supervisor-status-timeout:${status}`);
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

test("short finished task persists durable session after Herdr agent_not_found", async (t) => {
  t.after(restoreBins);
  useProtocolBins();
  const context = await env();
  const launched = await executeTool("launch_codex_mission", { ...context, ...mission() });
  assert.equal(launched.launched, true);
  assert.equal(launched.mission_success, false);
  assert.match(launched.herdr_id, /^ws_[0-9a-f]+\/pane_[0-9a-f]+$/u);
  assert.match(launched.codex_session_id, /^codex_[0-9a-f]+$/u);
  assert.equal(await readFile(path.join(context.start, "codex-launch.txt"), "utf8"), "Ecrire le fichier de lancement\n");
  await waitSupervisorStatus(context.allocation_root, "DUB-001", "exited");
  const herdrGet = await runCli(context.start, herdrBin, ["agent", "get", "d001"]);
  assert.notEqual(herdrGet.code, 0);
  assert.match(herdrGet.stderr, /agent_not_found/u);
  const loaded = await executeTool("get_ticket", { ...context, ticket_id: "DUB-001" });
  assert.equal(loaded.codex_session_id, launched.codex_session_id);
  assert.equal(loaded.herdr_id, launched.herdr_id);
  assert.equal(loaded.herdr_live, "not_found");
  const durable = await readSupervisorRun(context.allocation_root, "DUB-001");
  assert.equal(durable.codex_session_id, launched.codex_session_id);
  const store = await readTickets({ start: context.start });
  assert.equal(store.tickets.length, 1);
  assert.equal(store.tickets[0].cursor_launch, null);
});

test("consultation and continue reuse the same Codex id after MCP-side durable record", async (t) => {
  t.after(restoreBins);
  useProtocolBins();
  const context = await env();
  const launched = await executeTool("launch_codex_mission", { ...context, ...mission() });
  await waitSupervisorStatus(context.allocation_root, "DUB-001", "exited");
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

test("stop of an already finished short task is not interruption or success", async (t) => {
  t.after(restoreBins);
  useProtocolBins();
  const context = await env();
  await executeTool("launch_codex_mission", { ...context, ...mission() });
  await waitSupervisorStatus(context.allocation_root, "DUB-001", "exited");
  const stopped = await executeTool("stop_codex_mission", { ...context, ticket_id: "DUB-001" });
  assert.equal(stopped.already_finished, true);
  assert.equal(stopped.interrupted, false);
  assert.equal(stopped.mission_success, false);
  assert.equal(await readFile(path.join(context.start, "codex-launch.txt"), "utf8"), "Ecrire le fichier de lancement\n");
});

test("stop of a live long task is observed by the supervisor", async (t) => {
  t.after(restoreBins);
  useProtocolBins();
  process.env.CODEX_PROTOCOL_HOLD = "1";
  const context = await env();
  await executeTool("launch_codex_mission", { ...context, ...mission() });
  const stopped = await executeTool("stop_codex_mission", { ...context, ticket_id: "DUB-001" });
  assert.equal(stopped.interrupted, true);
  assert.equal(stopped.mission_success, false);
  assert.equal(await readFile(path.join(context.start, "codex-interrupted.flag"), "utf8"), "interrupted\n");
});

test("missing observation is ambiguous and does not launch again", async (t) => {
  t.after(restoreBins);
  useProtocolBins();
  const context = await env();
  await executeTool("launch_codex_mission", { ...context, ...mission() });
  await waitSupervisorStatus(context.allocation_root, "DUB-001", "exited");
  await unlink(path.join(context.allocation_root, "codex-supervisor.json"));
  await assert.rejects(executeTool("stop_codex_mission", { ...context, ticket_id: "DUB-001" }), {
    code: "MY_WORK_CODEX_STOP_AMBIGUOUS",
  });
  const store = await readTickets({ start: context.start });
  assert.equal(store.tickets.length, 1);
});

test("omitted prompt, missing binaries, --last, and out-of-scope cwd fail closed", async (t) => {
  t.after(restoreBins);
  useProtocolBins();
  const context = await env();
  const executor = createHerdrCodexExecutor();
  await assert.rejects(
    executor.exec({
      ticketId: "DUB-001",
      workspaceRoot: context.start,
      authorizedWorkspace: context.start,
      allocationRoot: context.allocation_root,
    }),
    { code: "MY_WORK_MISSION_INCOMPLETE" },
  );
  const bare = await runCli(context.start, codexBin, ["exec", "--json"], {
    CODEX_HOME: path.join(context.allocation_root, "codex-native"),
  });
  assert.notEqual(bare.code, 0);
  assert.match(bare.stderr, /No prompt provided/u);
  const last = await runCli(context.start, codexBin, ["exec", "resume", "--last", "--json", "--", "x"], {
    CODEX_HOME: path.join(context.allocation_root, "codex-native"),
  });
  assert.notEqual(last.code, 0);
  process.env.DUBSAR_HERDR_BIN = path.join(context.start, "missing-herdr");
  await assert.rejects(
    createHerdrCodexExecutor().exec({
      ticketId: "DUB-001",
      workspaceRoot: context.start,
      authorizedWorkspace: context.start,
      allocationRoot: context.allocation_root,
      prompt: "x",
    }),
    { code: "MY_WORK_HERDR_UNAVAILABLE" },
  );
  useProtocolBins();
  process.env.DUBSAR_CODEX_BIN = path.join(context.start, "missing-codex");
  await assert.rejects(
    createHerdrCodexExecutor().exec({
      ticketId: "DUB-001",
      workspaceRoot: context.start,
      authorizedWorkspace: context.start,
      allocationRoot: context.allocation_root,
      prompt: "x",
    }),
    { code: "MY_WORK_CODEX_UNAVAILABLE" },
  );
  useProtocolBins();
  const outside = await mkdtemp(path.join(tmpdir(), "dubsar-outside-"));
  await assert.rejects(
    createHerdrCodexExecutor().exec({
      ticketId: "DUB-001",
      workspaceRoot: outside,
      authorizedWorkspace: context.start,
      allocationRoot: context.allocation_root,
      prompt: "x",
    }),
    { code: "MY_WORK_SCOPE_EXTENSION" },
  );
});

test("PROOF.md and workspace claims do not override service-side session identity", async (t) => {
  t.after(restoreBins);
  useProtocolBins();
  const context = await env();
  await writeFile(path.join(context.start, "PROOF.md"), "success");
  const launched = await executeTool("launch_codex_mission", { ...context, ...mission() });
  await writeFile(path.join(context.start, "forged-session.txt"), "codex-sess-DUB-001\n");
  const loaded = await executeTool("get_ticket", { ...context, ticket_id: "DUB-001" });
  assert.equal(loaded.codex_session_id, launched.codex_session_id);
  assert.equal(loaded.codex_session_id.startsWith("codex-sess-DUB-"), false);
  assert.equal(launched.mission_success, false);
  setMcpProfile("hermes");
  t.after(() => setMcpProfile("default"));
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
