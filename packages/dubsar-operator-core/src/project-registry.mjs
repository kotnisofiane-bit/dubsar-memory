import path from "node:path";
import {
  WORKBENCH_AUTHORITY,
  WorkbenchError,
  deepFreeze,
  exactKeys,
} from "./contracts.mjs";
import { captureRegularFile } from "./safe-capture.mjs";
import { openDirectory } from "./path-safety.mjs";
import { isProjectId } from "./project-identifiers.mjs";

export const PROJECT_REGISTRY_FORMAT = "dubsar.workbench-projects/1";
export const MAX_PROJECTS = 16;
export const MAX_REGISTRY_BYTES = 64 * 1024;

export { isProjectId } from "./project-identifiers.mjs";

function comparable(input) {
  const resolved = path.resolve(input);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function supportedRoot(input) {
  if (
    typeof input !== "string" ||
    input.length === 0 ||
    input.length > 1024 ||
    input.includes("\0") ||
    !path.isAbsolute(input)
  ) {
    throw new WorkbenchError("PROJECT_REGISTRY_ROOT_INVALID");
  }
  const resolved = path.resolve(input);
  if (
    resolved.startsWith("\\\\") ||
    resolved.startsWith("//") ||
    resolved.startsWith("\\\\?\\") ||
    resolved.startsWith("\\\\.\\")
  ) {
    throw new WorkbenchError("PROJECT_REGISTRY_ROOT_UNSUPPORTED");
  }
  return resolved;
}

function validateEntries(projects) {
  if (!Array.isArray(projects) || projects.length > MAX_PROJECTS) {
    throw new WorkbenchError("PROJECT_REGISTRY_INVALID");
  }
  const ids = new Set();
  const roots = new Set();
  const result = projects.map((entry) => {
    if (
      !exactKeys(entry, ["project_id", "root"]) ||
      !isProjectId(entry.project_id)
    ) {
      throw new WorkbenchError("PROJECT_REGISTRY_INVALID");
    }
    const projectId = entry.project_id.toLowerCase();
    const root = supportedRoot(entry.root);
    const rootKey = comparable(root);
    if (ids.has(projectId) || roots.has(rootKey)) {
      throw new WorkbenchError("PROJECT_REGISTRY_DUPLICATE");
    }
    ids.add(projectId);
    roots.add(rootKey);
    return { project_id: entry.project_id, root };
  });
  const rootValues = [...roots];
  for (let left = 0; left < rootValues.length; left += 1) {
    for (let right = left + 1; right < rootValues.length; right += 1) {
      const first = rootValues.at(left);
      const second = rootValues.at(right);
      if (
        first.startsWith(`${second}${path.sep}`) ||
        second.startsWith(`${first}${path.sep}`)
      ) {
        throw new WorkbenchError("PROJECT_REGISTRY_NESTED_ROOTS");
      }
    }
  }
  return result;
}

export function parseProjectRegistry(value) {
  if (
    !exactKeys(value, ["authority", "format", "projects"]) ||
    value.format !== PROJECT_REGISTRY_FORMAT ||
    value.authority !== WORKBENCH_AUTHORITY
  ) {
    throw new WorkbenchError("PROJECT_REGISTRY_INVALID");
  }
  return deepFreeze({
    format: PROJECT_REGISTRY_FORMAT,
    authority: WORKBENCH_AUTHORITY,
    projects: validateEntries(value.projects),
  });
}

export function createProjectRegistry(projects = []) {
  return parseProjectRegistry({
    format: PROJECT_REGISTRY_FORMAT,
    authority: WORKBENCH_AUTHORITY,
    projects,
  });
}

export async function loadProjectRegistry(registryPath) {
  const resolved = supportedRoot(registryPath);
  const parent = await openDirectory(path.dirname(resolved));
  let captured;
  try {
    captured = await captureRegularFile(
      parent,
      path.basename(resolved),
      MAX_REGISTRY_BYTES,
    );
  } catch (error) {
    if (error instanceof WorkbenchError) {
      throw new WorkbenchError("PROJECT_REGISTRY_READ_FAILED");
    }
    throw error;
  }
  let value;
  try {
    value = JSON.parse(captured.content.toString("utf8"));
  } catch {
    throw new WorkbenchError("PROJECT_REGISTRY_INVALID");
  }
  return parseProjectRegistry(value);
}
