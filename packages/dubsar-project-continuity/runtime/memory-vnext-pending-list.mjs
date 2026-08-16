import { opendir } from "node:fs/promises";
import path from "node:path";

import {
  WorkbenchError,
  comparePortable,
  deepFreeze,
  resolveLimits,
  stableJson,
} from "./contracts.mjs";
import { safeDisplayText } from "./display-safety.mjs";
import { locateProjectWorkspace, MEMORY_PROJECT_MARKER } from "./locate.mjs";
import {
  MEMORY_PENDING_CHECKPOINT_FORMAT,
  MEMORY_PENDING_MAX_CANDIDATES,
  MEMORY_PENDING_MAX_FILE_BYTES,
  MEMORY_PENDING_MAX_SOURCES,
  MEMORY_PENDING_LIST_FORMAT,
  assertPendingCheckpointDocument,
  assertPendingCheckpointId,
  assertPendingDeclaredSource,
  memoryPendingListDigest,
  memoryPendingSetDigest,
} from "./memory-vnext-contracts.mjs";
import { parseMemoryMarkdown } from "./memory-vnext-markdown.mjs";
import { snapshotMemoryWorkspace } from "./memory-vnext-snapshot.mjs";
import {
  entryInfo,
  openDirectory,
  sameIdentity,
} from "./path-safety.mjs";
import { captureRegularFile } from "./safe-capture.mjs";

const PENDING_ROOT_NAME = ".dubsar-pending";
const MISSING_CODES = new Set(["PATH_NOT_FOUND", "REQUIRED_FILE_MISSING"]);

function displaySummary(value) {
  const result = safeDisplayText(value, 500);
  return result.redacted ? "[content withheld]" : result.text;
}

function foldKey(value) {
  return value.normalize("NFKC").toLowerCase();
}

function mapCaptureError(error) {
  if (!(error instanceof WorkbenchError)) {
    throw new WorkbenchError("PENDING_ROOT_UNSAFE");
  }
  if (error.code === "FILE_SIZE_LIMIT_EXCEEDED") {
    throw new WorkbenchError("PENDING_LIMIT_EXCEEDED");
  }
  if (
    error.code === "FILE_CHANGED_DURING_SNAPSHOT" ||
    MISSING_CODES.has(error.code)
  ) {
    throw new WorkbenchError("PENDING_CAPTURE_RACE");
  }
  throw new WorkbenchError("PENDING_ROOT_UNSAFE");
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
  if (rootInfo === null) return null;
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new WorkbenchError("PENDING_ROOT_UNSAFE");
  }
  let opened;
  try {
    opened = await openDirectory(pendingRoot);
  } catch (error) {
    mapCaptureError(error);
  }
  if (path.basename(opened) !== PENDING_ROOT_NAME) {
    throw new WorkbenchError("PENDING_ROOT_UNSAFE");
  }
  return opened;
}

/**
 * One bounded capture of `.dubsar-pending/`. Limits are enforced inside each
 * `for await` before any Dirent is retained. Unknown layout fails closed.
 */
async function capturePendingInventory(projectRoot) {
  const opened = await openExactPendingRoot(projectRoot);
  if (opened === null) {
    return { kind: "absent", captures: [], ledger: null };
  }

  const captures = [];
  const identities = new Set();
  const sourceFolds = new Set();
  const sources = new Set();
  const ledger = [];
  let sourceSlots = 0;
  let candidateSlots = 0;
  let directory;

  try {
    directory = await opendir(opened);
    const sourceEntries = [];
    for await (const entry of directory) {
      sourceSlots += 1;
      if (sourceSlots > MEMORY_PENDING_MAX_SOURCES) {
        throw new WorkbenchError("PENDING_LIMIT_EXCEEDED");
      }
      sourceEntries.push(entry);
    }
    sourceEntries.sort((left, right) => comparePortable(left.name, right.name));

    for (const entry of sourceEntries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        throw new WorkbenchError("PENDING_ROOT_UNSAFE");
      }

      let sourceName;
      try {
        sourceName = assertPendingDeclaredSource(entry.name, "PENDING_ROOT_UNSAFE");
      } catch {
        throw new WorkbenchError("PENDING_ROOT_UNSAFE");
      }
      if (sourceName !== entry.name) {
        throw new WorkbenchError("PENDING_ROOT_UNSAFE");
      }

      const foldedSource = foldKey(sourceName);
      if (sourceFolds.has(foldedSource) || sources.has(sourceName)) {
        throw new WorkbenchError("PENDING_ROOT_UNSAFE");
      }
      sourceFolds.add(foldedSource);
      sources.add(sourceName);

      const sourcePath = path.join(opened, sourceName);
      try {
        await openDirectory(sourcePath);
      } catch (error) {
        mapCaptureError(error);
      }

      let nested;
      const fileEntries = [];
      try {
        nested = await opendir(sourcePath);
        for await (const file of nested) {
          candidateSlots += 1;
          if (candidateSlots > MEMORY_PENDING_MAX_CANDIDATES) {
            throw new WorkbenchError("PENDING_LIMIT_EXCEEDED");
          }
          fileEntries.push(file);
        }
      } finally {
        await nested?.close().catch(() => {});
      }
      fileEntries.sort((left, right) => comparePortable(left.name, right.name));

      const fileLedger = [];
      const fileFolds = new Set();
      for (const file of fileEntries) {
        if (!file.isFile() || file.isSymbolicLink()) {
          throw new WorkbenchError("PENDING_ROOT_UNSAFE");
        }
        if (!file.name.endsWith(".md")) {
          throw new WorkbenchError("PENDING_ROOT_UNSAFE");
        }
        let checkpointId;
        try {
          checkpointId = assertPendingCheckpointId(file.name.slice(0, -3), "PENDING_ROOT_UNSAFE");
        } catch {
          throw new WorkbenchError("PENDING_ROOT_UNSAFE");
        }
        if (`${checkpointId}.md` !== file.name) {
          throw new WorkbenchError("PENDING_ROOT_UNSAFE");
        }

        const foldedFile = foldKey(file.name);
        if (fileFolds.has(foldedFile)) {
          throw new WorkbenchError("PENDING_ROOT_UNSAFE");
        }
        fileFolds.add(foldedFile);

        const portable = `${sourceName}/${checkpointId}.md`;
        let captured;
        try {
          captured = await captureRegularFile(
            opened,
            portable,
            MEMORY_PENDING_MAX_FILE_BYTES,
          );
        } catch (error) {
          mapCaptureError(error);
        }
        if (identities.has(captured.identity)) {
          throw new WorkbenchError("PENDING_ROOT_UNSAFE");
        }
        identities.add(captured.identity);
        captures.push({
          portable,
          declaredSource: sourceName,
          checkpointId,
          sha256: captured.sha256,
          content: captured.content,
          identity: captured.identity,
        });
        fileLedger.push({
          name: file.name,
          portable,
          sha256: captured.sha256,
          identity: captured.identity,
        });
      }

      ledger.push({
        name: sourceName,
        files: fileLedger,
      });
    }
  } catch (error) {
    if (error instanceof WorkbenchError) throw error;
    throw new WorkbenchError("PENDING_ROOT_UNSAFE");
  } finally {
    await directory?.close().catch(() => {});
  }

  return { kind: "present", captures, ledger };
}

function inventoryFingerprint(inventory) {
  if (inventory.kind === "absent") return "absent";
  return stableJson({ ledger: inventory.ledger });
}

function parseCandidate(capture, projectId, knownWorks, knownCheckpoints) {
  let parsed;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(capture.content);
    parsed = parseMemoryMarkdown(text);
  } catch {
    throw new WorkbenchError("PENDING_ENTRY_INVALID");
  }
  if (parsed.body !== "") {
    throw new WorkbenchError("PENDING_ENTRY_INVALID");
  }
  let document;
  try {
    document = assertPendingCheckpointDocument(parsed.frontmatter, projectId);
  } catch {
    throw new WorkbenchError("PENDING_ENTRY_INVALID");
  }
  if (
    document.format !== MEMORY_PENDING_CHECKPOINT_FORMAT ||
    document.declared_source !== capture.declaredSource ||
    document.checkpoint.checkpoint_id !== capture.checkpointId
  ) {
    throw new WorkbenchError("PENDING_ENTRY_INVALID");
  }
  if (!knownWorks.has(document.checkpoint.work_id)) {
    throw new WorkbenchError("PENDING_ENTRY_INVALID");
  }
  if (
    document.checkpoint.resolves !== null &&
    !knownCheckpoints.has(document.checkpoint.resolves)
  ) {
    throw new WorkbenchError("PENDING_ENTRY_INVALID");
  }
  return {
    declared_source: document.declared_source,
    checkpoint_id: document.checkpoint.checkpoint_id,
    work_id: document.checkpoint.work_id,
    kind: document.checkpoint.kind,
    summary: displaySummary(document.checkpoint.summary),
    candidate_sha256: document.candidate_sha256,
    source_file_sha256: capture.sha256,
  };
}

/**
 * Read-only list of valid pending checkpoint candidates.
 * Never mutates `.dubsar/` or `.dubsar-pending/`. Never observes references.
 *
 * @internal afterInventoryPass — test seam only.
 */
export async function listPendingCheckpoints({ start, afterInventoryPass } = {}) {
  const location = await locateProjectWorkspace({ start });
  if (location.marker !== MEMORY_PROJECT_MARKER) {
    throw new WorkbenchError("PENDING_WORKSPACE_REQUIRED");
  }
  const projectRoot = await assertPendingParent(
    location.project_root ?? path.dirname(location.root),
    location.root,
  );
  const snapshot = await snapshotMemoryWorkspace(location, resolveLimits());
  const projectId = snapshot.documents.manifest.project_id;
  const shared = snapshot.shared_snapshot_sha256;
  const knownWorks = new Set(snapshot.documents.works.map((item) => item.work_id));
  const knownCheckpoints = new Set(
    snapshot.documents.checkpoints.entries.map((entry) => entry.checkpoint_id),
  );

  let first;
  try {
    first = await capturePendingInventory(projectRoot);
    if (typeof afterInventoryPass === "function") await afterInventoryPass();
    const second = await capturePendingInventory(projectRoot);
    if (inventoryFingerprint(first) !== inventoryFingerprint(second)) {
      throw new WorkbenchError("PENDING_CAPTURE_RACE");
    }
  } catch (error) {
    if (error instanceof WorkbenchError) throw error;
    throw new WorkbenchError("PENDING_ROOT_UNSAFE");
  }

  if (first.kind === "absent") {
    const withoutDigest = {
      format: MEMORY_PENDING_LIST_FORMAT,
      project_id: projectId,
      source_shared_snapshot_sha256: shared,
      pending_set_sha256: memoryPendingSetDigest([]),
      count: 0,
      candidates: [],
    };
    return deepFreeze({
      ...withoutDigest,
      list_sha256: memoryPendingListDigest(withoutDigest),
    });
  }

  const captures = [...first.captures].sort((left, right) => (
    comparePortable(left.portable, right.portable)
  ));
  const candidates = captures.map((capture) => (
    parseCandidate(capture, projectId, knownWorks, knownCheckpoints)
  ));

  const setEntries = captures.map((item) => ({
    path: item.portable,
    sha256: item.sha256,
  }));
  const withoutDigest = {
    format: MEMORY_PENDING_LIST_FORMAT,
    project_id: projectId,
    source_shared_snapshot_sha256: shared,
    pending_set_sha256: memoryPendingSetDigest(setEntries),
    count: candidates.length,
    candidates,
  };
  return deepFreeze({
    ...withoutDigest,
    list_sha256: memoryPendingListDigest(withoutDigest),
  });
}
