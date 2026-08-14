import {
  WORKBENCH_AUTHORITY,
  WorkbenchError,
  deepFreeze,
  stableJson,
} from "./contracts.mjs";
import { compileMemorySnapshot } from "./memory-snapshot-compiler.mjs";

function fail(code) {
  throw new WorkbenchError(code);
}

function latestWorkState(entries, work) {
  if (!work) return null;
  const checkpoint = entries.at(-1) ?? null;
  const recorded = checkpoint?.resulting_state ?? {
    summary: work.objective,
    blockers: [],
    next_action: work.status === "complete"
      ? "Choose another open work item or record the project handoff."
      : work.status === "paused"
        ? "Review the recorded pause before resuming this work item."
        : `Continue the selected work item: ${work.title}`,
  };
  return {
    ...recorded,
    status: work.status === "complete" ? "complete" : work.status === "paused" ? "paused" : "active",
  };
}

function repeatedAttempt(entries, workId) {
  const attempts = entries.filter((entry) => entry.work_id === workId).slice(-2);
  return attempts.length === 2 &&
    attempts.every((entry) => entry.kind === "attempt" && entry.attempt !== null) &&
    attempts[0].attempt.action_id === attempts[1].attempt.action_id &&
    attempts[0].attempt.gate_id === attempts[1].attempt.gate_id &&
    attempts[0].attempt.failure_fingerprint === attempts[1].attempt.failure_fingerprint &&
    attempts[0].references.length === 0 && attempts[1].references.length === 0 &&
    stableJson(attempts[0].resulting_state) === stableJson(attempts[1].resulting_state);
}

export function evaluateMemorySnapshot(snapshot) {
  if (snapshot?.workspace_mode !== "memory_vnext") fail("MEMORY_SNAPSHOT_REQUIRED");
  const compiled = compileMemorySnapshot(snapshot);
  const entries = snapshot.documents?.checkpoints?.entries;
  if (!Array.isArray(entries)) fail("MEMORY_CHECKPOINTS_INVALID");
  const work = compiled.selected_work;
  const selectedEntries = work === null
    ? []
    : entries.filter((entry) => entry.work_id === work.work_id);
  const current = latestWorkState(selectedEntries, work);
  const repeated = work !== null && repeatedAttempt(selectedEntries, work.work_id);
  const workItems = Array.isArray(compiled.work_items) ? compiled.work_items : [];
  const noWorkRecorded = workItems.length === 0;
  const openItems = workItems.filter((item) => item.status !== "complete");
  const blockers = current?.blockers ?? [];
  const nextAction = work === null
    ? noWorkRecorded
      ? {
          code: "record_work",
          label: "No work item is recorded; record one before continuing. DUBSAR will not create it for you.",
        }
      : {
          code: openItems.length === 0 ? "continuity_complete" : "choose_work",
          label: openItems.length === 0
            ? "All recorded work items are complete."
            : "Choose an open work item; DUBSAR will not choose it for you.",
        }
    : work.status === "complete"
      ? { code: "finish_recorded", label: "The selected work item is recorded as complete." }
    : repeated
      ? { code: "reframe_recommended", label: "Reframe the approach before repeating the same failed attempt." }
      : blockers.length > 0
        ? { code: "resolve_recorded_blocker", label: "Review the recorded blockers before continuing." }
        : work.status === "paused"
          ? { code: "review_paused_work", label: "Review the recorded pause before resuming this work item." }
          : { code: "continue_selected_work", label: current.next_action };
  const records = selectedEntries.map((entry) => ({
    evidence_id: entry.checkpoint_id,
    lot_id: entry.work_id,
    kind: entry.kind,
    class: entry.references.length > 0 ? "observed" : "reported",
    statement: entry.summary,
    supported: entry.references.length > 0,
    freshness: entry.references.length > 0 ? ["unknown"] : [],
  }));
  return deepFreeze({
    authority: WORKBENCH_AUTHORITY,
    domain: "project",
    id: compiled.project.project_id,
    workspace_mode: "memory_vnext",
    integrity: { status: "valid", diagnostics: [] },
    readiness: {
      status: noWorkRecorded || (work === null && openItems.length > 0) ? "not_ready" : "ready",
      reasons: noWorkRecorded
        ? ["NO_WORK_RECORDED"]
        : work === null && openItems.length > 0 ? ["WORK_SELECTION_REQUIRED"] : [],
    },
    counts: {
      lots: workItems.length,
      complete_lots: workItems.filter((item) => item.status === "complete").length,
      evidence_entries: selectedEntries.length,
    },
    next_action: nextAction,
    memory: {
      ...compiled,
      current_state: current,
      repeated_attempt: repeated,
    },
    continuity: {
      records,
      decisions: selectedEntries.filter((entry) => entry.kind === "decision").map((entry) => ({
        evidence_id: entry.checkpoint_id,
        statement: entry.summary,
      })),
      open_blockers: blockers.map((blocker) => ({
        evidence_id: blocker.blocker_id,
        lot_id: work?.work_id ?? null,
        statement: blocker.statement,
      })),
      freshness: {
        fresh: 0,
        stale: 0,
        missing: 0,
        unknown: selectedEntries.flatMap((entry) => entry.references).length,
      },
    },
  });
}
