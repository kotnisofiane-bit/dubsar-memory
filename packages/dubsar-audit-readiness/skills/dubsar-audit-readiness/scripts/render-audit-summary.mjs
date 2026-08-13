import { fileURLToPath } from "node:url";
import {
  canonicalCandidate,
  isInsideOrEqual,
  openWorkspace,
  parseArgs,
  prepareOutputDirectory,
  printFailure,
  printResult,
  PublicPluginError,
  rootDigest,
  sha256File,
  writeJsonExclusive,
  writeTextExclusive,
} from "./safe-io.mjs";
import {
  loadAuditWorkspace,
  REQUIRED_FILES,
  validateAuditWorkspace,
} from "./audit-model.mjs";

function escapeMarkdown(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replace(/([\\`*_[\]{}()#+.!|])/gu, "\\$1");
}

function textValue(value) {
  if (typeof value === "string") {
    return value;
  }
  if (value && typeof value.statement === "string") {
    return value.statement;
  }
  return "Unstructured value omitted.";
}

function bulletList(values, fallback = "None recorded.") {
  if (!Array.isArray(values) || values.length === 0) {
    return `- ${escapeMarkdown(fallback)}`;
  }
  return values.map((value) => `- ${escapeMarkdown(textValue(value))}`).join("\n");
}

export function renderAuditPreparationMarkdown(documents, validation) {
  const scope = documents["audit-scope.json"];
  const inventory = documents["automation-inventory.json"];
  const sensitive = documents["sensitive-actions.json"];
  const review = documents["evidence-review.json"];
  const inventoryItems = inventory.items.map(
    (item) =>
      `${item.id}: ${item.name} [${item.kind}; ${item.state}; ${item.evidence_state}]`,
  );
  const actions = sensitive.actions.map(
    (action) =>
      `${action.id}: ${action.effect} [human_status=${action.human_status}]`,
  );
  const observations = review.supported_observations.map(
    (observation) =>
      `${observation.statement} (evidence: ${observation.evidence_refs.join(", ")})`,
  );
  const limitations = [
    ...(Array.isArray(scope.limitations) ? scope.limitations : []),
    ...(Array.isArray(review.limitations) ? review.limitations : []),
  ];

  const lines = [
    "# Audit preparation summary",
    "",
    `Case: ${escapeMarkdown(validation.case_id)}`,
    `Structural status: ${escapeMarkdown(validation.status)}`,
    `Preparation status: ${escapeMarkdown(validation.preparation_status)}`,
    "",
    "## Objective",
    "",
    escapeMarkdown(scope.objective || "Not recorded."),
    "",
    "## Scope",
    "",
    "### In scope",
    "",
    bulletList(scope.in_scope),
    "",
    "### Excluded",
    "",
    bulletList(scope.excluded),
    "",
    "## Inventory",
    "",
    `Automations: ${validation.counts.automations}`,
    bulletList(inventoryItems, "No evidence-supported automation recorded."),
    "",
    "## Sensitive actions",
    "",
    `Mapped actions: ${validation.counts.sensitive_actions}`,
    `Human map review: ${escapeMarkdown(sensitive.review_status)}`,
    bulletList(actions, "No sensitive action recorded."),
    "",
    "## Evidence review",
    "",
    `Indexed artifacts: ${validation.counts.evidence_artifacts}`,
    "",
    "### Supported observations",
    "",
    bulletList(observations, "No supported observation recorded."),
    "",
    "### Reported statements",
    "",
    bulletList(review.reported_statements),
    "",
    "### Contradictions",
    "",
    bulletList(review.contradictions),
    "",
    "### Missing evidence",
    "",
    bulletList(review.missing_evidence),
    "",
    "### Limitations",
    "",
    bulletList(limitations),
    "",
    "## Readiness reasons",
    "",
    bulletList(validation.readiness_reasons),
    "",
    "## Authority boundary",
    "",
    "This preparation summary is not an audit result, certification, compliance decision, safety verdict, or production approval.",
    "",
  ];
  return `${lines.join("\n")}\n`;
}

async function canonicalSourceFiles(root) {
  const files = [];
  for (const file of REQUIRED_FILES) {
    files.push({ path: file, sha256: await sha256File(root, file) });
  }
  return files;
}

export async function renderAuditSummary(input, output) {
  const sourceRoot = await openWorkspace(input);
  const outputCandidate = await canonicalCandidate(output);
  if (isInsideOrEqual(sourceRoot, outputCandidate)) {
    throw new PublicPluginError("OUTPUT_INSIDE_WORKSPACE");
  }
  const sourceFiles = await canonicalSourceFiles(sourceRoot);
  const documents = await loadAuditWorkspace(sourceRoot);
  const validation = await validateAuditWorkspace(sourceRoot);
  if (validation.status !== "valid") {
    throw new PublicPluginError("AUDIT_WORKSPACE_INVALID");
  }
  const confirmedSourceFiles = await canonicalSourceFiles(sourceRoot);
  if (rootDigest(sourceFiles) !== rootDigest(confirmedSourceFiles)) {
    throw new PublicPluginError("WORKSPACE_CHANGED_DURING_RENDER");
  }
  const outputRoot = await prepareOutputDirectory(output);
  const summary = renderAuditPreparationMarkdown(documents, validation);
  await writeTextExclusive(outputRoot, "AUDIT-PREPARATION-SUMMARY.md", summary);

  const manifest = {
    format: "dubsar.audit-summary-manifest/1",
    case_id: validation.case_id,
    source_files: sourceFiles,
    source_root_sha256: rootDigest(confirmedSourceFiles),
    summary_sha256: await sha256File(
      outputRoot,
      "AUDIT-PREPARATION-SUMMARY.md",
    ),
    disclaimer:
      "Preparation aid only; this is not an audit result or certification.",
  };
  await writeJsonExclusive(outputRoot, "MANIFEST.sha256.json", manifest);
  return {
    status: "rendered",
    case_id: validation.case_id,
    preparation_status: validation.preparation_status,
    source_root_sha256: manifest.source_root_sha256,
    summary_sha256: manifest.summary_sha256,
  };
}

async function main() {
  try {
    const args = parseArgs(process.argv.slice(2), ["root", "output"]);
    printResult(await renderAuditSummary(args.root, args.output));
  } catch (error) {
    printFailure(error);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
