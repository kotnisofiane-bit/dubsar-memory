import { randomBytes } from "node:crypto";
import { mkdir, open, rename, rmdir, unlink } from "node:fs/promises";
import path from "node:path";

import {
  WorkbenchError,
  resolveLimits,
  sha256Bytes,
  stableJson,
} from "./contracts.mjs";
import {
  LEGACY_PROJECT_MARKER,
  MEMORY_PROJECT_MARKER,
  locateProjectWorkspace,
} from "./locate.mjs";
import {
  assertMemoryCheckpoints,
  assertMemoryLocalState,
  assertMemoryManifest,
  assertMemoryWork,
} from "./memory-vnext-contracts.mjs";
import { serializeMemoryMarkdown } from "./memory-vnext-markdown.mjs";
import { snapshotMemoryWorkspace } from "./memory-vnext-snapshot.mjs";
import { detectWorkspaceMode, snapshotLiteWorkspace } from "./lite.mjs";
import { entryInfo } from "./path-safety.mjs";
import { captureRegularFile } from "./safe-capture.mjs";

export const MEMORY_MIGRATION_PREVIEW_FORMAT = "dubsar.memory-migration-preview/1";
export const MEMORY_MIGRATION_APPLY_FORMAT = "dubsar.memory-migration-apply/1";

const SHA256 = /^[0-9a-f]{64}$/u;
const GITIGNORE = [
  "inbox/*",
  "!inbox/.gitkeep",
  "generated/*",
  "!generated/.gitkeep",
  "local.json",
  "",
].join("\n");
const EMPTY = Buffer.alloc(0);

function migrationWorkId(projectId) {
  return `work-${sha256Bytes(Buffer.from(projectId, "utf8")).slice(0, 20)}`;
}

function currentLiteState(snapshot) {
  return snapshot.documents["checkpoints.json"].entries.at(-1)?.resulting_state ??
    snapshot.documents["state.json"].initial_state;
}

function migratedStatus(status) {
  if (status === "active") return "open";
  if (status === "paused") return "paused";
  if (status === "complete") return "complete";
  throw new WorkbenchError("MEMORY_MIGRATION_STATE_UNSUPPORTED");
}

function migrateCheckpoints(source, projectId, workId) {
  let previous = null;
  const entries = source.entries.map((entry) => {
    const attempt = entry.kind === "attempt" ? {
      action_id: `legacy-${sha256Bytes(Buffer.from(entry.summary, "utf8")).slice(0, 20)}`,
      gate_id: "legacy-migration",
      failure_fingerprint: sha256Bytes(Buffer.from(stableJson(entry.resulting_state), "utf8")),
    } : null;
    const base = {
      checkpoint_id: entry.checkpoint_id,
      index: entry.index,
      kind: entry.kind,
      limitations: entry.limitations,
      previous_checkpoint_sha256: previous,
      references: entry.references,
      resolves: entry.resolves,
      resulting_state: entry.resulting_state,
      summary: entry.summary,
      validation: entry.validation,
      work_id: workId,
      attempt,
    };
    const migrated = {
      ...base,
      checkpoint_sha256: sha256Bytes(Buffer.from(stableJson(base), "utf8")),
    };
    previous = migrated.checkpoint_sha256;
    return migrated;
  });
  return assertMemoryCheckpoints({
    format: "dubsar.continuity-checkpoints/2",
    project_id: projectId,
    entries,
  }, projectId);
}

function migrationFiles(snapshot) {
  const state = snapshot.documents["state.json"];
  const sourceCheckpoints = snapshot.documents["checkpoints.json"];
  const current = currentLiteState(snapshot);
  const workId = migrationWorkId(state.project_id);
  const references = [...new Set(sourceCheckpoints.entries.flatMap(
    (entry) => entry.references.map((reference) => reference.path),
  ))].sort();
  const manifest = assertMemoryManifest({
    format: "dubsar.memory-project/1",
    project_id: state.project_id,
    title: state.title,
    legacy_snapshot_sha256: snapshot.snapshot_sha256,
  });
  const work = assertMemoryWork({
    format: "dubsar.work/1",
    work_id: workId,
    title: state.title,
    status: migratedStatus(current.status),
    scope: "multi_session",
    objective: state.mission,
    acceptance_criteria: [],
    knowledge_ids: [],
    references,
  });
  const checkpoints = migrateCheckpoints(sourceCheckpoints, state.project_id, workId);
  const local = assertMemoryLocalState({
    format: "dubsar.local-state/1",
    project_id: state.project_id,
    selected_work_id: work.status === "complete" ? null : workId,
  }, state.project_id);
  const body = `# ${work.title}\n\nMigrated from the retained Continuity Lite workspace.\n`;
  return {
    workId,
    files: new Map([
      ["manifest.json", Buffer.from(stableJson(manifest), "utf8")],
      ["checkpoints.json", Buffer.from(stableJson(checkpoints), "utf8")],
      ["local.json", Buffer.from(stableJson(local), "utf8")],
      [".gitignore", Buffer.from(GITIGNORE, "utf8")],
      [`work/${workId}.md`, Buffer.from(serializeMemoryMarkdown({ frontmatter: work, body }), "utf8")],
      ["work/.gitkeep", EMPTY],
      ["knowledge/.gitkeep", EMPTY],
      ["inbox/.gitkeep", EMPTY],
      ["generated/.gitkeep", EMPTY],
    ]),
  };
}

async function captureLegacy(start) {
  const location = await locateProjectWorkspace({ start });
  if (location.marker !== LEGACY_PROJECT_MARKER || location.has_legacy_sibling) {
    throw new WorkbenchError("MEMORY_MIGRATION_SOURCE_REQUIRED");
  }
  if (await detectWorkspaceMode(location.root) !== "lite") {
    throw new WorkbenchError("MEMORY_MIGRATION_SOURCE_UNSUPPORTED");
  }
  const snapshot = await snapshotLiteWorkspace(location, resolveLimits());
  return { location, snapshot };
}

async function buildMigration({ start }) {
  const { location, snapshot } = await captureLegacy(start);
  const projectRoot = location.project_root ?? path.dirname(location.root);
  const marker = path.join(projectRoot, MEMORY_PROJECT_MARKER);
  if (await entryInfo(marker)) throw new WorkbenchError("WORKSPACE_ALREADY_EXISTS");
  const { workId, files } = migrationFiles(snapshot);
  const fileSha256 = Object.fromEntries([...files].map(
    ([name, bytes]) => [name, sha256Bytes(bytes)],
  ));
  const base = {
    operation: "migrate_lite_to_memory_vnext",
    target: MEMORY_PROJECT_MARKER,
    project_id: snapshot.documents["state.json"].project_id,
    work_id: workId,
    legacy_snapshot_sha256: snapshot.snapshot_sha256,
    file_sha256: fileSha256,
  };
  return {
    sourceLocation: location,
    sourceSnapshot: snapshot,
    projectRoot,
    marker,
    files,
    preview: {
      format: MEMORY_MIGRATION_PREVIEW_FORMAT,
      status: "preview",
      ...base,
      change_sha256: sha256Bytes(Buffer.from(stableJson(base), "utf8")),
      summary: "The Continuity Lite snapshot will be projected into a new .dubsar workspace.",
      consequence: "The existing .dubsar-project directory is retained unchanged and bound by digest in manifest.json.",
    },
  };
}

async function writeFileExclusive(staging, relativePath, bytes) {
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

async function cleanStaging(staging, files) {
  for (const name of files.keys()) {
    await unlink(path.join(staging, ...name.split("/"))).catch(() => {});
  }
  for (const name of ["work", "knowledge", "inbox", "generated"]) {
    await rmdir(path.join(staging, name)).catch(() => {});
  }
  await rmdir(staging).catch(() => {});
}

export async function previewMemoryMigration(options) {
  return (await buildMigration(options)).preview;
}

export async function applyMemoryMigration({ expectedChange, ...options }) {
  const change = await buildMigration(options);
  if (!SHA256.test(expectedChange ?? "") || expectedChange !== change.preview.change_sha256) {
    throw new WorkbenchError("MEMORY_MIGRATION_CONFIRMATION_MISMATCH");
  }
  const lockPath = path.join(change.projectRoot, ".dubsar-memory-migrate.lock");
  const staging = path.join(change.projectRoot, `.dubsar-memory-migrate-${randomBytes(12).toString("hex")}`);
  let lockHandle;
  let ownsLock = false;
  let published = false;
  try {
    try {
      lockHandle = await open(lockPath, "wx", 0o600);
      ownsLock = true;
    } catch {
      throw new WorkbenchError("MEMORY_MIGRATION_LOCKED");
    }
    const live = await snapshotLiteWorkspace(change.sourceLocation, resolveLimits());
    if (live.snapshot_sha256 !== change.preview.legacy_snapshot_sha256 || await entryInfo(change.marker)) {
      throw new WorkbenchError("MEMORY_MIGRATION_CONCURRENT");
    }
    await mkdir(staging, { recursive: false, mode: 0o700 });
    for (const name of ["work", "knowledge", "inbox", "generated"]) {
      await mkdir(path.join(staging, name), { recursive: false, mode: 0o700 });
    }
    for (const [name, bytes] of change.files) await writeFileExclusive(staging, name, bytes);
    for (const [name, expected] of Object.entries(change.preview.file_sha256)) {
      const captured = await captureRegularFile(staging, name, 1024 * 1024);
      if (captured.sha256 !== expected) throw new WorkbenchError("MEMORY_MIGRATION_STAGING_MISMATCH");
    }
    const revalidated = await snapshotLiteWorkspace(change.sourceLocation, resolveLimits());
    if (revalidated.snapshot_sha256 !== change.preview.legacy_snapshot_sha256 || await entryInfo(change.marker)) {
      throw new WorkbenchError("MEMORY_MIGRATION_CONCURRENT");
    }
    await rename(staging, change.marker);
    published = true;
    const memoryLocation = {
      domain: "project",
      marker: MEMORY_PROJECT_MARKER,
      root: change.marker,
      project_root: change.projectRoot,
      legacy_root: change.sourceLocation.root,
      has_legacy_sibling: true,
      distance: 0,
    };
    const memorySnapshot = await snapshotMemoryWorkspace(memoryLocation, resolveLimits());
    const legacyAfter = await snapshotLiteWorkspace(change.sourceLocation, resolveLimits());
    const manifest = memorySnapshot.documents.manifest;
    if (
      manifest.legacy_snapshot_sha256 !== legacyAfter.snapshot_sha256 ||
      legacyAfter.snapshot_sha256 !== change.preview.legacy_snapshot_sha256
    ) throw new WorkbenchError("MEMORY_MIGRATION_PUBLICATION_MISMATCH");
    return {
      format: MEMORY_MIGRATION_APPLY_FORMAT,
      status: "applied",
      operation: change.preview.operation,
      target: change.preview.target,
      change_sha256: change.preview.change_sha256,
      legacy_snapshot_sha256: legacyAfter.snapshot_sha256,
      snapshot_sha256: memorySnapshot.snapshot_sha256,
    };
  } finally {
    if (!published) await cleanStaging(staging, change.files);
    await lockHandle?.close();
    if (ownsLock) await unlink(lockPath).catch(() => {});
  }
}
