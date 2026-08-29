import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { request as httpRequest } from "node:http";
import { applyTicketChange, previewTicketChange, readTickets, readTicketAllocations } from "../packages/dubsar-workbench-launcher/src/registry-store.mjs";
import { createTicketDashboardHandler, runTicketCli } from "../packages/dubsar-workbench-launcher/src/launcher.mjs";
import { startTicketInteractiveWorkbenchServer } from "../packages/dubsar-workbench-server/src/server.mjs";

const create = (title = "Premier") => ({ type: "create", title, objective: "Livrer localement", criteria: ["Testé"], work_id: "work-1", project: "DUBSAR", agent: "Codex", branch: "work", pr: "#23", blocker: null, references: ["KOT-116"] });
async function environment() { const allocationRoot = await mkdtemp(path.join(tmpdir(), "dubsar-global-")); const project = async () => { const root = await mkdtemp(path.join(tmpdir(), "dubsar-project-")); await mkdir(path.join(root, ".dubsar")); return root; }; return { allocationRoot, first: await project(), second: await project() }; }
const request = (env, start, projectId, operation, extra = {}) => ({ start, allocationRoot: env.allocationRoot, projectId, operation, ...extra });
async function perform(env, start, projectId, operation, extra = {}) { const input = request(env, start, projectId, operation, extra); const preview = await previewTicketChange(input); await applyTicketChange({ ...input, expectedChange: preview.change_sha256 }); return preview; }

test("allocation globale multi-projets sans collision persiste après redémarrage", async () => {
  const env = await environment(); await perform(env, env.first, "project-a", create()); await perform(env, env.second, "project-b", create("Second"));
  assert.equal((await readTickets({ start: env.first })).tickets[0].id, "DUB-001");
  assert.equal((await readTickets({ start: env.second })).tickets[0].id, "DUB-002");
  assert.equal((await readTicketAllocations(env)).next_number, 3);
});
test("preview/apply exact refuse un digest obsolète et les lectures ne mutent rien", async () => {
  const env = await environment(); const stale = await previewTicketChange(request(env, env.first, "project-a", create())); await perform(env, env.second, "project-b", create("Concurrent"));
  await assert.rejects(applyTicketChange({ ...request(env, env.first, "project-a", create()), expectedChange: stale.change_sha256 }), { code: "TICKET_CHANGE_STALE" });
  const registry = path.join(env.allocationRoot, "ticket-allocations.json"); const before = await readFile(registry); const beforeStat = await stat(registry); await readTicketAllocations(env); assert.deepEqual(await readFile(registry), before); assert.equal((await stat(registry)).mtimeMs, beforeStat.mtimeMs);
});
test("Done exige une observation de confiance corroborée et liée au ticket", async () => {
  const env = await environment(); await perform(env, env.first, "project-a", create()); for (const to of ["To Do", "In Progress", "In Review"]) await perform(env, env.first, "project-a", { type: "transition", id: "DUB-001", to });
  const operation = { type: "transition", id: "DUB-001", to: "Done", github_claim: { repository: "owner/repo", pr: 23, merge_commit_sha: "a".repeat(40) } };
  await assert.rejects(previewTicketChange(request(env, env.first, "project-a", operation)), { code: "TICKET_GITHUB_OBSERVER_REQUIRED" });
  await assert.rejects(previewTicketChange(request(env, env.first, "project-a", operation, { observeGithubMerge: async () => ({ source: "trusted_github_observer", merged: true, repository: "other/repo", pr: 23, merge_commit_sha: "a".repeat(40), ticket_id: "DUB-001" }) })), { code: "TICKET_GITHUB_OBSERVATION_MISMATCH" });
  const observer = async ({ repository, pr, ticket_id }) => ({ source: "trusted_github_observer", merged: true, repository, pr, merge_commit_sha: "a".repeat(40), ticket_id });
  await perform(env, env.first, "project-a", operation, { observeGithubMerge: observer }); assert.equal((await readTickets({ start: env.first })).tickets[0].state, "Done");
});
test("Duplicate exige une cible et la réouverture terminale une confirmation", async () => {
  const env = await environment(); await perform(env, env.first, "project-a", create()); await perform(env, env.first, "project-a", create("Cible"));
  await assert.rejects(previewTicketChange(request(env, env.first, "project-a", { type: "transition", id: "DUB-001", to: "Duplicate" })), { code: "TICKET_DUPLICATE_TARGET_REQUIRED" });
  await perform(env, env.first, "project-a", { type: "transition", id: "DUB-001", to: "Duplicate", duplicate_of: "DUB-002" });
  await assert.rejects(previewTicketChange(request(env, env.first, "project-a", { type: "transition", id: "DUB-001", to: "Backlog" })), { code: "TICKET_REOPEN_CONFIRMATION_REQUIRED" });
  await perform(env, env.first, "project-a", { type: "transition", id: "DUB-001", to: "Backlog", reopen_confirmed: true });
});
test("CLI et Dashboard ont la même conséquence et le même reçu", async () => {
  const env = await environment(); const proposal = path.join(env.allocationRoot, "proposal.json"); await writeFile(proposal, JSON.stringify(create())); const io = { log() {}, error() {} };
  const args = ["tickets", "create", "--start", env.first, "--allocation-root", env.allocationRoot, "--project-id", "project-a", "--proposal", proposal, "--json"];
  const cli = await runTicketCli(args, io); const dashboard = createTicketDashboardHandler({ allocationRoot: env.allocationRoot, projects: [{ project_id: "project-a", root: env.first }] });
  const web = await dashboard("preview", { project_id: "project-a", operation: create() }); assert.equal(web.change_sha256, cli.value.change_sha256);
  const receipt = await dashboard("apply", { project_id: "project-a", operation: create(), expected_change_sha256: web.change_sha256 }); assert.equal(receipt.change_sha256, web.change_sha256);
  await assert.rejects(dashboard("preview", { project_id: "unknown", operation: create(), start: "/free/path" }), { code: "TICKET_DASHBOARD_REQUEST_INVALID" });
});
test("canal loopback accepte uniquement les deux actions JSON sur la capability URL", async () => {
  const html = Buffer.from("<!doctype html><title>My Work</title>"); const digest = (value) => createHash("sha256").update(value).digest("hex");
  const session = await startTicketInteractiveWorkbenchServer({ html, htmlSha256: digest(html), scriptSha256: digest("script"), styleSha256: digest("style"), dataSha256: digest("data") }, async (action, input) => ({ action, input }));
  const send = (suffix, body) => new Promise((resolve, reject) => { const target = new URL(session.url); const bytes = Buffer.from(JSON.stringify(body)); const req = httpRequest({ hostname: target.hostname, port: target.port, path: `${target.pathname}${suffix}`, method: "POST", headers: { Host: target.host, Origin: target.origin, Referer: session.url, "Content-Type": "application/json", "Content-Length": bytes.length } }, (res) => { const chunks = []; res.on("data", (chunk) => chunks.push(chunk)); res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() })); }); req.on("error", reject); req.end(bytes); });
  try { assert.equal((await send("tickets/preview/", { project_id: "a", operation: { type: "create" } })).status, 200); assert.equal((await send("tickets/command/", { command: "rm" })).status, 404); }
  finally { await session.close("test"); }
});
