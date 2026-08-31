import { createHash } from "node:crypto";
import {
  buildUnsignedControllerArguments,
  signControllerArguments,
} from "./mission-args.mjs";

export const CONTROLLER_CONTRACT_FORMAT = "dubsar.cursor-controller-contract/1";
export const GITHUB_REPOSITORY_URL =
  /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/u;
export const SHA40 = /^[0-9a-f]{40}$/u;
export const CONTRACT_FINGERPRINT = /^sha256:[0-9a-f]{64}$/u;
const TICKET_ID = /^DUB-\d{3}$/u;

export class MyWorkMcpError extends Error {
  constructor(code) {
    super(code);
    this.name = "MyWorkMcpError";
    this.code = code;
  }
}

export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function fingerprintOf(value) {
  return `sha256:${createHash("sha256").update(stableJson(value)).digest("hex")}`;
}

function requiredText(value, max, code) {
  if (
    typeof value !== "string" ||
    value.trim() !== value ||
    value.length < 1 ||
    value.length > max
  ) {
    throw new MyWorkMcpError(code);
  }
  return value;
}

export function requireSelectedProject(input) {
  requiredText(input?.start, 4096, "MY_WORK_PROJECT_REQUIRED");
  requiredText(input?.allocation_root, 4096, "MY_WORK_PROJECT_REQUIRED");
  requiredText(input?.project_id, 64, "MY_WORK_PROJECT_REQUIRED");
  return {
    start: input.start,
    allocationRoot: input.allocation_root,
    projectId: input.project_id,
  };
}

export function assertAllowedPath(value) {
  const pathValue = requiredText(value, 300, "MY_WORK_PATH_UNSAFE");
  if (
    pathValue.startsWith("/") ||
    pathValue.includes("\\") ||
    pathValue.includes("\0") ||
    pathValue.includes(":") ||
    pathValue.startsWith("~")
  ) {
    throw new MyWorkMcpError("MY_WORK_PATH_UNSAFE");
  }
  const parts = pathValue.split("/");
  if (parts.length < 1 || parts.some((part) => part === "" || part === "." || part === "..")) {
    throw new MyWorkMcpError("MY_WORK_PATH_UNSAFE");
  }
  return pathValue;
}

export function normalizeRepositoryUrl(value) {
  const url = requiredText(value, 2000, "MY_WORK_MISSION_INCOMPLETE");
  if (!GITHUB_REPOSITORY_URL.test(url)) throw new MyWorkMcpError("MY_WORK_REPOSITORY_CONTRADICTION");
  return url.replace(/\.git$/u, "");
}

export function normalizeRepositoryRefs({ targetRepositoryUrl, startingSha, repositoryRefs }) {
  const target = normalizeRepositoryUrl(targetRepositoryUrl);
  let refs;
  if (Array.isArray(repositoryRefs) && repositoryRefs.length > 0) {
    if (repositoryRefs.length > 20) throw new MyWorkMcpError("MY_WORK_MISSION_INCOMPLETE");
    refs = repositoryRefs.map((reference) => {
      if (!reference || typeof reference !== "object") throw new MyWorkMcpError("MY_WORK_MISSION_INCOMPLETE");
      const repositoryUrl = normalizeRepositoryUrl(reference.repository_url);
      if (!SHA40.test(reference.starting_sha ?? "")) throw new MyWorkMcpError("MY_WORK_SHA_INVALID");
      if (repositoryUrl !== target) throw new MyWorkMcpError("MY_WORK_REPOSITORY_CONTRADICTION");
      if (startingSha != null && startingSha !== "" && reference.starting_sha !== startingSha) {
        throw new MyWorkMcpError("MY_WORK_SHA_INVALID");
      }
      return Object.freeze({ repository_url: repositoryUrl, starting_sha: reference.starting_sha });
    });
  } else {
    if (!SHA40.test(startingSha ?? "")) throw new MyWorkMcpError("MY_WORK_SHA_INVALID");
    refs = [Object.freeze({ repository_url: target, starting_sha: startingSha })];
  }
  return { target, refs };
}

export function buildControllerEnvelope({
  ticketId,
  targetRepositoryUrl,
  startingSha,
  repositoryRefs,
  allowedPaths,
  linearIssue,
  prRepositoryUrl,
  mission,
  acceptanceCriteria,
  expectedEvidence,
  requiredCapabilities,
  preferredPlugins,
  requiredPlugins,
  humanGates,
  title,
  objective,
  criteria,
}) {
  if (!TICKET_ID.test(ticketId ?? "")) throw new MyWorkMcpError("MY_WORK_MISSION_INCOMPLETE");
  const { target, refs } = normalizeRepositoryRefs({
    targetRepositoryUrl,
    startingSha,
    repositoryRefs,
  });
  const pr = prRepositoryUrl == null ? target : normalizeRepositoryUrl(prRepositoryUrl);
  if (!Array.isArray(allowedPaths) || allowedPaths.length < 1 || allowedPaths.length > 20) {
    throw new MyWorkMcpError("MY_WORK_MISSION_INCOMPLETE");
  }
  const paths = Object.freeze(allowedPaths.map(assertAllowedPath));
  const linearIssueId =
    linearIssue == null ? undefined : requiredText(linearIssue, 32, "MY_WORK_MISSION_INCOMPLETE");
  const missionText =
    mission ??
    (typeof title === "string" && typeof objective === "string" ? `${title}: ${objective}` : `Ticket ${ticketId}`);
  const acceptance = acceptanceCriteria ?? (Array.isArray(criteria) && criteria.length > 0 ? criteria : [`Ticket ${ticketId} persisté`]);
  const evidence = expectedEvidence ?? ["diff GitHub borné aux allowed_paths", "sortie des tests ciblés du lot"];
  const unsigned = buildUnsignedControllerArguments({
    ticketId,
    targetRepositoryUrl: target,
    prRepositoryUrl: pr,
    repositoryRefs: refs,
    allowedPaths: paths,
    mission: missionText,
    acceptanceCriteria: acceptance,
    expectedEvidence: evidence,
    requiredCapabilities,
    preferredPlugins,
    requiredPlugins,
    humanGates,
    linearIssueId,
  });
  return Object.freeze(signControllerArguments(unsigned));
}
