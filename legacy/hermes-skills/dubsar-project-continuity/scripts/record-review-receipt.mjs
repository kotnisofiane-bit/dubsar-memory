import { fileURLToPath } from "node:url";
import {
  openWorkspace,
  parseArgs,
  printFailure,
  printResult,
  PublicPluginError,
  readJson,
  rootDigest,
  sha256File,
  writeJsonExclusive,
} from "./safe-io.mjs";
import { REQUIRED_FILES, validateProjectWorkspace } from "./project-model.mjs";

const ID = /^[a-z0-9][a-z0-9._-]{2,63}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const RECEIPT_TYPES = new Set(["domain-review", "challenge", "reconciliation"]);
const ROLES = new Set([
  "product", "architecture", "security", "verification", "reliability",
  "challenger", "principal", "human",
]);
const ISOLATION = new Set(["isolated-subagent", "external-model", "human", "self-check"]);
const SEVERITIES = new Set(["info", "low", "medium", "high", "critical"]);
const RECEIPT_KEYS = new Set([
  "format", "context_kind", "context_id", "decision_id", "receipt_id",
  "receipt_type", "role", "isolation", "advisory", "input_root_sha256",
  "resulting_root_sha256", "findings", "alternatives", "limitations",
  "reviewed_receipts",
]);
const FINDING_KEYS = new Set(["finding_id", "severity", "summary", "evidence_refs"]);

function fail(code) {
  throw new PublicPluginError(code);
}

function exactKeys(value, allowed, code) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(code);
  if (Object.keys(value).some((key) => !allowed.has(key))) fail(code);
}

function conciseString(value, code, max = 2048) {
  if (typeof value !== "string" || value.trim() === "" || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value)) fail(code);
}

function stringArray(value, code, { ids = false, refs = false } = {}) {
  if (!Array.isArray(value) || value.length > 50) fail(code);
  for (const item of value) {
    conciseString(item, code);
    if (ids && !ID.test(item)) fail(code);
    if (refs && (/^[\\/]/u.test(item) || /(^|[\\/])\.\.([\\/]|$)/u.test(item) || /:\/\//u.test(item))) fail(code);
  }
}

function rejectsCredentialMaterial(value) {
  const text = JSON.stringify(value);
  if (/-----BEGIN [A-Z ]+ PRIVATE KEY-----/u.test(text) ||
    /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16})\b/u.test(text) ||
    /\bBearer\s+[A-Za-z0-9._-]{12,}\b/iu.test(text) ||
    /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/iu.test(text)) return true;
  const assignment = /["']?\b(?:password|secret|client[_-]?secret|api[_-]?key|access[_-]?token|refresh[_-]?token|session[_-]?token|private[_-]?key|connection[_-]?string)\b["']?\s*[:=]\s*["']?([^\s"',}]{6,})/giu;
  for (const match of text.matchAll(assignment)) {
    const candidate = match[1].replace(/[<>]/gu, "").toLowerCase();
    if (!["redacted", "example", "dummy", "null", "none"].includes(candidate)) return true;
  }
  return false;
}

async function canonicalRoot(root) {
  const files = [];
  for (const file of REQUIRED_FILES) files.push({ path: file, sha256: await sha256File(root, file) });
  return rootDigest(files);
}

export async function currentProjectRootDigest(input) {
  return canonicalRoot(await openWorkspace(input));
}

async function validateReviewedReceipts(root, receipt, contextId) {
  for (const receiptId of receipt.reviewed_receipts) {
    const prior = await readJson(root, `reviews/${receipt.decision_id}/${receiptId}.json`);
    if (prior?.receipt_type === "reconciliation") fail("REVIEWED_RECEIPT_INVALID");
    validateReceiptShape(prior, contextId, prior?.input_root_sha256);
    if (prior.decision_id !== receipt.decision_id || prior.receipt_id !== receiptId) fail("REVIEWED_RECEIPT_INVALID");
    if (prior.input_root_sha256 !== receipt.input_root_sha256) fail("REVIEW_LINEAGE_MISMATCH");
  }
}

function validateReceiptShape(receipt, contextId, currentRoot) {
  exactKeys(receipt, RECEIPT_KEYS, "RECEIPT_SHAPE_INVALID");
  if (receipt.format !== "dubsar.review-receipt/1" || receipt.context_kind !== "project-mission" || receipt.context_id !== contextId) fail("RECEIPT_CONTEXT_INVALID");
  if (!ID.test(receipt.decision_id ?? "") || !ID.test(receipt.receipt_id ?? "")) fail("RECEIPT_ID_INVALID");
  if (!RECEIPT_TYPES.has(receipt.receipt_type) || !ROLES.has(receipt.role) || !ISOLATION.has(receipt.isolation) || receipt.advisory !== true) fail("RECEIPT_CLASSIFICATION_INVALID");
  if (!SHA256.test(receipt.input_root_sha256 ?? "") || !(receipt.resulting_root_sha256 === null || SHA256.test(receipt.resulting_root_sha256 ?? ""))) fail("RECEIPT_DIGEST_INVALID");
  if (!Array.isArray(receipt.findings) || receipt.findings.length > 50) fail("RECEIPT_FINDINGS_INVALID");
  for (const finding of receipt.findings) {
    exactKeys(finding, FINDING_KEYS, "RECEIPT_FINDING_SHAPE_INVALID");
    if (!ID.test(finding.finding_id ?? "") || !SEVERITIES.has(finding.severity)) fail("RECEIPT_FINDING_INVALID");
    conciseString(finding.summary, "RECEIPT_FINDING_INVALID");
    stringArray(finding.evidence_refs, "RECEIPT_EVIDENCE_REFS_INVALID", { refs: true });
  }
  stringArray(receipt.alternatives, "RECEIPT_ALTERNATIVES_INVALID");
  stringArray(receipt.limitations, "RECEIPT_LIMITATIONS_INVALID");
  stringArray(receipt.reviewed_receipts, "RECEIPT_REFERENCES_INVALID", { ids: true });
  if (receipt.receipt_type === "challenge" && (receipt.role !== "challenger" || !new Set(["isolated-subagent", "external-model"]).has(receipt.isolation))) fail("RECEIPT_ROLE_INVALID");
  if (receipt.receipt_type === "domain-review" && (!new Set(["product", "architecture", "security", "verification", "reliability"]).has(receipt.role) || receipt.isolation === "self-check")) fail("RECEIPT_ROLE_INVALID");
  if (receipt.receipt_type === "reconciliation") {
    if (!new Set(["principal", "human"]).has(receipt.role) || (receipt.role === "principal" && receipt.isolation !== "self-check") || (receipt.role === "human" && receipt.isolation !== "human") || receipt.resulting_root_sha256 !== currentRoot || receipt.reviewed_receipts.length === 0) fail("RECONCILIATION_INVALID");
  } else if (receipt.input_root_sha256 !== currentRoot || receipt.resulting_root_sha256 !== null || receipt.reviewed_receipts.length !== 0) {
    fail("REVIEW_ROOT_MISMATCH");
  }
  if (rejectsCredentialMaterial(receipt)) fail("RECEIPT_CREDENTIAL_PATTERN");
}

export async function recordProjectReviewReceipt(input, receipt) {
  const root = await openWorkspace(input);
  const validation = await validateProjectWorkspace(root);
  if (validation.status !== "valid") fail("WORKSPACE_INVALID");
  const currentRoot = await canonicalRoot(root);
  validateReceiptShape(receipt, validation.mission_id, currentRoot);
  if (receipt.receipt_type === "reconciliation") await validateReviewedReceipts(root, receipt, validation.mission_id);
  if (await canonicalRoot(root) !== currentRoot) fail("WORKSPACE_CHANGED_DURING_REVIEW_RECORDING");
  const relativePath = `reviews/${receipt.decision_id}/${receipt.receipt_id}.json`;
  await writeJsonExclusive(root, relativePath, receipt);
  const finalRoot = await canonicalRoot(root);
  return { status: finalRoot === currentRoot ? "recorded" : "recorded_historical", receipt: relativePath, input_root_sha256: receipt.input_root_sha256, current_root_sha256: finalRoot };
}

export async function readReceiptFromStdin(stream = process.stdin) {
  let body = "";
  for await (const chunk of stream) {
    body += chunk;
    if (Buffer.byteLength(body, "utf8") > 262144) fail("RECEIPT_TOO_LARGE");
  }
  try { return JSON.parse(body); } catch { fail("RECEIPT_JSON_INVALID"); }
}

async function main() {
  try {
    const args = parseArgs(process.argv.slice(2), ["root"], ["root"]);
    printResult(await recordProjectReviewReceipt(args.root, await readReceiptFromStdin()));
  } catch (error) { printFailure(error); }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
