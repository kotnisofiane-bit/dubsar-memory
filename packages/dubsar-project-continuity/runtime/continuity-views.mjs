import {
  WORKBENCH_AUTHORITY,
  WorkbenchError,
  deepFreeze,
} from "./contracts.mjs";
import {
  PROJECT_EVIDENCE_V1_FORMAT,
  PROJECT_EVIDENCE_V2_FORMAT,
  normalizeProjectArtifactPath,
} from "./continuity.mjs";
import { safeDisplayText } from "./display-safety.mjs";
import {
  buildLiteHistory,
  buildLiteLotsView,
  buildLitePrecedents,
} from "./lite.mjs";
import {
  deriveContinuityFacts,
  findExactPrecedentRecords,
} from "./continuity-facts.mjs";

export const PROJECT_HISTORY_FORMAT = "dubsar.project-history/1";
export const PROJECT_LOTS_VIEW_FORMAT = "dubsar.project-lots-view/1";
export const PROJECT_PRECEDENTS_FORMAT = "dubsar.project-precedents/1";

const MAX_HISTORY_PAGE = 32;
const MAX_PRECEDENTS = 3;
const SAFE_ID = /^[a-z0-9][a-z0-9._-]{2,127}$/iu;
const ACTIVE_INSTRUCTION =
  /\b(?:ignore|disregard|override)\b.{0,40}\b(?:instruction|prompt|policy|rule)s?\b|<\|(?:system|assistant|user|im_end)\|>|```|(?:^|\n)\s*(?:system|assistant|developer)\s*:|\b(?:when|once)\b.{0,60}\b(?:resum(?:e|ed)|loaded|opened)\b.{0,60}\b(?:run|execute|deploy|publish|merge|delete|send)\b|\b(?:run|execute|deploy|publish|merge|delete|send)\b.{0,40}\bautomatically\b/iu;

function assertProjectInspection(inspection) {
  if (
    !inspection || inspection.snapshot?.domain !== "project" ||
    !inspection.snapshot.documents || !inspection.evaluation
  ) {
    throw new WorkbenchError("PROJECT_INSPECTION_REQUIRED");
  }
}

function safeId(value) {
  return typeof value === "string" && SAFE_ID.test(value) ? value : "unavailable";
}

function projectText(value, maxChars = 500) {
  const display = safeDisplayText(value, maxChars);
  if (display.redacted || ACTIVE_INSTRUCTION.test(display.text)) {
    return "[content withheld]";
  }
  return display.text || "Unavailable";
}

function aggregateFreshness(values, unavailable = false) {
  if (unavailable) return "unavailable";
  if (!Array.isArray(values) || values.length === 0) return "none";
  const unique = new Set(values);
  if (unique.size === 1) return [...unique][0];
  return "mixed";
}

function historyRecord(entry, recordIndex, evaluated, evidenceFormat) {
  const legacy = evidenceFormat === PROJECT_EVIDENCE_V1_FORMAT;
  return {
    record_index: recordIndex,
    evidence_id: safeId(entry?.evidence_id),
    lot_id: safeId(entry?.lot_id),
    type: legacy ? "legacy" : projectText(entry?.kind, 40).toLowerCase(),
    class: projectText(entry?.class, 40).toLowerCase(),
    support: legacy
      ? "unavailable"
      : evaluated?.supported === true ? "supported" : "unsupported",
    freshness: aggregateFreshness(evaluated?.freshness, legacy),
    statement: projectText(legacy ? entry?.claim : entry?.statement),
  };
}

export function buildProjectHistory({ inspection, before, limit = MAX_HISTORY_PAGE }) {
  if (inspection?.snapshot?.workspace_mode === "memory_vnext") {
    assertProjectInspection(inspection);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_HISTORY_PAGE) {
      throw new WorkbenchError("HISTORY_PAGE_LIMIT_INVALID");
    }
    const entries = inspection.snapshot.documents.checkpoints.entries;
    const boundary = before === undefined ? entries.length : before;
    if (!Number.isSafeInteger(boundary) || boundary < 0 || boundary > entries.length) {
      throw new WorkbenchError("HISTORY_CURSOR_INVALID");
    }
    const selected = entries.map((entry, recordIndex) => ({ entry, recordIndex }))
      .filter(({ recordIndex }) => recordIndex < boundary).slice(-limit).reverse();
    return deepFreeze({
      format: PROJECT_HISTORY_FORMAT,
      authority: WORKBENCH_AUTHORITY,
      source: {
        mission_id: inspection.evaluation.id,
        snapshot_sha256: inspection.snapshot.snapshot_sha256,
        evidence_format: inspection.snapshot.documents.checkpoints.format,
      },
      order: { basis: "recorded_index", direction: "newest_first", is_chronology: false },
      page: {
        limit,
        before_index: before ?? null,
        next_before_index: selected.length === limit && selected.at(-1).recordIndex > 0
          ? selected.at(-1).recordIndex : null,
      },
      entries: selected.map(({ entry, recordIndex }) => ({
        record_index: recordIndex,
        evidence_id: entry.checkpoint_id,
        lot_id: entry.work_id,
        type: entry.kind,
        class: entry.references.length > 0 ? "observed" : "reported",
        support: entry.references.length > 0 ? "supported" : "unsupported",
        freshness: entry.references.length > 0 ? "unknown" : "none",
        statement: projectText(entry.summary),
      })),
    });
  }
  if (inspection?.snapshot?.workspace_mode === "lite") {
    return buildLiteHistory({ inspection, before, limit });
  }
  assertProjectInspection(inspection);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_HISTORY_PAGE) {
    throw new WorkbenchError("HISTORY_PAGE_LIMIT_INVALID");
  }
  const document = inspection.snapshot.documents["evidence.json"];
  const entries = Array.isArray(document?.entries) ? document.entries : [];
  const boundary = before === undefined ? entries.length : before;
  if (!Number.isSafeInteger(boundary) || boundary < 0 || boundary > entries.length) {
    throw new WorkbenchError("HISTORY_CURSOR_INVALID");
  }
  const evaluatedById = new Map(
    (inspection.evaluation.continuity?.records ?? []).map((item) => [item.evidence_id, item]),
  );
  const selected = entries
    .map((entry, recordIndex) => ({ entry, recordIndex }))
    .filter(({ recordIndex }) => recordIndex < boundary)
    .slice(-limit)
    .reverse();
  const nextBefore = selected.length === limit && selected.at(-1).recordIndex > 0
    ? selected.at(-1).recordIndex
    : null;
  return deepFreeze({
    format: PROJECT_HISTORY_FORMAT,
    authority: WORKBENCH_AUTHORITY,
    source: {
      mission_id: safeId(inspection.evaluation.id),
      snapshot_sha256: inspection.snapshot.snapshot_sha256,
      evidence_format: document?.format ?? "unsupported",
    },
    order: {
      basis: "recorded_index",
      direction: "newest_first",
      is_chronology: false,
    },
    page: {
      limit,
      before_index: before ?? null,
      next_before_index: nextBefore,
    },
    entries: selected.map(({ entry, recordIndex }) =>
      historyRecord(
        entry,
        recordIndex,
        evaluatedById.get(entry?.evidence_id),
        document?.format,
      )),
  });
}

function lotCategory({ lot, lotById, openBlockers, inspection, evidenceFormat }) {
  if (inspection.evaluation.integrity.status !== "valid") return "unknown";
  if (lot.status === "complete") return "complete";
  if (lot.status === "candidate") return "active";
  if (lot.status !== "planned") return "unknown";
  if ((lot.depends_on ?? []).some((id) => lotById.get(id)?.status !== "complete")) {
    return "waiting";
  }
  if ((openBlockers.get(lot.lot_id) ?? 0) > 0) return "blocked";
  if (evidenceFormat !== PROJECT_EVIDENCE_V2_FORMAT) return "unknown";
  return "eligible";
}

export function buildProjectLotsView({ inspection }) {
  if (inspection?.snapshot?.workspace_mode === "memory_vnext") {
    assertProjectInspection(inspection);
    const selected = inspection.evaluation.memory.selected_work?.work_id ?? null;
    const blockers = new Map();
    for (const entry of inspection.snapshot.documents.checkpoints.entries) {
      blockers.set(entry.work_id, entry.resulting_state.blockers.length);
    }
    const projected = inspection.evaluation.memory.work_items.map((work) => {
      const blockerCount = blockers.get(work.work_id) ?? 0;
      const category = work.status === "complete" ? "complete"
        : work.work_id === selected ? "active"
          : blockerCount > 0 ? "blocked"
            : work.status === "paused" ? "waiting" : "eligible";
      return {
        lot_id: work.work_id,
        title: projectText(work.title, 200),
        declared_status: work.status,
        category,
        blocker_count: blockerCount,
        dependencies_complete: true,
      };
    });
    const summary = Object.fromEntries(
      ["active", "eligible", "blocked", "waiting", "complete", "unknown"].map(
        (category) => [category, projected.filter((item) => item.category === category).length],
      ),
    );
    return deepFreeze({
      format: PROJECT_LOTS_VIEW_FORMAT,
      authority: WORKBENCH_AUTHORITY,
      source: {
        mission_id: inspection.evaluation.id,
        snapshot_sha256: inspection.snapshot.snapshot_sha256,
        evidence_format: inspection.snapshot.documents.checkpoints.format,
      },
      order: { basis: "declared_order", automatic_selection: false },
      summary,
      lots: projected,
    });
  }
  if (inspection?.snapshot?.workspace_mode === "lite") {
    return buildLiteLotsView({ inspection });
  }
  assertProjectInspection(inspection);
  const document = inspection.snapshot.documents["lots.json"];
  const evidenceFormat = inspection.snapshot.documents["evidence.json"]?.format;
  const lots = Array.isArray(document?.lots) ? document.lots : [];
  const lotById = new Map(lots.map((lot) => [lot?.lot_id, lot]));
  const openBlockers = new Map();
  for (const blocker of inspection.evaluation.continuity?.open_blockers ?? []) {
    openBlockers.set(blocker.lot_id, (openBlockers.get(blocker.lot_id) ?? 0) + 1);
  }
  const projected = lots.map((lot) => {
    const category = lotCategory({ lot, lotById, openBlockers, inspection, evidenceFormat });
    return {
      lot_id: safeId(lot?.lot_id),
      title: projectText(lot?.title, 200),
      declared_status: new Set(["candidate", "complete", "planned"]).has(lot?.status)
        ? lot.status
        : "unknown",
      category,
      blocker_count: openBlockers.get(lot?.lot_id) ?? 0,
      dependencies_complete: Array.isArray(lot?.depends_on) && lot.depends_on.every(
        (id) => lotById.get(id)?.status === "complete",
      ),
    };
  });
  const summary = Object.fromEntries(
    ["active", "eligible", "blocked", "waiting", "complete", "unknown"].map(
      (category) => [category, projected.filter((item) => item.category === category).length],
    ),
  );
  return deepFreeze({
    format: PROJECT_LOTS_VIEW_FORMAT,
    authority: WORKBENCH_AUTHORITY,
    source: {
      mission_id: safeId(inspection.evaluation.id),
      snapshot_sha256: inspection.snapshot.snapshot_sha256,
      evidence_format: evidenceFormat ?? "unsupported",
    },
    order: { basis: "declared_order", automatic_selection: false },
    summary,
    lots: projected,
  });
}

export function buildProjectPrecedents({ inspection, lotId, referencePath }) {
  if (inspection?.snapshot?.workspace_mode === "memory_vnext") {
    assertProjectInspection(inspection);
    const hasLot = lotId !== undefined;
    const hasReference = referencePath !== undefined;
    if (hasLot === hasReference) throw new WorkbenchError("PRECEDENT_SELECTOR_INVALID");
    if (hasLot && (typeof lotId !== "string" || !SAFE_ID.test(lotId))) {
      throw new WorkbenchError("PRECEDENT_LOT_INVALID");
    }
    const normalized = hasReference ? normalizeProjectArtifactPath(referencePath) : undefined;
    const entries = inspection.snapshot.documents.checkpoints.entries;
    const results = findExactPrecedentRecords(deriveContinuityFacts({
      inspection,
      memoryRecordScope: "all",
    }), {
      lotId,
      referencePath: normalized,
    }).slice(0, MAX_PRECEDENTS).map(({ record_index: index, match_basis }) => {
      const entry = entries.at(index);
      return {
        record_index: index,
        evidence_id: entry.checkpoint_id,
        lot_id: entry.work_id,
        type: entry.kind,
        class: entry.references.length > 0 ? "observed" : "reported",
        support: entry.references.length > 0 ? "supported" : "unsupported",
        freshness: entry.references.length > 0 ? "unknown" : "none",
        statement: projectText(entry.summary),
        match_basis,
      };
    });
    return deepFreeze({
      format: PROJECT_PRECEDENTS_FORMAT,
      authority: WORKBENCH_AUTHORITY,
      source: { mission_id: inspection.evaluation.id, snapshot_sha256: inspection.snapshot.snapshot_sha256 },
      selector: { kind: hasLot ? "lot" : "reference" },
      order: { basis: "recorded_index", direction: "newest_first", implies_relevance: false },
      results,
    });
  }
  if (inspection?.snapshot?.workspace_mode === "lite") {
    return buildLitePrecedents({ inspection, lotId, referencePath });
  }
  assertProjectInspection(inspection);
  const hasLot = lotId !== undefined;
  const hasReference = referencePath !== undefined;
  if (hasLot === hasReference) throw new WorkbenchError("PRECEDENT_SELECTOR_INVALID");
  if (hasLot && (typeof lotId !== "string" || !SAFE_ID.test(lotId))) {
    throw new WorkbenchError("PRECEDENT_LOT_INVALID");
  }
  let normalizedReference;
  if (hasReference) normalizedReference = normalizeProjectArtifactPath(referencePath);

  const document = inspection.snapshot.documents["evidence.json"];
  const legacy = document?.format === PROJECT_EVIDENCE_V1_FORMAT;
  const entries = Array.isArray(document?.entries) ? document.entries : [];
  const exactMatches = findExactPrecedentRecords(deriveContinuityFacts({ inspection }), {
    lotId,
    referencePath: normalizedReference,
  });
  const evaluatedById = new Map(
    (inspection.evaluation.continuity?.records ?? []).map((item) => [item.evidence_id, item]),
  );
  const results = exactMatches
    .slice(0, MAX_PRECEDENTS)
    .map(({ record_index: recordIndex, match_basis }) => {
      const entry = entries.at(recordIndex);
      const evaluated = evaluatedById.get(entry?.evidence_id);
      return {
        record_index: recordIndex,
        evidence_id: safeId(entry?.evidence_id),
        lot_id: safeId(entry?.lot_id),
        type: legacy ? "legacy" : projectText(entry?.kind, 40).toLowerCase(),
        class: projectText(entry?.class, 40).toLowerCase(),
        support: legacy
          ? "unavailable"
          : evaluated?.supported === true ? "supported" : "unsupported",
        freshness: aggregateFreshness(evaluated?.freshness, legacy),
        statement: projectText(legacy ? entry?.claim : entry?.statement),
        match_basis,
      };
    });
  return deepFreeze({
    format: PROJECT_PRECEDENTS_FORMAT,
    authority: WORKBENCH_AUTHORITY,
    source: {
      mission_id: safeId(inspection.evaluation.id),
      snapshot_sha256: inspection.snapshot.snapshot_sha256,
    },
    selector: { kind: hasLot ? "lot" : "reference" },
    order: {
      basis: "recorded_index",
      direction: "newest_first",
      implies_relevance: false,
    },
    results,
  });
}
