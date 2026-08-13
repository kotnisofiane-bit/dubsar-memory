import {
  WorkbenchError,
  comparePortable,
  deepFreeze,
  resolveLimits,
  rootDigest,
  sha256Bytes,
} from "./contracts.mjs";
import path from "node:path";
import { normalizeRelativePath } from "./path-safety.mjs";
import { captureRegularFile } from "./safe-capture.mjs";
import { artifactPolicyFinding } from "./sensitive-content.mjs";
import { projectArtifactReferences } from "./continuity.mjs";

const REQUIRED_FILES = Object.freeze({
  project: Object.freeze([
    "mission.json",
    "lots.json",
    "execution-contract.json",
    "evidence.json",
  ]),
  audit: Object.freeze([
    "audit-scope.json",
    "automation-inventory.json",
    "sensitive-actions.json",
    "evidence-index.json",
    "evidence-review.json",
  ]),
});

const decoder = new TextDecoder("utf-8", { fatal: true });

function assertLocation(location) {
  if (
    !location ||
    !Object.hasOwn(REQUIRED_FILES, location.domain) ||
    typeof location.root !== "string"
  ) {
    throw new WorkbenchError("LOCATION_INVALID");
  }
}

function validateJsonShape(document, limits) {
  const pending = [{ value: document, depth: 1 }];
  let nodes = 0;
  while (pending.length > 0) {
    const { value, depth } = pending.pop();
    nodes += 1;
    if (nodes > limits.maxJsonNodes) {
      throw new WorkbenchError("JSON_NODE_LIMIT_EXCEEDED");
    }
    if (depth > limits.maxJsonDepth) {
      throw new WorkbenchError("JSON_DEPTH_LIMIT_EXCEEDED");
    }
    if (typeof value === "string") {
      if (value.length > limits.maxStringChars) {
        throw new WorkbenchError("JSON_STRING_LIMIT_EXCEEDED");
      }
      continue;
    }
    if (!value || typeof value !== "object") {
      continue;
    }
    if (Array.isArray(value)) {
      if (value.length > limits.maxArrayItems) {
        throw new WorkbenchError("JSON_ARRAY_LIMIT_EXCEEDED");
      }
      for (const child of value) {
        pending.push({ value: child, depth: depth + 1 });
      }
      continue;
    }
    const entries = Object.entries(value);
    if (entries.length > limits.maxObjectKeys) {
      throw new WorkbenchError("JSON_OBJECT_LIMIT_EXCEEDED");
    }
    if (entries.some(([key]) => ["__proto__", "constructor", "prototype"].includes(key))) {
      throw new WorkbenchError("JSON_DANGEROUS_KEY_REJECTED");
    }
    for (const [key, child] of entries) {
      if (key.length > 128) {
        throw new WorkbenchError("JSON_KEY_LIMIT_EXCEEDED");
      }
      pending.push({ value: child, depth: depth + 1 });
    }
  }
}

function parseCanonical(captured, limits) {
  let text;
  try {
    text = decoder.decode(captured.content);
  } catch {
    throw new WorkbenchError("INVALID_UTF8");
  }
  let document;
  try {
    document = JSON.parse(text);
  } catch {
    throw new WorkbenchError("INVALID_JSON");
  }
  validateJsonShape(document, limits);
  return deepFreeze(document);
}

function auditArtifactPaths(documents, limits) {
  const artifacts = documents["evidence-index.json"]?.artifacts;
  if (!Array.isArray(artifacts)) {
    return [];
  }
  if (artifacts.length > limits.maxArtifacts) {
    throw new WorkbenchError("ARTIFACT_COUNT_LIMIT_EXCEEDED");
  }
  const paths = artifacts.map((artifact) => artifact?.path);
  if (paths.some((item) => typeof item !== "string")) {
    throw new WorkbenchError("ARTIFACT_PATH_INVALID");
  }
  const normalized = paths.map((item) => normalizeRelativePath(item));
  const portableIdentities = normalized.map((item) => item.toLowerCase());
  if (new Set(portableIdentities).size !== portableIdentities.length) {
    throw new WorkbenchError("ARTIFACT_PATH_DUPLICATE");
  }
  const reserved = new Set([
    ...REQUIRED_FILES.audit,
    "audit-preparation-summary.md",
    "manifest.sha256.json",
  ]);
  if (portableIdentities.some((item) => reserved.has(item))) {
    throw new WorkbenchError("ARTIFACT_PATH_RESERVED");
  }
  return normalized.sort(comparePortable);
}

export async function captureWorkspaceSnapshot(location, limits) {
  assertLocation(location);
  const documentEntries = [];
  const canonicalFiles = [];
  const files = [];
  const physicalIdentities = new Set();
  const revalidationEntries = [];
  let totalBytes = 0;

  const requiredFiles =
    location.domain === "project" ? REQUIRED_FILES.project : REQUIRED_FILES.audit;
  for (const relativePath of requiredFiles) {
    const captured = await captureRegularFile(
      location.root,
      relativePath,
      limits.maxCanonicalFileBytes,
    );
    if (physicalIdentities.has(captured.identity)) {
      throw new WorkbenchError("FILE_IDENTITY_DUPLICATE");
    }
    physicalIdentities.add(captured.identity);
    revalidationEntries.push({
      root: location.root,
      path: relativePath,
      maxBytes: limits.maxCanonicalFileBytes,
      identity: captured.identity,
      size: captured.size,
      sha256: captured.sha256,
    });
    totalBytes += captured.size;
    if (totalBytes > limits.maxSnapshotBytes) {
      throw new WorkbenchError("SNAPSHOT_SIZE_LIMIT_EXCEEDED");
    }
    documentEntries.push([relativePath, parseCanonical(captured, limits)]);
    const record = {
      path: captured.path,
      size: captured.size,
      sha256: captured.sha256,
      kind: "canonical",
    };
    canonicalFiles.push(record);
    files.push(record);
  }
  const documents = Object.fromEntries(documentEntries);

  const artifacts = [];
  const artifactPaths = location.domain === "audit"
    ? auditArtifactPaths(documents, limits)
    : projectArtifactReferences(documents["evidence.json"], limits.maxArtifacts);
  const artifactRoot = location.domain === "audit"
    ? location.root
    : path.dirname(location.root);
  for (const relativePath of artifactPaths) {
    try {
      const captured = await captureRegularFile(
        artifactRoot,
        relativePath,
        limits.maxArtifactFileBytes,
      );
      if (physicalIdentities.has(captured.identity)) {
        throw new WorkbenchError("FILE_IDENTITY_DUPLICATE");
      }
      physicalIdentities.add(captured.identity);
      revalidationEntries.push({
        root: artifactRoot,
        path: relativePath,
        maxBytes: limits.maxArtifactFileBytes,
        identity: captured.identity,
        size: captured.size,
        sha256: captured.sha256,
      });
      totalBytes += captured.size;
      if (totalBytes > limits.maxSnapshotBytes) {
        throw new WorkbenchError("SNAPSHOT_SIZE_LIMIT_EXCEEDED");
      }
      const policyFinding = artifactPolicyFinding(
        captured.path,
        captured.content,
      );
      const record = {
        path: captured.path,
        size: captured.size,
        sha256: captured.sha256,
        kind: "artifact",
        capture_status: "available",
        policy_finding: policyFinding,
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

  // A second bounded pass prevents a normal concurrent edit from producing a
  // projection assembled from canonical files that changed during capture.
  // It does not claim filesystem-level transactional snapshot semantics.
  for (const expected of revalidationEntries) {
    const observed = await captureRegularFile(
      expected.root,
      expected.path,
      expected.maxBytes,
    );
    if (
      observed.identity !== expected.identity ||
      observed.size !== expected.size ||
      observed.sha256 !== expected.sha256
    ) {
      throw new WorkbenchError("SNAPSHOT_CAPTURE_RACE");
    }
  }

  const sortedFiles = files.sort((left, right) =>
    comparePortable(left.path, right.path),
  );
  const snapshot = deepFreeze({
    format: "dubsar.workspace-snapshot/1",
    domain: location.domain,
    marker: location.marker,
    snapshot_sha256: rootDigest(sortedFiles),
    total_bytes: totalBytes,
    documents,
    artifacts,
    files: sortedFiles,
  });
  const sortedCanonicalFiles = canonicalFiles.sort((left, right) =>
    comparePortable(left.path, right.path),
  );
  return deepFreeze({
    snapshot,
    canonical_root_sha256: rootDigest(sortedCanonicalFiles),
  });
}

export async function snapshotWorkspace(location, overrides = {}) {
  assertLocation(location);
  const limits = resolveLimits(overrides);
  return (await captureWorkspaceSnapshot(location, limits)).snapshot;
}
