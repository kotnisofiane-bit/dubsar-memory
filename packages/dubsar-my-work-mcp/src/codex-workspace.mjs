import { realpath } from "node:fs/promises";
import path from "node:path";
import { MyWorkMcpError } from "./canonical.mjs";

export async function confineAuthorizedWorkspace(authorizedStart, candidate = authorizedStart) {
  if (typeof authorizedStart !== "string" || typeof candidate !== "string") {
    throw new MyWorkMcpError("MY_WORK_WORKSPACE_INVALID");
  }
  if (authorizedStart.includes("\0") || candidate.includes("\0")) {
    throw new MyWorkMcpError("MY_WORK_WORKSPACE_INVALID");
  }
  let authorizedReal;
  let candidateReal;
  try {
    authorizedReal = await realpath(authorizedStart);
    candidateReal = await realpath(candidate);
  } catch {
    throw new MyWorkMcpError("MY_WORK_WORKSPACE_INVALID");
  }
  if (authorizedReal !== candidateReal) {
    throw new MyWorkMcpError("MY_WORK_SCOPE_EXTENSION");
  }
  return authorizedReal;
}

export function assertPathInsideWorkspace(workspaceReal, relativePath) {
  if (typeof relativePath !== "string" || relativePath.startsWith("/") || relativePath.includes("\0")) {
    throw new MyWorkMcpError("MY_WORK_SCOPE_EXTENSION");
  }
  const resolved = path.resolve(workspaceReal, relativePath);
  const relative = path.relative(workspaceReal, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new MyWorkMcpError("MY_WORK_SCOPE_EXTENSION");
  }
  return resolved;
}
