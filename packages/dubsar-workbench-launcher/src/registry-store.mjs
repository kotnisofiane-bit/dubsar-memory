import { createHash, randomBytes, randomUUID } from "node:crypto";
import { open, rename, unlink } from "node:fs/promises";
import path from "node:path";
import {
  createProjectRegistry,
  loadProjectRegistry,
  stableJson,
} from "../../dubsar-operator-core/src/index.mjs";
import { locateProjectWorkspace } from "../../dubsar-project-continuity/runtime/index.mjs";
import { captureRegularFile } from "../../dubsar-operator-core/src/safe-capture.mjs";
import { entryInfo, openDirectory } from "../../dubsar-operator-core/src/path-safety.mjs";
import { WorkbenchLauncherError } from "./launcher-error.mjs";

export const PROJECT_REGISTRY_NAME = "projects.json";

function registryPath(outputRoot) {
  return path.join(outputRoot, PROJECT_REGISTRY_NAME);
}

export async function loadLocalProjectRegistry(outputRoot) {
  const safeRoot = await openDirectory(outputRoot);
  const target = registryPath(safeRoot);
  if (await entryInfo(target) === null) {
    return createProjectRegistry();
  }
  try {
    return await loadProjectRegistry(target);
  } catch {
    throw new WorkbenchLauncherError("PROJECT_REGISTRY_INVALID");
  }
}

async function stagePrivateFile(temporary, content) {
  const handle = await open(temporary, "wx", 0o600);
  try { await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); }
}

export async function publishLocalProjectRegistry(outputRoot, registry) {
  const safeRoot = await openDirectory(outputRoot);
  const normalized = createProjectRegistry(registry.projects);
  const content = Buffer.from(stableJson(normalized), "utf8");
  const target = registryPath(safeRoot);
  const temporaryName = `.dubsar-projects-${randomBytes(12).toString("hex")}.tmp`;
  const temporary = path.join(safeRoot, temporaryName);
  let published = false;
  try {
    await stagePrivateFile(temporary, content);
    const staged = await captureRegularFile(safeRoot, temporaryName, 64 * 1024);
    if (!staged.content.equals(content)) {
      throw new WorkbenchLauncherError("PROJECT_REGISTRY_STAGING_MISMATCH");
    }
    const current = await entryInfo(target);
    if (current !== null && (!current.isFile() || current.isSymbolicLink() || current.nlink > 1n)) {
      throw new WorkbenchLauncherError("PROJECT_REGISTRY_TARGET_UNSAFE");
    }
    await rename(temporary, target);
    published = true;
    const captured = await loadProjectRegistry(target);
    if (stableJson(captured) !== stableJson(normalized)) {
      throw new WorkbenchLauncherError("PROJECT_REGISTRY_PUBLICATION_MISMATCH");
    }
    return captured;
  } catch (error) {
    if (error instanceof WorkbenchLauncherError) throw error;
    throw new WorkbenchLauncherError("PROJECT_REGISTRY_WRITE_FAILED");
  } finally {
    if (!published) await unlink(temporary).catch(() => {});
  }
}

export async function addLocalProject(outputRoot, selectedRoot) {
  let location;
  try {
    const safeSelected = await openDirectory(selectedRoot);
    location = await locateProjectWorkspace({ start: safeSelected });
  } catch {
    throw new WorkbenchLauncherError("PROJECT_SELECTION_INVALID");
  }
  const projectRoot = await openDirectory(location.project_root);
  const registry = await loadLocalProjectRegistry(outputRoot);
  const next = createProjectRegistry([
    ...registry.projects,
    { project_id: `project-${randomUUID()}`, root: projectRoot },
  ]);
  return publishLocalProjectRegistry(outputRoot, next);
}

export async function removeLocalProject(outputRoot, projectId) {
  if (typeof projectId !== "string" || projectId.length === 0) {
    throw new WorkbenchLauncherError("PROJECT_ID_INVALID");
  }
  const registry = await loadLocalProjectRegistry(outputRoot);
  const projects = registry.projects.filter((item) => item.project_id !== projectId);
  if (projects.length === registry.projects.length) {
    throw new WorkbenchLauncherError("PROJECT_ID_NOT_FOUND");
  }
  return publishLocalProjectRegistry(outputRoot, createProjectRegistry(projects));
}

export const TICKETS_FORMAT = "dubsar.tickets/1";
export const TICKET_CHANGE_FORMAT = "dubsar.ticket-change/1";
export const TICKET_ALLOCATIONS_FORMAT = "dubsar.ticket-allocations/1";
export const TICKET_ALLOCATIONS_NAME = "ticket-allocations.json";
export const TICKET_ALLOCATIONS_LOCK_NAME = "ticket-allocations.lock";
export const TICKET_ALLOCATIONS_LOCK_FORMAT = "dubsar.ticket-allocation-lock/1";
export const TICKET_STATES = Object.freeze([
  "Backlog", "To Do", "In Progress", "In Review", "Blocked", "Paused",
  "Done", "Cancelled", "Duplicate",
]);
export const TERMINAL_TICKET_STATES = Object.freeze(["Done", "Cancelled", "Duplicate"]);
const MAX_TICKETS = 999;
const MAX_ACTIVITY = 200;
const SHA = /^[0-9a-f]{64}$/u;
const CONTRACT_FINGERPRINT = /^sha256:[0-9a-f]{64}$/u;
const GITHUB_REPOSITORY_URL = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/u;
const ID = /^DUB-(\d{3})$/u;
const LOCK_LEASE_MS = 30_000;
const CURSOR_RECEIPT_VERSIONS = new Set(["dubsar.cursor-launch-receipt/1", "dubsar.cursor-run-receipt/1"]);
const terminal = new Set(TERMINAL_TICKET_STATES);
const states = new Set(TICKET_STATES);
const transitions = new Map([
  ["Backlog", new Set(["To Do", "Cancelled", "Duplicate"])],
  ["To Do", new Set(["Backlog", "In Progress", "Blocked", "Paused", "Cancelled", "Duplicate"])],
  ["In Progress", new Set(["To Do", "In Review", "Blocked", "Paused", "Cancelled", "Duplicate"])],
  ["In Review", new Set(["In Progress", "Blocked", "Paused", "Cancelled", "Duplicate", "Done"])],
  ["Blocked", new Set(["To Do", "In Progress", "Paused", "Cancelled", "Duplicate"])],
  ["Paused", new Set(["To Do", "In Progress", "Blocked", "Cancelled", "Duplicate"])],
]);

export class TicketError extends Error {
  constructor(code) { super(code); this.name = "TicketError"; this.code = code; }
}
function validateAllocationLock(value) {
  if (!value || Object.keys(value).length !== 4 || value.format !== TICKET_ALLOCATIONS_LOCK_FORMAT || !Number.isSafeInteger(value.acquired_at_ms) || value.acquired_at_ms < 0 || !Number.isSafeInteger(value.expires_at_ms) || value.expires_at_ms <= value.acquired_at_ms || value.expires_at_ms - value.acquired_at_ms !== LOCK_LEASE_MS || typeof value.owner_nonce !== "string" || !/^[0-9a-f]{32}$/u.test(value.owner_nonce)) throw new TicketError("TICKET_ALLOCATION_LOCK_INVALID");
  return Object.freeze({ format: value.format, acquired_at_ms: value.acquired_at_ms, expires_at_ms: value.expires_at_ms, owner_nonce: value.owner_nonce });
}
async function captureAllocationLock(root) {
  try {
    const captured = await captureRegularFile(root, TICKET_ALLOCATIONS_LOCK_NAME, 1024);
    return validateAllocationLock(JSON.parse(captured.content.toString("utf8")));
  } catch (error) {
    if (error instanceof TicketError) throw error;
    throw new TicketError("TICKET_ALLOCATION_LOCK_INVALID");
  }
}
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => `${JSON.stringify(key)}:${stable(entry)}`).join(",")}}`;
  return JSON.stringify(value);
}
function sha(value) { return createHash("sha256").update(typeof value === "string" ? value : stable(value)).digest("hex"); }
function text(value, max, code = "TICKET_FIELD_INVALID") {
  if (typeof value !== "string" || value.trim() !== value || value.length < 1 || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value)) throw new TicketError(code);
  return value;
}
function boundedJson(value, max = 16 * 1024) {
  let encoded;
  try { encoded = stable(value); } catch { throw new TicketError("TICKET_CURSOR_RECEIPT_INVALID"); }
  if (value === null || typeof value !== "object" || Array.isArray(value) || Buffer.byteLength(encoded, "utf8") > max) throw new TicketError("TICKET_CURSOR_RECEIPT_INVALID");
  return structuredClone(value);
}
function cursorReceipt(value, ticketId) {
  const receipt = boundedJson(value);
  if (!CURSOR_RECEIPT_VERSIONS.has(receipt.receipt_version) || receipt.ticket_id !== ticketId) throw new TicketError("TICKET_CURSOR_RECEIPT_INVALID");
  const agentId = text(receipt.agent_id, 300, "TICKET_CURSOR_RECEIPT_INVALID");
  const runId = text(receipt.run_id, 300, "TICKET_CURSOR_RECEIPT_INVALID");
  const sourceUrl = text(receipt.source_url, 2000, "TICKET_CURSOR_RECEIPT_INVALID");
  try { const parsed = new URL(sourceUrl); if (parsed.protocol !== "https:") throw new Error(); } catch { throw new TicketError("TICKET_CURSOR_RECEIPT_INVALID"); }
  const targetRepositoryUrl = text(receipt.target_repository_url, 2000, "TICKET_CURSOR_RECEIPT_INVALID");
  const status = text(receipt.status, 80, "TICKET_CURSOR_RECEIPT_INVALID");
  if (!GITHUB_REPOSITORY_URL.test(targetRepositoryUrl) || !Array.isArray(receipt.repository_refs) || receipt.repository_refs.length < 1 || receipt.repository_refs.length > 20 || !CONTRACT_FINGERPRINT.test(receipt.contract_fingerprint ?? "")) throw new TicketError("TICKET_CURSOR_RECEIPT_INVALID");
  for (const reference of receipt.repository_refs) {
    if (!reference || Object.keys(reference).sort().join(",") !== "repository_url,starting_sha" || !GITHUB_REPOSITORY_URL.test(reference.repository_url ?? "") || !/^[0-9a-f]{40}$/u.test(reference.starting_sha ?? "")) throw new TicketError("TICKET_CURSOR_RECEIPT_INVALID");
  }
  boundedJson(receipt.bounds); boundedJson({ repository_refs: receipt.repository_refs });
  return Object.freeze({ receipt_version: receipt.receipt_version, target_repository_url: targetRepositoryUrl, contract_fingerprint: receipt.contract_fingerprint, repository_refs: structuredClone(receipt.repository_refs), ticket_id: ticketId, agent_id: agentId, run_id: runId, source_url: sourceUrl, status, bounds: structuredClone(receipt.bounds) });
}
const CURSOR_LIFECYCLES = new Set(["running", "failed", "completed"]);
const GITHUB_PR_STATES = new Set(["open", "draft", "closed", "merged"]);
const OWNER_REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const SHA40 = /^[0-9a-f]{40}$/u;
export function currentCursorReceipt(ticket) {
  if (ticket?.cursor_run && ticket.cursor_run.agent_id && ticket.cursor_run.run_id) return ticket.cursor_run;
  if (ticket?.cursor_launch && ticket.cursor_launch.agent_id && ticket.cursor_launch.run_id) return ticket.cursor_launch;
  return null;
}
export function isTicketSyncEligible(ticket) {
  return Boolean(ticket && !terminal.has(ticket.state) && currentCursorReceipt(ticket));
}
function repositoryFromTargetUrl(url) {
  let parsed;
  try { parsed = new URL(url); } catch { throw new TicketError("TICKET_SYNC_CONTRADICTION"); }
  const parts = parsed.pathname.replace(/\.git$/u, "").split("/").filter(Boolean);
  if (parsed.hostname !== "github.com" || parts.length !== 2) throw new TicketError("TICKET_SYNC_CONTRADICTION");
  return `${parts[0]}/${parts[1]}`;
}
function cursorObservation(value, ticket) {
  const receipt = currentCursorReceipt(ticket);
  if (!receipt) throw new TicketError("TICKET_SYNC_RECEIPT_REQUIRED");
  const observation = boundedJson(value);
  if (observation.source !== "trusted_cursor_observer" || observation.ticket_id !== ticket.id || observation.agent_id !== receipt.agent_id || observation.run_id !== receipt.run_id || !CURSOR_LIFECYCLES.has(observation.lifecycle)) throw new TicketError("TICKET_SYNC_CONTRADICTION");
  let pr = null;
  if (observation.pr != null) {
    if (!observation.pr || !OWNER_REPO.test(observation.pr.repository ?? "") || !Number.isSafeInteger(observation.pr.number) || observation.pr.number < 1) throw new TicketError("TICKET_SYNC_CONTRADICTION");
    if (observation.pr.repository !== repositoryFromTargetUrl(receipt.target_repository_url)) throw new TicketError("TICKET_SYNC_CONTRADICTION");
    const branch = observation.pr.branch == null ? undefined : text(observation.pr.branch, 300, "TICKET_SYNC_CONTRADICTION");
    pr = Object.freeze({ repository: observation.pr.repository, number: observation.pr.number, ...(branch === undefined ? {} : { branch }) });
  }
  return Object.freeze({ source: "trusted_cursor_observer", ticket_id: ticket.id, agent_id: receipt.agent_id, run_id: receipt.run_id, lifecycle: observation.lifecycle, pr });
}
function githubPrObservation(value, ticket, claimed) {
  if (value == null) {
    if (claimed) throw new TicketError("TICKET_SYNC_CONTRADICTION");
    return null;
  }
  const observation = boundedJson(value);
  if (observation.source !== "trusted_github_observer" || observation.ticket_id !== ticket.id || !OWNER_REPO.test(observation.repository ?? "") || !Number.isSafeInteger(observation.pr) || observation.pr < 1 || !GITHUB_PR_STATES.has(observation.state)) throw new TicketError("TICKET_SYNC_CONTRADICTION");
  if (!claimed || observation.repository !== claimed.repository || observation.pr !== claimed.number) throw new TicketError("TICKET_SYNC_CONTRADICTION");
  if (claimed.branch && claimed.branch !== observation.branch) throw new TicketError("TICKET_SYNC_CONTRADICTION");
  const headSha = observation.head_sha;
  if (!SHA40.test(headSha ?? "")) throw new TicketError("TICKET_SYNC_CONTRADICTION");
  const mergeCommit = observation.merge_commit_sha ?? null;
  if (observation.state === "merged") {
    if (!SHA40.test(mergeCommit ?? "") || mergeCommit === headSha) throw new TicketError("TICKET_SYNC_CONTRADICTION");
  } else if (mergeCommit != null) throw new TicketError("TICKET_SYNC_CONTRADICTION");
  const branch = text(observation.branch, 300, "TICKET_SYNC_CONTRADICTION");
  return Object.freeze({ source: "trusted_github_observer", ticket_id: ticket.id, repository: observation.repository, pr: observation.pr, state: observation.state, head_sha: headSha, merge_commit_sha: mergeCommit, branch });
}
function prEvidence(githubObs, extra = {}) {
  const basis = { type: githubObs.state === "merged" ? "github_merge_observation" : "github_pr_observation", repository: githubObs.repository, pr: githubObs.pr, branch: githubObs.branch, head_sha: githubObs.head_sha, ticket_id: githubObs.ticket_id, ...extra };
  if (githubObs.state === "merged") return { ...basis, merge_commit_sha: githubObs.merge_commit_sha };
  return { ...basis, state: githubObs.state };
}
function lastSyncEvidence(ticket) {
  let evidence = null;
  for (const item of ticket.activity) {
    if (item.kind === "cursor_sync") evidence = item.evidence ?? null;
  }
  return evidence;
}
function sameSyncOutcome(ticket, mapped) {
  return ticket.state === mapped.state && ticket.pr === mapped.pr && ticket.branch === mapped.branch && ticket.blocker === mapped.blocker && stable(lastSyncEvidence(ticket)) === stable(mapped.evidence);
}
function mapSyncedFields(ticket, cursorObs, githubObs) {
  const prLabel = githubObs ? `${githubObs.repository}#${githubObs.pr}` : ticket.pr;
  const branch = githubObs?.branch ?? ticket.branch;
  if (githubObs?.state === "merged") {
    return { state: "Done", pr: prLabel, branch, blocker: null, evidence: prEvidence(githubObs) };
  }
  if (cursorObs.lifecycle === "failed") {
    return { state: "Blocked", pr: prLabel, branch, blocker: "Cursor run failed", evidence: githubObs ? prEvidence(githubObs, { lifecycle: "failed" }) : { type: "cursor_run_observation", lifecycle: "failed", agent_id: cursorObs.agent_id, run_id: cursorObs.run_id, ticket_id: cursorObs.ticket_id } };
  }
  if (githubObs?.state === "open" || githubObs?.state === "draft") {
    return { state: "In Review", pr: prLabel, branch, blocker: null, evidence: prEvidence(githubObs) };
  }
  if (githubObs?.state === "closed") {
    return { state: "Blocked", pr: prLabel, branch, blocker: "Pull request closed without merge", evidence: prEvidence(githubObs) };
  }
  if (cursorObs.lifecycle === "completed") {
    return { state: "Blocked", pr: ticket.pr, branch: ticket.branch, blocker: "Cursor completed without a usable pull request", evidence: { type: "cursor_run_observation", lifecycle: "completed", agent_id: cursorObs.agent_id, run_id: cursorObs.run_id, ticket_id: cursorObs.ticket_id } };
  }
  return { state: "In Progress", pr: ticket.pr, branch: ticket.branch, blocker: null, evidence: { type: "cursor_run_observation", lifecycle: "running", agent_id: cursorObs.agent_id, run_id: cursorObs.run_id, ticket_id: cursorObs.ticket_id } };
}
function isReaderTransient(error) {
  return error instanceof TicketError && error.code === "TICKET_READER_TRANSIENT";
}
export async function synchronizeEligibleTickets({ start, allocationRoot, projectId, observeCursorRun, observeGithubPullRequest }) {
  const before = await readTickets({ start });
  const results = [];
  for (const ticket of before.tickets) {
    if (!isTicketSyncEligible(ticket)) {
      results.push(Object.freeze({ id: ticket.id, status: "skipped", code: currentCursorReceipt(ticket) ? "TICKET_SYNC_TERMINAL" : "TICKET_SYNC_RECEIPT_REQUIRED" }));
      continue;
    }
    if (typeof observeCursorRun !== "function") {
      results.push(Object.freeze({ id: ticket.id, status: "unchanged", code: "TICKET_CURSOR_READER_REQUIRED" }));
      continue;
    }
    try {
      const receipt = currentCursorReceipt(ticket);
      const rawCursor = await observeCursorRun(Object.freeze({ ticket_id: ticket.id, agent_id: receipt.agent_id, run_id: receipt.run_id }));
      const cursorObs = cursorObservation(rawCursor, ticket);
      let rawGithub = null;
      if (cursorObs.pr) {
        if (typeof observeGithubPullRequest !== "function") {
          results.push(Object.freeze({ id: ticket.id, status: "unchanged", code: "TICKET_GITHUB_READER_REQUIRED" }));
          continue;
        }
        rawGithub = await observeGithubPullRequest(Object.freeze({ repository: cursorObs.pr.repository, pr: cursorObs.pr.number, ticket_id: ticket.id }));
      }
      const operation = { type: "sync-cursor-status", id: ticket.id, cursor_observation: rawCursor, github_observation: rawGithub };
      const preview = await previewTicketChange({ start, allocationRoot, projectId, operation });
      if (preview.before_sha256 === sha(preview.after)) {
        results.push(Object.freeze({ id: ticket.id, status: "unchanged", change_sha256: preview.change_sha256 }));
        continue;
      }
      await applyTicketChange({ start, allocationRoot, projectId, operation, expectedChange: preview.change_sha256 });
      results.push(Object.freeze({ id: ticket.id, status: "applied", change_sha256: preview.change_sha256 }));
    } catch (error) {
      if (isReaderTransient(error)) {
        results.push(Object.freeze({ id: ticket.id, status: "unchanged", code: "TICKET_READER_TRANSIENT" }));
        continue;
      }
      if (error instanceof TicketError && (error.code === "TICKET_SYNC_CONTRADICTION" || error.code === "TICKET_SYNC_RECEIPT_REQUIRED")) {
        results.push(Object.freeze({ id: ticket.id, status: "unchanged", code: error.code }));
        continue;
      }
      throw error;
    }
  }
  return Object.freeze({ format: "dubsar.ticket-sync/1", results: Object.freeze(results) });
}
async function storePath(start) {
  const root = path.resolve(start);
  const memory = path.join(root, ".dubsar");
  if (await entryInfo(memory) !== null) return path.join(memory, "tickets.json");
  return path.join(root, ".dubsar-project", "tickets.json");
}
function emptyStore() { return { format: TICKETS_FORMAT, tickets: [] }; }
function emptyAllocations() { return { format: TICKET_ALLOCATIONS_FORMAT, next_number: 1, allocations: [] }; }
function validateActivity(items) {
  if (!Array.isArray(items) || items.length > MAX_ACTIVITY) throw new TicketError("TICKET_STORE_INVALID");
  let previous = null;
  return items.map((item, offset) => {
    if (!item || item.index !== offset + 1 || typeof item.kind !== "string" || typeof item.summary !== "string" || item.previous_digest !== previous) throw new TicketError("TICKET_STORE_INVALID");
    const basis = { index: item.index, kind: item.kind, summary: item.summary, previous_digest: item.previous_digest, evidence: item.evidence ?? null };
    if (item.digest !== sha(basis)) throw new TicketError("TICKET_STORE_INVALID");
    previous = item.digest;
    return Object.freeze({ ...item });
  });
}
export function validateTicketStore(value) {
  if (!value || value.format !== TICKETS_FORMAT || !Array.isArray(value.tickets) || value.tickets.length > MAX_TICKETS) throw new TicketError("TICKET_STORE_INVALID");
  const seen = new Set();
  const tickets = value.tickets.map((ticket) => {
    if (!ticket || !ID.test(ticket.id) || seen.has(ticket.id) || !states.has(ticket.state)) throw new TicketError("TICKET_STORE_INVALID");
    seen.add(ticket.id); text(ticket.title, 160); text(ticket.objective, 1000);
    if (!Array.isArray(ticket.criteria) || ticket.criteria.length > 20 || ticket.criteria.some((x) => typeof x !== "string" || x.length < 1 || x.length > 300)) throw new TicketError("TICKET_STORE_INVALID");
    if (ticket.duplicate_of !== null && !ID.test(ticket.duplicate_of)) throw new TicketError("TICKET_STORE_INVALID");
    if ((ticket.state === "Duplicate") !== (ticket.duplicate_of !== null)) throw new TicketError("TICKET_STORE_INVALID");
    if (typeof ticket.project_id !== "string" || ticket.project_id.length < 1 || ticket.project_id.length > 64 || ![ticket.agent, ticket.branch, ticket.pr, ticket.blocker].every((item) => item === null || (typeof item === "string" && item.length <= 300)) || !Array.isArray(ticket.references) || ticket.references.length > 20 || ticket.references.some((item) => typeof item !== "string" || item.length < 1 || item.length > 300)) throw new TicketError("TICKET_STORE_INVALID");
    const launch = ticket.cursor_launch == null ? null : cursorReceipt(ticket.cursor_launch, ticket.id);
    const run = ticket.cursor_run == null ? null : cursorReceipt(ticket.cursor_run, ticket.id);
    if (run && run.receipt_version !== "dubsar.cursor-run-receipt/1") throw new TicketError("TICKET_STORE_INVALID");
    if (run && launch && run.agent_id !== launch.agent_id) throw new TicketError("TICKET_STORE_INVALID");
    return Object.freeze({ ...ticket, cursor_launch: launch, cursor_run: run, criteria: Object.freeze([...ticket.criteria]), activity: Object.freeze(validateActivity(ticket.activity)) });
  });
  return Object.freeze({ format: TICKETS_FORMAT, tickets: Object.freeze(tickets) });
}
export function validateTicketAllocations(value) {
  if (!value || value.format !== TICKET_ALLOCATIONS_FORMAT || !Number.isSafeInteger(value.next_number) || value.next_number < 1 || value.next_number > 1000 || !Array.isArray(value.allocations) || value.allocations.length >= 1000) throw new TicketError("TICKET_ALLOCATIONS_INVALID");
  const ids = new Set();
  for (const item of value.allocations) {
    if (!item || !ID.test(item.id) || ids.has(item.id) || typeof item.project_id !== "string" || item.project_id.length < 1 || item.project_id.length > 64) throw new TicketError("TICKET_ALLOCATIONS_INVALID");
    ids.add(item.id);
  }
  return Object.freeze({ format: TICKET_ALLOCATIONS_FORMAT, next_number: value.next_number, allocations: Object.freeze(value.allocations.map((item) => Object.freeze({ ...item }))) });
}
export async function readTicketAllocations({ allocationRoot }) {
  const safeRoot = await openDirectory(allocationRoot);
  const target = path.join(safeRoot, TICKET_ALLOCATIONS_NAME);
  if (await entryInfo(target) === null) return validateTicketAllocations(emptyAllocations());
  try { return validateTicketAllocations(JSON.parse((await captureRegularFile(safeRoot, TICKET_ALLOCATIONS_NAME, 128 * 1024)).content.toString("utf8"))); }
  catch (error) { if (error instanceof TicketError) throw error; throw new TicketError("TICKET_ALLOCATIONS_INVALID"); }
}
export async function readTickets({ start }) {
  const target = await storePath(start);
  if (await entryInfo(target) === null) return validateTicketStore(emptyStore());
  try { return validateTicketStore(JSON.parse((await captureRegularFile(path.dirname(target), path.basename(target), 1024 * 1024)).content.toString("utf8"))); }
  catch (error) { if (error?.code === "ENOENT") return validateTicketStore(emptyStore()); if (error instanceof TicketError) throw error; throw new TicketError("TICKET_STORE_INVALID"); }
}
function activity(previous, kind, summary, evidence = null) {
  const basis = { index: previous.length + 1, kind, summary, previous_digest: previous.at(-1)?.digest ?? null, evidence };
  return { ...basis, digest: sha(basis) };
}
async function corroborateGithubMerge(operation, observeGithubMerge) {
  const claim = operation.github_claim;
  if (typeof observeGithubMerge !== "function") throw new TicketError("TICKET_GITHUB_OBSERVER_REQUIRED");
  if (!claim || typeof claim.repository !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(claim.repository) || !Number.isSafeInteger(claim.pr) || claim.pr < 1 || !/^[0-9a-f]{40}$/u.test(claim.merge_commit_sha ?? "")) throw new TicketError("TICKET_GITHUB_CLAIM_INVALID");
  const observed = await observeGithubMerge(Object.freeze({ repository: claim.repository, pr: claim.pr, ticket_id: operation.id }));
  if (!observed || observed.source !== "trusted_github_observer" || observed.merged !== true || observed.repository !== claim.repository || observed.pr !== claim.pr || observed.merge_commit_sha !== claim.merge_commit_sha || observed.ticket_id !== operation.id) throw new TicketError("TICKET_GITHUB_OBSERVATION_MISMATCH");
  return Object.freeze({ type: "github_merge_observation", repository: observed.repository, pr: observed.pr, merge_commit_sha: observed.merge_commit_sha, ticket_id: observed.ticket_id });
}
function applyOperation(store, operation, allocation = null, corroboration = null) {
  if (!operation || typeof operation !== "object") throw new TicketError("TICKET_OPERATION_INVALID");
  const next = structuredClone(store);
  if (operation.type === "create") {
    if (!allocation || !ID.test(allocation.id)) throw new TicketError("TICKET_ALLOCATION_REQUIRED");
    const id = allocation.id;
    if (next.tickets.some((ticket) => ticket.id === id)) throw new TicketError("TICKET_ID_COLLISION");
    const title = text(operation.title, 160); const objective = text(operation.objective, 1000);
    const criteria = operation.criteria ?? [];
    if (!Array.isArray(criteria) || criteria.length > 20 || criteria.some((x) => typeof x !== "string" || x.length < 1 || x.length > 300)) throw new TicketError("TICKET_FIELD_INVALID");
    const references = operation.references ?? [];
    if (!Array.isArray(references) || references.length > 20 || references.some((item) => typeof item !== "string" || item.length < 1 || item.length > 300)) throw new TicketError("TICKET_FIELD_INVALID");
    next.tickets.push({ id, work_id: operation.work_id ?? null, project_id: allocation.project_id, project: operation.project ?? allocation.project_id, title, objective, criteria, state: "Backlog", duplicate_of: null, agent: operation.agent ?? null, branch: operation.branch ?? null, pr: operation.pr ?? null, blocker: operation.blocker ?? null, references, cursor_launch: null, cursor_run: null, activity: [activity([], "created", `Ticket ${id} créé`)] });
  } else if (operation.type === "transition") {
    const ticket = next.tickets.find((item) => item.id === operation.id);
    if (!ticket || !states.has(operation.to) || ticket.state === operation.to) throw new TicketError("TICKET_TRANSITION_INVALID");
    if (terminal.has(ticket.state) && operation.reopen_confirmed !== true) throw new TicketError("TICKET_REOPEN_CONFIRMATION_REQUIRED");
    if (!terminal.has(ticket.state) && !transitions.get(ticket.state)?.has(operation.to)) throw new TicketError("TICKET_TRANSITION_INVALID");
    if (operation.to === "Duplicate" && (!ID.test(operation.duplicate_of ?? "") || operation.duplicate_of === ticket.id || !next.tickets.some((x) => x.id === operation.duplicate_of))) throw new TicketError("TICKET_DUPLICATE_TARGET_REQUIRED");
    if (operation.to === "Done" && corroboration === null) throw new TicketError("TICKET_GITHUB_OBSERVATION_REQUIRED");
    const from = ticket.state; ticket.state = operation.to; ticket.duplicate_of = operation.to === "Duplicate" ? operation.duplicate_of : null;
    ticket.activity.push(activity(ticket.activity, "transition", `${from} → ${operation.to}`, corroboration));
  } else if (operation.type === "activity") {
    const ticket = next.tickets.find((item) => item.id === operation.id); if (!ticket) throw new TicketError("TICKET_NOT_FOUND");
    if (ticket.activity.length >= MAX_ACTIVITY) throw new TicketError("TICKET_ACTIVITY_LIMIT");
    ticket.activity.push(activity(ticket.activity, text(operation.kind, 40), text(operation.summary, 500), operation.evidence ?? null));
  } else if (operation.type === "attach-cursor-launch") {
    const ticket = next.tickets.find((item) => item.id === operation.id); if (!ticket) throw new TicketError("TICKET_NOT_FOUND");
    if (ticket.cursor_launch !== null || terminal.has(ticket.state) || ticket.activity.length >= MAX_ACTIVITY) throw new TicketError("TICKET_CURSOR_LAUNCH_INVALID");
    const receipt = cursorReceipt(operation.receipt, ticket.id);
    const from = ticket.state; ticket.cursor_launch = receipt; ticket.agent = receipt.agent_id; ticket.blocker = null; ticket.state = "In Progress"; ticket.duplicate_of = null;
    ticket.activity.push(activity(ticket.activity, "cursor_launch", `${from} → In Progress · lancement Cursor attaché`, receipt));
  } else if (operation.type === "attach-cursor-run") {
    const ticket = next.tickets.find((item) => item.id === operation.id); if (!ticket) throw new TicketError("TICKET_NOT_FOUND");
    if (!ticket.cursor_launch || terminal.has(ticket.state) || ticket.activity.length >= MAX_ACTIVITY) throw new TicketError("TICKET_CURSOR_RUN_INVALID");
    const receipt = cursorReceipt(operation.receipt, ticket.id);
    if (receipt.receipt_version !== "dubsar.cursor-run-receipt/1") throw new TicketError("TICKET_CURSOR_RUN_INVALID");
    if (receipt.agent_id !== ticket.cursor_launch.agent_id) throw new TicketError("TICKET_CURSOR_RUN_INVALID");
    const previousNumber = ticket.cursor_run?.bounds?.correction_number;
    const nextNumber = receipt.bounds?.correction_number;
    if (!Number.isSafeInteger(nextNumber) || nextNumber < 1) throw new TicketError("TICKET_CURSOR_RUN_INVALID");
    if (Number.isSafeInteger(previousNumber) && nextNumber <= previousNumber) throw new TicketError("TICKET_CURSOR_RUN_INVALID");
    ticket.cursor_run = receipt;
    ticket.agent = receipt.agent_id;
    ticket.blocker = null;
    ticket.state = "In Progress";
    ticket.duplicate_of = null;
    ticket.activity.push(activity(ticket.activity, "cursor_run", `In Progress · continuation Cursor ${nextNumber} attachée`, receipt));
  } else if (operation.type === "fail-cursor-run") {
    const ticket = next.tickets.find((item) => item.id === operation.id); if (!ticket) throw new TicketError("TICKET_NOT_FOUND");
    if (!ticket.cursor_launch || terminal.has(ticket.state) || ticket.activity.length >= MAX_ACTIVITY) throw new TicketError("TICKET_CURSOR_RUN_INVALID");
    const code = text(operation.code, 80, "TICKET_CURSOR_FAILURE_INVALID"); const summary = text(operation.summary, 500, "TICKET_CURSOR_FAILURE_INVALID");
    const from = ticket.state; ticket.state = "Blocked"; ticket.blocker = summary; ticket.duplicate_of = null;
    ticket.activity.push(activity(ticket.activity, "cursor_run_failed", `${from} → Blocked · ${summary}`, { code }));
  } else if (operation.type === "fail-cursor-launch") {
    const ticket = next.tickets.find((item) => item.id === operation.id); if (!ticket) throw new TicketError("TICKET_NOT_FOUND");
    if (ticket.cursor_launch !== null || terminal.has(ticket.state) || ticket.activity.length >= MAX_ACTIVITY) throw new TicketError("TICKET_CURSOR_LAUNCH_INVALID");
    const code = text(operation.code, 80, "TICKET_CURSOR_FAILURE_INVALID"); const summary = text(operation.summary, 500, "TICKET_CURSOR_FAILURE_INVALID");
    const from = ticket.state; ticket.state = "Blocked"; ticket.blocker = summary; ticket.duplicate_of = null;
    ticket.activity.push(activity(ticket.activity, "cursor_launch_failed", `${from} → Blocked · ${summary}`, { code }));
  } else if (operation.type === "sync-cursor-status") {
    const ticket = next.tickets.find((item) => item.id === operation.id); if (!ticket) throw new TicketError("TICKET_NOT_FOUND");
    if (!isTicketSyncEligible(ticket)) throw new TicketError(currentCursorReceipt(ticket) ? "TICKET_SYNC_TERMINAL" : "TICKET_SYNC_RECEIPT_REQUIRED");
    if (ticket.activity.length >= MAX_ACTIVITY) throw new TicketError("TICKET_ACTIVITY_LIMIT");
    const cursorObs = cursorObservation(operation.cursor_observation, ticket);
    const githubObs = githubPrObservation(operation.github_observation, ticket, cursorObs.pr);
    const mapped = mapSyncedFields(ticket, cursorObs, githubObs);
    if (sameSyncOutcome(ticket, mapped)) return validateTicketStore(next);
    const from = ticket.state;
    ticket.state = mapped.state;
    ticket.pr = mapped.pr;
    ticket.branch = mapped.branch;
    ticket.blocker = mapped.blocker;
    ticket.duplicate_of = null;
    ticket.activity.push(activity(ticket.activity, "cursor_sync", `${from} → ${mapped.state}`, mapped.evidence));
  } else throw new TicketError("TICKET_OPERATION_INVALID");
  return validateTicketStore(next);
}
export async function previewTicketChange({ start, allocationRoot, projectId, operation, observeGithubMerge }) {
  const before = await readTickets({ start });
  const allocations = await readTicketAllocations({ allocationRoot });
  const allocation = operation.type === "create" ? { id: `DUB-${String(allocations.next_number).padStart(3, "0")}`, project_id: text(projectId, 64) } : null;
  const corroboration = operation.type === "transition" && operation.to === "Done" ? await corroborateGithubMerge(operation, observeGithubMerge) : null;
  const after = applyOperation(before, operation, allocation, corroboration);
  const allocationsAfter = allocation === null ? allocations : validateTicketAllocations({ format: TICKET_ALLOCATIONS_FORMAT, next_number: allocations.next_number + 1, allocations: [...allocations.allocations, allocation] });
  const change = { format: TICKET_CHANGE_FORMAT, before_sha256: sha(before), allocations_before_sha256: sha(allocations), project_id: projectId, operation, corroboration, after, allocations_after: allocationsAfter };
  return Object.freeze({ ...change, change_sha256: sha(change) });
}
export async function applyTicketChange({ start, allocationRoot, projectId, operation, expectedChange, observeGithubMerge, lockNow = Date.now }) {
  if (!SHA.test(expectedChange ?? "")) throw new TicketError("TICKET_EXPECTED_CHANGE_INVALID");
  const safeAllocationRoot = await openDirectory(allocationRoot);
  const lock = path.join(safeAllocationRoot, TICKET_ALLOCATIONS_LOCK_NAME);
  if (typeof lockNow !== "function") throw new TicketError("TICKET_ALLOCATION_LOCK_BOUNDARY_REQUIRED");
  const acquiredAt = lockNow();
  if (!Number.isSafeInteger(acquiredAt) || acquiredAt < 0) throw new TicketError("TICKET_ALLOCATION_LOCK_IDENTITY_AMBIGUOUS");
  const owner = validateAllocationLock({ format: TICKET_ALLOCATIONS_LOCK_FORMAT, acquired_at_ms: acquiredAt, expires_at_ms: acquiredAt + LOCK_LEASE_MS, owner_nonce: randomBytes(16).toString("hex") });
  const lockBytes = `${stable(owner)}\n`;
  let lockOwned = false;
  try {
    try {
      await stagePrivateFile(lock, lockBytes); lockOwned = true;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const existing = await captureAllocationLock(safeAllocationRoot);
      const observedAt = lockNow();
      if (!Number.isSafeInteger(observedAt) || observedAt < 0) throw new TicketError("TICKET_ALLOCATION_LOCK_IDENTITY_AMBIGUOUS");
      if (observedAt <= existing.expires_at_ms) throw new TicketError("TICKET_ALLOCATION_BUSY");
      const recovery = path.join(safeAllocationRoot, "ticket-allocations.recovery.lock");
      let recoveryOwned = false;
      try {
        try { await stagePrivateFile(recovery, lockBytes); recoveryOwned = true; } catch (claimError) { if (claimError?.code === "EEXIST") throw new TicketError("TICKET_ALLOCATION_BUSY"); throw claimError; }
        const confirmed = await captureAllocationLock(safeAllocationRoot);
        if (stable(confirmed) !== stable(existing)) throw new TicketError("TICKET_ALLOCATION_BUSY");
        const abandoned = `${recovery}.${randomBytes(16).toString("hex")}.abandoned`;
        try { await rename(lock, abandoned); } catch (recoveryError) { if (recoveryError?.code === "ENOENT") throw new TicketError("TICKET_ALLOCATION_BUSY"); throw new TicketError("TICKET_ALLOCATION_LOCK_INVALID"); }
        await unlink(abandoned).catch(() => {});
        try { await stagePrivateFile(lock, lockBytes); lockOwned = true; } catch (claimError) { if (claimError?.code === "EEXIST") throw new TicketError("TICKET_ALLOCATION_BUSY"); throw claimError; }
      } finally { if (recoveryOwned) await unlink(recovery).catch(() => {}); }
    }
    const preview = await previewTicketChange({ start, allocationRoot: safeAllocationRoot, projectId, operation, observeGithubMerge });
    if (preview.change_sha256 !== expectedChange) throw new TicketError("TICKET_CHANGE_STALE");
    if (preview.before_sha256 === sha(preview.after)) {
      return Object.freeze({ format: "dubsar.ticket-receipt/1", change_sha256: expectedChange, store_sha256: preview.before_sha256, tickets: preview.after.tickets.length });
    }
    const target = await storePath(start); await openDirectory(path.dirname(target));
    const projectTemporary = `${target}.${randomBytes(12).toString("hex")}.tmp`;
    const allocationTarget = path.join(safeAllocationRoot, TICKET_ALLOCATIONS_NAME);
    const allocationTemporary = `${allocationTarget}.${randomBytes(12).toString("hex")}.tmp`;
    const previousProject = await entryInfo(target) === null ? null : (await captureRegularFile(path.dirname(target), path.basename(target), 1024 * 1024)).content;
    let projectPublished = false;
    try {
      await stagePrivateFile(projectTemporary, `${stable(preview.after)}\n`);
      if (operation.type === "create") await stagePrivateFile(allocationTemporary, `${stable(preview.allocations_after)}\n`);
      await rename(projectTemporary, target); projectPublished = true;
      if (operation.type === "create") await rename(allocationTemporary, allocationTarget);
    } catch (error) {
      if (projectPublished) {
        if (previousProject === null) await unlink(target).catch(() => {});
        else { const restore = `${target}.${randomBytes(12).toString("hex")}.restore`; await stagePrivateFile(restore, previousProject); await rename(restore, target); }
      }
      throw error;
    } finally { await unlink(projectTemporary).catch(() => {}); await unlink(allocationTemporary).catch(() => {}); }
    return Object.freeze({ format: "dubsar.ticket-receipt/1", change_sha256: expectedChange, store_sha256: sha(preview.after), tickets: preview.after.tickets.length });
  } finally { if (lockOwned) await unlink(lock).catch(() => {}); }
}
