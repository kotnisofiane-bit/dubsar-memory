import { spawn } from "node:child_process";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { MyWorkMcpError } from "./canonical.mjs";
import { extractSessionIdFromCodexJson } from "./codex-json.mjs";
import { herdrBinary } from "./herdr-cli.mjs";

const SUPERVISOR_FORMAT = "dubsar.codex-supervisor/1";
const SUPERVISOR_NAME = "codex-supervisor.json";
const SESSION_WAIT_MS = 15_000;
const liveChildren = new Map();

export function supervisorPath(allocationRoot) {
  return path.join(allocationRoot, SUPERVISOR_NAME);
}

function spawnArgv(bin, args) {
  if (bin.endsWith(".mjs") || bin.endsWith(".js")) {
    return { command: process.execPath, argv: [bin, ...args] };
  }
  return { command: bin, argv: args };
}

function herdrChildEnv() {
  const env = { ...process.env };
  if (typeof process.env.DUBSAR_CODEX_HOME === "string" && process.env.DUBSAR_CODEX_HOME.length > 0) {
    env.CODEX_HOME = process.env.DUBSAR_CODEX_HOME;
  }
  return env;
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

export async function superviseCodex({ allocationRoot, ticketId, herdrId, argv, cwd, paneId }) {
  if (typeof paneId !== "string" || paneId.length < 1) {
    throw new MyWorkMcpError("MY_WORK_CODEX_LAUNCH_AMBIGUOUS");
  }
  const herdrArgv = ["exec", "--pane", paneId, "--kind", "codex", "--", ...argv];
  const launched = spawnArgv(herdrBinary(), herdrArgv);
  let stdout = "";
  let stderr = "";
  let sessionId = null;
  let spawnFailed = false;

  const child = spawn(launched.command, launched.argv, {
    cwd,
    env: herdrChildEnv(),
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
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
  child.on("error", () => {
    spawnFailed = true;
    liveChildren.delete(ticketId);
  });
  child.on("exit", (code, signal) => {
    const entry = liveChildren.get(ticketId);
    if (entry) entry.exit = { code, signal };
  });
  child.on("close", (code, signal) => {
    const entry = liveChildren.get(ticketId);
    if (entry) entry.exit = { code, signal };
    const status = signal === "SIGTERM" || signal === "SIGINT" ? "interrupted" : "exited";
    if (sessionId) void finish(status, code);
  });

  child.stdout?.on("data", (chunk) => {
    stdout += chunk.toString("utf8");
    if (!sessionId) sessionId = extractSessionIdFromCodexJson(stdout);
  });
  child.stderr?.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });

  const startedAt = Date.now();
  while (!sessionId && Date.now() - startedAt < SESSION_WAIT_MS) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    if (!sessionId) sessionId = extractSessionIdFromCodexJson(stdout);
    const herdrGone =
      spawnFailed ||
      child.exitCode != null ||
      child.signalCode != null ||
      Boolean(liveChildren.get(ticketId)?.exit) ||
      (Number.isInteger(child.pid) && !pidAlive(child.pid));
    if (herdrGone) {
      if (!sessionId) sessionId = extractSessionIdFromCodexJson(stdout);
      break;
    }
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

  const settleUntil = Date.now() + 250;
  while (!liveChildren.get(ticketId)?.exit && Date.now() < settleUntil) {
    if (!pidAlive(child.pid)) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const finished =
    Boolean(liveChildren.get(ticketId)?.exit) ||
    child.exitCode != null ||
    (Number.isInteger(child.pid) && !pidAlive(child.pid));
  await recordSupervisorRun(allocationRoot, {
    ticket_id: ticketId,
    codex_session_id: sessionId,
    herdr_id: herdrId,
    pid: child.pid ?? null,
    status: finished ? "exited" : "running",
    exit_code: liveChildren.get(ticketId)?.exit?.code ?? child.exitCode ?? null,
    herdr_live: "not_found",
  });
  return { sessionId, pid: child.pid ?? null, status: finished ? "exited" : "running" };
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
