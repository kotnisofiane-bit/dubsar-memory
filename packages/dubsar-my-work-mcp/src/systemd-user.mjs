import { existsSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { MyWorkMcpError } from "./canonical.mjs";

function configuredOrName(envName, fallback) {
  const configured = process.env[envName];
  if (typeof configured === "string" && configured.length > 0) return configured;
  return fallback;
}

export function systemdRunBinary() {
  return configuredOrName("DUBSAR_SYSTEMD_RUN_BIN", "systemd-run");
}

export function systemctlBinary() {
  return configuredOrName("DUBSAR_SYSTEMCTL_BIN", "systemctl");
}

export function spawnArgv(bin, args) {
  if (bin.endsWith(".mjs") || bin.endsWith(".js")) {
    return { command: process.execPath, argv: [bin, ...args] };
  }
  return { command: bin, argv: args };
}

export function resolveXdgRuntimeDir() {
  const fromEnv = process.env.XDG_RUNTIME_DIR;
  if (typeof fromEnv === "string" && fromEnv.length > 0 && existsSync(fromEnv)) {
    return fromEnv;
  }
  throw new MyWorkMcpError("MY_WORK_SYSTEMD_UNAVAILABLE");
}

export function scopeUnitName(ticketId) {
  const slug = String(ticketId).toLowerCase().replace(/[^a-z0-9-]/gu, "-");
  return `dubsar-mw-${slug}-${randomBytes(4).toString("hex")}.scope`;
}

export function assertSystemdAvailable() {
  const runBin = systemdRunBinary();
  const ctlBin = systemctlBinary();
  const runOk = runBin.includes("/") || runBin.endsWith(".mjs") || binOnPath(runBin);
  const ctlOk = ctlBin.includes("/") || ctlBin.endsWith(".mjs") || binOnPath(ctlBin);
  if (runBin.includes("/") && !existsSync(runBin)) throw new MyWorkMcpError("MY_WORK_SYSTEMD_UNAVAILABLE");
  if (ctlBin.includes("/") && !existsSync(ctlBin)) throw new MyWorkMcpError("MY_WORK_SYSTEMD_UNAVAILABLE");
  if (!runOk || !ctlOk) throw new MyWorkMcpError("MY_WORK_SYSTEMD_UNAVAILABLE");
  resolveXdgRuntimeDir();
  return { runBin, ctlBin };
}

function binOnPath(name) {
  const pathEnv = process.env.PATH ?? "";
  const parts = pathEnv.split(path.delimiter);
  return parts.some((dir) => dir.length > 0 && existsSync(path.join(dir, name)));
}

export function paneCommandArgv({ runtimeDir, unit, occupantArgv }) {
  const { runBin } = assertSystemdAvailable();
  return [
    "env",
    `XDG_RUNTIME_DIR=${runtimeDir}`,
    runBin,
    "--user",
    "--scope",
    `--unit=${unit}`,
    "--property=KillMode=control-group",
    "--property=TimeoutStopSec=5s",
    ...occupantArgv,
  ];
}

export function runSystemctl(args, { timeoutMs = 8_000 } = {}) {
  return new Promise((resolve) => {
    const launched = spawnArgv(systemctlBinary(), args);
    const child = spawn(launched.command, launched.argv, {
      env: process.env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      resolve({ ok: false, missing: false, stdout: "", stderr: "timeout", code: null });
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
  });
}

export async function stopUserScope(unit) {
  if (typeof unit !== "string" || unit.length < 1) {
    throw new MyWorkMcpError("MY_WORK_CODEX_STOP_AMBIGUOUS");
  }
  const stopped = await runSystemctl(["--user", "stop", unit]);
  if (stopped.missing) throw new MyWorkMcpError("MY_WORK_SYSTEMD_UNAVAILABLE");
  if (!stopped.ok) throw new MyWorkMcpError("MY_WORK_CODEX_STOP_AMBIGUOUS");
  const shown = await runSystemctl(["--user", "show", unit, "--property=ActiveState", "--property=SubState"]);
  if (shown.missing) throw new MyWorkMcpError("MY_WORK_SYSTEMD_UNAVAILABLE");
  const inactive = /ActiveState=inactive/u.test(shown.stdout) || /ActiveState=failed/u.test(shown.stdout);
  if (!inactive) throw new MyWorkMcpError("MY_WORK_CODEX_STOP_AMBIGUOUS");
  return { unit, active_state: "inactive", sub_state: "dead" };
}
