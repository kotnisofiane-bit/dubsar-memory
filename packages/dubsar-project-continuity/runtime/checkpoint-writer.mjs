import { randomBytes } from "node:crypto";
import { open, rename, unlink } from "node:fs/promises";
import path from "node:path";
import {
  PROJECT_EVIDENCE_V1_FORMAT,
  PROJECT_EVIDENCE_V2_FORMAT,
  WorkbenchError,
  evaluateProjectSnapshot,
  exactKeys,
  inspectWorkspace,
  normalizeProjectArtifactPath,
  sha256Bytes,
  stableJson,
} from "./index.mjs";
import { captureRegularFile } from "./safe-capture.mjs";
import { entryInfo, isInsideOrEqual } from "./path-safety.mjs";
import { artifactPolicyFinding } from "./sensitive-content.mjs";
import { safeDisplayText } from "./display-safety.mjs";
import {
  assertLiteProposal,
  createLiteCheckpoint,
  projectRootForLiteInspection,
} from "./lite.mjs";

export const CHECKPOINT_PROPOSAL_FORMAT = "dubsar.checkpoint-proposal/1";
export const CHECKPOINT_PREVIEW_FORMAT = "dubsar.checkpoint-preview/1";
export const CHECKPOINT_APPLY_FORMAT = "dubsar.checkpoint-apply/1";
export const CHECKPOINT_EVIDENCE_FORMAT = "dubsar.project-evidence/2";

const SHA256 = /^[0-9a-f]{64}$/u;
const SAFE_ID = /^[a-z0-9][a-z0-9._-]{2,127}$/iu;
const PROPOSAL_KEYS = ["entries", "format", "mission_id"];
const ENTRY_KEYS = [
  "artifact_refs", "class", "evidence_id", "kind", "limitations",
  "lot_id", "resolves", "statement", "validation",
];
const KINDS = new Set(["blocker", "blocker_resolution", "decision", "fact"]);
const CLASSES = new Set(["derived", "observed", "reported", "unverified"]);
const INSTRUCTION_PATTERN =
  /\b(?:ignore|disregard|override)\b.{0,40}\b(?:instruction|prompt|policy|rule)s?\b|<\|(?:system|assistant|user|im_end)\|>|```|(?:^|\n)\s*(?:system|assistant|developer)\s*:|\b(?:when|once)\b.{0,60}\b(?:resum(?:e|ed)|loaded|opened)\b.{0,60}\b(?:run|execute|deploy|publish|merge|delete|send)\b|\b(?:run|execute|deploy|publish|merge|delete|send)\b.{0,40}\bautomatically\b/iu;

function parseJson(content, errorCode) {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(content));
  } catch {
    throw new WorkbenchError(errorCode);
  }
}

function assertStringList(value, maxItems, maxChars) {
  return Array.isArray(value) && value.length <= maxItems && value.every(
    (item) => typeof item === "string" && item.length > 0 && item.length <= maxChars,
  );
}

function normalizedProposalText(value, maxChars) {
  const display = safeDisplayText(value, maxChars);
  if (
    display.text === "" || display.redacted || display.truncated ||
    INSTRUCTION_PATTERN.test(display.text)
  ) {
    throw new WorkbenchError("CHECKPOINT_PROPOSAL_INVALID");
  }
  return display.text;
}

function validateProposal(proposal, missionId) {
  if (
    !exactKeys(proposal, PROPOSAL_KEYS) ||
    proposal.format !== CHECKPOINT_PROPOSAL_FORMAT ||
    proposal.mission_id !== missionId ||
    !Array.isArray(proposal.entries) ||
    proposal.entries.length === 0 ||
    proposal.entries.length > 8
  ) {
    throw new WorkbenchError("CHECKPOINT_PROPOSAL_INVALID");
  }
  for (const entry of proposal.entries) {
    if (
      !exactKeys(entry, ENTRY_KEYS) ||
      typeof entry.evidence_id !== "string" || !SAFE_ID.test(entry.evidence_id) ||
      typeof entry.lot_id !== "string" || !SAFE_ID.test(entry.lot_id) ||
      !KINDS.has(entry.kind) || !CLASSES.has(entry.class) ||
      typeof entry.statement !== "string" || entry.statement.trim() === "" ||
      entry.statement.length > 500 ||
      !assertStringList(entry.artifact_refs, 8, 512) ||
      !assertStringList(entry.validation, 16, 500) ||
      !assertStringList(entry.limitations, 16, 500) ||
      !(
        entry.kind === "blocker_resolution"
          ? typeof entry.resolves === "string" && SAFE_ID.test(entry.resolves)
          : entry.resolves === null
      )
    ) {
      throw new WorkbenchError("CHECKPOINT_PROPOSAL_INVALID");
    }
  }
  return {
    ...proposal,
    entries: proposal.entries.map((entry) => ({
      ...entry,
      statement: normalizedProposalText(entry.statement, 500),
      validation: entry.validation.map((item) => normalizedProposalText(item, 500)),
      limitations: entry.limitations.map((item) => normalizedProposalText(item, 500)),
    })),
  };
}

async function loadProposal(proposalPath, proposal, missionId, projectRoot) {
  const fromPath = typeof proposalPath === "string" && proposalPath.length > 0;
  const fromValue = proposal !== undefined;
  if (fromPath === fromValue) throw new WorkbenchError("CHECKPOINT_PROPOSAL_REQUIRED");
  if (fromValue) return validateProposal(proposal, missionId);
  const absolute = path.resolve(proposalPath);
  if (isInsideOrEqual(projectRoot, absolute)) {
    throw new WorkbenchError("CHECKPOINT_PROPOSAL_LOCATION_INVALID");
  }
  const captured = await captureRegularFile(
    path.dirname(absolute),
    path.basename(absolute),
    64 * 1024,
  );
  return validateProposal(parseJson(captured.content, "CHECKPOINT_PROPOSAL_INVALID"), missionId);
}

async function captureReference(projectRoot, relativePath) {
  const normalized = normalizeProjectArtifactPath(relativePath);
  const captured = await captureRegularFile(projectRoot, normalized, 25 * 1024 * 1024);
  if (artifactPolicyFinding(captured.path, captured.content) !== null) {
    throw new WorkbenchError("CHECKPOINT_ARTIFACT_SENSITIVE");
  }
  return {
    reference: {
      path: captured.path,
      byte_length: captured.size,
      sha256: captured.sha256,
    },
    artifact: {
      path: captured.path,
      size: captured.size,
      sha256: captured.sha256,
      kind: "artifact",
      capture_status: "available",
      policy_finding: null,
    },
  };
}

async function migrateV1Entry(entry, projectRoot, artifacts) {
  const references = [];
  for (const item of Array.isArray(entry?.artifact_refs) ? entry.artifact_refs : []) {
    const normalized = normalizeProjectArtifactPath(item);
    try {
      const captured = await captureReference(projectRoot, normalized);
      references.push(captured.reference);
      artifacts.set(captured.artifact.path, captured.artifact);
    } catch (error) {
      if (
        !(error instanceof WorkbenchError) ||
        !new Set(["PATH_NOT_FOUND", "REQUIRED_FILE_MISSING"]).has(error.code)
      ) {
        throw error;
      }
      references.push({ path: normalized, byte_length: null, sha256: null });
    }
  }
  return {
    evidence_id: entry.evidence_id,
    lot_id: entry.lot_id,
    kind: "legacy",
    statement: normalizedProposalText(entry.claim, 500),
    class: entry.class,
    artifact_refs: references,
    validation: Array.isArray(entry.validation)
      ? entry.validation.map((item) => normalizedProposalText(item, 500))
      : [],
    limitations: Array.isArray(entry.limitations)
      ? entry.limitations.map((item) => normalizedProposalText(item, 500))
      : [],
    resolves: null,
  };
}

function changeDigest(value) {
  return sha256Bytes(Buffer.from(stableJson(value), "utf8"));
}

async function loadLiteProposal({ proposalPath, proposal, inspection }) {
  const fromPath = typeof proposalPath === "string" && proposalPath.length > 0;
  const fromValue = proposal !== undefined;
  if (fromPath === fromValue) throw new WorkbenchError("CHECKPOINT_PROPOSAL_REQUIRED");
  if (fromValue) return assertLiteProposal(proposal, inspection.evaluation.id);
  const projectRoot = projectRootForLiteInspection(inspection);
  const absolute = path.resolve(proposalPath);
  if (isInsideOrEqual(projectRoot, absolute)) {
    throw new WorkbenchError("CHECKPOINT_PROPOSAL_LOCATION_INVALID");
  }
  const captured = await captureRegularFile(path.dirname(absolute), path.basename(absolute), 64 * 1024);
  return assertLiteProposal(
    parseJson(captured.content, "LITE_PROPOSAL_INVALID"),
    inspection.evaluation.id,
  );
}

async function buildLiteCheckpointChange({ inspection, proposalPath, proposal }) {
  const normalized = await loadLiteProposal({ proposalPath, proposal, inspection });
  const projectRoot = projectRootForLiteInspection(inspection);
  const references = [];
  for (const referencePath of normalized.references) {
    const captured = await captureReference(projectRoot, referencePath);
    references.push({ path: captured.reference.path, sha256: captured.reference.sha256 });
  }
  const created = createLiteCheckpoint({ inspection, proposal: normalized, references });
  const beforeFile = inspection.snapshot.files.find((item) => item.path === "checkpoints.json");
  const base = {
    operation: "append_lite_checkpoint",
    target: "checkpoints.json",
    before_sha256: beforeFile.sha256,
    after_sha256: sha256Bytes(created.afterBytes),
    snapshot_sha256: inspection.snapshot.snapshot_sha256,
  };
  return {
    inspection,
    target: path.join(inspection.location.root, "checkpoints.json"),
    afterBytes: created.afterBytes,
    preview: {
      format: CHECKPOINT_PREVIEW_FORMAT,
      status: "preview",
      ...base,
      change_sha256: changeDigest(base),
      summary: `One Lite checkpoint will be appended at recorded index ${created.entry.index}.`,
      consequence: "Only checkpoints.json will change; state.json remains unchanged.",
      records: [{
        evidence_id: created.entry.checkpoint_id,
        lot_id: "unavailable",
        kind: created.entry.kind,
        class: created.entry.references.length > 0 ? "observed" : "reported",
        statement: created.entry.summary,
      }],
      lot_transition_available: false,
    },
  };
}

async function buildCheckpointChange({ start, proposalPath, proposal }) {
  const inspection = await inspectWorkspace({ start, domain: "project" });
  if (inspection.snapshot.workspace_mode === "lite") {
    return buildLiteCheckpointChange({ inspection, proposalPath, proposal });
  }
  if (inspection.evaluation.integrity.status !== "valid") {
    throw new WorkbenchError("CHECKPOINT_WORKSPACE_INVALID");
  }
  const mission = inspection.snapshot.documents["mission.json"];
  const current = inspection.snapshot.documents["evidence.json"];
  const projectRoot = path.dirname(inspection.location.root);
  const normalizedProposal = await loadProposal(
    proposalPath,
    proposal,
    mission.mission_id,
    projectRoot,
  );
  const artifacts = new Map((inspection.snapshot.artifacts ?? []).map((item) => [item.path, item]));
  const existing = [];
  if (current.format === PROJECT_EVIDENCE_V1_FORMAT) {
    for (const entry of current.entries) {
      existing.push(await migrateV1Entry(entry, projectRoot, artifacts));
    }
  } else if (current.format === PROJECT_EVIDENCE_V2_FORMAT) {
    existing.push(...current.entries);
  } else {
    throw new WorkbenchError("CHECKPOINT_EVIDENCE_FORMAT_UNSUPPORTED");
  }

  const nextEntries = [];
  for (const entry of normalizedProposal.entries) {
    const references = [];
    for (const referencePath of entry.artifact_refs) {
      const captured = await captureReference(projectRoot, referencePath);
      references.push(captured.reference);
      artifacts.set(captured.artifact.path, captured.artifact);
    }
    nextEntries.push({ ...entry, artifact_refs: references });
  }
  const evidenceIds = [...existing, ...nextEntries].map((entry) => entry.evidence_id);
  if (new Set(evidenceIds).size !== evidenceIds.length) {
    throw new WorkbenchError("CHECKPOINT_EVIDENCE_ID_DUPLICATE");
  }
  const after = {
    format: CHECKPOINT_EVIDENCE_FORMAT,
    mission_id: mission.mission_id,
    entries: [...existing, ...nextEntries],
  };
  const candidateSnapshot = {
    ...inspection.snapshot,
    documents: { ...inspection.snapshot.documents, "evidence.json": after },
    artifacts: [...artifacts.values()],
  };
  const candidateEvaluation = evaluateProjectSnapshot(candidateSnapshot);
  if (candidateEvaluation.integrity.status !== "valid") {
    throw new WorkbenchError("CHECKPOINT_WOULD_INVALIDATE_PROJECT");
  }
  const beforeFile = inspection.snapshot.files.find((item) => item.path === "evidence.json");
  const afterBytes = Buffer.from(stableJson(after), "utf8");
  const base = {
    operation: current.format === PROJECT_EVIDENCE_V1_FORMAT
      ? "migrate_legacy_evidence_and_append"
      : "append_evidence",
    target: "evidence.json",
    before_sha256: beforeFile.sha256,
    after_sha256: sha256Bytes(afterBytes),
    snapshot_sha256: inspection.snapshot.snapshot_sha256,
  };
  return {
    inspection,
    target: path.join(inspection.location.root, "evidence.json"),
    after,
    afterBytes,
    preview: {
      format: CHECKPOINT_PREVIEW_FORMAT,
      status: "preview",
      ...base,
      change_sha256: changeDigest(base),
      summary: current.format === PROJECT_EVIDENCE_V1_FORMAT
        ? `Legacy evidence/1 will be migrated to evidence/2 and ${nextEntries.length} checkpoint record(s) will be appended.`
        : `${nextEntries.length} checkpoint record(s) will be appended to evidence.json.`,
      consequence: "No lot status changes in this operation.",
      records: nextEntries.map((entry) => ({
        evidence_id: entry.evidence_id,
        lot_id: entry.lot_id,
        kind: entry.kind,
        class: entry.class,
        statement: entry.statement,
      })),
      lot_transition_available: candidateEvaluation.continuity.records.some(
        (item) => item.supported,
      ),
    },
  };
}

function transitionDocument(inspection, lotId, to) {
  if (typeof lotId !== "string" || !SAFE_ID.test(lotId) || !new Set(["candidate", "complete"]).has(to)) {
    throw new WorkbenchError("LOT_TRANSITION_INVALID");
  }
  const document = inspection.snapshot.documents["lots.json"];
  const target = document.lots.find((lot) => lot.lot_id === lotId);
  if (!target) throw new WorkbenchError("LOT_TRANSITION_INVALID");
  const hasOpenBlocker = (inspection.evaluation.continuity?.open_blockers ?? [])
    .some((blocker) => blocker.lot_id === lotId);
  if (to === "candidate") {
    if (
      target.status !== "planned" ||
      document.lots.some((lot) => lot.status === "candidate") ||
      hasOpenBlocker ||
      inspection.snapshot.documents["evidence.json"].format !== PROJECT_EVIDENCE_V2_FORMAT ||
      target.depends_on.some(
        (dependency) => document.lots.find((lot) => lot.lot_id === dependency)?.status !== "complete",
      )
    ) throw new WorkbenchError("LOT_TRANSITION_NOT_ALLOWED");
  } else {
    if (target.status !== "candidate" || hasOpenBlocker) {
      throw new WorkbenchError("LOT_TRANSITION_NOT_ALLOWED");
    }
    if (inspection.snapshot.documents["evidence.json"].format !== PROJECT_EVIDENCE_V2_FORMAT) {
      throw new WorkbenchError("LOT_TRANSITION_FRESH_EVIDENCE_REQUIRED");
    }
    const supported = new Set(
      inspection.evaluation.continuity.records.filter((item) => item.supported).map((item) => item.evidence_id),
    );
    if (target.expected_evidence.length === 0 || target.expected_evidence.some((id) => !supported.has(id))) {
      throw new WorkbenchError("LOT_TRANSITION_FRESH_EVIDENCE_REQUIRED");
    }
  }
  return {
    ...document,
    lots: document.lots.map((lot) => lot.lot_id === lotId ? { ...lot, status: to } : lot),
  };
}

async function buildLotTransitionChange({ start, lotId, to }) {
  const inspection = await inspectWorkspace({ start, domain: "project" });
  if (inspection.snapshot.workspace_mode === "lite") {
    throw new WorkbenchError("LOT_TRANSITION_NOT_APPLICABLE");
  }
  if (inspection.evaluation.integrity.status !== "valid") {
    throw new WorkbenchError("CHECKPOINT_WORKSPACE_INVALID");
  }
  const after = transitionDocument(inspection, lotId, to);
  const candidate = evaluateProjectSnapshot({
    ...inspection.snapshot,
    documents: { ...inspection.snapshot.documents, "lots.json": after },
  });
  if (candidate.integrity.status !== "valid") {
    throw new WorkbenchError("LOT_TRANSITION_WOULD_INVALIDATE_PROJECT");
  }
  const beforeFile = inspection.snapshot.files.find((item) => item.path === "lots.json");
  const afterBytes = Buffer.from(stableJson(after), "utf8");
  const base = {
    operation: "transition_lot",
    target: "lots.json",
    lot_id: lotId,
    to,
    before_sha256: beforeFile.sha256,
    after_sha256: sha256Bytes(afterBytes),
    snapshot_sha256: inspection.snapshot.snapshot_sha256,
  };
  return {
    inspection,
    target: path.join(inspection.location.root, "lots.json"),
    afterBytes,
    preview: {
      format: CHECKPOINT_PREVIEW_FORMAT,
      status: "preview",
      ...base,
      change_sha256: changeDigest(base),
      summary: `Lot ${lotId} will transition to ${to}.`,
      consequence: "Only lots.json will change.",
      lot_transition_available: false,
    },
  };
}

async function publishOneFile(change, expectedChange) {
  if (!SHA256.test(expectedChange ?? "") || expectedChange !== change.preview.change_sha256) {
    throw new WorkbenchError("CHECKPOINT_CONFIRMATION_MISMATCH");
  }
  const root = change.inspection.location.root;
  const targetName = new Set(["checkpoints.json", "evidence.json", "lots.json"]).has(change.preview.target)
    ? change.preview.target
    : null;
  if (targetName === null) {
    throw new WorkbenchError("CHECKPOINT_TARGET_UNSAFE");
  }
  const target = path.join(root, targetName);
  if (target !== change.target) {
    throw new WorkbenchError("CHECKPOINT_TARGET_UNSAFE");
  }
  const lockPath = path.join(root, ".dubsar-checkpoint.lock");
  const temporaryName = `.dubsar-checkpoint-${randomBytes(12).toString("hex")}.tmp`;
  const temporary = path.join(root, temporaryName);
  let handle;
  let lockHandle;
  let ownsLock = false;
  let published = false;
  try {
    try {
      lockHandle = await open(lockPath, "wx", 0o600);
      ownsLock = true;
    } catch {
      throw new WorkbenchError("CHECKPOINT_LOCKED");
    }
    const reinspection = await inspectWorkspace({
      start: path.dirname(root),
      domain: "project",
    });
    if (reinspection.snapshot.snapshot_sha256 !== change.preview.snapshot_sha256) {
      throw new WorkbenchError("CHECKPOINT_CONCURRENT_CHANGE");
    }
    const current = await captureRegularFile(root, targetName, 1024 * 1024);
    if (current.sha256 !== change.preview.before_sha256) {
      throw new WorkbenchError("CHECKPOINT_CONCURRENT_CHANGE");
    }
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(change.afterBytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    const staged = await captureRegularFile(root, temporaryName, 1024 * 1024);
    if (staged.sha256 !== change.preview.after_sha256) {
      throw new WorkbenchError("CHECKPOINT_STAGING_MISMATCH");
    }
    const targetInfo = await entryInfo(target);
    if (!targetInfo?.isFile() || targetInfo.isSymbolicLink() || targetInfo.nlink > 1n) {
      throw new WorkbenchError("CHECKPOINT_TARGET_UNSAFE");
    }
    const revalidated = await captureRegularFile(root, targetName, 1024 * 1024);
    if (revalidated.sha256 !== change.preview.before_sha256) {
      throw new WorkbenchError("CHECKPOINT_CONCURRENT_CHANGE");
    }
    await rename(temporary, target);
    published = true;
    const final = await captureRegularFile(root, targetName, 1024 * 1024);
    if (final.sha256 !== change.preview.after_sha256) {
      throw new WorkbenchError("CHECKPOINT_PUBLICATION_MISMATCH");
    }
  } finally {
    await handle?.close();
    if (!published) await unlink(temporary).catch(() => {});
    await lockHandle?.close();
    if (ownsLock) await unlink(lockPath).catch(() => {});
  }
  return {
    format: CHECKPOINT_APPLY_FORMAT,
    status: "applied",
    operation: change.preview.operation,
    target: change.preview.target,
    change_sha256: change.preview.change_sha256,
    before_sha256: change.preview.before_sha256,
    after_sha256: change.preview.after_sha256,
  };
}

export async function previewCheckpoint(options) {
  return (await buildCheckpointChange(options)).preview;
}

export async function applyCheckpoint({ expectedChange, ...options }) {
  return publishOneFile(await buildCheckpointChange(options), expectedChange);
}

export async function previewCheckpointProposal({ start, proposal }) {
  return (await buildCheckpointChange({ start, proposal })).preview;
}

export async function applyCheckpointProposal({ start, proposal, expectedChange }) {
  return publishOneFile(
    await buildCheckpointChange({ start, proposal }),
    expectedChange,
  );
}

export async function previewLotTransition(options) {
  return (await buildLotTransitionChange(options)).preview;
}

export async function applyLotTransition({ expectedChange, ...options }) {
  return publishOneFile(await buildLotTransitionChange(options), expectedChange);
}
