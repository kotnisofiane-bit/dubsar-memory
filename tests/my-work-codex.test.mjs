import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { executeTool, HERMES_TOOL_NAMES, TOOL_NAMES } from "../packages/dubsar-my-work-mcp/src/tools.mjs";
import { handleMessage, setMcpProfile } from "../packages/dubsar-my-work-mcp/src/server.mjs";
import {
  createFakeCodexExecutor,
  FAKE_EXPECTED_CONTENTS,
  FAKE_EXPECTED_RELATIVE,
  resetTestCodexExecutor,
  setTestCodexExecutor,
} from "../packages/dubsar-my-work-mcp/src/codex-executor.mjs";
import { previewTicketChange, readTickets } from "../packages/dubsar-workbench-launcher/src/registry-store.mjs";

async function env() {
  const start = await mkdtemp(path.join(tmpdir(), "dubsar-codex-project-"));
  const allocationRoot = await mkdtemp(path.join(tmpdir(), "dubsar-codex-global-"));
  await mkdir(path.join(start, ".dubsar"));
  return { start, allocation_root: allocationRoot, project_id: "project-codex" };
}

function mission(extra = {}) {
  return {
    title: "Lot Codex local",
    objective: "Lancer une session Herdr bornée",
    criteria: ["Ticket unique", "Reprise par identifiant"],
    allowed_paths: ["packages/dubsar-my-work-mcp/**"],
    ...extra,
  };
}

test("public launch persists one ticket and starts exactly one fake Codex session", async () => {
  const context = await env();
  const executor = createFakeCodexExecutor();
  let launches = 0;
  setTestCodexExecutor({
    ...executor,
    async exec(input) {
      launches += 1;
      return executor.exec(input);
    },
  });
  try {
    const launched = await executeTool("launch_codex_mission", { ...context, ...mission() });
    assert.equal(launched.format, "dubsar.my-work-codex-launch/1");
    assert.equal(launched.ticket_id, "DUB-001");
    assert.equal(launched.launched, true);
    assert.equal(launched.mission_success, false);
    assert.equal(launched.codex_session_id, "codex-sess-DUB-001");
    assert.equal(launched.herdr_id, "herdr-DUB-001");
    assert.equal(launches, 1);
    const store = await readTickets({ start: context.start });
    assert.equal(store.tickets.length, 1);
    assert.equal(store.tickets[0].cursor_launch, null);
    assert.equal(store.tickets[0].codex_launch.receipt_version, "dubsar.codex-local-launch-receipt/1");
    assert.equal(store.tickets[0].codex_launch.mission_success, false);
    assert.equal(await readFile(path.join(context.start, FAKE_EXPECTED_RELATIVE), "utf8"), FAKE_EXPECTED_CONTENTS);
  } finally {
    resetTestCodexExecutor();
  }
});

test("independent verifier reads expected file outside the MCP return", async () => {
  const context = await env();
  setTestCodexExecutor(createFakeCodexExecutor());
  try {
    const launched = await executeTool("launch_codex_mission", { ...context, ...mission() });
    assert.equal("expected_file_contents" in launched, false);
    const fromDisk = await readFile(path.join(context.start, FAKE_EXPECTED_RELATIVE), "utf8");
    assert.equal(fromDisk, FAKE_EXPECTED_CONTENTS);
  } finally {
    resetTestCodexExecutor();
  }
});

test("consultation after restart finds contract, history, workspace, Herdr and Codex ids", async () => {
  const context = await env();
  setTestCodexExecutor(createFakeCodexExecutor());
  try {
    await executeTool("launch_codex_mission", { ...context, ...mission() });
    const loaded = await executeTool("get_ticket", { ...context, ticket_id: "DUB-001" });
    assert.equal(loaded.prepared_codex_contract.format, "dubsar.codex-local-contract/1");
    assert.equal(loaded.herdr_id, "herdr-DUB-001");
    assert.equal(loaded.codex_session_id, "codex-sess-DUB-001");
    assert.equal(loaded.workspace_root, context.start);
    assert.ok(loaded.ticket.activity.some((row) => row.kind === "codex_trace"));
    assert.ok(loaded.ticket.activity.some((row) => row.kind === "codex_contract"));
    assert.equal(loaded.ticket.cursor_launch, null);
  } finally {
    resetTestCodexExecutor();
  }
});

test("continue after process-equivalent reread reuses the same Codex session id", async () => {
  const context = await env();
  const executor = createFakeCodexExecutor();
  let resumes = 0;
  setTestCodexExecutor({
    ...executor,
    exec: (input) => executor.exec(input),
    resume: async (input) => {
      resumes += 1;
      return executor.resume(input);
    },
    stop: (input) => executor.stop(input),
  });
  try {
    await executeTool("launch_codex_mission", { ...context, ...mission() });
    const continued = await executeTool("continue_codex_mission", {
      ...context,
      ticket_id: "DUB-001",
      prompt: "Reprendre la même session",
      codex_session_id: "codex-sess-DUB-001",
    });
    assert.equal(continued.continued, true);
    assert.equal(continued.codex_session_id, "codex-sess-DUB-001");
    assert.equal(continued.mission_success, false);
    assert.equal(resumes, 1);
    const store = await readTickets({ start: context.start });
    assert.equal(store.tickets[0].id, "DUB-001");
    assert.equal(store.tickets[0].codex_run.codex_session_id, "codex-sess-DUB-001");
  } finally {
    resetTestCodexExecutor();
  }
});

test("stop interrupts execution only and does not mean mission success", async () => {
  const context = await env();
  setTestCodexExecutor(createFakeCodexExecutor({ stopLoggingError: true }));
  try {
    await executeTool("launch_codex_mission", { ...context, ...mission() });
    const before = await stat(path.join(context.start, FAKE_EXPECTED_RELATIVE));
    const stopped = await executeTool("stop_codex_mission", { ...context, ticket_id: "DUB-001" });
    assert.equal(stopped.interrupted, true);
    assert.equal(stopped.mission_success, false);
    assert.equal(stopped.logging_error, true);
    const after = await stat(path.join(context.start, FAKE_EXPECTED_RELATIVE));
    assert.equal(after.mtimeMs, before.mtimeMs);
    const history = await executeTool("get_ticket", { ...context, ticket_id: "DUB-001" });
    assert.equal(history.ticket.codex_launch.codex_session_id, "codex-sess-DUB-001");
    assert.equal(history.ticket.state, "In Progress");
    assert.equal(history.ticket.codex_stop.mission_success, false);
  } finally {
    resetTestCodexExecutor();
  }
});

test("ambiguous launch is not retryable and does not double-exec", async () => {
  const context = await env();
  let launches = 0;
  setTestCodexExecutor({
    kind: "fake",
    async exec() {
      launches += 1;
      return { ambiguous: true };
    },
  });
  try {
    await assert.rejects(executeTool("launch_codex_mission", { ...context, ...mission() }), {
      code: "MY_WORK_CODEX_LAUNCH_AMBIGUOUS",
    });
    await assert.rejects(executeTool("launch_codex_mission", { ...context, ...mission() }), {
      code: "MY_WORK_CODEX_LAUNCH_NOT_RETRYABLE",
    });
    assert.equal(launches, 1);
    const store = await readTickets({ start: context.start });
    assert.equal(store.tickets[0].codex_launch, null);
    assert.equal(store.tickets[0].state, "Blocked");
  } finally {
    resetTestCodexExecutor();
  }
});

test("missing Codex session is not recreated silently", async () => {
  const context = await env();
  const { MyWorkMcpError } = await import("../packages/dubsar-my-work-mcp/src/canonical.mjs");
  const executor = createFakeCodexExecutor();
  setTestCodexExecutor({
    ...executor,
    exec: (input) => executor.exec(input),
    async resume() {
      throw new MyWorkMcpError("MY_WORK_CODEX_SESSION_MISSING");
    },
  });
  try {
    await executeTool("launch_codex_mission", { ...context, ...mission() });
    await assert.rejects(
      executeTool("continue_codex_mission", { ...context, ticket_id: "DUB-001", prompt: "reprendre" }),
      { code: "MY_WORK_CODEX_SESSION_MISSING" },
    );
  } finally {
    resetTestCodexExecutor();
  }
});

test("auto-approved dialogue and workspace close flags are refused", async () => {
  const context = await env();
  setTestCodexExecutor(createFakeCodexExecutor());
  try {
    await assert.rejects(
      executeTool("launch_codex_mission", { ...context, ...mission({ auto_approve_dialogue: true }) }),
      { code: "MY_WORK_DIALOGUE_AUTO_APPROVE_FORBIDDEN" },
    );
    await assert.rejects(
      executeTool("launch_codex_mission", { ...context, ...mission({ close_homonym_workspace: true }) }),
      { code: "MY_WORK_WORKSPACE_CLOSE_FORBIDDEN" },
    );
    assert.equal((await readTickets({ start: context.start })).tickets.length, 0);
  } finally {
    resetTestCodexExecutor();
  }
});

test("Cursor receipts cannot be stored as Codex receipts and Cursor path still works", async () => {
  const context = await env();
  const created = await executeTool("prepare_cursor_mission", {
    ...context,
    title: "Cursor intact",
    objective: "Non-regression",
    criteria: ["Toujours Cursor"],
    target_repository_url: "https://github.com/owner/repo",
    starting_sha: "a".repeat(40),
    allowed_paths: ["packages/dubsar-my-work-mcp/**"],
  });
  assert.equal(created.ticket_id, "DUB-001");
  await assert.rejects(
    previewTicketChange({
      start: context.start,
      allocationRoot: context.allocation_root,
      projectId: context.project_id,
      operation: {
        type: "attach-codex-launch",
        id: "DUB-001",
        receipt: {
          receipt_version: "dubsar.cursor-launch-receipt/1",
          ticket_id: "DUB-001",
          contract_fingerprint: created.contract_fingerprint,
        },
      },
    }),
    { code: "TICKET_CODEX_RECEIPT_INVALID" },
  );
});

test("Hermes profile exposes only bounded mission tools", async () => {
  setMcpProfile("hermes");
  try {
    const listed = await handleMessage({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    assert.deepEqual(listed.result.tools.map((tool) => tool.name), [...HERMES_TOOL_NAMES]);
    const forbidden = await handleMessage({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "launch_cursor_mission", arguments: {} },
    });
    assert.equal(forbidden.result.structuredContent.code, "MY_WORK_HERMES_TOOL_FORBIDDEN");
    const names = listed.result.tools.map((tool) => tool.name).join(" ");
    assert.equal(/ssh|docker|shell|herdr.sock|socket/i.test(names), false);
    assert.equal(TOOL_NAMES.includes("ssh"), false);
  } finally {
    setMcpProfile("default");
  }
});

test("agent declaration or PROOF.md cannot mark the mission successful", async () => {
  const context = await env();
  setTestCodexExecutor({
    kind: "fake",
    async exec({ ticketId, workspaceRoot }) {
      await writeFile(path.join(workspaceRoot, "PROOF.md"), "success");
      return {
        ambiguous: false,
        herdr_id: `herdr-${ticketId}`,
        codex_session_id: `codex-sess-${ticketId}`,
        status: "launched",
        declared_success: true,
      };
    },
  });
  try {
    const launched = await executeTool("launch_codex_mission", { ...context, ...mission() });
    assert.equal(launched.mission_success, false);
    const ticket = (await readTickets({ start: context.start })).tickets[0];
    assert.equal(ticket.codex_launch.mission_success, false);
    assert.equal(ticket.state, "In Progress");
  } finally {
    resetTestCodexExecutor();
  }
});
