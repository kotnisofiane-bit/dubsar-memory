import { WorkbenchError, deepFreeze } from "./contracts.mjs";

export const MEMORY_SNAPSHOT_FORMAT = "dubsar.memory-snapshot/1";

function fail(code = "MEMORY_SNAPSHOT_INVALID") {
  throw new WorkbenchError(code);
}

export function compileMemorySnapshot(snapshot) {
  if (
    snapshot?.format !== "dubsar.workspace-snapshot/1" ||
    snapshot?.workspace_mode !== "memory_vnext" ||
    !snapshot.documents?.manifest ||
    !snapshot.documents?.local ||
    !snapshot.documents?.checkpoints ||
    !Array.isArray(snapshot.documents.works) ||
    !Array.isArray(snapshot.documents.knowledge)
  ) fail();

  const { manifest, local, checkpoints } = snapshot.documents;
  const workItems = [...snapshot.documents.works];
  const selectedWork = local.selected_work_id === null
    ? null
    : workItems.find((item) => item.work_id === local.selected_work_id) ?? null;
  if (local.selected_work_id !== null && selectedWork === null) fail("MEMORY_LOCAL_INVALID");

  const knowledgeById = new Map(
    snapshot.documents.knowledge.map((item) => [item.knowledge_id, item]),
  );
  const linkedKnowledge = selectedWork === null
    ? []
    : selectedWork.knowledge_ids.flatMap((id) => {
        const item = knowledgeById.get(id);
        return item?.status === "approved" ? [item] : [];
      });
  const selectedCheckpoints = selectedWork === null
    ? []
    : checkpoints.entries.filter((item) => item.work_id === selectedWork.work_id).slice(-8);
  const latestCheckpointByWork = new Map();
  for (const entry of checkpoints.entries) latestCheckpointByWork.set(entry.work_id, entry);
  const incompleteWorkIds = workItems
    .filter((item) => item.status !== "complete")
    .map((item) => item.work_id);
  const eligibleWorkIds = workItems
    .filter((item) => item.status === "open" &&
      (latestCheckpointByWork.get(item.work_id)?.resulting_state.blockers.length ?? 0) === 0)
    .map((item) => item.work_id)
    .sort();

  let action;
  if (selectedWork === null) {
    action = incompleteWorkIds.length === 0 ? "continuity_complete" : "choose_work";
  } else if (selectedWork.status === "complete") {
    action = "finish_recorded";
  } else if (selectedWork.status === "paused") {
    action = "review_paused_work";
  } else {
    action = "continue_selected_work";
  }

  return deepFreeze({
    format: MEMORY_SNAPSHOT_FORMAT,
    source: {
      snapshot_sha256: snapshot.snapshot_sha256,
      shared_snapshot_sha256: snapshot.shared_snapshot_sha256,
      workspace_mode: "memory_vnext",
    },
    project: {
      project_id: manifest.project_id,
      title: manifest.title,
      legacy_snapshot_sha256: manifest.legacy_snapshot_sha256,
    },
    work_items: workItems,
    selected_work: selectedWork,
    knowledge: linkedKnowledge,
    checkpoints: selectedCheckpoints,
    routing: {
      action,
      eligible_work_ids: eligibleWorkIds,
      auto_execute: false,
    },
  });
}
