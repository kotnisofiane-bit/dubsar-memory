import {
  WorkbenchError,
  deepFreeze,
  sha256Bytes,
  stableJson,
} from "./contracts.mjs";
import {
  PROJECT_EVIDENCE_V1_FORMAT,
  normalizeProjectArtifactPath,
} from "./continuity.mjs";

const SHA256 = /^[0-9a-f]{64}$/u;

function stateDigest(value) {
  return value === null
    ? null
    : sha256Bytes(Buffer.from(stableJson(value), "utf8"));
}

function liteRecords(inspection) {
  return inspection.snapshot.documents["checkpoints.json"].entries.map((entry, index) => ({
    record_index: index,
    record_id: entry.checkpoint_id,
    lot_id: null,
    kind: entry.kind,
    references: entry.references.map((item) => ({ path: item.path, sha256: item.sha256 })),
    resulting_state_sha256: stateDigest(entry.resulting_state),
    resulting_status: entry.resulting_state.status,
    blocker_count: entry.resulting_state.blockers.length,
    limitation_count: entry.limitations.length,
    resolves: entry.resolves,
  }));
}

function memoryRecords(inspection, scope) {
  const selectedWorkId = inspection.evaluation.memory.selected_work?.work_id ?? null;
  if (scope === "selected" && selectedWorkId === null) return [];
  return inspection.snapshot.documents.checkpoints.entries
    .map((entry, recordIndex) => ({ entry, recordIndex }))
    .filter(({ entry }) => scope === "all" || entry.work_id === selectedWorkId)
    .map(({ entry, recordIndex }) => ({
      record_index: recordIndex,
      record_id: entry.checkpoint_id,
      lot_id: entry.work_id,
      kind: entry.kind,
      references: entry.references.map((item) => ({ path: item.path, sha256: item.sha256 })),
      resulting_state_sha256: stateDigest(entry.resulting_state),
      resulting_status: entry.resulting_state.status,
      blocker_count: entry.resulting_state.blockers.length,
      limitation_count: entry.limitations.length,
      resolves: entry.resolves,
    }));
}

function legacyReferences(entry, legacy) {
  const values = Array.isArray(entry?.artifact_refs) ? entry.artifact_refs : [];
  return values.flatMap((reference) => {
    const rawPath = legacy ? reference : reference?.path;
    try {
      return [{
        path: normalizeProjectArtifactPath(rawPath),
        sha256: legacy || !SHA256.test(reference?.sha256 ?? "") ? null : reference.sha256,
      }];
    } catch {
      return [];
    }
  });
}

function legacyRecords(inspection) {
  const document = inspection.snapshot.documents["evidence.json"];
  const legacy = document?.format === PROJECT_EVIDENCE_V1_FORMAT;
  return (document?.entries ?? []).map((entry, index) => ({
    record_index: index,
    record_id: entry.evidence_id,
    lot_id: entry.lot_id ?? null,
    kind: legacy ? "legacy" : entry.kind,
    references: legacyReferences(entry, legacy),
    resulting_state_sha256: null,
    resulting_status: null,
    blocker_count: 0,
    limitation_count: 0,
    resolves: legacy ? null : entry.resolves ?? null,
  }));
}

export function deriveContinuityFacts({ inspection, memoryRecordScope = "selected" } = {}) {
  if (!inspection?.snapshot?.documents || !inspection?.evaluation) {
    throw new WorkbenchError("PROJECT_INSPECTION_REQUIRED");
  }
  if (!new Set(["all", "selected"]).has(memoryRecordScope)) {
    throw new WorkbenchError("MEMORY_RECORD_SCOPE_INVALID");
  }
  const workspaceMode = inspection.snapshot.workspace_mode === "memory_vnext"
    ? "memory_vnext"
    : inspection.snapshot.workspace_mode === "lite" ? "lite" : "legacy";
  const records = workspaceMode === "memory_vnext"
    ? memoryRecords(inspection, memoryRecordScope)
    : workspaceMode === "lite" ? liteRecords(inspection) : legacyRecords(inspection);
  const current = workspaceMode === "memory_vnext"
    ? inspection.evaluation.memory.current_state
    : workspaceMode === "lite" ? inspection.evaluation.lite.current_state : null;
  return deepFreeze({
    source: {
      project_id: inspection.evaluation.id,
      snapshot_sha256: inspection.snapshot.snapshot_sha256,
      workspace_mode: workspaceMode,
    },
    integrity_status: inspection.evaluation.integrity.status,
    readiness_status: inspection.evaluation.readiness.status,
    work_state: current === null
      ? { status: "unknown", blocker_count: inspection.evaluation.continuity?.open_blockers?.length ?? 0 }
      : { status: current.status, blocker_count: current.blockers.length },
    guidance_hints: workspaceMode === "memory_vnext"
      ? {
          scope: inspection.evaluation.memory.selected_work?.scope ?? null,
          selected_work_id: inspection.evaluation.memory.selected_work?.work_id ?? null,
          open_work_count: inspection.evaluation.memory.work_items.filter((item) => item.status !== "complete").length,
        }
      : { scope: null, selected_work_id: null, open_work_count: 0 },
    repeated_attempt: inspection.evaluation.lite?.repeated_attempt === true ||
      inspection.evaluation.memory?.repeated_attempt === true,
    records,
  });
}

export function exactRelationBases(anchor, candidate) {
  const anchorPaths = new Set(anchor.references.map((item) => item.path));
  const basis = [];
  if (candidate.references.some((item) => anchorPaths.has(item.path))) {
    basis.push("same_reference");
  }
  if (
    anchor.resulting_state_sha256 !== null &&
    anchor.resulting_state_sha256 === candidate.resulting_state_sha256
  ) {
    basis.push("same_resulting_state");
  }
  if (anchor.resolves === candidate.record_id) basis.push("explicit_resolution");
  return basis;
}

export function deriveExactRelations(facts, { limit = 3 } = {}) {
  const anchor = facts.records.at(-1);
  if (!anchor) {
    return deepFreeze({ basis: "exact_only", matches: [] });
  }
  const matches = [];
  for (let index = facts.records.length - 2; index >= 0 && matches.length < limit; index -= 1) {
    const candidate = facts.records.at(index);
    const basis = exactRelationBases(anchor, candidate);
    if (basis.length > 0) matches.push({ record_id: candidate.record_id, basis });
  }
  return deepFreeze({ basis: "exact_only", matches });
}

export function findExactPrecedentRecords(facts, { lotId, referencePath, limit = 3 }) {
  const hasLot = lotId !== undefined;
  const hasReference = referencePath !== undefined;
  if (hasLot === hasReference) throw new WorkbenchError("PRECEDENT_SELECTOR_INVALID");
  const queryDigests = new Set();
  if (hasReference) {
    for (const record of facts.records) {
      for (const reference of record.references) {
        if (reference.path === referencePath && reference.sha256 !== null) {
          queryDigests.add(reference.sha256);
        }
      }
    }
  }
  const direct = new Map();
  for (const record of facts.records) {
    const basis = [];
    if (hasLot && record.lot_id === lotId) basis.push("same_lot");
    if (hasReference) {
      if (record.references.some((item) => item.path === referencePath)) {
        basis.push("same_reference");
      }
      if (
        queryDigests.size > 0 &&
        record.references.some((item) => item.sha256 !== null && queryDigests.has(item.sha256))
      ) {
        basis.push("identical_digest");
      }
    }
    if (basis.length > 0) direct.set(record.record_index, basis);
  }
  const directIds = new Set([...direct.keys()].map(
    (index) => facts.records.at(index)?.record_id,
  ));
  for (const record of facts.records) {
    if (record.resolves !== null && directIds.has(record.resolves)) {
      direct.set(record.record_index, [
        ...new Set([...(direct.get(record.record_index) ?? []), "resolves"]),
      ]);
    }
  }
  return [...direct.entries()]
    .sort(([left], [right]) => right - left)
    .slice(0, limit)
    .map(([recordIndex, matchBasis]) => ({ record_index: recordIndex, match_basis: matchBasis }));
}
