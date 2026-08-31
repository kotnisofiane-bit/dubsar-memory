/**
 * Arguments passable to create_dubsar_work_cursor_agent (stateless DUB Controller).
 * Observed Controller revision: 9c5cd6536ebfa5c582a00a9d66cdff1560dd469c
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { MyWorkMcpError, fingerprintOf, stableJson } from "./canonical.mjs";

export const CONTROLLER_TOOL = "create_dubsar_work_cursor_agent";
export const CONTRACT_FORMAT = "dubsar.cursor-controller-contract/1";
export const CORRECTION_BUDGET = 3;
export const REQUIRED_CAPABILITIES = Object.freeze([
  "Node.js 20 ou supérieur",
  "Implémentation MCP stdio locale",
  "Réutilisation des APIs tickets My Work existantes",
  "Tests node:test avec vrai sous-processus",
]);
export const RECEIPT_BOUNDS = Object.freeze({
  autoCreatePR: true,
  max_runs: 1,
  polling: false,
  workOnCurrentBranch: false,
});

const HUMAN_GATES = Object.freeze(
  JSON.parse(
    readFileSync(
      fileURLToPath(new URL("../vectors/controller-human-gates.json", import.meta.url)),
      "utf8",
    ),
  ),
);

const MAX_MISSION = 4000;
const MAX_ITEM = 300;
const MAX_PLUGIN = 80;
const MAX_CONTRACT_BYTES = 12 * 1024;

function boundedItem(item, max, code) {
  if (typeof item !== "string" || item.trim() !== item || item.length < 1 || item.length > max) {
    throw new MyWorkMcpError(code);
  }
  return item;
}

function nonEmptyStrings(value, code, max = MAX_ITEM) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 20) {
    throw new MyWorkMcpError(code);
  }
  return value.map((item) => boundedItem(item, max, code));
}

function pluginList(value) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 20) throw new MyWorkMcpError("MY_WORK_MISSION_INCOMPLETE");
  return value.map((item) => boundedItem(item, MAX_PLUGIN, "MY_WORK_MISSION_INCOMPLETE"));
}

function requireCatalog(gates) {
  const provided = new Set(gates);
  for (const required of HUMAN_GATES) {
    if (!provided.has(required)) throw new MyWorkMcpError("MY_WORK_MISSION_INCOMPLETE");
  }
  return gates;
}

export function stripFingerprint(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const { contract_fingerprint: _ignored, ...rest } = value;
  return rest;
}

/**
 * Normalized Controller tool arguments without contract_fingerprint.
 * Fingerprint is sha256 of stableJson(this object).
 */
export function buildUnsignedControllerArguments({
  ticketId,
  targetRepositoryUrl,
  prRepositoryUrl,
  repositoryRefs,
  allowedPaths,
  mission,
  acceptanceCriteria,
  expectedEvidence,
  requiredCapabilities,
  preferredPlugins,
  requiredPlugins,
  humanGates,
  linearIssueId,
  autoCreatePR,
  workOnCurrentBranch,
}) {
  const target = targetRepositoryUrl;
  const pr = prRepositoryUrl ?? target;
  const missionText =
    typeof mission === "string" && mission.trim() === mission && mission.length >= 1 && mission.length <= MAX_MISSION
      ? mission
      : null;
  if (!missionText) throw new MyWorkMcpError("MY_WORK_MISSION_INCOMPLETE");
  const args = {
    acceptance_criteria: nonEmptyStrings(acceptanceCriteria, "MY_WORK_MISSION_INCOMPLETE"),
    allowed_paths: allowedPaths,
    autoCreatePR: autoCreatePR ?? RECEIPT_BOUNDS.autoCreatePR,
    bounds: {
      autoCreatePR: autoCreatePR ?? RECEIPT_BOUNDS.autoCreatePR,
      max_runs: RECEIPT_BOUNDS.max_runs,
      polling: RECEIPT_BOUNDS.polling,
      workOnCurrentBranch: workOnCurrentBranch ?? RECEIPT_BOUNDS.workOnCurrentBranch,
    },
    correction_budget: CORRECTION_BUDGET,
    expected_evidence: nonEmptyStrings(expectedEvidence, "MY_WORK_MISSION_INCOMPLETE"),
    format: CONTRACT_FORMAT,
    human_gates: requireCatalog(nonEmptyStrings(humanGates ?? [...HUMAN_GATES], "MY_WORK_MISSION_INCOMPLETE")),
    mission: missionText,
    preferred_plugins: pluginList(preferredPlugins),
    pr_repository_url: pr,
    repository_refs: repositoryRefs,
    required_capabilities: nonEmptyStrings(
      requiredCapabilities ?? [...REQUIRED_CAPABILITIES],
      "MY_WORK_MISSION_INCOMPLETE",
    ),
    required_plugins: pluginList(requiredPlugins),
    target_repository_url: target,
    ticket_id: ticketId,
    workOnCurrentBranch: workOnCurrentBranch ?? RECEIPT_BOUNDS.workOnCurrentBranch,
  };
  if (linearIssueId != null) args.linear_issue_id = linearIssueId;
  if (Buffer.byteLength(stableJson(args), "utf8") > MAX_CONTRACT_BYTES) {
    throw new MyWorkMcpError("MY_WORK_MISSION_INCOMPLETE");
  }
  return args;
}

export function signControllerArguments(unsigned) {
  return { ...unsigned, contract_fingerprint: fingerprintOf(unsigned) };
}

export function controllerToolCall(signed) {
  return { tool: CONTROLLER_TOOL, arguments: signed };
}

export function defaultMissionText(title, objective) {
  return `${title}: ${objective}`;
}

export function refsMatch(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
  for (let i = 0; i < left.length; i += 1) {
    if (
      left[i]?.repository_url !== right[i]?.repository_url ||
      left[i]?.starting_sha !== right[i]?.starting_sha
    ) {
      return false;
    }
  }
  return true;
}

export function boundsMatch(receiptBounds, contractBounds) {
  const expected = contractBounds ?? RECEIPT_BOUNDS;
  return stableJson(receiptBounds) === stableJson(expected);
}

export function humanGatesCatalog() {
  return [...HUMAN_GATES];
}
