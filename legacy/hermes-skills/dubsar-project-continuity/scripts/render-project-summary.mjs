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
  loadProjectWorkspace,
  REQUIRED_FILES,
  validateProjectWorkspace,
} from "./project-model.mjs";

function escapeMarkdown(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replace(/([\\`*_[\]{}()#+.!|])/gu, "\\$1");
}

function bulletList(values, fallback = "None recorded.") {
  if (!Array.isArray(values) || values.length === 0) {
    return `- ${escapeMarkdown(fallback)}`;
  }
  return values.map((value) => `- ${escapeMarkdown(value)}`).join("\n");
}

function renderSummary(documents, validation) {
  const mission = documents["mission.json"];
  const lots = documents["lots.json"].lots;
  const contract = documents["execution-contract.json"];
  const evidenceDocument = documents["evidence.json"];
  const evidence = evidenceDocument.entries;
  const evidenceV2 = evidenceDocument.format === "dubsar.project-evidence/2";
  const supportedEvidence = evidence
    .filter((entry) => evidenceV2 && ["observed", "derived"].includes(entry.class))
    .map((entry) => `[${entry.class}] ${entry.statement} (${entry.evidence_id})`);
  const unresolvedEvidence = evidence
    .filter((entry) => !evidenceV2 || ["reported", "unverified"].includes(entry.class))
    .map((entry) => `[${entry.class}] ${entry.statement ?? entry.claim} (${entry.evidence_id})`);
  const evidenceLimitations = evidence.flatMap((entry) =>
    entry.limitations.map(
      (limitation) => `${entry.evidence_id}: ${limitation}`,
    ),
  );
  const currentLot =
    lots.find((lot) => lot.status === "candidate") ??
    lots.find((lot) => lot.status !== "complete") ??
    null;

  const lines = [
    "# Project continuity summary",
    "",
    `Mission: ${escapeMarkdown(mission.title || mission.mission_id)}`,
    `Mission status: ${escapeMarkdown(mission.status)}`,
    `Continuity: ${escapeMarkdown(validation.continuity_status)}`,
    "",
    "## Desired outcome",
    "",
    escapeMarkdown(mission.desired_outcome || "Not recorded."),
    "",
    "## Current lot",
    "",
    currentLot
      ? `${escapeMarkdown(currentLot.lot_id)}: ${escapeMarkdown(currentLot.title)}`
      : "No active candidate lot.",
    "",
    "## Evidence",
    "",
    `Recorded entries: ${evidence.length}`,
    `Completed lots: ${validation.counts.complete_lots}/${validation.counts.lots}`,
    "",
    "### Evidence-backed facts",
    "",
    bulletList(supportedEvidence, "No observed or derived fact recorded."),
    "",
    "### Reported or unverified claims",
    "",
    bulletList(unresolvedEvidence, "None recorded."),
    "",
    "### Evidence limitations",
    "",
    bulletList(evidenceLimitations, "None recorded."),
    "",
    "## Protected areas",
    "",
    bulletList(contract.protected_areas),
    "",
    "## Stop conditions",
    "",
    bulletList(
      [...mission.stop_conditions, ...contract.stop_conditions],
      "None recorded.",
    ),
    "",
    "## Next preparation step",
    "",
    escapeMarkdown(validation.next_preparation_step),
    "",
    "## Authority boundary",
    "",
    "This summary does not authorize execution, deployment, merge, or external communication.",
    "",
  ];
  return `${lines.join("\n")}\n`;
}

export async function renderProjectSummary(input, output) {
  const sourceRoot = await openWorkspace(input);
  const outputCandidate = await canonicalCandidate(output);
  if (isInsideOrEqual(sourceRoot, outputCandidate)) {
    throw new PublicPluginError("OUTPUT_INSIDE_WORKSPACE");
  }
  const validation = await validateProjectWorkspace(sourceRoot);
  if (validation.status !== "valid") {
    throw new PublicPluginError("CONTINUITY_BLOCKED");
  }
  const documents = await loadProjectWorkspace(sourceRoot);
  const outputRoot = await prepareOutputDirectory(output);
  const summary = renderSummary(documents, validation);
  await writeTextExclusive(outputRoot, "PROJECT-SUMMARY.md", summary);

  const sourceFiles = [];
  for (const file of REQUIRED_FILES) {
    sourceFiles.push({
      path: file,
      sha256: await sha256File(sourceRoot, file),
    });
  }
  const manifest = {
    format: "dubsar.project-summary-manifest/1",
    mission_id: validation.mission_id,
    source_files: sourceFiles,
    source_root_sha256: rootDigest(sourceFiles),
    summary_sha256: await sha256File(outputRoot, "PROJECT-SUMMARY.md"),
    disclaimer: "Continuity aid only; no execution authority is granted.",
  };
  await writeJsonExclusive(outputRoot, "MANIFEST.sha256.json", manifest);

  return {
    status: "rendered",
    mission_id: validation.mission_id,
    source_root_sha256: manifest.source_root_sha256,
    summary_sha256: manifest.summary_sha256,
  };
}

async function main() {
  try {
    const args = parseArgs(process.argv.slice(2), ["root", "output"]);
    printResult(await renderProjectSummary(args.root, args.output));
  } catch (error) {
    printFailure(error);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
