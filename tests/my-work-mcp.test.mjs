import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "acorn";
import { executeTool } from "../packages/dubsar-my-work-mcp/src/tools.mjs";
import { handleMessage, encodeFrame, createFrameParser } from "../packages/dubsar-my-work-mcp/src/server.mjs";
import { buildControllerEnvelope } from "../packages/dubsar-my-work-mcp/src/canonical.mjs";
import { CONTROLLER_ARGUMENT_KEYS, CONTROLLER_TOOL, controllerContractFingerprint } from "../packages/dubsar-my-work-mcp/src/mission-args.mjs";
import { applyTicketChange, previewTicketChange, readTickets } from "../packages/dubsar-workbench-launcher/src/registry-store.mjs";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const mcpRoot = path.join(repositoryRoot, "packages", "dubsar-my-work-mcp");
const sha = "a".repeat(40);
const repo = "https://github.com/owner/repo";
const FROZEN_CONTROLLER_FINGERPRINT =
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
  assert.equal(prepared.arguments.correction_budget, 3);
  assert.equal(prepared.arguments.pr_repository_url, repo);
  assert.equal(prepared.receipt_bounds.stateless, true);
  assert.equal(prepared.receipt_bounds.auto_create_pr, true);
  assert.equal(prepared.receipt_bounds.work_on_current_branch, false);
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

function assertPreparedBinding(prepared, ticket) {
  assert.equal(prepared.ticket_id, ticket.id);
  assert.equal(prepared.arguments.ticket_id, ticket.id);
  assert.equal(ticket.references[0], prepared.contract_fingerprint);
  const contracts = ticket.activity.filter((item) => item.kind === "cursor_contract");
  assert.equal(contracts.length, 1);
  assert.equal(contracts[0].evidence.arguments.ticket_id, ticket.id);
  assert.equal(contracts[0].evidence.contract_fingerprint, prepared.contract_fingerprint);
}

test("prepare binds the allocated ticket after a prior create advances the counter", async () => {
  const context = await env();
  const input = {
    start: context.start,
    allocationRoot: context.allocation_root,
    projectId: context.project_id,
    operation: {
      type: "create",
      title: "Existant",
      objective: "Réserver DUB-001",
      criteria: ["Alloué"],
    },
  };
  const preview = await previewTicketChange(input);
  await applyTicketChange({ ...input, expectedChange: preview.change_sha256 });
  const prepared = await executeTool("prepare_cursor_mission", { ...context, ...mission({ title: "Mission suivante" }) });
  assert.equal(prepared.ticket_id, "DUB-002");
  const store = await readTickets({ start: context.start });
  assert.equal(store.tickets.length, 2);
  assertPreparedBinding(prepared, store.tickets.find((ticket) => ticket.id === "DUB-002"));
  const first = store.tickets.find((ticket) => ticket.id === "DUB-001");
  assert.equal(first.activity.some((item) => item.kind === "cursor_contract"), false);
});

test("concurrent prepares keep each contract on the ticket they allocated", async () => {
  const context = await env();
  const settled = await Promise.allSettled([
    executeTool("prepare_cursor_mission", { ...context, ...mission({ title: "Mission A", objective: "Livrer A" }) }),
    executeTool("prepare_cursor_mission", { ...context, ...mission({ title: "Mission B", objective: "Livrer B" }) }),
  ]);
  const prepared = settled.filter((result) => result.status === "fulfilled").map((result) => result.value);
  assert.equal(prepared.length >= 1, true);
  const store = await readTickets({ start: context.start });
  const boundIds = new Set();
  for (const item of prepared) {
    const ticket = store.tickets.find((row) => row.id === item.ticket_id);
    assert.equal(Boolean(ticket), true);
    assertPreparedBinding(item, ticket);
    boundIds.add(ticket.id);
  }
  for (const ticket of store.tickets) {
    const contracts = ticket.activity.filter((item) => item.kind === "cursor_contract");
    for (const contract of contracts) {
      assert.equal(contract.evidence.arguments.ticket_id, ticket.id);
    }
  }
  assert.equal(boundIds.size, prepared.length);
});

test("prepare is idempotent for the same persisted fingerprint", async () => {
  const context = await env();
  const first = await executeTool("prepare_cursor_mission", { ...context, ...mission() });
  const second = await executeTool("prepare_cursor_mission", { ...context, ...mission() });
  assert.equal(second.ticket_id, first.ticket_id);
  assert.equal(second.persisted, false);
  assert.equal((await readTickets({ start: context.start })).tickets.length, 1);
});

test("frozen Controller vector fingerprint is a literal, not a locally recomputed oracle", async () => {
  const vectorPath = path.join(mcpRoot, "vectors", "controller-canonical-v1.json");
  const vector = JSON.parse(await readFile(vectorPath, "utf8"));
  assert.equal(vector.expected_contract_fingerprint, FROZEN_CONTROLLER_FINGERPRINT);
  assert.notEqual(
    vector.expected_contract_fingerprint,
    "sha256:5d5f41f76154df9ff312e27ddfe9d7dd586a8cdabe23743ee7994a6d5c3d8737",
  );
  assert.equal(vector.controller_tool, CONTROLLER_TOOL);
  assert.equal(vector.controller_revision, "9c5cd6536ebfa5c582a00a9d66cdff1560dd469c");
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

test("frozen realistic Controller receipt attaches; divergences do not mutate", async () => {
  const vector = JSON.parse(
    await readFile(path.join(mcpRoot, "vectors", "controller-canonical-v1.json"), "utf8"),
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
    correction_budget: 3,
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

test("local MCP sources have no network client and no secret tokens", async () => {
  const files = await filesUnder(path.join(mcpRoot, "src"));
  files.push(path.join(mcpRoot, "bin", "dubsar-my-work-mcp.mjs"));
  const forbiddenModules = new Set(["node:http", "node:https", "node:net", "node:tls", "node:dgram", "node:dns", "node:child_process", "undici"]);
  const secret = /api[_-]?key|authorization|bearer|secret|oauth|token/iu;
  for (const file of files) {
    const source = await readFile(file, "utf8");
    assert.doesNotMatch(source, secret);
    const ast = parse(source, { ecmaVersion: "latest", sourceType: "module" });
    for (const node of ast.body) {
      if (node.type === "ImportDeclaration") {
        assert.equal(forbiddenModules.has(node.source.value), false, file);
      }
    }
  }
});
