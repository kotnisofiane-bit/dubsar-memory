import { spawn } from "node:child_process";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { MyWorkMcpError } from "./canonical.mjs";
import { extractSessionIdFromCodexJson } from "./codex-json.mjs";

const SUPERVISOR_FORMAT = "dubsar.codex-supervisor/1";
const SUPERVISOR_NAME = "codex-supervisor.json";
const SESSION_WAIT_MS = 15_000;
const liveChildren = new Map();

export function supervisorPath(allocationRoot) {
  return path.join(allocationRoot, SUPERVISOR_NAME);
}

export function codexHomeDir(allocationRoot) {
  return path.join(allocationRoot, "codex-native");
}

export function codexBinary() {
  const configured = process.env.DUBSAR_CODEX_BIN;
  if (typeof configured === "string" && configured.length > 0) return configured;
  return "codex";
}

function spawnArgv(bin, args) {
  if (bin.endsWith(".mjs") || bin.endsWith(".js")) {
    return { command: process.execPath, argv: [bin, ...args] };
  }
  return { command: bin, argv: args };
}

function emptyStore() {
  return { format: SUPERVISOR_FORMAT, runs: {} };
}

export async function readSupervisorStore(allocationRoot) {
  try {
    const raw = JSON.parse(await readFile(supervisorPath(allocationRoot), "utf8"));
    if (raw?.format !== SUPERVISOR_FORMAT || typeof raw.runs !== "object" || raw.runs == null) {
      return emptyStore();
    }
    return raw;
  } catch {
    return emptyStore();
  }
}

export async function readSupervisorRun(allocationRoot, ticketId) {
  const store = await readSupervisorStore(allocationRoot);
  const run = store.runs?.[ticketId];
  return run && typeof run === "object" ? run : null;
}

async function writeSupervisorStore(allocationRoot, store) {
  await mkdir(allocationRoot, { recursive: true });
  const target = supervisorPath(allocationRoot);
  const temporary = `${target}.${randomBytes(8).toString("hex")}.tmp`;
  await writeFile(temporary, `${JSON.stringify(store)}\n`);
  await rename(temporary, target).catch(async (error) => {
    await unlink(temporary).catch(() => {});
    throw error;
  });
}

export async function recordSupervisorRun(allocationRoot, run) {
  const store = await readSupervisorStore(allocationRoot);
  store.runs[run.ticket_id] = {
    ticket_id: run.ticket_id,
    codex_session_id: run.codex_session_id,
    herdr_id: run.herdr_id,
    pid: run.pid ?? null,
    status: run.status,
    exit_code: run.exit_code ?? null,
    herdr_live: run.herdr_live ?? "unknown",
  };
  await writeSupervisorStore(allocationRoot, store);
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function processObservation(run) {
  const live = liveChildren.get(run?.ticket_id);
  if (live?.exit) {
    if (live.exit.signal === "SIGTERM" || live.exit.signal === "SIGINT") return "interrupted";
    return "already_finished";
  }
  if (live?.child && live.exit === undefined) return "running";
  if (run?.status === "interrupted") return "interrupted";
  if (run?.status === "exited") return "already_finished";
  if (Number.isInteger(run?.pid) && pidAlive(run.pid)) return "running";
  return "unknown";
}

export async function superviseCodex({ allocationRoot, ticketId, herdrId, argv, cwd }) {
  const bin = codexBinary();
  const launched = spawnArgv(bin, argv);
  const home = codexHomeDir(allocationRoot);
  await mkdir(home, { recursive: true });
  let stdout = "";
  let stderr = "";
  let sessionId = null;
  let spawnFailed = false;

  const child = spawn(launched.command, launched.argv, {
    cwd,
    env: { ...process.env, CODEX_HOME: home },
    windowsHide: true,
  });

  const finish = async (status, exitCode) => {
    if (!sessionId) return;
    await recordSupervisorRun(allocationRoot, {
      ticket_id: ticketId,
      codex_session_id: sessionId,
      herdr_id: herdrId,
      pid: child.pid ?? null,
      status,
      exit_code: exitCode,
      herdr_live: "not_found",
    });
  };

  liveChildren.set(ticketId, { child, exit: undefined });

  child.stdout?.on("data", (chunk) => {
    stdout += chunk.toString("utf8");
    if (!sessionId) sessionId = extractSessionIdFromCodexJson(stdout);
  });
  child.stderr?.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });
  child.on("error", () => {
    spawnFailed = true;
    liveChildren.delete(ticketId);
  });
  child.on("close", (code, signal) => {
    const entry = liveChildren.get(ticketId);
    if (entry) entry.exit = { code, signal };
    const status = signal === "SIGTERM" || signal === "SIGINT" ? "interrupted" : "exited";
    void finish(status, code);
  });

  const startedAt = Date.now();
  while (!sessionId && Date.now() - startedAt < SESSION_WAIT_MS) {
    if (spawnFailed) break;
    if (liveChildren.get(ticketId)?.exit && !sessionId) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
    if (!sessionId) sessionId = extractSessionIdFromCodexJson(stdout);
  }

  if (!sessionId) {
    if (child.exitCode == null && pidAlive(child.pid)) {
      try {
        child.kill("SIGTERM");
      } catch {
        // ignore
      }
    }
    liveChildren.delete(ticketId);
    if (spawnFailed) throw new MyWorkMcpError("MY_WORK_CODEX_UNAVAILABLE");
    if (/No prompt provided/u.test(stderr) || /No prompt provided/u.test(stdout)) {
      throw new MyWorkMcpError("MY_WORK_MISSION_INCOMPLETE");
    }
    throw new MyWorkMcpError("MY_WORK_CODEX_LAUNCH_AMBIGUOUS");
  }

  await recordSupervisorRun(allocationRoot, {
    ticket_id: ticketId,
    codex_session_id: sessionId,
    herdr_id: herdrId,
    pid: child.pid ?? null,
    status: liveChildren.get(ticketId)?.exit ? "exited" : "running",
    exit_code: liveChildren.get(ticketId)?.exit?.code ?? null,
    herdr_live: "not_found",
  });
  return { sessionId, pid: child.pid ?? null, status: liveChildren.get(ticketId)?.exit ? "exited" : "running" };
}

export async function stopSupervisedCodex({ allocationRoot, ticketId, sessionId }) {
  const run = await readSupervisorRun(allocationRoot, ticketId);
  if (!run || run.codex_session_id !== sessionId) {
    throw new MyWorkMcpError("MY_WORK_CODEX_STOP_AMBIGUOUS");
  }
  const observation = processObservation(run);
  if (observation === "already_finished") {
    return { status: "already_finished", interrupted: false, mission_success: false };
  }
  if (observation === "interrupted") {
    return { status: "interrupted", interrupted: true, mission_success: false };
  }
  if (observation !== "running") {
    throw new MyWorkMcpError("MY_WORK_CODEX_STOP_AMBIGUOUS");
  }
  const live = liveChildren.get(ticketId);
  if (live?.child) {
    live.child.kill("SIGTERM");
    const deadline = Date.now() + 5_000;
    while (live.exit === undefined && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    if (live.exit === undefined) throw new MyWorkMcpError("MY_WORK_CODEX_STOP_AMBIGUOUS");
    await recordSupervisorRun(allocationRoot, {
      ...run,
      status: "interrupted",
      pid: run.pid,
      herdr_live: "not_found",
    });
    return { status: "interrupted", interrupted: true, mission_success: false };
  }
  if (Number.isInteger(run.pid) && pidAlive(run.pid)) {
    try {
      process.kill(run.pid, "SIGTERM");
    } catch {
      throw new MyWorkMcpError("MY_WORK_CODEX_STOP_AMBIGUOUS");
    }
    const deadline = Date.now() + 5_000;
    while (pidAlive(run.pid) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    if (pidAlive(run.pid)) throw new MyWorkMcpError("MY_WORK_CODEX_STOP_AMBIGUOUS");
    await recordSupervisorRun(allocationRoot, { ...run, status: "interrupted", herdr_live: "not_found" });
    return { status: "interrupted", interrupted: true, mission_success: false };
  }
  throw new MyWorkMcpError("MY_WORK_CODEX_STOP_AMBIGUOUS");
}

export function resetSupervisorChildren() {
  liveChildren.clear();
}
