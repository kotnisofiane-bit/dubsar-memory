import {
  WORKBENCH_AUTHORITY,
  WorkbenchError,
  deepFreeze,
  rootDigest,
  resolveLimits,
} from "./contracts.mjs";
import { evaluateAuditSnapshot } from "./audit.mjs";
import { buildWorkbenchGraph } from "./graph-model.mjs";
import { locateWorkspace } from "./locate.mjs";
import { evaluateProjectSnapshot } from "./project.mjs";
import { readReviewLedger } from "./review-ledger.mjs";
import {
  captureWorkspaceSnapshot,
  snapshotWorkspace,
} from "./snapshot.mjs";
import { buildWorkbenchView } from "./view-model.mjs";
import { MAX_PROJECTS } from "./project-registry.mjs";
import { createProjectRegistry } from "./project-registry.mjs";
import { buildProjectResumeCapsule } from "../../dubsar-project-continuity/runtime/capsule.mjs";
import {
  buildProjectHistory,
  buildProjectLotsView,
} from "../../dubsar-project-continuity/runtime/continuity-views.mjs";
import {
  buildMemoryRoute,
  detectWorkspaceMode,
  inspectWorkspace as inspectContinuityWorkspace,
  locateProjectWorkspace,
} from "../../dubsar-project-continuity/runtime/index.mjs";
import { MEMORY_MAX_CHECKPOINTS } from "../../dubsar-project-continuity/runtime/memory-vnext-contracts.mjs";

export const WORKBENCH_CATALOG_FORMAT = "dubsar.workbench-catalog/1";
export const WORKBENCH_CONTINUITY_DATA_FORMAT =
  "dubsar.workbench-continuity-data/3";

function reviewSummary(reviewLedger) {
  if (reviewLedger === null) {
    return {
      status: "not_included",
      valid_count: 0,
      omitted_count: 0,
      receipt_set_sha256: null,
    };
  }
  return {
    status: reviewLedger.ledger.status,
    valid_count: reviewLedger.ledger.valid_count ?? 0,
    omitted_count: reviewLedger.ledger.omitted_count ?? 0,
    receipt_set_sha256: reviewLedger.ledger.receipt_set_sha256,
  };
}

function availableEntry(projectId, inspection, reviewLedger) {
  const { view, graph } = inspection;
  const primaryBlocker = view.blockers.at(0) ?? null;
  return {
    project_id: projectId,
    capture_status: "available",
    source_kind: "local_project",
    source_id: view.source.id,
    snapshot_sha256: view.source.snapshot_sha256,
    title: view.overview.title,
    integrity: {
      status: view.integrity.status,
      diagnostic_codes: view.integrity.diagnostics.map((item) => item.code),
    },
    readiness: {
      status: view.readiness.status,
      reason_codes: [...view.readiness.reasons],
    },
    primary_blocker: primaryBlocker === null
      ? null
      : {
          code: primaryBlocker.code,
          severity: primaryBlocker.severity,
          title: primaryBlocker.title,
        },
    next_action: {
      code: view.next_action.code,
      label: view.next_action.label,
    },
    review_summary: reviewSummary(reviewLedger),
    view,
    graph,
  };
}

function unavailableEntry(projectId, code, includeReviews) {
  return {
    project_id: projectId,
    capture_status: "unavailable",
    source_kind: "local_project",
    source_id: null,
    snapshot_sha256: null,
    title: "Projet indisponible",
    integrity: { status: "unknown", diagnostic_codes: [code] },
    readiness: { status: "unknown", reason_codes: ["PROJECT_UNAVAILABLE"] },
    primary_blocker: {
      code: "PROJECT_UNAVAILABLE",
      severity: "error",
      title: "Le dossier du projet doit etre verifie",
    },
    next_action: {
      code: "verify_project_root",
      label: "Verifier le dossier du projet",
    },
    review_summary: reviewSummary(includeReviews ? {
      ledger: {
        status: "unavailable",
        valid_count: 0,
        omitted_count: 0,
        receipt_set_sha256: null,
      },
    } : null),
    view: null,
    graph: null,
  };
}

async function inspectEntry(entry, { includeReviews, limits, producer }) {
  try {
    const continuityLocation = await locateProjectWorkspace({
      start: entry.root,
      maxParents: limits.maxParents,
    });
    if (continuityLocation.marker === ".dubsar") {
      const continuityInspection = await inspectContinuityWorkspace({
        start: entry.root,
        domain: "project",
        limits,
      });
      const { snapshot, evaluation } = continuityInspection;
      const view = buildWorkbenchView({ snapshot, evaluation, limits, producer });
      const graph = buildWorkbenchGraph({ snapshot, view, limits });
      const inspection = {
        ...continuityInspection,
        view,
        graph,
      };
      return {
        catalog_entry: availableEntry(entry.project_id, inspection, null),
        inspection,
      };
    }
    const location = await locateWorkspace({
      start: entry.root,
      domain: "project",
      maxParents: limits.maxParents,
    });
    const workspaceMode = await detectWorkspaceMode(location.root);
    const captured = workspaceMode === "lite"
      ? null
      : includeReviews
        ? await captureWorkspaceSnapshot(location, limits)
        : { snapshot: await snapshotWorkspace(location, limits) };
    const liteInspection = workspaceMode === "lite"
      ? await inspectContinuityWorkspace({ start: entry.root, domain: "project", limits })
      : null;
    const snapshot = liteInspection?.snapshot ?? captured.snapshot;
    const evaluation = liteInspection?.evaluation ?? (snapshot.domain === "project"
      ? evaluateProjectSnapshot(snapshot)
      : evaluateAuditSnapshot(snapshot));
    const view = buildWorkbenchView({ snapshot, evaluation, limits, producer });
    const graph = buildWorkbenchGraph({ snapshot, view, limits });
    let reviewLedger = null;
    if (includeReviews) {
      reviewLedger = await readReviewLedger(location.root, {
        domain: snapshot.domain,
        context_id: evaluation.id,
        canonical_root_sha256: captured?.canonical_root_sha256 ?? rootDigest(snapshot.files),
        snapshot_sha256: snapshot.snapshot_sha256,
      });
    }
    const inspection = { snapshot, evaluation, view, graph };
    return {
      catalog_entry: availableEntry(entry.project_id, inspection, reviewLedger),
      inspection,
    };
  } catch (error) {
    const code = error instanceof WorkbenchError
      ? error.code
      : "PROJECT_CAPTURE_FAILED";
    return {
      catalog_entry: unavailableEntry(entry.project_id, code, includeReviews),
      inspection: null,
    };
  }
}

function catalogSummary(projects) {
  return {
    total: projects.length,
    available: projects.filter((item) => item.capture_status === "available").length,
    unavailable: projects.filter((item) => item.capture_status === "unavailable").length,
    ready: projects.filter((item) => item.readiness.status === "ready").length,
    action_required: projects.filter(
      (item) => item.capture_status === "available" && item.readiness.status !== "ready",
    ).length,
  };
}

function continuityRoutes() {
  return {
    resume: { auto_execute: false, human_parameters: [] },
    choose_work: { auto_execute: false, human_parameters: ["lot_id"] },
    review_history: { auto_execute: false, human_parameters: [] },
    find_precedent: {
      auto_execute: false,
      human_parameters: ["lot_id_or_reference"],
    },
  };
}

function memoryWorkHistory(inspection, capsule) {
  const allEntries = inspection.snapshot.documents.checkpoints.entries;
  const indexedById = new Map(allEntries.map((entry, recordIndex) => [
    entry.checkpoint_id,
    { entry, recordIndex },
  ]));
  const selected = capsule.recorded_continuity
    .map((item) => ({ capsule: item, indexed: indexedById.get(item.checkpoint_id) }))
    .filter((item) => item.indexed !== undefined)
    .reverse();
  const selectedWorkId = capsule.active_work?.work_id ?? null;
  const selectedWorkCount = selectedWorkId === null
    ? 0
    : allEntries.filter((entry) => entry.work_id === selectedWorkId).length;
  return {
    format: "dubsar.project-history/1",
    authority: WORKBENCH_AUTHORITY,
    source: {
      mission_id: inspection.evaluation.id,
      snapshot_sha256: inspection.snapshot.snapshot_sha256,
      evidence_format: inspection.snapshot.documents.checkpoints.format,
    },
    order: { basis: "recorded_index", direction: "newest_first", is_chronology: false },
    page: {
      limit: 8,
      before_index: null,
      next_before_index: selectedWorkCount > selected.length
        ? selected.at(-1)?.indexed.recordIndex ?? null
        : null,
    },
    entries: selected.map(({ capsule: item, indexed: { entry, recordIndex } }) => ({
      record_index: recordIndex,
      evidence_id: item.checkpoint_id,
      lot_id: item.work_id,
      type: item.kind,
      class: entry.references.length > 0 ? "observed" : "reported",
      support: entry.references.length > 0 ? "supported" : "unsupported",
      freshness: entry.references.length > 0 ? "unknown" : "none",
      statement: item.summary,
    })),
  };
}

function continuityProjection(inspection, producer) {
  const capsule = buildProjectResumeCapsule({ inspection, producer });
  const memoryRoute = buildMemoryRoute({ inspection });
  const lots = buildProjectLotsView({ inspection });
  if (lots.lots.length > 256) {
    throw new WorkbenchError("CONTINUITY_VIEW_LIMIT_EXCEEDED");
  }
  const snapshotSha256 = inspection.snapshot.snapshot_sha256;
  const memoryVnext = inspection.snapshot.workspace_mode === "memory_vnext";
  const history = memoryVnext
    ? memoryWorkHistory(inspection, capsule)
    : buildProjectHistory({ inspection, limit: 8 });
  const workspaceMode = memoryVnext
    ? "memory_vnext"
    : inspection.snapshot.workspace_mode === "lite" ? "lite" : "legacy";
  const freshnessCounts = memoryVnext
    ? { ...inspection.evaluation.continuity.freshness }
    : { ...capsule.evidence.freshness };
  const freshnessTotal = Object.values(freshnessCounts).reduce((sum, value) => sum + value, 0);
  const freshnessStatus = freshnessTotal === 0
    ? "unknown"
    : freshnessCounts.stale > 0
      ? "stale"
      : freshnessCounts.missing > 0
        ? "missing"
        : freshnessCounts.unknown > 0
          ? "unknown"
          : "fresh";
  const declaredLots = memoryVnext
    ? inspection.snapshot.documents.works
    : inspection.snapshot.workspace_mode === "lite"
      ? []
      : inspection.snapshot.documents["lots.json"]?.lots ?? [];
  const evidenceDocument = memoryVnext
    ? inspection.snapshot.documents.checkpoints
    : inspection.snapshot.workspace_mode === "lite"
      ? inspection.snapshot.documents["checkpoints.json"] ?? {}
      : inspection.snapshot.documents["evidence.json"] ?? {};
  const evidenceEntries = memoryVnext
    ? history.entries.map((item) => evidenceDocument.entries
        .find((entry) => entry.checkpoint_id === item.evidence_id))
        .filter(Boolean)
    : Array.isArray(evidenceDocument.entries)
      ? evidenceDocument.entries.slice(-8).reverse()
      : [];
  const health = memoryVnext
    ? {
        work_scope: inspection.evaluation.memory.selected_work?.scope ?? null,
        stagnation: inspection.evaluation.memory.selected_work === null
          ? "not_applicable"
          : inspection.evaluation.memory.repeated_attempt
            ? "detected"
            : "clear",
        checkpoint_count: inspection.snapshot.documents.checkpoints.entries.length,
        checkpoint_capacity: MEMORY_MAX_CHECKPOINTS,
      }
    : null;
  if (
    capsule.project.snapshot_sha256 !== snapshotSha256 ||
    lots.source.snapshot_sha256 !== snapshotSha256 ||
    history.source.snapshot_sha256 !== snapshotSha256 ||
    memoryRoute.source.snapshot_sha256 !== snapshotSha256 ||
    memoryRoute.source.workspace_mode !== workspaceMode ||
    inspection.view.source.snapshot_sha256 !== snapshotSha256 ||
    inspection.graph.source_snapshot_sha256 !== snapshotSha256
  ) {
    throw new WorkbenchError("CATALOG_SNAPSHOT_MISMATCH");
  }
  return {
    source: {
      project_id: capsule.project.project_id,
      snapshot_sha256: snapshotSha256,
      workspace_mode: workspaceMode,
    },
    health,
    capsule,
    freshness: { status: freshnessStatus, counts: freshnessCounts },
    lots,
    lot_dependencies: declaredLots.map((lot) => ({
      lot_id: memoryVnext ? lot.work_id : lot.lot_id,
      depends_on: [...(lot.depends_on ?? [])],
    })),
    history,
    evidence_details: evidenceEntries.map((entry) => ({
      evidence_id: entry.evidence_id ?? entry.checkpoint_id,
      lot_id: entry.lot_id ?? entry.work_id ?? null,
      references: (entry.artifact_refs ?? entry.references ?? []).slice(0, 8).map((reference) =>
        typeof reference === "string"
          ? { path: reference, sha256: null }
          : { path: reference.path, sha256: reference.sha256 }),
    })),
    decisions: (memoryVnext
      ? inspection.evaluation.continuity.decisions
      : capsule.decisions).slice(0, 5).map((item) => ({ ...item })),
    blockers: capsule.blockers.map((item) => ({ ...item })),
    memory_route: memoryRoute,
    routes: continuityRoutes(),
  };
}

async function inspectCatalogEntries({
  entries,
  includeReviews,
  limits: limitOverrides,
  producer,
}) {
  if (!Array.isArray(entries) || entries.length === 0 || entries.length > MAX_PROJECTS) {
    throw new WorkbenchError("CATALOG_INPUT_INVALID");
  }
  let normalizedEntries;
  try {
    normalizedEntries = createProjectRegistry(entries).projects;
  } catch {
    throw new WorkbenchError("CATALOG_INPUT_INVALID");
  }
  if (
    !producer ||
    typeof producer.name !== "string" ||
    typeof producer.version !== "string"
  ) {
    throw new WorkbenchError("CATALOG_INPUT_INVALID");
  }
  const limits = resolveLimits(limitOverrides);
  const inspected = [];
  for (const entry of normalizedEntries) {
    inspected.push(await inspectEntry(entry, { includeReviews, limits, producer }));
  }
  return { inspected, producer };
}

export async function inspectProjectCatalog({
  entries,
  includeReviews = true,
  limits: limitOverrides,
  producer,
} = {}) {
  const { inspected } = await inspectCatalogEntries({
    entries, includeReviews, limits: limitOverrides, producer,
  });
  const projects = inspected.map((item) => item.catalog_entry);
  return deepFreeze({
    format: WORKBENCH_CATALOG_FORMAT,
    authority: WORKBENCH_AUTHORITY,
    producer: { name: producer.name, version: producer.version },
    summary: catalogSummary(projects),
    projects,
  });
}

export async function inspectProjectContinuityCatalog({
  entries,
  includeReviews = true,
  limits: limitOverrides,
  producer,
} = {}) {
  const { inspected } = await inspectCatalogEntries({
    entries, includeReviews, limits: limitOverrides, producer,
  });
  const projects = inspected.map(({ catalog_entry: catalogEntry, inspection }) => {
    if (inspection === null) return { ...catalogEntry, continuity: null };
    try {
      return {
        ...catalogEntry,
        continuity: continuityProjection(inspection, producer),
      };
    } catch {
      return {
        ...unavailableEntry(
          catalogEntry.project_id,
          "CONTINUITY_PROJECTION_FAILED",
          includeReviews,
        ),
        continuity: null,
      };
    }
  });
  return deepFreeze({
    format: WORKBENCH_CONTINUITY_DATA_FORMAT,
    authority: WORKBENCH_AUTHORITY,
    producer: { name: producer.name, version: producer.version },
    summary: catalogSummary(projects),
    projects,
  });
}
