import path from "node:path";
import { opendir } from "node:fs/promises";

import {
  WorkbenchError,
  comparePortable,
  deepFreeze,
  resolveLimits,
  rootDigest,
} from "./contracts.mjs";
import { captureRegularFile } from "./safe-capture.mjs";
import { entryInfo } from "./path-safety.mjs";
import {
  MEMORY_MAX_KNOWLEDGE_ITEMS,
  MEMORY_MAX_WORK_ITEMS,
  assertMemoryCheckpoints,
  assertMemoryKnowledge,
  assertMemoryLocalState,
  assertMemoryManifest,
  assertMemoryWork,
} from "./memory-vnext-contracts.mjs";
import { parseMemoryMarkdown } from "./memory-vnext-markdown.mjs";
import { snapshotLiteWorkspace } from "./lite.mjs";

const decoder = new TextDecoder("utf-8", { fatal: true });
const REQUIRED_DIRECTORIES = ["knowledge", "work"];
const OPTIONAL_DIRECTORIES = new Set(["generated", "inbox"]);
const ROOT_FILES = new Set([".gitignore", "checkpoints.json", "local.json", "manifest.json"]);
const TRANSIENT = /^\.dubsar-memory-[0-9a-f]{24}\.tmp$/u;

function fail(code = "MEMORY_WORKSPACE_INVALID") {
  throw new WorkbenchError(code);
}

function assertLocation(location) {
  if (
    location?.domain !== "project" ||
    location?.marker !== ".dubsar" ||
    typeof location.root !== "string"
  ) fail("LOCATION_INVALID");
}

function parseJson(captured, code) {
  try {
    return JSON.parse(decoder.decode(captured.content));
  } catch (error) {
    if (error instanceof TypeError) throw new WorkbenchError("INVALID_UTF8");
    throw new WorkbenchError(code);
  }
}

async function inspectRoot(root) {
  const names = [];
  let directory;
  try {
    directory = await opendir(root);
    for await (const entry of directory) {
      if (ROOT_FILES.has(entry.name)) {
        if (!entry.isFile() || entry.isSymbolicLink()) fail();
        names.push(entry.name);
        continue;
      }
      if (REQUIRED_DIRECTORIES.includes(entry.name) || OPTIONAL_DIRECTORIES.has(entry.name)) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) fail();
        names.push(entry.name);
        continue;
      }
      if (entry.name === ".dubsar-memory.lock" || TRANSIENT.test(entry.name)) {
        if (!entry.isFile() || entry.isSymbolicLink()) fail();
        continue;
      }
      fail();
    }
  } catch (error) {
    if (error instanceof WorkbenchError) throw error;
    fail("PATH_INSPECTION_FAILED");
  } finally {
    await directory?.close().catch(() => {});
  }
  return names.sort(comparePortable);
}

function decodeMarkdown(content) {
  try {
    return parseMemoryMarkdown(decoder.decode(content));
  } catch (error) {
    if (error instanceof TypeError) throw new WorkbenchError("INVALID_UTF8");
    throw error;
  }
}

async function markdownNames(root, directoryName, maximum) {
  const target = path.join(root, directoryName);
  const info = await entryInfo(target);
  if (!info?.isDirectory() || info.isSymbolicLink()) fail();
  const names = [];
  let directory;
  try {
    directory = await opendir(target);
    for await (const entry of directory) {
      if (entry.name === ".gitkeep" && entry.isFile() && !entry.isSymbolicLink()) continue;
      if (TRANSIENT.test(entry.name)) continue;
      if (!entry.isFile() || entry.isSymbolicLink() || !/^[a-z0-9][a-z0-9._-]{2,127}\.md$/iu.test(entry.name)) {
        fail();
      }
      names.push(entry.name);
      if (names.length > maximum) fail("MEMORY_ITEM_LIMIT_EXCEEDED");
    }
  } catch (error) {
    if (error instanceof WorkbenchError) throw error;
    fail("PATH_INSPECTION_FAILED");
  } finally {
    await directory?.close().catch(() => {});
  }
  return names.sort(comparePortable);
}

async function recaptureAll(root, captures, maxBytes) {
  for (const expected of captures) {
    const observed = await captureRegularFile(root, expected.path, maxBytes);
    if (
      observed.identity !== expected.identity ||
      observed.size !== expected.size ||
      observed.sha256 !== expected.sha256
    ) throw new WorkbenchError("SNAPSHOT_CAPTURE_RACE");
  }
}

/**
 * Re-read the canonical workspace and require it to still digest to
 * `expectedSnapshotSha256`. Used after reading files outside `.dubsar/`, so a
 * capsule can never mix freshness observed against one snapshot with
 * checkpoints read from another. Any divergence, or any failure to re-read, is
 * reported as SNAPSHOT_CAPTURE_RACE.
 */
export async function revalidateMemorySnapshot(location, limits, expectedSnapshotSha256) {
  let after;
  try {
    after = await snapshotMemoryWorkspace(location, limits);
  } catch {
    throw new WorkbenchError("SNAPSHOT_CAPTURE_RACE");
  }
  if (after.snapshot_sha256 !== expectedSnapshotSha256) {
    throw new WorkbenchError("SNAPSHOT_CAPTURE_RACE");
  }
  return after;
}

export async function snapshotMemoryWorkspace(location, overrides = {}, seams = {}) {
  assertLocation(location);
  const limits = resolveLimits(overrides);
  const rootNames = await inspectRoot(location.root);

  const captures = [];
  const identities = new Set();
  let totalBytes = 0;
  const capture = async (relative, kind) => {
    const item = await captureRegularFile(location.root, relative, limits.maxCanonicalFileBytes);
    if (identities.has(item.identity)) fail("FILE_IDENTITY_DUPLICATE");
    identities.add(item.identity);
    captures.push(item);
    totalBytes += item.size;
    if (totalBytes > limits.maxSnapshotBytes) fail("SNAPSHOT_SIZE_LIMIT_EXCEEDED");
    return {
      captured: item,
      file: { path: item.path, size: item.size, sha256: item.sha256, kind },
    };
  };

  const manifestCapture = await capture("manifest.json", "canonical");
  const manifest = assertMemoryManifest(parseJson(manifestCapture.captured, "MEMORY_MANIFEST_INVALID"));
  const checkpointsCapture = await capture("checkpoints.json", "canonical");
  const checkpoints = assertMemoryCheckpoints(
    parseJson(checkpointsCapture.captured, "MEMORY_CHECKPOINTS_INVALID"),
    manifest.project_id,
  );
  const localInfo = await entryInfo(path.join(location.root, "local.json"));
  const localCapture = localInfo === null ? null : await capture("local.json", "local");
  const local = localCapture === null
    ? assertMemoryLocalState({
        format: "dubsar.local-state/1",
        project_id: manifest.project_id,
        selected_work_id: null,
      }, manifest.project_id)
    : assertMemoryLocalState(
        parseJson(localCapture.captured, "MEMORY_LOCAL_INVALID"),
        manifest.project_id,
      );

  const files = [
    manifestCapture.file,
    checkpointsCapture.file,
    ...(localCapture === null ? [] : [localCapture.file]),
  ];
  const works = [];
  const workNames = await markdownNames(location.root, "work", MEMORY_MAX_WORK_ITEMS);
  for (const name of workNames) {
    const relative = `work/${name}`;
    const item = await capture(relative, "canonical");
    const parsed = decodeMarkdown(item.captured.content);
    const work = assertMemoryWork(parsed.frontmatter);
    if (`${work.work_id}.md` !== name) fail("MEMORY_WORK_INVALID");
    works.push(work);
    files.push(item.file);
  }

  const knowledge = [];
  const knowledgeNames = await markdownNames(location.root, "knowledge", MEMORY_MAX_KNOWLEDGE_ITEMS);
  for (const name of knowledgeNames) {
    const relative = `knowledge/${name}`;
    const item = await capture(relative, "canonical");
    const parsed = decodeMarkdown(item.captured.content);
    const record = assertMemoryKnowledge(parsed.frontmatter);
    if (`${record.knowledge_id}.md` !== name) fail("MEMORY_KNOWLEDGE_INVALID");
    knowledge.push(record);
    files.push(item.file);
  }

  if (new Set(works.map((item) => item.work_id)).size !== works.length) fail("MEMORY_WORK_INVALID");
  if (new Set(knowledge.map((item) => item.knowledge_id)).size !== knowledge.length) fail("MEMORY_KNOWLEDGE_INVALID");
  const workIds = new Set(works.map((item) => item.work_id));
  const knowledgeIds = new Set(knowledge.map((item) => item.knowledge_id));
  if (local.selected_work_id !== null && !workIds.has(local.selected_work_id)) fail("MEMORY_LOCAL_INVALID");
  if (works.some((item) => item.knowledge_ids.some((id) => !knowledgeIds.has(id)))) fail("MEMORY_WORK_INVALID");
  if (checkpoints.entries.some((entry) => !workIds.has(entry.work_id))) fail("MEMORY_CHECKPOINTS_INVALID");

  if (manifest.legacy_snapshot_sha256 !== null) {
    if (!location.has_legacy_sibling || typeof location.legacy_root !== "string") {
      fail("WORKSPACE_FORMAT_AMBIGUOUS");
    }
    const legacySnapshot = await snapshotLiteWorkspace({
      ...location,
      marker: ".dubsar-project",
      root: location.legacy_root,
    }, limits);
    if (
      legacySnapshot.snapshot_sha256 !== manifest.legacy_snapshot_sha256 ||
      legacySnapshot.documents["state.json"].project_id !== manifest.project_id
    ) fail("MEMORY_LEGACY_BINDING_INVALID");
  } else if (location.has_legacy_sibling) {
    fail("WORKSPACE_FORMAT_AMBIGUOUS");
  }

  if (typeof seams.afterCanonicalCapture === "function") {
    await seams.afterCanonicalCapture();
  }
  await recaptureAll(location.root, captures, limits.maxCanonicalFileBytes);
  const [rootNamesAfter, workNamesAfter, knowledgeNamesAfter] = await Promise.all([
    inspectRoot(location.root),
    markdownNames(location.root, "work", MEMORY_MAX_WORK_ITEMS),
    markdownNames(location.root, "knowledge", MEMORY_MAX_KNOWLEDGE_ITEMS),
  ]);
  if (
    JSON.stringify(rootNamesAfter) !== JSON.stringify(rootNames) ||
    JSON.stringify(workNamesAfter) !== JSON.stringify(workNames) ||
    JSON.stringify(knowledgeNamesAfter) !== JSON.stringify(knowledgeNames)
  ) throw new WorkbenchError("SNAPSHOT_CAPTURE_RACE");
  const orderedFiles = files.sort((left, right) => comparePortable(left.path, right.path));
  const sharedFiles = orderedFiles.filter((item) => item.kind === "canonical");
  return deepFreeze({
    format: "dubsar.workspace-snapshot/1",
    domain: "project",
    marker: location.marker,
    workspace_mode: "memory_vnext",
    shared_snapshot_sha256: rootDigest(sharedFiles),
    snapshot_sha256: rootDigest(orderedFiles),
    total_bytes: totalBytes,
    documents: { manifest, checkpoints, local, works, knowledge },
    artifacts: [],
    files: orderedFiles,
  });
}
