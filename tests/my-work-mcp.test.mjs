import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "acorn";
import { TOOL_NAMES, executeTool } from "../packages/dubsar-my-work-mcp/src/tools.mjs";
import { handleMessage, encodeFrame, createFrameParser } from "../packages/dubsar-my-work-mcp/src/server.mjs";
import { buildControllerEnvelope } from "../packages/dubsar-my-work-mcp/src/canonical.mjs";
import { CONTROLLER_ARGUMENT_KEYS, CONTROLLER_TOOL, controllerContractFingerprint } from "../packages/dubsar-my-work-mcp/src/mission-args.mjs";
import { applyTicketChange, previewTicketChange, readTickets } from "../packages/dubsar-workbench-launcher/src/registry-store.mjs";
import {
  resetTestControllerTransport,
  setTestControllerTransport,
} from "../packages/dubsar-my-work-mcp/src/controller-client.mjs";
import { connectionStatus, credentialsPath, writeCredentials } from "../packages/dubsar-my-work-mcp/src/oauth-store.mjs";
import { connectController } from "../packages/dubsar-my-work-mcp/src/oauth-flow.mjs";
import { runCli } from "../packages/dubsar-my-work-mcp/src/cli.mjs";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const mcpRoot = path.join(repositoryRoot, "packages", "dubsar-my-work-mcp");
const sha = "a".repeat(40);
const repo = "https://github.com/owner/repo";
const FROZEN_CONTROLLER_FINGERPRINT =
  "sha256:0f70c44c67c84c156eca8d8fcf57cf25340447d5e4d19867377ee2e3be87e3b6";
const LEGACY_CONTROLLER_FINGERPRINT =
  "sha256:56ada5fb957c3c84449688dc79169e093ee4b7d6d05dc0cfc64be9c0db89f574";

async function env() {
  const start = await mkdtemp(path.join(tmpdir(), "dubsar-mcp-project-"));
  const allocationRoot = await mkdtemp(path.join(tmpdir(), "dubsar-mcp-global-"));
  await mkdir(path.join(start, ".dubsar"));
  return { start, allocation_root: allocationRoot, project_id: "project-mcp" };
}

function mission(extra = {}) {
  return {
    title: "Mission bornée",
    objective: "Livrer le lot MCP",
    criteria: ["Ticket persistant"],
    target_repository_url: repo,
    starting_sha: sha,
    allowed_paths: ["packages/dubsar-my-work-mcp/**"],
    ...extra,
  };
}

function receiptFor(prepared, extra = {}) {
  return {
    receipt_version: "dubsar.cursor-launch-receipt/1",
    target_repository_url: prepared.arguments.target_repository_url,
    contract_fingerprint: prepared.contract_fingerprint,
    repository_refs: prepared.arguments.repository_refs,
    ticket_id: prepared.arguments.ticket_id,
    agent_id: "agent-1",
    run_id: "run-1",
    source_url: "https://cursor.example/runs/1",
    status: "launched",
    bounds: prepared.receipt_bounds,
    ...extra,
  };
}

async function filesUnder(root) {
  const entries = await readdir(root, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(absolute));
    else if (entry.isFile() && entry.name.endsWith(".mjs")) files.push(absolute);
  }
  return files;
}

test("list and get are read-only", async () => {
  const context = await env();
  const target = path.join(context.start, ".dubsar");
  const before = await stat(target);
  const listed = await executeTool("list_tickets", context);
  assert.equal(listed.tickets.length, 0);
  await assert.rejects(executeTool("get_ticket", { ...context, ticket_id: "DUB-001" }), { code: "MY_WORK_TICKET_NOT_FOUND" });
  assert.equal((await stat(target)).mtimeMs, before.mtimeMs);
});

test("complete mission creates one ticket and passable Controller arguments", async () => {
  const context = await env();
  const prepared = await executeTool("prepare_cursor_mission", { ...context, ...mission() });
  assert.equal(prepared.ticket_id, "DUB-001");
  assert.equal(prepared.tool, CONTROLLER_TOOL);
  assert.deepEqual(Object.keys(prepared.arguments).sort(), [...CONTROLLER_ARGUMENT_KEYS].sort());
  assert.equal("format" in prepared.arguments, false);
  assert.equal("bounds" in prepared.arguments, false);
  assert.equal("contract_fingerprint" in prepared.arguments, false);
  assert.equal("linear_issue_id" in prepared.arguments, false);
  assert.equal("autoCreatePR" in prepared.arguments, false);
  assert.equal("workOnCurrentBranch" in prepared.arguments, false);
  assert.equal(prepared.arguments.correction_budget, "uncapped");
  assert.equal(prepared.arguments.pr_repository_url, repo);
  assert.equal(prepared.receipt_bounds.stateless, true);
  assert.equal(prepared.receipt_bounds.auto_create_pr, true);
  assert.equal(prepared.receipt_bounds.work_on_current_branch, false);
  assert.equal(prepared.receipt_bounds.correction_budget, "uncapped");
  assert.equal(prepared.receipt_bounds.correction_policy, "uncapped");
  assert.equal(
    prepared.contract_fingerprint,
    controllerContractFingerprint(prepared.arguments),
  );
  const store = await readTickets({ start: context.start });
  assert.equal(store.tickets.length, 1);
  assert.equal(store.tickets[0].state, "Backlog");
  assert.equal(store.tickets[0].references[0], prepared.contract_fingerprint);
  const loaded = await executeTool("get_ticket", { ...context, ticket_id: "DUB-001" });
  assert.equal(loaded.prepared_contract.contract_fingerprint, prepared.contract_fingerprint);
  assert.equal(loaded.prepared_contract.arguments.mission, prepared.arguments.mission);
});

test("incomplete mission, bad SHA, unsafe path, repo contradiction, and missing project fail before write", async () => {
  const context = await env();
  const target = path.join(context.start, ".dubsar", "tickets.json");
  await assert.rejects(executeTool("prepare_cursor_mission", { ...context, ...mission({ title: undefined }) }), { code: "MY_WORK_MISSION_INCOMPLETE" });
  await assert.rejects(executeTool("prepare_cursor_mission", { ...context, ...mission({ starting_sha: "not-a-sha" }) }), { code: "MY_WORK_SHA_INVALID" });
  await assert.rejects(executeTool("prepare_cursor_mission", { ...context, ...mission({ allowed_paths: ["../secret"] }) }), { code: "MY_WORK_PATH_UNSAFE" });
  await assert.rejects(executeTool("prepare_cursor_mission", { ...context, ...mission({ allowed_paths: ["/etc/passwd"] }) }), { code: "MY_WORK_PATH_UNSAFE" });
  await assert.rejects(executeTool("prepare_cursor_mission", { ...context, ...mission({ repository_refs: [{ repository_url: repo, starting_sha: "b".repeat(40) }] }) }), { code: "MY_WORK_SHA_INVALID" });
  await assert.rejects(executeTool("prepare_cursor_mission", { ...context, ...mission({ human_gates: ["merge"] }) }), { code: "MY_WORK_MISSION_INCOMPLETE" });
  await assert.rejects(executeTool("prepare_cursor_mission", { ...context, ...mission({ mission: "x".repeat(4001) }) }), { code: "MY_WORK_MISSION_INCOMPLETE" });
  await assert.rejects(executeTool("prepare_cursor_mission", { ...context, ...mission({ correction_budget: 3 }) }), { code: "MY_WORK_MISSION_INCOMPLETE" });
  await assert.rejects(executeTool("prepare_cursor_mission", { ...context, ...mission({ correction_budget: 4 }) }), { code: "MY_WORK_MISSION_INCOMPLETE" });
  await assert.rejects(executeTool("prepare_cursor_mission", { ...mission() }), { code: "MY_WORK_PROJECT_REQUIRED" });
  await assert.equal(await readFile(target).then(() => "exists", () => "missing"), "missing");
  assert.equal((await readTickets({ start: context.start })).tickets.length, 0);
});

test("receipt attaches once, sets In Progress, and is idempotent", async () => {
  const context = await env();
  const prepared = await executeTool("prepare_cursor_mission", { ...context, ...mission() });
  const receipt = receiptFor(prepared);
  const first = await executeTool("attach_cursor_receipt", { ...context, ticket_id: "DUB-001", receipt });
  assert.equal(first.state, "In Progress");
  assert.equal(first.idempotent, false);
  const second = await executeTool("attach_cursor_receipt", { ...context, ticket_id: "DUB-001", receipt });
  assert.equal(second.idempotent, true);
  const ticket = (await readTickets({ start: context.start })).tickets[0];
  assert.equal(ticket.activity.filter((item) => item.kind === "cursor_launch").length, 1);
  await assert.rejects(executeTool("attach_cursor_receipt", {
    ...context,
    ticket_id: "DUB-001",
    receipt: receiptFor(prepared, { contract_fingerprint: `sha256:${"c".repeat(64)}` }),
  }), { code: "MY_WORK_FINGERPRINT_MISMATCH" });
});

test("sync reuses KOT-119 mapping and persists PR, branch, and SHAs", async () => {
  const context = await env();
  const prepared = await executeTool("prepare_cursor_mission", { ...context, ...mission() });
  await executeTool("attach_cursor_receipt", { ...context, ticket_id: "DUB-001", receipt: receiptFor(prepared) });
  const merge = "c".repeat(40);
  const head = "d".repeat(40);
  const synced = await executeTool("sync_cursor_status", {
    ...context,
    ticket_id: "DUB-001",
    cursor_observation: {
      source: "trusted_cursor_observer",
      ticket_id: "DUB-001",
      agent_id: "agent-1",
      run_id: "run-1",
      lifecycle: "completed",
      pr: { repository: "owner/repo", number: 12 },
    },
    github_observation: {
      source: "trusted_github_observer",
      ticket_id: "DUB-001",
      repository: "owner/repo",
      pr: 12,
      state: "merged",
      branch: "cursor/work",
      head_sha: head,
      merge_commit_sha: merge,
    },
  });
  assert.equal(synced.ticket.state, "Done");
  assert.equal(synced.ticket.pr, "owner/repo#12");
  assert.equal(synced.ticket.branch, "cursor/work");
  assert.equal(synced.ticket.activity.at(-1).evidence.head_sha, head);
  assert.equal(synced.ticket.activity.at(-1).evidence.merge_commit_sha, merge);
  const again = await executeTool("sync_cursor_status", {
    ...context,
    ticket_id: "DUB-001",
    cursor_observation: {
      source: "trusted_cursor_observer",
      ticket_id: "DUB-001",
      agent_id: "agent-1",
      run_id: "run-1",
      lifecycle: "completed",
      pr: { repository: "owner/repo", number: 12 },
    },
    github_observation: {
      source: "trusted_github_observer",
      ticket_id: "DUB-001",
      repository: "owner/repo",
      pr: 12,
      state: "merged",
      branch: "cursor/work",
      head_sha: head,
      merge_commit_sha: merge,
    },
  });
  assert.equal(again.ticket.activity.length, synced.ticket.activity.length);
});

test("MCP initialize and tools/list expose the closed surface", async () => {
  const initialized = await handleMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  assert.equal(initialized.result.serverInfo.name, "dubsar-my-work");
  const listed = await handleMessage({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  assert.deepEqual(listed.result.tools.map((tool) => tool.name), [
    "list_tickets",
    "get_ticket",
    "prepare_cursor_mission",
    "launch_cursor_mission",
    "attach_cursor_receipt",
    "sync_cursor_status",
  ]);
});

test("stdio framing is newline-delimited JSON-RPC", async () => {
  const messages = [];
  const parse = createFrameParser((message) => messages.push(message));
  parse(Buffer.from('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}\n', "utf8"));
  assert.equal(messages[0].method, "initialize");
  const frame = encodeFrame({ jsonrpc: "2.0", id: 2, result: {} });
  assert.equal(frame.includes(0x0a), true);
  assert.equal(frame.toString("utf8").startsWith("Content-Length"), false);
});

test("prepare is idempotent for the same persisted fingerprint", async () => {
  const context = await env();
  const first = await executeTool("prepare_cursor_mission", { ...context, ...mission() });
  const second = await executeTool("prepare_cursor_mission", { ...context, ...mission() });
  assert.equal(second.ticket_id, first.ticket_id);
  assert.equal(second.persisted, false);
  assert.equal((await readTickets({ start: context.start })).tickets.length, 1);
});

test("frozen Controller PR26 vector fingerprint is a literal corroborated by ordered JSON.stringify", async () => {
  const vectorPath = path.join(mcpRoot, "vectors", "controller-canonical-pr26.json");
  const vector = JSON.parse(await readFile(vectorPath, "utf8"));
  assert.equal(vector.expected_contract_fingerprint, FROZEN_CONTROLLER_FINGERPRINT);
  assert.equal(vector.controller_revision, "90a35ac02cf22399e389b048acf2c074053b763d");
  const { createHash } = await import("node:crypto");
  const independent = `sha256:${createHash("sha256").update(vector.controller_ordered_fingerprint_json, "utf8").digest("hex")}`;
  assert.equal(independent, FROZEN_CONTROLLER_FINGERPRINT);
  assert.equal(JSON.stringify(vector.unsigned_arguments.correction_budget), JSON.stringify("uncapped"));
  assert.notEqual(
    vector.expected_contract_fingerprint,
    LEGACY_CONTROLLER_FINGERPRINT,
  );
  assert.equal(vector.controller_tool, CONTROLLER_TOOL);
  const prepared = buildControllerEnvelope({
    ticketId: vector.unsigned_arguments.ticket_id,
    targetRepositoryUrl: vector.unsigned_arguments.target_repository_url,
    startingSha: vector.unsigned_arguments.repository_refs[0].starting_sha,
    allowedPaths: vector.unsigned_arguments.allowed_paths,
    mission: vector.unsigned_arguments.mission,
    acceptanceCriteria: vector.unsigned_arguments.acceptance_criteria,
    expectedEvidence: vector.unsigned_arguments.expected_evidence,
    requiredCapabilities: vector.unsigned_arguments.required_capabilities,
    preferredPlugins: vector.unsigned_arguments.preferred_plugins,
    requiredPlugins: vector.unsigned_arguments.required_plugins,
    humanGates: vector.unsigned_arguments.human_gates,
  });
  assert.deepEqual(Object.keys(prepared.arguments).sort(), [...CONTROLLER_ARGUMENT_KEYS].sort());
  assert.equal(prepared.contract_fingerprint, FROZEN_CONTROLLER_FINGERPRINT);
  assert.equal(JSON.stringify(prepared.receipt_bounds), JSON.stringify(vector.receipt_bounds));
  assert.equal(
    JSON.stringify(prepared.arguments.acceptance_criteria),
    JSON.stringify(vector.unsigned_arguments.acceptance_criteria),
  );
});

test("frozen realistic Controller PR26 receipt attaches; divergences do not mutate", async () => {
  const vector = JSON.parse(
    await readFile(path.join(mcpRoot, "vectors", "controller-canonical-pr26.json"), "utf8"),
  );
  const context = await env();
  const prepared = await executeTool("prepare_cursor_mission", {
    ...context,
    title: "KOT-126",
    objective: "MCP local My Work",
    criteria: ["Ticket persisté"],
    target_repository_url: vector.unsigned_arguments.target_repository_url,
    starting_sha: vector.unsigned_arguments.repository_refs[0].starting_sha,
    allowed_paths: vector.unsigned_arguments.allowed_paths,
    linear_issue_id: "KOT-126",
    mission: vector.unsigned_arguments.mission,
    acceptance_criteria: vector.unsigned_arguments.acceptance_criteria,
    expected_evidence: vector.unsigned_arguments.expected_evidence,
    required_capabilities: vector.unsigned_arguments.required_capabilities,
    preferred_plugins: vector.unsigned_arguments.preferred_plugins,
    required_plugins: vector.unsigned_arguments.required_plugins,
    human_gates: vector.unsigned_arguments.human_gates,
    correction_budget: "uncapped",
  });
  assert.equal(prepared.contract_fingerprint, FROZEN_CONTROLLER_FINGERPRINT);
  assert.deepEqual(Object.keys(prepared.arguments).sort(), [...CONTROLLER_ARGUMENT_KEYS].sort());
  assert.equal(JSON.stringify(prepared.receipt_bounds), JSON.stringify(vector.receipt_bounds));
  const ticketsFile = path.join(context.start, ".dubsar", "tickets.json");
  const first = await executeTool("attach_cursor_receipt", {
    ...context,
    ticket_id: "DUB-001",
    receipt: vector.realistic_receipt,
  });
  assert.equal(first.state, "In Progress");
  const before = await stat(ticketsFile);
  await assert.rejects(
    executeTool("attach_cursor_receipt", {
      ...context,
      ticket_id: "DUB-001",
      receipt: { ...vector.realistic_receipt, ticket_id: "DUB-002" },
    }),
    { code: "MY_WORK_TICKET_MISMATCH" },
  );
  await assert.rejects(
    executeTool("attach_cursor_receipt", {
      ...context,
      ticket_id: "DUB-001",
      receipt: {
        ...vector.realistic_receipt,
        target_repository_url: "https://github.com/other/repo",
      },
    }),
    { code: "MY_WORK_RECEIPT_MISMATCH" },
  );
  await assert.rejects(
    executeTool("attach_cursor_receipt", {
      ...context,
      ticket_id: "DUB-001",
      receipt: {
        ...vector.realistic_receipt,
        repository_refs: [
          {
            repository_url: vector.unsigned_arguments.target_repository_url,
            starting_sha: "b".repeat(40),
          },
        ],
      },
    }),
    { code: "MY_WORK_RECEIPT_MISMATCH" },
  );
  await assert.rejects(
    executeTool("attach_cursor_receipt", {
      ...context,
      ticket_id: "DUB-001",
      receipt: { ...vector.realistic_receipt, bounds: { ...vector.realistic_receipt.bounds, auto_create_pr: false } },
    }),
    { code: "MY_WORK_RECEIPT_MISMATCH" },
  );
  await assert.rejects(
    executeTool("attach_cursor_receipt", {
      ...context,
      ticket_id: "DUB-001",
      expected_contract_fingerprint: `sha256:${"c".repeat(64)}`,
      receipt: { ...vector.realistic_receipt, contract_fingerprint: `sha256:${"c".repeat(64)}` },
    }),
    { code: "MY_WORK_FINGERPRINT_MISMATCH" },
  );
  await assert.rejects(
    executeTool("attach_cursor_receipt", {
      ...context,
      ticket_id: "DUB-001",
      receipt: {
        ...vector.realistic_receipt,
        bounds: { autoCreatePR: true, max_runs: 1, polling: false, workOnCurrentBranch: false },
      },
    }),
    { code: "MY_WORK_RECEIPT_MISMATCH" },
  );
  assert.equal((await stat(ticketsFile)).mtimeMs, before.mtimeMs);
});

test("one public launch call creates one ticket, one Controller request, matching receipt, and survives restart", async () => {
  const context = await env();
  const calls = [];
  setTestControllerTransport(async (request) => {
    calls.push(request);
    assert.equal(request.tool, CONTROLLER_TOOL);
    assert.equal("contract_fingerprint" in request.arguments, false);
    assert.equal("receipt_bounds" in request.arguments, false);
    const preparedLater = await executeTool("get_ticket", { ...context, ticket_id: "DUB-001" });
    assert.deepEqual(request.arguments, preparedLater.prepared_contract.arguments);
    return receiptFor({ arguments: request.arguments, contract_fingerprint: preparedLater.prepared_contract.contract_fingerprint, receipt_bounds: preparedLater.prepared_contract.receipt_bounds });
  });
  try {
    const launched = await executeTool("launch_cursor_mission", { ...context, ...mission() });
    assert.equal(launched.ticket_id, "DUB-001");
    assert.equal(launched.agent_id, "agent-1");
    assert.equal(launched.run_id, "run-1");
    assert.equal(launched.state, "In Progress");
    assert.equal(calls.length, 1);
    const again = await executeTool("launch_cursor_mission", { ...context, ...mission() });
    assert.equal(again.launched, false);
    assert.equal(calls.length, 1);
    const restarted = await executeTool("get_ticket", { ...context, ticket_id: "DUB-001" });
    assert.equal(restarted.ticket.state, "In Progress");
    assert.equal(restarted.attached_receipt.run_id, "run-1");
    assert.equal(restarted.attached_receipt.agent_id, "agent-1");
  } finally {
    resetTestControllerTransport();
  }
});

test("legacy budget-3 tickets and receipts stay readable and unchanged after reread", async () => {
  const context = await env();
  const vector = JSON.parse(await readFile(path.join(mcpRoot, "vectors", "controller-canonical-v1.json"), "utf8"));
  const envelope = {
    arguments: vector.unsigned_arguments,
    contract_fingerprint: vector.expected_contract_fingerprint,
    receipt_bounds: vector.receipt_bounds,
  };
  async function apply(operation) {
    const preview = await previewTicketChange({
      start: context.start,
      allocationRoot: context.allocation_root,
      projectId: context.project_id,
      operation,
    });
    await applyTicketChange({
      start: context.start,
      allocationRoot: context.allocation_root,
      projectId: context.project_id,
      operation,
      expectedChange: preview.change_sha256,
    });
  }
  await apply({
    type: "create",
    title: "Legacy budget 3",
    objective: "Ancien contrat",
    criteria: ["Ticket persisté"],
    references: [envelope.contract_fingerprint, envelope.arguments.target_repository_url],
  });
  await apply({
    type: "activity",
    id: "DUB-001",
    kind: "cursor_contract",
    summary: `${CONTROLLER_TOOL} arguments persisted`,
    evidence: envelope,
  });
  const attached = await executeTool("attach_cursor_receipt", {
    ...context,
    ticket_id: "DUB-001",
    receipt: vector.realistic_receipt,
  });
  assert.equal(attached.state, "In Progress");
  const first = await executeTool("get_ticket", { ...context, ticket_id: "DUB-001" });
  assert.equal(first.prepared_contract.arguments.correction_budget, 3);
  assert.equal(first.prepared_contract.receipt_bounds.correction_budget, 3);
  assert.equal("correction_policy" in first.prepared_contract.receipt_bounds, false);
  assert.equal(first.attached_receipt.bounds.correction_budget, 3);
  assert.equal(first.prepared_contract.contract_fingerprint, LEGACY_CONTROLLER_FINGERPRINT);
  const ticketsFile = path.join(context.start, ".dubsar", "tickets.json");
  const before = await readFile(ticketsFile);
  const second = await executeTool("get_ticket", { ...context, ticket_id: "DUB-001" });
  assert.deepEqual(second.prepared_contract, first.prepared_contract);
  assert.deepEqual(second.attached_receipt, first.attached_receipt);
  assert.equal((await readFile(ticketsFile)).toString("utf8"), before.toString("utf8"));
  await assert.rejects(
    executeTool("attach_cursor_receipt", {
      ...context,
      ticket_id: "DUB-001",
      receipt: {
        ...vector.realistic_receipt,
        bounds: { ...vector.realistic_receipt.bounds, correction_budget: "uncapped", correction_policy: "uncapped" },
      },
    }),
    { code: "MY_WORK_RECEIPT_MISMATCH" },
  );
  assert.equal((await readFile(ticketsFile)).toString("utf8"), before.toString("utf8"));
});

async function preparePr26(context, vector) {
  return executeTool("prepare_cursor_mission", {
    ...context,
    title: "KOT-126",
    objective: "MCP local My Work",
    criteria: ["Ticket persisté"],
    target_repository_url: vector.unsigned_arguments.target_repository_url,
    starting_sha: vector.unsigned_arguments.repository_refs[0].starting_sha,
    allowed_paths: vector.unsigned_arguments.allowed_paths,
    mission: vector.unsigned_arguments.mission,
    acceptance_criteria: vector.unsigned_arguments.acceptance_criteria,
    expected_evidence: vector.unsigned_arguments.expected_evidence,
    required_capabilities: vector.unsigned_arguments.required_capabilities,
    preferred_plugins: vector.unsigned_arguments.preferred_plugins,
    required_plugins: vector.unsigned_arguments.required_plugins,
    human_gates: vector.unsigned_arguments.human_gates,
  });
}

test("isolated Controller run receipts 4 and 5 attach as first matching receipts", async () => {
  const vector = JSON.parse(await readFile(path.join(mcpRoot, "vectors", "controller-canonical-pr26.json"), "utf8"));
  assert.equal(vector.follow_up_4_receipt.receipt_version, "dubsar.cursor-run-receipt/1");
  assert.equal(vector.follow_up_5_receipt.receipt_version, "dubsar.cursor-run-receipt/1");
  assert.equal(vector.follow_up_4_receipt.agent_id, vector.realistic_receipt.agent_id);
  assert.equal(vector.follow_up_5_receipt.agent_id, vector.realistic_receipt.agent_id);
  assert.equal(vector.follow_up_4_receipt.bounds.correction_number, 4);
  assert.equal(vector.follow_up_5_receipt.bounds.correction_number, 5);
  const four = await env();
  await preparePr26(four, vector);
  const attachedFour = await executeTool("attach_cursor_receipt", {
    ...four,
    ticket_id: "DUB-001",
    receipt: vector.follow_up_4_receipt,
  });
  assert.equal(attachedFour.state, "In Progress");
  assert.equal(attachedFour.cursor_launch.run_id, vector.follow_up_4_receipt.run_id);
  assert.equal(attachedFour.cursor_launch.bounds.correction_number, 4);
  const five = await env();
  await preparePr26(five, vector);
  const attachedFive = await executeTool("attach_cursor_receipt", {
    ...five,
    ticket_id: "DUB-001",
    receipt: vector.follow_up_5_receipt,
  });
  assert.equal(attachedFive.state, "In Progress");
  assert.equal(attachedFive.cursor_launch.run_id, vector.follow_up_5_receipt.run_id);
  assert.equal(attachedFive.cursor_launch.bounds.correction_number, 5);
  assert.equal(TOOL_NAMES.includes("create_dubsar_work_cursor_agent_run"), false);
});

test("already-attached receipt cannot be replaced; run-receipt divergences are refused", async () => {
  const vector = JSON.parse(await readFile(path.join(mcpRoot, "vectors", "controller-canonical-pr26.json"), "utf8"));
  const context = await env();
  await preparePr26(context, vector);
  await executeTool("attach_cursor_receipt", {
    ...context,
    ticket_id: "DUB-001",
    receipt: vector.follow_up_4_receipt,
  });
  const ticketsFile = path.join(context.start, ".dubsar", "tickets.json");
  const before = await readFile(ticketsFile);
  await assert.rejects(
    executeTool("attach_cursor_receipt", {
      ...context,
      ticket_id: "DUB-001",
      receipt: vector.follow_up_5_receipt,
    }),
    { code: "MY_WORK_RECEIPT_MISMATCH" },
  );
  const other = await env();
  await preparePr26(other, vector);
  await assert.rejects(
    executeTool("attach_cursor_receipt", {
      ...other,
      ticket_id: "DUB-001",
      receipt: {
        ...vector.follow_up_4_receipt,
        bounds: { ...vector.follow_up_4_receipt.bounds, correction_budget: 3 },
      },
    }),
    { code: "MY_WORK_RECEIPT_MISMATCH" },
  );
  await assert.rejects(
    executeTool("attach_cursor_receipt", {
      ...other,
      ticket_id: "DUB-001",
      receipt: { ...vector.follow_up_4_receipt, receipt_version: "dubsar.cursor-launch-receipt/1" },
    }),
    { code: "MY_WORK_RECEIPT_MISMATCH" },
  );
  const withoutNumber = structuredClone(vector.follow_up_4_receipt);
  delete withoutNumber.bounds.correction_number;
  await assert.rejects(
    executeTool("attach_cursor_receipt", {
      ...other,
      ticket_id: "DUB-001",
      receipt: withoutNumber,
    }),
    { code: "MY_WORK_RECEIPT_MISMATCH" },
  );
  assert.equal((await readFile(ticketsFile)).toString("utf8"), before.toString("utf8"));
  assert.equal((await readTickets({ start: other.start })).tickets[0].cursor_launch, null);
});

test("ambiguous Controller response is not retried and fabricates no receipt", async () => {
  const context = await env();
  const calls = [];
  setTestControllerTransport(async (request) => {
    calls.push(request);
    return {};
  });
  try {
    await assert.rejects(
      executeTool("launch_cursor_mission", { ...context, ...mission() }),
      { code: "MY_WORK_LAUNCH_AMBIGUOUS" },
    );
    assert.equal(calls.length, 1);
    await assert.rejects(
      executeTool("launch_cursor_mission", { ...context, ...mission() }),
      { code: "MY_WORK_LAUNCH_NOT_RETRYABLE" },
    );
    assert.equal(calls.length, 1);
    const loaded = await executeTool("get_ticket", { ...context, ticket_id: "DUB-001" });
    assert.equal(loaded.attached_receipt, null);
    assert.notEqual(loaded.ticket.state, "In Progress");
    assert.equal(loaded.ticket.cursor_launch, null);
  } finally {
    resetTestControllerTransport();
  }
});

test("browser OAuth connect stores credentials locally and redacts them from output", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "dubsar-mcp-connect-"));
  const previous = {
    config: process.env.DUBSAR_MY_WORK_CONFIG_DIR,
    url: process.env.DUBSAR_CONTROLLER_URL,
    auth: process.env.DUBSAR_CONTROLLER_AUTHORIZATION_ENDPOINT,
    token: process.env.DUBSAR_CONTROLLER_TOKEN_ENDPOINT,
    client: process.env.DUBSAR_CONTROLLER_CLIENT_ID,
    open: process.env.DUBSAR_MY_WORK_OPEN_BROWSER,
  };
  let tokenHits = 0;
  const tokenServer = createServer((request, response) => {
    tokenHits += 1;
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      assert.match(body, /code=auth-code/);
      assert.doesNotMatch(body, /super-secret/);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        access_token: "super-secret-access-token",
        refresh_token: "super-secret-refresh-token",
        token_type: "Bearer",
        expires_in: 3600,
      }));
    });
  });
  await new Promise((resolve) => tokenServer.listen(0, "127.0.0.1", resolve));
  const tokenPort = tokenServer.address().port;
  process.env.DUBSAR_MY_WORK_CONFIG_DIR = dir;
  process.env.DUBSAR_CONTROLLER_URL = "https://controller.example/mcp";
  process.env.DUBSAR_CONTROLLER_AUTHORIZATION_ENDPOINT = "https://controller.example/authorize";
  process.env.DUBSAR_CONTROLLER_TOKEN_ENDPOINT = `http://127.0.0.1:${tokenPort}/token`;
  process.env.DUBSAR_CONTROLLER_CLIENT_ID = "public-client";
  process.env.DUBSAR_MY_WORK_OPEN_BROWSER = "0";
  const chunks = [];
  try {
    const done = connectController({
      write: { write(text) { chunks.push(text); return true; } },
      openBrowserImpl: async (url) => {
        const parsed = new URL(url);
        assert.equal(parsed.searchParams.get("code_challenge_method"), "S256");
        const redirect = parsed.searchParams.get("redirect_uri");
        const state = parsed.searchParams.get("state");
        await fetch(`${redirect}?code=auth-code&state=${state}`);
      },
    });
    await done;
    const output = chunks.join("");
    assert.match(output, /Open this URL/);
    assert.doesNotMatch(output, /super-secret-access-token/);
    const stored = JSON.parse(await readFile(path.join(dir, "credentials.json"), "utf8"));
    assert.equal(stored.access_token, "super-secret-access-token");
    assert.equal(tokenHits, 1);
    const statusChunks = [];
    await runCli(["status"], { stdout: { write(text) { statusChunks.push(text); return true; } } });
    assert.doesNotMatch(statusChunks.join(""), /super-secret-access-token/);
  } finally {
    tokenServer.close();
    for (const [key, value] of Object.entries({
      DUBSAR_MY_WORK_CONFIG_DIR: previous.config,
      DUBSAR_CONTROLLER_URL: previous.url,
      DUBSAR_CONTROLLER_AUTHORIZATION_ENDPOINT: previous.auth,
      DUBSAR_CONTROLLER_TOKEN_ENDPOINT: previous.token,
      DUBSAR_CONTROLLER_CLIENT_ID: previous.client,
      DUBSAR_MY_WORK_OPEN_BROWSER: previous.open,
    })) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("CLI status redacts credentials and stores them only in the local config dir", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "dubsar-mcp-oauth-"));
  const previous = process.env.DUBSAR_MY_WORK_CONFIG_DIR;
  process.env.DUBSAR_MY_WORK_CONFIG_DIR = dir;
  try {
    await writeCredentials({
      controller_url: "https://controller.example/mcp",
      access_token: "super-secret-access-token",
      refresh_token: "super-secret-refresh-token",
    });
    const chunks = [];
    await runCli(["status"], { stdout: { write(text) { chunks.push(text); return true; } } });
    const output = chunks.join("");
    assert.match(output, /\[redacted\]/);
    assert.doesNotMatch(output, /super-secret-access-token/);
    assert.doesNotMatch(output, /super-secret-refresh-token/);
    const status = await connectionStatus();
    assert.equal(status.connected, true);
    assert.equal(status.access_token, "[redacted]");
    assert.equal(credentialsPath().startsWith(dir), true);
    const tracked = spawnSync("git", ["check-ignore", "-q", credentialsPath()], { cwd: repositoryRoot });
    assert.equal(path.relative(repositoryRoot, credentialsPath()).startsWith("..") || tracked.status === 0, true);
  } finally {
    if (previous == null) delete process.env.DUBSAR_MY_WORK_CONFIG_DIR;
    else process.env.DUBSAR_MY_WORK_CONFIG_DIR = previous;
  }
});

test("OAuth and Controller network stay in dedicated modules; credentials are not in the package tree", async () => {
  const files = await filesUnder(path.join(mcpRoot, "src"));
  files.push(path.join(mcpRoot, "bin", "dubsar-my-work-mcp.mjs"));
  const networkFiles = new Set([
    path.join(mcpRoot, "src", "oauth-flow.mjs"),
    path.join(mcpRoot, "src", "controller-client.mjs"),
  ]);
  const oauthFiles = new Set([
    ...networkFiles,
    path.join(mcpRoot, "src", "oauth-store.mjs"),
    path.join(mcpRoot, "src", "redact.mjs"),
    path.join(mcpRoot, "src", "cli.mjs"),
    path.join(mcpRoot, "src", "tools.mjs"),
    path.join(mcpRoot, "src", "index.mjs"),
  ]);
  const forbiddenModules = new Set(["node:https", "node:net", "node:tls", "node:dgram", "node:dns", "undici"]);
  const secretLiteral = /super-secret|sk_live_|eyJ[A-Za-z0-9_-]{20,}/u;
  for (const file of files) {
    const source = await readFile(file, "utf8");
    assert.doesNotMatch(source, secretLiteral);
    const ast = parse(source, { ecmaVersion: "latest", sourceType: "module" });
    for (const node of ast.body) {
      if (node.type === "ImportDeclaration") {
        if (node.source.value === "node:http" || node.source.value === "node:child_process") {
          assert.equal(file, path.join(mcpRoot, "src", "oauth-flow.mjs"));
          continue;
        }
        assert.equal(forbiddenModules.has(node.source.value), false, file);
      }
    }
    if (!oauthFiles.has(file)) {
      assert.doesNotMatch(source, /oauth|access_token|authorization|bearer/iu);
    }
  }
  const packageFiles = await readdir(mcpRoot, { recursive: true });
  assert.equal(packageFiles.includes("credentials.json"), false);
});
