import path from "node:path";
import {
  DEFAULT_LIMITS,
  WorkbenchError,
  deepFreeze,
  resolveLimits,
} from "./contracts.mjs";
import { entryInfo, openDirectory } from "./path-safety.mjs";

export const LEGACY_PROJECT_MARKER = ".dubsar-project";
export const MEMORY_PROJECT_MARKER = ".dubsar";

async function assertMarker(candidate) {
  const info = await entryInfo(candidate);
  if (info === null) return false;
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new WorkbenchError("WORKSPACE_MARKER_UNSAFE");
  }
  await openDirectory(candidate);
  return true;
}

async function hasProjectBoundary(directory) {
  const info = await entryInfo(path.join(directory, ".git"));
  if (info === null) return false;
  if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) {
    throw new WorkbenchError("PROJECT_BOUNDARY_UNSAFE");
  }
  return true;
}

export async function locateProjectWorkspace({
  start = process.cwd(),
  maxParents = DEFAULT_LIMITS.maxParents,
} = {}) {
  const limits = resolveLimits({ maxParents });
  let current = await openDirectory(start);
  for (let distance = 0; distance < limits.maxParents; distance += 1) {
    const memoryCandidate = path.join(current, MEMORY_PROJECT_MARKER);
    const legacyCandidate = path.join(current, LEGACY_PROJECT_MARKER);
    const hasMemory = await assertMarker(memoryCandidate);
    const hasLegacy = await assertMarker(legacyCandidate);
    if (hasMemory || hasLegacy) {
      const marker = hasMemory ? MEMORY_PROJECT_MARKER : LEGACY_PROJECT_MARKER;
      const candidate = hasMemory ? memoryCandidate : legacyCandidate;
      return deepFreeze({
        domain: "project",
        marker,
        root: await openDirectory(candidate),
        project_root: current,
        legacy_root: hasLegacy ? await openDirectory(legacyCandidate) : null,
        has_legacy_sibling: hasMemory && hasLegacy,
        distance,
      });
    }
    const atBoundary = await hasProjectBoundary(current);
    const parent = path.dirname(current);
    if (atBoundary || parent === current) break;
    current = parent;
  }
  throw new WorkbenchError("WORKSPACE_NOT_FOUND");
}
