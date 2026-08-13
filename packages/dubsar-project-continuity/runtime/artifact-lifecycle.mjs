import { WORKBENCH_AUTHORITY, deepFreeze } from "./contracts.mjs";

export const ARTIFACT_LIFECYCLE_FORMAT = "dubsar.artifact-lifecycle/1";

export function deriveArtifactLifecycle(facts) {
  const latest = facts.records.at(-1) ?? null;
  let state;
  let reasonCode;
  if (latest === null) {
    state = "empty";
    reasonCode = "NO_CONTINUITY_RECORD";
  } else if (facts.integrity_status !== "valid") {
    state = "recorded";
    reasonCode = "RECORD_PRESENT_WITHOUT_VALID_INTEGRITY";
  } else if (facts.work_state.status === "complete") {
    state = "closed_recorded";
    reasonCode = "COMPLETE_STATE_RECORDED";
  } else {
    state = "integrity_checked";
    reasonCode = "RECORDED_CHAIN_INTEGRITY_VALID";
  }
  return deepFreeze({
    format: ARTIFACT_LIFECYCLE_FORMAT,
    authority: WORKBENCH_AUTHORITY,
    source: { ...facts.source },
    state,
    record_id: latest?.record_id ?? null,
    reason_codes: [reasonCode],
    auto_execute: false,
  });
}
