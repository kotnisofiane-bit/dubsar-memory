import {
  asArray,
  codedDiagnostic,
  duplicateIds,
  exactKeys,
  ownValue,
  uniqueSorted,
} from "./contracts.mjs";
import {
  EVIDENCE_V2_ENTRY_KEYS,
  PROJECT_EVIDENCE_V1_FORMAT,
  PROJECT_EVIDENCE_V2_FORMAT,
  analyzeEvidenceV2,
} from "./continuity.mjs";

const EXPECTED_FORMATS = Object.freeze({
  "mission.json": "dubsar.project-mission/1",
  "lots.json": "dubsar.project-lots/1",
  "execution-contract.json": "dubsar.execution-contract/1",
  "evidence.json": PROJECT_EVIDENCE_V1_FORMAT,
});
const SAFE_ID = /^[a-z0-9][a-z0-9._-]{2,127}$/iu;

const MISSION_KEYS = [
  "acceptance_evidence",
  "constraints",
  "desired_outcome",
  "excluded",
  "format",
  "in_scope",
  "known_inputs",
  "mission_id",
  "open_decisions",
  "purpose",
  "risks",
  "status",
  "stop_conditions",
  "title",
];
const LOTS_KEYS = ["format", "lots", "mission_id"];
const LOT_KEYS = [
  "depends_on",
  "excluded",
  "expected_evidence",
  "in_scope",
  "lot_id",
  "status",
  "stop_conditions",
  "title",
  "validation",
];
const CONTRACT_KEYS = [
  "allowed_actions",
  "contract_id",
  "forbidden_actions",
  "format",
  "lot_id",
  "mission_id",
  "protected_areas",
  "recovery_expectations",
  "required_evidence",
  "status",
  "stop_conditions",
  "targets",
  "validation",
];
const EVIDENCE_KEYS = ["entries", "format", "mission_id"];
const EVIDENCE_ENTRY_KEYS = [
  "artifact_refs",
  "claim",
  "class",
  "evidence_id",
  "limitations",
  "lot_id",
  "validation",
];

function hasDependencyCycle(lots) {
  const byId = new Map(
    lots
      .filter((lot) => typeof lot?.lot_id === "string")
      .map((lot) => [lot.lot_id, lot]),
  );
  const indegree = new Map([...byId.keys()].map((id) => [id, 0]));
  const dependents = new Map([...byId.keys()].map((id) => [id, []]));
  for (const lot of byId.values()) {
    const dependencies = Array.isArray(lot.depends_on) ? lot.depends_on : [];
    for (const dependency of new Set(dependencies)) {
      if (byId.has(dependency)) {
        indegree.set(lot.lot_id, indegree.get(lot.lot_id) + 1);
        dependents.get(dependency).push(lot.lot_id);
      }
    }
  }
  const queue = [...indegree.entries()]
    .filter(([, count]) => count === 0)
    .map(([id]) => id);
  let visited = 0;
  while (queue.length > 0) {
    const id = queue.pop();
    visited += 1;
    for (const dependent of dependents.get(id)) {
      const next = indegree.get(dependent) - 1;
      indegree.set(dependent, next);
      if (next === 0) {
        queue.push(dependent);
      }
    }
  }
  return visited !== byId.size;
}

function nextAction(
  mission,
  lots,
  contract,
  integrityValid,
  acceptanceReady,
  readinessReasons,
) {
  if (!integrityValid) {
    return {
      code: "resolve_integrity_findings",
      label: "Resolve the listed local record contradictions with a human.",
    };
  }
  if (mission.status === "draft") {
    return {
      code: "approve_mission",
      label: "Review and approve the project mission.",
    };
  }
  if (
    readinessReasons.some((reason) =>
      new Set([
        "MISSION_TITLE_MISSING",
        "MISSION_DESIRED_OUTCOME_MISSING",
        "MISSION_PURPOSE_MISSING",
        "MISSION_SCOPE_EMPTY",
      ]).has(reason),
    )
  ) {
    return {
      code: "complete_mission_definition",
      label: "Complete the essential mission definition before preparing work.",
    };
  }
  if (lots.length === 0) {
    return {
      code: "decompose_lots",
      label: "Decompose the approved mission into verifiable lots.",
    };
  }
  if (readinessReasons.includes("LEGACY_EVIDENCE_REQUIRES_MIGRATION")) {
    return {
      code: "migrate_project_evidence",
      label: "Create a reviewed evidence/2 checkpoint before relying on project readiness.",
    };
  }
  if (lots.every((lot) => lot.status === "complete")) {
    return acceptanceReady
      ? {
          code: "review_mission_acceptance",
          label: "Review the supported mission acceptance evidence.",
        }
      : {
          code: "record_acceptance_evidence",
          label: "Record supported evidence for mission acceptance.",
        };
  }
  const candidate = lots.find((lot) => lot.status === "candidate");
  if (!candidate) {
    return {
      code: "select_candidate_lot",
      label: "Choose an eligible work package.",
    };
  }
  if (contract.lot_id !== candidate.lot_id) {
    return {
      code: "draft_execution_contract",
      label: "Draft an execution contract for the candidate lot.",
    };
  }
  if (contract.status !== "approved") {
    return {
      code: "approve_execution_contract",
      label: "Review and approve the candidate lot execution contract.",
    };
  }
  if (readinessReasons.length > 0) {
    return {
      code: "resolve_readiness_blockers",
      label: "Resolve the listed readiness blockers before preparing work.",
    };
  }
  return {
    code: "prepare_approved_lot",
    label: "Prepare the approved lot within its recorded contract.",
  };
}

export function evaluateProjectSnapshot(snapshot) {
  const findings = [];
  const documents = snapshot.documents;
  for (const [file, expected] of Object.entries(EXPECTED_FORMATS)) {
    const observed = ownValue(documents, file)?.format;
    if (
      file === "evidence.json"
        ? !new Set([PROJECT_EVIDENCE_V1_FORMAT, PROJECT_EVIDENCE_V2_FORMAT]).has(observed)
        : observed !== expected
    ) {
      findings.push(`FORMAT_MISMATCH:${file}`);
    }
  }

  const mission = documents["mission.json"] ?? {};
  const lotsDocument = documents["lots.json"] ?? {};
  const contract = documents["execution-contract.json"] ?? {};
  const evidenceDocument = documents["evidence.json"] ?? {};
  const evidenceV2 = evidenceDocument.format === PROJECT_EVIDENCE_V2_FORMAT;
  if (!exactKeys(mission, MISSION_KEYS)) {
    findings.push("MISSION_KEYS_INVALID");
  }
  if (!exactKeys(lotsDocument, LOTS_KEYS)) {
    findings.push("LOTS_KEYS_INVALID");
  }
  if (!exactKeys(contract, CONTRACT_KEYS)) {
    findings.push("CONTRACT_KEYS_INVALID");
  }
  if (!exactKeys(evidenceDocument, EVIDENCE_KEYS)) {
    findings.push("EVIDENCE_KEYS_INVALID");
  }

  const missionId = mission.mission_id;
  if (typeof missionId !== "string" || !SAFE_ID.test(missionId)) {
    findings.push("MISSION_ID_INVALID");
  }
  for (const file of Object.keys(EXPECTED_FORMATS).slice(1)) {
    if (ownValue(documents, file)?.mission_id !== missionId) {
      findings.push(`MISSION_ID_MISMATCH:${file}`);
    }
  }

  const lots = asArray(lotsDocument.lots, "LOTS_NOT_ARRAY", findings);
  const evidence = asArray(
    evidenceDocument.entries,
    "EVIDENCE_NOT_ARRAY",
    findings,
  );
  for (const lot of lots) {
    if (!exactKeys(lot, LOT_KEYS)) {
      findings.push("LOT_KEYS_INVALID");
    }
  }
  for (const entry of evidence) {
    if (!exactKeys(entry, evidenceV2 ? EVIDENCE_V2_ENTRY_KEYS : EVIDENCE_ENTRY_KEYS)) {
      findings.push("EVIDENCE_ENTRY_KEYS_INVALID");
    }
  }
  if (!new Set(["approved", "complete", "draft"]).has(mission.status)) {
    findings.push("MISSION_STATUS_INVALID");
  }
  asArray(mission.stop_conditions, "MISSION_STOP_CONDITIONS_NOT_ARRAY", findings);
  const missionInScope = asArray(
    mission.in_scope,
    "MISSION_IN_SCOPE_NOT_ARRAY",
    findings,
  );
  for (const [field, code] of [
    ["constraints", "MISSION_CONSTRAINTS_NOT_ARRAY"],
    ["excluded", "MISSION_EXCLUDED_NOT_ARRAY"],
    ["known_inputs", "MISSION_KNOWN_INPUTS_NOT_ARRAY"],
    ["open_decisions", "MISSION_OPEN_DECISIONS_NOT_ARRAY"],
    ["risks", "MISSION_RISKS_NOT_ARRAY"],
  ]) {
    asArray(ownValue(mission, field), code, findings);
  }
  const acceptanceEvidence = asArray(
    mission.acceptance_evidence,
    "MISSION_ACCEPTANCE_EVIDENCE_NOT_ARRAY",
    findings,
  );

  if (duplicateIds(lots, "lot_id").size > 0) {
    findings.push("DUPLICATE_LOT_ID");
  }
  if (duplicateIds(evidence, "evidence_id").size > 0) {
    findings.push("DUPLICATE_EVIDENCE_ID");
  }
  if (lots.filter((lot) => lot?.status === "candidate").length > 1) {
    findings.push("MULTIPLE_CANDIDATE_LOTS");
  }
  if (lots.some((lot) => typeof lot?.lot_id !== "string" || !SAFE_ID.test(lot.lot_id))) {
    findings.push("LOT_ID_INVALID");
  }
  if (
    evidence.some(
      (item) =>
        typeof item?.evidence_id !== "string" ||
        !SAFE_ID.test(item.evidence_id),
    )
  ) {
    findings.push("EVIDENCE_ID_INVALID");
  }
  if (hasDependencyCycle(lots)) {
    findings.push("LOT_DEPENDENCY_CYCLE");
  }
  if (mission.status === "complete" && lots.length === 0) {
    findings.push("MISSION_COMPLETE_WITHOUT_LOTS");
  }
  if (
    mission.status === "complete" &&
    lots.some((lot) => lot?.status !== "complete")
  ) {
    findings.push("MISSION_COMPLETE_WITH_INCOMPLETE_LOTS");
  }

  const lotIds = new Set(lots.map((lot) => lot?.lot_id));
  const evidenceIds = new Set(evidence.map((item) => item?.evidence_id));
  const continuity = evidenceV2
    ? analyzeEvidenceV2(evidenceDocument, snapshot.artifacts ?? [], lotIds, findings)
    : Object.freeze({ records: [], decisions: [], open_blockers: [], freshness: null });
  const v2ById = new Map(continuity.records.map((item) => [item.evidence_id, item]));
  const evidenceClasses = new Map(evidence.map((item) => [item?.evidence_id, item?.class]));
  const evidenceSupport = new Map(evidence.map((item) => [
    item?.evidence_id,
    evidenceV2
      ? v2ById.get(item?.evidence_id)?.supported === true
      : false,
  ]));
  const lotById = new Map(lots.map((lot) => [lot?.lot_id, lot]));
  for (const lot of lots) {
    if (!new Set(["candidate", "complete", "planned"]).has(lot?.status)) {
      findings.push("LOT_STATUS_INVALID");
    }
    for (const dependency of asArray(
      lot?.depends_on,
      "LOT_DEPENDENCIES_NOT_ARRAY",
      findings,
    )) {
      if (!lotIds.has(dependency) || dependency === lot?.lot_id) {
        findings.push("LOT_DEPENDENCY_INVALID");
      }
      if (
        new Set(["candidate", "complete"]).has(lot?.status) &&
        lotById.get(dependency)?.status !== "complete"
      ) {
        findings.push("LOT_DEPENDENCY_NOT_COMPLETE");
      }
    }
    if (lot?.status === "complete") {
      const expectedEvidence = asArray(
        lot?.expected_evidence,
        "LOT_EXPECTED_EVIDENCE_NOT_ARRAY",
        findings,
      );
      if (expectedEvidence.length === 0) {
        findings.push("COMPLETE_LOT_HAS_NO_EXPECTED_EVIDENCE");
      }
      for (const expected of expectedEvidence) {
        if (
          !evidenceIds.has(expected) ||
          !new Set(["derived", "observed"]).has(evidenceClasses.get(expected)) ||
          evidenceSupport.get(expected) !== true
        ) {
          findings.push("COMPLETE_LOT_EVIDENCE_MISSING");
        }
      }
    }
  }

  for (const entry of evidenceV2 ? [] : evidence) {
    if (!lotIds.has(entry?.lot_id)) {
      findings.push("EVIDENCE_LOT_REFERENCE_MISSING");
    }
    if (!new Set(["derived", "observed", "reported", "unverified"]).has(entry?.class)) {
      findings.push("EVIDENCE_CLASS_INVALID");
    }
    if (typeof entry?.claim !== "string" || entry.claim.trim() === "") {
      findings.push("EVIDENCE_CLAIM_MISSING");
    }
    const artifactRefs = asArray(
      entry?.artifact_refs,
      "EVIDENCE_ARTIFACT_REFS_NOT_ARRAY",
      findings,
    );
    const validation = asArray(
      entry?.validation,
      "EVIDENCE_VALIDATION_NOT_ARRAY",
      findings,
    );
    asArray(entry?.limitations, "EVIDENCE_LIMITATIONS_NOT_ARRAY", findings);
    if (
      new Set(["derived", "observed"]).has(entry?.class) &&
      (artifactRefs.length === 0 || validation.length === 0)
    ) {
      findings.push("EVIDENCE_SUPPORT_MISSING");
    }
  }
  if (mission.status === "complete" || lots.every((lot) => lot?.status === "complete")) {
    for (const evidenceId of acceptanceEvidence) {
      if (!evidenceIds.has(evidenceId)) {
        findings.push("MISSION_ACCEPTANCE_EVIDENCE_REFERENCE_MISSING");
      }
    }
  }

  const contractHasLot =
    typeof contract.lot_id === "string" && contract.lot_id.length > 0;
  if (!new Set(["approved", "closed", "draft"]).has(contract.status)) {
    findings.push("CONTRACT_STATUS_INVALID");
  }
  for (const [field, code] of [
    ["protected_areas", "CONTRACT_PROTECTED_AREAS_NOT_ARRAY"],
    ["stop_conditions", "CONTRACT_STOP_CONDITIONS_NOT_ARRAY"],
    ["allowed_actions", "CONTRACT_ALLOWED_ACTIONS_NOT_ARRAY"],
    ["forbidden_actions", "CONTRACT_FORBIDDEN_ACTIONS_NOT_ARRAY"],
    ["validation", "CONTRACT_VALIDATION_NOT_ARRAY"],
    ["required_evidence", "CONTRACT_REQUIRED_EVIDENCE_NOT_ARRAY"],
  ]) {
    asArray(ownValue(contract, field), code, findings);
  }
  if (contractHasLot && !lotIds.has(contract.lot_id)) {
    findings.push("CONTRACT_LOT_REFERENCE_MISSING");
  }
  if (
    contractHasLot &&
    (typeof contract.contract_id !== "string" || !SAFE_ID.test(contract.contract_id))
  ) {
    findings.push("CONTRACT_ID_INVALID");
  }
  if (!contractHasLot && (contract.contract_id !== null || contract.status !== "draft")) {
    findings.push("ORPHAN_CONTRACT_STATE");
  }
  if (
    contract.status === "approved" &&
    !lots.some(
      (lot) =>
        lot?.lot_id === contract.lot_id &&
        new Set(["candidate", "complete"]).has(lot.status),
    )
  ) {
    findings.push("APPROVED_CONTRACT_WITHOUT_CANDIDATE");
  }

  const uniqueFindings = uniqueSorted(findings);
  const integrityValid = uniqueFindings.length === 0;
  const acceptanceReady =
    acceptanceEvidence.length > 0 &&
    acceptanceEvidence.every(
      (id) =>
        evidenceSupport.get(id) === true &&
        new Set(["derived", "observed"]).has(evidenceClasses.get(id)),
    );
  const readinessReasons = [];
  if (!integrityValid) {
    readinessReasons.push("INTEGRITY_INVALID");
  } else if (mission.status === "draft") {
    readinessReasons.push("MISSION_NOT_APPROVED");
  } else if (typeof mission.title !== "string" || mission.title.trim() === "") {
    readinessReasons.push("MISSION_TITLE_MISSING");
  } else if (
    typeof mission.desired_outcome !== "string" ||
    mission.desired_outcome.trim() === ""
  ) {
    readinessReasons.push("MISSION_DESIRED_OUTCOME_MISSING");
  } else if (typeof mission.purpose !== "string" || mission.purpose.trim() === "") {
    readinessReasons.push("MISSION_PURPOSE_MISSING");
  } else if (missionInScope.length === 0) {
    readinessReasons.push("MISSION_SCOPE_EMPTY");
  } else if (lots.length === 0) {
    readinessReasons.push("LOTS_EMPTY");
  } else if (!evidenceV2) {
    readinessReasons.push("LEGACY_EVIDENCE_REQUIRES_MIGRATION");
  } else if (lots.every((lot) => lot.status === "complete")) {
    if (!acceptanceReady) {
      readinessReasons.push("MISSION_ACCEPTANCE_EVIDENCE_INCOMPLETE");
    }
  } else {
    const candidate = lots.find((lot) => lot.status === "candidate");
    if (!candidate) {
      readinessReasons.push("CANDIDATE_LOT_MISSING");
    } else if (contract.lot_id !== candidate.lot_id) {
      readinessReasons.push("EXECUTION_CONTRACT_MISSING");
    } else if (contract.status !== "approved") {
      readinessReasons.push("EXECUTION_CONTRACT_NOT_APPROVED");
    }
  }
  const uniqueReasons = uniqueSorted(readinessReasons);
  const readinessStatus = !integrityValid
    ? "unknown"
    : uniqueReasons.length === 0
      ? "ready"
      : "not_ready";

  return Object.freeze({
    domain: "project",
    id: typeof missionId === "string" && SAFE_ID.test(missionId) ? missionId : null,
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
      lots: lots.length,
      complete_lots: lots.filter((lot) => lot?.status === "complete").length,
      evidence_entries: evidence.length,
    }),
    continuity,
    next_action: Object.freeze(
      nextAction(
        mission,
        lots,
        contract,
        integrityValid,
        acceptanceReady,
        uniqueReasons,
      ),
    ),
  });
}
