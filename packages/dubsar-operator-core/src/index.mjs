import { deepFreeze, resolveLimits } from "./contracts.mjs";
import { evaluateAuditSnapshot } from "./audit.mjs";
import { locateWorkspace } from "./locate.mjs";
import { evaluateProjectSnapshot } from "./project.mjs";
import { readReviewLedger } from "./review-ledger.mjs";
import {
  captureWorkspaceSnapshot,
  snapshotWorkspace,
} from "./snapshot.mjs";
import { buildWorkbenchView } from "./view-model.mjs";
import { buildWorkbenchGraph } from "./graph-model.mjs";
import {
  inspectWorkspace as inspectContinuityWorkspace,
  locateProjectWorkspace,
} from "../../dubsar-project-continuity/runtime/index.mjs";

export const OPERATOR_CORE_IDENTITY = Object.freeze({
  name: "@dubsar/operator-core",
  version: "0.1.0-dev",
});

export {
  DEFAULT_LIMITS,
  WORKBENCH_AUTHORITY,
  WORKBENCH_VIEW_FORMAT,
  WorkbenchError,
  resolveLimits,
  sha256Bytes,
  stableJson,
  exactKeys,
} from "./contracts.mjs";
export { locateWorkspace } from "./locate.mjs";
export { snapshotWorkspace } from "./snapshot.mjs";
export { evaluateAuditSnapshot } from "./audit.mjs";
export { evaluateProjectSnapshot } from "./project.mjs";
export { buildWorkbenchView } from "./view-model.mjs";
export {
  PROJECT_REGISTRY_FORMAT,
  MAX_PROJECTS,
  MAX_REGISTRY_BYTES,
  createProjectRegistry,
  loadProjectRegistry,
  parseProjectRegistry,
} from "./project-registry.mjs";
export {
  WORKBENCH_CATALOG_FORMAT,
  WORKBENCH_CONTINUITY_DATA_FORMAT,
  inspectProjectCatalog,
  inspectProjectContinuityCatalog,
} from "./catalog.mjs";
export {
  RESUME_CAPSULE_FORMAT,
  assertResumeCapsule,
  buildResumeCapsule,
} from "./capsule.mjs";
export {
  MAX_RESUME_CAPSULE_BYTES,
  PROJECT_RESUME_CAPSULE_FORMAT,
  assertProjectResumeCapsule,
  buildProjectResumeCapsule,
} from "../../dubsar-project-continuity/runtime/capsule.mjs";
export {
  MAX_MEMORY_RESUME_CAPSULE_BYTES,
  MEMORY_RESUME_CAPSULE_FORMAT,
  assertMemoryResumeCapsule,
  buildMemoryResumeCapsule,
} from "../../dubsar-project-continuity/runtime/memory-vnext-capsule.mjs";
export {
  PROJECT_EVIDENCE_V1_FORMAT,
  PROJECT_EVIDENCE_V2_FORMAT,
  normalizeProjectArtifactPath,
  projectArtifactReferences,
  referenceFreshness,
} from "./continuity.mjs";
export {
  PROJECT_HISTORY_FORMAT,
  PROJECT_LOTS_VIEW_FORMAT,
  PROJECT_PRECEDENTS_FORMAT,
  buildProjectHistory,
  buildProjectLotsView,
  buildProjectPrecedents,
} from "./continuity-views.mjs";
export {
  WORKBENCH_GRAPH_FORMAT,
  buildWorkbenchGraph,
} from "./graph-model.mjs";

export async function inspectWorkspace({
  start,
  domain,
  limits: limitOverrides,
  producer = OPERATOR_CORE_IDENTITY,
} = {}) {
  const limits = resolveLimits(limitOverrides);
  if (domain === "project") {
    const continuityLocation = await locateProjectWorkspace({
      start,
      maxParents: limits.maxParents,
    });
    if (continuityLocation.marker === ".dubsar") {
      const continuityInspection = await inspectContinuityWorkspace({
        start,
        domain,
        limits,
      });
      const { location, snapshot, evaluation } = continuityInspection;
      const view = buildWorkbenchView({ snapshot, evaluation, limits, producer });
      const graph = buildWorkbenchGraph({ snapshot, view, limits });
      return deepFreeze({ location, snapshot, evaluation, view, graph });
    }
  }
  const location = await locateWorkspace({
    start,
    domain,
    maxParents: limits.maxParents,
  });
  const snapshot = await snapshotWorkspace(location, limits);
  const evaluation =
    snapshot.domain === "project"
      ? evaluateProjectSnapshot(snapshot)
      : evaluateAuditSnapshot(snapshot);
  const view = buildWorkbenchView({ snapshot, evaluation, limits, producer });
  const graph = buildWorkbenchGraph({ snapshot, view, limits });
  return Object.freeze({ location, snapshot, evaluation, view, graph });
}

export async function inspectWorkspaceWithReviews({
  start,
  domain,
  limits: limitOverrides,
  producer = OPERATOR_CORE_IDENTITY,
} = {}) {
  const limits = resolveLimits(limitOverrides);
  if (domain === "project") {
    const continuityLocation = await locateProjectWorkspace({
      start,
      maxParents: limits.maxParents,
    });
    if (continuityLocation.marker === ".dubsar") {
      const continuityInspection = await inspectContinuityWorkspace({
        start,
        domain,
        limits,
      });
      const { location, snapshot, evaluation } = continuityInspection;
      const view = buildWorkbenchView({ snapshot, evaluation, limits, producer });
      const graph = buildWorkbenchGraph({ snapshot, view, limits });
      return deepFreeze({
        location,
        snapshot,
        evaluation,
        view,
        graph,
        review_ledger: null,
      });
    }
  }
  const location = await locateWorkspace({
    start,
    domain,
    maxParents: limits.maxParents,
  });
  const captured = await captureWorkspaceSnapshot(location, limits);
  const { snapshot, canonical_root_sha256: canonicalRootSha256 } = captured;
  const evaluation =
    snapshot.domain === "project"
      ? evaluateProjectSnapshot(snapshot)
      : evaluateAuditSnapshot(snapshot);
  const view = buildWorkbenchView({ snapshot, evaluation, limits, producer });
  const graph = buildWorkbenchGraph({ snapshot, view, limits });
  const contextId =
    snapshot.domain === "project"
      ? snapshot.documents["mission.json"].mission_id
      : snapshot.documents["audit-scope.json"].case_id;
  const reviewIdentities = deepFreeze({
    domain: snapshot.domain,
    context_id: contextId,
    canonical_root_sha256: canonicalRootSha256,
    snapshot_sha256: snapshot.snapshot_sha256,
  });
  const reviewLedger = await readReviewLedger(location.root, reviewIdentities);
  return deepFreeze({
    location,
    snapshot,
    evaluation,
    view,
    graph,
    review_ledger: reviewLedger,
  });
}
