import { PublicPluginError, readJson } from "./safe-io.mjs";

export const REQUIRED_FILES = Object.freeze([
  "mission.json",
  "lots.json",
  "execution-contract.json",
  "evidence.json",
]);

const EXPECTED_FORMATS = Object.freeze({
  "mission.json": "dubsar.project-mission/1",
  "lots.json": "dubsar.project-lots/1",
  "execution-contract.json": "dubsar.execution-contract/1",
});
const EVIDENCE_V1 = "dubsar.project-evidence/1";
const EVIDENCE_V2 = "dubsar.project-evidence/2";
const SHA256 = /^[0-9a-f]{64}$/u;

function asArray(value, code, findings) {
  if (!Array.isArray(value)) {
    findings.push(code);
    return [];
  }
  return value;
}

function hasDuplicateIds(items, field) {
  const values = items.map((item) => item?.[field]).filter(
    (value) => typeof value === "string" && value.length > 0,
  );
  return values.length !== new Set(values).size;
}

function hasDependencyCycle(lots) {
  const dependencies = new Map(lots.map((lot) => [
    lot?.lot_id,
    Array.isArray(lot?.depends_on) ? lot.depends_on : [],
  ]));
  const visiting = new Set();
  const visited = new Set();
  function visit(id) {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    for (const dependency of dependencies.get(id) ?? []) {
      if (dependencies.has(dependency) && visit(dependency)) return true;
    }
    visiting.delete(id);
    visited.add(id);
    return false;
  }
  return [...dependencies.keys()].some(visit);
}

function supportedV2Evidence(entry) {
  return (
    ["observed", "derived"].includes(entry?.class) &&
    Array.isArray(entry?.validation) && entry.validation.length > 0 &&
    Array.isArray(entry?.artifact_refs) && entry.artifact_refs.length > 0 &&
    entry.artifact_refs.every((reference) =>
      reference && typeof reference.path === "string" && reference.path.length > 0 &&
      Number.isSafeInteger(reference.byte_length) && reference.byte_length >= 0 &&
      SHA256.test(reference.sha256 ?? ""))
  );
}

function nextPreparationStep(mission, lots, contract, evidenceFormat) {
  if (evidenceFormat === EVIDENCE_V1) {
    return "Create a reviewed evidence/2 checkpoint before relying on project readiness.";
  }
  if (mission.status === "draft") return "Review and approve the project mission.";
  const incomplete = lots.filter((lot) => lot.status !== "complete");
  if (incomplete.length === 0) {
    return lots.length === 0
      ? "Decompose the approved mission into verifiable work packages."
      : "Review mission acceptance evidence.";
  }
  const candidate = incomplete.find((lot) => lot.status === "candidate");
  if (!candidate) return "Choose an eligible work package.";
  if (contract.lot_id !== candidate.lot_id) {
    return `Draft an execution contract for lot ${candidate.lot_id}.`;
  }
  if (contract.status === "draft") {
    return `Review the execution contract for lot ${candidate.lot_id}.`;
  }
  return `Prepare the approved lot ${candidate.lot_id}; no execution is started by this plugin.`;
}

export async function loadProjectWorkspace(root) {
  const documents = {};
  for (const file of REQUIRED_FILES) documents[file] = await readJson(root, file);
  return documents;
}

export async function validateProjectWorkspace(root) {
  const findings = [];
  let documents;
  try {
    documents = await loadProjectWorkspace(root);
  } catch (error) {
    const code = error instanceof PublicPluginError ? error.code : "WORKSPACE_VALIDATION_FAILED";
    return {
      status: "invalid",
      continuity_status: "continuity_blocked",
      findings: [code],
    };
  }

  for (const [file, expected] of Object.entries(EXPECTED_FORMATS)) {
    if (documents[file]?.format !== expected) findings.push(`FORMAT_MISMATCH:${file}`);
  }
  const evidenceFormat = documents["evidence.json"]?.format;
  if (![EVIDENCE_V1, EVIDENCE_V2].includes(evidenceFormat)) {
    findings.push("FORMAT_MISMATCH:evidence.json");
  }
  const mission = documents["mission.json"];
  const missionId = mission?.mission_id;
  if (typeof missionId !== "string" || missionId.length === 0) findings.push("MISSION_ID_MISSING");
  for (const file of REQUIRED_FILES.slice(1)) {
    if (documents[file]?.mission_id !== missionId) findings.push(`MISSION_ID_MISMATCH:${file}`);
  }

  const lots = asArray(documents["lots.json"]?.lots, "LOTS_NOT_ARRAY", findings);
  const evidence = asArray(documents["evidence.json"]?.entries, "EVIDENCE_NOT_ARRAY", findings);
  const contract = documents["execution-contract.json"];
  if (!new Set(["draft", "approved", "complete"]).has(mission?.status)) {
    findings.push("MISSION_STATUS_INVALID");
  }
  asArray(mission?.stop_conditions, "MISSION_STOP_CONDITIONS_NOT_ARRAY", findings);
  if (hasDuplicateIds(lots, "lot_id")) findings.push("DUPLICATE_LOT_ID");
  if (hasDuplicateIds(evidence, "evidence_id")) findings.push("DUPLICATE_EVIDENCE_ID");
  if (lots.filter((lot) => lot?.status === "candidate").length > 1) {
    findings.push("MULTIPLE_CANDIDATE_LOTS");
  }
  if (hasDependencyCycle(lots)) findings.push("LOT_DEPENDENCY_CYCLE");

  const lotIds = new Set(lots.map((lot) => lot?.lot_id));
  const evidenceById = new Map(evidence.map((entry) => [entry?.evidence_id, entry]));
  const lotById = new Map(lots.map((lot) => [lot?.lot_id, lot]));
  for (const lot of lots) {
    if (typeof lot?.lot_id !== "string" || lot.lot_id.length === 0) findings.push("LOT_ID_MISSING");
    if (!new Set(["planned", "candidate", "complete"]).has(lot?.status)) {
      findings.push("LOT_STATUS_INVALID");
    }
    for (const dependency of asArray(lot?.depends_on, "LOT_DEPENDENCIES_NOT_ARRAY", findings)) {
      if (!lotIds.has(dependency) || dependency === lot?.lot_id) findings.push("LOT_DEPENDENCY_INVALID");
      if (["candidate", "complete"].includes(lot?.status) && lotById.get(dependency)?.status !== "complete") {
        findings.push("LOT_DEPENDENCY_NOT_COMPLETE");
      }
    }
    if (lot?.status === "complete") {
      const expected = asArray(lot?.expected_evidence, "LOT_EXPECTED_EVIDENCE_NOT_ARRAY", findings);
      if (expected.length === 0) findings.push("COMPLETE_LOT_HAS_NO_EXPECTED_EVIDENCE");
      if (evidenceFormat !== EVIDENCE_V2 || expected.some((id) => !supportedV2Evidence(evidenceById.get(id)))) {
        findings.push("COMPLETE_LOT_EVIDENCE_MISSING");
      }
    }
  }

  for (const entry of evidence) {
    if (!lotIds.has(entry?.lot_id)) findings.push("EVIDENCE_LOT_REFERENCE_MISSING");
    if (typeof entry?.evidence_id !== "string" || entry.evidence_id.length === 0) {
      findings.push("EVIDENCE_ID_MISSING");
    }
    if (evidenceFormat === EVIDENCE_V1) {
      if (!new Set(["observed", "reported", "derived", "unverified"]).has(entry?.class)) {
        findings.push("EVIDENCE_CLASS_INVALID");
      }
      if (typeof entry?.claim !== "string" || entry.claim.trim() === "") {
        findings.push("EVIDENCE_CLAIM_MISSING");
      }
      if (
        ["observed", "derived"].includes(entry?.class) &&
        (!Array.isArray(entry?.artifact_refs) || entry.artifact_refs.length === 0 ||
          !Array.isArray(entry?.validation) || entry.validation.length === 0)
      ) findings.push("EVIDENCE_SUPPORT_MISSING");
    } else if (evidenceFormat === EVIDENCE_V2) {
      if (!new Set(["fact", "decision", "blocker", "legacy"]).has(entry?.kind)) {
        findings.push("EVIDENCE_KIND_INVALID");
      }
      if (typeof entry?.statement !== "string" || entry.statement.trim() === "") {
        findings.push("EVIDENCE_STATEMENT_MISSING");
      }
      if (["observed", "derived"].includes(entry?.class) && !supportedV2Evidence(entry)) {
        findings.push("EVIDENCE_SUPPORT_MISSING");
      }
    }
  }

  if (!new Set(["draft", "approved", "closed"]).has(contract?.status)) {
    findings.push("CONTRACT_STATUS_INVALID");
  }
  const contractHasLot = typeof contract?.lot_id === "string" && contract.lot_id.length > 0;
  if (contractHasLot && !lotIds.has(contract.lot_id)) findings.push("CONTRACT_LOT_REFERENCE_MISSING");
  if (!contractHasLot && (contract?.contract_id !== null || contract?.status !== "draft")) {
    findings.push("ORPHAN_CONTRACT_STATE");
  }
  if (
    contract?.status === "approved" &&
    !lots.some((lot) => lot?.lot_id === contract.lot_id && ["candidate", "complete"].includes(lot.status))
  ) findings.push("APPROVED_CONTRACT_WITHOUT_CANDIDATE");

  const uniqueFindings = [...new Set(findings)].sort();
  const structurallyValid = uniqueFindings.length === 0;
  const readiness = !structurallyValid
    ? { status: "unknown", reasons: ["INTEGRITY_INVALID"] }
    : evidenceFormat === EVIDENCE_V1
      ? { status: "not_ready", reasons: ["LEGACY_EVIDENCE_REQUIRES_MIGRATION"] }
      : { status: "ready", reasons: [] };
  return {
    status: structurallyValid ? "valid" : "invalid",
    continuity_status: structurallyValid ? "continuity_valid" : "continuity_blocked",
    mission_id: typeof missionId === "string" ? missionId : null,
    mission_status: mission?.status ?? null,
    counts: {
      lots: lots.length,
      complete_lots: lots.filter((lot) => lot?.status === "complete").length,
      evidence_entries: evidence.length,
    },
    next_preparation_step: structurallyValid
      ? nextPreparationStep(mission, lots, contract, evidenceFormat)
      : "Resolve the listed contradictions with a human before resuming.",
    findings: uniqueFindings,
    evidence_format: evidenceFormat ?? null,
    readiness,
  };
}
