import path from "node:path";
import {
  WorkbenchError,
  comparePortable,
  deepFreeze,
  resolveLimits,
  rootDigest,
  sha256Bytes,
} from "./contracts.mjs";
import { captureRegularFile } from "./safe-capture.mjs";
import { artifactPolicyFinding } from "./sensitive-content.mjs";
import { projectArtifactReferences } from "./continuity.mjs";

const REQUIRED_FILES = Object.freeze([
  "mission.json",
  "lots.json",
  "execution-contract.json",
  "evidence.json",
]);
const decoder = new TextDecoder("utf-8", { fatal: true });

function assertProjectLocation(location) {
  if (location?.domain !== "project" || typeof location.root !== "string") {
    throw new WorkbenchError("LOCATION_INVALID");
  }
}

function validateJsonShape(document, limits) {
  const pending = [{ value: document, depth: 1 }];
  let nodes = 0;
  while (pending.length > 0) {
    const { value, depth } = pending.pop();
    nodes += 1;
    if (nodes > limits.maxJsonNodes) throw new WorkbenchError("JSON_NODE_LIMIT_EXCEEDED");
    if (depth > limits.maxJsonDepth) throw new WorkbenchError("JSON_DEPTH_LIMIT_EXCEEDED");
    if (typeof value === "string") {
      if (value.length > limits.maxStringChars) throw new WorkbenchError("JSON_STRING_LIMIT_EXCEEDED");
      continue;
    }
    if (!value || typeof value !== "object") continue;
    if (Array.isArray(value)) {
      if (value.length > limits.maxArrayItems) throw new WorkbenchError("JSON_ARRAY_LIMIT_EXCEEDED");
      for (const child of value) pending.push({ value: child, depth: depth + 1 });
      continue;
    }
    const entries = Object.entries(value);
    if (entries.length > limits.maxObjectKeys) throw new WorkbenchError("JSON_OBJECT_LIMIT_EXCEEDED");
    if (entries.some(([key]) => ["__proto__", "constructor", "prototype"].includes(key))) {
      throw new WorkbenchError("JSON_DANGEROUS_KEY_REJECTED");
    }
    for (const [key, child] of entries) {
      if (key.length > 128) throw new WorkbenchError("JSON_KEY_LIMIT_EXCEEDED");
      pending.push({ value: child, depth: depth + 1 });
    }
  }
}

function parseCanonical(captured, limits) {
  let document;
  try {
    document = JSON.parse(decoder.decode(captured.content));
  } catch (error) {
    if (error instanceof TypeError) throw new WorkbenchError("INVALID_UTF8");
    throw new WorkbenchError("INVALID_JSON");
  }
  validateJsonShape(document, limits);
  return deepFreeze(document);
}

export async function snapshotProjectWorkspace(location, overrides = {}) {
  assertProjectLocation(location);
  const limits = resolveLimits(overrides);
  const documentEntries = [];
  const canonicalFiles = [];
  const files = [];
  const identities = new Set();
  const revalidationEntries = [];
  let totalBytes = 0;

  for (const relativePath of REQUIRED_FILES) {
    const captured = await captureRegularFile(location.root, relativePath, limits.maxCanonicalFileBytes);
    if (identities.has(captured.identity)) throw new WorkbenchError("FILE_IDENTITY_DUPLICATE");
    identities.add(captured.identity);
    revalidationEntries.push({
      root: location.root,
      path: relativePath,
      maxBytes: limits.maxCanonicalFileBytes,
      identity: captured.identity,
      size: captured.size,
      sha256: captured.sha256,
    });
    totalBytes += captured.size;
    if (totalBytes > limits.maxSnapshotBytes) throw new WorkbenchError("SNAPSHOT_SIZE_LIMIT_EXCEEDED");
    documentEntries.push([relativePath, parseCanonical(captured, limits)]);
    const record = { path: captured.path, size: captured.size, sha256: captured.sha256, kind: "canonical" };
    canonicalFiles.push(record);
    files.push(record);
  }

  const documents = Object.fromEntries(documentEntries);
  const artifacts = [];
  const projectRoot = path.dirname(location.root);
  const artifactPaths = projectArtifactReferences(documents["evidence.json"], limits.maxArtifacts);
  for (const relativePath of artifactPaths) {
    try {
      const captured = await captureRegularFile(projectRoot, relativePath, limits.maxArtifactFileBytes);
      if (identities.has(captured.identity)) throw new WorkbenchError("FILE_IDENTITY_DUPLICATE");
      identities.add(captured.identity);
      revalidationEntries.push({
        root: projectRoot,
        path: relativePath,
        maxBytes: limits.maxArtifactFileBytes,
        identity: captured.identity,
        size: captured.size,
        sha256: captured.sha256,
      });
      totalBytes += captured.size;
      if (totalBytes > limits.maxSnapshotBytes) throw new WorkbenchError("SNAPSHOT_SIZE_LIMIT_EXCEEDED");
      const record = {
        path: captured.path,
        size: captured.size,
        sha256: captured.sha256,
        kind: "artifact",
        capture_status: "available",
        policy_finding: artifactPolicyFinding(captured.path, captured.content),
      };
      artifacts.push(record);
      files.push(record);
    } catch (error) {
      if (!(error instanceof WorkbenchError)) throw error;
      const captureStatus = new Set(["PATH_NOT_FOUND", "REQUIRED_FILE_MISSING"]).has(error.code)
        ? "missing"
        : "unknown";
      const record = {
        path: relativePath,
        size: 0,
        sha256: sha256Bytes(Buffer.from(`${captureStatus}:${error.code}:${relativePath}`, "utf8")),
        kind: "artifact",
        capture_status: captureStatus,
        policy_finding: error.code,
      };
      artifacts.push(record);
      files.push(record);
    }
  }

  for (const expected of revalidationEntries) {
    const observed = await captureRegularFile(expected.root, expected.path, expected.maxBytes);
    if (
      observed.identity !== expected.identity ||
      observed.size !== expected.size ||
      observed.sha256 !== expected.sha256
    ) {
      throw new WorkbenchError("SNAPSHOT_CAPTURE_RACE");
    }
  }

  const sortedFiles = files.sort((left, right) => comparePortable(left.path, right.path));
  const sortedCanonical = canonicalFiles.sort((left, right) => comparePortable(left.path, right.path));
  return deepFreeze({
    snapshot: {
      format: "dubsar.workspace-snapshot/1",
      domain: "project",
      marker: location.marker,
      snapshot_sha256: rootDigest(sortedFiles),
      total_bytes: totalBytes,
      documents: deepFreeze(documents),
      artifacts: deepFreeze(artifacts),
      files: deepFreeze(sortedFiles),
    },
    canonical_root_sha256: rootDigest(sortedCanonical),
  }).snapshot;
}
