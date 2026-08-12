import {
  PublicPluginError,
  readRegularFile,
  readJson,
  sha256File,
} from "./safe-io.mjs";
import path from "node:path";

export const REQUIRED_FILES = [
  "audit-scope.json",
  "automation-inventory.json",
  "sensitive-actions.json",
  "evidence-index.json",
  "evidence-review.json",
];

const EXPECTED_FORMATS = {
  "audit-scope.json": "dubsar.audit-scope/1",
  "automation-inventory.json": "dubsar.automation-inventory/1",
  "sensitive-actions.json": "dubsar.sensitive-actions/1",
  "evidence-index.json": "dubsar.evidence-index/1",
  "evidence-review.json": "dubsar.evidence-review/1",
};

const MAX_ARTIFACT_BYTES = 25 * 1024 * 1024;
const FORBIDDEN_ARTIFACT_EXTENSIONS = new Set([
  ".exe",
  ".dll",
  ".node",
  ".zip",
  ".tar",
  ".7z",
  ".pem",
  ".key",
  ".kdbx",
  ".p12",
  ".pfx",
]);
const FORBIDDEN_ARTIFACT_BASENAMES = new Set([
  ".dockerconfigjson",
  ".netrc",
  ".npmrc",
  ".pypirc",
  "auth.json",
  "credentials",
  "credentials.json",
  "id_ed25519",
  "id_rsa",
  "secrets",
  "secrets.json",
]);

export function artifactPolicyFinding(relativePath, content) {
  const portablePath = relativePath.replaceAll("\\", "/");
  const basename = path.posix.basename(portablePath).toLowerCase();
  const extension = path.posix.extname(basename);
  if (
    basename === ".env" ||
    basename.startsWith(".env.") ||
    basename.startsWith("credentials.") ||
    basename.startsWith("secrets.") ||
    FORBIDDEN_ARTIFACT_BASENAMES.has(basename) ||
    FORBIDDEN_ARTIFACT_EXTENSIONS.has(extension)
  ) {
    return "ARTIFACT_FILE_TYPE_FORBIDDEN";
  }
  const text = content.toString("utf8");
  if (
    /-----BEGIN [A-Z ]+ PRIVATE KEY-----/u.test(text) ||
    /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16})\b/u.test(
      text,
    ) ||
    /\bBearer\s+[A-Za-z0-9._-]{12,}\b/iu.test(text) ||
    /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/u.test(
      text,
    )
  ) {
    return "ARTIFACT_CREDENTIAL_PATTERN";
  }
  const assignment =
    /["']?\b(?:password|secret|client[_-]?secret|api[_-]?key|access[_-]?token|refresh[_-]?token|session[_-]?token|private[_-]?key|connection[_-]?string|token|bearer)\b["']?\s*[:=]\s*["']?([^\s"',}]{6,})/giu;
  for (const match of text.matchAll(assignment)) {
    const value = match[1].replace(/[<>]/gu, "").toLowerCase();
    if (!["redacted", "token", "example", "dummy", "null", "none"].includes(value)) {
      return "ARTIFACT_CREDENTIAL_ASSIGNMENT";
    }
  }
  if (/\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/iu.test(text)) {
    return "ARTIFACT_CREDENTIAL_URL";
  }
  return null;
}

function arrayOrFinding(value, code, findings) {
  if (!Array.isArray(value)) {
    findings.push(code);
    return [];
  }
  return value;
}

function duplicateIds(items, field) {
  const seen = new Set();
  const duplicates = new Set();
  for (const item of items) {
    const id = item?.[field];
    if (typeof id !== "string" || id.length === 0) {
      continue;
    }
    if (seen.has(id)) {
      duplicates.add(id);
    }
    seen.add(id);
  }
  return duplicates;
}

export async function loadAuditWorkspace(root) {
  const documents = {};
  for (const file of REQUIRED_FILES) {
    documents[file] = await readJson(root, file);
  }
  return documents;
}

export async function validateAuditWorkspace(root) {
  const findings = [];
  let documents;
  try {
    documents = await loadAuditWorkspace(root);
  } catch (error) {
    if (error instanceof PublicPluginError) {
      return {
        status: "invalid",
        preparation_status: "not_ready",
        findings: [error.code],
      };
    }
    throw error;
  }

  for (const [file, expected] of Object.entries(EXPECTED_FORMATS)) {
    if (documents[file]?.format !== expected) {
      findings.push(`FORMAT_MISMATCH:${file}`);
    }
  }

  const scope = documents["audit-scope.json"];
  const caseId = scope?.case_id;
  if (typeof caseId !== "string" || caseId.length === 0) {
    findings.push("CASE_ID_MISSING");
  }
  for (const file of REQUIRED_FILES.slice(1)) {
    if (documents[file]?.case_id !== caseId) {
      findings.push(`CASE_ID_MISMATCH:${file}`);
    }
  }

  const inventory = arrayOrFinding(
    documents["automation-inventory.json"]?.items,
    "INVENTORY_ITEMS_NOT_ARRAY",
    findings,
  );
  const actions = arrayOrFinding(
    documents["sensitive-actions.json"]?.actions,
    "SENSITIVE_ACTIONS_NOT_ARRAY",
    findings,
  );
  const artifacts = arrayOrFinding(
    documents["evidence-index.json"]?.artifacts,
    "EVIDENCE_ARTIFACTS_NOT_ARRAY",
    findings,
  );

  if (duplicateIds(inventory, "id").size > 0) {
    findings.push("DUPLICATE_INVENTORY_ID");
  }
  if (duplicateIds(actions, "id").size > 0) {
    findings.push("DUPLICATE_ACTION_ID");
  }
  if (duplicateIds(artifacts, "artifact_id").size > 0) {
    findings.push("DUPLICATE_ARTIFACT_ID");
  }
  if (
    inventory.some(
      (item) => typeof item?.id !== "string" || item.id.length === 0,
    )
  ) {
    findings.push("INVENTORY_ID_MISSING");
  }
  if (
    actions.some(
      (action) => typeof action?.id !== "string" || action.id.length === 0,
    )
  ) {
    findings.push("ACTION_ID_MISSING");
  }

  const inventoryIds = new Set(inventory.map((item) => item?.id));
  const artifactIds = new Set(artifacts.map((item) => item?.artifact_id));
  const generatedFrom = arrayOrFinding(
    documents["automation-inventory.json"]?.generated_from,
    "INVENTORY_GENERATED_FROM_NOT_ARRAY",
    findings,
  );
  const approvedEvidence = arrayOrFinding(
    scope?.approved_evidence,
    "APPROVED_EVIDENCE_NOT_ARRAY",
    findings,
  );
  const reservedArtifactPaths = new Set([
    ...REQUIRED_FILES.map((file) => file.toLowerCase()),
    "audit-preparation-summary.md",
    "manifest.sha256.json",
  ]);
  let inventoryHasUnlinkedItem = false;
  for (const action of actions) {
    if (!inventoryIds.has(action?.automation_id)) {
      findings.push("ACTION_AUTOMATION_REFERENCE_MISSING");
    }
    for (const evidenceRef of arrayOrFinding(
      action?.evidence_refs,
      "ACTION_EVIDENCE_REFS_NOT_ARRAY",
      findings,
    )) {
      if (!artifactIds.has(evidenceRef)) {
        findings.push("ACTION_EVIDENCE_REFERENCE_MISSING");
      }
    }
  }

  for (const sourceRef of generatedFrom) {
    if (!artifactIds.has(sourceRef)) {
      findings.push("INVENTORY_SOURCE_REFERENCE_MISSING");
    }
  }
  for (const item of inventory) {
    const itemEvidenceRefs = arrayOrFinding(
      item?.evidence_refs,
      "INVENTORY_EVIDENCE_REFS_NOT_ARRAY",
      findings,
    );
    if (itemEvidenceRefs.length === 0) {
      inventoryHasUnlinkedItem = true;
    }
    for (const evidenceRef of itemEvidenceRefs) {
      if (!artifactIds.has(evidenceRef)) {
        findings.push("INVENTORY_EVIDENCE_REFERENCE_MISSING");
      }
    }
  }

  for (const approvedRef of approvedEvidence) {
    if (!artifactIds.has(approvedRef)) {
      findings.push("APPROVED_EVIDENCE_REFERENCE_MISSING");
    }
  }
  const approvedEvidenceSet = new Set(approvedEvidence);
  for (const artifactId of artifactIds) {
    if (!approvedEvidenceSet.has(artifactId)) {
      findings.push("ARTIFACT_NOT_APPROVED");
    }
  }

  for (const artifact of artifacts) {
    if (
      typeof artifact?.artifact_id !== "string" ||
      artifact.artifact_id.length === 0 ||
      typeof artifact?.path !== "string" ||
      typeof artifact?.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(artifact.sha256)
    ) {
      findings.push("ARTIFACT_METADATA_INVALID");
      continue;
    }
    const portableArtifactPath = artifact.path
      .replaceAll("\\", "/")
      .toLowerCase();
    if (reservedArtifactPaths.has(portableArtifactPath)) {
      findings.push("ARTIFACT_PATH_RESERVED");
      continue;
    }
    try {
      const content = await readRegularFile(
        root,
        artifact.path,
        MAX_ARTIFACT_BYTES,
      );
      const policyFinding = artifactPolicyFinding(artifact.path, content);
      if (policyFinding) {
        findings.push(policyFinding);
      }
      const actual = await sha256File(root, artifact.path);
      if (actual !== artifact.sha256) {
        findings.push("ARTIFACT_DIGEST_MISMATCH");
      }
    } catch (error) {
      findings.push(
        error instanceof PublicPluginError
          ? error.code.startsWith("ARTIFACT_")
            ? error.code
            : `ARTIFACT_${error.code}`
          : "ARTIFACT_CHECK_FAILED",
      );
    }
  }

  const review = documents["evidence-review.json"];
  const supportedObservations = arrayOrFinding(
    review?.supported_observations,
    "SUPPORTED_OBSERVATIONS_NOT_ARRAY",
    findings,
  );
  for (const observation of supportedObservations) {
    if (
      typeof observation?.statement !== "string" ||
      observation.statement.trim() === ""
    ) {
      findings.push("SUPPORTED_OBSERVATION_STATEMENT_INVALID");
    }
    const evidenceRefs = arrayOrFinding(
      observation?.evidence_refs,
      "SUPPORTED_OBSERVATION_EVIDENCE_REFS_NOT_ARRAY",
      findings,
    );
    if (evidenceRefs.length === 0) {
      findings.push("SUPPORTED_OBSERVATION_EVIDENCE_LINK_MISSING");
    }
    for (const evidenceRef of evidenceRefs) {
      if (!artifactIds.has(evidenceRef)) {
        findings.push("SUPPORTED_OBSERVATION_EVIDENCE_REFERENCE_MISSING");
      }
    }
  }
  const contradictions = arrayOrFinding(
    review?.contradictions,
    "CONTRADICTIONS_NOT_ARRAY",
    findings,
  );
  const missingEvidence = arrayOrFinding(
    review?.missing_evidence,
    "MISSING_EVIDENCE_NOT_ARRAY",
    findings,
  );
  const requestedReady =
    review?.preparation_status === "ready_for_human_review";
  if (
    !["not_ready", "ready_for_human_review"].includes(
      review?.preparation_status,
    )
  ) {
    findings.push("PREPARATION_STATUS_INVALID");
  }
  const readinessReasons = [];
  if (scope?.status !== "approved") {
    readinessReasons.push("SCOPE_NOT_APPROVED");
  }
  if (
    typeof scope?.approval?.approved_by !== "string" ||
    scope.approval.approved_by.trim() === "" ||
    typeof scope?.approval?.approved_at !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u.test(
      scope.approval.approved_at,
    ) ||
    typeof scope?.approval?.approval_ref !== "string" ||
    scope.approval.approval_ref.trim() === "" ||
    scope?.approval?.source !== "user-provided"
  ) {
    readinessReasons.push("ATTRIBUTABLE_SCOPE_APPROVAL_MISSING");
  }
  if (typeof scope?.objective !== "string" || scope.objective.trim() === "") {
    readinessReasons.push("OBJECTIVE_MISSING");
  }
  if (!Array.isArray(scope?.in_scope) || scope.in_scope.length === 0) {
    readinessReasons.push("SCOPE_ITEMS_MISSING");
  }
  if (
    !Array.isArray(scope?.completion_criteria) ||
    scope.completion_criteria.length === 0
  ) {
    readinessReasons.push("COMPLETION_CRITERIA_MISSING");
  }
  if (approvedEvidence.length === 0) {
    readinessReasons.push("APPROVED_EVIDENCE_MISSING");
  }
  if (artifacts.length === 0) {
    readinessReasons.push("EVIDENCE_ARTIFACTS_MISSING");
  }
  if (inventory.length === 0) {
    readinessReasons.push("AUTOMATION_INVENTORY_EMPTY");
  }
  if (generatedFrom.length === 0) {
    readinessReasons.push("INVENTORY_SOURCE_LINK_MISSING");
  }
  if (inventoryHasUnlinkedItem) {
    readinessReasons.push("INVENTORY_ITEM_EVIDENCE_LINK_MISSING");
  }
  if (
    documents["sensitive-actions.json"]?.review_status !== "reviewed"
  ) {
    readinessReasons.push("SENSITIVE_ACTION_REVIEW_PENDING");
  }
  if (contradictions.length > 0) {
    readinessReasons.push("CONTRADICTIONS_DECLARED");
  }
  if (missingEvidence.length > 0) {
    readinessReasons.push("EVIDENCE_GAPS_DECLARED");
  }
  const internallyReady =
    findings.length === 0 &&
    readinessReasons.length === 0;

  if (requestedReady && !internallyReady) {
    findings.push("READINESS_CONTRADICTS_EVIDENCE");
  }

  const uniqueFindings = [...new Set(findings)].sort();
  const preparationStatus =
    requestedReady && uniqueFindings.length === 0
      ? "ready_for_human_review"
      : "not_ready";

  return {
    status: uniqueFindings.length === 0 ? "valid" : "invalid",
    preparation_status: preparationStatus,
    case_id: typeof caseId === "string" ? caseId : null,
    counts: {
      automations: inventory.length,
      sensitive_actions: actions.length,
      evidence_artifacts: artifacts.length,
    },
    readiness_reasons: [...new Set(readinessReasons)].sort(),
    findings: uniqueFindings,
  };
}
