import { randomBytes } from "node:crypto";
import { mkdir, open, rename, rmdir, unlink } from "node:fs/promises";
import path from "node:path";

import {
  WorkbenchError,
  exactKeys,
  resolveLimits,
  sha256Bytes,
  stableJson,
} from "./contracts.mjs";
import {
  assertMemoryCheckpoints,
  assertMemoryLocalState,
  assertMemoryManifest,
} from "./memory-vnext-contracts.mjs";
import { snapshotMemoryWorkspace } from "./memory-vnext-snapshot.mjs";
import { entryInfo, isInsideOrEqual, openDirectory } from "./path-safety.mjs";
import { captureRegularFile } from "./safe-capture.mjs";

export const MEMORY_INIT_PROPOSAL_FORMAT = "dubsar.memory-init-proposal/1";
export const MEMORY_INIT_PREVIEW_FORMAT = "dubsar.memory-init-preview/1";
export const MEMORY_INIT_APPLY_FORMAT = "dubsar.memory-init-apply/1";

const SHA256 = /^[0-9a-f]{64}$/u;
const SAFE_ID = /^[a-z0-9][a-z0-9._-]{2,127}$/iu;
const MAX_PROPOSAL_BYTES = 64 * 1024;
const GITIGNORE = [
  "inbox/*",
  "!inbox/.gitkeep",
  "generated/*",
  "!generated/.gitkeep",
  "local.json",
  "",
].join("\n");
const EMPTY = Buffer.alloc(0);

function parseJson(content) {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(content));
  } catch {
    throw new WorkbenchError("MEMORY_INIT_PROPOSAL_INVALID");
  }
}

function assertProposal(value) {
  if (
    !exactKeys(value, ["format", "project_id", "title"]) ||
    value.format !== MEMORY_INIT_PROPOSAL_FORMAT ||
    typeof value.project_id !== "string" || !SAFE_ID.test(value.project_id)
  ) throw new WorkbenchError("MEMORY_INIT_PROPOSAL_INVALID");
  const manifest = assertMemoryManifest({
    format: "dubsar.memory-project/1",
    project_id: value.project_id,
    title: value.title,
    legacy_snapshot_sha256: null,
  });
  return { ...value, project_id: manifest.project_id, title: manifest.title };
}

async function loadProposal({ projectRoot, proposalPath, proposal }) {
  const fromPath = typeof proposalPath === "string" && proposalPath.length > 0;
  const fromValue = proposal !== undefined;
  if (fromPath === fromValue) throw new WorkbenchError("MEMORY_INIT_PROPOSAL_REQUIRED");
  if (fromValue) return assertProposal(proposal);
  const absolute = path.resolve(proposalPath);
  if (isInsideOrEqual(projectRoot, absolute)) {
    throw new WorkbenchError("MEMORY_INIT_PROPOSAL_LOCATION_INVALID");
  }
  const captured = await captureRegularFile(
    path.dirname(absolute),
    path.basename(absolute),
    MAX_PROPOSAL_BYTES,
  );
  return assertProposal(parseJson(captured.content));
}

function initializationFiles(proposal) {
  const manifest = assertMemoryManifest({
    format: "dubsar.memory-project/1",
    project_id: proposal.project_id,
    title: proposal.title,
    legacy_snapshot_sha256: null,
  });
  const checkpoints = assertMemoryCheckpoints({
    format: "dubsar.continuity-checkpoints/2",
    project_id: proposal.project_id,
    entries: [],
  }, proposal.project_id);
  const local = assertMemoryLocalState({
    format: "dubsar.local-state/1",
    project_id: proposal.project_id,
    selected_work_id: null,
  }, proposal.project_id);
  return new Map([
    ["manifest.json", Buffer.from(stableJson(manifest), "utf8")],
    ["checkpoints.json", Buffer.from(stableJson(checkpoints), "utf8")],
    ["local.json", Buffer.from(stableJson(local), "utf8")],
    [".gitignore", Buffer.from(GITIGNORE, "utf8")],
    ["work/.gitkeep", EMPTY],
    ["knowledge/.gitkeep", EMPTY],
    ["inbox/.gitkeep", EMPTY],
    ["generated/.gitkeep", EMPTY],
  ]);
}

function digestFiles(files) {
  return Object.fromEntries([...files].map(([name, bytes]) => [name, sha256Bytes(bytes)]));
}

async function buildInitialization({ start, proposalPath, proposal }) {
  const projectRoot = await openDirectory(start ?? process.cwd());
  const marker = path.join(projectRoot, ".dubsar");
  if (await entryInfo(marker)) throw new WorkbenchError("WORKSPACE_ALREADY_EXISTS");
  if (await entryInfo(path.join(projectRoot, ".dubsar-project"))) {
    throw new WorkbenchError("MEMORY_MIGRATION_REQUIRED");
  }
  const normalized = await loadProposal({ projectRoot, proposalPath, proposal });
  const files = initializationFiles(normalized);
  const fileSha256 = digestFiles(files);
  const base = {
    operation: "initialize_memory_vnext",
    target: ".dubsar",
    project_id: normalized.project_id,
    file_sha256: fileSha256,
  };
  return {
    projectRoot,
    marker,
    files,
    preview: {
      format: MEMORY_INIT_PREVIEW_FORMAT,
      status: "preview",
      ...base,
      change_sha256: sha256Bytes(Buffer.from(stableJson(base), "utf8")),
      summary: "A new DUBSAR project-memory workspace will be created.",
      consequence: "The .dubsar directory is published atomically; source files and personal memory are unchanged.",
    },
  };
}

async function writeStagedFile(staging, relativePath, bytes) {
  const target = path.join(staging, ...relativePath.split("/"));
  let handle;
  try {
    handle = await open(target, "wx", 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle?.close();
  }
}

async function removeStaging(staging, files) {
  for (const name of files.keys()) {
    await unlink(path.join(staging, ...name.split("/"))).catch(() => {});
  }
  for (const name of ["work", "knowledge", "inbox", "generated"]) {
    await rmdir(path.join(staging, name)).catch(() => {});
  }
  await rmdir(staging).catch(() => {});
}

export async function previewMemoryInitialization(options) {
  return (await buildInitialization(options)).preview;
}

export async function applyMemoryInitialization({ expectedChange, ...options }) {
  const change = await buildInitialization(options);
  if (!SHA256.test(expectedChange ?? "") || expectedChange !== change.preview.change_sha256) {
    throw new WorkbenchError("MEMORY_INIT_CONFIRMATION_MISMATCH");
  }
  const lockPath = path.join(change.projectRoot, ".dubsar-memory-init.lock");
  const staging = path.join(change.projectRoot, `.dubsar-memory-init-${randomBytes(12).toString("hex")}`);
  let lockHandle;
  let ownsLock = false;
  let published = false;
  try {
    try {
      lockHandle = await open(lockPath, "wx", 0o600);
      ownsLock = true;
    } catch {
      throw new WorkbenchError("MEMORY_INIT_LOCKED");
    }
    if (await entryInfo(change.marker) || await entryInfo(path.join(change.projectRoot, ".dubsar-project"))) {
      throw new WorkbenchError("MEMORY_INIT_CONCURRENT");
    }
    await mkdir(staging, { recursive: false, mode: 0o700 });
    for (const name of ["work", "knowledge", "inbox", "generated"]) {
      await mkdir(path.join(staging, name), { recursive: false, mode: 0o700 });
    }
    for (const [name, bytes] of change.files) await writeStagedFile(staging, name, bytes);
    for (const [name, expected] of Object.entries(change.preview.file_sha256)) {
      const captured = await captureRegularFile(staging, name, 1024 * 1024);
      if (captured.sha256 !== expected) throw new WorkbenchError("MEMORY_INIT_STAGING_MISMATCH");
    }
    if (await entryInfo(change.marker) || await entryInfo(path.join(change.projectRoot, ".dubsar-project"))) {
      throw new WorkbenchError("MEMORY_INIT_CONCURRENT");
    }
    await rename(staging, change.marker);
    published = true;
    const snapshot = await snapshotMemoryWorkspace({
      domain: "project",
      marker: ".dubsar",
      root: change.marker,
      project_root: change.projectRoot,
      legacy_root: null,
      has_legacy_sibling: false,
      distance: 0,
    }, resolveLimits());
    if (snapshot.documents.manifest.project_id !== change.preview.project_id) {
      throw new WorkbenchError("MEMORY_INIT_PUBLICATION_MISMATCH");
    }
    return {
      format: MEMORY_INIT_APPLY_FORMAT,
      status: "applied",
      operation: change.preview.operation,
      target: change.preview.target,
      change_sha256: change.preview.change_sha256,
      snapshot_sha256: snapshot.snapshot_sha256,
    };
  } finally {
    if (!published) await removeStaging(staging, change.files);
    await lockHandle?.close();
    if (ownsLock) await unlink(lockPath).catch(() => {});
  }
}
