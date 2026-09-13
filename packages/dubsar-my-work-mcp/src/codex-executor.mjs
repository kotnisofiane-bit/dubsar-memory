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

export function codexExecArgv(prompt) {
  return ["exec", "--", requirePrompt(prompt)];
}

export function codexResumeArgv(sessionId, prompt) {
  if (typeof sessionId !== "string" || sessionId.length < 1) {
    throw new MyWorkMcpError("MY_WORK_CODEX_CONTINUE_AMBIGUOUS");
  }
  return ["exec", "resume", sessionId, "--", requirePrompt(prompt)];
}

function resultBody(payload) {
  return payload?.result ?? payload;
}

function assertPositiveStop(sent, got, sessionId) {
  const sentBody = resultBody(sent.payload);
  const sentSession = sessionRefFrom({ result: sentBody }) ?? sentBody?.native_session_id;
  if (sentBody?.interrupted !== true || sentBody?.process_exited !== true) {
    throw new MyWorkMcpError("MY_WORK_CODEX_STOP_AMBIGUOUS");
  }
  if (sentSession !== sessionId) throw new MyWorkMcpError("MY_WORK_CODEX_STOP_AMBIGUOUS");
  if (!got.ok) return;
  if (got.payload?.result?.running !== false) throw new MyWorkMcpError("MY_WORK_CODEX_STOP_AMBIGUOUS");
  if (sessionRefFrom(got.payload) !== sessionId) throw new MyWorkMcpError("MY_WORK_CODEX_STOP_AMBIGUOUS");
}

function failIfPromptMissing(started, code) {
  if (started.payload?.error?.code === "prompt_missing") {
    throw new MyWorkMcpError("MY_WORK_MISSION_INCOMPLETE");
  }
  if (!started.ok) throw new MyWorkMcpError(code);
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
      const argv = ["agent", "start", name, "--kind", "codex", "--pane", ids.paneId, "--", ...codexExecArgv(text)];
      const started = await herdrJson(argv, { cwd: confined });
      failIfPromptMissing(started, "MY_WORK_CODEX_LAUNCH_AMBIGUOUS");
      const got = await herdrJson(["agent", "get", name], { cwd: confined });
      const sessionId = sessionRefFrom(got.payload) ?? sessionRefFrom(started.payload);
      if (!sessionId) throw new MyWorkMcpError("MY_WORK_CODEX_LAUNCH_AMBIGUOUS");
      const herdrId = herdrIdFrom(ids);
      rejectFabricatedIds(herdrId, sessionId);
      return {
        ambiguous: false,
        herdr_id: herdrId,
        codex_session_id: sessionId,
        status: "launched",
        argv: ["herdr", ...argv],
      };
    },
    async resume({ workspaceRoot, herdrId, sessionId, prompt, authorizedWorkspace, ticketId }) {
      const text = requirePrompt(prompt);
      const confined = await confineAuthorizedWorkspace(authorizedWorkspace ?? workspaceRoot, workspaceRoot);
      const parsed = parseStoredHerdrId(herdrId);
      if (!parsed) throw new MyWorkMcpError("MY_WORK_CODEX_CONTINUE_AMBIGUOUS");
      const name = agentName(ticketId);
      const argv = [
        "agent",
        "start",
        name,
        "--kind",
        "codex",
        "--pane",
        parsed.paneId,
        "--",
        ...codexResumeArgv(sessionId, text),
      ];
      const started = await herdrJson(argv, { cwd: confined });
      failIfPromptMissing(started, "MY_WORK_CODEX_CONTINUE_AMBIGUOUS");
      const got = await herdrJson(["agent", "get", name], { cwd: confined });
      const observed = sessionRefFrom(got.payload);
      if (observed !== sessionId) throw new MyWorkMcpError("MY_WORK_CODEX_CONTINUE_AMBIGUOUS");
      return {
        ambiguous: false,
        herdr_id: herdrId,
        codex_session_id: sessionId,
        status: "resumed",
        argv: ["herdr", ...argv],
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
      let got;
      try {
        got = await herdrJson(["agent", "get", name], { cwd: confined });
      } catch (error) {
        if (error instanceof MyWorkMcpError && error.code === "MY_WORK_CODEX_SESSION_MISSING") {
          got = { ok: false, payload: null };
        } else {
          throw error;
        }
      }
      assertPositiveStop(sent, got, sessionId);
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
