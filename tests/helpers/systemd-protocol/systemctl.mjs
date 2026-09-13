#!/usr/bin/env node
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

function fail(message, code = 1) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

const args = process.argv.slice(2);
if (args[0] !== "--user") fail("systemctl protocol double requires --user");
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

const command = args[1];
if (command === "stop") {
  const unit = args[2];
  const state = await loadState();
  const record = state.units[unit];
  if (!record) fail(`unknown unit ${unit}`, 5);
  for (const pid of record.pids ?? []) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // already gone
    }
    if (process.platform !== "win32") {
      try {
        process.kill(-pid, "SIGTERM");
      } catch {
        // not a group leader
      }
    }
  }
  record.active = "inactive";
  record.sub = "dead";
  record.pids = [];
  await saveState(state);
  process.exit(0);
}

if (command === "show") {
  const unit = args[2];
  const state = await loadState();
  const record = state.units[unit];
  if (!record) {
    process.stdout.write("ActiveState=inactive\nSubState=dead\n");
    process.exit(0);
  }
  process.stdout.write(`ActiveState=${record.active}\nSubState=${record.sub}\n`);
  process.exit(0);
}

fail(`unsupported ${args.join(" ")}`);
