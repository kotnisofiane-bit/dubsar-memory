import {
  WorkbenchError,
  comparePortable,
  deepFreeze,
  exactKeys,
  sha256Bytes,
  stableJson,
} from "./contracts.mjs";
import { WINDOWS_RESERVED, normalizeRelativePath } from "./path-safety.mjs";
import { safeDisplayText } from "./display-safety.mjs";

export const MEMORY_MANIFEST_FORMAT = "dubsar.memory-project/1";
export const MEMORY_WORK_FORMAT = "dubsar.work/1";
export const MEMORY_KNOWLEDGE_FORMAT = "dubsar.knowledge/1";
export const MEMORY_LOCAL_FORMAT = "dubsar.local-state/1";
export const MEMORY_CHECKPOINTS_FORMAT = "dubsar.continuity-checkpoints/2";

export const MEMORY_MAX_WORK_ITEMS = 256;
export const MEMORY_MAX_KNOWLEDGE_ITEMS = 256;
export const MEMORY_MAX_CHECKPOINTS = 128;

const SAFE_ID = /^[a-z0-9][a-z0-9._-]{2,127}$/iu;
const SAFE_DOMAIN = /^[a-z0-9][a-z0-9._-]{1,63}$/iu;
const SHA256 = /^[0-9a-f]{64}$/u;
const STRUCTURAL_SECRET = /(?:^|[-_.])(?:sk-[a-z0-9_-]{16,}|gh[pousr]_[a-z0-9]{20,}|akia[a-z0-9]{16}|eyj[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}\.[a-z0-9_-]{8,})(?:$|[-_.])/iu;
const STRUCTURAL_IPV4 = /(?:^|[-_])(?:\d{1,3}\.){3}\d{1,3}(?:$|[-_])/u;
const STRUCTURAL_INSTRUCTION = /\b(?:ignore|disregard|override)\b.{0,40}\b(?:instruction|prompt|policy|rule)s?\b|\b(?:run|execute|deploy|publish|merge|delete|send)\b.{0,40}\bautomatically\b/iu;
const WORK_STATUS = new Set(["open", "paused", "complete"]);
const WORK_SCOPE = new Set(["bounded", "multi_step", "multi_session"]);
const KNOWLEDGE_KIND = new Set(["decision", "invariant", "learning"]);
const KNOWLEDGE_STATUS = new Set(["approved", "superseded", "retired"]);
const KNOWLEDGE_PROVENANCE = new Set(["human_confirmed", "checkpoint_promoted"]);
const CHECKPOINT_KIND = new Set(["progress", "decision", "blocker", "blocker_resolution", "attempt"]);
const RESULT_STATUS = new Set(["active", "paused", "complete", "unknown"]);
const FORBIDDEN_REFERENCE_ROOTS = new Set([
  ".codex-work",
  ".dubsar",
  ".git",
  "memory",
  "node_modules",
]);

function fail(code) {
  throw new WorkbenchError(code);
}

function text(value, max, code) {
  if (typeof value !== "string" || value.length === 0 || value.length > max) fail(code);
  const display = safeDisplayText(value, max);
  if (display.redacted || display.truncated || display.text !== value) fail(code);
  return value;
}

function id(value, code) {
  if (typeof value !== "string" || !SAFE_ID.test(value)) fail(code);
  const policy = value.normalize("NFKC");
  const instruction = policy.replace(/[-_.]+/gu, " ");
  if (STRUCTURAL_SECRET.test(policy) || STRUCTURAL_IPV4.test(policy) || STRUCTURAL_INSTRUCTION.test(instruction)) {
    fail(code);
  }
  return value;
}

function nullableId(value, code) {
  return value === null ? null : id(value, code);
}

function textArray(value, maxItems, maxChars, code) {
  if (!Array.isArray(value) || value.length > maxItems) fail(code);
  const output = value.map((item) => text(item, maxChars, code));
  if (new Set(output).size !== output.length) fail(code);
  return output;
}

function idArray(value, maxItems, code) {
  if (!Array.isArray(value) || value.length > maxItems) fail(code);
  const output = value.map((item) => id(item, code));
  if (new Set(output).size !== output.length) fail(code);
  return output;
}

function referenceArray(value, code) {
  if (!Array.isArray(value) || value.length > 16) fail(code);
  const output = value.map((item) => {
    const normalized = normalizeRelativePath(item);
    const unsafe = normalized.split("/").some((segment) => {
      const lower = segment.toLowerCase();
      return FORBIDDEN_REFERENCE_ROOTS.has(lower) || lower.startsWith(".dubsar-");
    });
    if (unsafe) fail(code);
    return normalized;
  });
  if (new Set(output).size !== output.length) fail(code);
  return output;
}

export function assertMemoryManifest(value) {
  const code = "MEMORY_MANIFEST_INVALID";
  if (!exactKeys(value, ["format", "legacy_snapshot_sha256", "project_id", "title"]) ||
    value.format !== MEMORY_MANIFEST_FORMAT ||
    !(value.legacy_snapshot_sha256 === null || SHA256.test(value.legacy_snapshot_sha256 ?? ""))) fail(code);
  return deepFreeze({
    format: MEMORY_MANIFEST_FORMAT,
    project_id: id(value.project_id, code),
    title: text(value.title, 300, code),
    legacy_snapshot_sha256: value.legacy_snapshot_sha256,
  });
}

export function assertMemoryWork(value) {
  const code = "MEMORY_WORK_INVALID";
  if (!exactKeys(value, [
    "acceptance_criteria", "format", "knowledge_ids", "objective", "references",
    "scope", "status", "title", "work_id",
  ]) || value.format !== MEMORY_WORK_FORMAT || !WORK_STATUS.has(value.status) || !WORK_SCOPE.has(value.scope)) fail(code);
  return deepFreeze({
    format: MEMORY_WORK_FORMAT,
    work_id: id(value.work_id, code),
    title: text(value.title, 300, code),
    status: value.status,
    scope: value.scope,
    objective: text(value.objective, 1_500, code),
    acceptance_criteria: textArray(value.acceptance_criteria, 12, 500, code),
    knowledge_ids: idArray(value.knowledge_ids, 32, code),
    references: referenceArray(value.references, code),
  });
}

export function assertMemoryKnowledge(value) {
  const code = "MEMORY_KNOWLEDGE_INVALID";
  if (!exactKeys(value, [
    "domain", "format", "kind", "knowledge_id", "provenance", "statement", "status",
    "supersedes", "title",
  ]) || value.format !== MEMORY_KNOWLEDGE_FORMAT || !KNOWLEDGE_KIND.has(value.kind) ||
    !KNOWLEDGE_STATUS.has(value.status) || !KNOWLEDGE_PROVENANCE.has(value.provenance)) fail(code);
  const supersedes = nullableId(value.supersedes, code);
  const knowledgeId = id(value.knowledge_id, code);
  if (supersedes === knowledgeId) fail(code);
  return deepFreeze({
    format: MEMORY_KNOWLEDGE_FORMAT,
    knowledge_id: knowledgeId,
    title: text(value.title, 300, code),
    domain: typeof value.domain === "string" && SAFE_DOMAIN.test(value.domain)
      ? id(value.domain, code)
      : fail(code),
    kind: value.kind,
    status: value.status,
    statement: text(value.statement, 1_000, code),
    provenance: value.provenance,
    supersedes,
  });
}

export function assertMemoryLocalState(value, projectId) {
  const code = "MEMORY_LOCAL_INVALID";
  if (!exactKeys(value, ["format", "project_id", "selected_work_id"]) ||
    value.format !== MEMORY_LOCAL_FORMAT) fail(code);
  const normalized = {
    format: MEMORY_LOCAL_FORMAT,
    project_id: id(value.project_id, code),
    selected_work_id: nullableId(value.selected_work_id, code),
  };
  if (projectId !== undefined && normalized.project_id !== projectId) fail(code);
  return deepFreeze(normalized);
}

function resultingState(value, code) {
  if (!exactKeys(value, ["blockers", "next_action", "status", "summary"]) || !RESULT_STATUS.has(value.status) ||
    !Array.isArray(value.blockers) || value.blockers.length > 8) fail(code);
  return {
    status: value.status,
    summary: text(value.summary, 500, code),
    blockers: value.blockers.map((item) => {
      if (!exactKeys(item, ["blocker_id", "statement"])) fail(code);
      return { blocker_id: id(item.blocker_id, code), statement: text(item.statement, 500, code) };
    }),
    next_action: text(value.next_action, 500, code),
  };
}

function checkpointDigest(entry) {
  const { checkpoint_sha256: ignored, ...base } = entry;
  return sha256Bytes(Buffer.from(stableJson(base), "utf8"));
}

const CHECKPOINT_AUTHOR_KEYS = [
  "attempt", "checkpoint_id", "kind", "limitations", "references",
  "resolves", "resulting_state", "summary", "validation", "work_id",
];

function assertStructuralIdPolicy(value, code) {
  const policy = value.normalize("NFKC");
  const instruction = policy.replace(/[-_.]+/gu, " ");
  if (STRUCTURAL_SECRET.test(policy) || STRUCTURAL_IPV4.test(policy) || STRUCTURAL_INSTRUCTION.test(instruction)) {
    fail(code);
  }
}

function assertPortableSegment(value, code, { maxTail }) {
  if (
    typeof value !== "string" ||
    value.length < 3 ||
    value.length > maxTail + 1 ||
    !new RegExp(`^[a-z0-9][a-z0-9._-]{2,${maxTail}}$`, "u").test(value) ||
    /[. ]$/u.test(value) ||
    WINDOWS_RESERVED.test(value)
  ) {
    fail(code);
  }
  assertStructuralIdPolicy(value, code);
  return value;
}

function assertPortableCheckpointId(value, code) {
  return assertPortableSegment(value, code, { maxTail: 127 });
}

/**
 * Shared author-field validation for canonical checkpoint_append entries and
 * pending candidates. Callers supply the checkpoint_id asserter so pending can
 * tighten to the portable lowercase filesystem subset.
 */
function assertCheckpointAuthorFields(value, code, assertCheckpointId) {
  if (!CHECKPOINT_KIND.has(value.kind)) fail(code);
  const attempt = value.attempt === null ? null : (() => {
    if (!exactKeys(value.attempt, ["action_id", "failure_fingerprint", "gate_id"]) ||
      !SHA256.test(value.attempt.failure_fingerprint ?? "")) fail(code);
    return {
      action_id: id(value.attempt.action_id, code),
      gate_id: id(value.attempt.gate_id, code),
      failure_fingerprint: value.attempt.failure_fingerprint,
    };
  })();
  if ((value.kind === "attempt") !== (attempt !== null)) fail(code);
  if (!Array.isArray(value.references) || value.references.length > 8) fail(code);
  const references = value.references.map((item) => {
    if (!exactKeys(item, ["path", "sha256"]) || !SHA256.test(item.sha256 ?? "")) fail(code);
    const normalized = referenceArray([item.path], code).at(0);
    return { path: normalized, sha256: item.sha256 };
  });
  if (new Set(references.map((item) => item.path)).size !== references.length) fail(code);
  return {
    attempt,
    checkpoint_id: assertCheckpointId(value.checkpoint_id, code),
    kind: value.kind,
    limitations: textArray(value.limitations, 8, 500, code),
    references,
    resolves: nullableId(value.resolves, code),
    resulting_state: resultingState(value.resulting_state, code),
    summary: text(value.summary, 500, code),
    validation: textArray(value.validation, 8, 500, code),
    work_id: id(value.work_id, code),
  };
}

function assertCheckpoint(value, index, previous, projectId) {
  const code = "MEMORY_CHECKPOINTS_INVALID";
  if (!exactKeys(value, [
    "attempt", "checkpoint_id", "checkpoint_sha256", "index", "kind", "limitations",
    "previous_checkpoint_sha256", "references", "resolves", "resulting_state", "summary",
    "validation", "work_id",
  ]) || value.index !== index ||
    value.previous_checkpoint_sha256 !== previous || !SHA256.test(value.checkpoint_sha256 ?? "")) fail(code);
  const author = assertCheckpointAuthorFields(value, code, id);
  const normalized = {
    ...author,
    checkpoint_sha256: value.checkpoint_sha256,
    index,
    previous_checkpoint_sha256: previous,
  };
  if (checkpointDigest(normalized) !== normalized.checkpoint_sha256) fail(code);
  return normalized;
}

export function assertMemoryCheckpoints(value, projectId) {
  const code = "MEMORY_CHECKPOINTS_INVALID";
  if (!exactKeys(value, ["entries", "format", "project_id"]) ||
    value.format !== MEMORY_CHECKPOINTS_FORMAT || !Array.isArray(value.entries) ||
    value.entries.length > MEMORY_MAX_CHECKPOINTS) fail(code);
  const documentProjectId = id(value.project_id, code);
  if (projectId !== undefined && projectId !== documentProjectId) fail(code);
  let previous = null;
  const entries = value.entries.map((entry, index) => {
    const normalized = assertCheckpoint(entry, index, previous, documentProjectId);
    previous = normalized.checkpoint_sha256;
    return normalized;
  });
  const ids = entries.map((entry) => entry.checkpoint_id);
  if (new Set(ids).size !== ids.length) fail(code);
  const seen = new Set();
  for (const entry of entries) {
    if (entry.resolves !== null && !seen.has(entry.resolves)) fail(code);
    seen.add(entry.checkpoint_id);
  }
  return deepFreeze({ format: MEMORY_CHECKPOINTS_FORMAT, project_id: documentProjectId, entries });
}

export function memoryCheckpointDigest(entry) {
  return checkpointDigest(entry);
}

export const MEMORY_PENDING_CHECKPOINT_FORMAT = "dubsar.pending-checkpoint/1";
export const MEMORY_PENDING_MAX_SOURCES = 32;
export const MEMORY_PENDING_MAX_CANDIDATES = 128;
export const MEMORY_PENDING_MAX_FILE_BYTES = 64 * 1024;

function pendingAuthorCheckpoint(value, code) {
  if (!exactKeys(value, CHECKPOINT_AUTHOR_KEYS)) fail(code);
  return deepFreeze(assertCheckpointAuthorFields(value, code, assertPortableCheckpointId));
}

export function assertPendingDeclaredSource(value, code = "PENDING_DOCUMENT_INVALID") {
  return assertPortableSegment(value, code, { maxTail: 63 });
}

export function assertPendingCheckpointId(value, code = "PENDING_DOCUMENT_INVALID") {
  return assertPortableCheckpointId(value, code);
}

export function memoryPendingCandidateDigest(frontmatterWithoutDigest) {
  return sha256Bytes(Buffer.concat([
    Buffer.from(`${MEMORY_PENDING_CHECKPOINT_FORMAT}\0`, "utf8"),
    Buffer.from(stableJson(frontmatterWithoutDigest), "utf8"),
  ]));
}

export function assertPendingCheckpointDocument(value, projectId) {
  const code = "PENDING_DOCUMENT_INVALID";
  if (!exactKeys(value, [
    "base_checkpoint_sha256",
    "base_work_checkpoint_sha256",
    "candidate_sha256",
    "checkpoint",
    "declared_source",
    "format",
    "project_id",
    "source_shared_snapshot_sha256",
  ]) || value.format !== MEMORY_PENDING_CHECKPOINT_FORMAT ||
    !(value.base_checkpoint_sha256 === null || SHA256.test(value.base_checkpoint_sha256 ?? "")) ||
    !(value.base_work_checkpoint_sha256 === null || SHA256.test(value.base_work_checkpoint_sha256 ?? "")) ||
    !SHA256.test(value.candidate_sha256 ?? "") ||
    !SHA256.test(value.source_shared_snapshot_sha256 ?? "")) fail(code);
  const documentProjectId = id(value.project_id, code);
  if (projectId !== undefined && projectId !== documentProjectId) fail(code);
  const declaredSource = assertPendingDeclaredSource(value.declared_source, code);
  const checkpoint = pendingAuthorCheckpoint(value.checkpoint, code);
  const withoutDigest = {
    base_checkpoint_sha256: value.base_checkpoint_sha256,
    base_work_checkpoint_sha256: value.base_work_checkpoint_sha256,
    checkpoint,
    declared_source: declaredSource,
    format: MEMORY_PENDING_CHECKPOINT_FORMAT,
    project_id: documentProjectId,
    source_shared_snapshot_sha256: value.source_shared_snapshot_sha256,
  };
  if (memoryPendingCandidateDigest(withoutDigest) !== value.candidate_sha256) fail(code);
  return deepFreeze({
    ...withoutDigest,
    candidate_sha256: value.candidate_sha256,
  });
}

export function assertPendingCheckpointAuthor(value) {
  return pendingAuthorCheckpoint(value, "PENDING_DOCUMENT_INVALID");
}

export const MEMORY_PENDING_LIST_FORMAT = "dubsar.pending-checkpoints-list/1";
export const MEMORY_PENDING_SET_FORMAT = "dubsar.pending-checkpoints-set/1";

/**
 * Public fail-closed diagnostics for `pending list`. Locator and snapshot
 * codes never cross this boundary.
 */
export const PENDING_LIST_DIAGNOSTICS = Object.freeze([
  "PENDING_CAPTURE_RACE",
  "PENDING_ENTRY_INVALID",
  "PENDING_LIMIT_EXCEEDED",
  "PENDING_LIST_INVALID",
  "PENDING_ROOT_UNSAFE",
  "PENDING_WORKSPACE_REQUIRED",
]);

const PENDING_LIST_DIAGNOSTIC_SET = new Set(PENDING_LIST_DIAGNOSTICS);

const PENDING_LIST_INTERNAL_DIAGNOSTIC_PAIRS = Object.freeze([
  Object.freeze(["FILE_CHANGED_DURING_SNAPSHOT", "PENDING_CAPTURE_RACE"]),
  Object.freeze(["INVALID_JSON", "PENDING_LIST_INVALID"]),
  Object.freeze(["INVALID_UTF8", "PENDING_LIST_INVALID"]),
  Object.freeze(["MEMORY_CHECKPOINTS_INVALID", "PENDING_LIST_INVALID"]),
  Object.freeze(["MEMORY_KNOWLEDGE_INVALID", "PENDING_LIST_INVALID"]),
  Object.freeze(["MEMORY_LOCAL_INVALID", "PENDING_LIST_INVALID"]),
  Object.freeze(["MEMORY_MANIFEST_INVALID", "PENDING_LIST_INVALID"]),
  Object.freeze(["MEMORY_MARKDOWN_INVALID", "PENDING_LIST_INVALID"]),
  Object.freeze(["MEMORY_WORKSPACE_INVALID", "PENDING_LIST_INVALID"]),
  Object.freeze(["MEMORY_WORK_INVALID", "PENDING_LIST_INVALID"]),
  Object.freeze(["PROJECT_BOUNDARY_UNSAFE", "PENDING_ROOT_UNSAFE"]),
  Object.freeze(["REQUIRED_FILE_MISSING", "PENDING_LIST_INVALID"]),
  Object.freeze(["SNAPSHOT_CAPTURE_RACE", "PENDING_CAPTURE_RACE"]),
  Object.freeze(["WORKSPACE_MARKER_UNSAFE", "PENDING_ROOT_UNSAFE"]),
  Object.freeze(["WORKSPACE_NOT_FOUND", "PENDING_WORKSPACE_REQUIRED"]),
]);

export const PENDING_LIST_INTERNAL_DIAGNOSTIC_MAP = Object.freeze(
  Object.fromEntries(PENDING_LIST_INTERNAL_DIAGNOSTIC_PAIRS),
);

export function mapPendingListDiagnostic(error, phase = null) {
  const code = error instanceof WorkbenchError && typeof error.code === "string"
    ? error.code
    : null;
  if (code !== null && PENDING_LIST_DIAGNOSTIC_SET.has(code)) {
    return error instanceof WorkbenchError ? error : new WorkbenchError(code);
  }
  if (phase === "locate") {
    if (code === "PROJECT_BOUNDARY_UNSAFE" || code === "WORKSPACE_MARKER_UNSAFE") {
      return new WorkbenchError("PENDING_ROOT_UNSAFE");
    }
    return new WorkbenchError("PENDING_WORKSPACE_REQUIRED");
  }
  if (phase === "snapshot") {
    if (code === "FILE_CHANGED_DURING_SNAPSHOT" || code === "SNAPSHOT_CAPTURE_RACE") {
      return new WorkbenchError("PENDING_CAPTURE_RACE");
    }
    return new WorkbenchError("PENDING_LIST_INVALID");
  }
  if (phase === "pending") {
    if (code === "FILE_SIZE_LIMIT_EXCEEDED") {
      return new WorkbenchError("PENDING_LIMIT_EXCEEDED");
    }
    if (
      code === "FILE_CHANGED_DURING_SNAPSHOT" ||
      code === "PATH_NOT_FOUND" ||
      code === "REQUIRED_FILE_MISSING" ||
      code === "SNAPSHOT_CAPTURE_RACE"
    ) {
      return new WorkbenchError("PENDING_CAPTURE_RACE");
    }
    return new WorkbenchError("PENDING_ROOT_UNSAFE");
  }
  if (code !== null) {
    for (const [internal, mapped] of PENDING_LIST_INTERNAL_DIAGNOSTIC_PAIRS) {
      if (code === internal) {
        return new WorkbenchError(mapped);
      }
    }
  }
  return new WorkbenchError("PENDING_LIST_INVALID");
}

export function memoryPendingSetDigest(entries) {
  if (!Array.isArray(entries) || entries.length > MEMORY_PENDING_MAX_CANDIDATES) {
    fail("PENDING_DOCUMENT_INVALID");
  }
  const lines = [...entries]
    .map((item) => {
      if (!exactKeys(item, ["path", "sha256"]) || !SHA256.test(item.sha256 ?? "")) {
        fail("PENDING_DOCUMENT_INVALID");
      }
      if (
        typeof item.path !== "string" ||
        item.path.includes("\n") ||
        item.path.includes("\r") ||
        item.path.includes("\0")
      ) {
        fail("PENDING_DOCUMENT_INVALID");
      }
      let portable;
      try {
        portable = normalizeRelativePath(item.path);
      } catch {
        fail("PENDING_DOCUMENT_INVALID");
      }
      if (portable !== item.path) fail("PENDING_DOCUMENT_INVALID");
      const parts = portable.split("/");
      if (parts.length !== 2) fail("PENDING_DOCUMENT_INVALID");
      const sourcePart = parts[0];
      const filePart = parts[1];
      if (typeof filePart !== "string" || !filePart.endsWith(".md")) {
        fail("PENDING_DOCUMENT_INVALID");
      }
      const source = assertPendingDeclaredSource(sourcePart, "PENDING_DOCUMENT_INVALID");
      const checkpointId = assertPendingCheckpointId(
        filePart.slice(0, -3),
        "PENDING_DOCUMENT_INVALID",
      );
      const reconstructed = `${source}/${checkpointId}.md`;
      if (reconstructed !== portable) fail("PENDING_DOCUMENT_INVALID");
      return { path: reconstructed, sha256: item.sha256 };
    })
    .sort((left, right) => comparePortable(left.path, right.path));
  let previousPath = null;
  for (const line of lines) {
    if (previousPath !== null && comparePortable(previousPath, line.path) !== -1) {
      fail("PENDING_DOCUMENT_INVALID");
    }
    previousPath = line.path;
  }
  if (new Set(lines.map((item) => item.path)).size !== lines.length) {
    fail("PENDING_DOCUMENT_INVALID");
  }
  return sha256Bytes(Buffer.concat([
    Buffer.from(`${MEMORY_PENDING_SET_FORMAT}\0`, "utf8"),
    Buffer.from(lines.map((item) => `${item.sha256}  ${item.path}\n`).join(""), "utf8"),
  ]));
}

export function memoryPendingListDigest(listWithoutListSha256) {
  return sha256Bytes(Buffer.concat([
    Buffer.from(`${MEMORY_PENDING_LIST_FORMAT}\0`, "utf8"),
    Buffer.from(stableJson(listWithoutListSha256), "utf8"),
  ]));
}

export function assertPendingCheckpointsList(value) {
  const code = "PENDING_LIST_INVALID";
  if (!exactKeys(value, [
    "candidates",
    "count",
    "format",
    "list_sha256",
    "pending_set_sha256",
    "project_id",
    "source_shared_snapshot_sha256",
  ]) || value.format !== MEMORY_PENDING_LIST_FORMAT ||
    !SHA256.test(value.source_shared_snapshot_sha256 ?? "") ||
    !SHA256.test(value.pending_set_sha256 ?? "") ||
    !SHA256.test(value.list_sha256 ?? "") ||
    !Number.isSafeInteger(value.count) || value.count < 0 ||
    value.count > MEMORY_PENDING_MAX_CANDIDATES ||
    !Array.isArray(value.candidates) ||
    value.candidates.length > MEMORY_PENDING_MAX_CANDIDATES ||
    value.count !== value.candidates.length
  ) fail(code);

  const candidates = value.candidates.map((item) => {
    if (!exactKeys(item, [
      "candidate_sha256",
      "checkpoint_id",
      "declared_source",
      "kind",
      "source_file_sha256",
      "summary",
      "work_id",
    ]) || !CHECKPOINT_KIND.has(item.kind) ||
      typeof item.summary !== "string" || item.summary.length === 0 || item.summary.length > 500 ||
      !SHA256.test(item.candidate_sha256 ?? "") ||
      !SHA256.test(item.source_file_sha256 ?? "")
    ) fail(code);
    return {
      declared_source: assertPendingDeclaredSource(item.declared_source, code),
      checkpoint_id: assertPendingCheckpointId(item.checkpoint_id, code),
      work_id: id(item.work_id, code),
      kind: item.kind,
      summary: item.summary,
      candidate_sha256: item.candidate_sha256,
      source_file_sha256: item.source_file_sha256,
    };
  });

  const keys = candidates.map((item) => `${item.declared_source}/${item.checkpoint_id}`);
  if (new Set(keys).size !== keys.length) fail(code);
  let previousKey = null;
  for (const key of keys) {
    if (previousKey !== null && comparePortable(previousKey, key) !== -1) fail(code);
    previousKey = key;
  }

  const setEntries = candidates.map((item) => ({
    path: `${item.declared_source}/${item.checkpoint_id}.md`,
    sha256: item.source_file_sha256,
  }));
  if (memoryPendingSetDigest(setEntries) !== value.pending_set_sha256) fail(code);

  const withoutDigest = {
    format: MEMORY_PENDING_LIST_FORMAT,
    project_id: id(value.project_id, code),
    source_shared_snapshot_sha256: value.source_shared_snapshot_sha256,
    pending_set_sha256: value.pending_set_sha256,
    count: value.count,
    candidates,
  };
  if (memoryPendingListDigest(withoutDigest) !== value.list_sha256) fail(code);
  return deepFreeze({
    ...withoutDigest,
    list_sha256: value.list_sha256,
  });
}
