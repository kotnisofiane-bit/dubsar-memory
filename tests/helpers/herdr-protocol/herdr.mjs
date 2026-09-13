#!/usr/bin/env node
/**
 * Controlled Herdr CLI protocol for tests. Not the real Herdr binary.
 * Speaks the documented subset: workspace create --cwd/--no-focus,
 * agent start --kind codex --pane -- exec|exec resume ID,
 * agent prompt, agent get, agent send-keys ctrl+c.
 */
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const cwd = process.cwd();
const statePath = path.join(cwd, ".dubsar", "herdr-protocol-state.json");

async function loadState() {
  try {
    return JSON.parse(await readFile(statePath, "utf8"));
  } catch {
    return { workspaces: {}, agents: {} };
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
    state.workspaces[workspaceId] = { workspace_id: workspaceId, pane_id: paneId, cwd: cwdFlag.value, label: labelFlag.value };
    await saveState(state);
    json({
      workspace: { workspace_id: workspaceId, cwd: cwdFlag.value },
      root_pane: { pane_id: paneId },
    });
  }
} else if (command === "agent" && rest[0] === "start") {
  const name = rest[1];
  const paneIndex = rest.indexOf("--pane");
  const paneId = paneIndex >= 0 ? rest[paneIndex + 1] : null;
  const kindIndex = rest.indexOf("--kind");
  const kind = kindIndex >= 0 ? rest[kindIndex + 1] : null;
  const dash = rest.indexOf("--");
  const agentArgs = dash >= 0 ? rest.slice(dash + 1) : [];
  if (kind !== "codex" || !paneId || !name) {
    fail("usage", "agent start requires name, --kind codex, --pane");
  } else if (agentArgs[0] !== "exec") {
    fail("usage", "codex args must start with exec");
  } else {
    const state = await loadState();
    const workspace = Object.values(state.workspaces).find((item) => item.pane_id === paneId);
    if (!workspace) {
      fail("pane_missing", "unknown pane");
    } else if (agentArgs[1] === "resume") {
      const sessionId = agentArgs[2];
      const agent = state.agents[name];
      if (!agent || agent.session_id !== sessionId) {
        fail("session_missing", "unknown session");
      } else if (agentArgs.length < 3) {
        fail("usage", "resume requires session id");
      } else {
        agent.mode = "resume";
        await saveState(state);
        json({ name, pane_id: paneId, session_ref: { kind: "id", value: sessionId } });
      }
    } else if (agentArgs.length !== 1) {
      fail("usage", "launch exec takes no extra args");
    } else {
      const sessionId = `codex_${randomBytes(8).toString("hex")}`;
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        cwd,
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
      child.unref();
      state.agents[name] = {
        name,
        pane_id: paneId,
        session_id: sessionId,
        pid: child.pid,
        running: true,
        mode: "exec",
      };
      await saveState(state);
      json({ name, pane_id: paneId, session_ref: { kind: "id", value: sessionId } });
    }
  }
} else if (command === "agent" && rest[0] === "prompt") {
  const name = rest[1];
  const dash = rest.indexOf("--");
  const promptParts = dash >= 0 ? rest.slice(dash + 1) : rest.slice(2);
  const prompt = promptParts.join(" ");
  if (!prompt || prompt.trim() === "") {
    fail("usage", "prompt required");
  } else {
    const state = await loadState();
    const agent = state.agents[name];
    if (!agent) {
      fail("session_missing", "unknown agent");
    } else {
      const relative = agent.mode === "resume" ? "codex-continue.txt" : "codex-launch.txt";
      await writeFile(path.join(cwd, relative), `${prompt}\n`);
      agent.last_prompt = prompt;
      await saveState(state);
      json({ name, accepted: true, waited: false });
    }
  }
} else if (command === "agent" && rest[0] === "get") {
  const name = rest[1];
  const state = await loadState();
  const agent = state.agents[name];
  if (!agent) {
    fail("session_missing", "unknown agent");
  } else {
    json({
      name,
      session_ref: { kind: "id", value: agent.session_id },
      native_session_id: agent.session_id,
      running: agent.running === true,
      logging_error: false,
    });
  }
} else if (command === "agent" && rest[0] === "send-keys") {
  const name = rest[1];
  const key = rest[2];
  if (key !== "ctrl+c") {
    fail("usage", "only ctrl+c is implemented in the protocol double");
  } else {
    const state = await loadState();
    const agent = state.agents[name];
    if (!agent) {
      fail("session_missing", "unknown agent");
    } else {
      if (agent.pid) {
        try {
          process.kill(agent.pid, "SIGTERM");
        } catch {
          // process may have already exited; interruption is still recorded
        }
      }
      agent.running = false;
      await saveState(state);
      await writeFile(path.join(cwd, "codex-interrupted.flag"), "interrupted\n");
      json({ name, interrupted: true, running: false });
    }
  }
} else if (command === "workspace" && rest[0] === "close") {
  fail("forbidden", "adapter must not close workspaces");
} else {
  fail("unknown", argv.join(" "));
}
