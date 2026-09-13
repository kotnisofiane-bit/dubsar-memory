#!/usr/bin/env node
/**
 * Controlled Codex CLI hosted only inside a Herdr pane.
 * Refuses execution outside HERDR_PANE_ID. Does not treat HERDR_ENV=1 as hosting.
 */
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

function fail(message, code = 1) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

function emit(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

async function loadHistory(storePath) {
  try {
    return JSON.parse(await readFile(storePath, "utf8"));
  } catch {
    return { sessions: {} };
  }
}

async function saveHistory(storePath, history) {
  await mkdir(path.dirname(storePath), { recursive: true });
  await writeFile(storePath, `${JSON.stringify(history)}\n`);
}

function promptFrom(args) {
  const dash = args.lastIndexOf("--");
  if (dash < 0) return "";
  return args.slice(dash + 1).join(" ");
}

function historyPath(cwd, paneId, home) {
  if (typeof home === "string" && home.length > 0) return path.join(home, "sessions.json");
  return path.join(cwd, ".dubsar", `pane-${paneId}-sessions.json`);
}

const args = process.argv.slice(2);
if (!process.env.HERDR_PANE_ID) {
  fail("refusing execution outside a Herdr pane");
}
if (args.includes("--last")) fail("resume --last is forbidden");
if (args[0] !== "exec") fail("expected exec");
if (!args.includes("--json")) fail("exec requires --json");

const prompt = promptFrom(args);
if (!prompt) {
  fail("No prompt provided. Either specify one as an argument or pipe the prompt into stdin.");
}

const cwd = process.cwd();
const paneId = process.env.HERDR_PANE_ID;
const home = process.env.CODEX_HOME;
const storePath = historyPath(cwd, paneId, home);
const resumeIndex = args.indexOf("resume");
const hold = process.env.CODEX_PROTOCOL_HOLD === "1";
const sentinel = process.env.CODEX_CONFIG_SENTINEL ?? "";
await writeFile(path.join(cwd, "codex-context-sentinel.txt"), `${sentinel}\n`);
await writeFile(path.join(cwd, "codex-home-echo.txt"), `${home ?? ""}\n`);

if (resumeIndex >= 0) {
  const sessionId = args[resumeIndex + 1];
  if (!sessionId || sessionId.startsWith("-")) fail("resume requires an explicit session id");
  const history = await loadHistory(storePath);
  if (!history.sessions[sessionId]) {
    process.stderr.write(`${JSON.stringify({ error: { code: "session_missing" } })}\n`);
    process.exit(1);
  }
  emit({ type: "session_meta", id: sessionId });
  await writeFile(path.join(cwd, "codex-continue.txt"), `${prompt}\n`);
  emit({ type: "event_msg", payload: { type: "task_complete" } });
} else {
  const history = await loadHistory(storePath);
  const sessionId = `codex_${randomBytes(8).toString("hex")}`;
  history.sessions[sessionId] = { id: sessionId, pane_id: paneId };
  await saveHistory(storePath, history);
  emit({ type: "session_meta", id: sessionId });
  await writeFile(path.join(cwd, "codex-launch.txt"), `${prompt}\n`);
  emit({ type: "event_msg", payload: { type: "task_complete" } });
  if (hold) {
    const onStop = async () => {
      await writeFile(path.join(cwd, "codex-interrupted.flag"), "interrupted\n");
      process.exit(0);
    };
    process.on("SIGTERM", onStop);
    process.on("SIGINT", onStop);
    setInterval(() => {}, 1000);
  }
}
