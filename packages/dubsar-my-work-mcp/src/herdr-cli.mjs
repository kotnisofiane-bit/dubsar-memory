import { spawn } from "node:child_process";
import { MyWorkMcpError } from "./canonical.mjs";

const HERDR_JSON_TIMEOUT_MS = 15_000;

export function herdrBinary() {
  const configured = process.env.DUBSAR_HERDR_BIN;
  if (typeof configured === "string" && configured.length > 0) return configured;
  return "herdr";
}

export function parseHerdrJson(text) {
  if (typeof text !== "string" || text.trim() === "") return null;
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

export function workspaceIdsFrom(payload) {
  const workspaceId = payload?.result?.workspace?.workspace_id;
  const paneId = payload?.result?.root_pane?.pane_id;
  const cwd = payload?.result?.workspace?.cwd ?? payload?.result?.cwd;
  if (typeof workspaceId !== "string" || workspaceId.length < 1) return null;
  if (typeof paneId !== "string" || paneId.length < 1) return null;
  return { workspaceId, paneId, cwd: typeof cwd === "string" ? cwd : null };
}

export function sessionRefFrom(payload) {
  const value =
    payload?.result?.session_ref?.value ??
    payload?.result?.native_session_id ??
    payload?.result?.codex_session_id;
  if (typeof value !== "string" || value.length < 1) return null;
  return value;
}

export function herdrIdFrom(ids) {
  return `${ids.workspaceId}/${ids.paneId}`;
}

export function parseStoredHerdrId(herdrId) {
  if (typeof herdrId !== "string" || !herdrId.includes("/")) return null;
  const index = herdrId.indexOf("/");
  const workspaceId = herdrId.slice(0, index);
  const paneId = herdrId.slice(index + 1);
  if (workspaceId.length < 1 || paneId.length < 1) return null;
  return { workspaceId, paneId };
}

function spawnArgv(bin, args) {
  if (bin.endsWith(".mjs") || bin.endsWith(".js")) {
    return { command: process.execPath, argv: [bin, ...args] };
  }
  return { command: bin, argv: args };
}

export function runHerdrCommand(args, { cwd, env = process.env, input = null, timeoutMs = HERDR_JSON_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    const launched = spawnArgv(herdrBinary(), args);
    const child = spawn(launched.command, launched.argv, {
      cwd,
      env,
      windowsHide: true,
    });
    const stdout = [];
    const stderr = [];
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      resolve({ ok: false, ambiguous: true, stdout: "", stderr: "timeout", code: null });
    }, timeoutMs);
    child.stdout?.on("data", (chunk) => stdout.push(chunk));
    child.stderr?.on("data", (chunk) => stderr.push(chunk));
    child.on("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, missing: true, stdout: "", stderr: "spawn", code: null });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ok: code === 0,
        code,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
    if (input != null) {
      child.stdin.write(input);
      child.stdin.end();
    } else if (child.stdin) {
      child.stdin.end();
    }
  });
}

export async function herdrJson(args, options = {}) {
  const result = await runHerdrCommand(args, options);
  if (result.missing) throw new MyWorkMcpError("MY_WORK_HERDR_UNAVAILABLE");
  if (!result.ok) {
    if (result.ambiguous) throw new MyWorkMcpError("MY_WORK_CODEX_LAUNCH_AMBIGUOUS");
    const payload = parseHerdrJson(result.stderr) ?? parseHerdrJson(result.stdout);
    const code = payload?.error?.code ?? payload?.code;
    if (code === "session_missing" || code === "MY_WORK_CODEX_SESSION_MISSING") {
      throw new MyWorkMcpError("MY_WORK_CODEX_SESSION_MISSING");
    }
    if (code === "agent_blocked") throw new MyWorkMcpError("MY_WORK_DIALOGUE_AUTO_APPROVE_FORBIDDEN");
    return { ...result, payload: payload ?? null };
  }
  return { ...result, payload: parseHerdrJson(result.stdout) };
}
