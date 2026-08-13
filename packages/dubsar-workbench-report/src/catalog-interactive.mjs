import {
  WORKBENCH_AUTHORITY,
  WorkbenchError,
  assertProjectResumeCapsule,
  buildResumeCapsule,
  exactKeys,
  sha256Bytes,
} from "../../dubsar-operator-core/src/index.mjs";
import { assertMemoryResumeCapsule } from "../../dubsar-project-continuity/runtime/index.mjs";
import {
  safeDisplayText,
  safeStructuralText,
} from "../../dubsar-operator-core/src/display-safety.mjs";
import { isProjectId } from "../../dubsar-operator-core/src/project-identifiers.mjs";
import { MAX_REPORT_BYTES, WORKBENCH_REPORT_RENDERER, escapeHtmlText, renderWorkbenchReport } from "./render.mjs";
import { INTERACTIVE_STYLE } from "./interactive-assets.mjs";
import {
  cspHash,
  encodeJsonForHtml,
  graphProjection,
  interactiveProjectView,
  memoryProjection,
} from "./interactive.mjs";
import {
  CATALOG_INTERACTIVE_SCRIPT,
  CATALOG_INTERACTIVE_STYLE,
} from "./catalog-interactive-assets.mjs";

export const WORKBENCH_CATALOG_INTERACTIVE_REPORT_FORMAT =
  "dubsar.workbench-catalog-interactive-report/1";
export const WORKBENCH_CATALOG_INTERACTIVE_DATA_FORMAT =
  "dubsar.workbench-catalog-interactive-data/1";
export const WORKBENCH_CONTINUITY_INTERACTIVE_REPORT_FORMAT =
  "dubsar.workbench-continuity-interactive-report/4";
export const WORKBENCH_CONTINUITY_INTERACTIVE_DATA_FORMAT =
  "dubsar.workbench-continuity-interactive-data/4";

const CATALOG_PROJECT_KEYS = Object.freeze([
  "capture_status", "graph", "integrity", "next_action", "primary_blocker",
  "project_id", "readiness", "review_summary", "snapshot_sha256",
  "source_id", "source_kind", "title", "view",
]);
const STRUCTURAL_TOKEN = /^[a-z0-9][a-z0-9._-]{1,127}$/iu;
const MAX_REVIEW_RECEIPTS = 256;
const REVIEW_STATUSES = new Set(["available", "degraded", "not_included", "unavailable"]);
const SHA256 = /^[a-f0-9]{64}$/u;

function assertSafeCatalogDisplayText(value, maxChars = 2_000) {
  if (typeof value !== "string" || value.length > maxChars) {
    throw new WorkbenchError("CATALOG_REPORT_INPUT_INVALID");
  }
  const checked = safeDisplayText(value, maxChars);
  if (checked.redacted) {
    throw new WorkbenchError("CATALOG_REPORT_SENSITIVE_TEXT");
  }
  if (checked.truncated || checked.text !== value) {
    throw new WorkbenchError("CATALOG_REPORT_INPUT_INVALID");
  }
}

function assertSafeCatalogStructuralText(value, pattern = STRUCTURAL_TOKEN) {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new WorkbenchError("CATALOG_REPORT_INPUT_INVALID");
  }
  const checked = safeStructuralText(value, 2_000);
  if (checked.redacted || checked.truncated || checked.text !== value) {
    throw new WorkbenchError("CATALOG_REPORT_SENSITIVE_TEXT");
  }
}

function sameValues(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index += 1) {
    if (left.at(index) !== right.at(index)) return false;
  }
  return true;
}

function assertReviewSummary(summary) {
  if (
    !exactKeys(summary, ["omitted_count", "receipt_set_sha256", "status", "valid_count"]) ||
    !REVIEW_STATUSES.has(summary.status) ||
    !Number.isSafeInteger(summary.valid_count) || summary.valid_count < 0 ||
    summary.valid_count > MAX_REVIEW_RECEIPTS ||
    !Number.isSafeInteger(summary.omitted_count) || summary.omitted_count < 0 ||
    summary.omitted_count > MAX_REVIEW_RECEIPTS ||
    !(summary.receipt_set_sha256 === null || /^[a-f0-9]{64}$/u.test(summary.receipt_set_sha256))
  ) {
    throw new WorkbenchError("CATALOG_REPORT_INPUT_INVALID");
  }
}

function assertProjectInput(project) {
  if (
    !exactKeys(project, CATALOG_PROJECT_KEYS) ||
    !isProjectId(project.project_id) ||
    project.source_kind !== "local_project" ||
    !new Set(["available", "unavailable"]).has(project.capture_status) ||
    !exactKeys(project.integrity, ["diagnostic_codes", "status"]) ||
    !Array.isArray(project.integrity.diagnostic_codes) ||
    project.integrity.diagnostic_codes.length > 256 ||
    !exactKeys(project.readiness, ["reason_codes", "status"]) ||
    !Array.isArray(project.readiness.reason_codes) ||
    project.readiness.reason_codes.length > 256 ||
    !exactKeys(project.next_action, ["code", "label"]) ||
    !(project.primary_blocker === null || exactKeys(
      project.primary_blocker,
      ["code", "severity", "title"],
    ))
  ) {
    throw new WorkbenchError("CATALOG_REPORT_INPUT_INVALID");
  }
  assertSafeCatalogStructuralText(project.project_id, /^[a-z0-9][a-z0-9._-]{2,63}$/u);
  assertReviewSummary(project.review_summary);
  assertSafeCatalogDisplayText(project.title);
  if (project.primary_blocker !== null) {
    assertSafeCatalogDisplayText(project.primary_blocker.title);
  }
  assertSafeCatalogDisplayText(project.next_action.label);

  if (project.capture_status === "unavailable") {
    if (
      project.source_id !== null || project.snapshot_sha256 !== null ||
      project.view !== null || project.graph !== null ||
      project.title !== "Projet indisponible" ||
      project.integrity?.status !== "unknown" ||
      project.readiness?.status !== "unknown" ||
      project.integrity.diagnostic_codes.length !== 1 ||
      !sameValues(project.readiness.reason_codes, ["PROJECT_UNAVAILABLE"]) ||
      project.primary_blocker?.code !== "PROJECT_UNAVAILABLE" ||
      project.primary_blocker?.severity !== "error" ||
      project.primary_blocker?.title !== "Le dossier du projet doit etre verifie" ||
      project.next_action.code !== "verify_project_root" ||
      project.next_action.label !== "Verifier le dossier du projet" ||
      !new Set(["not_included", "unavailable"]).has(project.review_summary.status) ||
      project.review_summary.valid_count !== 0 ||
      project.review_summary.omitted_count !== 0 ||
      project.review_summary.receipt_set_sha256 !== null
    ) {
      throw new WorkbenchError("CATALOG_REPORT_INPUT_INVALID");
    }
  } else {
    renderWorkbenchReport(project.view);
    const view = project.view;
    const expectedBlocker = view.blockers.at(0) ?? null;
    const blockerMatches = expectedBlocker === null
      ? project.primary_blocker === null
      : project.primary_blocker?.code === expectedBlocker.code &&
        project.primary_blocker?.severity === expectedBlocker.severity &&
        project.primary_blocker?.title === expectedBlocker.title;
    if (
      project.source_id !== view.source.id ||
      project.snapshot_sha256 !== view.source.snapshot_sha256 ||
      project.title !== view.overview.title ||
      project.integrity?.status !== view.integrity.status ||
      !sameValues(
        project.integrity?.diagnostic_codes,
        view.integrity.diagnostics.map((item) => item.code),
      ) ||
      project.readiness?.status !== view.readiness.status ||
      !sameValues(project.readiness?.reason_codes, view.readiness.reasons) ||
      !blockerMatches ||
      project.next_action?.code !== view.next_action.code ||
      project.next_action?.label !== view.next_action.label ||
      project.graph === null
    ) {
      throw new WorkbenchError("CATALOG_REPORT_INPUT_INVALID");
    }
  }

  for (const code of project.integrity.diagnostic_codes) assertSafeCatalogStructuralText(code);
  for (const code of project.readiness.reason_codes) assertSafeCatalogStructuralText(code);
  if (project.primary_blocker !== null) {
    assertSafeCatalogStructuralText(project.primary_blocker.code);
    assertSafeCatalogStructuralText(project.primary_blocker.severity);
  }
  assertSafeCatalogStructuralText(project.next_action.code);
}

function assertProjectDisplayText(project) {
  assertSafeCatalogDisplayText(project.title);
  if (project.primary_blocker !== null) {
    assertSafeCatalogDisplayText(project.primary_blocker.title);
  }
  assertSafeCatalogDisplayText(project.next_action.label);

  if (project.view !== null) {
    assertSafeCatalogDisplayText(project.view.overview.title);
    assertSafeCatalogDisplayText(project.view.overview.summary);
    for (const blocker of project.view.blockers) {
      assertSafeCatalogDisplayText(blocker.title);
    }
    for (const decision of project.view.decisions) {
      assertSafeCatalogDisplayText(decision.label);
    }
    for (const evidence of project.view.evidence) {
      assertSafeCatalogDisplayText(evidence.statement);
    }
  }

  if (project.graph !== null) {
    for (const node of project.graph.nodes) {
      assertSafeCatalogDisplayText(node.label);
      if (node.kind === "mission" || node.kind === "decision") {
        assertSafeCatalogDisplayText(node.detail);
      } else {
        assertSafeCatalogStructuralText(node.detail);
      }
    }
  }

  if (project.capsule !== null) {
    if (project.capsule.format === "dubsar.resume-capsule/3") {
      assertSafeCatalogDisplayText(project.capsule.project.title);
      if (project.capsule.active_work !== null) {
        assertSafeCatalogDisplayText(project.capsule.active_work.title);
        assertSafeCatalogDisplayText(project.capsule.active_work.objective);
        for (const criterion of project.capsule.active_work.acceptance_criteria) {
          assertSafeCatalogDisplayText(criterion, 500);
        }
      }
      for (const knowledge of project.capsule.knowledge) {
        assertSafeCatalogDisplayText(knowledge.title, 500);
        assertSafeCatalogDisplayText(knowledge.statement, 700);
      }
      for (const checkpoint of project.capsule.recorded_continuity) {
        assertSafeCatalogDisplayText(checkpoint.summary, 500);
      }
    } else {
      assertSafeCatalogDisplayText(project.capsule.mission.title);
      assertSafeCatalogDisplayText(
        project.capsule.mission.objective ?? project.capsule.mission.desired_outcome,
      );
    }
    for (const blocker of project.capsule.blockers) {
      assertSafeCatalogDisplayText(blocker.statement ?? blocker.title);
    }
    assertSafeCatalogDisplayText(project.capsule.next_action.label);
  }
}

function baseCatalogProject(project) {
  return {
    capture_status: project.capture_status,
    graph: project.graph,
    integrity: project.integrity,
    next_action: project.next_action,
    primary_blocker: project.primary_blocker,
    project_id: project.project_id,
    readiness: project.readiness,
    review_summary: project.review_summary,
    snapshot_sha256: project.snapshot_sha256,
    source_id: project.source_id,
    source_kind: project.source_kind,
    title: project.title,
    view: project.view,
  };
}

function assertContinuityRoute(route, parameters) {
  if (
    !exactKeys(route, ["auto_execute", "human_parameters"]) ||
    route.auto_execute !== false ||
    !Array.isArray(route.human_parameters) ||
    !sameValues(route.human_parameters, parameters)
  ) {
    throw new WorkbenchError("CATALOG_REPORT_INPUT_INVALID");
  }
}

function assertLegacyMemoryRoute(memoryRoute, project) {
  if (
    !memoryRoute ||
    !exactKeys(memoryRoute, [
      "authority", "format", "maturation", "native_guidance", "reactivation",
      "resonance", "route", "source",
    ]) ||
    memoryRoute.format !== "dubsar.memory-route/1" ||
    memoryRoute.authority !== WORKBENCH_AUTHORITY ||
    !exactKeys(memoryRoute.source, ["project_id", "snapshot_sha256", "workspace_mode"]) ||
    memoryRoute.source.project_id !== project.source_id ||
    memoryRoute.source.snapshot_sha256 !== project.snapshot_sha256 ||
    !new Set(["legacy", "lite"]).has(memoryRoute.source.workspace_mode) ||
    !exactKeys(memoryRoute.route, ["auto_execute", "reason_codes", "station"]) ||
    memoryRoute.route.auto_execute !== false ||
    !new Set(["abstain", "capture", "complete", "continue", "hold", "reactivate", "reframe"])
      .has(memoryRoute.route.station) ||
    !Array.isArray(memoryRoute.route.reason_codes) ||
    memoryRoute.route.reason_codes.length < 1 || memoryRoute.route.reason_codes.length > 4 ||
    !exactKeys(memoryRoute.maturation, [
      "limitation_count", "record_count", "stage", "supported_record_count",
    ]) ||
    !new Set(["constrained", "reactivated", "recorded", "seeded", "stabilized", "supported"])
      .has(memoryRoute.maturation.stage) ||
    ![memoryRoute.maturation.limitation_count, memoryRoute.maturation.record_count,
      memoryRoute.maturation.supported_record_count]
      .every((value) => Number.isSafeInteger(value) && value >= 0 && value <= 1_024) ||
    memoryRoute.maturation.supported_record_count > memoryRoute.maturation.record_count ||
    !exactKeys(memoryRoute.resonance, ["basis", "matches", "relevance_ranking", "result"]) ||
    memoryRoute.resonance.basis !== "exact_only" ||
    memoryRoute.resonance.relevance_ranking !== false ||
    !new Set(["matched", "none"]).has(memoryRoute.resonance.result) ||
    !Array.isArray(memoryRoute.resonance.matches) || memoryRoute.resonance.matches.length > 3 ||
    (memoryRoute.resonance.result === "none") !== (memoryRoute.resonance.matches.length === 0) ||
    !exactKeys(memoryRoute.reactivation, [
      "auto_execute", "checkpoint_id", "reason_code", "status",
    ]) ||
    memoryRoute.reactivation.auto_execute !== false ||
    !new Set(["candidate", "not_applicable", "recorded"]).has(memoryRoute.reactivation.status) ||
    !(memoryRoute.reactivation.checkpoint_id === null ||
      STRUCTURAL_TOKEN.test(memoryRoute.reactivation.checkpoint_id)) ||
    !exactKeys(memoryRoute.native_guidance, ["goal", "plan"])
  ) throw new WorkbenchError("CATALOG_REPORT_INPUT_INVALID");
  for (const reason of memoryRoute.route.reason_codes) assertSafeCatalogStructuralText(reason);
  assertSafeCatalogStructuralText(memoryRoute.reactivation.reason_code);
  for (const match of memoryRoute.resonance.matches) {
    if (
      !exactKeys(match, ["basis", "checkpoint_id"]) ||
      !Array.isArray(match.basis) || match.basis.length < 1 || match.basis.length > 3 ||
      match.basis.some((basis) =>
        !new Set(["explicit_resolution", "same_reference", "same_resulting_state"]).has(basis))
    ) throw new WorkbenchError("CATALOG_REPORT_INPUT_INVALID");
    assertSafeCatalogStructuralText(match.checkpoint_id);
  }
  for (const guidance of [memoryRoute.native_guidance.goal, memoryRoute.native_guidance.plan]) {
    if (
      !exactKeys(guidance, ["reason_code", "recommendation"]) ||
      !new Set(["consider", "not_indicated"]).has(guidance.recommendation)
    ) throw new WorkbenchError("CATALOG_REPORT_INPUT_INVALID");
    assertSafeCatalogStructuralText(guidance.reason_code);
  }
}

function assertMemoryRoute(memoryRoute, project) {
  if (memoryRoute?.format === "dubsar.memory-route/1") {
    assertLegacyMemoryRoute(memoryRoute, project);
    return;
  }
  if (
    !memoryRoute ||
    !exactKeys(memoryRoute, [
      "artifact_lifecycle", "authority", "exact_relations", "format", "guidance",
      "memory_state", "native_guidance", "source",
    ]) ||
    memoryRoute.format !== "dubsar.memory-route/2" ||
    memoryRoute.authority !== WORKBENCH_AUTHORITY ||
    !exactKeys(memoryRoute.source, ["project_id", "snapshot_sha256", "workspace_mode"]) ||
    memoryRoute.source.project_id !== project.source_id ||
    memoryRoute.source.snapshot_sha256 !== project.snapshot_sha256 ||
    !new Set(["legacy", "lite", "memory_vnext"]).has(memoryRoute.source.workspace_mode) ||
    !exactKeys(memoryRoute.guidance, [
      "action", "auto_execute", "reason_codes", "related_record_id",
    ]) ||
    memoryRoute.guidance.auto_execute !== false ||
    !new Set([
      "continue", "finish_recorded", "none", "pause", "reconsider", "record",
      "resume_candidate",
    ]).has(memoryRoute.guidance.action) ||
    !Array.isArray(memoryRoute.guidance.reason_codes) ||
    memoryRoute.guidance.reason_codes.length < 1 || memoryRoute.guidance.reason_codes.length > 4 ||
    !(memoryRoute.guidance.related_record_id === null ||
      STRUCTURAL_TOKEN.test(memoryRoute.guidance.related_record_id)) ||
    !new Set([
      "closed_recorded", "empty", "limited", "recorded", "referenced", "resumed",
    ]).has(memoryRoute.memory_state) ||
    !exactKeys(memoryRoute.exact_relations, ["basis", "matches"]) ||
    memoryRoute.exact_relations.basis !== "exact_only" ||
    !Array.isArray(memoryRoute.exact_relations.matches) ||
    memoryRoute.exact_relations.matches.length > 3 ||
    !exactKeys(memoryRoute.artifact_lifecycle, [
      "authority", "auto_execute", "format", "reason_codes", "record_id", "source", "state",
    ]) ||
    memoryRoute.artifact_lifecycle.format !== "dubsar.artifact-lifecycle/1" ||
    memoryRoute.artifact_lifecycle.authority !== WORKBENCH_AUTHORITY ||
    memoryRoute.artifact_lifecycle.auto_execute !== false ||
    !new Set(["closed_recorded", "empty", "integrity_checked", "recorded"])
      .has(memoryRoute.artifact_lifecycle.state) ||
    !(memoryRoute.artifact_lifecycle.record_id === null ||
      STRUCTURAL_TOKEN.test(memoryRoute.artifact_lifecycle.record_id)) ||
    !exactKeys(memoryRoute.artifact_lifecycle.source, [
      "project_id", "snapshot_sha256", "workspace_mode",
    ]) ||
    memoryRoute.artifact_lifecycle.source.project_id !== memoryRoute.source.project_id ||
    memoryRoute.artifact_lifecycle.source.snapshot_sha256 !== memoryRoute.source.snapshot_sha256 ||
    memoryRoute.artifact_lifecycle.source.workspace_mode !== memoryRoute.source.workspace_mode ||
    !Array.isArray(memoryRoute.artifact_lifecycle.reason_codes) ||
    memoryRoute.artifact_lifecycle.reason_codes.length < 1 ||
    memoryRoute.artifact_lifecycle.reason_codes.length > 4 ||
    !exactKeys(memoryRoute.native_guidance, ["goal", "plan"])
  ) throw new WorkbenchError("CATALOG_REPORT_INPUT_INVALID");
  for (const reason of memoryRoute.guidance.reason_codes) assertSafeCatalogStructuralText(reason);
  for (const reason of memoryRoute.artifact_lifecycle.reason_codes) {
    assertSafeCatalogStructuralText(reason);
  }
  for (const match of memoryRoute.exact_relations.matches) {
    if (
      !exactKeys(match, ["basis", "record_id"]) ||
      !STRUCTURAL_TOKEN.test(match.record_id) ||
      !Array.isArray(match.basis) || match.basis.length < 1 || match.basis.length > 3 ||
      match.basis.some((basis) =>
        !new Set(["explicit_resolution", "same_reference", "same_resulting_state"]).has(basis))
    ) throw new WorkbenchError("CATALOG_REPORT_INPUT_INVALID");
  }
  for (const guidance of [memoryRoute.native_guidance.goal, memoryRoute.native_guidance.plan]) {
    if (
      !exactKeys(guidance, ["reason_code", "recommendation"]) ||
      !new Set(["consider", "not_indicated"]).has(guidance.recommendation)
    ) throw new WorkbenchError("CATALOG_REPORT_INPUT_INVALID");
    assertSafeCatalogStructuralText(guidance.reason_code);
  }
}

function assertContinuityInput(
  project,
  { requireHealth = false, requireWorkspaceMode = false } = {},
) {
  if (!exactKeys(project, [...CATALOG_PROJECT_KEYS, "continuity"])) {
    throw new WorkbenchError("CATALOG_REPORT_INPUT_INVALID");
  }
  const base = baseCatalogProject(project);
  assertProjectInput(base);
  if (project.capture_status === "unavailable") {
    if (project.continuity !== null) throw new WorkbenchError("CATALOG_REPORT_INPUT_INVALID");
    return base;
  }
  const continuity = project.continuity;
  if (
    !continuity ||
    !exactKeys(continuity, [
      "blockers", "capsule", "decisions", "evidence_details", "freshness", "history",
      ...(requireHealth ? ["health"] : []),
      "lot_dependencies", "lots", "memory_route", "routes", "source",
    ]) ||
    !exactKeys(continuity.source, requireWorkspaceMode
      ? ["project_id", "snapshot_sha256", "workspace_mode"]
      : ["project_id", "snapshot_sha256"]) ||
    continuity.source.project_id !== project.source_id ||
    continuity.source.snapshot_sha256 !== project.snapshot_sha256 ||
    (requireWorkspaceMode && !new Set(["legacy", "lite", "memory_vnext"])
      .has(continuity.source.workspace_mode)) ||
    !exactKeys(continuity.freshness, ["counts", "status"]) ||
    !new Set(["fresh", "stale", "missing", "unknown"]).has(continuity.freshness.status) ||
    !exactKeys(continuity.freshness.counts, ["fresh", "missing", "stale", "unknown"]) ||
    !Object.values(continuity.freshness.counts).every(
      (value) => Number.isSafeInteger(value) && value >= 0,
    ) ||
    !exactKeys(continuity.routes, [
      "choose_work", "find_precedent", "resume", "review_history",
    ])
  ) {
    throw new WorkbenchError("CATALOG_REPORT_INPUT_INVALID");
  }
  const memoryVnext = continuity.capsule?.format === "dubsar.resume-capsule/3";
  if (memoryVnext) assertMemoryResumeCapsule(continuity.capsule);
  else assertProjectResumeCapsule(continuity.capsule);
  if (requireHealth) {
    const healthValid = memoryVnext
      ? continuity.health !== null &&
        exactKeys(continuity.health, [
          "checkpoint_capacity", "checkpoint_count", "stagnation", "work_scope",
        ]) &&
        (continuity.health.work_scope === null || new Set([
          "bounded", "multi_step", "multi_session",
        ]).has(continuity.health.work_scope)) &&
        new Set(["clear", "detected", "not_applicable"]).has(
          continuity.health.stagnation,
        ) &&
        Number.isSafeInteger(continuity.health.checkpoint_count) &&
        continuity.health.checkpoint_count >= 0 &&
        continuity.health.checkpoint_count <= 128 &&
        continuity.health.checkpoint_capacity === 128 &&
        (continuity.capsule.active_work === null
          ? continuity.health.work_scope === null &&
            continuity.health.stagnation === "not_applicable"
          : continuity.health.work_scope !== null &&
            new Set(["clear", "detected"]).has(continuity.health.stagnation))
      : continuity.health === null;
    if (!healthValid) throw new WorkbenchError("CATALOG_REPORT_INPUT_INVALID");
  }
  if (
    continuity.capsule.project.project_id !== project.source_id ||
    continuity.capsule.project.snapshot_sha256 !== project.snapshot_sha256 ||
    (!memoryVnext && (
      continuity.capsule.evidence.freshness.fresh !== continuity.freshness.counts.fresh ||
      continuity.capsule.evidence.freshness.stale !== continuity.freshness.counts.stale ||
      continuity.capsule.evidence.freshness.missing !== continuity.freshness.counts.missing ||
      continuity.capsule.evidence.freshness.unknown !== continuity.freshness.counts.unknown
    )) ||
    (memoryVnext && continuity.memory_route?.source?.workspace_mode !== "memory_vnext") ||
    (requireWorkspaceMode && continuity.source.workspace_mode !==
      continuity.memory_route?.source?.workspace_mode) ||
    (requireWorkspaceMode && memoryVnext !== (continuity.source.workspace_mode === "memory_vnext"))
  ) {
    throw new WorkbenchError("CATALOG_REPORT_INPUT_INVALID");
  }
  assertContinuityRoute(continuity.routes.resume, []);
  assertContinuityRoute(continuity.routes.choose_work, ["lot_id"]);
  assertContinuityRoute(continuity.routes.review_history, []);
  assertContinuityRoute(continuity.routes.find_precedent, ["lot_id_or_reference"]);
  assertMemoryRoute(continuity.memory_route, project);
  const lots = continuity.lots;
  if (
    !exactKeys(lots, ["authority", "format", "lots", "order", "source", "summary"]) ||
    lots.format !== "dubsar.project-lots-view/1" ||
    !exactKeys(lots.source, ["evidence_format", "mission_id", "snapshot_sha256"]) ||
    lots.source.snapshot_sha256 !== project.snapshot_sha256 ||
    !Array.isArray(lots.lots) || lots.lots.length > 256 ||
    !exactKeys(lots.order, ["automatic_selection", "basis"]) ||
    lots.order.automatic_selection !== false || lots.order.basis !== "declared_order" ||
    !exactKeys(lots.summary, ["active", "blocked", "complete", "eligible", "unknown", "waiting"])
  ) {
    throw new WorkbenchError("CATALOG_REPORT_INPUT_INVALID");
  }
  for (const lot of lots.lots) {
    if (
      !exactKeys(lot, [
        "blocker_count", "category", "declared_status", "dependencies_complete",
        "lot_id", "title",
      ]) ||
      !STRUCTURAL_TOKEN.test(lot.lot_id) ||
      !new Set(["active", "blocked", "complete", "eligible", "unknown", "waiting"]).has(lot.category) ||
      !Number.isSafeInteger(lot.blocker_count) || lot.blocker_count < 0 ||
      typeof lot.dependencies_complete !== "boolean"
    ) throw new WorkbenchError("CATALOG_REPORT_INPUT_INVALID");
    assertSafeCatalogStructuralText(lot.lot_id);
    assertSafeCatalogDisplayText(lot.title, 500);
  }
  if (
    !Array.isArray(continuity.lot_dependencies) ||
    continuity.lot_dependencies.length !== lots.lots.length
  ) throw new WorkbenchError("CATALOG_REPORT_INPUT_INVALID");
  for (const item of continuity.lot_dependencies) {
    if (
      !exactKeys(item, ["depends_on", "lot_id"]) ||
      !STRUCTURAL_TOKEN.test(item.lot_id) ||
      !Array.isArray(item.depends_on) || item.depends_on.length > 256
    ) throw new WorkbenchError("CATALOG_REPORT_INPUT_INVALID");
    assertSafeCatalogStructuralText(item.lot_id);
    for (const dependency of item.depends_on) assertSafeCatalogStructuralText(dependency);
  }
  const history = continuity.history;
  if (
    !exactKeys(history, ["authority", "entries", "format", "order", "page", "source"]) ||
    history.format !== "dubsar.project-history/1" ||
    !exactKeys(history.source, ["evidence_format", "mission_id", "snapshot_sha256"]) ||
    history.source.snapshot_sha256 !== project.snapshot_sha256 ||
    !Array.isArray(history.entries) || history.entries.length > 8
  ) throw new WorkbenchError("CATALOG_REPORT_INPUT_INVALID");
  for (const entry of history.entries) {
    if (
      !exactKeys(entry, [
        "class", "evidence_id", "freshness", "lot_id", "record_index",
        "statement", "support", "type",
      ]) ||
      !Number.isSafeInteger(entry.record_index) || entry.record_index < 0
    ) throw new WorkbenchError("CATALOG_REPORT_INPUT_INVALID");
    assertSafeCatalogStructuralText(entry.evidence_id);
    assertSafeCatalogStructuralText(entry.lot_id);
    assertSafeCatalogStructuralText(entry.type);
    assertSafeCatalogStructuralText(entry.class);
    assertSafeCatalogStructuralText(entry.support);
    assertSafeCatalogStructuralText(entry.freshness);
    assertSafeCatalogDisplayText(entry.statement, 500);
  }
  if (!Array.isArray(continuity.evidence_details) || continuity.evidence_details.length > 8) {
    throw new WorkbenchError("CATALOG_REPORT_INPUT_INVALID");
  }
  for (const detail of continuity.evidence_details) {
    if (
      !exactKeys(detail, ["evidence_id", "lot_id", "references"]) ||
      !Array.isArray(detail.references) || detail.references.length > 8
    ) throw new WorkbenchError("CATALOG_REPORT_INPUT_INVALID");
    assertSafeCatalogStructuralText(detail.evidence_id);
    assertSafeCatalogStructuralText(detail.lot_id);
    for (const reference of detail.references) {
      if (
        !exactKeys(reference, ["path", "sha256"]) ||
        !(reference.sha256 === null || SHA256.test(reference.sha256))
      ) throw new WorkbenchError("CATALOG_REPORT_INPUT_INVALID");
      assertSafeCatalogDisplayText(reference.path, 500);
    }
  }
  if (
    !Array.isArray(continuity.decisions) || continuity.decisions.length > 5 ||
    !Array.isArray(continuity.blockers) || continuity.blockers.length > 3
  ) throw new WorkbenchError("CATALOG_REPORT_INPUT_INVALID");
  for (const decision of continuity.decisions) {
    if (!exactKeys(decision, ["evidence_id", "statement"])) {
      throw new WorkbenchError("CATALOG_REPORT_INPUT_INVALID");
    }
    assertSafeCatalogStructuralText(decision.evidence_id);
    assertSafeCatalogDisplayText(decision.statement, 500);
  }
  for (const blocker of continuity.blockers) {
    if (!exactKeys(blocker, ["evidence_id", "lot_id", "statement"])) {
      throw new WorkbenchError("CATALOG_REPORT_INPUT_INVALID");
    }
    assertSafeCatalogStructuralText(blocker.evidence_id);
    assertSafeCatalogStructuralText(blocker.lot_id);
    assertSafeCatalogDisplayText(blocker.statement, 500);
  }
  return base;
}

const EDGE_EXPLANATIONS = Object.freeze({
  contains: ["canonical", "Declared by the project mission"],
  depends_on: ["canonical", "Declared work-package dependency"],
  governs: ["canonical", "Declared execution contract"],
  supports: ["canonical", "Declared evidence support"],
  has_open_decision: ["derived", "Open decision detected during evaluation"],
  has_blocker: ["derived", "Open blocker detected during evaluation"],
});

function edgeExplanation(kind) {
  switch (kind) {
    case "contains": return EDGE_EXPLANATIONS.contains;
    case "depends_on": return EDGE_EXPLANATIONS.depends_on;
    case "governs": return EDGE_EXPLANATIONS.governs;
    case "supports": return EDGE_EXPLANATIONS.supports;
    case "has_open_decision": return EDGE_EXPLANATIONS.has_open_decision;
    case "has_blocker": return EDGE_EXPLANATIONS.has_blocker;
    default: throw new WorkbenchError("INTERACTIVE_GRAPH_INVALID");
  }
}

function continuityGraphProjection(graph, view, continuity) {
  const projected = graphProjection(graph, view);
  const sortedLots = [...continuity.lots.lots].sort((left, right) =>
    left.lot_id < right.lot_id ? -1 : left.lot_id > right.lot_id ? 1 : 0);
  return Object.freeze({
    ...projected,
    source_snapshot_sha256: graph.source_snapshot_sha256,
    nodes: Object.freeze(projected.nodes.map((node) => {
      if (node.kind !== "lot") return node;
      const index = Number.parseInt(node.id.slice(4), 10);
      return Object.freeze({ ...node, reference_id: sortedLots.at(index)?.lot_id ?? null });
    })),
    edges: Object.freeze(projected.edges.map((edge) => {
      const [provenance, justification] = edgeExplanation(edge.kind);
      return Object.freeze({ ...edge, provenance, justification });
    })),
  });
}

function continuityViewProjection(view) {
  return Object.freeze({
    ...interactiveProjectView(view),
    source: Object.freeze({
      id: view.source.id,
      snapshot_sha256: view.source.snapshot_sha256,
    }),
  });
}

function continuityProjectProjection(project, options) {
  const base = assertContinuityInput(project, options);
  if (project.capture_status === "unavailable") {
    return Object.freeze({ ...projectProjection({ projects: [base] }, base, WORKBENCH_REPORT_RENDERER), continuity: null });
  }
  const continuity = project.continuity;
  return Object.freeze({
    project_id: project.project_id,
    capture_status: project.capture_status,
    source_id: project.source_id,
    snapshot_sha256: project.snapshot_sha256,
    title: project.title,
    integrity: project.integrity,
    readiness: project.readiness,
    primary_blocker: project.primary_blocker,
    next_action: project.next_action,
    review_summary: project.review_summary,
    counts: project.view.overview.counts,
    view: continuityViewProjection(project.view),
    graph: continuityGraphProjection(project.graph, project.view, continuity),
    capsule: continuity.capsule,
    continuity: Object.freeze({
      source: continuity.source,
      freshness: continuity.freshness,
      lots: continuity.lots,
      lot_dependencies: continuity.lot_dependencies,
      history: continuity.history,
      evidence_details: continuity.evidence_details,
      decisions: continuity.decisions,
      blockers: continuity.blockers,
      ...(options?.requireHealth ? { health: continuity.health } : {}),
      memory_route: continuity.memory_route,
      routes: continuity.routes,
    }),
  });
}

function projectProjection(catalog, project, capsuleProducer) {
  assertProjectInput(project);
  if (project.capture_status === "unavailable") {
    return Object.freeze({
      project_id: project.project_id,
      capture_status: project.capture_status,
      source_id: null,
      snapshot_sha256: null,
      title: project.title,
      integrity: project.integrity,
      readiness: project.readiness,
      primary_blocker: project.primary_blocker,
      next_action: project.next_action,
      review_summary: project.review_summary,
      counts: null,
      view: null,
      graph: null,
      capsule: null,
    });
  }
  return Object.freeze({
    project_id: project.project_id,
    capture_status: project.capture_status,
    source_id: project.source_id,
    snapshot_sha256: project.snapshot_sha256,
    title: project.title,
    integrity: project.integrity,
    readiness: project.readiness,
    primary_blocker: project.primary_blocker,
    next_action: project.next_action,
    review_summary: project.review_summary,
    counts: project.view.overview.counts,
    view: interactiveProjectView(project.view),
    graph: graphProjection(project.graph, project.view),
    capsule: buildResumeCapsule({
      catalog,
      projectId: project.project_id,
      producer: capsuleProducer,
    }),
  });
}

function statusLabel(project) {
  if (project.capture_status === "unavailable") return "Unavailable";
  if (project.integrity.status === "invalid") return "Needs record review";
  if (project.continuity?.freshness?.status === "stale") return "Stale evidence";
  if (project.continuity?.freshness?.status === "missing") return "Missing evidence";
  if (project.readiness.status === "ready") return "Ready to continue";
  if (project.readiness.status === "unknown") return "Status to confirm";
  return "Action required";
}

function integrityLabel(project) {
  if (project.capture_status === "unavailable") return "Capture unavailable";
  return project.integrity.status === "valid"
    ? "Integrity verified"
    : "Integrity needs attention";
}

function isMemoryVnextProject(project) {
  return project?.capsule?.format === "dubsar.resume-capsule/3";
}

function projectBlockers(project) {
  return isMemoryVnextProject(project)
    ? project.capsule.blockers.map((blocker) => ({
      code: blocker.evidence_id,
      severity: "warning",
      statement: blocker.statement,
      title: blocker.statement,
    }))
    : (project.view?.blockers ?? []);
}

function projectSummary(project) {
  if (isMemoryVnextProject(project)) {
    return project.capsule.active_work?.objective ??
      "No Work is selected. Choose an open Work item explicitly to continue.";
  }
  return project.view?.overview.summary ?? "The folder cannot be read.";
}

function selectedWorkTitle(project) {
  if (isMemoryVnextProject(project)) return project.capsule.active_work?.title ?? null;
  return project.capsule?.active_lot?.title ?? null;
}

function recordedCheckpointLabel(project) {
  const checkpoint = isMemoryVnextProject(project)
    ? project.capsule.recorded_continuity.at(-1)
    : null;
  return checkpoint?.summary ?? "No checkpoint recorded for the selected Work.";
}

function nativeGuidanceLabel(route) {
  if (!route?.native_guidance) return "No native guidance";
  const guidance = [];
  if (route.native_guidance.plan.recommendation === "consider") guidance.push("Consider Plan mode");
  if (route.native_guidance.goal.recommendation === "consider") guidance.push("Consider a Goal");
  return guidance.length > 0 ? guidance.join(" · ") : "No guidance needed";
}

function memoryRouteLabel(route) {
  if (!route) return "Unavailable";
  if (route.format === "dubsar.memory-route/2") {
    if (route.source.workspace_mode === "memory_vnext") return nativeGuidanceLabel(route);
    let action;
    switch (route.guidance.action) {
      case "continue": action = "Continue"; break;
      case "finish_recorded": action = "Work recorded as complete"; break;
      case "none": action = "No guidance"; break;
      case "pause": action = "Pause"; break;
      case "reconsider": action = "Reconsider"; break;
      case "record": action = "Record context"; break;
      case "resume_candidate": action = "Resume candidate"; break;
      default: action = "Unavailable";
    }
    const state = route.memory_state.replaceAll("_", " ");
    return `${action} - ${state}`;
  }
  let station;
  switch (route.route.station) {
    case "abstain": station = "Abstain"; break;
    case "capture": station = "Capture"; break;
    case "complete": station = "Complete"; break;
    case "continue": station = "Continue"; break;
    case "hold": station = "Hold"; break;
    case "reactivate": station = "Reactivate"; break;
    case "reframe": station = "Reframe"; break;
    default: station = "Unavailable";
  }
  let stage;
  switch (route.maturation.stage) {
    case "constrained": stage = "constrained"; break;
    case "reactivated": stage = "reactivated"; break;
    case "recorded": stage = "recorded"; break;
    case "seeded": stage = "seeded"; break;
    case "stabilized": stage = "stabilized"; break;
    case "supported": stage = "supported"; break;
    default: stage = "unknown";
  }
  return `${station} - ${stage}`;
}

function actionLabel(action, capsule = null) {
  if (capsule?.format === "dubsar.resume-capsule/3") return action.label;
  switch (action.code) {
    case "approve_execution_contract": return "Review and approve the execution contract for the selected work package.";
    case "approve_mission": return "Review and approve the project mission.";
    case "complete_mission_definition": return "Complete the mission outcome and scope.";
    case "decompose_lots": return "Break the approved mission into verifiable work packages.";
    case "draft_execution_contract": return "Prepare the execution contract for the selected work package.";
    case "prepare_approved_lot": return "Prepare the approved work package within its contract.";
    case "record_acceptance_evidence": return "Add the evidence required to accept the mission.";
    case "resolve_integrity_findings": return "Resolve project inconsistencies with human validation.";
    case "resolve_readiness_blockers": return "Resolve the displayed blockers before preparing the work.";
    case "review_mission_acceptance": return "Review the evidence before accepting the mission.";
    case "select_candidate_lot": return "Choose an eligible work package.";
    case "verify_project_root": return "Check the project folder.";
    default: return "A next step is recorded in the technical details.";
  }
}

function blockerLabel(blocker) {
  if (typeof blocker.statement === "string") return blocker.statement;
  switch (blocker.code) {
    case "CANDIDATE_LOT_MISSING": return "No work package is selected for the next step.";
    case "EXECUTION_CONTRACT_MISSING": return "The selected work package does not have an execution contract yet.";
    case "EXECUTION_CONTRACT_NOT_APPROVED": return "The execution contract for the selected work package still needs approval.";
    case "LOTS_EMPTY": return "The mission has not been split into work packages yet.";
    case "MISSION_ACCEPTANCE_EVIDENCE_INCOMPLETE": return "The evidence required to accept the mission is incomplete.";
    case "MISSION_DESIRED_OUTCOME_MISSING": return "The mission's desired outcome needs to be defined.";
    case "MISSION_NOT_APPROVED": return "The mission still needs approval.";
    case "MISSION_PURPOSE_MISSING": return "The mission purpose needs to be defined.";
    case "MISSION_SCOPE_EMPTY": return "The mission scope needs to be defined.";
    case "MISSION_TITLE_MISSING": return "The mission needs a clear title.";
    case "PROJECT_UNAVAILABLE": return "The project folder needs to be checked.";
    default: return "A technical check is still required.";
  }
}

function projectChoiceLines(projects, selectedProjectId) {
  return projects.map((project) =>
    `        <option value="${escapeHtmlText(project.project_id)}"${project.project_id === selectedProjectId ? " selected" : ""}>${escapeHtmlText(project.title)} — ${escapeHtmlText(statusLabel(project))}</option>`);
}

function blockerPreviewLines(blockers) {
  if (blockers.length === 0) {
    return ["          <li class=\"blocker-empty\">No blockers detected.</li>"];
  }
  return blockers.slice(0, 2).map((blocker) =>
    `          <li class="blocker-preview-item">${escapeHtmlText(blockerLabel(blocker))}</li>`);
}

function blockerDetailLines(blockers) {
  return blockers.map((blocker) =>
    `            <li><strong>${escapeHtmlText(blockerLabel(blocker))}</strong><code>${escapeHtmlText(blocker.code)}</code></li>`);
}

function lotProgressLabel(project) {
  if (project.capture_status !== "available") return "Progress unavailable";
  const complete = project.counts?.complete_lots ?? 0;
  const total = project.counts?.lots ?? 0;
  if (total === 0) return "No work packages recorded";
  if (project.integrity.status !== "valid") {
    return `${total} work package${total === 1 ? "" : "s"} recorded · unverified`;
  }
  return `Work items completed: ${complete} / ${total}`;
}

function workScopeLabel(scope) {
  switch (scope) {
    case "bounded": return "Short task";
    case "multi_step": return "Planned work";
    case "multi_session": return "Long-running goal";
    default: return "Not available";
  }
}

function countLabel(count, singular, plural) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function reviewLabel(project) {
  if (project.review_summary.status === "not_included") return "Not included";
  return countLabel(project.review_summary.valid_count, "advisory review", "advisory reviews");
}

function renderDocument(projects, memory, dataJson, dataSha256, live) {
  const style = `${INTERACTIVE_STYLE}\n${CATALOG_INTERACTIVE_STYLE}`;
  const first = projects.find((project) => project.capture_status === "available") ?? projects.at(0);
  const title = isMemoryVnextProject(first)
    ? first.capsule.project.title
    : (first.view?.overview.title ?? first.title);
  const summary = first.capture_status === "available" && first.integrity.status !== "valid"
    ? "Project records conflict, so readiness and active work cannot be confirmed."
    : projectSummary(first);
  const firstBlockers = projectBlockers(first);
  const firstEvidenceCount = isMemoryVnextProject(first)
    ? first.capsule.recorded_continuity.length
    : (first.view?.evidence.length ?? 0);
  const firstDecisionCount = isMemoryVnextProject(first)
    ? first.capsule.knowledge.length
    : (first.view?.decisions.length ?? 0);
  const firstCompleteLots = first.counts?.complete_lots ?? 0;
  const firstTotalLots = first.counts?.lots ?? 0;
  const firstIntegrityInvalid = first.capture_status === "available" && first.integrity.status !== "valid";
  const firstResumeEnabled = Boolean(first.capsule) && !firstIntegrityInvalid;
  const firstMemoryRoute = firstIntegrityInvalid
    ? "Unverified"
    : memoryRouteLabel(first.continuity?.memory_route);
  const firstAction = firstIntegrityInvalid
    ? "Review record consistency."
    : actionLabel(first.next_action, first.capsule);
  const firstMemoryVnext = isMemoryVnextProject(first);
  const firstSelectedWork = selectedWorkTitle(first) ?? "No work package selected";
  const firstContextLabel = firstMemoryVnext ? "Last checkpoint" : "Evidence";
  const firstContextValue = firstMemoryVnext
    ? recordedCheckpointLabel(first)
    : (first.continuity ? first.continuity.freshness.status : "Status unknown");
  const firstGuidanceLabel = firstMemoryVnext ? "Native guidance" : "Memory route";
  const firstBlockerPreview = firstIntegrityInvalid
    ? ["          <li class=\"blocker-unverified\">No trusted blocker list is available until the project records are consistent.</li>"]
    : blockerPreviewLines(firstBlockers);
  const firstDiagnosticCodes = first.integrity.diagnostic_codes.length === 0
    ? "None"
    : first.integrity.diagnostic_codes.join(", ");
  const continuityMode = projects.some((project) => Object.hasOwn(project, "continuity"));
  const firstHealth = first.continuity?.health ?? null;
  const firstCheckpointCount = firstHealth?.checkpoint_count ?? 0;
  const firstCheckpointCapacity = firstHealth?.checkpoint_capacity ?? 128;
  const firstGraphTrivial = (first.graph?.nodes.length ?? 0) < 4 ||
    (first.graph?.edges.length ?? 0) < 3;
  const styleHash = cspHash(style);
  const scriptHash = cspHash(CATALOG_INTERACTIVE_SCRIPT);
  return [
    "<!doctype html>",
    "<html lang=\"en\" data-runtime=\"fallback\">",
    "<head>",
    "  <meta charset=\"utf-8\">",
    "  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">",
    "  <meta name=\"referrer\" content=\"no-referrer\">",
    `  <meta http-equiv="Content-Security-Policy" content="base-uri 'none'; connect-src '${live ? "self" : "none"}'; default-src 'none'; font-src 'none'; form-action 'none'; frame-src 'none'; img-src 'none'; manifest-src 'none'; media-src 'none'; object-src 'none'; script-src 'sha256-${scriptHash}'; script-src-attr 'none'; style-src 'sha256-${styleHash}'; style-src-attr 'none'; worker-src 'none'">`,
    `  <meta name="dubsar-data-sha256" content="${dataSha256}">`,
    `  <meta name="dubsar-live-session" content="${live ? "enabled" : "disabled"}">`,
    "  <meta name=\"color-scheme\" content=\"dark\">",
    "  <title>DUBSAR Workbench — Resume</title>",
    `  <style>${style}</style>`,
    "</head>",
    "<body>",
    `<div class="app-shell catalog-mode${firstIntegrityInvalid ? " recovery-mode" : ""}" id="app-shell">`,
    "  <aside class=\"rail\">",
    "    <div class=\"brand\">DUBSAR</div>",
    "    <nav class=\"nav-list\" role=\"tablist\" aria-label=\"Dashboard views\" data-i18n-aria-label=\"dashboard_views_aria\">",
    "      <button type=\"button\" class=\"nav-button\" id=\"nav-resume-tab\" role=\"tab\" data-view=\"dashboard\" aria-controls=\"dashboard-view\" aria-selected=\"true\" tabindex=\"0\" data-i18n=\"nav_resume\">Resume</button>",
    `      <button type="button" class="nav-button" id="nav-memory-tab" role="tab" data-view="memory" aria-controls="memory-view" aria-selected="false" tabindex="-1" data-i18n="nav_memory"${continuityMode ? "" : " hidden"}>Memory</button>`,
    "      <button type=\"button\" class=\"nav-button\" id=\"nav-graph-tab\" role=\"tab\" data-view=\"graph\" aria-controls=\"graph-view\" aria-selected=\"false\" tabindex=\"-1\" data-i18n=\"nav_graph\">Graph</button>",
    "    </nav>",
    "    <div class=\"locale-switch\" id=\"locale-switch\" role=\"group\" aria-label=\"Language\"><button type=\"button\" class=\"locale-button\" data-locale=\"en\" aria-pressed=\"true\">EN</button><button type=\"button\" class=\"locale-button\" data-locale=\"fr\" aria-pressed=\"false\">FR</button></div>",
    "    <div class=\"rail-meta\"><div class=\"offline-line\"><span class=\"offline-dot\"></span><span data-i18n=\"local_offline\">Local / Offline</span></div>",
    `      <div><span data-i18n="snapshot_label">Snapshot</span> <span class="snapshot-code" id="rail-snapshot">${escapeHtmlText(first.snapshot_sha256?.slice(0, 10) ?? "unavailable")}</span></div>`,
    "    </div>",
    "  </aside>",
    "  <main class=\"workspace\">",
    `    <section class="portfolio-strip" aria-labelledby="portfolio-title"${projects.length === 1 ? " hidden" : ""}>`,
    "      <label class=\"portfolio-heading\" for=\"project-select\"><span class=\"project-kicker\" data-i18n=\"local_portfolio\">Local portfolio</span><strong id=\"portfolio-title\" data-i18n=\"choose_project\">Choose a project</strong></label>",
    "      <select class=\"project-picker\" id=\"project-select\">",
    ...projectChoiceLines(projects, first.project_id),
    "      </select>",
    "    </section>",
    `    <section id="memory-view" class="continuity-memory-view" role="tabpanel" aria-labelledby="nav-memory-tab" tabindex="0" hidden${continuityMode ? "" : " data-unavailable=\"true\""}>`,
    "      <header class=\"memory-view-header\"><div><span class=\"graph-kicker\" data-i18n=\"project_memory\">Project memory</span><h1 data-i18n=\"continuity_memory\">Recorded continuity</h1><p data-i18n=\"memory_note\">Project facts derived from the same snapshot as Resume. No personal memory is included.</p></div><div class=\"freshness-summary\"><span data-i18n=\"freshness\">Freshness</span><strong id=\"memory-freshness\">Unknown</strong></div></header>",
    "      <div class=\"memory-workspace\">",
    "        <section class=\"memory-card work-package-card\"><div class=\"memory-card-heading\"><div><span class=\"section-label\" data-i18n=\"work_packages\">Work packages</span><p data-i18n=\"work_packages_note\">Choose explicitly. DUBSAR never ranks or selects work.</p></div><div class=\"lot-filter-bar\" id=\"lot-filter-bar\" role=\"group\" aria-label=\"Work package filters\" data-i18n-aria-label=\"work_filter_aria\"><button type=\"button\" class=\"lot-filter is-active\" data-lot-filter=\"active\" data-i18n=\"filter_active\">Active</button><button type=\"button\" class=\"lot-filter\" data-lot-filter=\"eligible\" data-i18n=\"filter_eligible\">Eligible</button><button type=\"button\" class=\"lot-filter\" data-lot-filter=\"blocked\" data-i18n=\"filter_blocked\">Blocked</button><button type=\"button\" class=\"lot-filter\" data-lot-filter=\"waiting\" data-i18n=\"filter_waiting\">Waiting</button><button type=\"button\" class=\"lot-filter\" data-lot-filter=\"complete\" data-i18n=\"filter_complete\">Complete</button><button type=\"button\" class=\"lot-filter\" data-lot-filter=\"all\" data-i18n=\"filter_all\">All</button></div></div><ul class=\"continuity-list lot-list\" id=\"lot-list\"></ul></section>",
    `        <section class="memory-card project-health-card" id="memory-health-card"${firstHealth === null ? " hidden" : ""}><div class="memory-card-heading"><div><span class="section-label" data-i18n="project_health">Project health</span><p data-i18n="project_health_note">Read-only signals from the current project snapshot.</p></div></div><dl class="health-summary"><div><dt data-i18n="work_scope">Work scope</dt><dd id="memory-work-scope">${escapeHtmlText(workScopeLabel(firstHealth?.work_scope))}</dd></div><div><dt data-i18n="anti_loop">Anti-loop</dt><dd id="memory-stagnation">${firstHealth?.stagnation === "detected" ? "Repeated attempt detected" : firstHealth?.stagnation === "clear" ? "No stagnation detected" : "Not applicable"}</dd></div></dl><div class="stagnation-alert" id="memory-stagnation-alert" role="status"${firstHealth?.stagnation === "detected" ? "" : " hidden"} data-i18n="repeated_attempt_alert">Two identical failures were recorded without progress. Review the approach before retrying.</div><div class="checkpoint-meter"><label for="memory-checkpoint-meter"><span data-i18n="recorded_checkpoints">Recorded checkpoints</span> <strong><span id="memory-checkpoint-count">${firstCheckpointCount}</span> / <span id="memory-checkpoint-capacity">${firstCheckpointCapacity}</span></strong></label><progress id="memory-checkpoint-meter" max="${firstCheckpointCapacity}" value="${firstCheckpointCount}">${firstCheckpointCount} / ${firstCheckpointCapacity}</progress></div></section>`,
    `        <section class="memory-card decisions-evidence-card linked-knowledge-card" id="linked-knowledge-card"><div class="memory-card-heading"><div><span class="section-label" id="linked-knowledge-label">${firstMemoryVnext ? "Linked Knowledge" : "Decisions and evidence"}</span><p id="linked-knowledge-note">${firstMemoryVnext ? "Approved project knowledge linked to the selected Work." : "Advisory summaries."} Canonical records remain authoritative.</p></div></div><div class="memory-split"><div><h2 id="memory-decision-heading" data-i18n="open_decisions">Open decisions</h2><ul class="continuity-list" id="memory-decision-list"></ul></div><div><h2 id="memory-evidence-heading" data-i18n="evidence">Evidence</h2><ul class="continuity-list" id="memory-evidence-list"></ul></div></div></section>`,
    "        <section class=\"memory-card history-card recent-activity-card\"><div class=\"memory-card-heading\"><div><span class=\"section-label\" data-i18n=\"recorded_continuity\">Recent recorded activity</span><p data-i18n=\"recorded_order_note\">Most recently recorded first — not a real chronology. First eight entries only.</p></div><span class=\"memory-count\" id=\"history-count\">0</span></div><ol class=\"continuity-list history-list\" id=\"history-list\"></ol></section>",
    "        <section class=\"memory-card precedent-card\"><div class=\"memory-card-heading\"><div><span class=\"section-label\" data-i18n=\"exact_precedents\">Exact precedents</span><p data-i18n=\"precedent_note\">Select a work package, then copy the exact local CLI query. No semantic ranking is used.</p></div></div><div class=\"precedent-controls\"><select id=\"precedent-lot-select\" aria-label=\"Work package for precedent search\" data-i18n-aria-label=\"precedent_select_aria\"></select><button type=\"button\" class=\"capsule-copy\" id=\"precedent-copy\" data-i18n=\"copy_query\">Copy query</button></div><textarea class=\"technical-output precedent-output\" id=\"precedent-output\" readonly></textarea><p class=\"resume-copy-status\" id=\"precedent-status\" aria-live=\"polite\"></p></section>",
    "      </div>",
    "    </section>",
    "    <section id=\"dashboard-view\" role=\"tabpanel\" aria-labelledby=\"nav-resume-tab\" tabindex=\"0\">",
    `      <header class="project-header${first.capture_status === "available" ? "" : " is-unavailable"}${firstIntegrityInvalid ? " is-recovery" : ""}" id="project-header">`,
    `        <div class="project-topline"><span class="project-kicker" data-i18n="project_resume">Project resume</span><span class="snapshot-note" id="live-status" aria-live="polite">${live ? "Automatic updates active" : "Snapshot read when opened — reopen DUBSAR to refresh"}</span></div>`,
    "        <div class=\"project-title-row\">",
    `          <h1 id="project-title">${escapeHtmlText(title)}</h1>`,
    `          <div class="state-badges"><strong class="status-pill" id="state-value" data-state="${escapeHtmlText(firstIntegrityInvalid ? "invalid" : (first.capture_status === "available" ? first.readiness.status : "unavailable"))}">${escapeHtmlText(statusLabel(first))}</strong><span class="integrity-badge" id="integrity-badge" data-state="${escapeHtmlText(first.integrity.status)}">${escapeHtmlText(integrityLabel(first))}</span></div>`,
    "        </div>",
    `        <p id="project-summary">${escapeHtmlText(summary)}</p>`,
    "      </header>",
    `      <section class="integrity-alert" id="integrity-alert" role="alert"${firstIntegrityInvalid ? "" : " hidden"}><strong data-i18n="integrity_alert_title">Project records conflict</strong><span id="integrity-alert-detail">Readiness and active work cannot be confirmed until the local records are consistent.</span></section>`,
    "      <section class=\"next-section resume-focus\" aria-labelledby=\"action-heading\"><span class=\"section-label\" id=\"action-heading\" data-i18n=\"do_now\">Do this now</span><div class=\"next-action\"><span class=\"next-action-bar\"></span><span class=\"next-action-copy\">",
    `        <strong id="next-action-primary">${escapeHtmlText(firstAction)}</strong><span id="local-step-note" data-i18n="${firstIntegrityInvalid ? "recovery_step_note" : "local_step_note"}">${firstIntegrityInvalid ? "Open the read-only record details to understand what must be reconciled." : "Suggested step based on the local project folder"}</span></span></div><div class="resume-why" id="resume-why"${firstIntegrityInvalid ? " hidden" : ""}><span><small id="active-work-label">Work package</small><strong id="active-lot">${escapeHtmlText(firstSelectedWork)}</strong></span><span><small id="resume-context-label">${escapeHtmlText(firstContextLabel)}</small><strong id="resume-freshness">${escapeHtmlText(firstContextValue)}</strong></span><span><small id="native-guidance-label">${escapeHtmlText(firstGuidanceLabel)}</small><strong id="memory-route">${escapeHtmlText(firstMemoryRoute)}</strong></span></div>`,
    "        <div class=\"blocker-overview\" id=\"blocker-overview\"><div class=\"blocker-heading\"><span class=\"section-label\" data-i18n=\"blockers_detected\">Blockers detected</span><strong id=\"blocker-count\">" + (firstIntegrityInvalid ? "Unverified" : String(firstBlockers.length)) + "</strong></div><ul class=\"blocker-preview\" id=\"blocker-preview\">",
    ...firstBlockerPreview,
    "        </ul><details class=\"blocker-details\" id=\"blocker-details\"" + (!firstIntegrityInvalid && firstBlockers.length > 1 ? "" : " hidden") + "><summary id=\"blocker-details-summary\">View all detected blockers</summary><ul class=\"blocker-list\" id=\"blocker-list\">",
    ...blockerDetailLines(firstBlockers),
    `        </ul><p data-i18n="blocker_order_note">Technical list with no business priority order.</p></details></div><div class="resume-actions"><button type="button" class="review-records" id="review-records"${firstIntegrityInvalid ? "" : " hidden"} data-i18n="review_records">Review record consistency</button><button type="button" class="resume-copy" id="resume-copy"${firstResumeEnabled ? "" : " disabled"} data-i18n="resume_with_codex">Resume with Codex</button><span class="resume-action-copy"><span class="resume-safety" data-i18n="copy_safety">Copies context · no action is executed</span><span class="resume-copy-status" id="resume-copy-status" aria-live="polite">${firstIntegrityInvalid ? "Unavailable until record consistency is reviewed" : (first.capsule ? "Local instruction ready" : "Check the folder before resuming")}</span></span></div></section>`,
    "      <section class=\"resume-context\" id=\"resume-context\" aria-label=\"Available progress and context\" data-i18n-aria-label=\"progress_context_aria\"><div class=\"progress-compact\"><span class=\"signal-label\" data-i18n=\"progress\">Progress</span>",
    `        <strong id="lot-progress">${escapeHtmlText(lotProgressLabel(first))}</strong><progress id="lot-progress-bar" max="${Math.max(firstTotalLots, 1)}" value="${Math.min(firstCompleteLots, Math.max(firstTotalLots, 1))}"${firstTotalLots === 0 || firstIntegrityInvalid ? " hidden" : ""}></progress></div>`,
    "        <ul class=\"context-summary\"><li id=\"signal-evidence-item\"" + (firstEvidenceCount === 0 ? " hidden" : "") + "><strong id=\"signal-evidence\">" + String(firstEvidenceCount) + "</strong><span id=\"signal-evidence-label\">" + (firstMemoryVnext ? (firstEvidenceCount === 1 ? "recorded checkpoint" : "recorded checkpoints") : (firstEvidenceCount === 1 ? "evidence item" : "evidence items")) + (firstIntegrityInvalid ? " · unverified" : "") + "</span></li><li id=\"signal-decisions-item\"" + (firstDecisionCount === 0 ? " hidden" : "") + "><strong id=\"signal-decisions\">" + String(firstDecisionCount) + "</strong><span id=\"signal-decisions-label\">" + (firstMemoryVnext ? (firstDecisionCount === 1 ? "linked Knowledge entry" : "linked Knowledge entries") : (firstDecisionCount === 1 ? "open decision" : "open decisions")) + (firstIntegrityInvalid ? " · unverified" : "") + "</span></li></ul></section>",
    "      <div class=\"dashboard-disclosures\"><details class=\"decisions-section compact-panel\" id=\"decision-details\"><summary><span id=\"decision-summary-label\" data-i18n=\"open_decisions\">Open decisions</span><strong id=\"decision-summary-count\">0</strong></summary><ol class=\"decision-list\" id=\"decision-list\"></ol></details>",
    `      <details class="technical compact-panel" id="technical-details"><summary><span id="technical-summary-label" data-i18n="${firstIntegrityInvalid ? "record_details" : "technical_details"}">${firstIntegrityInvalid ? "Record details" : "Technical details and traceability"}</span></summary><div class="provenance-badges" id="provenance-badges" aria-label="Data provenance"><b>Canonical</b><b>Derived</b><b>Advisory</b></div><dl><dt data-i18n="authority">Authority</dt><dd>local_preparation_record</dd><dt data-i18n="source">Source</dt><dd id="source-id">not displayed</dd><dt data-i18n="snapshot_hash">Snapshot hash</dt><dd><code id="snapshot-id">unavailable</code></dd><dt data-i18n="raw_status">Raw status</dt><dd id="raw-state">unavailable</dd><dt data-i18n="diagnostic_codes">Diagnostic codes</dt><dd><code id="integrity-diagnostic-list">${escapeHtmlText(firstDiagnosticCodes)}</code></dd><dt data-i18n="next_action_code">Next action code</dt><dd id="next-action-code">unavailable</dd><dt data-i18n="advisory_reviews">Advisory reviews</dt><dd id="signal-reviews">${escapeHtmlText(reviewLabel(first))}</dd></dl><div class="technical-copy-block"><label for="resume-instruction-output" data-i18n="codex_instruction">Codex instruction</label><textarea class="technical-output instruction-output" id="resume-instruction-output" readonly></textarea></div><div class="technical-copy-block"><div class="capsule-toolbar"><span id="capsule-copy-status">Bounded local data</span><button type="button" class="capsule-copy" id="capsule-copy"${firstResumeEnabled ? "" : " disabled"} data-i18n="copy_capsule">Copy capsule JSON</button></div><textarea class="technical-output capsule-output" id="capsule-output" readonly></textarea><p class="capsule-note" data-i18n="capsule_note">This capsule is advisory. It does not prove approval, merge, or deployment.</p></div></details></div>`,
    "    </section>",
    `    <section id="graph-view" class="graph-view" role="tabpanel" aria-labelledby="nav-graph-tab" tabindex="0" data-graph-trivial="${firstGraphTrivial}" hidden><header class="graph-header"><div><span class="graph-kicker" data-i18n="relationship_view">Relationship view</span><h1 data-i18n="selected_project_graph">Selected project graph</h1><p class="graph-project-note" data-i18n="graph_note">The list remains the reference navigation. The Canvas is a visual representation of the selected project.</p></div><div class="graph-toolbar"><button type="button" class="tool-button" id="graph-zoom-out" aria-label="Zoom out" data-i18n-aria-label="zoom_out">−</button><button type="button" class="tool-button" id="graph-reset" data-i18n="center_graph">Center</button><button type="button" class="tool-button" id="graph-zoom-in" aria-label="Zoom in" data-i18n-aria-label="zoom_in">+</button></div></header>`,
    `      <section class="graph-compact-summary" id="graph-compact-summary"${firstGraphTrivial ? "" : " hidden"}><div><strong data-i18n="relationships_glance">Relationships at a glance</strong><p id="graph-compact-counts">${first.graph?.nodes.length ?? 0} nodes · ${first.graph?.edges.length ?? 0} relations</p></div><ul class="graph-compact-relationships" id="graph-compact-relationships" aria-label="Project relationships" data-i18n-aria-label="project_relationships_aria"></ul><button type="button" class="capsule-copy graph-show-canvas" id="graph-show-canvas" aria-controls="graph-canvas-region" aria-expanded="false" data-i18n="show_graph">Show graph</button></section>`,
    `      <div class="graph-filter-bar" role="group" aria-label="Filter the graph" data-i18n-aria-label="filter_graph"${firstGraphTrivial ? " hidden" : ""}><button type="button" class="graph-filter-button" data-graph-filter="essential" aria-pressed="true" data-i18n="essential">Essential</button><button type="button" class="graph-filter-button" data-graph-filter="blocker" aria-pressed="false" data-i18n="blockers">Blockers</button><button type="button" class="graph-filter-button" data-graph-filter="decision" aria-pressed="false" data-i18n="decisions">Decisions</button><button type="button" class="graph-filter-button" data-graph-filter="evidence" aria-pressed="false" data-i18n="evidence">Evidence</button><button type="button" class="graph-filter-button" data-graph-filter="all" aria-pressed="false" data-i18n="all">All</button></div>`,
    `      <div class="graph-layout"><div class="canvas-wrap" id="graph-canvas-region"${firstGraphTrivial ? " hidden" : ""}><canvas id="graph-canvas" aria-hidden="true"></canvas></div><aside class="graph-details" aria-live="polite"><span class="graph-kicker" id="graph-detail-kind">project</span><h2 id="graph-detail-title">Project</h2><p id="graph-detail-text"></p><p class="graph-detail-relations" id="graph-detail-relations"></p><ul class="graph-node-list" id="graph-node-list" aria-label="Graph nodes" data-i18n-aria-label="graph_nodes"></ul></aside></div>`,
    "    </section>",
    "  </main>",
    "</div>",
    `  <script id="workbench-data" type="application/json">${dataJson}</script>`,
    `  <script>${CATALOG_INTERACTIVE_SCRIPT}</script>`,
    "</body>",
    "</html>",
    "",
  ].join("\n");
}

export function renderWorkbenchCatalogInteractiveReport(catalog, options = {}) {
  if (
    !catalog ||
    !exactKeys(catalog, ["authority", "format", "producer", "projects", "summary"]) ||
    catalog.format !== "dubsar.workbench-catalog/1" ||
    catalog.authority !== WORKBENCH_AUTHORITY ||
    !Array.isArray(catalog.projects) ||
    catalog.projects.length === 0 ||
    catalog.projects.length > 16 ||
    !options ||
    typeof options !== "object" ||
    Array.isArray(options)
  ) {
    throw new WorkbenchError("CATALOG_REPORT_INPUT_INVALID");
  }
  if (
    !exactKeys(catalog.producer, ["name", "version"]) ||
    !exactKeys(catalog.summary, ["action_required", "available", "ready", "total", "unavailable"])
  ) {
    throw new WorkbenchError("CATALOG_REPORT_INPUT_INVALID");
  }
  assertSafeCatalogStructuralText(
    catalog.producer.name,
    /^@?[a-z0-9][a-z0-9@/._-]{1,127}$/iu,
  );
  assertSafeCatalogStructuralText(
    catalog.producer.version,
    /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u,
  );
  const maxBytes = options.maxBytes ?? MAX_REPORT_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > MAX_REPORT_BYTES) {
    throw new WorkbenchError("REPORT_LIMIT_INVALID");
  }
  if (Object.hasOwn(options, "live") && typeof options.live !== "boolean") {
    throw new WorkbenchError("CATALOG_REPORT_INPUT_INVALID");
  }
  const live = options.live === true;
  const capsuleProducer = options.capsuleProducer ?? WORKBENCH_REPORT_RENDERER;
  if (
    !exactKeys(capsuleProducer, ["name", "version"]) ||
    !/^@?[a-z0-9][a-z0-9@/._-]{1,127}$/iu.test(capsuleProducer.name) ||
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(capsuleProducer.version)
  ) {
    throw new WorkbenchError("CATALOG_REPORT_INPUT_INVALID");
  }
  assertSafeCatalogStructuralText(
    capsuleProducer.name,
    /^@?[a-z0-9][a-z0-9@/._-]{1,127}$/iu,
  );
  assertSafeCatalogStructuralText(
    capsuleProducer.version,
    /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u,
  );
  const projects = Object.freeze(catalog.projects.map((project) =>
    projectProjection(catalog, project, capsuleProducer)));
  const expectedSummary = {
    total: projects.length,
    available: projects.filter((project) => project.capture_status === "available").length,
    unavailable: projects.filter((project) => project.capture_status === "unavailable").length,
    ready: projects.filter((project) => project.readiness.status === "ready").length,
    action_required: projects.filter(
      (project) => project.capture_status === "available" && project.readiness.status !== "ready",
    ).length,
  };
  if (
    catalog.summary.total !== expectedSummary.total ||
    catalog.summary.available !== expectedSummary.available ||
    catalog.summary.unavailable !== expectedSummary.unavailable ||
    catalog.summary.ready !== expectedSummary.ready ||
    catalog.summary.action_required !== expectedSummary.action_required
  ) {
    throw new WorkbenchError("CATALOG_REPORT_INPUT_INVALID");
  }
  const memory = memoryProjection(undefined);
  const data = Object.freeze({
    format: WORKBENCH_CATALOG_INTERACTIVE_DATA_FORMAT,
    authority: WORKBENCH_AUTHORITY,
    summary: Object.freeze(expectedSummary),
    projects,
    memory,
  });
  for (const project of projects) assertProjectDisplayText(project);
  const dataJson = encodeJsonForHtml(data);
  const dataSha256 = sha256Bytes(Buffer.from(dataJson, "utf8"));
  const html = renderDocument(projects, memory, dataJson, dataSha256, live);
  const buffer = Buffer.from(html, "utf8");
  if (buffer.length > maxBytes) throw new WorkbenchError("REPORT_SIZE_LIMIT_EXCEEDED");
  return Object.freeze({
    html,
    manifest: Object.freeze({
      format: WORKBENCH_CATALOG_INTERACTIVE_REPORT_FORMAT,
      authority: WORKBENCH_AUTHORITY,
      renderer: WORKBENCH_REPORT_RENDERER,
      catalog_format: catalog.format,
      project_count: projects.length,
      available_count: projects.filter((project) => project.capture_status === "available").length,
      bytes: buffer.length,
      sha256: sha256Bytes(buffer),
      script_sha256: sha256Bytes(Buffer.from(CATALOG_INTERACTIVE_SCRIPT, "utf8")),
      style_sha256: sha256Bytes(Buffer.from(`${INTERACTIVE_STYLE}\n${CATALOG_INTERACTIVE_STYLE}`, "utf8")),
      data_sha256: dataSha256,
    }),
  });
}

export function renderWorkbenchContinuityInteractiveReport(catalog, options = {}) {
  const catalogVersion = catalog?.format === "dubsar.workbench-continuity-data/3"
    ? 3
    : catalog?.format === "dubsar.workbench-continuity-data/2"
      ? 2
      : catalog?.format === "dubsar.workbench-continuity-data/1"
        ? 1
        : null;
  if (
    !catalog ||
    !exactKeys(catalog, ["authority", "format", "producer", "projects", "summary"]) ||
    !new Set([
      "dubsar.workbench-continuity-data/1",
      "dubsar.workbench-continuity-data/2",
      "dubsar.workbench-continuity-data/3",
    ]).has(catalog.format) ||
    catalog.authority !== WORKBENCH_AUTHORITY ||
    !Array.isArray(catalog.projects) ||
    catalog.projects.length === 0 ||
    catalog.projects.length > 16 ||
    !options || typeof options !== "object" || Array.isArray(options) ||
    !exactKeys(catalog.producer, ["name", "version"]) ||
    !exactKeys(catalog.summary, ["action_required", "available", "ready", "total", "unavailable"])
  ) {
    throw new WorkbenchError("CATALOG_REPORT_INPUT_INVALID");
  }
  assertSafeCatalogStructuralText(
    catalog.producer.name,
    /^@?[a-z0-9][a-z0-9@/._-]{1,127}$/iu,
  );
  assertSafeCatalogStructuralText(
    catalog.producer.version,
    /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u,
  );
  const maxBytes = options.maxBytes ?? MAX_REPORT_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > MAX_REPORT_BYTES) {
    throw new WorkbenchError("REPORT_LIMIT_INVALID");
  }
  if (Object.hasOwn(options, "live") && typeof options.live !== "boolean") {
    throw new WorkbenchError("CATALOG_REPORT_INPUT_INVALID");
  }
  const projects = Object.freeze(catalog.projects.map((project) =>
    continuityProjectProjection(project, {
      requireHealth: catalogVersion === 3,
      requireWorkspaceMode: catalogVersion >= 2,
    })));
  const expectedSummary = {
    total: projects.length,
    available: projects.filter((project) => project.capture_status === "available").length,
    unavailable: projects.filter((project) => project.capture_status === "unavailable").length,
    ready: projects.filter((project) => project.readiness.status === "ready").length,
    action_required: projects.filter(
      (project) => project.capture_status === "available" && project.readiness.status !== "ready",
    ).length,
  };
  if (
    catalog.summary.total !== expectedSummary.total ||
    catalog.summary.available !== expectedSummary.available ||
    catalog.summary.unavailable !== expectedSummary.unavailable ||
    catalog.summary.ready !== expectedSummary.ready ||
    catalog.summary.action_required !== expectedSummary.action_required
  ) {
    throw new WorkbenchError("CATALOG_REPORT_INPUT_INVALID");
  }
  const memory = memoryProjection(undefined);
  const data = Object.freeze({
    format: catalogVersion === 3
      ? WORKBENCH_CONTINUITY_INTERACTIVE_DATA_FORMAT
      : catalogVersion === 2
        ? "dubsar.workbench-continuity-interactive-data/3"
        : "dubsar.workbench-continuity-interactive-data/2",
    authority: WORKBENCH_AUTHORITY,
    summary: Object.freeze(expectedSummary),
    projects,
    memory,
  });
  for (const project of projects) assertProjectDisplayText(project);
  const dataJson = encodeJsonForHtml(data);
  const dataSha256 = sha256Bytes(Buffer.from(dataJson, "utf8"));
  const html = renderDocument(projects, memory, dataJson, dataSha256, options.live === true);
  const buffer = Buffer.from(html, "utf8");
  if (buffer.length > maxBytes) throw new WorkbenchError("REPORT_SIZE_LIMIT_EXCEEDED");
  return Object.freeze({
    html,
    manifest: Object.freeze({
      format: catalogVersion === 3
        ? WORKBENCH_CONTINUITY_INTERACTIVE_REPORT_FORMAT
        : catalogVersion === 2
          ? "dubsar.workbench-continuity-interactive-report/3"
          : "dubsar.workbench-continuity-interactive-report/2",
      authority: WORKBENCH_AUTHORITY,
      renderer: WORKBENCH_REPORT_RENDERER,
      catalog_format: catalog.format,
      project_count: projects.length,
      available_count: expectedSummary.available,
      bytes: buffer.length,
      sha256: sha256Bytes(buffer),
      script_sha256: sha256Bytes(Buffer.from(CATALOG_INTERACTIVE_SCRIPT, "utf8")),
      style_sha256: sha256Bytes(Buffer.from(`${INTERACTIVE_STYLE}\n${CATALOG_INTERACTIVE_STYLE}`, "utf8")),
      data_sha256: dataSha256,
    }),
  });
}
