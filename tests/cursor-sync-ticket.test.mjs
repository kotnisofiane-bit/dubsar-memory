import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { applyTicketChange, previewTicketChange, readTickets, synchronizeEligibleTickets } from "../packages/dubsar-workbench-launcher/src/registry-store.mjs";
import { runTicketCli } from "../packages/dubsar-workbench-launcher/src/index.mjs";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const launchSkill = path.join(repositoryRoot, "packages", "dubsar-codex-workbench", "skills", "launch-dubsar-work", "SKILL.md");
const resumeSkill = path.join(repositoryRoot, "packages", "dubsar-codex-workbench", "skills", "resume-dubsar-workbench", "SKILL.md");
const syncSkill = path.join(repositoryRoot, "packages", "dubsar-codex-workbench", "skills", "sync-dubsar-work", "SKILL.md");
const installedLauncher = path.resolve(path.dirname(syncSkill), "../../../dubsar-workbench-launcher/bin/dubsar-workbench-open.mjs");

async function setup() {
  const start = await mkdtemp(path.join(tmpdir(), "dubsar-sync-project-"));
  const allocationRoot = await mkdtemp(path.join(tmpdir(), "dubsar-sync-global-"));
  await mkdir(path.join(start, ".dubsar"));
  return { start, allocationRoot, projectId: "project-sync" };
}
const create = { type: "create", title: "Mission bornée", objective: "Livrer le lot", criteria: ["Synchro"] };
const receipt = { receipt_version: "dubsar.cursor-launch-receipt/1", target_repository_url: "https://github.com/owner/repo", contract_fingerprint: `sha256:${"b".repeat(64)}`, repository_refs: [{ repository_url: "https://github.com/owner/repo", starting_sha: "a".repeat(40) }], ticket_id: "DUB-001", agent_id: "agent-1", run_id: "run-1", source_url: "https://cursor.example/runs/1", status: "launched", bounds: { max_runs: 1, polling: false } };
async function apply(env, operation) { const preview = await previewTicketChange({ ...env, operation }); return applyTicketChange({ ...env, operation, expectedChange: preview.change_sha256 }); }
async function launched(env) { await apply(env, create); await apply(env, { type: "attach-cursor-launch", id: "DUB-001", receipt }); }
function cursorObs({ lifecycle = "running", pr = null } = {}) {
  return { source: "trusted_cursor_observer", ticket_id: "DUB-001", agent_id: "agent-1", run_id: "run-1", lifecycle, pr };
}
function githubObs({ state = "open", merge_commit_sha = null, branch = "cursor/work" } = {}) {
  return { source: "trusted_github_observer", ticket_id: "DUB-001", repository: "owner/repo", pr: 12, state, merge_commit_sha, branch };
}

test("run Cursor actif mappe vers In Progress", async () => {
  const env = await setup(); await launched(env);
  await apply(env, { type: "sync-cursor-status", id: "DUB-001", cursor_observation: cursorObs(), github_observation: null });
  const ticket = (await readTickets({ start: env.start })).tickets[0];
  assert.equal(ticket.state, "In Progress");
  assert.deepEqual(ticket.cursor_launch, receipt);
});

test("PR GitHub ouverte ou brouillon vérifiée mappe vers In Review", async () => {
  const env = await setup(); await launched(env);
  await apply(env, { type: "sync-cursor-status", id: "DUB-001", cursor_observation: cursorObs({ lifecycle: "completed", pr: { repository: "owner/repo", number: 12 } }), github_observation: githubObs({ state: "draft" }) });
  assert.equal((await readTickets({ start: env.start })).tickets[0].state, "In Review");
  assert.equal((await readTickets({ start: env.start })).tickets[0].pr, "owner/repo#12");
});

test("PR fusionnée vérifiée indépendamment mappe vers Done avec SHA de fusion", async () => {
  const env = await setup(); await launched(env);
  const merge = "c".repeat(40);
  await apply(env, { type: "sync-cursor-status", id: "DUB-001", cursor_observation: cursorObs({ lifecycle: "completed", pr: { repository: "owner/repo", number: 12 } }), github_observation: githubObs({ state: "merged", merge_commit_sha: merge }) });
  const ticket = (await readTickets({ start: env.start })).tickets[0];
  assert.equal(ticket.state, "Done");
  assert.equal(ticket.activity.at(-1).evidence.merge_commit_sha, merge);
  assert.equal(ticket.activity.at(-1).evidence.type, "github_merge_observation");
});

test("fermeture puis réouverture conserve reçu, PR, branche et état synchronisé", async () => {
  const env = await setup(); await launched(env);
  await apply(env, { type: "sync-cursor-status", id: "DUB-001", cursor_observation: cursorObs({ lifecycle: "completed", pr: { repository: "owner/repo", number: 12 } }), github_observation: githubObs({ state: "open", branch: "cursor/work" }) });
  const first = await readTickets({ start: env.start });
  const reopened = await readTickets({ start: env.start });
  assert.deepEqual(reopened, first);
  assert.equal(reopened.tickets[0].cursor_launch.run_id, "run-1");
  assert.equal(reopened.tickets[0].pr, "owner/repo#12");
  assert.equal(reopened.tickets[0].branch, "cursor/work");
  assert.equal(reopened.tickets[0].state, "In Review");
});

test("reçu manquant ou invalide n'est pas éligible et ne mute pas", async () => {
  const env = await setup(); await apply(env, create);
  const target = path.join(env.start, ".dubsar", "tickets.json");
  const before = await readFile(target);
  const beforeStat = await stat(target);
  await assert.rejects(previewTicketChange({ ...env, operation: { type: "sync-cursor-status", id: "DUB-001", cursor_observation: cursorObs(), github_observation: null } }), { code: "TICKET_SYNC_RECEIPT_REQUIRED" });
  const sync = await synchronizeEligibleTickets({ ...env, observeCursorRun: async () => { throw new Error("must-not-run"); } });
  assert.equal(sync.results[0].status, "skipped");
  assert.deepEqual(await readFile(target), before);
  assert.equal((await stat(target)).mtimeMs, beforeStat.mtimeMs);
});

test("contradiction dépôt ou PR laisse le ticket inchangé", async () => {
  const env = await setup(); await launched(env);
  const target = path.join(env.start, ".dubsar", "tickets.json");
  const before = await readFile(target);
  await assert.rejects(previewTicketChange({ ...env, operation: { type: "sync-cursor-status", id: "DUB-001", cursor_observation: cursorObs({ pr: { repository: "other/repo", number: 12 } }), github_observation: null } }), { code: "TICKET_SYNC_CONTRADICTION" });
  await assert.rejects(previewTicketChange({ ...env, operation: { type: "sync-cursor-status", id: "DUB-001", cursor_observation: cursorObs({ lifecycle: "completed", pr: { repository: "owner/repo", number: 12 } }), github_observation: { ...githubObs(), repository: "other/repo" } } }), { code: "TICKET_SYNC_CONTRADICTION" });
  assert.deepEqual(await readFile(target), before);
  assert.equal((await readTickets({ start: env.start })).tickets[0].state, "In Progress");
});

test("PR fermée non fusionnée mappe vers Blocked", async () => {
  const env = await setup(); await launched(env);
  await apply(env, { type: "sync-cursor-status", id: "DUB-001", cursor_observation: cursorObs({ lifecycle: "completed", pr: { repository: "owner/repo", number: 12 } }), github_observation: githubObs({ state: "closed" }) });
  const ticket = (await readTickets({ start: env.start })).tickets[0];
  assert.equal(ticket.state, "Blocked");
  assert.match(ticket.blocker, /closed without merge/u);
});

test("run Cursor terminé sans PR utilisable mappe vers Blocked", async () => {
  const env = await setup(); await launched(env);
  await apply(env, { type: "sync-cursor-status", id: "DUB-001", cursor_observation: cursorObs({ lifecycle: "completed" }), github_observation: null });
  assert.equal((await readTickets({ start: env.start })).tickets[0].state, "Blocked");
});

test("échec lecteur transitoire ne mute pas et n'enchaîne pas un second backend", async () => {
  const env = await setup(); await launched(env);
  const target = path.join(env.start, ".dubsar", "tickets.json");
  const before = await readFile(target);
  const beforeStat = await stat(target);
  let cursorCalls = 0;
  let githubCalls = 0;
  const { TicketError } = await import("../packages/dubsar-workbench-launcher/src/registry-store.mjs");
  const sync = await synchronizeEligibleTickets({
    ...env,
    observeCursorRun: async () => { cursorCalls += 1; const error = new TicketError("TICKET_READER_TRANSIENT"); throw error; },
    observeGithubPullRequest: async () => { githubCalls += 1; return githubObs(); },
  });
  assert.equal(sync.results[0].status, "unchanged");
  assert.equal(sync.results[0].code, "TICKET_READER_TRANSIENT");
  assert.equal(cursorCalls, 1);
  assert.equal(githubCalls, 0);
  assert.deepEqual(await readFile(target), before);
  assert.equal((await stat(target)).mtimeMs, beforeStat.mtimeMs);
});

test("deux synchros contre la même évidence sont idempotentes sans activité dupliquée ni réécriture", async () => {
  const env = await setup(); await launched(env);
  const observation = { type: "sync-cursor-status", id: "DUB-001", cursor_observation: cursorObs({ lifecycle: "completed", pr: { repository: "owner/repo", number: 12 } }), github_observation: githubObs({ state: "open" }) };
  await apply(env, observation);
  const target = path.join(env.start, ".dubsar", "tickets.json");
  const before = await readFile(target);
  const beforeStat = await stat(target);
  const activityLength = (await readTickets({ start: env.start })).tickets[0].activity.length;
  const preview = await previewTicketChange({ ...env, operation: observation });
  assert.equal((await readTickets({ start: env.start })).tickets[0].activity.length, activityLength);
  await applyTicketChange({ ...env, operation: observation, expectedChange: preview.change_sha256 });
  assert.deepEqual(await readFile(target), before);
  assert.equal((await stat(target)).mtimeMs, beforeStat.mtimeMs);
  assert.equal((await readTickets({ start: env.start })).tickets[0].activity.length, activityLength);
});

test("synchronizeEligibleTickets lit Cursor une fois par ticket éligible avec l'identité persistée", async () => {
  const env = await setup(); await launched(env);
  const seen = [];
  await synchronizeEligibleTickets({
    ...env,
    observeCursorRun: async (query) => { seen.push(query); return cursorObs({ lifecycle: "running" }); },
  });
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0], { ticket_id: "DUB-001", agent_id: "agent-1", run_id: "run-1" });
  assert.equal((await readTickets({ start: env.start })).tickets[0].state, "In Progress");
});

test("CLI publique preview/apply sync-cursor-status puis relit le ticket", async () => {
  const env = await setup(); await launched(env);
  const proposal = path.join(env.allocationRoot, "sync.json");
  await writeFile(proposal, JSON.stringify({ type: "sync-cursor-status", id: "DUB-001", cursor_observation: cursorObs({ lifecycle: "failed" }), github_observation: null }));
  const io = { log() {}, error() {} };
  const base = ["tickets", "sync-cursor-status", "--start", env.start, "--allocation-root", env.allocationRoot, "--project-id", env.projectId, "--proposal", proposal, "--json"];
  const preview = await runTicketCli(base, io);
  assert.equal(preview.exitCode, 0);
  assert.equal((await readTickets({ start: env.start })).tickets[0].state, "In Progress");
  const applied = await runTicketCli([...base, "--apply", "--expected-change", preview.value.change_sha256], io);
  assert.equal(applied.exitCode, 0);
  assert.equal((await readTickets({ start: env.start })).tickets[0].state, "Blocked");
  const bin = spawnSync(process.execPath, [installedLauncher, "tickets", "list", "--start", env.start, "--allocation-root", env.allocationRoot, "--project-id", env.projectId, "--json"], { encoding: "utf8" });
  assert.equal(bin.status, 0, bin.stderr);
  assert.equal(JSON.parse(bin.stdout).tickets[0].state, "Blocked");
});

test("skills imposent synchro avant My Work, identité persistée et absence de polling", async () => {
  const [launch, resume, sync] = await Promise.all([launchSkill, resumeSkill, syncSkill].map((file) => readFile(file, "utf8")));
  assert.match(launch, /sync-dubsar-work/);
  assert.match(resume, /sync-dubsar-work/);
  assert.match(sync, /exactly once/);
  assert.match(sync, /persisted `cursor_launch.agent_id`/);
  assert.match(sync, /do not poll/i);
  assert.match(sync, /Never launch, retry, discover, or switch agents/);
  assert.match(sync, /<skill-dir>\/\.\.\/\.\.\/\.\.\/dubsar-workbench-launcher\/bin\/dubsar-workbench-open\.mjs/u);
  assert.match(sync, /tickets sync-cursor-status/);
});
