import { WORKBENCH_AUTHORITY, deepFreeze } from "./contracts.mjs";
import { deriveArtifactLifecycle } from "./artifact-lifecycle.mjs";
import { deriveContinuityFacts, deriveExactRelations } from "./continuity-facts.mjs";

export const MEMORY_ROUTE_FORMAT = "dubsar.memory-route/2";
export const LEGACY_MEMORY_ROUTE_FORMAT = "dubsar.memory-route/1";

function memoryState(facts) {
  const latest = facts.records.at(-1) ?? null;
  if (latest === null) return "empty";
  if (facts.work_state.status === "complete" && facts.integrity_status === "valid") {
    return "closed_recorded";
  }
  if (latest.kind === "blocker_resolution" && latest.resolves !== null) return "resumed";
  if (
    facts.work_state.blocker_count > 0 || facts.repeated_attempt ||
    facts.records.some((record) => record.limitation_count > 0)
  ) return "limited";
  if (facts.records.some((record) => record.references.length > 0)) return "referenced";
  return "recorded";
}

function guidance(facts, relations) {
  let action;
  let reasonCode;
  let relatedRecordId = null;
  if (facts.integrity_status !== "valid") {
    action = "none";
    reasonCode = "WORKSPACE_INTEGRITY_INVALID";
  } else if (
    facts.source.workspace_mode === "memory_vnext" &&
    facts.guidance_hints.selected_work_id === null &&
    facts.guidance_hints.open_work_count > 0
  ) {
    action = "none";
    reasonCode = "WORK_SELECTION_REQUIRED";
  } else if (facts.work_state.status === "complete") {
    action = "finish_recorded";
    reasonCode = "COMPLETE_STATE_RECORDED";
  } else if (facts.work_state.status === "unknown") {
    if (facts.source.workspace_mode === "legacy" && facts.work_state.blocker_count > 0) {
      action = "pause";
      reasonCode = "RECORDED_BLOCKER_OPEN";
    } else if (facts.source.workspace_mode === "legacy" && facts.readiness_status === "ready") {
      action = "continue";
      reasonCode = "VERIFIED_ACTION_AVAILABLE";
    } else if (facts.records.length === 0) {
      action = "record";
      reasonCode = "NO_CONTINUITY_RECORD";
    } else {
      action = "none";
      reasonCode = "RECORDED_STATE_UNKNOWN";
    }
  } else if (facts.repeated_attempt) {
    action = "reconsider";
    reasonCode = "EQUIVALENT_UNSUPPORTED_ATTEMPT_REPEATED";
  } else if (facts.work_state.blocker_count > 0) {
    action = "pause";
    reasonCode = "RECORDED_BLOCKER_OPEN";
  } else if (facts.work_state.status === "paused" && relations.matches.length > 0) {
    action = "resume_candidate";
    reasonCode = "EXACT_RECORDED_RELATION_AVAILABLE";
    relatedRecordId = relations.matches.at(0).record_id;
  } else if (facts.work_state.status === "paused") {
    action = "pause";
    reasonCode = "PAUSED_WITHOUT_EXACT_REACTIVATION_SIGNAL";
  } else if (facts.records.length === 0) {
    action = "record";
    reasonCode = "NO_CONTINUITY_RECORD";
  } else {
    action = "continue";
    reasonCode = "RECORDED_ACTION_AVAILABLE";
  }
  return {
    action,
    reason_codes: [reasonCode],
    related_record_id: relatedRecordId,
    auto_execute: false,
  };
}

function nativeGuidance(facts, action) {
  const planConsidered = facts.repeated_attempt || facts.work_state.blocker_count > 1 ||
    action === "reconsider" || new Set(["multi_step", "multi_session"]).has(facts.guidance_hints.scope);
  const goalConsidered = facts.work_state.status === "paused" || facts.guidance_hints.scope === "multi_session";
  return {
    plan: {
      recommendation: planConsidered ? "consider" : "not_indicated",
      reason_code: facts.repeated_attempt || action === "reconsider"
        ? "REFRAME_BEFORE_ANOTHER_ATTEMPT"
        : facts.work_state.blocker_count > 1
          ? "MULTIPLE_RECORDED_BLOCKERS"
          : new Set(["multi_step", "multi_session"]).has(facts.guidance_hints.scope)
            ? "WORK_SCOPE_RECORDED_AS_MULTI_STEP"
            : "NO_ROUTING_SIGNAL",
    },
    goal: {
      recommendation: goalConsidered ? "consider" : "not_indicated",
      reason_code: facts.work_state.status === "paused"
        ? "RECORDED_WORK_PAUSED"
        : facts.guidance_hints.scope === "multi_session"
          ? "WORK_SCOPE_RECORDED_AS_MULTI_SESSION"
          : "DURATION_NOT_RECORDED",
    },
  };
}

export function buildMemoryRoute({ inspection } = {}) {
  const facts = deriveContinuityFacts({ inspection });
  const exactRelations = deriveExactRelations(facts);
  const projectedGuidance = guidance(facts, exactRelations);
  return deepFreeze({
    format: MEMORY_ROUTE_FORMAT,
    authority: WORKBENCH_AUTHORITY,
    source: { ...facts.source },
    guidance: projectedGuidance,
    memory_state: memoryState(facts),
    exact_relations: exactRelations,
    artifact_lifecycle: deriveArtifactLifecycle(facts),
    native_guidance: nativeGuidance(facts, projectedGuidance.action),
  });
}
