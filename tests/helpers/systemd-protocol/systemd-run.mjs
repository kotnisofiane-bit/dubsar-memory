#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function spawnArgv(bin, args) {
  if (bin.endsWith(".mjs") || bin.endsWith(".js")) {
    return { command: process.execPath, argv: [bin, ...args] };
  }
  return { command: bin, argv: args };
}

function takeUnit(args) {
  const flag = args.find((item) => item.startsWith("--unit="));
  return flag ? flag.slice("--unit=".length) : null;
}

const args = process.argv.slice(2);
if (!args.includes("--user") || !args.includes("--scope")) fail("systemd-run protocol double requires --user --scope");
const unit = takeUnit(args);
if (!unit) fail("systemd-run protocol double requires --unit=");
if (!args.includes("--property=KillMode=control-group") || !args.includes("--property=TimeoutStopSec=5s")) {
  fail("systemd-run protocol double requires KillMode=control-group and TimeoutStopSec=5s");
}

let occupant = args.slice(args.findLastIndex((item) => item.startsWith("--property=")) + 1);
if (occupant[0] === "--") occupant = occupant.slice(1);
if (occupant.length < 1) fail("systemd-run protocol double requires a command");

const runtime = process.env.XDG_RUNTIME_DIR;
if (!runtime) fail("XDG_RUNTIME_DIR required");
const statePath = path.join(runtime, "dubsar-systemd-protocol.json");

async function loadState() {
  try {
    return JSON.parse(await readFile(statePath, "utf8"));
  } catch {
    return { units: {} };
  }
}

async function saveState(state) {
  await mkdir(path.dirname(statePath), { recursive: true });
  await writeFile(statePath, `${JSON.stringify(state)}\n`);
}

const launched = spawnArgv(occupant[0], occupant.slice(1));
const child = spawn(launched.command, launched.argv, {
  env: process.env,
  windowsHide: true,
  detached: process.platform !== "win32",
  stdio: ["ignore", "pipe", "pipe"],
});

const pids = [child.pid].filter((pid) => Number.isInteger(pid));
const state = await loadState();
state.units[unit] = { unit, pids, active: "active", sub: "running", pgid: child.pid };
await saveState(state);

const stop = async () => {
  try {
    if (process.platform === "win32") child.kill("SIGTERM");
    else process.kill(-child.pid, "SIGTERM");
  } catch {
    try {
      child.kill("SIGTERM");
    } catch {
      // already gone
    }
  }
};

process.on("SIGTERM", () => void stop());
process.on("SIGINT", () => void stop());

child.stdout?.pipe(process.stdout);
child.stderr?.pipe(process.stderr);

const code = await new Promise((resolve) => {
  child.on("error", () => resolve(127));
  child.on("close", (exitCode) => resolve(exitCode ?? 1));
});

const after = await loadState();
if (after.units[unit]) {
  after.units[unit].active = "inactive";
  after.units[unit].sub = "dead";
  after.units[unit].pids = [];
  await saveState(after);
}
process.exitCode = code;
