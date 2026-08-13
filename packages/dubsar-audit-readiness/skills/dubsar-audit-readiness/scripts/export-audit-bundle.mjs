import { fileURLToPath } from "node:url";
import {
  canonicalCandidate,
  copyFileExclusive,
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
import { renderAuditPreparationMarkdown } from "./render-audit-summary.mjs";

export async function exportAuditBundle(input, output) {
  const sourceRoot = await openWorkspace(input);
  const outputCandidate = await canonicalCandidate(output);
  if (isInsideOrEqual(sourceRoot, outputCandidate)) {
    throw new PublicPluginError("OUTPUT_INSIDE_WORKSPACE");
  }

  const validation = await validateAuditWorkspace(sourceRoot);
  if (
    validation.status !== "valid" ||
    validation.preparation_status !== "ready_for_human_review"
  ) {
    throw new PublicPluginError("WORKSPACE_NOT_READY");
  }

  const documents = await loadAuditWorkspace(sourceRoot);
  const artifactPaths = documents["evidence-index.json"].artifacts.map(
    (artifact) => artifact.path,
  );
  const files = [...new Set([...REQUIRED_FILES, ...artifactPaths])].sort();
  const outputRoot = await prepareOutputDirectory(output);

  for (const file of files) {
    await copyFileExclusive(sourceRoot, file, outputRoot);
  }

  const bundleValidation = await validateAuditWorkspace(outputRoot);
  if (
    bundleValidation.status !== "valid" ||
    bundleValidation.preparation_status !== "ready_for_human_review"
  ) {
    throw new PublicPluginError("SOURCE_CHANGED_DURING_EXPORT");
  }
  const bundleDocuments = await loadAuditWorkspace(outputRoot);

  await writeTextExclusive(
    outputRoot,
    "AUDIT-PREPARATION-SUMMARY.md",
    renderAuditPreparationMarkdown(bundleDocuments, bundleValidation),
  );
  files.push("AUDIT-PREPARATION-SUMMARY.md");
  files.sort();

  const entries = [];
  for (const file of files) {
    entries.push({
      path: file.replaceAll("\\", "/"),
      sha256: await sha256File(outputRoot, file),
    });
  }

  const manifest = {
    format: "dubsar.audit-bundle-manifest/1",
    label: "prepared_for_human_review",
    case_id: validation.case_id,
    file_count: entries.length,
    files: entries,
    root_sha256: rootDigest(entries),
    disclaimer:
      "Byte integrity only; this bundle is not an audit result or certification.",
  };
  await writeJsonExclusive(outputRoot, "MANIFEST.sha256.json", manifest);

  return {
    status: "exported",
    label: manifest.label,
    file_count: manifest.file_count,
    root_sha256: manifest.root_sha256,
  };
}

async function main() {
  try {
    const args = parseArgs(process.argv.slice(2), ["root", "output"]);
    printResult(await exportAuditBundle(args.root, args.output));
  } catch (error) {
    printFailure(error);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
