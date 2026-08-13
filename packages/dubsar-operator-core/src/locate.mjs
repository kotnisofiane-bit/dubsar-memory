import path from "node:path";
import {
  DEFAULT_LIMITS,
  WorkbenchError,
  deepFreeze,
  resolveLimits,
} from "./contracts.mjs";
import { entryInfo, openDirectory } from "./path-safety.mjs";

const MARKERS = Object.freeze({
  project: ".dubsar-project",
  audit: ".dubsar-audit",
});

async function assertMarker(candidate) {
  const info = await entryInfo(candidate);
  if (info === null) {
    return false;
  }
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new WorkbenchError("WORKSPACE_MARKER_UNSAFE");
  }
  await openDirectory(candidate);
  return true;
}

async function hasProjectBoundary(directory) {
  const marker = path.join(directory, ".git");
  const info = await entryInfo(marker);
  if (info === null) {
    return false;
  }
  if (
    info.isSymbolicLink() ||
    (!info.isDirectory() && !info.isFile())
  ) {
    throw new WorkbenchError("PROJECT_BOUNDARY_UNSAFE");
  }
  return true;
}

export async function locateWorkspace({
  start = process.cwd(),
  domain,
  maxParents = DEFAULT_LIMITS.maxParents,
} = {}) {
  if (domain !== undefined && !Object.hasOwn(MARKERS, domain)) {
    throw new WorkbenchError("DOMAIN_INVALID");
  }
  const limits = resolveLimits({ maxParents });
  let current = await openDirectory(start);

  for (let distance = 0; distance < limits.maxParents; distance += 1) {
    const domains = domain === undefined ? Object.keys(MARKERS) : [domain];
    const found = [];
    for (const candidateDomain of domains) {
      const marker =
        candidateDomain === "project" ? MARKERS.project : MARKERS.audit;
      const candidate = path.join(current, marker);
      if (await assertMarker(candidate)) {
        found.push({
          domain: candidateDomain,
          marker,
          root: await openDirectory(candidate),
          distance,
        });
      }
    }
    if (found.length > 1) {
      throw new WorkbenchError("WORKSPACE_DOMAIN_AMBIGUOUS");
    }
    if (found.length === 1) {
      return deepFreeze(found.at(0));
    }
    const atBoundary = await hasProjectBoundary(current);
    const parent = path.dirname(current);
    if (atBoundary || parent === current) {
      break;
    }
    current = parent;
  }
  throw new WorkbenchError("WORKSPACE_NOT_FOUND");
}
