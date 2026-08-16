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
import { locateProjectWorkspace, MEMORY_PROJECT_MARKER } from "./locate.mjs";
import {
  MEMORY_MAX_CHECKPOINTS,
  MEMORY_PENDING_MAX_FILE_BYTES,
  assertMemoryCheckpoints,
  assertPendingCheckpointDocument,
  assertPendingCheckpointId,
  assertPendingDeclaredSource,
  memoryCheckpointDigest,
} from "./memory-vnext-contracts.mjs";
import { parseMemoryMarkdown } from "./memory-vnext-markdown.mjs";
import { listPendingCheckpoints } from "./memory-vnext-pending-list.mjs";
import { snapshotMemoryWorkspace } from "./memory-vnext-snapshot.mjs";
import {
  entryInfo,
  normalizeRelativePath,
  openDirectory,
  sameIdentity,
} from "./path-safety.mjs";
import { captureRegularFile } from "./safe-capture.mjs";
import { artifactPolicyFinding } from "./sensitive-content.mjs";

export const PENDING_CHECKPOINT_PROMOTION_PREVIEW_FORMAT =
  "dubsar.pending-checkpoint-promotion-preview/1";
export const PENDING_CHECKPOINT_PROMOTION_APPLY_FORMAT =
  "dubsar.pending-checkpoint-promotion-apply/1";

const SHA256 = /^[0-9a-f]{64}$/u;
const PENDING_ROOT_NAME = ".dubsar-pending";
const TARGET = "checkpoints.json";
const MAX_TARGET_BYTES = 1024 * 1024;

function changeDigest(base) {
  return sha256Bytes(Buffer.from(stableJson(base), "utf8"));
}

function authorFields(value) {
  return {
    attempt: value.attempt,
    checkpoint_id: value.checkpoint_id,
    kind: value.kind,
    limitations: value.limitations,
    references: value.references,
    resolves: value.resolves,
    resulting_state: value.resulting_state,
    summary: value.summary,
    validation: value.validation,
    work_id: value.work_id,
  };
}

function authorsEqual(left, right) {
  return stableJson(authorFields(left)) === stableJson(authorFields(right));
}

function fileSha(snapshot, relativePath) {
  return snapshot.files.find((item) => item.path === relativePath)?.sha256 ?? null;
}

function workHead(entries, workId) {
  let head = null;
  for (const entry of entries) {
    if (entry.work_id === workId) head = entry.checkpoint_sha256;
  }
  return head;
}

async function assertPendingParent(projectRoot, memoryRoot) {
  const openedProject = await openDirectory(projectRoot);
  const openedMemory = await openDirectory(memoryRoot);
  const memoryParent = path.dirname(openedMemory);
  const projectInfo = await entryInfo(openedProject);
  const parentInfo = await entryInfo(memoryParent);
  if (
    projectInfo === null ||
    parentInfo === null ||
    !sameIdentity(projectInfo, parentInfo) ||
    path.basename(openedMemory) !== MEMORY_PROJECT_MARKER
  ) {
    throw new WorkbenchError("PENDING_ROOT_UNSAFE");
  }
  return openedProject;
}

async function openExactPendingRoot(projectRoot) {
  const pendingRoot = path.join(projectRoot, PENDING_ROOT_NAME);
  const rootInfo = await entryInfo(pendingRoot);
  if (rootInfo === null) throw new WorkbenchError("PENDING_CANDIDATE_NOT_FOUND");
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new WorkbenchError("PENDING_ROOT_UNSAFE");
  }
  const opened = await openDirectory(pendingRoot);
  if (path.basename(opened) !== PENDING_ROOT_NAME) {
    throw new WorkbenchError("PENDING_ROOT_UNSAFE");
  }
  return opened;
}

function mapPendingCaptureError(error) {
  if (!(error instanceof WorkbenchError)) {
    throw new WorkbenchError("PENDING_ROOT_UNSAFE");
  }
  if (error.code === "FILE_SIZE_LIMIT_EXCEEDED") {
    throw new WorkbenchError("PENDING_LIMIT_EXCEEDED");
  }
  if (
    error.code === "FILE_CHANGED_DURING_SNAPSHOT" ||
    error.code === "PATH_NOT_FOUND" ||
    error.code === "REQUIRED_FILE_MISSING"
  ) {
    throw new WorkbenchError("PENDING_CAPTURE_RACE");
  }
  if (
    error.code === "FILE_UNSAFE" ||
    error.code === "SYMBOLIC_PATH_REJECTED" ||
    error.code === "UNSAFE_RELATIVE_PATH" ||
    error.code === "DIRECTORY_UNSAFE" ||
    error.code === "DIRECTORY_ALIAS_REJECTED"
  ) {
    throw new WorkbenchError("PENDING_ROOT_UNSAFE");
  }
  throw error;
}

async function captureCandidateTwice(pendingRoot, portable, afterFirstCapture) {
  let first;
  let second;
  try {
    first = await captureRegularFile(pendingRoot, portable, MEMORY_PENDING_MAX_FILE_BYTES);
    if (typeof afterFirstCapture === "function") await afterFirstCapture();
    second = await captureRegularFile(pendingRoot, portable, MEMORY_PENDING_MAX_FILE_BYTES);
  } catch (error) {
    if (error instanceof WorkbenchError && (
      error.code === "PATH_NOT_FOUND" || error.code === "REQUIRED_FILE_MISSING"
    )) {
      throw new WorkbenchError("PENDING_CANDIDATE_NOT_FOUND");
    }
    mapPendingCaptureError(error);
  }
  if (
    first.sha256 !== second.sha256 ||
    first.identity !== second.identity ||
    !first.content.equals(second.content)
  ) {
    throw new WorkbenchError("PENDING_CAPTURE_RACE");
  }
  return first;
}

async function validateReferences(projectRoot, references) {
  const output = [];
  for (const claimed of references) {
    if (!exactKeys(claimed, ["path", "sha256"]) || !SHA256.test(claimed.sha256 ?? "")) {
      throw new WorkbenchError("PENDING_DOCUMENT_INVALID");
    }
    const relative = normalizeRelativePath(claimed.path);
    if (relative.startsWith(".dubsar/") || relative.startsWith(`${PENDING_ROOT_NAME}/`)) {
      throw new WorkbenchError("PENDING_REFERENCE_UNSAFE");
    }
    let captured;
    try {
      captured = await captureRegularFile(projectRoot, relative, 25 * 1024 * 1024);
    } catch (error) {
      if (error instanceof WorkbenchError) throw error;
      throw new WorkbenchError("PENDING_REFERENCE_INVALID");
    }
    if (
      captured.sha256 !== claimed.sha256 ||
      artifactPolicyFinding(relative, captured.content) !== null
    ) {
      throw new WorkbenchError("PENDING_REFERENCE_INVALID");
    }
    output.push({ path: relative, sha256: captured.sha256 });
  }
  return output;
}

function classifyPromotion({
  document,
  snapshot,
  pendingList,
  declaredSource,
  checkpointId,
}) {
  const entries = snapshot.documents.checkpoints.entries;
  const sameIdPending = pendingList.candidates.filter(
    (item) => item.checkpoint_id === checkpointId,
  );
  if (sameIdPending.length > 1) {
    throw new WorkbenchError("PENDING_PROMOTION_DUPLICATE_ID");
  }
  if (
    sameIdPending.length === 1 &&
    sameIdPending[0].declared_source !== declaredSource
  ) {
    throw new WorkbenchError("PENDING_PROMOTION_DUPLICATE_ID");
  }

  const canonical = entries.find((entry) => entry.checkpoint_id === checkpointId);
  if (canonical !== undefined) {
    if (authorsEqual(canonical, document.checkpoint)) {
      return { state: "already_promoted", staleChain: false };
    }
    throw new WorkbenchError("PENDING_PROMOTION_COLLISION");
  }

  if (!snapshot.documents.works.some((item) => item.work_id === document.checkpoint.work_id)) {
    throw new WorkbenchError("PENDING_WORK_NOT_FOUND");
  }
  if (
    document.checkpoint.resolves !== null &&
    !entries.some((entry) => entry.checkpoint_id === document.checkpoint.resolves)
  ) {
    throw new WorkbenchError("PENDING_RESOLVES_INVALID");
  }

  const currentWorkHead = workHead(entries, document.checkpoint.work_id);
  if (document.base_work_checkpoint_sha256 !== currentWorkHead) {
    throw new WorkbenchError("PENDING_PROMOTION_STALE_WORK");
  }

  const currentGlobalHead = entries.at(-1)?.checkpoint_sha256 ?? null;
  const staleChain = document.base_checkpoint_sha256 !== currentGlobalHead;
  return { state: staleChain ? "stale_chain" : "ready", staleChain };
}

function buildCanonicalAfter(snapshot, author) {
  const current = snapshot.documents.checkpoints;
  if (current.entries.length >= MEMORY_MAX_CHECKPOINTS) {
    throw new WorkbenchError("PENDING_PROMOTION_JOURNAL_FULL");
  }
  const index = current.entries.length;
  const previous = current.entries.at(-1)?.checkpoint_sha256 ?? null;
  const withoutDigest = {
    ...author,
    index,
    previous_checkpoint_sha256: previous,
  };
  const entry = {
    ...withoutDigest,
    checkpoint_sha256: memoryCheckpointDigest(withoutDigest),
  };
  return assertMemoryCheckpoints(
    { ...current, entries: [...current.entries, entry] },
    snapshot.documents.manifest.project_id,
  );
}

async function buildPromotion({ start, source, checkpoint, afterCandidateCapture }) {
  const declaredSource = assertPendingDeclaredSource(source, "PENDING_DOCUMENT_INVALID");
  const checkpointId = assertPendingCheckpointId(checkpoint, "PENDING_DOCUMENT_INVALID");
  const location = await locateProjectWorkspace({ start });
  if (location.marker !== MEMORY_PROJECT_MARKER) {
    throw new WorkbenchError("PENDING_WORKSPACE_REQUIRED");
  }
  const projectRoot = await assertPendingParent(
    location.project_root ?? path.dirname(location.root),
    location.root,
  );
  const snapshot = await snapshotMemoryWorkspace(location, resolveLimits());
  const pendingList = await listPendingCheckpoints({ start });
  if (pendingList.project_id !== snapshot.documents.manifest.project_id) {
    throw new WorkbenchError("PENDING_CAPTURE_RACE");
  }
  const pendingRoot = await openExactPendingRoot(projectRoot);
  const portable = `${declaredSource}/${checkpointId}.md`;
  const captured = await captureCandidateTwice(pendingRoot, portable, afterCandidateCapture);

  let parsed;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(captured.content);
    parsed = parseMemoryMarkdown(text);
  } catch {
    throw new WorkbenchError("PENDING_ENTRY_INVALID");
  }
  if (parsed.body !== "") throw new WorkbenchError("PENDING_ENTRY_INVALID");
  const document = assertPendingCheckpointDocument(
    parsed.frontmatter,
    snapshot.documents.manifest.project_id,
  );
  if (
    document.declared_source !== declaredSource ||
    document.checkpoint.checkpoint_id !== checkpointId ||
    document.project_id !== snapshot.documents.manifest.project_id
  ) {
    throw new WorkbenchError("PENDING_ENTRY_INVALID");
  }

  const listed = pendingList.candidates.find(
    (item) =>
      item.declared_source === declaredSource &&
      item.checkpoint_id === checkpointId,
  );
  if (listed === undefined) throw new WorkbenchError("PENDING_ENTRY_INVALID");
  if (
    listed.candidate_sha256 !== document.candidate_sha256 ||
    listed.source_file_sha256 !== captured.sha256
  ) {
    throw new WorkbenchError("PENDING_CAPTURE_RACE");
  }

  const classification = classifyPromotion({
    document,
    snapshot,
    pendingList,
    declaredSource,
    checkpointId,
  });

  const liveReferences = await validateReferences(
    projectRoot,
    document.checkpoint.references,
  );
  if (stableJson(liveReferences) !== stableJson(document.checkpoint.references)) {
    throw new WorkbenchError("PENDING_REFERENCE_INVALID");
  }

  const author = authorFields(document.checkpoint);
  const beforeSha = fileSha(snapshot, TARGET) ?? (
    await entryInfo(path.join(location.root, TARGET))
      ? (await captureRegularFile(location.root, TARGET, MAX_TARGET_BYTES)).sha256
      : null
  );

  let afterDocument;
  let afterBytes;
  let afterSha;
  if (classification.state === "already_promoted") {
    afterDocument = snapshot.documents.checkpoints;
    afterBytes = Buffer.from(stableJson(afterDocument), "utf8");
    afterSha = beforeSha;
  } else {
    afterDocument = buildCanonicalAfter(snapshot, author);
    afterBytes = Buffer.from(stableJson(afterDocument), "utf8");
    afterSha = sha256Bytes(afterBytes);
  }

  const staleChain = classification.staleChain;
  const base = {
    operation: "pending_checkpoint_promotion",
    target: TARGET,
    project_id: snapshot.documents.manifest.project_id,
    declared_source: declaredSource,
    checkpoint_id: checkpointId,
    candidate_state: classification.state,
    stale_chain: staleChain,
    shared_snapshot_sha256: snapshot.shared_snapshot_sha256,
    canonical_snapshot_sha256: snapshot.snapshot_sha256,
    pending_set_sha256: pendingList.pending_set_sha256,
    list_sha256: pendingList.list_sha256,
    candidate_sha256: document.candidate_sha256,
    source_file_sha256: captured.sha256,
    before_sha256: beforeSha,
    after_sha256: afterSha,
  };

  const consequence = classification.state === "already_promoted"
    ? `No write: checkpoint ${checkpointId} is already canonical with identical author fields. .dubsar-pending stays unchanged.`
    : staleChain
      ? `Only .dubsar/${TARGET} will change. Candidate ${checkpointId} from ${declaredSource} will be appended after the current global parent, which differs from base_checkpoint_sha256 recorded at candidate creation. .dubsar-pending stays unchanged.`
      : `Only .dubsar/${TARGET} will change. Candidate ${checkpointId} from ${declaredSource} will be appended to the canonical checkpoint chain. .dubsar-pending stays unchanged.`;

  const summary = classification.state === "already_promoted"
    ? `Pending checkpoint ${checkpointId} is already promoted.`
    : staleChain
      ? `Pending checkpoint ${checkpointId} is stale on the global chain and will append after the current head.`
      : `Pending checkpoint ${checkpointId} will be promoted into the canonical chain.`;

  return {
    start,
    location,
    projectRoot,
    pendingRoot,
    portable,
    afterBytes,
    afterDocument,
    capturedSha256: captured.sha256,
    candidateSha256: document.candidate_sha256,
    alreadyPromoted: classification.state === "already_promoted",
    preview: {
      format: PENDING_CHECKPOINT_PROMOTION_PREVIEW_FORMAT,
      status: classification.state === "already_promoted" ? "already_promoted" : "preview",
      ...base,
      change_sha256: changeDigest(base),
      summary,
      consequence,
    },
  };
}

async function publishPromotion(change, expectedChange) {
  if (!SHA256.test(expectedChange ?? "") || expectedChange !== change.preview.change_sha256) {
    throw new WorkbenchError("PENDING_CONFIRMATION_MISMATCH");
  }

  const root = change.location.root;
  const target = path.join(root, TARGET);
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
      throw new WorkbenchError("PENDING_PROMOTION_LOCKED");
    }

    const live = await buildPromotion({
      start: change.start,
      source: change.preview.declared_source,
      checkpoint: change.preview.checkpoint_id,
    });
    if (
      live.preview.change_sha256 !== change.preview.change_sha256 ||
      live.preview.canonical_snapshot_sha256 !== change.preview.canonical_snapshot_sha256 ||
      live.preview.shared_snapshot_sha256 !== change.preview.shared_snapshot_sha256 ||
      live.preview.pending_set_sha256 !== change.preview.pending_set_sha256 ||
      live.preview.list_sha256 !== change.preview.list_sha256 ||
      live.preview.candidate_sha256 !== change.preview.candidate_sha256 ||
      live.preview.source_file_sha256 !== change.preview.source_file_sha256 ||
      live.preview.before_sha256 !== change.preview.before_sha256 ||
      live.preview.after_sha256 !== change.preview.after_sha256 ||
      live.preview.stale_chain !== change.preview.stale_chain ||
      live.alreadyPromoted !== change.alreadyPromoted
    ) {
      throw new WorkbenchError("PENDING_PROMOTION_CONCURRENT");
    }

    if (change.alreadyPromoted) {
      return {
        format: PENDING_CHECKPOINT_PROMOTION_APPLY_FORMAT,
        status: "already_promoted",
        operation: change.preview.operation,
        target: change.preview.target,
        declared_source: change.preview.declared_source,
        checkpoint_id: change.preview.checkpoint_id,
        candidate_sha256: change.preview.candidate_sha256,
        source_file_sha256: change.preview.source_file_sha256,
        change_sha256: change.preview.change_sha256,
        before_sha256: change.preview.before_sha256,
        after_sha256: change.preview.after_sha256,
        shared_snapshot_sha256: live.preview.shared_snapshot_sha256,
        snapshot_sha256: live.preview.canonical_snapshot_sha256,
      };
    }

    const targetInfo = await entryInfo(target);
    if (change.preview.before_sha256 === null) {
      if (targetInfo !== null) throw new WorkbenchError("PENDING_PROMOTION_CONCURRENT");
    } else {
      if (!targetInfo?.isFile() || targetInfo.isSymbolicLink() || targetInfo.nlink > 1n) {
        throw new WorkbenchError("PENDING_ROOT_UNSAFE");
      }
      const current = await captureRegularFile(root, TARGET, MAX_TARGET_BYTES);
      if (current.sha256 !== change.preview.before_sha256) {
        throw new WorkbenchError("PENDING_PROMOTION_CONCURRENT");
      }
    }

    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(live.afterBytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    const staged = await captureRegularFile(parent, temporaryName, MAX_TARGET_BYTES);
    if (staged.sha256 !== change.preview.after_sha256) {
      throw new WorkbenchError("PENDING_STAGING_MISMATCH");
    }
    if (change.preview.before_sha256 !== null) {
      const finalCheck = await captureRegularFile(root, TARGET, MAX_TARGET_BYTES);
      if (finalCheck.sha256 !== change.preview.before_sha256) {
        throw new WorkbenchError("PENDING_PROMOTION_CONCURRENT");
      }
    } else if (await entryInfo(target)) {
      throw new WorkbenchError("PENDING_PROMOTION_CONCURRENT");
    }

    await rename(temporary, target);
    published = true;
    const final = await captureRegularFile(root, TARGET, MAX_TARGET_BYTES);
    if (final.sha256 !== change.preview.after_sha256) {
      throw new WorkbenchError("PENDING_PUBLICATION_MISMATCH");
    }

    const pendingAfter = await captureRegularFile(
      change.pendingRoot,
      change.portable,
      MEMORY_PENDING_MAX_FILE_BYTES,
    );
    if (pendingAfter.sha256 !== change.preview.source_file_sha256) {
      throw new WorkbenchError("PENDING_PROMOTION_PENDING_MUTATION");
    }

    const resultingSnapshot = await snapshotMemoryWorkspace(change.location, resolveLimits());
    return {
      format: PENDING_CHECKPOINT_PROMOTION_APPLY_FORMAT,
      status: "applied",
      operation: change.preview.operation,
      target: change.preview.target,
      declared_source: change.preview.declared_source,
      checkpoint_id: change.preview.checkpoint_id,
      candidate_sha256: change.preview.candidate_sha256,
      source_file_sha256: change.preview.source_file_sha256,
      change_sha256: change.preview.change_sha256,
      before_sha256: change.preview.before_sha256,
      after_sha256: change.preview.after_sha256,
      shared_snapshot_sha256: resultingSnapshot.shared_snapshot_sha256,
      snapshot_sha256: resultingSnapshot.snapshot_sha256,
    };
  } finally {
    await handle?.close();
    if (!published) await unlink(temporary).catch(() => {});
    await lockHandle?.close();
    if (ownsLock) await unlink(lockPath).catch(() => {});
  }
}

export async function previewPendingCheckpointPromotion(options) {
  return (await buildPromotion(options)).preview;
}

export async function applyPendingCheckpointPromotion({ expectedChange, ...options }) {
  return publishPromotion(await buildPromotion(options), expectedChange);
}
