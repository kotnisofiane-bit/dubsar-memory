import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initProjectWorkspace } from "./init-project-workspace.mjs";
import { runProjectValidation } from "./validate-project-workspace.mjs";
import {
  canonicalCandidate,
  isInsideOrEqual,
  openWorkspace,
  parseArgs,
  printFailure,
  printResult,
  PublicPluginError,
  readJson,
  safeChild,
} from "./safe-io.mjs";

const MARKER = ".dubsar-project";
const REQUIRED_FILES = [
  "mission.json",
  "lots.json",
  "execution-contract.json",
  "evidence.json",
];
const MISSION_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{2,63}$/iu;

function samePath(left, right) {
  return isInsideOrEqual(left, right) && isInsideOrEqual(right, left);
}

async function entryInfo(target) {
  try {
    return await lstat(target);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw new PublicPluginError("PATH_INSPECTION_FAILED");
  }
}

async function findProjectContext(startInput) {
  const start = await openWorkspace(startInput ?? process.cwd());
  let current = start;

  while (true) {
    const gitMarker = path.join(current, ".git");
    const info = await entryInfo(gitMarker);
    if (info) {
      if (
        info.isSymbolicLink() ||
        (!info.isDirectory() && !info.isFile())
      ) {
        throw new PublicPluginError("PROJECT_MARKER_UNSAFE");
      }
      return { projectRoot: current, start };
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return { projectRoot: start, start };
    }
    current = parent;
  }
}

async function findNearestMarker(projectRoot, start) {
  let current = start;

  while (isInsideOrEqual(projectRoot, current)) {
    const candidate = safeChild(current, MARKER);
    const info = await entryInfo(candidate);
    if (info) {
      if (info.isSymbolicLink()) {
        throw new PublicPluginError("SYMLINK_ANCESTOR_REJECTED");
      }
      if (!info.isDirectory()) {
        throw new PublicPluginError("WORKSPACE_NOT_DIRECTORY");
      }
      const workspaceRoot = await openWorkspace(candidate);
      if (!isInsideOrEqual(projectRoot, workspaceRoot)) {
        throw new PublicPluginError("WORKSPACE_OUTSIDE_PROJECT");
      }
      return workspaceRoot;
    }
    if (samePath(current, projectRoot)) {
      break;
    }
    current = path.dirname(current);
  }
  return null;
}

async function resolveExplicitWorkspace(projectRoot, start, workspace) {
  const unresolved = path.isAbsolute(workspace)
    ? workspace
    : safeChild(start, workspace);
  const candidate = await canonicalCandidate(unresolved);
  if (!isInsideOrEqual(projectRoot, candidate)) {
    throw new PublicPluginError("WORKSPACE_OUTSIDE_PROJECT");
  }
  if (path.basename(candidate) !== MARKER) {
    throw new PublicPluginError("INVALID_WORKSPACE_MARKER");
  }
  return candidate;
}

function relativeWorkspace(projectRoot, start, workspaceRoot) {
  if (
    !isInsideOrEqual(projectRoot, start) ||
    !isInsideOrEqual(projectRoot, workspaceRoot)
  ) {
    throw new PublicPluginError("WORKSPACE_OUTSIDE_PROJECT");
  }
  const relative = path
    .relative(start, workspaceRoot)
    .replaceAll("\\", "/");
  return relative || ".";
}

async function readMissionId(workspaceRoot) {
  let missionId = null;
  for (const file of REQUIRED_FILES) {
    const document = await readJson(workspaceRoot, file);
    if (
      typeof document?.mission_id !== "string" ||
      !MISSION_ID_PATTERN.test(document.mission_id)
    ) {
      throw new PublicPluginError("INVALID_MISSION_ID");
    }
    if (missionId !== null && document.mission_id !== missionId) {
      throw new PublicPluginError("MISSION_ID_MISMATCH");
    }
    missionId = document.mission_id;
  }
  return missionId;
}

async function assertValidWorkspace(workspaceRoot) {
  const validation = await runProjectValidation(workspaceRoot);
  if (validation.status !== "valid") {
    throw new PublicPluginError("WORKSPACE_INVALID");
  }
}

async function inspectWorkspace(candidate) {
  const info = await entryInfo(candidate);
  if (!info) {
    return { exists: false, root: candidate };
  }
  const root = await openWorkspace(candidate);
  if ((await readdir(root)).length === 0) {
    throw new PublicPluginError("WORKSPACE_INCOMPLETE");
  }
  return { exists: true, root };
}

export async function locateProjectWorkspace({ start, workspace } = {}) {
  const context = await findProjectContext(start);
  let candidate;

  if (workspace !== undefined) {
    candidate = await resolveExplicitWorkspace(
      context.projectRoot,
      context.start,
      workspace,
    );
  } else {
    candidate = await findNearestMarker(context.projectRoot, context.start);
    if (candidate === null) {
      return {
        status: "continuity_absent",
        mission_id: null,
        workspace: null,
      };
    }
  }

  const existing = await inspectWorkspace(candidate);
  if (!existing.exists) {
    return {
      status: "continuity_absent",
      mission_id: null,
      workspace: null,
    };
  }

  const missionId = await readMissionId(existing.root);
  await assertValidWorkspace(existing.root);
  return {
    status: "located",
    mission_id: missionId,
    workspace: relativeWorkspace(
      context.projectRoot,
      context.start,
      existing.root,
    ),
  };
}

export async function ensureProjectWorkspace({
  start,
  workspace,
  missionId,
} = {}) {
  const context = await findProjectContext(start);
  let candidate;

  if (workspace !== undefined) {
    candidate = await resolveExplicitWorkspace(
      context.projectRoot,
      context.start,
      workspace,
    );
  } else {
    candidate =
      (await findNearestMarker(context.projectRoot, context.start)) ??
      (await canonicalCandidate(safeChild(context.projectRoot, MARKER)));
  }

  const existing = await inspectWorkspace(candidate);
  if (existing.exists) {
    const existingMissionId = await readMissionId(existing.root);
    await assertValidWorkspace(existing.root);
    if (missionId !== undefined && missionId !== existingMissionId) {
      throw new PublicPluginError("MISSION_ID_CONFLICT");
    }
    return {
      status: "reused",
      mission_id: existingMissionId,
      workspace: relativeWorkspace(
        context.projectRoot,
        context.start,
        existing.root,
      ),
    };
  }

  const initialized = await initProjectWorkspace(existing.root, missionId);
  const workspaceRoot = await openWorkspace(existing.root);
  const storedMissionId = await readMissionId(workspaceRoot);
  await assertValidWorkspace(workspaceRoot);
  if (storedMissionId !== initialized.mission_id) {
    throw new PublicPluginError("MISSION_ID_MISMATCH");
  }
  return {
    status: "initialized",
    mission_id: storedMissionId,
    workspace: relativeWorkspace(
      context.projectRoot,
      context.start,
      workspaceRoot,
    ),
  };
}

async function main() {
  try {
    const args = parseArgs(process.argv.slice(2), [], [
      "start",
      "workspace",
      "mission-id",
    ]);
    printResult(
      await ensureProjectWorkspace({
        start: args.start,
        workspace: args.workspace,
        missionId: args["mission-id"],
      }),
    );
  } catch (error) {
    printFailure(error);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
