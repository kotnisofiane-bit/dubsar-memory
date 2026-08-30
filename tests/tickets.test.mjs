import test from "node:test";
import assert from "node:assert/strict";
import { link, mkdir, mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";
import { spawnSync } from "node:child_process";
import { applyTicketChange, previewTicketChange, readTickets, readTicketAllocations } from "../packages/dubsar-workbench-launcher/src/registry-store.mjs";
import { createTicketDashboardHandler, runTicketCli } from "../packages/dubsar-workbench-launcher/src/launcher.mjs";
import { startTicketInteractiveWorkbenchServer } from "../packages/dubsar-workbench-server/src/server.mjs";

const create = (title = "Premier") => ({ type: "create", title, objective: "Livrer localement", criteria: ["Testé"], work_id: "work-1", project: "DUBSAR", agent: "Codex", branch: "work", pr: "#23", blocker: null, references: ["KOT-116"] });
async function environment() { const allocationRoot = await mkdtemp(path.join(tmpdir(), "dubsar-global-")); const project = async () => { const root = await mkdtemp(path.join(tmpdir(), "dubsar-project-")); await mkdir(path.join(root, ".dubsar")); return root; }; return { allocationRoot, first: await project(), second: await project() }; }
const request = (env, start, projectId, operation, extra = {}) => ({ start, allocationRoot: env.allocationRoot, projectId, operation, lockOwner: { owner_port: 54321, owner_nonce: randomBytes(16).toString("hex") }, isLockOwnerActive: async (owner) => owner.owner_port === 54321, ...extra });
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
  const receipt = await dashboard("apply", { project_id: "project-a", operation: create(), expected_change_sha256: web.change_sha256 }); assert.equal(receipt.receipt.change_sha256, web.change_sha256);
  await assert.rejects(dashboard("preview", { project_id: "unknown", operation: create(), start: "/free/path" }), { code: "TICKET_DASHBOARD_REQUEST_INVALID" });
});
test("canal loopback accepte uniquement les deux actions JSON sur la capability URL", async () => {
  const html = Buffer.from("<!doctype html><title>My Work</title>"); const digest = (value) => createHash("sha256").update(value).digest("hex");
  const session = await startTicketInteractiveWorkbenchServer({ html, htmlSha256: digest(html), scriptSha256: digest("script"), styleSha256: digest("style"), dataSha256: digest("data") }, async (action, input) => ({ action, input }));
  const document = () => new Promise((resolve, reject) => { const target = new URL(session.url); const req = httpRequest({ hostname: target.hostname, port: target.port, path: target.pathname, method: "GET", headers: { Host: target.host, "Sec-Fetch-Dest": "document", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Site": "none", "Sec-Fetch-User": "?1" } }, (res) => { res.resume(); res.on("end", () => resolve({ status: res.statusCode, headers: res.headers })); }); req.on("error", reject); req.end(); });
  const send = (suffix, body) => new Promise((resolve, reject) => { const target = new URL(session.url); const bytes = Buffer.from(JSON.stringify(body)); const req = httpRequest({ hostname: target.hostname, port: target.port, path: `${target.pathname}${suffix}`, method: "POST", headers: { Host: target.host, Origin: target.origin, Referer: session.url, "Content-Type": "application/json", "Content-Length": bytes.length } }, (res) => { const chunks = []; res.on("data", (chunk) => chunks.push(chunk)); res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() })); }); req.on("error", reject); req.end(bytes); });
  try { const page = await document(); assert.equal(page.status, 200); assert.equal(page.headers["referrer-policy"], "same-origin"); assert.equal((await send("tickets/preview/", { project_id: "a", operation: { type: "create" } })).status, 200); assert.equal((await send("tickets/command/", { command: "rm" })).status, 404); }
  finally { await session.close("test"); }
});
test("deux apply concurrents sont sérialisés sans doublon ni état partiel", async () => {
  const env = await environment(); const one = request(env, env.first, "project-a", create("A")); const two = request(env, env.second, "project-b", create("B"));
  const [firstPreview, secondPreview] = await Promise.all([previewTicketChange(one), previewTicketChange(two)]);
  const results = await Promise.allSettled([applyTicketChange({ ...one, expectedChange: firstPreview.change_sha256 }), applyTicketChange({ ...two, expectedChange: secondPreview.change_sha256 })]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const stores = await Promise.all([readTickets({ start: env.first }), readTickets({ start: env.second })]);
  assert.equal(stores.flatMap((store) => store.tickets).filter((ticket) => ticket.id === "DUB-001").length, 1);
  assert.equal((await readTicketAllocations(env)).allocations.length, 1);
});
test("échec de publication projet ne consomme aucune allocation", async () => {
  const env = await environment(); const input = request(env, env.first, "project-a", create()); const preview = await previewTicketChange(input);
  await mkdir(path.join(env.first, ".dubsar", "tickets.json"));
  await assert.rejects(applyTicketChange({ ...input, expectedChange: preview.change_sha256 }));
  assert.equal((await readTicketAllocations(env)).allocations.length, 0);
  assert.equal((await readTickets({ start: env.second })).tickets.length, 0);
});
test("le binaire installé expose réellement tickets list/create", async () => {
  const env = await environment(); const proposal = path.join(env.allocationRoot, "public-proposal.json"); await writeFile(proposal, JSON.stringify(create("CLI publique")));
  const bin = path.resolve("packages/dubsar-workbench-launcher/bin/dubsar-workbench-open.mjs");
  const base = [bin, "tickets", "create", "--start", env.first, "--allocation-root", env.allocationRoot, "--project-id", "project-a", "--proposal", proposal, "--json"];
  const preview = spawnSync(process.execPath, base, { encoding: "utf8" }); assert.equal(preview.status, 0, preview.stderr); const change = JSON.parse(preview.stdout).change_sha256;
  const apply = spawnSync(process.execPath, [...base, "--apply", "--expected-change", change], { encoding: "utf8" }); assert.equal(apply.status, 0, apply.stderr);
  const list = spawnSync(process.execPath, [bin, "tickets", "list", "--start", env.first, "--allocation-root", env.allocationRoot, "--project-id", "project-a", "--json"], { encoding: "utf8" }); assert.equal(list.status, 0, list.stderr); assert.equal(JSON.parse(list.stdout).tickets[0].title, "CLI publique");
});
test("verrou versionné actif reste intact et retourne busy", async () => {
  const env = await environment(); const input = request(env, env.first, "project-a", create()); const preview = await previewTicketChange(input); const lock = path.join(env.allocationRoot, "ticket-allocations.lock"); const now = Date.now(); const record = { format: "dubsar.ticket-allocation-lock/1", acquired_at_ms: now, expires_at_ms: now + 30_000, owner_nonce: "b".repeat(32) }; await writeFile(lock, JSON.stringify(record));
  await assert.rejects(applyTicketChange({ ...input, expectedChange: preview.change_sha256, lockNow: () => now + 1 }), { code: "TICKET_ALLOCATION_BUSY" });
  assert.deepEqual(JSON.parse(await readFile(lock, "utf8")), record);
});
test("verrou abandonné est récupéré sans suppression manuelle et survit au redémarrage simulé", async () => {
  const env = await environment(); const input = request(env, env.first, "project-a", create()); const preview = await previewTicketChange(input); await writeFile(path.join(env.allocationRoot, "ticket-allocations.lock"), JSON.stringify({ format: "dubsar.ticket-allocation-lock/1", acquired_at_ms: 1, expires_at_ms: 30_001, owner_nonce: "c".repeat(32) }));
  await applyTicketChange({ ...input, expectedChange: preview.change_sha256, lockNow: () => 60_000 });
  assert.equal((await readTickets({ start: env.first })).tickets[0].id, "DUB-001"); assert.equal((await readTicketAllocations(env)).next_number, 2);
});
test("deux récupérateurs concurrents d'un verrou abandonné gardent une seule allocation", async () => {
  const env = await environment(); const one = request(env, env.first, "project-a", create("A")); const two = request(env, env.second, "project-b", create("B")); const previews = await Promise.all([previewTicketChange(one), previewTicketChange(two)]); await writeFile(path.join(env.allocationRoot, "ticket-allocations.lock"), JSON.stringify({ format: "dubsar.ticket-allocation-lock/1", acquired_at_ms: 1, expires_at_ms: 30_001, owner_nonce: "d".repeat(32) }));
  const results = await Promise.allSettled([applyTicketChange({ ...one, expectedChange: previews[0].change_sha256, lockNow: () => 60_000 }), applyTicketChange({ ...two, expectedChange: previews[1].change_sha256, lockNow: () => 60_000 })]); assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal((await readTicketAllocations(env)).allocations.length, 1); assert.equal((await Promise.all([readTickets({ start: env.first }), readTickets({ start: env.second })])).flatMap((store) => store.tickets).length, 1);
});
test("locks malformé, surdimensionné, symbolique et hardlinké échouent fermés", async (t) => {
  const variants = [
    async (lock) => writeFile(lock, "not-json"),
    async (lock) => writeFile(lock, "x".repeat(2048)),
    async (lock, root) => { const source = path.join(root, "source"); await writeFile(source, "{}"); await symlink(source, lock); },
    async (lock, root) => { const source = path.join(root, "source"); await writeFile(source, "{}"); await link(source, lock); },
  ];
  for (const prepare of variants) {
    const env = await environment(); const input = request(env, env.first, "project-a", create()); const preview = await previewTicketChange(input); const lock = path.join(env.allocationRoot, "ticket-allocations.lock"); await prepare(lock, env.allocationRoot);
    await assert.rejects(applyTicketChange({ ...input, expectedChange: preview.change_sha256 }), { code: "TICKET_ALLOCATION_LOCK_INVALID" });
    assert.equal((await readTicketAllocations(env)).allocations.length, 0);
  }
});
