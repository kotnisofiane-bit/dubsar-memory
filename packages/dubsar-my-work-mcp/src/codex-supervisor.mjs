import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { MyWorkMcpError } from "./canonical.mjs";
import { extractSessionIdFromCodexJson, paneReadText, processInfoFrom } from "./codex-json.mjs";
import { herdrJson } from "./herdr-cli.mjs";
import {
  assertSystemdAvailable,
  paneCommandArgv,
  resolveXdgRuntimeDir,
  scopeUnitName,
  stopUserScope,
} from "./systemd-user.mjs";

const SUPERVISOR_FORMAT = "dubsar.codex-supervisor/1";
const SUPERVISOR_NAME = "codex-supervisor.json";
const SESSION_WAIT_MS = 15_000;
const storeLocks = new Map();

export function supervisorPath(allocationRoot) {
  return path.join(allocationRoot, SUPERVISOR_NAME);
}

export function ndjsonPath(allocationRoot, ticketId) {
  return path.join(allocationRoot, "codex-pane-log", `${ticketId}.ndjson`);
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

async function withStoreLock(allocationRoot, fn) {
  const previous = storeLocks.get(allocationRoot) ?? Promise.resolve();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  storeLocks.set(allocationRoot, previous.then(() => gate, () => gate));
  await previous.catch(() => {});
  try {
    return await fn();
  } finally {
    release();
  }
}

async function writeSupervisorStore(allocationRoot, store) {
  await mkdir(allocationRoot, { recursive: true });
  const target = supervisorPath(allocationRoot);
  const temporary = `${target}.${randomBytes(8).toString("hex")}.tmp`;
  await writeFile(temporary, `${JSON.stringify(store)}\n`);
  try {
    await rename(temporary, target);
  } catch (error) {
    if (error && (error.code === "EPERM" || error.code === "EEXIST")) {
      await unlink(target).catch(() => {});
      await rename(temporary, target);
      return;
    }
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

export async function recordSupervisorRun(allocationRoot, run) {
  await withStoreLock(allocationRoot, async () => {
    const store = await readSupervisorStore(allocationRoot);
    store.runs[run.ticket_id] = {
      ticket_id: run.ticket_id,
      codex_session_id: run.codex_session_id,
      herdr_id: run.herdr_id,
      systemd_unit: run.systemd_unit ?? null,
      pid: run.pid ?? null,
      status: run.status,
      exit_code: run.exit_code ?? null,
      herdr_live: run.herdr_live ?? "unknown",
      scope_state: run.scope_state ?? null,
    };
    await writeSupervisorStore(allocationRoot, store);
  });
}

export function occupantBinary() {
  const configured = process.env.DUBSAR_CODEX_BIN;
  if (typeof configured === "string" && configured.length > 0) return configured;
  return "codex";
}

export function publicPaneArgv(paneId, occupantTail) {
  return ["herdr", "pane", "run", paneId, ...occupantTail];
}

async function collectPaneNdjson({ allocationRoot, ticketId, paneId, cwd }) {
  const target = ndjsonPath(allocationRoot, ticketId);
  await mkdir(path.dirname(target), { recursive: true });
  const startedAt = Date.now();
  let sessionId = null;
  let text = "";
  while (!sessionId && Date.now() - startedAt < SESSION_WAIT_MS) {
    const read = await herdrJson(["pane", "read", "--pane", paneId, "--source", "recent-unwrapped"], { cwd });
    text = paneReadText(read.payload);
    await writeFile(target, text);
    sessionId = extractSessionIdFromCodexJson(text);
    if (sessionId) break;
    if (Date.now() - startedAt > 400) {
      const info = await herdrJson(["pane", "process-info", "--pane", paneId], { cwd });
      const processes = processInfoFrom(info.payload)?.foreground_processes ?? [];
      if (processes.length < 1) break;
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  return { sessionId, text, target };
}

async function readProcessInfo(paneId, cwd) {
  const info = await herdrJson(["pane", "process-info", "--pane", paneId], { cwd });
  return processInfoFrom(info.payload);
}

export function processObservation(run) {
  if (run?.status === "interrupted") return "interrupted";
  if (run?.status === "exited") return "already_finished";
  if (run?.status === "running") return "running";
  return "unknown";
}

export async function superviseCodex({ allocationRoot, ticketId, herdrId, argv, cwd, paneId }) {
  if (typeof paneId !== "string" || paneId.length < 1) {
    throw new MyWorkMcpError("MY_WORK_CODEX_LAUNCH_AMBIGUOUS");
  }
  assertSystemdAvailable();
  const runtimeDir = resolveXdgRuntimeDir();
  const unit = scopeUnitName(ticketId);
  const occupant = [occupantBinary(), ...argv];
  const paneArgv = paneCommandArgv({ runtimeDir, unit, occupantArgv: occupant });
  const submitted = await herdrJson(["pane", "run", paneId, ...paneArgv], { cwd, env: process.env });
  if (submitted.payload?.error || submitted.ok === false) {
    throw new MyWorkMcpError("MY_WORK_CODEX_LAUNCH_AMBIGUOUS");
  }
  if (submitted.payload?.result?.type !== "command_submitted") {
    throw new MyWorkMcpError("MY_WORK_CODEX_LAUNCH_AMBIGUOUS");
  }
  const collected = await collectPaneNdjson({ allocationRoot, ticketId, paneId, cwd });
  if (!collected.sessionId) throw new MyWorkMcpError("MY_WORK_CODEX_LAUNCH_AMBIGUOUS");
  const settleUntil = Date.now() + 1_000;
  let info = await readProcessInfo(paneId, cwd);
  while ((info?.foreground_processes?.length ?? 0) > 0 && Date.now() < settleUntil) {
    await new Promise((resolve) => setTimeout(resolve, 40));
    info = await readProcessInfo(paneId, cwd);
  }
  const running = (info?.foreground_processes?.length ?? 0) > 0;
  await recordSupervisorRun(allocationRoot, {
    ticket_id: ticketId,
    codex_session_id: collected.sessionId,
    herdr_id: herdrId,
    systemd_unit: unit,
    pid: info?.foreground_process_group_id ?? null,
    status: running ? "running" : "exited",
    herdr_live: "not_found",
    scope_state: running ? "active" : "inactive",
  });
  return {
    sessionId: collected.sessionId,
    pid: info?.foreground_process_group_id ?? null,
    status: running ? "running" : "exited",
    systemd_unit: unit,
    pane_argv: publicPaneArgv(paneId, paneArgv),
  };
}

export async function stopSupervisedCodex({ allocationRoot, ticketId, sessionId, paneId, cwd }) {
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
  if (typeof run.systemd_unit !== "string" || run.systemd_unit.length < 1) {
    throw new MyWorkMcpError("MY_WORK_CODEX_STOP_AMBIGUOUS");
  }
  const scope = await stopUserScope(run.systemd_unit);
  let remaining = paneId ? await readProcessInfo(paneId, cwd) : { foreground_processes: [] };
  const deadline = Date.now() + 2_000;
  while (paneId && remaining.foreground_processes.length > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 40));
    remaining = await readProcessInfo(paneId, cwd);
  }
  if (remaining && remaining.foreground_processes.length > 0) {
    throw new MyWorkMcpError("MY_WORK_CODEX_STOP_AMBIGUOUS");
  }
  await recordSupervisorRun(allocationRoot, {
    ...run,
    status: "interrupted",
    scope_state: scope.active_state,
    herdr_live: "not_found",
  });
  return { status: "interrupted", interrupted: true, mission_success: false, scope };
}

export function resetSupervisorChildren() {}
