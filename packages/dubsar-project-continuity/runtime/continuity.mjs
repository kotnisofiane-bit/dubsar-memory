import {
  WorkbenchError,
  comparePortable,
  deepFreeze,
  exactKeys,
} from "./contracts.mjs";
import { normalizeRelativePath } from "./path-safety.mjs";

export const PROJECT_EVIDENCE_V1_FORMAT = "dubsar.project-evidence/1";
export const PROJECT_EVIDENCE_V2_FORMAT = "dubsar.project-evidence/2";

export const EVIDENCE_V2_ENTRY_KEYS = Object.freeze([
  "artifact_refs",
  "class",
  "evidence_id",
  "kind",
  "limitations",
  "lot_id",
  "resolves",
  "statement",
  "validation",
]);
export const EVIDENCE_V2_REF_KEYS = Object.freeze([
  "byte_length",
  "path",
  "sha256",
]);

const SHA256 = /^[0-9a-f]{64}$/u;
const SAFE_ID = /^[a-z0-9][a-z0-9._-]{2,127}$/iu;
const FORBIDDEN_ROOTS = new Set([
  ".codex-work",
  ".git",
  "memory",
  "node_modules",
]);

export function normalizeProjectArtifactPath(value) {
  const normalized = normalizeRelativePath(value);
  const first = normalized.split("/").at(0).toLowerCase();
  if (first.startsWith(".dubsar-") || FORBIDDEN_ROOTS.has(first)) {
    throw new WorkbenchError("PROJECT_ARTIFACT_PATH_FORBIDDEN");
  }
  return normalized;
}

export function projectArtifactReferences(document, maxArtifacts = 128) {
  if (document?.format !== PROJECT_EVIDENCE_V2_FORMAT) return [];
  if (!Array.isArray(document.entries)) {
    throw new WorkbenchError("EVIDENCE_NOT_ARRAY");
  }
  const byPath = new Map();
  for (const entry of document.entries) {
    if (!Array.isArray(entry?.artifact_refs)) continue;
    for (const reference of entry.artifact_refs) {
      if (!exactKeys(reference, EVIDENCE_V2_REF_KEYS)) {
        throw new WorkbenchError("EVIDENCE_ARTIFACT_REF_INVALID");
      }
      const artifactPath = normalizeProjectArtifactPath(reference.path);
      if (!byPath.has(artifactPath)) byPath.set(artifactPath, artifactPath);
    }
  }
  if (byPath.size > maxArtifacts) {
    throw new WorkbenchError("ARTIFACT_COUNT_LIMIT_EXCEEDED");
  }
  return [...byPath.values()].sort(comparePortable);
}

export function referenceFreshness(reference, artifacts) {
  if (!reference || !exactKeys(reference, EVIDENCE_V2_REF_KEYS)) {
    return "unknown";
  }
  let artifactPath;
  try {
    artifactPath = normalizeProjectArtifactPath(reference.path);
  } catch {
    return "unknown";
  }
  const artifact = artifacts.find((item) => item.path === artifactPath);
  if (!artifact || artifact.capture_status === "missing") return "missing";
  if (
    artifact.capture_status !== "available" ||
    artifact.policy_finding !== null ||
    !Number.isSafeInteger(reference.byte_length) ||
    reference.byte_length < 0 ||
    !SHA256.test(reference.sha256 ?? "")
  ) {
    return "unknown";
  }
  return artifact.size === reference.byte_length && artifact.sha256 === reference.sha256
    ? "fresh"
    : "stale";
}

export function analyzeEvidenceV2(document, artifacts, lotIds, findings) {
  const entries = Array.isArray(document.entries) ? document.entries : [];
  const allowedKinds = new Set([
    "blocker",
    "blocker_resolution",
    "decision",
    "fact",
    "legacy",
  ]);
  const allowedClasses = new Set([
    "derived",
    "observed",
    "reported",
    "unverified",
  ]);
  const openBlockers = new Map();
  const resolutions = new Set();
  const records = [];

  for (const entry of entries) {
    if (!exactKeys(entry, EVIDENCE_V2_ENTRY_KEYS)) {
      findings.push("EVIDENCE_ENTRY_KEYS_INVALID");
    }
    if (typeof entry?.evidence_id !== "string" || !SAFE_ID.test(entry.evidence_id)) {
      findings.push("EVIDENCE_ID_INVALID");
    }
    if (!lotIds.has(entry?.lot_id)) findings.push("EVIDENCE_LOT_REFERENCE_MISSING");
    if (!allowedKinds.has(entry?.kind)) findings.push("EVIDENCE_KIND_INVALID");
    if (!allowedClasses.has(entry?.class)) findings.push("EVIDENCE_CLASS_INVALID");
    if (typeof entry?.statement !== "string" || entry.statement.trim() === "") {
      findings.push("EVIDENCE_STATEMENT_MISSING");
    }
    if (!Array.isArray(entry?.artifact_refs)) {
      findings.push("EVIDENCE_ARTIFACT_REFS_NOT_ARRAY");
    } else {
      if (entry.artifact_refs.length > 8) findings.push("EVIDENCE_ARTIFACT_REFS_LIMIT_EXCEEDED");
      const paths = [];
      for (const reference of entry.artifact_refs) {
        if (!exactKeys(reference, EVIDENCE_V2_REF_KEYS)) {
          findings.push("EVIDENCE_ARTIFACT_REF_INVALID");
          continue;
        }
        try {
          paths.push(normalizeProjectArtifactPath(reference.path));
        } catch {
          findings.push("EVIDENCE_ARTIFACT_REF_INVALID");
        }
        const hasDigest = SHA256.test(reference.sha256 ?? "");
        const hasLength = Number.isSafeInteger(reference.byte_length) && reference.byte_length >= 0;
        const unresolvedLegacy = entry.kind === "legacy" &&
          reference.sha256 === null && reference.byte_length === null;
        if ((!hasDigest || !hasLength) && !unresolvedLegacy) {
          findings.push("EVIDENCE_ARTIFACT_REF_INVALID");
        }
      }
      if (new Set(paths).size !== paths.length) {
        findings.push("EVIDENCE_ARTIFACT_REF_DUPLICATE");
      }
    }
    if (!Array.isArray(entry?.validation)) findings.push("EVIDENCE_VALIDATION_NOT_ARRAY");
    if (!Array.isArray(entry?.limitations)) findings.push("EVIDENCE_LIMITATIONS_NOT_ARRAY");

    const freshness = Array.isArray(entry?.artifact_refs)
      ? entry.artifact_refs.map((reference) => referenceFreshness(reference, artifacts))
      : [];
    const supportEligible = new Set(["fact", "legacy"]).has(entry?.kind);
    const supported =
      supportEligible &&
      new Set(["derived", "observed"]).has(entry?.class) &&
      freshness.length > 0 &&
      freshness.every((status) => status === "fresh") &&
      Array.isArray(entry?.validation) &&
      entry.validation.length > 0;
    if (
      entry?.kind === "fact" &&
      new Set(["derived", "observed"]).has(entry?.class) &&
      !supported
    ) {
      findings.push("EVIDENCE_SUPPORT_MISSING");
    }

    if (entry?.kind === "blocker") {
      if (entry.resolves !== null) findings.push("EVIDENCE_RESOLUTION_INVALID");
      openBlockers.set(entry.evidence_id, entry);
    } else if (entry?.kind === "blocker_resolution") {
      const target = openBlockers.get(entry.resolves);
      if (
        typeof entry.resolves !== "string" ||
        !target ||
        target.lot_id !== entry.lot_id ||
        resolutions.has(entry.resolves)
      ) {
        findings.push("EVIDENCE_BLOCKER_RESOLUTION_INVALID");
      } else {
        resolutions.add(entry.resolves);
        openBlockers.delete(entry.resolves);
      }
    } else if (entry?.resolves !== null) {
      findings.push("EVIDENCE_RESOLUTION_INVALID");
    }

    records.push({
      evidence_id: entry?.evidence_id,
      lot_id: entry?.lot_id,
      kind: entry?.kind,
      statement: entry?.statement,
      class: entry?.class,
      freshness,
      supported,
    });
  }

  const freshnessCounts = { fresh: 0, missing: 0, stale: 0, unknown: 0 };
  for (const record of records) {
    for (const status of record.freshness) {
      if (status === "fresh") freshnessCounts.fresh += 1;
      else if (status === "missing") freshnessCounts.missing += 1;
      else if (status === "stale") freshnessCounts.stale += 1;
      else freshnessCounts.unknown += 1;
    }
  }
  return deepFreeze({
    records,
    decisions: records.filter((item) => item.kind === "decision"),
    open_blockers: [...openBlockers.values()].map((item) => ({
      evidence_id: item.evidence_id,
      lot_id: item.lot_id,
      statement: item.statement,
    })),
    freshness: freshnessCounts,
  });
}
