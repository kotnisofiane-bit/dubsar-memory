#!/usr/bin/env node
/**
 * Controlled Codex CLI: non-interactive exec --json / exec resume ID --json.
 * Not the vendor binary. Native-like session_meta events; history under CODEX_HOME.
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

async function loadHistory(home) {
  try {
    return JSON.parse(await readFile(path.join(home, "sessions.json"), "utf8"));
  } catch {
    return { sessions: {} };
  }
}

async function saveHistory(home, history) {
  await mkdir(home, { recursive: true });
  await writeFile(path.join(home, "sessions.json"), `${JSON.stringify(history)}\n`);
}

function promptFrom(args) {
  const dash = args.lastIndexOf("--");
  if (dash < 0) return "";
  return args.slice(dash + 1).join(" ");
}

const args = process.argv.slice(2);
if (args.includes("--last")) fail("resume --last is forbidden");
if (args[0] !== "exec") fail("expected exec");
if (!args.includes("--json")) fail("exec requires --json");

const home = process.env.CODEX_HOME;
if (!home) fail("CODEX_HOME is required");

const prompt = promptFrom(args);
if (!prompt) {
  fail("No prompt provided. Either specify one as an argument or pipe the prompt into stdin.");
}

const cwd = process.cwd();
const resumeIndex = args.indexOf("resume");
const hold = process.env.CODEX_PROTOCOL_HOLD === "1";

if (resumeIndex >= 0) {
  const sessionId = args[resumeIndex + 1];
  if (!sessionId || sessionId.startsWith("-")) fail("resume requires an explicit session id");
  const history = await loadHistory(home);
  if (!history.sessions[sessionId]) {
    process.stderr.write(`${JSON.stringify({ error: { code: "session_missing" } })}\n`);
    process.exit(1);
  }
  emit({ type: "session_meta", id: sessionId });
  await writeFile(path.join(cwd, "codex-continue.txt"), `${prompt}\n`);
  emit({ type: "event_msg", payload: { type: "task_complete" } });
} else {
  const history = await loadHistory(home);
  const sessionId = `codex_${randomBytes(8).toString("hex")}`;
  history.sessions[sessionId] = { id: sessionId };
  await saveHistory(home, history);
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
