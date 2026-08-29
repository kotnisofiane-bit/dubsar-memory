import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { applyTicketChange, previewTicketChange, readTickets } from "../packages/dubsar-workbench-launcher/src/registry-store.mjs";
import { runTicketCli } from "../packages/dubsar-workbench-launcher/src/launcher.mjs";

const create = (title = "Premier") => ({ type: "create", title, objective: "Livrer localement", criteria: ["Testé"], work_id: "work-1", project: "DUBSAR" });
async function root() { const value = await mkdtemp(path.join(tmpdir(), "dubsar-tickets-")); await mkdir(path.join(value, ".dubsar")); return value; }
async function perform(start, operation) { const preview = await previewTicketChange({ start, operation }); await applyTicketChange({ start, operation, expectedChange: preview.change_sha256 }); return preview; }

test("allocation DUB-### sans collision et persistance après redémarrage", async () => {
  const start = await root(); await perform(start, create()); await perform(start, create("Second"));
  assert.deepEqual((await readTickets({ start })).tickets.map(({ id }) => id), ["DUB-001", "DUB-002"]);
});
test("preview/apply exact refuse un digest obsolète et les lectures ne mutent rien", async () => {
  const start = await root(); const preview = await previewTicketChange({ start, operation: create() });
  await perform(start, create("Concurrent"));
  await assert.rejects(applyTicketChange({ start, operation: create(), expectedChange: preview.change_sha256 }), { code: "TICKET_CHANGE_STALE" });
  const target = path.join(start, ".dubsar", "tickets.json"); const before = await readFile(target); const beforeStat = await stat(target);
  await readTickets({ start }); assert.deepEqual(await readFile(target), before); assert.equal((await stat(target)).mtimeMs, beforeStat.mtimeMs);
});
test("transitions, Duplicate, réouverture et preuve GitHub validée", async () => {
  const start = await root(); await perform(start, create()); await perform(start, create("Cible"));
  await assert.rejects(previewTicketChange({ start, operation: { type: "transition", id: "DUB-001", to: "Duplicate" } }), { code: "TICKET_DUPLICATE_TARGET_REQUIRED" });
  await perform(start, { type: "transition", id: "DUB-001", to: "To Do" });
  await perform(start, { type: "transition", id: "DUB-001", to: "In Progress" });
  await perform(start, { type: "transition", id: "DUB-001", to: "In Review" });
  await assert.rejects(previewTicketChange({ start, operation: { type: "transition", id: "DUB-001", to: "Done", evidence: { type: "agent_report" } } }), { code: "TICKET_GITHUB_MERGE_REQUIRED" });
  await perform(start, { type: "transition", id: "DUB-001", to: "Done", evidence: { type: "github_merge", verified: true, merged: true, pr_url: "https://github.com/a/b/pull/1", merge_commit_sha: "a".repeat(40) } });
  await assert.rejects(previewTicketChange({ start, operation: { type: "transition", id: "DUB-001", to: "Backlog" } }), { code: "TICKET_REOPEN_CONFIRMATION_REQUIRED" });
  await perform(start, { type: "transition", id: "DUB-001", to: "Backlog", reopen_confirmed: true });
  const ticket = (await readTickets({ start })).tickets[0]; assert.equal(ticket.activity.at(-1).index, 6); assert.match(ticket.activity.at(-1).digest, /^[0-9a-f]{64}$/);
});
test("CLI et moteur partagent aperçu et reçu", async () => {
  const start = await root(); const proposal = path.join(start, "proposal.json"); await writeFile(proposal, JSON.stringify(create()));
  const lines = []; const io = { log: (x) => lines.push(x), error: (x) => lines.push(x) };
  const preview = await runTicketCli(["tickets", "create", "--start", start, "--proposal", proposal, "--json"], io);
  const applied = await runTicketCli(["tickets", "create", "--start", start, "--proposal", proposal, "--apply", "--expected-change", preview.value.change_sha256, "--json"], io);
  assert.equal(applied.exitCode, 0); assert.equal((await readTickets({ start })).tickets.length, 1);
});
