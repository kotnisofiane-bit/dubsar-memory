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
import { safeDisplayText } from "./display-safety.mjs";
import {
  assertMemoryCheckpoints,
  assertMemoryLocalState,
  assertMemoryManifest,
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

export const MEMORY_BOOTSTRAP_PROPOSAL_FORMAT = "dubsar.memory-bootstrap-proposal/1";
export const MEMORY_BOOTSTRAP_PREVIEW_FORMAT = "dubsar.memory-bootstrap-preview/1";
export const MEMORY_BOOTSTRAP_APPLY_FORMAT = "dubsar.memory-bootstrap-apply/1";

const SHA256 = /^[0-9a-f]{64}$/u;
const SAFE_ID = /^[a-z0-9][a-z0-9._-]{2,127}$/iu;
const MAX_PROPOSAL_BYTES = 128 * 1024;
const GITIGNORE = [
  "inbox/*",
  "!inbox/.gitkeep",
  "generated/*",
  "!generated/.gitkeep",
  "local.json",
  "",
].join("\n");
const EMPTY = Buffer.alloc(0);

function fail(code = "MEMORY_BOOTSTRAP_PROPOSAL_INVALID") {
  throw new WorkbenchError(code);
}

function parseJson(content, code = "MEMORY_BOOTSTRAP_PROPOSAL_INVALID") {
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

async function captureCheckpointReferences(projectRoot, claimed) {
  if (!Array.isArray(claimed) || claimed.length > 8) fail();
  const references = [];
  for (const item of claimed) {
    if (!exactKeys(item, ["path", "sha256"]) || !SHA256.test(item.sha256 ?? "")) fail();
    const relative = normalizeRelativePath(item.path);
    if (relative.startsWith(".dubsar/")) throw new WorkbenchError("MEMORY_REFERENCE_UNSAFE");
    const captured = await captureRegularFile(projectRoot, relative, 25 * 1024 * 1024);
    if (
      captured.sha256 !== item.sha256 ||
      artifactPolicyFinding(relative, captured.content) !== null
    ) throw new WorkbenchError("MEMORY_REFERENCE_INVALID");
    references.push({ path: relative, sha256: captured.sha256 });
  }
  return references;
}

function assertCheckpointAuthoring(value) {
  if (!exactKeys(value, [
    "attempt", "checkpoint_id", "kind", "limitations", "references", "resolves",
    "resulting_state", "summary", "validation", "work_id",
  ])) fail();
  if (value.resolves !== null) fail();
  return value;
}

async function assertProposal(value, projectRoot) {
  if (!exactKeys(value, [
    "checkpoint", "format", "project_id", "selected_work_id", "title", "work", "work_body",
  ]) || value.format !== MEMORY_BOOTSTRAP_PROPOSAL_FORMAT) fail();
  if (typeof value.project_id !== "string" || !SAFE_ID.test(value.project_id)) fail();
  const manifest = assertMemoryManifest({
    format: "dubsar.memory-project/1",
    project_id: value.project_id,
    title: value.title,
    legacy_snapshot_sha256: null,
  });
  const work = assertMemoryWork(value.work);
  const workBody = safeBody(value.work_body);
  const selectedWorkId = assertId(value.selected_work_id);
  const authored = assertCheckpointAuthoring(value.checkpoint);
  if (
    selectedWorkId !== work.work_id ||
    authored.work_id !== work.work_id
  ) throw new WorkbenchError("MEMORY_BOOTSTRAP_SELECTION_MISMATCH");
  if (work.knowledge_ids.length > 0) throw new WorkbenchError("MEMORY_KNOWLEDGE_NOT_FOUND");
  const references = await captureCheckpointReferences(projectRoot, authored.references);
  return {
    format: MEMORY_BOOTSTRAP_PROPOSAL_FORMAT,
    project_id: manifest.project_id,
    title: manifest.title,
    work,
    work_body: workBody,
    selected_work_id: selectedWorkId,
    checkpoint: {
      ...authored,
      work_id: work.work_id,
      references,
    },
  };
}

async function loadProposal({ projectRoot, proposalPath, proposal }) {
  const fromPath = typeof proposalPath === "string" && proposalPath.length > 0;
  const fromValue = proposal !== undefined;
  if (fromPath === fromValue) throw new WorkbenchError("MEMORY_BOOTSTRAP_PROPOSAL_REQUIRED");
  if (fromValue) return assertProposal(proposal, projectRoot);
  const absolute = path.resolve(proposalPath);
  if (isInsideOrEqual(projectRoot, absolute)) {
    throw new WorkbenchError("MEMORY_BOOTSTRAP_PROPOSAL_LOCATION_INVALID");
  }
  const captured = await captureRegularFile(
    path.dirname(absolute),
    path.basename(absolute),
    MAX_PROPOSAL_BYTES,
  );
  return assertProposal(parseJson(captured.content), projectRoot);
}

function bootstrapFiles(normalized) {
  const manifest = assertMemoryManifest({
    format: "dubsar.memory-project/1",
    project_id: normalized.project_id,
    title: normalized.title,
    legacy_snapshot_sha256: null,
  });
  const withoutDigest = {
    ...normalized.checkpoint,
    index: 0,
    previous_checkpoint_sha256: null,
  };
  const entry = {
    ...withoutDigest,
    checkpoint_sha256: memoryCheckpointDigest(withoutDigest),
  };
  const checkpoints = assertMemoryCheckpoints({
    format: "dubsar.continuity-checkpoints/2",
    project_id: normalized.project_id,
    entries: [entry],
  }, normalized.project_id);
  const local = assertMemoryLocalState({
    format: "dubsar.local-state/1",
    project_id: normalized.project_id,
    selected_work_id: normalized.selected_work_id,
  }, normalized.project_id);
  const workBytes = Buffer.from(serializeMemoryMarkdown({
    frontmatter: normalized.work,
    body: normalized.work_body,
  }), "utf8");
  return new Map([
    ["manifest.json", Buffer.from(stableJson(manifest), "utf8")],
    ["checkpoints.json", Buffer.from(stableJson(checkpoints), "utf8")],
    ["local.json", Buffer.from(stableJson(local), "utf8")],
    [".gitignore", Buffer.from(GITIGNORE, "utf8")],
    [`work/${normalized.work.work_id}.md`, workBytes],
    ["work/.gitkeep", EMPTY],
    ["knowledge/.gitkeep", EMPTY],
    ["inbox/.gitkeep", EMPTY],
    ["generated/.gitkeep", EMPTY],
  ]);
}

function digestFiles(files) {
  return Object.fromEntries([...files].map(([name, bytes]) => [name, sha256Bytes(bytes)]));
}

function validatePublishedDocuments(files, normalized) {
  const manifest = assertMemoryManifest(parseJson(files.get("manifest.json")));
  const local = assertMemoryLocalState(parseJson(files.get("local.json")), normalized.project_id);
  const checkpoints = assertMemoryCheckpoints(
    parseJson(files.get("checkpoints.json")),
    normalized.project_id,
  );
  const workPath = `work/${normalized.work.work_id}.md`;
  const workSource = new TextDecoder("utf-8", { fatal: true }).decode(files.get(workPath));
  const parsed = parseMemoryMarkdown(workSource);
  const work = assertMemoryWork(parsed.frontmatter);
  if (manifest.project_id !== normalized.project_id) fail("MEMORY_BOOTSTRAP_STAGED_INVALID");
  if (local.selected_work_id !== normalized.selected_work_id) {
    fail("MEMORY_BOOTSTRAP_STAGED_INVALID");
  }
  if (work.work_id !== normalized.work.work_id) fail("MEMORY_BOOTSTRAP_STAGED_INVALID");
  if (checkpoints.entries.length !== 1) fail("MEMORY_BOOTSTRAP_STAGED_INVALID");
  const [entry] = checkpoints.entries;
  if (
    entry.index !== 0 ||
    entry.previous_checkpoint_sha256 !== null ||
    entry.work_id !== normalized.work.work_id ||
    entry.checkpoint_id !== normalized.checkpoint.checkpoint_id
  ) fail("MEMORY_BOOTSTRAP_STAGED_INVALID");
  return { manifest, local, work, checkpoints, entry };
}

async function buildBootstrap({ start, proposalPath, proposal }) {
  const projectRoot = await openDirectory(start ?? process.cwd());
  const marker = path.join(projectRoot, ".dubsar");
  if (await entryInfo(marker)) throw new WorkbenchError("WORKSPACE_ALREADY_EXISTS");
  if (await entryInfo(path.join(projectRoot, ".dubsar-project"))) {
    throw new WorkbenchError("MEMORY_MIGRATION_REQUIRED");
  }
  const normalized = await loadProposal({ projectRoot, proposalPath, proposal });
  const files = bootstrapFiles(normalized);
  validatePublishedDocuments(files, normalized);
  const fileSha256 = digestFiles(files);
  const proposalSha256 = sha256Bytes(Buffer.from(stableJson(normalized), "utf8"));
  const base = {
    operation: "bootstrap_memory_vnext",
    target: ".dubsar",
    project_id: normalized.project_id,
    work_id: normalized.work.work_id,
    checkpoint_id: normalized.checkpoint.checkpoint_id,
    file_sha256: fileSha256,
    proposal_sha256: proposalSha256,
  };
  return {
    projectRoot,
    marker,
    files,
    normalized,
    preview: {
      format: MEMORY_BOOTSTRAP_PREVIEW_FORMAT,
      status: "preview",
      ...base,
      change_sha256: sha256Bytes(Buffer.from(stableJson(base), "utf8")),
      summary: "Create project memory with one Active work and one First recorded checkpoint.",
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

export async function previewMemoryBootstrap(options) {
  return (await buildBootstrap(options)).preview;
}

export async function applyMemoryBootstrap({ expectedChange, ...options }) {
  const change = await buildBootstrap(options);
  if (!SHA256.test(expectedChange ?? "") || expectedChange !== change.preview.change_sha256) {
    throw new WorkbenchError("MEMORY_BOOTSTRAP_CONFIRMATION_MISMATCH");
  }
  const lockPath = path.join(change.projectRoot, ".dubsar-memory-init.lock");
  const staging = path.join(change.projectRoot, `.dubsar-memory-bootstrap-${randomBytes(12).toString("hex")}`);
  let lockHandle;
  let ownsLock = false;
  let published = false;
  try {
    try {
      lockHandle = await open(lockPath, "wx", 0o600);
      ownsLock = true;
    } catch {
      throw new WorkbenchError("MEMORY_BOOTSTRAP_LOCKED");
    }
    if (await entryInfo(change.marker) || await entryInfo(path.join(change.projectRoot, ".dubsar-project"))) {
      throw new WorkbenchError("MEMORY_BOOTSTRAP_CONCURRENT");
    }
    await mkdir(staging, { recursive: false, mode: 0o700 });
    for (const name of ["work", "knowledge", "inbox", "generated"]) {
      await mkdir(path.join(staging, name), { recursive: false, mode: 0o700 });
    }
    for (const [name, bytes] of change.files) await writeStagedFile(staging, name, bytes);
    for (const [name, expected] of Object.entries(change.preview.file_sha256)) {
      const captured = await captureRegularFile(staging, name, 1024 * 1024);
      if (captured.sha256 !== expected) throw new WorkbenchError("MEMORY_BOOTSTRAP_STAGING_MISMATCH");
    }
    const stagedFiles = new Map();
    for (const [name] of change.files) {
      const captured = await captureRegularFile(staging, name, 1024 * 1024);
      stagedFiles.set(name, captured.content);
    }
    validatePublishedDocuments(stagedFiles, change.normalized);
    if (await entryInfo(change.marker) || await entryInfo(path.join(change.projectRoot, ".dubsar-project"))) {
      throw new WorkbenchError("MEMORY_BOOTSTRAP_CONCURRENT");
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
    if (
      snapshot.documents.manifest.project_id !== change.preview.project_id ||
      snapshot.documents.local.selected_work_id !== change.normalized.selected_work_id ||
      snapshot.documents.checkpoints.entries.length !== 1 ||
      snapshot.documents.checkpoints.entries[0].checkpoint_id !== change.preview.checkpoint_id ||
      !snapshot.documents.works.some((item) => item.work_id === change.preview.work_id)
    ) {
      throw new WorkbenchError("MEMORY_BOOTSTRAP_PUBLICATION_MISMATCH");
    }
    return {
      format: MEMORY_BOOTSTRAP_APPLY_FORMAT,
      status: "applied",
      operation: change.preview.operation,
      target: change.preview.target,
      change_sha256: change.preview.change_sha256,
      snapshot_sha256: snapshot.snapshot_sha256,
      work_id: change.preview.work_id,
      checkpoint_id: change.preview.checkpoint_id,
    };
  } finally {
    if (!published) await removeStaging(staging, change.files);
    await lockHandle?.close();
    if (ownsLock) await unlink(lockPath).catch(() => {});
  }
}
