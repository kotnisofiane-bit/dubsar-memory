import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { applyTicketChange, previewTicketChange, readTickets } from "../packages/dubsar-workbench-launcher/src/registry-store.mjs";

async function setup() {
  const start = await mkdtemp(path.join(tmpdir(), "dubsar-cursor-project-"));
  const allocationRoot = await mkdtemp(path.join(tmpdir(), "dubsar-cursor-global-"));
  await mkdir(path.join(start, ".dubsar"));
  return { start, allocationRoot, projectId: "project-cursor" };
}
const create = { type: "create", title: "Mission bornée", objective: "Livrer le lot", criteria: ["Reçu persisté"] };
const receipt = { receipt_version: "dubsar.cursor-launch-receipt/1", target_repository_url: "https://github.com/owner/repo", contract_fingerprint: `sha256:${"b".repeat(64)}`, repository_refs: [{ repository_url: "https://github.com/owner/repo", starting_sha: "a".repeat(40) }], ticket_id: "DUB-001", agent_id: "agent-1", run_id: "run-1", source_url: "https://cursor.example/runs/1", status: "launched", bounds: { max_runs: 1, polling: false } };
async function apply(env, operation) { const preview = await previewTicketChange({ ...env, operation }); return applyTicketChange({ ...env, operation, expectedChange: preview.change_sha256 }); }

test("create -> reçu -> In Progress persiste après réouverture simulée", async () => {
  const env = await setup(); await apply(env, create);
  const operation = { type: "attach-cursor-launch", id: "DUB-001", receipt };
  const target = path.join(env.start, ".dubsar", "tickets.json"); const before = await readFile(target); const beforeStat = await stat(target);
  const preview = await previewTicketChange({ ...env, operation });
  assert.deepEqual(await readFile(target), before); assert.equal((await stat(target)).mtimeMs, beforeStat.mtimeMs);
  await applyTicketChange({ ...env, operation, expectedChange: preview.change_sha256 });
  const reopened = await readTickets({ start: env.start });
  assert.equal(reopened.tickets[0].state, "In Progress"); assert.deepEqual(reopened.tickets[0].cursor_launch, receipt);
});

test("un échec borné bloque sans inventer un agent", async () => {
  const env = await setup(); await apply(env, create);
  await apply(env, { type: "fail-cursor-launch", id: "DUB-001", code: "CONTROLLER_CONTRADICTION", summary: "Empreinte du contrat divergente" });
  const ticket = (await readTickets({ start: env.start })).tickets[0];
  assert.equal(ticket.state, "Blocked"); assert.equal(ticket.agent, null); assert.equal(ticket.cursor_launch, null); assert.equal(ticket.activity.at(-1).evidence.code, "CONTROLLER_CONTRADICTION");
});

test("l'ancien faux schéma de reçu est refusé sans mutation", async () => {
  const env = await setup(); await apply(env, create);
  const legacy = { format: "dubsar.cursor-launch-receipt/1", ticket_id: "DUB-001", agent_id: "agent-1", run_id: "run-1", source_url: "https://cursor.example/runs/1", target_repository: "owner/repo", repository_refs: [{ ref: "main", sha: "a".repeat(40) }], contract_fingerprint: "b".repeat(64), bounds: { max_runs: 1 } };
  await assert.rejects(previewTicketChange({ ...env, operation: { type: "attach-cursor-launch", id: "DUB-001", receipt: legacy } }), { code: "TICKET_CURSOR_RECEIPT_INVALID" });
  const ticket = (await readTickets({ start: env.start })).tickets[0]; assert.equal(ticket.state, "Backlog"); assert.equal(ticket.cursor_launch, null);
});

test("CLI publique fournit preview/apply pour l'attachement", async () => {
  const env = await setup(); await apply(env, create); const proposal = path.join(env.allocationRoot, "attach.json");
  await writeFile(proposal, JSON.stringify({ type: "attach-cursor-launch", id: "DUB-001", receipt }));
  const bin = path.resolve("packages/dubsar-workbench-launcher/bin/dubsar-workbench-open.mjs");
  const base = [bin, "tickets", "attach-cursor-launch", "--start", env.start, "--allocation-root", env.allocationRoot, "--project-id", env.projectId, "--proposal", proposal, "--json"];
  const preview = spawnSync(process.execPath, base, { encoding: "utf8" }); assert.equal(preview.status, 0, preview.stderr);
  assert.equal((await readTickets({ start: env.start })).tickets[0].state, "Backlog");
  const applied = spawnSync(process.execPath, [...base, "--apply", "--expected-change", JSON.parse(preview.stdout).change_sha256], { encoding: "utf8" }); assert.equal(applied.status, 0, applied.stderr);
  assert.equal((await readTickets({ start: env.start })).tickets[0].state, "In Progress");
});

test("skill impose allocation avant MCP, appel unique et arrêt sur contradiction", async () => {
  const skill = await readFile("packages/dubsar-codex-workbench/skills/launch-dubsar-work/SKILL.md", "utf8");
  assert.match(skill, /Never call\n+   Cursor before this persisted allocation succeeds/); assert.match(skill, /exactly once/); assert.match(skill, /sha256:<64 lowercase hex>/); assert.match(skill, /Controller canonicalization/); assert.match(skill, /Stop on a missing\/malformed receipt/); assert.match(skill, /do not poll/i);
});
