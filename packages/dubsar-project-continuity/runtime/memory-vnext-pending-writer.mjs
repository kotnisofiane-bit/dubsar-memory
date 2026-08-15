import { randomBytes } from "node:crypto";
import { mkdir, open, opendir, rename, unlink } from "node:fs/promises";
import path from "node:path";

import {
  WorkbenchError,
  exactKeys,
  resolveLimits,
  sha256Bytes,
  stableJson,
} from "./contracts.mjs";
import { locateProjectWorkspace, MEMORY_PROJECT_MARKER } from "./locate.mjs";
import {
  MEMORY_PENDING_CHECKPOINT_FORMAT,
  MEMORY_PENDING_MAX_CANDIDATES,
  MEMORY_PENDING_MAX_FILE_BYTES,
  MEMORY_PENDING_MAX_SOURCES,
  assertPendingCheckpointAuthor,
  assertPendingCheckpointDocument,
  assertPendingCheckpointId,
  assertPendingDeclaredSource,
  memoryPendingCandidateDigest,
} from "./memory-vnext-contracts.mjs";
import {
  serializeMemoryMarkdown,
} from "./memory-vnext-markdown.mjs";
import { snapshotMemoryWorkspace } from "./memory-vnext-snapshot.mjs";
import {
  assertNoSymbolicComponents,
  entryInfo,
  isInsideOrEqual,
  normalizeRelativePath,
  openDirectory,
  sameIdentity,
} from "./path-safety.mjs";
import { captureRegularFile } from "./safe-capture.mjs";
import { artifactPolicyFinding } from "./sensitive-content.mjs";

export const PENDING_CHECKPOINT_PROPOSAL_FORMAT = "dubsar.pending-checkpoint-proposal/1";
export const PENDING_CHECKPOINT_PREVIEW_FORMAT = "dubsar.pending-checkpoint-preview/1";
export const PENDING_CHECKPOINT_APPLY_FORMAT = "dubsar.pending-checkpoint-apply/1";

const SHA256 = /^[0-9a-f]{64}$/u;
const MAX_PROPOSAL_BYTES = 128 * 1024;
const PENDING_ROOT_NAME = ".dubsar-pending";

function fail(code = "PENDING_PROPOSAL_INVALID") {
  throw new WorkbenchError(code);
}

function parseJson(content, code = "PENDING_PROPOSAL_INVALID") {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(content));
  } catch {
    throw new WorkbenchError(code);
  }
}

function changeDigest(base) {
  return sha256Bytes(Buffer.from(stableJson(base), "utf8"));
}

function assertProposal(value, projectId) {
  if (!exactKeys(value, ["checkpoint", "declared_source", "format", "project_id"])) fail();
  if (value.format !== PENDING_CHECKPOINT_PROPOSAL_FORMAT || value.project_id !== projectId) fail();
  return {
    format: value.format,
    project_id: value.project_id,
    declared_source: assertPendingDeclaredSource(value.declared_source, "PENDING_PROPOSAL_INVALID"),
    checkpoint: assertPendingCheckpointAuthor(value.checkpoint),
  };
}

async function loadProposal({ proposalPath, proposal, projectRoot, projectId }) {
  const fromPath = typeof proposalPath === "string" && proposalPath.length > 0;
  const fromValue = proposal !== undefined;
  if (fromPath === fromValue) throw new WorkbenchError("PENDING_PROPOSAL_REQUIRED");
  if (fromValue) return assertProposal(proposal, projectId);
  const absolute = path.resolve(proposalPath);
  if (isInsideOrEqual(projectRoot, absolute)) {
    throw new WorkbenchError("PENDING_PROPOSAL_LOCATION_INVALID");
  }
  const captured = await captureRegularFile(
    path.dirname(absolute),
    path.basename(absolute),
    MAX_PROPOSAL_BYTES,
  );
  return assertProposal(parseJson(captured.content), projectId);
}

async function assertPendingParent(projectRoot, memoryRoot) {
  const openedProject = await openDirectory(projectRoot);
  const openedMemory = await openDirectory(memoryRoot);
  const memoryParent = path.dirname(openedMemory);
  const projectInfo = await entryInfo(openedProject);
  const parentInfo = await entryInfo(memoryParent);
  if (
    projectInfo === null || parentInfo === null ||
    !sameIdentity(projectInfo, parentInfo) ||
    path.basename(openedMemory) !== MEMORY_PROJECT_MARKER
  ) {
    throw new WorkbenchError("PENDING_ROOT_UNSAFE");
  }
  return openedProject;
}

function assertInventorySourceName(name) {
  try {
    return assertPendingDeclaredSource(name, "PENDING_ROOT_UNSAFE");
  } catch (error) {
    if (error instanceof WorkbenchError) throw error;
    throw new WorkbenchError("PENDING_ROOT_UNSAFE");
  }
}

function assertInventoryCheckpointFileName(name) {
  if (typeof name !== "string" || !name.endsWith(".md")) {
    throw new WorkbenchError("PENDING_ROOT_UNSAFE");
  }
  const checkpointId = name.slice(0, -3);
  try {
    assertPendingCheckpointId(checkpointId, "PENDING_ROOT_UNSAFE");
  } catch (error) {
    if (error instanceof WorkbenchError) throw error;
    throw new WorkbenchError("PENDING_ROOT_UNSAFE");
  }
  if (`${checkpointId}.md` !== name) throw new WorkbenchError("PENDING_ROOT_UNSAFE");
  return checkpointId;
}

async function assertSafePendingFile(absolute) {
  await assertNoSymbolicComponents(absolute);
  const info = await entryInfo(absolute);
  if (
    info === null ||
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.nlink > 1n ||
    info.size > BigInt(MEMORY_PENDING_MAX_FILE_BYTES)
  ) {
    throw new WorkbenchError(
      info !== null && info.size > BigInt(MEMORY_PENDING_MAX_FILE_BYTES)
        ? "PENDING_LIMIT_EXCEEDED"
        : "PENDING_ROOT_UNSAFE",
    );
  }
  return info;
}

async function inventoryPending(pendingRoot) {
  const info = await entryInfo(pendingRoot);
  if (info === null) {
    return { sources: new Set(), candidates: 0, paths: new Set() };
  }
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new WorkbenchError("PENDING_ROOT_UNSAFE");
  }
  const opened = await openDirectory(pendingRoot);
  const sources = new Set();
  const paths = new Set();
  const identities = new Set();
  let candidates = 0;
  let directory;
  try {
    directory = await opendir(opened);
    for await (const entry of directory) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        throw new WorkbenchError("PENDING_ROOT_UNSAFE");
      }
      const sourceName = assertInventorySourceName(entry.name);
      sources.add(sourceName);
      const sourcePath = path.join(opened, sourceName);
      await openDirectory(sourcePath);
      let nested;
      try {
        nested = await opendir(sourcePath);
        for await (const file of nested) {
          if (!file.isFile() || file.isSymbolicLink()) {
            throw new WorkbenchError("PENDING_ROOT_UNSAFE");
          }
          const checkpointId = assertInventoryCheckpointFileName(file.name);
          const absolute = path.join(sourcePath, `${checkpointId}.md`);
          const fileInfo = await assertSafePendingFile(absolute);
          const identity = `${fileInfo.dev}:${fileInfo.ino}`;
          if (identities.has(identity)) throw new WorkbenchError("PENDING_ROOT_UNSAFE");
          identities.add(identity);
          const portable = `${sourceName}/${checkpointId}.md`;
          if (paths.has(portable)) throw new WorkbenchError("PENDING_ROOT_UNSAFE");
          paths.add(portable);
          candidates += 1;
          if (sources.size > MEMORY_PENDING_MAX_SOURCES || candidates > MEMORY_PENDING_MAX_CANDIDATES) {
            throw new WorkbenchError("PENDING_LIMIT_EXCEEDED");
          }
        }
      } finally {
        await nested?.close().catch(() => {});
      }
    }
  } catch (error) {
    if (error instanceof WorkbenchError) throw error;
    throw new WorkbenchError("PENDING_ROOT_UNSAFE");
  } finally {
    await directory?.close().catch(() => {});
  }
  return { sources, candidates, paths };
}

async function buildPendingRecord({ start, proposalPath, proposal }) {
  const location = await locateProjectWorkspace({ start });
  if (location.marker !== MEMORY_PROJECT_MARKER) {
    throw new WorkbenchError("PENDING_WORKSPACE_REQUIRED");
  }
  const projectRoot = await assertPendingParent(
    location.project_root ?? path.dirname(location.root),
    location.root,
  );
  const snapshot = await snapshotMemoryWorkspace(location, resolveLimits());
  const manifest = snapshot.documents.manifest;
  const normalized = await loadProposal({
    proposalPath,
    proposal,
    projectRoot,
    projectId: manifest.project_id,
  });
  const declaredSource = assertPendingDeclaredSource(
    normalized.declared_source,
    "PENDING_PROPOSAL_INVALID",
  );
  if (!snapshot.documents.works.some((item) => item.work_id === normalized.checkpoint.work_id)) {
    throw new WorkbenchError("PENDING_WORK_NOT_FOUND");
  }
  if (normalized.checkpoint.resolves !== null) {
    const known = new Set(snapshot.documents.checkpoints.entries.map((entry) => entry.checkpoint_id));
    if (!known.has(normalized.checkpoint.resolves)) {
      throw new WorkbenchError("PENDING_RESOLVES_INVALID");
    }
  }
  const references = [];
  for (const claimed of normalized.checkpoint.references) {
    const relative = normalizeRelativePath(claimed.path);
    if (relative.startsWith(".dubsar/") || relative.startsWith(`${PENDING_ROOT_NAME}/`)) {
      throw new WorkbenchError("PENDING_REFERENCE_UNSAFE");
    }
    const captured = await captureRegularFile(projectRoot, relative, 25 * 1024 * 1024);
    if (
      captured.sha256 !== claimed.sha256 ||
      artifactPolicyFinding(relative, captured.content) !== null
    ) {
      throw new WorkbenchError("PENDING_REFERENCE_INVALID");
    }
    references.push({ path: relative, sha256: captured.sha256 });
  }
  const author = assertPendingCheckpointAuthor({
    ...normalized.checkpoint,
    references,
  });
  const checkpointId = author.checkpoint_id;
  const entries = snapshot.documents.checkpoints.entries;
  const baseCheckpoint = entries.at(-1)?.checkpoint_sha256 ?? null;
  let baseWork = null;
  for (const entry of entries) {
    if (entry.work_id === author.work_id) {
      baseWork = entry.checkpoint_sha256;
    }
  }
  const withoutDigest = {
    base_checkpoint_sha256: baseCheckpoint,
    base_work_checkpoint_sha256: baseWork,
    checkpoint: author,
    declared_source: declaredSource,
    format: MEMORY_PENDING_CHECKPOINT_FORMAT,
    project_id: manifest.project_id,
    source_shared_snapshot_sha256: snapshot.shared_snapshot_sha256,
  };
  const frontmatter = assertPendingCheckpointDocument({
    ...withoutDigest,
    candidate_sha256: memoryPendingCandidateDigest(withoutDigest),
  }, manifest.project_id);
  const afterBytes = Buffer.from(serializeMemoryMarkdown({
    frontmatter,
    body: "",
  }), "utf8");
  if (afterBytes.byteLength > MEMORY_PENDING_MAX_FILE_BYTES) {
    throw new WorkbenchError("PENDING_LIMIT_EXCEEDED");
  }
  const relativeTarget = `${declaredSource}/${checkpointId}.md`;
  const pendingRoot = path.join(projectRoot, PENDING_ROOT_NAME);
  const sourceDir = path.join(pendingRoot, declaredSource);
  const targetAbsolute = path.join(sourceDir, `${checkpointId}.md`);
  const inventory = await inventoryPending(pendingRoot);
  if (inventory.paths.has(relativeTarget)) {
    throw new WorkbenchError("PENDING_TARGET_EXISTS");
  }
  const nextSources = new Set(inventory.sources);
  nextSources.add(declaredSource);
  if (
    nextSources.size > MEMORY_PENDING_MAX_SOURCES ||
    inventory.candidates + 1 > MEMORY_PENDING_MAX_CANDIDATES
  ) {
    throw new WorkbenchError("PENDING_LIMIT_EXCEEDED");
  }
  const beforeInfo = await entryInfo(targetAbsolute);
  if (beforeInfo !== null) throw new WorkbenchError("PENDING_TARGET_EXISTS");
  const base = {
    operation: "pending_checkpoint_record",
    target: `${PENDING_ROOT_NAME}/${relativeTarget}`,
    project_id: manifest.project_id,
    declared_source: declaredSource,
    checkpoint_id: checkpointId,
    candidate_sha256: frontmatter.candidate_sha256,
    source_shared_snapshot_sha256: snapshot.shared_snapshot_sha256,
    shared_snapshot_sha256: snapshot.shared_snapshot_sha256,
    before_sha256: null,
    after_sha256: sha256Bytes(afterBytes),
    proposal_sha256: sha256Bytes(Buffer.from(stableJson({
      ...normalized,
      declared_source: declaredSource,
      checkpoint: author,
    }), "utf8")),
  };
  return {
    location,
    projectRoot,
    pendingRoot,
    sourceDir,
    targetAbsolute,
    relativeTarget,
    afterBytes,
    frontmatter,
    preview: {
      format: PENDING_CHECKPOINT_PREVIEW_FORMAT,
      status: "preview",
      ...base,
      change_sha256: changeDigest(base),
      summary: `Pending checkpoint ${checkpointId} will be recorded for source ${declaredSource}.`,
      consequence: `Only ${PENDING_ROOT_NAME}/${relativeTarget} will change. Canonical .dubsar/ memory is untouched.`,
    },
  };
}

async function ensurePendingTree(change) {
  try {
    if ((await entryInfo(change.pendingRoot)) === null) {
      await mkdir(change.pendingRoot, { recursive: false, mode: 0o700 });
    }
  } catch (error) {
    if (error instanceof WorkbenchError) throw error;
    throw new WorkbenchError("PENDING_ROOT_UNSAFE");
  }
  await openDirectory(change.pendingRoot);
  try {
    if ((await entryInfo(change.sourceDir)) === null) {
      await mkdir(change.sourceDir, { recursive: false, mode: 0o700 });
    }
  } catch (error) {
    if (error instanceof WorkbenchError) throw error;
    throw new WorkbenchError("PENDING_ROOT_UNSAFE");
  }
  await openDirectory(change.sourceDir);
}

async function publishPendingRecord(change, expectedChange) {
  if (!SHA256.test(expectedChange ?? "") || expectedChange !== change.preview.change_sha256) {
    throw new WorkbenchError("PENDING_CONFIRMATION_MISMATCH");
  }
  const lockPath = path.join(change.projectRoot, ".dubsar-pending-record.lock");
  const temporaryName = `.dubsar-pending-${randomBytes(12).toString("hex")}.tmp`;
  const temporary = path.join(change.sourceDir, temporaryName);
  let lockHandle;
  let handle;
  let ownsLock = false;
  let published = false;
  try {
    try {
      lockHandle = await open(lockPath, "wx", 0o600);
      ownsLock = true;
    } catch {
      throw new WorkbenchError("PENDING_LOCKED");
    }
    const liveSnapshot = await snapshotMemoryWorkspace(change.location, resolveLimits());
    if (liveSnapshot.shared_snapshot_sha256 !== change.preview.shared_snapshot_sha256) {
      throw new WorkbenchError("PENDING_CONCURRENT");
    }
    const inventory = await inventoryPending(change.pendingRoot);
    if (inventory.paths.has(change.relativeTarget) || await entryInfo(change.targetAbsolute)) {
      throw new WorkbenchError("PENDING_CONCURRENT");
    }
    const nextSources = new Set(inventory.sources);
    nextSources.add(change.preview.declared_source);
    if (
      nextSources.size > MEMORY_PENDING_MAX_SOURCES ||
      inventory.candidates + 1 > MEMORY_PENDING_MAX_CANDIDATES
    ) {
      throw new WorkbenchError("PENDING_LIMIT_EXCEEDED");
    }
    await ensurePendingTree(change);
    if (await entryInfo(change.targetAbsolute)) {
      throw new WorkbenchError("PENDING_CONCURRENT");
    }
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(change.afterBytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    const staged = await captureRegularFile(change.sourceDir, temporaryName, MEMORY_PENDING_MAX_FILE_BYTES);
    if (staged.sha256 !== change.preview.after_sha256) {
      throw new WorkbenchError("PENDING_STAGING_MISMATCH");
    }
    if (await entryInfo(change.targetAbsolute)) {
      throw new WorkbenchError("PENDING_CONCURRENT");
    }
    const target = change.targetAbsolute;
    await rename(temporary, target);
    published = true;
    const final = await captureRegularFile(
      change.sourceDir,
      `${change.preview.checkpoint_id}.md`,
      MEMORY_PENDING_MAX_FILE_BYTES,
    );
    if (final.sha256 !== change.preview.after_sha256) {
      throw new WorkbenchError("PENDING_PUBLICATION_MISMATCH");
    }
    const unchanged = await snapshotMemoryWorkspace(change.location, resolveLimits());
    if (unchanged.shared_snapshot_sha256 !== change.preview.shared_snapshot_sha256) {
      throw new WorkbenchError("PENDING_CANONICAL_MUTATION");
    }
    return {
      format: PENDING_CHECKPOINT_APPLY_FORMAT,
      status: "applied",
      operation: change.preview.operation,
      target: change.preview.target,
      declared_source: change.preview.declared_source,
      checkpoint_id: change.preview.checkpoint_id,
      candidate_sha256: change.preview.candidate_sha256,
      change_sha256: change.preview.change_sha256,
      before_sha256: null,
      after_sha256: change.preview.after_sha256,
      source_file_sha256: final.sha256,
      shared_snapshot_sha256: unchanged.shared_snapshot_sha256,
    };
  } finally {
    await handle?.close();
    if (!published) await unlink(temporary).catch(() => {});
    await lockHandle?.close();
    if (ownsLock) await unlink(lockPath).catch(() => {});
  }
}

export async function previewPendingCheckpointRecord(options) {
  return (await buildPendingRecord(options)).preview;
}

export async function applyPendingCheckpointRecord({ expectedChange, ...options }) {
  return publishPendingRecord(await buildPendingRecord(options), expectedChange);
}
