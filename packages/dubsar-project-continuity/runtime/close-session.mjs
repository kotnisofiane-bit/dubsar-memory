import { createInterface } from "node:readline/promises";
import {
  WorkbenchError,
  buildProjectLotsView,
  buildProjectResumeCapsule,
  inspectWorkspace,
  memoryCheckpointDigest,
  normalizeProjectArtifactPath,
  sha256Bytes,
  stableJson,
} from "./index.mjs";
import { safeDisplayText } from "./display-safety.mjs";
import {
  applyCheckpointProposal,
  previewCheckpointProposal,
} from "./checkpoint-writer.mjs";
import { applyMemoryChange, previewMemoryChange } from "./memory-vnext-writer.mjs";
import { captureRegularFile } from "./safe-capture.mjs";

export const CLOSE_RESULT_FORMAT = "dubsar.close-result/1";

const FORBIDDEN_TEXT =
  /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060\u2066-\u2069\ufeff]/u;
const ACTIVE_INSTRUCTION =
  /\b(?:ignore|disregard|override)\b.{0,40}\b(?:instruction|prompt|policy|rule)s?\b|<\|(?:system|assistant|user|im_end)\|>|```|^\s*(?:system|assistant|developer|user)\s*:|\b(?:when|once)\b.{0,60}\b(?:resum(?:e|ed)|loaded|opened)\b.{0,60}\b(?:run|execute|deploy|publish|merge|delete|send)\b|\b(?:run|execute|deploy|publish|merge|delete|send)\b.{0,40}\bautomatically\b/iu;
const ACTIVE_HTML = /<(?:script|iframe|object|embed|img|link|style)\b|javascript\s*:|data\s*:\s*text\/html/iu;
const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu;
const PHONE = /(?:^|[^\p{L}\p{N}])(?!\d{4}-\d{2}-\d{2}(?:$|[^\p{L}\p{N}]))\+?\d(?:[ ./()-]*\d){7,}(?=$|[^\p{L}\p{N}])/u;
const IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/u;

const MESSAGES = new Map([
  ["en", Object.freeze({
    active: (id) => `Active work package: ${id}\n`,
    choose: "Enter the exact work package ID: ",
    decision: "Optional project decision (Enter to skip): ",
    fact: "Optional verified fact (Enter to skip): ",
    validation: "How was this fact verified? ",
    references: "Safe relative references, comma-separated (1-8): ",
    blocker: "Optional open blocker (Enter to skip): ",
    preview: "Normalized checkpoint entries:\n",
    continue: "Type CONTINUE to prepare the live preview: ",
    apply: (digest) => `Change SHA-256: ${digest}\nType APPLY to write evidence.json: `,
    capsuleOnly: "No checkpoint entry was provided. A resume capsule was generated without writing.\n",
    applied: "Checkpoint applied. A post-checkpoint resume capsule was generated.\n",
    memoryOptIn: "Type YES to prepare one separate personal journal entry (Enter to skip): ",
    memoryNote: "Personal journal note: ",
    memoryPreview: "Exact personal-memory Markdown preview:\n",
    memoryApply: "Type APPLY MEMORY to append this one journal entry: ",
    memorySkipped: "Personal memory was not changed.\n",
    memoryFailed: (code) => `Project checkpoint remains applied. Personal memory failed: ${code}\n`,
    liteSummary: "Optional checkpoint summary (Enter to generate a capsule only): ",
    liteReferences: "Optional safe relative references, comma-separated: ",
    liteNext: "Next action after this checkpoint: ",
    liteBlocker: "Optional open blocker (Enter to keep none): ",
  })],
  ["fr", Object.freeze({
    active: (id) => `Lot actif : ${id}\n`,
    choose: "Saisissez l’identifiant exact du lot : ",
    decision: "Décision de projet facultative (Entrée pour ignorer) : ",
    fact: "Fait vérifié facultatif (Entrée pour ignorer) : ",
    validation: "Comment ce fait a-t-il été vérifié ? ",
    references: "Références relatives sûres, séparées par des virgules (1-8) : ",
    blocker: "Blocage encore ouvert facultatif (Entrée pour ignorer) : ",
    preview: "Entrées de checkpoint normalisées :\n",
    continue: "Saisissez CONTINUE pour préparer l’aperçu vivant : ",
    apply: (digest) => `SHA-256 du changement : ${digest}\nSaisissez APPLY pour écrire evidence.json : `,
    capsuleOnly: "Aucune entrée n’a été fournie. Une capsule de reprise a été générée sans écriture.\n",
    applied: "Checkpoint appliqué. Une capsule post-checkpoint a été générée.\n",
    memoryOptIn: "Saisissez YES pour préparer une entrée de journal personnel séparée (Entrée pour ignorer) : ",
    memoryNote: "Note du journal personnel : ",
    memoryPreview: "Aperçu Markdown exact de la mémoire personnelle :\n",
    memoryApply: "Saisissez APPLY MEMORY pour ajouter cette unique entrée : ",
    memorySkipped: "La mémoire personnelle n’a pas été modifiée.\n",
    memoryFailed: (code) => `Le checkpoint projet reste appliqué. Échec de la mémoire personnelle : ${code}\n`,
    liteSummary: "Synthèse facultative du checkpoint (Entrée pour une capsule seule) : ",
    liteReferences: "Références relatives sûres facultatives, séparées par des virgules : ",
    liteNext: "Prochaine action après ce checkpoint : ",
    liteBlocker: "Blocage ouvert facultatif (Entrée pour aucun) : ",
  })],
]);

function strictText(value, code = "CLOSE_TEXT_INVALID") {
  if (typeof value !== "string") throw new WorkbenchError(code);
  if (value === "") return "";
  if (
    value !== value.trim() || Array.from(value).length > 500 ||
    FORBIDDEN_TEXT.test(value) || ACTIVE_INSTRUCTION.test(value) || ACTIVE_HTML.test(value) ||
    EMAIL.test(value) || PHONE.test(value) || IPV4.test(value)
  ) throw new WorkbenchError(code);
  const display = safeDisplayText(value, 500);
  if (display.redacted || display.truncated || display.text !== value) {
    throw new WorkbenchError(code);
  }
  return value;
}

function parseReferences(value) {
  if (typeof value !== "string" || value === "") {
    throw new WorkbenchError("CLOSE_FACT_REFERENCES_REQUIRED");
  }
  const raw = value.split(",");
  if (raw.length < 1 || raw.length > 8 || raw.some((item) => item.trim() !== item || item === "")) {
    throw new WorkbenchError("CLOSE_FACT_REFERENCES_INVALID");
  }
  const normalized = raw.map((item) => normalizeProjectArtifactPath(item));
  if (new Set(normalized).size !== normalized.length) {
    throw new WorkbenchError("CLOSE_FACT_REFERENCES_INVALID");
  }
  return normalized;
}

function parseOptionalReferences(value) {
  if (value === "") return [];
  return parseReferences(value);
}

function evidenceId(snapshotSha256, lotId, kind, content) {
  const digest = sha256Bytes(Buffer.from(stableJson({
    snapshot_sha256: snapshotSha256,
    lot_id: lotId,
    kind,
    content,
  }), "utf8"));
  return `evidence-close-${digest.slice(0, 24)}`;
}

function proposalEntry({ snapshotSha256, lotId, kind, statement, artifactRefs = [], validation = [] }) {
  const id = evidenceId(snapshotSha256, lotId, kind, {
    statement,
    artifact_refs: artifactRefs,
    validation,
  });
  return {
    evidence_id: id,
    lot_id: lotId,
    kind,
    statement,
    class: kind === "fact" ? "observed" : "reported",
    artifact_refs: artifactRefs,
    validation,
    limitations: kind === "fact" ? [] : ["Recorded as a human declaration."],
    resolves: null,
  };
}

function safeLotTitle(value) {
  const display = safeDisplayText(value, 160);
  return display.redacted ? "[content withheld]" : display.text;
}

async function chooseLot(inspection, readLine, writeOut, messages) {
  const lots = inspection.snapshot.documents["lots.json"].lots;
  const active = lots.find((lot) => lot.status === "candidate");
  if (active) {
    writeOut(messages.active(active.lot_id));
    return active.lot_id;
  }
  const open = lots.filter((lot) => lot.status !== "complete");
  if (open.length === 0) throw new WorkbenchError("CLOSE_NO_OPEN_LOT");
  const view = buildProjectLotsView({ inspection });
  for (const item of view.lots.filter((lot) => lot.declared_status !== "complete")) {
    writeOut(`- ${item.lot_id}: ${safeLotTitle(item.title)} [${item.category}]\n`);
  }
  const selected = await readLine(messages.choose);
  if (selected === "") throw new WorkbenchError("CLOSE_CANCELLED");
  const lot = open.find((item) => item.lot_id === selected);
  if (!lot) throw new WorkbenchError("CLOSE_LOT_SELECTION_INVALID");
  writeOut(messages.active(lot.lot_id));
  return lot.lot_id;
}

function terminalReader(io) {
  if (typeof io.readLine === "function") {
    return {
      async readLine(prompt) {
        try {
          return await io.readLine(prompt);
        } catch (error) {
          if (error?.code === "ABORT_ERR") throw new WorkbenchError("CLOSE_CANCELLED");
          throw error;
        }
      },
      close() {},
    };
  }
  const terminal = createInterface({ input: io.input, output: io.output, terminal: true });
  let interrupted = false;
  terminal.once("SIGINT", () => {
    interrupted = true;
    terminal.close();
  });
  return {
    async readLine(prompt) {
      try {
        const answer = await terminal.question(prompt);
        if (interrupted) throw new WorkbenchError("CLOSE_CANCELLED");
        return answer;
      } catch (error) {
        if (interrupted || error?.code === "ABORT_ERR") {
          throw new WorkbenchError("CLOSE_CANCELLED");
        }
        throw error;
      }
    },
    close() { terminal.close(); },
  };
}

function localDate(io) {
  if (typeof io.today === "string") return io.today;
  const now = new Date();
  return [
    String(now.getFullYear()).padStart(4, "0"),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
  ].join("-");
}

async function optionalPersonalJournal({ checkpoint, reader, io, messages }) {
  const optedIn = await reader.readLine(messages.memoryOptIn);
  if (optedIn !== "YES") {
    io.writeOut(messages.memorySkipped);
    return { status: "skipped" };
  }
  try {
    const {
      preparePersonalMemoryAppend,
      validatePersonalMemoryText,
    } = await import("./personal-memory.mjs");
    const note = validatePersonalMemoryText(await reader.readLine(messages.memoryNote));
    const prepared = await preparePersonalMemoryAppend({
      category: "journal",
      text: note,
      date: localDate(io),
      checkpointDigest: checkpoint.change_sha256,
    });
    io.writeOut(messages.memoryPreview);
    io.writeOut(`${prepared.preview.markdown}\n`);
    io.writeOut(`Change SHA-256: ${prepared.preview.change_sha256}\n`);
    if (await reader.readLine(messages.memoryApply) !== "APPLY MEMORY") {
      io.writeOut(messages.memorySkipped);
      return { status: "skipped" };
    }
    const receipt = await prepared.apply(prepared.preview.change_sha256);
    return { status: "applied", receipt };
  } catch (error) {
    const code = typeof error?.code === "string" && error.code.startsWith("MEMORY_")
      ? error.code
      : error instanceof WorkbenchError && error.code === "CLOSE_CANCELLED"
        ? "MEMORY_CANCELLED"
        : null;
    if (code === null) throw error;
    io.writeOut(messages.memoryFailed(code));
    return { status: "failed", code };
  }
}

async function runLiteClose({ start, inspection, producer, io, reader, messages }) {
  const summary = strictText(await reader.readLine(messages.liteSummary));
  if (summary === "") {
    const capsule = buildProjectResumeCapsule({ inspection, producer });
    io.writeOut(messages.capsuleOnly);
    return { format: CLOSE_RESULT_FORMAT, status: "capsule_only", checkpoint: null, capsule };
  }
  const references = parseOptionalReferences(await reader.readLine(messages.liteReferences));
  const nextAction = strictText(await reader.readLine(messages.liteNext));
  if (nextAction === "") throw new WorkbenchError("CLOSE_NEXT_ACTION_REQUIRED");
  const blocker = strictText(await reader.readLine(messages.liteBlocker));
  const current = inspection.evaluation.lite.current_state;
  const blockers = blocker === "" ? current.blockers : [...current.blockers, {
    blocker_id: `blocker-${sha256Bytes(Buffer.from(stableJson({
      snapshot_sha256: inspection.snapshot.snapshot_sha256,
      statement: blocker,
    }), "utf8")).slice(0, 24)}`,
    statement: blocker,
  }];
  if (blockers.length > 8) throw new WorkbenchError("CLOSE_BLOCKER_LIMIT_EXCEEDED");
  const proposal = {
    format: "dubsar.continuity-checkpoint-proposal/1",
    project_id: inspection.evaluation.id,
    kind: blocker === "" ? "progress" : "blocker",
    summary,
    references,
    validation: references.length === 0 ? [] : ["Referenced files were captured by the local DUBSAR runtime."],
    limitations: references.length === 0 ? ["Recorded as a human summary without an artifact reference."] : [],
    resolves: null,
    resulting_state: {
      status: current.status === "complete" ? "complete" : "active",
      summary,
      blockers,
      next_action: nextAction,
    },
  };
  io.writeOut(messages.preview);
  io.writeOut(`- ${proposal.kind}: ${proposal.summary}\n`);
  if (await reader.readLine(messages.continue) !== "CONTINUE") {
    throw new WorkbenchError("CLOSE_CANCELLED");
  }
  const preview = await previewCheckpointProposal({ start, proposal });
  if (await reader.readLine(messages.apply(preview.change_sha256)) !== "APPLY") {
    throw new WorkbenchError("CLOSE_CANCELLED");
  }
  const checkpoint = await applyCheckpointProposal({
    start, proposal, expectedChange: preview.change_sha256,
  });
  const postInspection = await inspectWorkspace({ start, domain: "project" });
  const capsule = buildProjectResumeCapsule({ inspection: postInspection, producer });
  io.writeOut(messages.applied);
  return {
    format: CLOSE_RESULT_FORMAT,
    status: "checkpoint_applied",
    checkpoint,
    capsule,
    memory: { status: "not_requested" },
  };
}

async function runMemoryClose({ start, inspection, producer, io, reader, messages }) {
  const selected = inspection.evaluation.memory.selected_work;
  if (selected === null) throw new WorkbenchError("MEMORY_WORK_SELECTION_REQUIRED");
  const summary = strictText(await reader.readLine(messages.liteSummary));
  if (summary === "") {
    const capsule = buildProjectResumeCapsule({ inspection, producer });
    io.writeOut(messages.capsuleOnly);
    return { format: CLOSE_RESULT_FORMAT, status: "capsule_only", checkpoint: null, capsule };
  }
  const referencePaths = parseOptionalReferences(await reader.readLine(messages.liteReferences));
  const references = [];
  for (const relative of referencePaths) {
    const captured = await captureRegularFile(
      inspection.location.project_root,
      relative,
      25 * 1024 * 1024,
    );
    references.push({ path: captured.path, sha256: captured.sha256 });
  }
  const nextAction = strictText(await reader.readLine(messages.liteNext));
  if (nextAction === "") throw new WorkbenchError("CLOSE_NEXT_ACTION_REQUIRED");
  const blocker = strictText(await reader.readLine(messages.liteBlocker));
  const current = inspection.evaluation.memory.current_state ?? {
    status: selected.status === "complete" ? "complete" : selected.status === "paused" ? "paused" : "active",
    summary: selected.objective,
    blockers: [],
    next_action: nextAction,
  };
  const blockers = blocker === "" ? current.blockers : [...current.blockers, {
    blocker_id: `blocker-${sha256Bytes(Buffer.from(stableJson({
      snapshot_sha256: inspection.snapshot.snapshot_sha256,
      work_id: selected.work_id,
      statement: blocker,
    }), "utf8")).slice(0, 24)}`,
    statement: blocker,
  }];
  if (blockers.length > 8) throw new WorkbenchError("CLOSE_BLOCKER_LIMIT_EXCEEDED");
  const document = inspection.snapshot.documents.checkpoints;
  const index = document.entries.length;
  const checkpointId = `cp-${sha256Bytes(Buffer.from(stableJson({
    snapshot_sha256: inspection.snapshot.snapshot_sha256,
    work_id: selected.work_id,
    summary,
    references,
  }), "utf8")).slice(0, 24)}`;
  const entryBase = {
    attempt: null,
    checkpoint_id: checkpointId,
    checkpoint_sha256: "0".repeat(64),
    index,
    kind: blocker === "" ? "progress" : "blocker",
    limitations: references.length === 0 ? ["Recorded as a human summary without an artifact reference."] : [],
    previous_checkpoint_sha256: document.entries.at(-1)?.checkpoint_sha256 ?? null,
    references,
    resolves: null,
    resulting_state: {
      status: selected.status === "complete" ? "complete" : "active",
      summary,
      blockers,
      next_action: nextAction,
    },
    summary,
    validation: references.length === 0 ? [] : ["Referenced files were captured by the local DUBSAR runtime."],
    work_id: selected.work_id,
  };
  entryBase.checkpoint_sha256 = memoryCheckpointDigest(entryBase);
  const proposal = {
    format: "dubsar.memory-change-proposal/1",
    project_id: inspection.evaluation.id,
    operation: "checkpoint_append",
    payload: { entry: entryBase },
  };
  io.writeOut(messages.preview);
  io.writeOut(`- ${entryBase.kind}: ${entryBase.summary}\n`);
  if (await reader.readLine(messages.continue) !== "CONTINUE") throw new WorkbenchError("CLOSE_CANCELLED");
  const preview = await previewMemoryChange({
    start,
    proposal,
    expectedOperation: "checkpoint_append",
  });
  if (await reader.readLine(messages.apply(preview.change_sha256)) !== "APPLY") {
    throw new WorkbenchError("CLOSE_CANCELLED");
  }
  const checkpoint = await applyMemoryChange({
    start,
    proposal,
    expectedChange: preview.change_sha256,
    expectedOperation: "checkpoint_append",
  });
  const postInspection = await inspectWorkspace({ start, domain: "project" });
  const capsule = buildProjectResumeCapsule({ inspection: postInspection, producer });
  io.writeOut(messages.applied);
  return {
    format: CLOSE_RESULT_FORMAT,
    status: "checkpoint_applied",
    checkpoint,
    capsule,
    memory: { status: "not_requested" },
  };
}

export async function runInteractiveClose({ start, lang = "en", producer, io }) {
  if (!io.isInputTTY || !io.isOutputTTY) {
    throw new WorkbenchError("CLOSE_INTERACTIVE_REQUIRED");
  }
  const messages = MESSAGES.get(lang);
  if (!messages) throw new WorkbenchError("CLOSE_LANGUAGE_INVALID");
  const reader = terminalReader(io);
  try {
    const inspection = await inspectWorkspace({ start, domain: "project", producer });
    if (inspection.evaluation.integrity.status !== "valid") {
      throw new WorkbenchError("CLOSE_WORKSPACE_INVALID");
    }
    if (inspection.snapshot.workspace_mode === "memory_vnext") {
      return await runMemoryClose({ start, inspection, producer, io, reader, messages });
    }
    if (inspection.snapshot.workspace_mode === "lite") {
      return await runLiteClose({ start, inspection, producer, io, reader, messages });
    }
    if (inspection.snapshot.documents["evidence.json"]?.format !== "dubsar.project-evidence/2") {
      throw new WorkbenchError("CLOSE_LEGACY_MIGRATION_REQUIRED");
    }
    const lotId = await chooseLot(inspection, reader.readLine, io.writeOut, messages);
    const decision = strictText(await reader.readLine(messages.decision));
    const fact = strictText(await reader.readLine(messages.fact));
    let factValidation = "";
    let factReferences = [];
    if (fact !== "") {
      factValidation = strictText(
        await reader.readLine(messages.validation),
        "CLOSE_FACT_VALIDATION_INVALID",
      );
      if (factValidation === "") throw new WorkbenchError("CLOSE_FACT_VALIDATION_REQUIRED");
      factReferences = parseReferences(await reader.readLine(messages.references));
    }
    const blocker = strictText(await reader.readLine(messages.blocker));
    const entries = [
      ...(decision === "" ? [] : [proposalEntry({
        snapshotSha256: inspection.snapshot.snapshot_sha256,
        lotId,
        kind: "decision",
        statement: decision,
      })]),
      ...(fact === "" ? [] : [proposalEntry({
        snapshotSha256: inspection.snapshot.snapshot_sha256,
        lotId,
        kind: "fact",
        statement: fact,
        artifactRefs: factReferences,
        validation: [factValidation],
      })]),
      ...(blocker === "" ? [] : [proposalEntry({
        snapshotSha256: inspection.snapshot.snapshot_sha256,
        lotId,
        kind: "blocker",
        statement: blocker,
      })]),
    ];
    if (entries.length === 0) {
      const capsule = buildProjectResumeCapsule({ inspection, producer });
      io.writeOut(messages.capsuleOnly);
      return {
        format: CLOSE_RESULT_FORMAT,
        status: "capsule_only",
        checkpoint: null,
        capsule,
      };
    }
    io.writeOut(messages.preview);
    for (const entry of entries) {
      io.writeOut(`- ${entry.kind}: ${entry.statement}\n`);
    }
    if (await reader.readLine(messages.continue) !== "CONTINUE") {
      throw new WorkbenchError("CLOSE_CANCELLED");
    }
    const proposal = {
      format: "dubsar.checkpoint-proposal/1",
      mission_id: inspection.evaluation.id,
      entries,
    };
    const preview = await previewCheckpointProposal({ start, proposal });
    if (await reader.readLine(messages.apply(preview.change_sha256)) !== "APPLY") {
      throw new WorkbenchError("CLOSE_CANCELLED");
    }
    const checkpoint = await applyCheckpointProposal({
      start,
      proposal,
      expectedChange: preview.change_sha256,
    });
    const postInspection = await inspectWorkspace({ start, domain: "project", producer });
    const capsule = buildProjectResumeCapsule({ inspection: postInspection, producer });
    io.writeOut(messages.applied);
    const memory = await optionalPersonalJournal({ checkpoint, reader, io, messages });
    return {
      format: CLOSE_RESULT_FORMAT,
      status: "checkpoint_applied",
      checkpoint,
      capsule,
      memory,
    };
  } finally {
    reader.close();
  }
}
