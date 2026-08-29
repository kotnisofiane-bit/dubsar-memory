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
export const TICKET_STATES = Object.freeze([
  "Backlog", "To Do", "In Progress", "In Review", "Blocked", "Paused",
  "Done", "Cancelled", "Duplicate",
]);
export const TERMINAL_TICKET_STATES = Object.freeze(["Done", "Cancelled", "Duplicate"]);
const MAX_TICKETS = 999;
const MAX_ACTIVITY = 200;
const SHA = /^[0-9a-f]{64}$/u;
const ID = /^DUB-(\d{3})$/u;
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
function storePath(start) { return path.join(path.resolve(start), ".dubsar", "tickets.json"); }
function emptyStore() { return { format: TICKETS_FORMAT, next_number: 1, tickets: [] }; }
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
  if (!value || value.format !== TICKETS_FORMAT || !Number.isSafeInteger(value.next_number) || value.next_number < 1 || value.next_number > 1000 || !Array.isArray(value.tickets) || value.tickets.length > MAX_TICKETS) throw new TicketError("TICKET_STORE_INVALID");
  const seen = new Set();
  const tickets = value.tickets.map((ticket) => {
    if (!ticket || !ID.test(ticket.id) || seen.has(ticket.id) || !states.has(ticket.state)) throw new TicketError("TICKET_STORE_INVALID");
    seen.add(ticket.id); text(ticket.title, 160); text(ticket.objective, 1000);
    if (!Array.isArray(ticket.criteria) || ticket.criteria.length > 20 || ticket.criteria.some((x) => typeof x !== "string" || x.length < 1 || x.length > 300)) throw new TicketError("TICKET_STORE_INVALID");
    if (ticket.duplicate_of !== null && !ID.test(ticket.duplicate_of)) throw new TicketError("TICKET_STORE_INVALID");
    if ((ticket.state === "Duplicate") !== (ticket.duplicate_of !== null)) throw new TicketError("TICKET_STORE_INVALID");
    return Object.freeze({ ...ticket, criteria: Object.freeze([...ticket.criteria]), activity: Object.freeze(validateActivity(ticket.activity)) });
  });
  return Object.freeze({ format: TICKETS_FORMAT, next_number: value.next_number, tickets: Object.freeze(tickets) });
}
export async function readTickets({ start }) {
  const target = storePath(start);
  if (await entryInfo(target) === null) return validateTicketStore(emptyStore());
  try { return validateTicketStore(JSON.parse((await captureRegularFile(path.dirname(target), path.basename(target), 1024 * 1024)).content.toString("utf8"))); }
  catch (error) { if (error?.code === "ENOENT") return validateTicketStore(emptyStore()); if (error instanceof TicketError) throw error; throw new TicketError("TICKET_STORE_INVALID"); }
}
function activity(previous, kind, summary, evidence = null) {
  const basis = { index: previous.length + 1, kind, summary, previous_digest: previous.at(-1)?.digest ?? null, evidence };
  return { ...basis, digest: sha(basis) };
}
function githubMerge(evidence) {
  return evidence && evidence.type === "github_merge" && evidence.verified === true && evidence.merged === true && /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+$/u.test(evidence.pr_url) && /^[0-9a-f]{40}$/u.test(evidence.merge_commit_sha);
}
function applyOperation(store, operation) {
  if (!operation || typeof operation !== "object") throw new TicketError("TICKET_OPERATION_INVALID");
  const next = structuredClone(store);
  if (operation.type === "create") {
    if (next.next_number > MAX_TICKETS) throw new TicketError("TICKET_ID_EXHAUSTED");
    const id = `DUB-${String(next.next_number).padStart(3, "0")}`;
    if (next.tickets.some((ticket) => ticket.id === id)) throw new TicketError("TICKET_ID_COLLISION");
    const title = text(operation.title, 160); const objective = text(operation.objective, 1000);
    const criteria = operation.criteria ?? [];
    if (!Array.isArray(criteria) || criteria.length > 20 || criteria.some((x) => typeof x !== "string" || x.length < 1 || x.length > 300)) throw new TicketError("TICKET_FIELD_INVALID");
    next.next_number += 1;
    next.tickets.push({ id, work_id: operation.work_id ?? null, project: operation.project ?? null, title, objective, criteria, state: "Backlog", duplicate_of: null, activity: [activity([], "created", `Ticket ${id} créé`)] });
  } else if (operation.type === "transition") {
    const ticket = next.tickets.find((item) => item.id === operation.id);
    if (!ticket || !states.has(operation.to) || ticket.state === operation.to) throw new TicketError("TICKET_TRANSITION_INVALID");
    if (terminal.has(ticket.state) && operation.reopen_confirmed !== true) throw new TicketError("TICKET_REOPEN_CONFIRMATION_REQUIRED");
    if (!terminal.has(ticket.state) && !transitions.get(ticket.state)?.has(operation.to)) throw new TicketError("TICKET_TRANSITION_INVALID");
    if (operation.to === "Duplicate" && (!ID.test(operation.duplicate_of ?? "") || operation.duplicate_of === ticket.id || !next.tickets.some((x) => x.id === operation.duplicate_of))) throw new TicketError("TICKET_DUPLICATE_TARGET_REQUIRED");
    if (operation.to === "Done" && !githubMerge(operation.evidence)) throw new TicketError("TICKET_GITHUB_MERGE_REQUIRED");
    const from = ticket.state; ticket.state = operation.to; ticket.duplicate_of = operation.to === "Duplicate" ? operation.duplicate_of : null;
    ticket.activity.push(activity(ticket.activity, "transition", `${from} → ${operation.to}`, operation.evidence ?? null));
  } else if (operation.type === "activity") {
    const ticket = next.tickets.find((item) => item.id === operation.id); if (!ticket) throw new TicketError("TICKET_NOT_FOUND");
    if (ticket.activity.length >= MAX_ACTIVITY) throw new TicketError("TICKET_ACTIVITY_LIMIT");
    ticket.activity.push(activity(ticket.activity, text(operation.kind, 40), text(operation.summary, 500), operation.evidence ?? null));
  } else throw new TicketError("TICKET_OPERATION_INVALID");
  return validateTicketStore(next);
}
export async function previewTicketChange({ start, operation }) {
  const before = await readTickets({ start }); const after = applyOperation(before, operation);
  const change = { format: TICKET_CHANGE_FORMAT, before_sha256: sha(before), operation, after };
  return Object.freeze({ ...change, change_sha256: sha(change) });
}
export async function applyTicketChange({ start, operation, expectedChange }) {
  if (!SHA.test(expectedChange ?? "")) throw new TicketError("TICKET_EXPECTED_CHANGE_INVALID");
  const preview = await previewTicketChange({ start, operation });
  if (preview.change_sha256 !== expectedChange) throw new TicketError("TICKET_CHANGE_STALE");
  const target = storePath(start); await openDirectory(path.dirname(target));
  const temporary = `${target}.${randomBytes(12).toString("hex")}.tmp`; try { await stagePrivateFile(temporary, `${stable(preview.after)}\n`); await rename(temporary, target); }
  finally { await unlink(temporary).catch(() => {}); }
  return Object.freeze({ format: "dubsar.ticket-receipt/1", change_sha256: expectedChange, store_sha256: sha(preview.after), tickets: preview.after.tickets.length });
}
