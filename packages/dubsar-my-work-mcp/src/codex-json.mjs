import { MyWorkMcpError } from "./canonical.mjs";

export function assertNoLastFlag(argv) {
  if (argv.some((item) => item === "--last")) {
    throw new MyWorkMcpError("MY_WORK_CODEX_CONTINUE_AMBIGUOUS");
  }
}

export function codexExecArgv(prompt) {
  if (typeof prompt !== "string" || prompt.trim() !== prompt || prompt.length < 1) {
    throw new MyWorkMcpError("MY_WORK_MISSION_INCOMPLETE");
  }
  return ["exec", "--json", "--", prompt];
}

export function codexResumeArgv(sessionId, prompt) {
  if (typeof sessionId !== "string" || sessionId.length < 1) {
    throw new MyWorkMcpError("MY_WORK_CODEX_CONTINUE_AMBIGUOUS");
  }
  if (sessionId === "--last") throw new MyWorkMcpError("MY_WORK_CODEX_CONTINUE_AMBIGUOUS");
  if (typeof prompt !== "string" || prompt.trim() !== prompt || prompt.length < 1) {
    throw new MyWorkMcpError("MY_WORK_MISSION_INCOMPLETE");
  }
  return ["exec", "resume", sessionId, "--json", "--", prompt];
}

export function sessionIdFromCodexEvent(value) {
  if (!value || typeof value !== "object") return null;
  if (value.type === "thread.started" && typeof value.thread_id === "string" && value.thread_id.length > 0) {
    return value.thread_id;
  }
  return null;
}

export function extractSessionIdFromCodexJson(text) {
  if (typeof text !== "string" || text.trim() === "") return null;
  for (const line of text.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(trimmed);
      const found = sessionIdFromCodexEvent(parsed);
      if (found) return found;
    } catch {
      // ignore non-JSON noise from the pane
    }
  }
  return null;
}

export function paneReadText(payload) {
  const text = payload?.result?.text ?? payload?.result?.result?.text;
  return typeof text === "string" ? text : "";
}

export function processInfoFrom(payload) {
  const info = payload?.result?.process_info;
  if (!info || typeof info !== "object") return null;
  return {
    foreground_process_group_id: info.foreground_process_group_id ?? null,
    foreground_processes: Array.isArray(info.foreground_processes) ? info.foreground_processes : [],
    shell_pid: info.shell_pid ?? null,
  };
}
