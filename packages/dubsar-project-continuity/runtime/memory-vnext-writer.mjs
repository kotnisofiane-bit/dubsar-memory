import { randomBytes } from "node:crypto";
import { open, rename, unlink } from "node:fs/promises";
import path from "node:path";

import {
  WorkbenchError,
  exactKeys,
  resolveLimits,
  sha256Bytes,
  stableJson,
} from "./contracts.mjs";
import { safeDisplayText } from "./display-safety.mjs";
import { locateProjectWorkspace, MEMORY_PROJECT_MARKER } from "./locate.mjs";
import {
  assertMemoryCheckpoints,
  assertMemoryKnowledge,
  assertMemoryLocalState,
  assertMemoryWork,
  memoryCheckpointDigest,
} from "./memory-vnext-contracts.mjs";
import {
  parseMemoryMarkdown,
  serializeMemoryMarkdown,
} from "./memory-vnext-markdown.mjs";
import { snapshotMemoryWorkspace } from "./memory-vnext-snapshot.mjs";
import {
  entryInfo,
  isInsideOrEqual,
  normalizeRelativePath,
  openDirectory,
} from "./path-safety.mjs";
import { captureRegularFile } from "./safe-capture.mjs";
import { artifactPolicyFinding } from "./sensitive-content.mjs";

export const MEMORY_CHANGE_PROPOSAL_FORMAT = "dubsar.memory-change-proposal/1";
export const MEMORY_CHANGE_PREVIEW_FORMAT = "dubsar.memory-change-preview/1";
export const MEMORY_CHANGE_APPLY_FORMAT = "dubsar.memory-change-apply/1";

const SHA256 = /^[0-9a-f]{64}$/u;
const SAFE_ID = /^[a-z0-9][a-z0-9._-]{2,127}$/iu;
const OPERATIONS = new Set([
  "work_create",
  "work_status",
  "work_select",
  "inbox_add",
  "inbox_promote",
  "knowledge_retire",
  "checkpoint_append",
  "context_write",
]);
const WORK_STATUSES = new Set(["open", "paused", "complete"]);
const MAX_PROPOSAL_BYTES = 128 * 1024;
const MAX_MARKDOWN_BYTES = 64 * 1024;
const MAX_TARGET_BYTES = 1024 * 1024;

function fail(code = "MEMORY_CHANGE_PROPOSAL_INVALID") {
  throw new WorkbenchError(code);
}

function parseJson(content, code = "MEMORY_CHANGE_PROPOSAL_INVALID") {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(content));
  } catch {
    throw new WorkbenchError(code);
  }
}

function safeBody(value, maxChars = 16_000) {
  if (typeof value !== "string" || value.length > maxChars) fail();
  const display = safeDisplayText(value, maxChars);
  if (display.redacted || display.truncated) fail();
  const bytes = Buffer.from(value, "utf8");
  if (artifactPolicyFinding("memory-entry.md", bytes) !== null) fail();
  return value;
}

function assertId(value) {
  if (typeof value !== "string" || !SAFE_ID.test(value)) fail();
  return value;
}

function validatePayload(operation, payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) fail();
  if (operation === "work_create") {
    if (!exactKeys(payload, ["body", "work"])) fail();
    return { work: assertMemoryWork(payload.work), body: safeBody(payload.body) };
  }
  if (operation === "work_status") {
    if (!exactKeys(payload, ["status", "work_id"])) fail();
    const workId = assertId(payload.work_id);
    if (!WORK_STATUSES.has(payload.status)) fail();
    return { work_id: workId, status: payload.status };
  }
  if (operation === "work_select") {
    if (!exactKeys(payload, ["work_id"])) fail();
    if (payload.work_id !== null) assertId(payload.work_id);
    return { work_id: payload.work_id };
  }
  if (operation === "inbox_add") {
    if (!exactKeys(payload, ["body", "note_id"])) fail();
    return { note_id: assertId(payload.note_id), body: safeBody(payload.body) };
  }
  if (operation === "inbox_promote") {
    if (!exactKeys(payload, ["body", "knowledge", "note_id"])) fail();
    return {
      note_id: assertId(payload.note_id),
      knowledge: assertMemoryKnowledge(payload.knowledge),
      body: safeBody(payload.body),
    };
  }
  if (operation === "knowledge_retire") {
    if (!exactKeys(payload, ["knowledge_id"])) fail();
    return { knowledge_id: assertId(payload.knowledge_id) };
  }
  if (operation === "checkpoint_append") {
    if (!exactKeys(payload, ["entry"])) fail();
    if (!payload.entry || typeof payload.entry !== "object" || Array.isArray(payload.entry)) fail();
    return { entry: payload.entry };
  }
  if (operation === "context_write") {
    if (!exactKeys(payload, ["content", "source_snapshot_sha256"])) fail();
    if (!SHA256.test(payload.source_snapshot_sha256 ?? "")) fail();
    return {
      content: safeBody(payload.content, 64_000),
      source_snapshot_sha256: payload.source_snapshot_sha256,
    };
  }
  fail();
}

function assertProposal(value, projectId) {
  if (!exactKeys(value, ["format", "operation", "payload", "project_id"])) fail();
  if (
    value.format !== MEMORY_CHANGE_PROPOSAL_FORMAT ||
    value.project_id !== projectId ||
    !OPERATIONS.has(value.operation)
  ) fail();
  return {
    format: value.format,
    project_id: value.project_id,
    operation: value.operation,
    payload: validatePayload(value.operation, value.payload),
  };
}

async function loadProposal({ proposalPath, proposal, projectRoot, projectId }) {
  const fromPath = typeof proposalPath === "string" && proposalPath.length > 0;
  const fromValue = proposal !== undefined;
  if (fromPath === fromValue) throw new WorkbenchError("MEMORY_CHANGE_PROPOSAL_REQUIRED");
  if (fromValue) return assertProposal(proposal, projectId);
  const absolute = path.resolve(proposalPath);
  if (isInsideOrEqual(projectRoot, absolute)) {
    throw new WorkbenchError("MEMORY_CHANGE_PROPOSAL_LOCATION_INVALID");
  }
  const captured = await captureRegularFile(
    path.dirname(absolute),
    path.basename(absolute),
    MAX_PROPOSAL_BYTES,
  );
  return assertProposal(parseJson(captured.content), projectId);
}

async function captureMarkdown(root, relativePath) {
  const captured = await captureRegularFile(root, relativePath, MAX_MARKDOWN_BYTES);
  let source;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(captured.content);
  } catch {
    throw new WorkbenchError("MEMORY_MARKDOWN_INVALID");
  }
  return { captured, parsed: parseMemoryMarkdown(source) };
}

function markdownBytes(frontmatter, body) {
  return Buffer.from(serializeMemoryMarkdown({ frontmatter, body }), "utf8");
}

function changeDigest(base) {
  return sha256Bytes(Buffer.from(stableJson(base), "utf8"));
}

function fileSha(snapshot, relativePath) {
  return snapshot.files.find((item) => item.path === relativePath)?.sha256 ?? null;
}

function snapshotDigestForWrite(snapshot, target, beforeSha) {
  if (target.startsWith("inbox/") || target.startsWith("generated/") || target === "local.json") {
    return sha256Bytes(Buffer.from(stableJson({
      canonical_snapshot_sha256: snapshot.snapshot_sha256,
      target,
      before_sha256: beforeSha,
    }), "utf8"));
  }
  return snapshot.snapshot_sha256;
}

async function buildChange({ start, proposalPath, proposal, expectedOperation }) {
  const location = await locateProjectWorkspace({ start });
  if (location.marker !== MEMORY_PROJECT_MARKER) {
    throw new WorkbenchError("MEMORY_WORKSPACE_REQUIRED");
  }
  const snapshot = await snapshotMemoryWorkspace(location, resolveLimits());
  const manifest = snapshot.documents.manifest;
  const normalized = await loadProposal({
    proposalPath,
    proposal,
    projectRoot: location.project_root ?? path.dirname(location.root),
    projectId: manifest.project_id,
  });
  if (expectedOperation !== undefined && (
    !OPERATIONS.has(expectedOperation) || normalized.operation !== expectedOperation
  )) {
    throw new WorkbenchError("MEMORY_CHANGE_PROPOSAL_INVALID");
  }
  const payload = normalized.payload;
  let target;
  let afterBytes;
  let summary;
  let extraBeforeSha = null;

  if (normalized.operation === "work_create") {
    target = `work/${payload.work.work_id}.md`;
    if (await entryInfo(path.join(location.root, target))) {
      throw new WorkbenchError("MEMORY_TARGET_EXISTS");
    }
    const knownKnowledge = new Set(snapshot.documents.knowledge
      .filter((item) => item.status === "approved")
      .map((item) => item.knowledge_id));
    if (payload.work.knowledge_ids.some((item) => !knownKnowledge.has(item))) {
      throw new WorkbenchError("MEMORY_KNOWLEDGE_NOT_FOUND");
    }
    afterBytes = markdownBytes(payload.work, payload.body);
    summary = `Work ${payload.work.work_id} will be created.`;
  } else if (normalized.operation === "work_status") {
    target = `work/${payload.work_id}.md`;
    const current = await captureMarkdown(location.root, target);
    const work = assertMemoryWork(current.parsed.frontmatter);
    if (work.work_id !== payload.work_id) throw new WorkbenchError("MEMORY_TARGET_ID_MISMATCH");
    afterBytes = markdownBytes(assertMemoryWork({ ...work, status: payload.status }), current.parsed.body);
    summary = `Work ${payload.work_id} will change to ${payload.status}.`;
  } else if (normalized.operation === "work_select") {
    target = "local.json";
    if (payload.work_id !== null && !snapshot.documents.works.some((item) => item.work_id === payload.work_id)) {
      throw new WorkbenchError("MEMORY_WORK_NOT_FOUND");
    }
    afterBytes = Buffer.from(stableJson(assertMemoryLocalState({
      format: "dubsar.local-state/1",
      project_id: manifest.project_id,
      selected_work_id: payload.work_id,
    }, manifest.project_id)), "utf8");
    summary = payload.work_id === null
      ? "The local work selection will be cleared."
      : `Work ${payload.work_id} will be selected locally.`;
  } else if (normalized.operation === "inbox_add") {
    target = `inbox/${payload.note_id}.md`;
    if (await entryInfo(path.join(location.root, target))) throw new WorkbenchError("MEMORY_TARGET_EXISTS");
    afterBytes = markdownBytes({ format: "dubsar.inbox-note/1", note_id: payload.note_id }, payload.body);
    summary = `Local inbox note ${payload.note_id} will be created.`;
  } else if (normalized.operation === "inbox_promote") {
    const notePath = `inbox/${payload.note_id}.md`;
    const note = await captureMarkdown(location.root, notePath);
    if (
      !exactKeys(note.parsed.frontmatter, ["format", "note_id"]) ||
      note.parsed.frontmatter.format !== "dubsar.inbox-note/1" ||
      note.parsed.frontmatter.note_id !== payload.note_id
    ) throw new WorkbenchError("MEMORY_INBOX_NOTE_INVALID");
    extraBeforeSha = note.captured.sha256;
    target = `knowledge/${payload.knowledge.knowledge_id}.md`;
    if (await entryInfo(path.join(location.root, target))) throw new WorkbenchError("MEMORY_TARGET_EXISTS");
    if (
      payload.knowledge.supersedes !== null &&
      !snapshot.documents.knowledge.some((item) => item.knowledge_id === payload.knowledge.supersedes)
    ) throw new WorkbenchError("MEMORY_KNOWLEDGE_NOT_FOUND");
    afterBytes = markdownBytes(payload.knowledge, payload.body);
    summary = `Inbox note ${payload.note_id} will be promoted without deleting it.`;
  } else if (normalized.operation === "knowledge_retire") {
    target = `knowledge/${payload.knowledge_id}.md`;
    const current = await captureMarkdown(location.root, target);
    const knowledge = assertMemoryKnowledge(current.parsed.frontmatter);
    if (knowledge.knowledge_id !== payload.knowledge_id) {
      throw new WorkbenchError("MEMORY_TARGET_ID_MISMATCH");
    }
    afterBytes = markdownBytes(
      assertMemoryKnowledge({ ...knowledge, status: "retired" }),
      current.parsed.body,
    );
    summary = `Knowledge ${payload.knowledge_id} will be retired in place.`;
  } else if (normalized.operation === "checkpoint_append") {
    target = "checkpoints.json";
    const current = snapshot.documents.checkpoints;
    if (!snapshot.documents.works.some((item) => item.work_id === payload.entry.work_id)) {
      throw new WorkbenchError("MEMORY_WORK_NOT_FOUND");
    }
    if (!Array.isArray(payload.entry.references) || payload.entry.references.length > 8) fail();
    const references = [];
    for (const claimed of payload.entry.references) {
      if (!exactKeys(claimed, ["path", "sha256"]) || !SHA256.test(claimed.sha256 ?? "")) fail();
      const relative = normalizeRelativePath(claimed.path);
      if (relative.startsWith(".dubsar/")) throw new WorkbenchError("MEMORY_REFERENCE_UNSAFE");
      const captured = await captureRegularFile(
        location.project_root ?? path.dirname(location.root),
        relative,
        25 * 1024 * 1024,
      );
      if (
        captured.sha256 !== claimed.sha256 ||
        artifactPolicyFinding(relative, captured.content) !== null
      ) throw new WorkbenchError("MEMORY_REFERENCE_INVALID");
      references.push({ path: relative, sha256: captured.sha256 });
    }
    const index = current.entries.length;
    const previous = current.entries.at(-1)?.checkpoint_sha256 ?? null;
    const withoutDigest = {
      ...payload.entry,
      references,
      index,
      previous_checkpoint_sha256: previous,
    };
    const entry = {
      ...withoutDigest,
      checkpoint_sha256: memoryCheckpointDigest(withoutDigest),
    };
    const after = assertMemoryCheckpoints({ ...current, entries: [...current.entries, entry] }, manifest.project_id);
    afterBytes = Buffer.from(stableJson(after), "utf8");
    summary = "One continuity checkpoint will be appended.";
  } else {
    target = "generated/context.md";
    if (payload.source_snapshot_sha256 !== snapshot.snapshot_sha256) {
      throw new WorkbenchError("MEMORY_CONTEXT_SNAPSHOT_MISMATCH");
    }
    afterBytes = Buffer.from(payload.content, "utf8");
    summary = "The local generated context will be replaced.";
  }

  const beforeSha = fileSha(snapshot, target) ?? (
    await entryInfo(path.join(location.root, target))
      ? (await captureRegularFile(location.root, target, MAX_TARGET_BYTES)).sha256
      : null
  );
  const writeSnapshotSha = snapshotDigestForWrite(snapshot, target, beforeSha);
  const base = {
    operation: normalized.operation,
    target,
    project_id: manifest.project_id,
    snapshot_sha256: writeSnapshotSha,
    canonical_snapshot_sha256: snapshot.snapshot_sha256,
    before_sha256: beforeSha,
    after_sha256: sha256Bytes(afterBytes),
    source_sha256: extraBeforeSha,
    proposal_sha256: sha256Bytes(Buffer.from(stableJson(normalized), "utf8")),
  };
  return {
    location,
    target,
    afterBytes,
    sourceNote: normalized.operation === "inbox_promote"
      ? { path: `inbox/${payload.note_id}.md`, sha256: extraBeforeSha }
      : null,
    preview: {
      format: MEMORY_CHANGE_PREVIEW_FORMAT,
      status: "preview",
      ...base,
      change_sha256: changeDigest(base),
      summary,
      consequence: `Only .dubsar/${target} will change.`,
    },
  };
}

function allowedTarget(relativePath) {
  return relativePath === "local.json" || relativePath === "checkpoints.json" ||
    relativePath === "generated/context.md" ||
    /^(?:work|knowledge|inbox)\/[a-z0-9][a-z0-9._-]{2,127}\.md$/iu.test(relativePath);
}

async function publishOneFile(change, expectedChange) {
  if (!SHA256.test(expectedChange ?? "") || expectedChange !== change.preview.change_sha256) {
    throw new WorkbenchError("MEMORY_CHANGE_CONFIRMATION_MISMATCH");
  }
  if (!allowedTarget(change.target)) throw new WorkbenchError("MEMORY_TARGET_UNSAFE");
  const root = change.location.root;
  const target = path.join(root, ...change.target.split("/"));
  const parent = path.dirname(target);
  await openDirectory(parent);
  const lockPath = path.join(root, ".dubsar-memory.lock");
  const temporaryName = `.dubsar-memory-${randomBytes(12).toString("hex")}.tmp`;
  const temporary = path.join(parent, temporaryName);
  let lockHandle;
  let handle;
  let ownsLock = false;
  let published = false;
  try {
    try {
      lockHandle = await open(lockPath, "wx", 0o600);
      ownsLock = true;
    } catch {
      throw new WorkbenchError("MEMORY_CHANGE_LOCKED");
    }
    const currentSnapshot = await snapshotMemoryWorkspace(change.location, resolveLimits());
    const liveBefore = fileSha(currentSnapshot, change.target) ?? (
      await entryInfo(target)
        ? (await captureRegularFile(root, change.target, MAX_TARGET_BYTES)).sha256
        : null
    );
    if (
      currentSnapshot.snapshot_sha256 !== change.preview.canonical_snapshot_sha256 ||
      snapshotDigestForWrite(currentSnapshot, change.target, liveBefore) !== change.preview.snapshot_sha256
    ) {
      throw new WorkbenchError("MEMORY_CHANGE_CONCURRENT");
    }
    if (change.sourceNote !== null) {
      const source = await captureRegularFile(root, change.sourceNote.path, MAX_MARKDOWN_BYTES);
      if (source.sha256 !== change.sourceNote.sha256) throw new WorkbenchError("MEMORY_CHANGE_CONCURRENT");
    }
    const targetInfo = await entryInfo(target);
    if (change.preview.before_sha256 === null) {
      if (targetInfo !== null) throw new WorkbenchError("MEMORY_CHANGE_CONCURRENT");
    } else {
      if (!targetInfo?.isFile() || targetInfo.isSymbolicLink() || targetInfo.nlink > 1n) {
        throw new WorkbenchError("MEMORY_TARGET_UNSAFE");
      }
      const current = await captureRegularFile(root, change.target, MAX_TARGET_BYTES);
      if (current.sha256 !== change.preview.before_sha256) throw new WorkbenchError("MEMORY_CHANGE_CONCURRENT");
    }
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(change.afterBytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    const staged = await captureRegularFile(parent, temporaryName, MAX_TARGET_BYTES);
    if (staged.sha256 !== change.preview.after_sha256) {
      throw new WorkbenchError("MEMORY_CHANGE_STAGING_MISMATCH");
    }
    if (change.preview.before_sha256 !== null) {
      const finalCheck = await captureRegularFile(root, change.target, MAX_TARGET_BYTES);
      if (finalCheck.sha256 !== change.preview.before_sha256) throw new WorkbenchError("MEMORY_CHANGE_CONCURRENT");
    } else if (await entryInfo(target)) {
      throw new WorkbenchError("MEMORY_CHANGE_CONCURRENT");
    }
    await rename(temporary, target);
    published = true;
    const final = await captureRegularFile(root, change.target, MAX_TARGET_BYTES);
    if (final.sha256 !== change.preview.after_sha256) {
      throw new WorkbenchError("MEMORY_CHANGE_PUBLICATION_MISMATCH");
    }
    const resultingSnapshot = await snapshotMemoryWorkspace(change.location, resolveLimits());
    return {
      format: MEMORY_CHANGE_APPLY_FORMAT,
      status: "applied",
      operation: change.preview.operation,
      target: change.preview.target,
      change_sha256: change.preview.change_sha256,
      before_sha256: change.preview.before_sha256,
      after_sha256: change.preview.after_sha256,
      snapshot_sha256: resultingSnapshot.snapshot_sha256,
    };
  } finally {
    await handle?.close();
    if (!published) await unlink(temporary).catch(() => {});
    await lockHandle?.close();
    if (ownsLock) await unlink(lockPath).catch(() => {});
  }
}

export async function previewMemoryChange(options) {
  return (await buildChange(options)).preview;
}

export async function applyMemoryChange({ expectedChange, ...options }) {
  return publishOneFile(await buildChange(options), expectedChange);
}
