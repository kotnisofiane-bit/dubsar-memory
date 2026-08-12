import { randomBytes } from "node:crypto";
import { mkdir, open, rename, rmdir, unlink } from "node:fs/promises";
import path from "node:path";
import {
  WorkbenchError,
  inspectWorkspace,
  sha256Bytes,
  stableJson,
} from "./index.mjs";
import {
  LITE_CHECKPOINTS_FORMAT,
  LITE_STATE_FORMAT,
  assertLiteInitializationProposal,
} from "./lite.mjs";
import { captureRegularFile } from "./safe-capture.mjs";
import { entryInfo, isInsideOrEqual, openDirectory } from "./path-safety.mjs";

export const LITE_INIT_PREVIEW_FORMAT = "dubsar.continuity-init-preview/1";
export const LITE_INIT_APPLY_FORMAT = "dubsar.continuity-init-apply/1";

const SHA256 = /^[0-9a-f]{64}$/u;

function parseProposal(content) {
  try {
    return assertLiteInitializationProposal(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(content)),
    );
  } catch (error) {
    if (error instanceof WorkbenchError) throw error;
    throw new WorkbenchError("LITE_INIT_PROPOSAL_INVALID");
  }
}

async function loadProposal(projectRoot, proposalPath) {
  if (typeof proposalPath !== "string" || proposalPath.length === 0) {
    throw new WorkbenchError("LITE_INIT_PROPOSAL_REQUIRED");
  }
  const absolute = path.resolve(proposalPath);
  if (isInsideOrEqual(projectRoot, absolute)) {
    throw new WorkbenchError("LITE_INIT_PROPOSAL_LOCATION_INVALID");
  }
  const captured = await captureRegularFile(path.dirname(absolute), path.basename(absolute), 64 * 1024);
  return parseProposal(captured.content);
}

function initializationDocuments(proposal) {
  const state = {
    format: LITE_STATE_FORMAT,
    project_id: proposal.project_id,
    title: proposal.title,
    mission: proposal.mission,
    initial_state: proposal.initial_state,
  };
  const checkpoints = {
    format: LITE_CHECKPOINTS_FORMAT,
    project_id: proposal.project_id,
    entries: [],
  };
  return {
    stateBytes: Buffer.from(stableJson(state), "utf8"),
    checkpointsBytes: Buffer.from(stableJson(checkpoints), "utf8"),
  };
}

async function buildInitialization({ start, proposalPath }) {
  const projectRoot = await openDirectory(start ?? process.cwd());
  const marker = path.join(projectRoot, ".dubsar-project");
  if (await entryInfo(marker)) throw new WorkbenchError("WORKSPACE_ALREADY_EXISTS");
  const proposal = await loadProposal(projectRoot, proposalPath);
  const documents = initializationDocuments(proposal);
  const base = {
    operation: "initialize_lite_continuity",
    target: ".dubsar-project",
    project_id: proposal.project_id,
    state_sha256: sha256Bytes(documents.stateBytes),
    checkpoints_sha256: sha256Bytes(documents.checkpointsBytes),
  };
  return {
    projectRoot,
    marker,
    ...documents,
    preview: {
      format: LITE_INIT_PREVIEW_FORMAT,
      status: "preview",
      ...base,
      change_sha256: sha256Bytes(Buffer.from(stableJson(base), "utf8")),
      summary: "A new two-file DUBSAR Continuity Lite workspace will be created.",
      consequence: "No source, Git, personal-memory, or legacy continuity file will be modified.",
    },
  };
}

export async function previewLiteInitialization(options) {
  return (await buildInitialization(options)).preview;
}

export async function applyLiteInitialization({ expectedChange, ...options }) {
  const change = await buildInitialization(options);
  if (!SHA256.test(expectedChange ?? "") || expectedChange !== change.preview.change_sha256) {
    throw new WorkbenchError("LITE_INIT_CONFIRMATION_MISMATCH");
  }
  const lockPath = path.join(change.projectRoot, ".dubsar-init.lock");
  const staging = path.join(change.projectRoot, `.dubsar-project-init-${randomBytes(12).toString("hex")}`);
  const stagingState = path.join(staging, "state.json");
  const stagingCheckpoints = path.join(staging, "checkpoints.json");
  let lockHandle;
  let stateHandle;
  let checkpointsHandle;
  let ownsLock = false;
  let published = false;
  try {
    try {
      lockHandle = await open(lockPath, "wx", 0o600);
      ownsLock = true;
    } catch {
      throw new WorkbenchError("LITE_INIT_LOCKED");
    }
    if (await entryInfo(change.marker)) throw new WorkbenchError("WORKSPACE_ALREADY_EXISTS");
    await mkdir(staging, { recursive: false, mode: 0o700 });
    stateHandle = await open(stagingState, "wx", 0o600);
    await stateHandle.writeFile(change.stateBytes);
    await stateHandle.sync();
    await stateHandle.close();
    stateHandle = undefined;
    checkpointsHandle = await open(stagingCheckpoints, "wx", 0o600);
    await checkpointsHandle.writeFile(change.checkpointsBytes);
    await checkpointsHandle.sync();
    await checkpointsHandle.close();
    checkpointsHandle = undefined;
    const stagedState = await captureRegularFile(staging, "state.json", 1024 * 1024);
    const stagedCheckpoints = await captureRegularFile(staging, "checkpoints.json", 1024 * 1024);
    if (
      stagedState.sha256 !== change.preview.state_sha256 ||
      stagedCheckpoints.sha256 !== change.preview.checkpoints_sha256 ||
      await entryInfo(change.marker)
    ) throw new WorkbenchError("LITE_INIT_STAGING_MISMATCH");
    await rename(staging, change.marker);
    published = true;
    const inspection = await inspectWorkspace({ start: change.projectRoot, domain: "project" });
    if (inspection.snapshot.workspace_mode !== "lite" || inspection.evaluation.id !== change.preview.project_id) {
      throw new WorkbenchError("LITE_INIT_PUBLICATION_MISMATCH");
    }
    return {
      format: LITE_INIT_APPLY_FORMAT,
      status: "applied",
      operation: change.preview.operation,
      target: change.preview.target,
      change_sha256: change.preview.change_sha256,
      snapshot_sha256: inspection.snapshot.snapshot_sha256,
    };
  } finally {
    await stateHandle?.close();
    await checkpointsHandle?.close();
    if (!published) {
      await unlink(stagingState).catch(() => {});
      await unlink(stagingCheckpoints).catch(() => {});
      await rmdir(staging).catch(() => {});
    }
    await lockHandle?.close();
    if (ownsLock) await unlink(lockPath).catch(() => {});
  }
}
