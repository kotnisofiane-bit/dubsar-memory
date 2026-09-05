/**
 * Arguments passable to create_dubsar_work_cursor_agent (stateless DUB Controller).
 * New contracts follow Controller PR26 at 90a35ac02cf22399e389b048acf2c074053b763d.
 * Fingerprint algorithm (Controller src/dubsar-work.ts): SHA-256 of JSON.stringify
 * of the ordered 13-key body. Receipt bounds add correction_policy uncapped.
 * Legacy numeric budget 3 contracts remain readable; they are never rewritten here.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { MyWorkMcpError } from "./canonical.mjs";

export const CONTROLLER_TOOL = "create_dubsar_work_cursor_agent";
export const CORRECTION_BUDGET = "uncapped";
export const CORRECTION_POLICY = "uncapped";
export const LEGACY_CORRECTION_BUDGET = 3;
export const CONTROLLER_FINGERPRINT_KEY_ORDER = Object.freeze([
  "acceptance_criteria",
  "allowed_paths",
  "correction_budget",
  "expected_evidence",
  "human_gates",
  "mission",
  "preferred_plugins",
  "pr_repository_url",
  "required_capabilities",
  "required_plugins",
  "repository_refs",
  "target_repository_url",
  "ticket_id",
]);
export const CONTROLLER_ARGUMENT_KEYS = Object.freeze([
  "ticket_id",
  "target_repository_url",
  "pr_repository_url",
  "repository_refs",
  "allowed_paths",
  "mission",
  "acceptance_criteria",
  "expected_evidence",
  "required_capabilities",
  "preferred_plugins",
  "required_plugins",
  "human_gates",
  "correction_budget",
]);
export const REQUIRED_CAPABILITIES = Object.freeze([
  "Node.js 20 ou supérieur",
  "Implémentation MCP stdio locale",
  "Réutilisation des APIs tickets My Work existantes",
  "Tests node:test avec vrai sous-processus",
]);

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
  name,
  mode,
}) {
  const target = targetRepositoryUrl;
  const pr = prRepositoryUrl ?? target;
  const missionText =
    typeof mission === "string" && mission.trim() === mission && mission.length >= 1 && mission.length <= MAX_MISSION
      ? mission
      : null;
  if (!missionText) throw new MyWorkMcpError("MY_WORK_MISSION_INCOMPLETE");
  const args = {
    ticket_id: ticketId,
    target_repository_url: target,
    pr_repository_url: pr,
    repository_refs: repositoryRefs.map((ref) => ({
      repository_url: ref.repository_url,
      starting_sha: ref.starting_sha,
    })),
    allowed_paths: [...allowedPaths],
    mission: missionText,
    acceptance_criteria: nonEmptyStrings(acceptanceCriteria, "MY_WORK_MISSION_INCOMPLETE"),
    expected_evidence: nonEmptyStrings(expectedEvidence, "MY_WORK_MISSION_INCOMPLETE"),
    required_capabilities: nonEmptyStrings(
      requiredCapabilities ?? [...REQUIRED_CAPABILITIES],
      "MY_WORK_MISSION_INCOMPLETE",
    ),
    preferred_plugins: pluginList(preferredPlugins),
    required_plugins: pluginList(requiredPlugins),
    human_gates: requireCatalog(nonEmptyStrings(humanGates ?? [...HUMAN_GATES], "MY_WORK_MISSION_INCOMPLETE")),
    correction_budget: CORRECTION_BUDGET,
  };
  if (name != null) args.name = boundedItem(name, MAX_ITEM, "MY_WORK_MISSION_INCOMPLETE");
  if (mode != null) args.mode = boundedItem(mode, MAX_ITEM, "MY_WORK_MISSION_INCOMPLETE");
  if (Buffer.byteLength(JSON.stringify(args), "utf8") > MAX_CONTRACT_BYTES) {
    throw new MyWorkMcpError("MY_WORK_MISSION_INCOMPLETE");
  }
  return args;
}

export function controllerFingerprintBody(args) {
  return {
    acceptance_criteria: args.acceptance_criteria,
    allowed_paths: args.allowed_paths,
    correction_budget: args.correction_budget,
    expected_evidence: args.expected_evidence,
    human_gates: args.human_gates,
    mission: args.mission,
    preferred_plugins: args.preferred_plugins,
    pr_repository_url: args.pr_repository_url,
    required_capabilities: args.required_capabilities,
    required_plugins: args.required_plugins,
    repository_refs: args.repository_refs,
    target_repository_url: args.target_repository_url,
    ticket_id: args.ticket_id,
  };
}

export function requireNewCorrectionBudget(value) {
  if (value == null) return CORRECTION_BUDGET;
  if (value !== CORRECTION_BUDGET) throw new MyWorkMcpError("MY_WORK_MISSION_INCOMPLETE");
  return CORRECTION_BUDGET;
}

export function controllerContractFingerprint(args) {
  return `sha256:${createHash("sha256").update(JSON.stringify(controllerFingerprintBody(args)), "utf8").digest("hex")}`;
}

export function controllerReceiptBounds(args) {
  return {
    allowed_paths: args.allowed_paths,
    auto_create_pr: true,
    correction_budget: args.correction_budget,
    correction_policy: CORRECTION_POLICY,
    human_gates: args.human_gates,
    pr_repository_url: args.pr_repository_url,
    stateless: true,
    work_on_current_branch: false,
  };
}

export function assemblePreparedMission(args) {
  return {
    arguments: args,
    contract_fingerprint: controllerContractFingerprint(args),
    receipt_bounds: controllerReceiptBounds(args),
  };
}

export function controllerToolCall(args) {
  return { tool: CONTROLLER_TOOL, arguments: args };
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

export function boundsMatch(receiptBounds, expected) {
  if (JSON.stringify(receiptBounds) === JSON.stringify(expected)) return true;
  if (!receiptBounds || typeof receiptBounds !== "object" || Array.isArray(receiptBounds)) {
    return false;
  }
  if (!Number.isSafeInteger(receiptBounds.correction_number) || receiptBounds.correction_number < 1) {
    return false;
  }
  const expectedRunBounds = {
    ...expected,
    correction_number: receiptBounds.correction_number,
  };
  return JSON.stringify(receiptBounds) === JSON.stringify(expectedRunBounds);
}

export function humanGatesCatalog() {
  return [...HUMAN_GATES];
}
