#!/usr/bin/env node
/**
 * Controlled Herdr CLI protocol for tests. Not the real Herdr binary.
 * Speaks the documented subset: workspace create --cwd/--no-focus,
 * agent start --kind codex --pane -- exec -- <prompt> |
 * exec resume ID -- <prompt>, agent get, agent send-keys ctrl+c.
 * Bare `exec` (no prompt) reproduces vendor Codex: agent never stays up.
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

function promptFrom(agentArgs, startIndex) {
  const parts = agentArgs.slice(startIndex);
  const text = (parts[0] === "--" ? parts.slice(1) : parts).join(" ");
  return text;
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
  } else if (agentArgs[1] === "resume") {
    const sessionId = agentArgs[2];
    const prompt = promptFrom(agentArgs, 3);
    const state = await loadState();
    const agent = state.agents[name];
    if (!sessionId || agentArgs.length < 3) {
      fail("usage", "resume requires session id");
    } else if (!prompt) {
      process.stderr.write("No prompt provided. Either specify one as an argument or pipe the prompt into stdin.\n");
      fail("prompt_missing", "codex exec resume requires a prompt argument");
    } else if (!agent || agent.session_id !== sessionId) {
      fail("session_missing", "unknown session");
    } else {
      agent.mode = "resume";
      agent.last_prompt = prompt;
      agent.running = true;
      await writeFile(path.join(cwd, "codex-continue.txt"), `${prompt}\n`);
      await saveState(state);
      json({ name, pane_id: paneId, session_ref: { kind: "id", value: sessionId } });
    }
  } else {
    const prompt = promptFrom(agentArgs, 1);
    if (!prompt) {
      process.stderr.write("No prompt provided. Either specify one as an argument or pipe the prompt into stdin.\n");
      fail("prompt_missing", "codex exec requires a prompt argument");
    } else {
      const state = await loadState();
      const workspace = Object.values(state.workspaces).find((item) => item.pane_id === paneId);
      if (!workspace) {
        fail("pane_missing", "unknown pane");
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
          last_prompt: prompt,
        };
        await writeFile(path.join(cwd, "codex-launch.txt"), `${prompt}\n`);
        await saveState(state);
        json({ name, pane_id: paneId, session_ref: { kind: "id", value: sessionId } });
      }
    }
  }
} else if (command === "agent" && rest[0] === "prompt") {
  fail("too_late", "agent prompt after start is too late for non-interactive codex exec");
} else if (command === "agent" && rest[0] === "get") {
  const name = rest[1];
  const state = await loadState();
  const agent = state.agents[name];
  if (!agent) {
    fail("agent_not_found", "agent_not_found");
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
      fail("agent_not_found", "unknown agent");
    } else {
      const mode = process.env.HERDR_PROTOCOL_STOP;
      if (mode === "no_observation") {
        json({ name, accepted: true });
      } else if (mode === "still_running") {
        json({
          name,
          interrupted: true,
          process_exited: false,
          running: true,
          session_ref: { kind: "id", value: agent.session_id },
        });
      } else {
        if (agent.pid) {
          try {
            process.kill(agent.pid, "SIGTERM");
          } catch {
            // process may have already exited
          }
        }
        agent.running = false;
        await saveState(state);
        await writeFile(path.join(cwd, "codex-interrupted.flag"), "interrupted\n");
        json({
          name,
          interrupted: true,
          process_exited: true,
          running: false,
          session_ref: { kind: "id", value: agent.session_id },
          native_session_id: agent.session_id,
        });
      }
    }
  }
} else if (command === "workspace" && rest[0] === "close") {
  fail("forbidden", "adapter must not close workspaces");
} else {
  fail("unknown", argv.join(" "));
}
