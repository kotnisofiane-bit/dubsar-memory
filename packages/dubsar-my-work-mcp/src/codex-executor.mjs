import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { MyWorkMcpError } from "./canonical.mjs";

export const FAKE_EXPECTED_RELATIVE = "codex-expected.txt";
export const FAKE_EXPECTED_CONTENTS = "expected-write-v1\n";
export const CODEX_LAUNCH_ARGV = Object.freeze(["exec"]);
export const CODEX_RESUME_ARGV = Object.freeze(["exec", "resume"]);

let testExecutor = null;

export function setTestCodexExecutor(executor) {
  testExecutor = executor;
}

export function resetTestCodexExecutor() {
  testExecutor = null;
}

export const FAKE_SESSION_RELATIVE = path.join(".dubsar", "codex-fake-session.json");

async function writeFakeSession(workspaceRoot, record) {
  await mkdir(path.join(workspaceRoot, ".dubsar"), { recursive: true });
  await writeFile(path.join(workspaceRoot, FAKE_SESSION_RELATIVE), `${JSON.stringify(record)}\n`);
}

async function readFakeSession(workspaceRoot) {
  try {
    return JSON.parse(await readFile(path.join(workspaceRoot, FAKE_SESSION_RELATIVE), "utf8"));
  } catch {
    return null;
  }
}

export function createFakeCodexExecutor(options = {}) {
  const live = options.live ?? new Set();
  return {
    kind: "fake",
    async exec({ ticketId, workspaceRoot, missionId }) {
      if (options.ambiguousLaunch === true) {
        return { ambiguous: true };
      }
      const herdrId = `herdr-${ticketId}`;
      const sessionId = `codex-sess-${ticketId}`;
      await mkdir(workspaceRoot, { recursive: true });
      await writeFile(path.join(workspaceRoot, FAKE_EXPECTED_RELATIVE), FAKE_EXPECTED_CONTENTS);
      await writeFakeSession(workspaceRoot, { ticketId, herdrId, sessionId, workspaceRoot, missionId });
      live.add(sessionId);
      return {
        ambiguous: false,
        herdr_id: herdrId,
        codex_session_id: sessionId,
        status: "launched",
        argv: ["codex", ...CODEX_LAUNCH_ARGV],
      };
    },
    async resume({ workspaceRoot, herdrId, sessionId }) {
      if (options.ambiguousResume === true) {
        return { ambiguous: true };
      }
      const known = await readFakeSession(workspaceRoot);
      if (!known || known.sessionId !== sessionId) {
        throw new MyWorkMcpError("MY_WORK_CODEX_SESSION_MISSING");
      }
      if (known.workspaceRoot !== workspaceRoot || known.herdrId !== herdrId) {
        throw new MyWorkMcpError("MY_WORK_SCOPE_EXTENSION");
      }
      live.add(sessionId);
      return {
        ambiguous: false,
        herdr_id: herdrId,
        codex_session_id: sessionId,
        status: "resumed",
        argv: ["codex", ...CODEX_RESUME_ARGV, sessionId],
      };
    },
    async stop({ sessionId, herdrId, workspaceRoot }) {
      const known = workspaceRoot ? await readFakeSession(workspaceRoot) : null;
      if (!known || known.sessionId !== sessionId || known.herdrId !== herdrId) {
        throw new MyWorkMcpError("MY_WORK_CODEX_SESSION_MISSING");
      }
      live.delete(sessionId);
      return {
        ambiguous: false,
        herdr_id: herdrId,
        codex_session_id: sessionId,
        status: "interrupted",
        logging_error: options.stopLoggingError === true,
        mission_success: false,
      };
    },
  };
}

function spawnCodex(argv, cwd) {
  return new Promise((resolve) => {
    const child = spawn("codex", argv, { cwd, env: { PATH: process.env.PATH }, windowsHide: true });
    const chunks = [];
    child.stdout?.on("data", (chunk) => chunks.push(chunk));
    child.stderr?.on("data", (chunk) => chunks.push(chunk));
    child.on("error", () => resolve({ ambiguous: true }));
    child.on("close", (code) => {
      const text = Buffer.concat(chunks).toString("utf8");
      const match = text.match(/session[_ ]id[:\s]+([A-Za-z0-9_-]+)/iu) ?? text.match(/\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/u);
      if (code !== 0 || !match) {
        resolve({ ambiguous: true, text });
        return;
      }
      resolve({ ambiguous: false, sessionId: match[1], text });
    });
  });
}

export function createProcessCodexExecutor() {
  return {
    kind: "process",
    async exec({ workspaceRoot }) {
      const result = await spawnCodex([...CODEX_LAUNCH_ARGV], workspaceRoot);
      if (result.ambiguous) return { ambiguous: true };
      return {
        ambiguous: false,
        herdr_id: `herdr-local`,
        codex_session_id: result.sessionId,
        status: "launched",
        argv: ["codex", ...CODEX_LAUNCH_ARGV],
      };
    },
    async resume({ workspaceRoot, sessionId, herdrId }) {
      const result = await spawnCodex([...CODEX_RESUME_ARGV, sessionId], workspaceRoot);
      if (result.ambiguous) return { ambiguous: true };
      if (result.sessionId !== sessionId) return { ambiguous: true };
      return {
        ambiguous: false,
        herdr_id: herdrId,
        codex_session_id: sessionId,
        status: "resumed",
        argv: ["codex", ...CODEX_RESUME_ARGV, sessionId],
      };
    },
    async stop() {
      return {
        ambiguous: false,
        status: "interrupted",
        mission_success: false,
        logging_error: true,
      };
    },
  };
}

export function resolveCodexExecutor() {
  if (testExecutor) return testExecutor;
  if (process.env.DUBSAR_CODEX_EXECUTOR === "fake") return createFakeCodexExecutor();
  if (process.env.DUBSAR_CODEX_EXECUTOR === "process") return createProcessCodexExecutor();
  throw new MyWorkMcpError("MY_WORK_CODEX_EXECUTOR_UNCONFIGURED");
}
