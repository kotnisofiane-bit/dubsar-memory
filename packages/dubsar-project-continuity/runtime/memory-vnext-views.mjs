import { opendir } from "node:fs/promises";
import {
  WORKBENCH_AUTHORITY,
  WorkbenchError,
  deepFreeze,
} from "./contracts.mjs";
import { safeDisplayText } from "./display-safety.mjs";
import { captureRegularFile } from "./safe-capture.mjs";
import { parseMemoryMarkdown } from "./memory-vnext-markdown.mjs";

export const MEMORY_WORK_VIEW_FORMAT = "dubsar.memory-work-view/1";
export const MEMORY_KNOWLEDGE_VIEW_FORMAT = "dubsar.memory-knowledge-view/1";
export const MEMORY_INBOX_VIEW_FORMAT = "dubsar.memory-inbox-view/1";

function requireMemory(inspection) {
  if (inspection?.snapshot?.workspace_mode !== "memory_vnext") {
    throw new WorkbenchError("MEMORY_WORKSPACE_REQUIRED");
  }
}

function display(value, max = 500) {
  const result = safeDisplayText(value, max);
  return result.redacted ? "[content withheld]" : result.text;
}

export function buildMemoryWorkView({ inspection, status } = {}) {
  requireMemory(inspection);
  if (status !== undefined && !new Set(["open", "paused", "complete"]).has(status)) {
    throw new WorkbenchError("MEMORY_WORK_FILTER_INVALID");
  }
  const selected = inspection.evaluation.memory.selected_work?.work_id ?? null;
  const items = inspection.evaluation.memory.work_items
    .filter((item) => status === undefined || item.status === status)
    .map((item) => ({
      work_id: item.work_id,
      title: display(item.title, 300),
      status: item.status,
      scope: item.scope,
      selected: item.work_id === selected,
      objective: display(item.objective, 800),
      acceptance_criteria: item.acceptance_criteria.map((entry) => display(entry, 500)),
      knowledge_ids: [...item.knowledge_ids],
      references: [...item.references],
    }));
  return deepFreeze({
    format: MEMORY_WORK_VIEW_FORMAT,
    authority: WORKBENCH_AUTHORITY,
    source: { project_id: inspection.evaluation.id, snapshot_sha256: inspection.snapshot.snapshot_sha256 },
    selected_work_id: selected,
    automatic_selection: false,
    items,
  });
}

export function buildMemoryKnowledgeView({ inspection, domain, status, knowledgeId } = {}) {
  requireMemory(inspection);
  if (status !== undefined && !new Set(["approved", "superseded", "retired"]).has(status)) {
    throw new WorkbenchError("MEMORY_KNOWLEDGE_FILTER_INVALID");
  }
  const items = inspection.snapshot.documents.knowledge
    .filter((item) => domain === undefined || item.domain === domain)
    .filter((item) => status === undefined || item.status === status)
    .filter((item) => knowledgeId === undefined || item.knowledge_id === knowledgeId)
    .map((item) => ({
      knowledge_id: item.knowledge_id,
      title: display(item.title, 300),
      domain: item.domain,
      kind: item.kind,
      status: item.status,
      statement: display(item.statement, 1_000),
      provenance: item.provenance,
      supersedes: item.supersedes,
    }));
  if (knowledgeId !== undefined && items.length === 0) throw new WorkbenchError("MEMORY_KNOWLEDGE_NOT_FOUND");
  return deepFreeze({
    format: MEMORY_KNOWLEDGE_VIEW_FORMAT,
    authority: WORKBENCH_AUTHORITY,
    source: { project_id: inspection.evaluation.id, snapshot_sha256: inspection.snapshot.snapshot_sha256 },
    items,
  });
}

export async function buildMemoryInboxView({ inspection } = {}) {
  requireMemory(inspection);
  const names = [];
  let directory;
  try {
    directory = await opendir(`${inspection.location.root}/inbox`);
    for await (const entry of directory) {
      if (entry.name === ".gitkeep" && entry.isFile() && !entry.isSymbolicLink()) continue;
      if (!entry.isFile() || entry.isSymbolicLink() || !/^[a-z0-9][a-z0-9._-]{2,127}\.md$/iu.test(entry.name)) {
        throw new WorkbenchError("MEMORY_INBOX_INVALID");
      }
      names.push(entry.name);
      if (names.length > 128) throw new WorkbenchError("MEMORY_INBOX_LIMIT_EXCEEDED");
    }
  } finally {
    await directory?.close().catch(() => {});
  }
  const items = [];
  for (const name of names.sort()) {
    const captured = await captureRegularFile(inspection.location.root, `inbox/${name}`, 64 * 1024);
    let parsed;
    try {
      parsed = parseMemoryMarkdown(new TextDecoder("utf-8", { fatal: true }).decode(captured.content));
    } catch {
      throw new WorkbenchError("MEMORY_INBOX_INVALID");
    }
    if (parsed.frontmatter?.format !== "dubsar.inbox-note/1" ||
      parsed.frontmatter?.note_id !== name.slice(0, -3) || Object.keys(parsed.frontmatter).length !== 2) {
      throw new WorkbenchError("MEMORY_INBOX_INVALID");
    }
    items.push({
      note_id: parsed.frontmatter.note_id,
      preview: display(parsed.body, 240),
      source_sha256: captured.sha256,
      advisory: true,
    });
  }
  return deepFreeze({
    format: MEMORY_INBOX_VIEW_FORMAT,
    authority: WORKBENCH_AUTHORITY,
    source: { project_id: inspection.evaluation.id, snapshot_sha256: inspection.snapshot.snapshot_sha256 },
    local_only: true,
    items,
  });
}
