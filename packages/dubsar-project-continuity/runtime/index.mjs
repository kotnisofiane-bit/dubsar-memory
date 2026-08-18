import path from "node:path";
import { WorkbenchError, deepFreeze, resolveLimits } from "./contracts.mjs";
import { locateProjectWorkspace } from "./locate.mjs";
import { snapshotProjectWorkspace } from "./snapshot.mjs";
import { evaluateProjectSnapshot } from "./project.mjs";
import {
  detectWorkspaceMode,
  evaluateLiteSnapshot,
  snapshotLiteWorkspace,
} from "./lite.mjs";
import {
  revalidateMemorySnapshot,
  snapshotMemoryWorkspace,
} from "./memory-vnext-snapshot.mjs";
import { evaluateMemorySnapshot } from "./memory-vnext-evaluator.mjs";
import { observeMemoryReferences } from "./memory-vnext-freshness.mjs";

export const CONTINUITY_RUNTIME_IDENTITY = Object.freeze({
  name: "@dubsar/project-continuity-runtime",
  version: "0.3.0-dev",
});

export {
  DEFAULT_LIMITS,
  WORKBENCH_AUTHORITY,
  WorkbenchError,
  exactKeys,
  sha256Bytes,
  stableJson,
} from "./contracts.mjs";
export {
  PROJECT_EVIDENCE_V1_FORMAT,
  PROJECT_EVIDENCE_V2_FORMAT,
  normalizeProjectArtifactPath,
  projectArtifactReferences,
  referenceFreshness,
} from "./continuity.mjs";
export { evaluateProjectSnapshot } from "./project.mjs";
export {
  PROJECT_HISTORY_FORMAT,
  PROJECT_LOTS_VIEW_FORMAT,
  PROJECT_PRECEDENTS_FORMAT,
  buildProjectHistory,
  buildProjectLotsView,
  buildProjectPrecedents,
} from "./continuity-views.mjs";
export {
  MAX_RESUME_CAPSULE_BYTES,
  PROJECT_RESUME_CAPSULE_FORMAT,
  assertProjectResumeCapsule,
  buildProjectResumeCapsule,
} from "./capsule.mjs";
export { locateProjectWorkspace } from "./locate.mjs";
export { snapshotProjectWorkspace } from "./snapshot.mjs";
export {
  LEGACY_MEMORY_ROUTE_FORMAT,
  MEMORY_ROUTE_FORMAT,
  buildMemoryRoute,
} from "./memory-router.mjs";
export {
  deriveContinuityFacts,
  deriveExactRelations,
  exactRelationBases,
  findExactPrecedentRecords,
} from "./continuity-facts.mjs";
export {
  ARTIFACT_LIFECYCLE_FORMAT,
  deriveArtifactLifecycle,
} from "./artifact-lifecycle.mjs";
export {
  LITE_CHECKPOINTS_FORMAT,
  LITE_INIT_PROPOSAL_FORMAT,
  LITE_PROPOSAL_FORMAT,
  LITE_STATE_FORMAT,
  assertLiteCheckpointsDocument,
  assertLiteInitializationProposal,
  assertLiteProposal,
  assertLiteResultingState,
  assertLiteStateDocument,
  detectWorkspaceMode,
  evaluateLiteSnapshot,
  snapshotLiteWorkspace,
} from "./lite.mjs";
export {
  MEMORY_CHECKPOINTS_FORMAT,
  MEMORY_KNOWLEDGE_FORMAT,
  MEMORY_LOCAL_FORMAT,
  MEMORY_MANIFEST_FORMAT,
  MEMORY_PENDING_LIST_FORMAT,
  MEMORY_WORK_FORMAT,
  PENDING_LIST_DIAGNOSTICS,
  assertMemoryCheckpoints,
  assertMemoryKnowledge,
  assertMemoryLocalState,
  assertMemoryManifest,
  assertMemoryWork,
  memoryCheckpointDigest,
} from "./memory-vnext-contracts.mjs";
export { parseMemoryMarkdown, serializeMemoryMarkdown } from "./memory-vnext-markdown.mjs";
export { snapshotMemoryWorkspace } from "./memory-vnext-snapshot.mjs";
export { compileMemorySnapshot } from "./memory-snapshot-compiler.mjs";
export { evaluateMemorySnapshot } from "./memory-vnext-evaluator.mjs";
export {
  MEMORY_CONTEXT_FORMAT,
  buildMemoryContext,
  renderMemoryContextMarkdown,
} from "./memory-context.mjs";
export {
  MEMORY_INBOX_VIEW_FORMAT,
  MEMORY_KNOWLEDGE_VIEW_FORMAT,
  MEMORY_WORK_VIEW_FORMAT,
  buildMemoryInboxView,
  buildMemoryKnowledgeView,
  buildMemoryWorkView,
} from "./memory-vnext-views.mjs";
export {
  MEMORY_RESUME_CAPSULE_FORMAT,
  assertMemoryResumeCapsule,
  buildMemoryResumeCapsule,
} from "./memory-vnext-capsule.mjs";

export async function inspectWorkspace({
  start,
  domain = "project",
  limits: limitOverrides,
  observeReferences = false,
} = {}) {
  if (domain !== "project") throw new WorkbenchError("DOMAIN_INVALID");
  const limits = resolveLimits(limitOverrides);
  const location = await locateProjectWorkspace({ start, maxParents: limits.maxParents });
  const mode = location.marker === ".dubsar" ? "memory_vnext" : await detectWorkspaceMode(location.root);
  const snapshot = mode === "memory_vnext"
    ? await snapshotMemoryWorkspace(location, limits)
    : mode === "lite" ? await snapshotLiteWorkspace(location, limits) : await snapshotProjectWorkspace(location, limits);
  // Reference observation is opt-in and memory-vNext only. Writers never ask
  // for it, so a preview or apply stays independent of external artifacts.
  let observation = null;
  if (observeReferences === true && mode === "memory_vnext") {
    observation = await observeMemoryReferences({
      projectRoot: location.project_root ?? path.dirname(location.root),
      snapshot,
      limits,
    });
    // Re-snapshot the canonical workspace after reading outside it.
    await revalidateMemorySnapshot(location, limits, snapshot.snapshot_sha256);
  }
  const evaluation = mode === "memory_vnext"
    ? evaluateMemorySnapshot(snapshot, observation)
    : mode === "lite" ? evaluateLiteSnapshot(snapshot) : evaluateProjectSnapshot(snapshot);
  return deepFreeze({ location, snapshot, evaluation, observation });
}
