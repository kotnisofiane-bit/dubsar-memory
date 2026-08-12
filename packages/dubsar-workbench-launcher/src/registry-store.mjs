import { randomBytes, randomUUID } from "node:crypto";
import { open, rename, unlink } from "node:fs/promises";
import path from "node:path";
import {
  createProjectRegistry,
  loadProjectRegistry,
  stableJson,
} from "../../dubsar-operator-core/src/index.mjs";
import { locateProjectWorkspace } from "../../dubsar-project-continuity/runtime/index.mjs";
import { captureRegularFile } from "../../dubsar-operator-core/src/safe-capture.mjs";
import { entryInfo, openDirectory } from "../../dubsar-operator-core/src/path-safety.mjs";
import { WorkbenchLauncherError } from "./launcher-error.mjs";

export const PROJECT_REGISTRY_NAME = "projects.json";

function registryPath(outputRoot) {
  return path.join(outputRoot, PROJECT_REGISTRY_NAME);
}

export async function loadLocalProjectRegistry(outputRoot) {
  const safeRoot = await openDirectory(outputRoot);
  const target = registryPath(safeRoot);
  if (await entryInfo(target) === null) {
    return createProjectRegistry();
  }
  try {
    return await loadProjectRegistry(target);
  } catch {
    throw new WorkbenchLauncherError("PROJECT_REGISTRY_INVALID");
  }
}

export async function publishLocalProjectRegistry(outputRoot, registry) {
  const safeRoot = await openDirectory(outputRoot);
  const normalized = createProjectRegistry(registry.projects);
  const content = Buffer.from(stableJson(normalized), "utf8");
  const target = registryPath(safeRoot);
  const temporaryName = `.dubsar-projects-${randomBytes(12).toString("hex")}.tmp`;
  const temporary = path.join(safeRoot, temporaryName);
  let handle;
  let published = false;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(content);
    await handle.sync();
    await handle.close();
    handle = undefined;
    const staged = await captureRegularFile(safeRoot, temporaryName, 64 * 1024);
    if (!staged.content.equals(content)) {
      throw new WorkbenchLauncherError("PROJECT_REGISTRY_STAGING_MISMATCH");
    }
    const current = await entryInfo(target);
    if (current !== null && (!current.isFile() || current.isSymbolicLink() || current.nlink > 1n)) {
      throw new WorkbenchLauncherError("PROJECT_REGISTRY_TARGET_UNSAFE");
    }
    await rename(temporary, target);
    published = true;
    const captured = await loadProjectRegistry(target);
    if (stableJson(captured) !== stableJson(normalized)) {
      throw new WorkbenchLauncherError("PROJECT_REGISTRY_PUBLICATION_MISMATCH");
    }
    return captured;
  } catch (error) {
    if (error instanceof WorkbenchLauncherError) throw error;
    throw new WorkbenchLauncherError("PROJECT_REGISTRY_WRITE_FAILED");
  } finally {
    await handle?.close();
    if (!published) await unlink(temporary).catch(() => {});
  }
}

export async function addLocalProject(outputRoot, selectedRoot) {
  let location;
  try {
    const safeSelected = await openDirectory(selectedRoot);
    location = await locateProjectWorkspace({ start: safeSelected });
  } catch {
    throw new WorkbenchLauncherError("PROJECT_SELECTION_INVALID");
  }
  const projectRoot = await openDirectory(location.project_root);
  const registry = await loadLocalProjectRegistry(outputRoot);
  const next = createProjectRegistry([
    ...registry.projects,
    { project_id: `project-${randomUUID()}`, root: projectRoot },
  ]);
  return publishLocalProjectRegistry(outputRoot, next);
}

export async function removeLocalProject(outputRoot, projectId) {
  if (typeof projectId !== "string" || projectId.length === 0) {
    throw new WorkbenchLauncherError("PROJECT_ID_INVALID");
  }
  const registry = await loadLocalProjectRegistry(outputRoot);
  const projects = registry.projects.filter((item) => item.project_id !== projectId);
  if (projects.length === registry.projects.length) {
    throw new WorkbenchLauncherError("PROJECT_ID_NOT_FOUND");
  }
  return publishLocalProjectRegistry(outputRoot, createProjectRegistry(projects));
}
