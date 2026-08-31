import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "acorn";
import { executeTool } from "../packages/dubsar-my-work-mcp/src/tools.mjs";
import { handleMessage } from "../packages/dubsar-my-work-mcp/src/server.mjs";
import { buildControllerEnvelope, fingerprintOf } from "../packages/dubsar-my-work-mcp/src/canonical.mjs";
import { readTickets } from "../packages/dubsar-workbench-launcher/src/registry-store.mjs";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const mcpRoot = path.join(repositoryRoot, "packages", "dubsar-my-work-mcp");
const sha = "a".repeat(40);
const repo = "https://github.com/owner/repo";
const fingerprintBody = {
  allowed_paths: ["packages/dubsar-my-work-mcp/**"],
  bounds: { autoCreatePR: true, max_runs: 1, polling: false, workOnCurrentBranch: false },
  format: "dubsar.cursor-controller-contract/1",
  repository_refs: [{ repository_url: repo, starting_sha: sha }],
  target_repository_url: repo,
  ticket_id: "DUB-001",
};

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

function receiptFor(envelope, extra = {}) {
  return {
    receipt_version: "dubsar.cursor-launch-receipt/1",
    target_repository_url: envelope.target_repository_url,
    contract_fingerprint: envelope.contract_fingerprint,
    repository_refs: envelope.repository_refs,
    ticket_id: envelope.ticket_id,
    agent_id: "agent-1",
    run_id: "run-1",
    source_url: "https://cursor.example/runs/1",
    status: "launched",
    bounds: envelope.bounds,
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

test("complete mission creates one ticket and a controller envelope", async () => {
  const context = await env();
  const prepared = await executeTool("prepare_cursor_mission", { ...context, ...mission() });
  assert.equal(prepared.ticket_id, "DUB-001");
  assert.equal(prepared.envelope.format, "dubsar.cursor-controller-contract/1");
  assert.equal(prepared.envelope.bounds.polling, false);
  assert.equal(prepared.envelope.bounds.workOnCurrentBranch, false);
  assert.equal(prepared.envelope.bounds.autoCreatePR, true);
  assert.equal(prepared.envelope.contract_fingerprint, fingerprintOf(fingerprintBody));
  const store = await readTickets({ start: context.start });
  assert.equal(store.tickets.length, 1);
  assert.equal(store.tickets[0].state, "Backlog");
  assert.equal(store.tickets[0].references[0], prepared.envelope.contract_fingerprint);
});

test("incomplete mission, bad SHA, unsafe path, repo contradiction, and missing project fail before write", async () => {
  const context = await env();
  const target = path.join(context.start, ".dubsar", "tickets.json");
  await assert.rejects(executeTool("prepare_cursor_mission", { ...context, ...mission({ title: undefined }) }), { code: "MY_WORK_MISSION_INCOMPLETE" });
  await assert.rejects(executeTool("prepare_cursor_mission", { ...context, ...mission({ starting_sha: "not-a-sha" }) }), { code: "MY_WORK_SHA_INVALID" });
  await assert.rejects(executeTool("prepare_cursor_mission", { ...context, ...mission({ allowed_paths: ["../secret"] }) }), { code: "MY_WORK_PATH_UNSAFE" });
  await assert.rejects(executeTool("prepare_cursor_mission", { ...context, ...mission({ allowed_paths: ["/etc/passwd"] }) }), { code: "MY_WORK_PATH_UNSAFE" });
  await assert.rejects(executeTool("prepare_cursor_mission", { ...context, ...mission({ repository_refs: [{ repository_url: "https://github.com/other/repo", starting_sha: sha }] }) }), { code: "MY_WORK_REPOSITORY_CONTRADICTION" });
  await assert.rejects(executeTool("prepare_cursor_mission", { ...mission() }), { code: "MY_WORK_PROJECT_REQUIRED" });
  await assert.equal(await readFile(target).then(() => "exists", () => "missing"), "missing");
  assert.equal((await readTickets({ start: context.start })).tickets.length, 0);
});

test("receipt attaches once, sets In Progress, and is idempotent", async () => {
  const context = await env();
  const prepared = await executeTool("prepare_cursor_mission", { ...context, ...mission() });
  const receipt = receiptFor(prepared.envelope);
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
    receipt: receiptFor(prepared.envelope, { contract_fingerprint: `sha256:${"c".repeat(64)}` }),
  }), { code: "MY_WORK_FINGERPRINT_MISMATCH" });
});

test("sync reuses KOT-119 mapping and persists PR, branch, and SHAs", async () => {
  const context = await env();
  const prepared = await executeTool("prepare_cursor_mission", { ...context, ...mission() });
  await executeTool("attach_cursor_receipt", { ...context, ticket_id: "DUB-001", receipt: receiptFor(prepared.envelope) });
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

test("canonical envelope fingerprint excludes the fingerprint field", () => {
  const envelope = buildControllerEnvelope({
    ticketId: "DUB-001",
    targetRepositoryUrl: repo,
    startingSha: sha,
    allowedPaths: ["packages/dubsar-my-work-mcp/**"],
  });
  assert.equal(envelope.contract_fingerprint, fingerprintOf(fingerprintBody));
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
