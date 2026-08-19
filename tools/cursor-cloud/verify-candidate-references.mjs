import { readFile } from "node:fs/promises";
import path from "node:path";

import { parseMemoryMarkdown } from "../../packages/dubsar-project-continuity/runtime/memory-vnext-markdown.mjs";
import { captureRegularFile } from "../../packages/dubsar-project-continuity/runtime/safe-capture.mjs";
import { WorkbenchError } from "../../packages/dubsar-project-continuity/runtime/contracts.mjs";
import {
  CursorCloudError,
  inventoryFingerprint,
} from "./runtime.mjs";

export const MAX_CANDIDATE_REFERENCE_BYTES = 25 * 1024 * 1024;
const SHA256 = /^[0-9a-f]{64}$/u;

function mapWorkbenchError(error) {
  if (!(error instanceof WorkbenchError)) {
    throw error;
  }
  switch (error.code) {
    case "REQUIRED_FILE_MISSING":
    case "PATH_NOT_FOUND":
    case "DIRECTORY_NOT_FOUND":
      return new CursorCloudError("CURSOR_CLOUD_CANDIDATE_REFERENCE_MISSING");
    case "FILE_SIZE_LIMIT_EXCEEDED":
      return new CursorCloudError("CURSOR_CLOUD_CANDIDATE_REFERENCE_TOO_LARGE");
    case "UNSAFE_RELATIVE_PATH":
    case "PATH_OUTSIDE_WORKSPACE":
    case "SYMBOLIC_PATH_REJECTED":
    case "FILE_UNSAFE":
    case "UNSUPPORTED_ABSOLUTE_PATH":
    case "DIRECTORY_UNSAFE":
    case "DIRECTORY_ALIAS_REJECTED":
      return new CursorCloudError("CURSOR_CLOUD_CANDIDATE_REFERENCE_UNSAFE");
    default:
      return new CursorCloudError("CURSOR_CLOUD_CANDIDATE_REFERENCE_INVALID");
  }
}

function assertReferenceShape(reference) {
  if (
    !reference ||
    typeof reference.path !== "string" ||
    typeof reference.sha256 !== "string" ||
    !SHA256.test(reference.sha256)
  ) {
    throw new CursorCloudError("CURSOR_CLOUD_CANDIDATE_REFERENCE_INVALID");
  }
  if (
    reference.path.startsWith(".dubsar/") ||
    reference.path.startsWith(".dubsar-pending/")
  ) {
    throw new CursorCloudError("CURSOR_CLOUD_CANDIDATE_REFERENCE_UNSAFE");
  }
}

export async function readPendingCandidateReferences({
  repositoryRoot,
  declaredSource,
  checkpointId,
}) {
  if (
    typeof repositoryRoot !== "string" ||
    typeof declaredSource !== "string" ||
    typeof checkpointId !== "string" ||
    declaredSource.length === 0 ||
    checkpointId.length === 0
  ) {
    throw new CursorCloudError("CURSOR_CLOUD_FORMAT_INVALID");
  }
  const relativeTarget = `.dubsar-pending/${declaredSource}/${checkpointId}.md`;
  const absoluteTarget = path.join(repositoryRoot, relativeTarget);
  let markdown;
  try {
    markdown = await readFile(absoluteTarget, "utf8");
  } catch {
    throw new CursorCloudError("CURSOR_CLOUD_CANDIDATE_REFERENCE_MISSING");
  }
  let parsed;
  try {
    parsed = parseMemoryMarkdown(markdown);
  } catch {
    throw new CursorCloudError("CURSOR_CLOUD_CANDIDATE_REFERENCE_INVALID");
  }
  if (parsed.body !== "") {
    throw new CursorCloudError("CURSOR_CLOUD_CANDIDATE_REFERENCE_INVALID");
  }
  const references = parsed.frontmatter?.checkpoint?.references;
  if (!Array.isArray(references)) {
    throw new CursorCloudError("CURSOR_CLOUD_CANDIDATE_REFERENCE_INVALID");
  }
  return references.map((item) => ({ path: item.path, sha256: item.sha256 }));
}

export async function verifyCandidateReference({
  repositoryRoot,
  reference,
  maxBytes = MAX_CANDIDATE_REFERENCE_BYTES,
}) {
  assertReferenceShape(reference);
  let captured;
  try {
    captured = await captureRegularFile(repositoryRoot, reference.path, maxBytes);
  } catch (error) {
    throw mapWorkbenchError(error);
  }
  if (captured.sha256 !== reference.sha256) {
    throw new CursorCloudError("CURSOR_CLOUD_CANDIDATE_REFERENCE_INVALID");
  }
  return {
    path: captured.path,
    sha256: captured.sha256,
  };
}

export async function verifyPendingCandidateReferences({
  repositoryRoot,
  declaredSource,
  checkpointId,
  references,
  maxBytes = MAX_CANDIDATE_REFERENCE_BYTES,
}) {
  const beforeDubsar = await inventoryFingerprint(path.join(repositoryRoot, ".dubsar"));
  const beforePending = await inventoryFingerprint(path.join(repositoryRoot, ".dubsar-pending"));
  const listed = references ?? await readPendingCandidateReferences({
    repositoryRoot,
    declaredSource,
    checkpointId,
  });
  if (listed.length === 0 || listed.length > 8) {
    throw new CursorCloudError("CURSOR_CLOUD_CANDIDATE_REFERENCE_INVALID");
  }
  const verified = [];
  for (const reference of listed) {
    verified.push(await verifyCandidateReference({
      repositoryRoot,
      reference,
      maxBytes,
    }));
  }
  const afterDubsar = await inventoryFingerprint(path.join(repositoryRoot, ".dubsar"));
  const afterPending = await inventoryFingerprint(path.join(repositoryRoot, ".dubsar-pending"));
  if (afterDubsar !== beforeDubsar || afterPending !== beforePending) {
    throw new CursorCloudError("CURSOR_CLOUD_INVENTORY_MUTATED");
  }
  return {
    count: verified.length,
    references: verified,
    inventories: {
      dubsar_sha256: afterDubsar,
      pending_sha256: afterPending,
      unchanged: true,
    },
  };
}
