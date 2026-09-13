#!/usr/bin/env node
/**
 * Herdr CLI subset matching isolated vendor observations:
 * workspace create is durable host identity; agent names vanish after occupant exit.
 * This double does not invent session_ref, running, interrupted, or process_exited.
 */
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const cwd = process.cwd();
const statePath = path.join(cwd, ".dubsar", "herdr-protocol-state.json");

async function loadState() {
  try {
    return JSON.parse(await readFile(statePath, "utf8"));
  } catch {
    return { workspaces: {} };
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
  process.exitCode = 1;
}

function takeFlag(argv, name) {
  const index = argv.indexOf(name);
  if (index < 0) return { argv, value: null };
  const value = argv[index + 1];
  return { argv: [...argv.slice(0, index), ...argv.slice(index + 2)], value };
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
  } else if (cwdFlag.value !== cwd) {
    fail("cwd_mismatch", "workspace cwd must match process cwd");
  } else {
    const state = await loadState();
    const workspaceId = `ws_${randomBytes(6).toString("hex")}`;
    const paneId = `pane_${randomBytes(6).toString("hex")}`;
    state.workspaces[workspaceId] = {
      workspace_id: workspaceId,
      pane_id: paneId,
      cwd: cwdFlag.value,
      label: labelFlag.value,
    };
    await saveState(state);
    json({
      type: "workspace_created",
      workspace: { workspace_id: workspaceId, cwd: cwdFlag.value },
      root_pane: { pane_id: paneId },
    });
  }
} else if (command === "agent" && rest[0] === "start") {
  const dash = rest.indexOf("--");
  const agentArgs = dash >= 0 ? rest.slice(dash + 1) : [];
  json({
    type: "agent_started",
    agent: { agent_status: "idle", interactive_ready: true, pane_id: rest[rest.indexOf("--pane") + 1] ?? null },
    argv: agentArgs,
  });
} else if (command === "agent" && rest[0] === "get") {
  fail("agent_not_found", "agent_not_found");
} else if (command === "agent" && rest[0] === "prompt") {
  fail("too_late", "agent prompt is not used for non-interactive exec");
} else if (command === "agent" && rest[0] === "send-keys") {
  fail("agent_not_found", "agent name is not a durable process registry");
} else if (command === "workspace" && rest[0] === "close") {
  fail("forbidden", "adapter must not close workspaces");
} else {
  fail("unknown", argv.join(" "));
}
