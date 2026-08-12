import {
  asArray,
  codedDiagnostic,
  duplicateIds,
  exactKeys,
  ownValue,
  uniqueSorted,
} from "./contracts.mjs";

const EXPECTED_FORMATS = Object.freeze({
  "audit-scope.json": "dubsar.audit-scope/1",
  "automation-inventory.json": "dubsar.automation-inventory/1",
  "sensitive-actions.json": "dubsar.sensitive-actions/1",
  "evidence-index.json": "dubsar.evidence-index/1",
  "evidence-review.json": "dubsar.evidence-review/1",
});
const SAFE_ID = /^[a-z0-9][a-z0-9._-]{2,127}$/iu;
const SCOPE_KEYS = [
  "approval",
  "approved_evidence",
  "case_id",
  "completion_criteria",
  "excluded",
  "format",
  "in_scope",
  "limitations",
  "objective",
  "status",
  "time_window",
];
const INVENTORY_KEYS = ["case_id", "format", "gaps", "generated_from", "items"];
const ACTIONS_KEYS = ["actions", "case_id", "format", "review_status"];
const INDEX_KEYS = ["artifacts", "case_id", "format"];
const REVIEW_KEYS = [
  "case_id",
  "contradictions",
  "format",
  "limitations",
  "missing_evidence",
  "preparation_status",
  "reported_statements",
  "supported_observations",
];

function nextAction(integrityValid, readinessReasons, review) {
  if (!integrityValid) {
    return {
      code: "resolve_integrity_findings",
      label: "Resolve the listed local audit-record contradictions.",
    };
  }
  const mapping = [
    ["SCOPE_NOT_APPROVED", "approve_audit_scope", "Review and approve the bounded audit scope."],
    ["ATTRIBUTABLE_SCOPE_APPROVAL_MISSING", "record_scope_approval", "Record an attributable human scope approval."],
    ["APPROVED_EVIDENCE_MISSING", "approve_evidence", "Select the local evidence approved for this preparation."],
    ["AUTOMATION_INVENTORY_EMPTY", "inventory_automations", "Build the evidence-linked automation inventory."],
    ["SENSITIVE_ACTION_REVIEW_PENDING", "review_sensitive_actions", "Review the mapped sensitive actions."],
    ["CONTRADICTIONS_DECLARED", "resolve_contradictions", "Resolve or explicitly bound the declared contradictions."],
    ["EVIDENCE_GAPS_DECLARED", "resolve_evidence_gaps", "Resolve or explicitly accept the declared evidence gaps."],
  ];
  for (const [reason, code, label] of mapping) {
    if (readinessReasons.includes(reason)) {
      return { code, label };
    }
  }
  if (review.preparation_status !== "ready_for_human_review") {
    return {
      code: "request_human_review",
      label: "Set preparation status only after the bounded evidence is ready for human review.",
    };
  }
  return {
    code: "perform_human_review",
    label: "Perform the human review; this preparation is not an audit result.",
  };
}

export function evaluateAuditSnapshot(snapshot) {
  const findings = [];
  const documents = snapshot.documents;
  for (const [file, expected] of Object.entries(EXPECTED_FORMATS)) {
    if (ownValue(documents, file)?.format !== expected) {
      findings.push(`FORMAT_MISMATCH:${file}`);
    }
  }

  const scope = documents["audit-scope.json"] ?? {};
  const inventoryDocument = documents["automation-inventory.json"] ?? {};
  const actionsDocument = documents["sensitive-actions.json"] ?? {};
  const indexDocument = documents["evidence-index.json"] ?? {};
  const review = documents["evidence-review.json"] ?? {};
  for (const [document, keys, code] of [
    [scope, SCOPE_KEYS, "SCOPE_KEYS_INVALID"],
    [inventoryDocument, INVENTORY_KEYS, "INVENTORY_KEYS_INVALID"],
    [actionsDocument, ACTIONS_KEYS, "SENSITIVE_ACTIONS_KEYS_INVALID"],
    [indexDocument, INDEX_KEYS, "EVIDENCE_INDEX_KEYS_INVALID"],
    [review, REVIEW_KEYS, "EVIDENCE_REVIEW_KEYS_INVALID"],
  ]) {
    if (!exactKeys(document, keys)) {
      findings.push(code);
    }
  }

  const caseId = scope.case_id;
  if (typeof caseId !== "string" || !SAFE_ID.test(caseId)) {
    findings.push("CASE_ID_INVALID");
  }
  for (const file of Object.keys(EXPECTED_FORMATS).slice(1)) {
    if (ownValue(documents, file)?.case_id !== caseId) {
      findings.push(`CASE_ID_MISMATCH:${file}`);
    }
  }

  const inventory = asArray(inventoryDocument.items, "INVENTORY_ITEMS_NOT_ARRAY", findings);
  const actions = asArray(actionsDocument.actions, "SENSITIVE_ACTIONS_NOT_ARRAY", findings);
  const artifacts = asArray(indexDocument.artifacts, "EVIDENCE_ARTIFACTS_NOT_ARRAY", findings);
  if (duplicateIds(inventory, "id").size > 0) {
    findings.push("DUPLICATE_INVENTORY_ID");
  }
  if (duplicateIds(actions, "id").size > 0) {
    findings.push("DUPLICATE_ACTION_ID");
  }
  if (duplicateIds(artifacts, "artifact_id").size > 0) {
    findings.push("DUPLICATE_ARTIFACT_ID");
  }
  if (inventory.some((item) => typeof item?.id !== "string" || !SAFE_ID.test(item.id))) {
    findings.push("INVENTORY_ID_INVALID");
  }
  if (actions.some((item) => typeof item?.id !== "string" || !SAFE_ID.test(item.id))) {
    findings.push("ACTION_ID_INVALID");
  }

  const inventoryIds = new Set(inventory.map((item) => item?.id));
  const artifactIds = new Set(artifacts.map((item) => item?.artifact_id));
  const generatedFrom = asArray(
    inventoryDocument.generated_from,
    "INVENTORY_GENERATED_FROM_NOT_ARRAY",
    findings,
  );
  const approvedEvidence = asArray(
    scope.approved_evidence,
    "APPROVED_EVIDENCE_NOT_ARRAY",
    findings,
  );
  let inventoryHasUnlinkedItem = false;
  for (const action of actions) {
    if (!inventoryIds.has(action?.automation_id)) {
      findings.push("ACTION_AUTOMATION_REFERENCE_MISSING");
    }
    for (const reference of asArray(
      action?.evidence_refs,
      "ACTION_EVIDENCE_REFS_NOT_ARRAY",
      findings,
    )) {
      if (!artifactIds.has(reference)) {
        findings.push("ACTION_EVIDENCE_REFERENCE_MISSING");
      }
    }
  }
  for (const reference of generatedFrom) {
    if (!artifactIds.has(reference)) {
      findings.push("INVENTORY_SOURCE_REFERENCE_MISSING");
    }
  }
  for (const item of inventory) {
    const references = asArray(
      item?.evidence_refs,
      "INVENTORY_EVIDENCE_REFS_NOT_ARRAY",
      findings,
    );
    if (references.length === 0) {
      inventoryHasUnlinkedItem = true;
    }
    for (const reference of references) {
      if (!artifactIds.has(reference)) {
        findings.push("INVENTORY_EVIDENCE_REFERENCE_MISSING");
      }
    }
  }
  for (const reference of approvedEvidence) {
    if (!artifactIds.has(reference)) {
      findings.push("APPROVED_EVIDENCE_REFERENCE_MISSING");
    }
  }
  const approvedSet = new Set(approvedEvidence);
  for (const artifactId of artifactIds) {
    if (!approvedSet.has(artifactId)) {
      findings.push("ARTIFACT_NOT_APPROVED");
    }
  }

  const capturedByPath = new Map(
    snapshot.artifacts.map((artifact) => [artifact.path, artifact]),
  );
  for (const artifact of artifacts) {
    if (
      typeof artifact?.artifact_id !== "string" ||
      !SAFE_ID.test(artifact.artifact_id) ||
      typeof artifact?.path !== "string" ||
      typeof artifact?.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(artifact.sha256)
    ) {
      findings.push("ARTIFACT_METADATA_INVALID");
      continue;
    }
    const captured = capturedByPath.get(artifact.path.replaceAll("\\", "/"));
    if (!captured) {
      findings.push("ARTIFACT_CAPTURE_MISSING");
      continue;
    }
    if (captured.sha256 !== artifact.sha256) {
      findings.push("ARTIFACT_DIGEST_MISMATCH");
    }
    if (captured.policy_finding) {
      findings.push(captured.policy_finding);
    }
  }

  const supportedObservations = asArray(
    review.supported_observations,
    "SUPPORTED_OBSERVATIONS_NOT_ARRAY",
    findings,
  );
  for (const observation of supportedObservations) {
    if (typeof observation?.statement !== "string" || observation.statement.trim() === "") {
      findings.push("SUPPORTED_OBSERVATION_STATEMENT_INVALID");
    }
    const references = asArray(
      observation?.evidence_refs,
      "SUPPORTED_OBSERVATION_EVIDENCE_REFS_NOT_ARRAY",
      findings,
    );
    if (references.length === 0) {
      findings.push("SUPPORTED_OBSERVATION_EVIDENCE_LINK_MISSING");
    }
    for (const reference of references) {
      if (!artifactIds.has(reference)) {
        findings.push("SUPPORTED_OBSERVATION_EVIDENCE_REFERENCE_MISSING");
      }
    }
  }
  const contradictions = asArray(review.contradictions, "CONTRADICTIONS_NOT_ARRAY", findings);
  const missingEvidence = asArray(review.missing_evidence, "MISSING_EVIDENCE_NOT_ARRAY", findings);
  if (!new Set(["not_ready", "ready_for_human_review"]).has(review.preparation_status)) {
    findings.push("PREPARATION_STATUS_INVALID");
  }

  const readinessReasons = [];
  if (scope.status !== "approved") {
    readinessReasons.push("SCOPE_NOT_APPROVED");
  }
  if (
    typeof scope?.approval?.approved_by !== "string" ||
    scope.approval.approved_by.trim() === "" ||
    typeof scope?.approval?.approved_at !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u.test(scope.approval.approved_at) ||
    typeof scope?.approval?.approval_ref !== "string" ||
    scope.approval.approval_ref.trim() === "" ||
    scope.approval.source !== "user-provided"
  ) {
    readinessReasons.push("ATTRIBUTABLE_SCOPE_APPROVAL_MISSING");
  }
  if (typeof scope.objective !== "string" || scope.objective.trim() === "") {
    readinessReasons.push("OBJECTIVE_MISSING");
  }
  if (!Array.isArray(scope.in_scope) || scope.in_scope.length === 0) {
    readinessReasons.push("SCOPE_ITEMS_MISSING");
  }
  if (!Array.isArray(scope.completion_criteria) || scope.completion_criteria.length === 0) {
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
  if (actionsDocument.review_status !== "reviewed") {
    readinessReasons.push("SENSITIVE_ACTION_REVIEW_PENDING");
  }
  if (contradictions.length > 0) {
    readinessReasons.push("CONTRADICTIONS_DECLARED");
  }
  if (missingEvidence.length > 0) {
    readinessReasons.push("EVIDENCE_GAPS_DECLARED");
  }

  const requestedReady = review.preparation_status === "ready_for_human_review";
  if (requestedReady && (findings.length > 0 || readinessReasons.length > 0)) {
    findings.push("READINESS_CONTRADICTS_EVIDENCE");
  }
  const uniqueFindings = uniqueSorted(findings);
  const integrityValid = uniqueFindings.length === 0;
  if (!integrityValid) {
    readinessReasons.push("INTEGRITY_INVALID");
  }
  const uniqueReasons = uniqueSorted(readinessReasons);
  const readinessStatus = !integrityValid
    ? "unknown"
    : requestedReady && uniqueReasons.length === 0
      ? "ready"
      : "not_ready";

  return Object.freeze({
    domain: "audit",
    id: typeof caseId === "string" && SAFE_ID.test(caseId) ? caseId : null,
    integrity: Object.freeze({
      status: integrityValid ? "valid" : "invalid",
      diagnostics: Object.freeze(
        uniqueFindings.map((code) => codedDiagnostic(code)),
      ),
    }),
    readiness: Object.freeze({
      status: readinessStatus,
      reasons: Object.freeze(uniqueReasons),
    }),
    counts: Object.freeze({
      automations: inventory.length,
      sensitive_actions: actions.length,
      evidence_artifacts: artifacts.length,
    }),
    next_action: Object.freeze(
      nextAction(integrityValid, uniqueReasons, review),
    ),
  });
}
