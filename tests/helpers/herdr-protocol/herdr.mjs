#!/usr/bin/env node
/**
 * Herdr CLI subset matching observed primitives:
 * workspace create, pane run, pane read, pane process-info.
 * `herdr exec` is not established and is refused.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { existsSync, openSync } from "node:fs";
import path from "node:path";

const cwd = process.cwd();
const statePath = path.join(cwd, ".dubsar", "herdr-protocol-state.json");

async function loadState() {
  try {
    return JSON.parse(await readFile(statePath, "utf8"));
  } catch {
    return { workspaces: {}, panes: {} };
  }
}

async function saveState(state) {
  await mkdir(path.dirname(statePath), { recursive: true });
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
}

function json(result) {
  process.stdout.write(`${JSON.stringify({ result })}\n`);
}

function fail(code, message) {
  process.stderr.write(`${JSON.stringify({ error: { code, message } })}\n`);
  process.exit(1);
}

function takeFlag(argv, name) {
  const index = argv.indexOf(name);
  if (index < 0) return { argv, value: null };
  const value = argv[index + 1];
  return { argv: [...argv.slice(0, index), ...argv.slice(index + 2)], value };
}

function spawnArgv(bin, args) {
  if (bin.endsWith(".mjs") || bin.endsWith(".js")) {
    return { command: process.execPath, argv: [bin, ...args] };
  }
  return { command: bin, argv: args };
}

function peelEnv(argv) {
  if (argv[0] !== "env") return { env: {}, rest: argv };
  const extra = {};
  let index = 1;
  while (index < argv.length && argv[index].includes("=") && !argv[index].startsWith("-")) {
    const eq = argv[index].indexOf("=");
    extra[argv[index].slice(0, eq)] = argv[index].slice(eq + 1);
    index += 1;
  }
  return { env: extra, rest: argv.slice(index) };
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(error && error.code === "EPERM");
  }
}

const argv = process.argv.slice(2);
const command = argv[0];
const rest = argv.slice(1);

if (command === "workspace" && rest[0] === "create") {
  let args = rest.slice(1);
  const cwdFlag = takeFlag(args, "--cwd");
  args = cwdFlag.argv;
  const labelFlag = takeFlag(args, "--label");
  args = labelFlag.argv;
  const noFocus = args.includes("--no-focus");
  if (!cwdFlag.value || !noFocus) {
    fail("usage", "workspace create requires --cwd and --no-focus");
  } else {
    let cwdReal;
    let flagReal;
    try {
      cwdReal = await realpath(cwd);
      flagReal = await realpath(cwdFlag.value);
    } catch {
      fail("cwd_mismatch", "workspace cwd must exist");
    }
    if (cwdReal !== flagReal) {
      fail("cwd_mismatch", "workspace cwd must match process cwd");
    }
    const state = await loadState();
    const workspaceId = `ws_${randomBytes(6).toString("hex")}`;
    const paneId = `pane_${randomBytes(6).toString("hex")}`;
    const logPath = path.join(cwd, ".dubsar", `pane-${paneId}.out`);
    state.workspaces[workspaceId] = {
      workspace_id: workspaceId,
      pane_id: paneId,
      cwd: cwdFlag.value,
      label: labelFlag.value,
    };
    state.panes[paneId] = {
      pane_id: paneId,
      workspace_id: workspaceId,
      log_path: logPath,
      shell_pid: process.pid,
      occupant_pids: [],
      pgid: null,
    };
    await saveState(state);
    json({
      type: "workspace_created",
      workspace: { workspace_id: workspaceId, cwd: cwdFlag.value },
      root_pane: { pane_id: paneId },
    });
  }
} else if (command === "pane" && rest[0] === "run") {
  const paneId = rest[1];
  const commandArgv = rest.slice(2);
  if (!paneId || commandArgv.length < 1) fail("usage", "pane run PANE_ID COMMAND");
  const state = await loadState();
  const pane = state.panes[paneId];
  if (!pane) fail("pane_missing", "unknown pane");
  const peeled = peelEnv(commandArgv);
  if (peeled.rest.length < 1) fail("usage", "pane run requires a command");
  await mkdir(path.join(cwd, ".dubsar"), { recursive: true });
  const logPath = pane.log_path ?? path.join(cwd, ".dubsar", `pane-${paneId}.out`);
  const outFd = openSync(logPath, "a");
  const launched = spawnArgv(peeled.rest[0], peeled.rest.slice(1));
  const child = spawn(launched.command, launched.argv, {
    cwd,
    env: { ...process.env, ...peeled.env },
    windowsHide: true,
    detached: true,
    stdio: ["ignore", outFd, outFd],
  });
  child.on("error", () => fail("codex_unavailable", "pane occupant spawn failed"));
  if (!Number.isInteger(child.pid)) fail("codex_unavailable", "pane occupant spawn failed");
  child.unref();
  pane.log_path = logPath;
  pane.occupant_pids = [child.pid];
  pane.pgid = child.pid;
  await saveState(state);
  json({ type: "command_submitted", pane_id: paneId });
  process.exit(0);
} else if (command === "pane" && rest[0] === "read") {
  let args = rest.slice(1);
  const paneFlag = takeFlag(args, "--pane");
  args = paneFlag.argv;
  const sourceFlag = takeFlag(args, "--source");
  if (sourceFlag.value !== "recent-unwrapped") fail("usage", "pane read requires --source recent-unwrapped");
  const state = await loadState();
  const pane = state.panes[paneFlag.value];
  if (!pane) fail("pane_missing", "unknown pane");
  let text = "";
  try {
    text = await readFile(pane.log_path, "utf8");
  } catch {
    text = "";
  }
  json({ type: "pane_read", source: "recent-unwrapped", text });
} else if (command === "pane" && rest[0] === "process-info") {
  let args = rest.slice(1);
  const paneFlag = takeFlag(args, "--pane");
  if (!paneFlag.value) fail("usage", "process-info requires --pane");
  const state = await loadState();
  const pane = state.panes[paneFlag.value];
  if (!pane) fail("pane_missing", "unknown pane");
  const live = (pane.occupant_pids ?? []).filter((pid) => pidAlive(pid));
  json({
    process_info: {
      foreground_process_group_id: live.length > 0 ? pane.pgid : null,
      foreground_processes: live.map((pid) => ({ pid, comm: "codex" })),
      shell_pid: pane.shell_pid,
    },
  });
} else if (command === "exec") {
  fail("unknown", "herdr exec is not an established Herdr interface");
} else if (command === "agent" && rest[0] === "get") {
  fail("agent_not_found", "agent_not_found");
} else if (command === "workspace" && rest[0] === "close") {
  fail("forbidden", "adapter must not close workspaces");
} else {
  fail("unknown", argv.join(" "));
}
