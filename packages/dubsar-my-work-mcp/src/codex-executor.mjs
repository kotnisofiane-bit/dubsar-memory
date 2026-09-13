import { MyWorkMcpError } from "./canonical.mjs";
import { confineAuthorizedWorkspace } from "./codex-workspace.mjs";
import {
  herdrIdFrom,
  herdrJson,
  parseStoredHerdrId,
  sessionRefFrom,
  workspaceIdsFrom,
} from "./herdr-cli.mjs";

export const CODEX_LAUNCH_ARGV = Object.freeze(["exec"]);
export const CODEX_RESUME_ARGV = Object.freeze(["exec", "resume"]);

let testExecutor = null;

export function setTestCodexExecutor(executor) {
  testExecutor = executor;
}

export function resetTestCodexExecutor() {
  testExecutor = null;
}

function requirePrompt(prompt) {
  if (typeof prompt !== "string" || prompt.trim() !== prompt || prompt.length < 1) {
    throw new MyWorkMcpError("MY_WORK_MISSION_INCOMPLETE");
  }
  return prompt;
}

function agentName(ticketId) {
  const digits = String(ticketId ?? "").replace(/\D/gu, "").slice(-3).padStart(3, "0");
  return `d${digits}`;
}

function rejectFabricatedIds(herdrId, sessionId) {
  if (herdrId === "herdr-local" || /^herdr-DUB-/u.test(herdrId) || /^herdr-\d/u.test(herdrId)) {
    throw new MyWorkMcpError("MY_WORK_CODEX_LAUNCH_AMBIGUOUS");
  }
  if (/^codex-sess-DUB-/u.test(sessionId)) {
    throw new MyWorkMcpError("MY_WORK_CODEX_LAUNCH_AMBIGUOUS");
  }
}

export function createHerdrCodexExecutor() {
  return {
    kind: "herdr",
    async exec({ ticketId, workspaceRoot, prompt, authorizedWorkspace }) {
      const text = requirePrompt(prompt);
      const confined = await confineAuthorizedWorkspace(authorizedWorkspace ?? workspaceRoot, workspaceRoot);
      const name = agentName(ticketId);
      const created = await herdrJson(
        ["workspace", "create", "--cwd", confined, "--label", ticketId, "--no-focus"],
        { cwd: confined },
      );
      const ids = workspaceIdsFrom(created.payload);
      if (!ids) throw new MyWorkMcpError("MY_WORK_CODEX_LAUNCH_AMBIGUOUS");
      if (ids.cwd && ids.cwd !== confined) throw new MyWorkMcpError("MY_WORK_SCOPE_EXTENSION");
      const started = await herdrJson(
        ["agent", "start", name, "--kind", "codex", "--pane", ids.paneId, "--", ...CODEX_LAUNCH_ARGV],
        { cwd: confined },
      );
      if (!started.ok) throw new MyWorkMcpError("MY_WORK_CODEX_LAUNCH_AMBIGUOUS");
      const prompted = await herdrJson(["agent", "prompt", name, "--", text], { cwd: confined });
      if (!prompted.ok) throw new MyWorkMcpError("MY_WORK_CODEX_LAUNCH_AMBIGUOUS");
      const got = await herdrJson(["agent", "get", name], { cwd: confined });
      const sessionId = sessionRefFrom(got.payload);
      if (!sessionId) throw new MyWorkMcpError("MY_WORK_CODEX_LAUNCH_AMBIGUOUS");
      const herdrId = herdrIdFrom(ids);
      rejectFabricatedIds(herdrId, sessionId);
      return {
        ambiguous: false,
        herdr_id: herdrId,
        codex_session_id: sessionId,
        status: "launched",
        argv: ["herdr", "agent", "start", name, "--kind", "codex", "--", ...CODEX_LAUNCH_ARGV],
      };
    },
    async resume({ workspaceRoot, herdrId, sessionId, prompt, authorizedWorkspace, ticketId }) {
      const text = requirePrompt(prompt);
      const confined = await confineAuthorizedWorkspace(authorizedWorkspace ?? workspaceRoot, workspaceRoot);
      const parsed = parseStoredHerdrId(herdrId);
      if (!parsed) throw new MyWorkMcpError("MY_WORK_CODEX_CONTINUE_AMBIGUOUS");
      const name = agentName(ticketId);
      const started = await herdrJson(
        ["agent", "start", name, "--kind", "codex", "--pane", parsed.paneId, "--", ...CODEX_RESUME_ARGV, sessionId],
        { cwd: confined },
      );
      if (!started.ok) {
        if (started.payload?.error?.code === "session_missing") throw new MyWorkMcpError("MY_WORK_CODEX_SESSION_MISSING");
        throw new MyWorkMcpError("MY_WORK_CODEX_CONTINUE_AMBIGUOUS");
      }
      const prompted = await herdrJson(["agent", "prompt", name, "--", text], { cwd: confined });
      if (!prompted.ok) throw new MyWorkMcpError("MY_WORK_CODEX_CONTINUE_AMBIGUOUS");
      const got = await herdrJson(["agent", "get", name], { cwd: confined });
      const observed = sessionRefFrom(got.payload);
      if (observed !== sessionId) throw new MyWorkMcpError("MY_WORK_CODEX_CONTINUE_AMBIGUOUS");
      return {
        ambiguous: false,
        herdr_id: herdrId,
        codex_session_id: sessionId,
        status: "resumed",
        argv: ["herdr", "agent", "start", name, "--kind", "codex", "--", ...CODEX_RESUME_ARGV, sessionId],
      };
    },
    async stop({ sessionId, herdrId, workspaceRoot, ticketId, authorizedWorkspace }) {
      const confined = await confineAuthorizedWorkspace(authorizedWorkspace ?? workspaceRoot, workspaceRoot);
      const parsed = parseStoredHerdrId(herdrId);
      if (!parsed) throw new MyWorkMcpError("MY_WORK_CODEX_STOP_AMBIGUOUS");
      const name = agentName(ticketId);
      const sent = await herdrJson(["agent", "send-keys", name, "ctrl+c"], { cwd: confined });
      if (sent.missing) throw new MyWorkMcpError("MY_WORK_HERDR_UNAVAILABLE");
      if (!sent.ok) throw new MyWorkMcpError("MY_WORK_CODEX_STOP_AMBIGUOUS");
      const got = await herdrJson(["agent", "get", name], { cwd: confined });
      const observed = sessionRefFrom(got.payload);
      if (observed !== sessionId) throw new MyWorkMcpError("MY_WORK_CODEX_STOP_AMBIGUOUS");
      if (got.payload?.result?.running === true) throw new MyWorkMcpError("MY_WORK_CODEX_STOP_AMBIGUOUS");
      return {
        ambiguous: false,
        herdr_id: herdrId,
        codex_session_id: sessionId,
        status: "interrupted",
        logging_error: got.payload?.result?.logging_error === true,
        mission_success: false,
      };
    },
  };
}

export function createFakeCodexExecutor(options = {}) {
  return {
    kind: "fake",
    async exec() {
      if (options.ambiguousLaunch === true) return { ambiguous: true };
      throw new MyWorkMcpError("MY_WORK_CODEX_LAUNCH_AMBIGUOUS");
    },
    async resume() {
      throw new MyWorkMcpError("MY_WORK_CODEX_CONTINUE_AMBIGUOUS");
    },
    async stop() {
      throw new MyWorkMcpError("MY_WORK_CODEX_STOP_AMBIGUOUS");
    },
  };
}

export function resolveCodexExecutor() {
  if (testExecutor) return testExecutor;
  if (process.env.DUBSAR_CODEX_EXECUTOR === "fake") return createFakeCodexExecutor();
  return createHerdrCodexExecutor();
}
