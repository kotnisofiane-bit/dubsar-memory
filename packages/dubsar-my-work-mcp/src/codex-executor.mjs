import { MyWorkMcpError } from "./canonical.mjs";
import { confineAuthorizedWorkspace } from "./codex-workspace.mjs";
import { assertNoLastFlag, codexExecArgv, codexResumeArgv } from "./codex-json.mjs";
import {
  readSupervisorRun,
  stopSupervisedCodex,
  superviseCodex,
} from "./codex-supervisor.mjs";
import { herdrIdFrom, herdrJson, parseStoredHerdrId, workspaceIdsFrom } from "./herdr-cli.mjs";

export const CODEX_LAUNCH_ARGV = Object.freeze(["exec", "--json"]);
export const CODEX_RESUME_ARGV = Object.freeze(["exec", "resume"]);

let testExecutor = null;

export function setTestCodexExecutor(executor) {
  testExecutor = executor;
}

export function resetTestCodexExecutor() {
  testExecutor = null;
}

function rejectFabricatedIds(herdrId, sessionId) {
  if (herdrId === "herdr-local" || /^herdr-DUB-/u.test(herdrId) || /^herdr-\d/u.test(herdrId)) {
    throw new MyWorkMcpError("MY_WORK_CODEX_LAUNCH_AMBIGUOUS");
  }
  if (/^codex-sess-DUB-/u.test(sessionId)) {
    throw new MyWorkMcpError("MY_WORK_CODEX_LAUNCH_AMBIGUOUS");
  }
}

export { codexExecArgv, codexResumeArgv };

export function createHerdrCodexExecutor() {
  return {
    kind: "herdr",
    async exec({ ticketId, workspaceRoot, prompt, authorizedWorkspace, allocationRoot }) {
      if (typeof allocationRoot !== "string" || allocationRoot.length < 1) {
        throw new MyWorkMcpError("MY_WORK_PROJECT_REQUIRED");
      }
      const confined = await confineAuthorizedWorkspace(authorizedWorkspace ?? workspaceRoot, workspaceRoot);
      const created = await herdrJson(
        ["workspace", "create", "--cwd", confined, "--label", ticketId, "--no-focus"],
        { cwd: confined },
      );
      const ids = workspaceIdsFrom(created.payload);
      if (!ids) throw new MyWorkMcpError("MY_WORK_CODEX_LAUNCH_AMBIGUOUS");
      if (ids.cwd && ids.cwd !== confined) throw new MyWorkMcpError("MY_WORK_SCOPE_EXTENSION");
      const argv = codexExecArgv(prompt);
      assertNoLastFlag(argv);
      const herdrId = herdrIdFrom(ids);
      const supervised = await superviseCodex({
        allocationRoot,
        ticketId,
        herdrId,
        paneId: ids.paneId,
        argv,
        cwd: confined,
      });
      rejectFabricatedIds(herdrId, supervised.sessionId);
      return {
        ambiguous: false,
        herdr_id: herdrId,
        codex_session_id: supervised.sessionId,
        status: "launched",
        herdr_live: "not_found",
        argv: ["herdr", "exec", "--pane", ids.paneId, "--kind", "codex", "--", ...argv],
      };
    },
    async resume({ workspaceRoot, herdrId, sessionId, prompt, authorizedWorkspace, ticketId, allocationRoot }) {
      if (typeof allocationRoot !== "string" || allocationRoot.length < 1) {
        throw new MyWorkMcpError("MY_WORK_PROJECT_REQUIRED");
      }
      const confined = await confineAuthorizedWorkspace(authorizedWorkspace ?? workspaceRoot, workspaceRoot);
      const durable = await readSupervisorRun(allocationRoot, ticketId);
      if (!durable || durable.codex_session_id !== sessionId || durable.herdr_id !== herdrId) {
        throw new MyWorkMcpError("MY_WORK_CODEX_CONTINUE_AMBIGUOUS");
      }
      const parsed = parseStoredHerdrId(herdrId);
      if (!parsed) throw new MyWorkMcpError("MY_WORK_CODEX_CONTINUE_AMBIGUOUS");
      const argv = codexResumeArgv(sessionId, prompt);
      assertNoLastFlag(argv);
      const supervised = await superviseCodex({
        allocationRoot,
        ticketId,
        herdrId,
        paneId: parsed.paneId,
        argv,
        cwd: confined,
      });
      if (supervised.sessionId !== sessionId) throw new MyWorkMcpError("MY_WORK_CODEX_CONTINUE_AMBIGUOUS");
      return {
        ambiguous: false,
        herdr_id: herdrId,
        codex_session_id: sessionId,
        status: "resumed",
        herdr_live: "not_found",
        argv: ["herdr", "exec", "--pane", parsed.paneId, "--kind", "codex", "--", ...argv],
      };
    },
    async stop({ sessionId, herdrId, workspaceRoot, ticketId, authorizedWorkspace, allocationRoot }) {
      await confineAuthorizedWorkspace(authorizedWorkspace ?? workspaceRoot, workspaceRoot);
      const result = await stopSupervisedCodex({ allocationRoot, ticketId, sessionId });
      return {
        ambiguous: false,
        herdr_id: herdrId,
        codex_session_id: sessionId,
        status: result.status,
        interrupted: result.interrupted === true,
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
