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
  const direct =
    (value.type === "session_meta" && value.id) ||
    value.session_meta?.id ||
    value.payload?.session_meta?.id ||
    value.msg?.session_meta?.id ||
    (value.type === "thread.started" && value.thread_id);
  if (typeof direct === "string" && direct.length > 0) return direct;
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
