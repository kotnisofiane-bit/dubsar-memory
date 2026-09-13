import { fingerprintOf, MyWorkMcpError, requireSelectedProject, stableJson } from "./canonical.mjs";
import { assertAllowedPath } from "./canonical.mjs";
import { requireNewCorrectionBudget } from "./mission-args.mjs";

export const CODEX_CONTRACT_FORMAT = "dubsar.codex-local-contract/1";
export const CODEX_LAUNCH_RECEIPT_VERSION = "dubsar.codex-local-launch-receipt/1";
export const CODEX_RUN_RECEIPT_VERSION = "dubsar.codex-local-run-receipt/1";
export const CODEX_STOP_RECEIPT_VERSION = "dubsar.codex-local-stop-receipt/1";
export const TICKET_ID = /^DUB-\d{3}$/u;

export const LOCAL_CODEX_ARGUMENT_KEYS = Object.freeze([
  "ticket_id",
  "workspace_root",
  "allowed_paths",
  "mission",
  "acceptance_criteria",
  "expected_evidence",
  "human_gates",
  "correction_budget",
  "auto_approve_dialogue",
  "auto_recreate_session",
  "close_homonym_workspace",
]);

export const LOCAL_CODEX_BOUNDS = Object.freeze({
  auto_approve_dialogue: false,
  auto_recreate_session: false,
  close_homonym_workspace: false,
  workspace_bind: "authorized_only",
  correction_budget: "uncapped",
  correction_policy: "uncapped",
  stateless: true,
});

const HUMAN_GATES = Object.freeze([
  "merge",
  "local_install",
  "deployment",
  "publication",
  "vm_cloud",
  "secrets",
  "backend_switch",
  "scope_extension",
]);

function requiredText(value, max, code) {
  if (typeof value !== "string" || value.trim() !== value || value.length < 1 || value.length > max) {
    throw new MyWorkMcpError(code);
  }
  return value;
}

function freezeArgs(args) {
  return Object.freeze({
    ticket_id: args.ticket_id,
    workspace_root: args.workspace_root,
    allowed_paths: Object.freeze([...args.allowed_paths]),
    mission: args.mission,
    acceptance_criteria: Object.freeze([...args.acceptance_criteria]),
    expected_evidence: Object.freeze([...args.expected_evidence]),
    human_gates: Object.freeze([...args.human_gates]),
    correction_budget: args.correction_budget,
    auto_approve_dialogue: false,
    auto_recreate_session: false,
    close_homonym_workspace: false,
  });
}

export function buildCodexEnvelope({
  ticketId,
  workspaceRoot,
  allowedPaths,
  mission,
  acceptanceCriteria,
  expectedEvidence,
  humanGates,
  title,
  objective,
  criteria,
  autoApproveDialogue,
  autoRecreateSession,
  closeHomonymWorkspace,
  correctionBudget,
}) {
  if (!TICKET_ID.test(ticketId ?? "")) throw new MyWorkMcpError("MY_WORK_MISSION_INCOMPLETE");
  requireNewCorrectionBudget(correctionBudget);
  if (autoApproveDialogue === true) throw new MyWorkMcpError("MY_WORK_DIALOGUE_AUTO_APPROVE_FORBIDDEN");
  if (autoRecreateSession === true) throw new MyWorkMcpError("MY_WORK_SESSION_RECREATE_FORBIDDEN");
  if (closeHomonymWorkspace === true) throw new MyWorkMcpError("MY_WORK_WORKSPACE_CLOSE_FORBIDDEN");
  const workspace = requiredText(workspaceRoot, 4096, "MY_WORK_WORKSPACE_INVALID");
  if (workspace.includes("\0") || workspace.includes("..")) throw new MyWorkMcpError("MY_WORK_WORKSPACE_INVALID");
  if (!Array.isArray(allowedPaths) || allowedPaths.length < 1 || allowedPaths.length > 20) {
    throw new MyWorkMcpError("MY_WORK_MISSION_INCOMPLETE");
  }
  const paths = Object.freeze(allowedPaths.map(assertAllowedPath));
  const missionText =
    mission ??
    (typeof title === "string" && typeof objective === "string" ? `${title}: ${objective}` : `Ticket ${ticketId}`);
  requiredText(missionText, 4000, "MY_WORK_MISSION_INCOMPLETE");
  const acceptance = acceptanceCriteria ?? (Array.isArray(criteria) && criteria.length > 0 ? criteria : [`Ticket ${ticketId} persisté`]);
  if (!Array.isArray(acceptance) || acceptance.length < 1 || acceptance.some((item) => typeof item !== "string" || item.length < 1 || item.length > 300)) {
    throw new MyWorkMcpError("MY_WORK_MISSION_INCOMPLETE");
  }
  const evidence = expectedEvidence ?? [
    "écriture attendue vérifiée hors processus agent",
    "reprise par identifiant Codex sans nouvelle session",
  ];
  if (!Array.isArray(evidence) || evidence.length < 1 || evidence.some((item) => typeof item !== "string")) {
    throw new MyWorkMcpError("MY_WORK_MISSION_INCOMPLETE");
  }
  const gates = humanGates ?? HUMAN_GATES;
  if (!Array.isArray(gates) || stableJson(gates) !== stableJson(HUMAN_GATES)) {
    throw new MyWorkMcpError("MY_WORK_MISSION_INCOMPLETE");
  }
  const arguments_ = freezeArgs({
    ticket_id: ticketId,
    workspace_root: workspace,
    allowed_paths: paths,
    mission: missionText,
    acceptance_criteria: acceptance,
    expected_evidence: evidence,
    human_gates: gates,
    correction_budget: "uncapped",
  });
  return Object.freeze({
    format: CODEX_CONTRACT_FORMAT,
    arguments: arguments_,
    contract_fingerprint: fingerprintOf(arguments_),
    receipt_bounds: Object.freeze({ ...LOCAL_CODEX_BOUNDS }),
  });
}

export function requireAuthorizedWorkspace(argsStart, workspaceRoot) {
  const selected = requireSelectedProject({ start: argsStart, allocation_root: "x", project_id: "x" }).start;
  if (workspaceRoot !== selected && workspaceRoot !== argsStart) {
    throw new MyWorkMcpError("MY_WORK_SCOPE_EXTENSION");
  }
  return workspaceRoot;
}

export function localCodexReceiptShape({
  version,
  ticketId,
  contractFingerprint,
  workspaceRoot,
  herdrId,
  sessionId,
  missionId,
  status,
}) {
  return {
    receipt_version: version,
    ticket_id: ticketId,
    contract_fingerprint: contractFingerprint,
    workspace_root: workspaceRoot,
    herdr_id: herdrId,
    codex_session_id: sessionId,
    mission_id: missionId,
    status,
    bounds: { ...LOCAL_CODEX_BOUNDS },
    mission_success: false,
  };
}
