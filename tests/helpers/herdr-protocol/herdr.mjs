#!/usr/bin/env node
/**
 * Herdr CLI subset: workspace create + non-interactive pane exec.
 * Occupant stdout is forwarded. Agent names are not a durable registry.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
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
  process.exit(1);
}

function takeFlag(argv, name) {
  const index = argv.indexOf(name);
  if (index < 0) return { argv, value: null };
  const value = argv[index + 1];
  return { argv: [...argv.slice(0, index), ...argv.slice(index + 2)], value };
}

function spawnOccupant(bin, args, options) {
  if (bin.endsWith(".mjs") || bin.endsWith(".js")) {
    return spawn(process.execPath, [bin, ...args], options);
  }
  return spawn(bin, args, options);
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
} else if (command === "exec") {
  let args = rest;
  const paneFlag = takeFlag(args, "--pane");
  args = paneFlag.argv;
  const kindFlag = takeFlag(args, "--kind");
  args = kindFlag.argv;
  const dash = args.indexOf("--");
  const occupantArgs = dash >= 0 ? args.slice(dash + 1) : [];
  if (!paneFlag.value || kindFlag.value !== "codex" || occupantArgs[0] !== "exec") {
    fail("usage", "exec requires --pane, --kind codex, and occupant argv after --");
  }
  const state = await loadState();
  const workspace = Object.values(state.workspaces).find((item) => item.pane_id === paneFlag.value);
  if (!workspace) fail("pane_missing", "unknown pane");
  const bin = process.env.DUBSAR_CODEX_BIN || "codex";
  if ((bin.includes("/") || bin.endsWith(".mjs") || bin.endsWith(".js")) && !existsSync(bin)) {
    process.stderr.write(`${JSON.stringify({ error: { code: "codex_unavailable", message: "codex occupant spawn failed" } })}\n`);
    process.exitCode = 1;
  } else {
    const occupantEnv = { ...process.env, HERDR_PANE_ID: paneFlag.value, HERDR_WORKSPACE_ID: workspace.workspace_id };
    delete occupantEnv.HERDR_ENV;
    const child = spawnOccupant(bin, occupantArgs, {
      cwd,
      env: occupantEnv,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    child.on("error", () => {
      process.stderr.write(`${JSON.stringify({ error: { code: "codex_unavailable", message: "codex occupant spawn failed" } })}\n`);
    });
    child.stdout?.pipe(process.stdout);
    child.stderr?.on("data", (chunk) => process.stderr.write(chunk));
    const stopOccupant = () => {
      try {
        child.kill("SIGTERM");
      } catch {
        // already gone
      }
    };
    process.on("SIGTERM", stopOccupant);
    process.on("SIGINT", stopOccupant);
    const code = await new Promise((resolve) => {
      child.on("error", () => resolve(127));
      child.on("close", (exitCode) => resolve(exitCode ?? 1));
    });
    process.exitCode = code;
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
