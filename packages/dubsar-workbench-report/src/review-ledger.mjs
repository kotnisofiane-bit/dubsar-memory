import {
  WORKBENCH_AUTHORITY,
  WorkbenchError,
  sha256Bytes,
} from "../../dubsar-operator-core/src/contracts.mjs";
import { safeDisplayText } from "../../dubsar-operator-core/src/display-safety.mjs";
import {
  MAX_REPORT_BYTES,
  WORKBENCH_REPORT_RENDERER,
  escapeHtmlText,
  renderWorkbenchReport,
} from "./render.mjs";

export const REVIEW_LEDGER_REPORT_FORMAT = "dubsar.review-ledger-report/1";

const REVIEW_LEDGER_FORMAT = "dubsar.review-ledger-view/1";
const REVIEW_SHELL_RESERVE_BYTES = 4_096;
const REVIEW_DETAIL_BUDGET_BYTES = 524_288;
const MAX_REVIEW_ITEMS = 256;
const MAX_ARRAY_ITEMS = 50;
const MAX_DISPLAY_BYTES = 8_192;
const HEX_64 = /^[0-9a-f]{64}$/u;
const SAFE_ID = /^(?:[a-z0-9][a-z0-9._-]{2,127}|~[drf][0-9]{6})$/u;
const RECEIPT_TYPES = new Set([
  "domain-review",
  "challenge",
  "reconciliation",
]);
const ROLES = new Set([
  "product",
  "architecture",
  "security",
  "verification",
  "reliability",
  "challenger",
  "principal",
  "human",
]);
const ISOLATIONS = new Set([
  "isolated-subagent",
  "external-model",
  "human",
  "self-check",
]);
const SEVERITIES = new Set(["info", "low", "medium", "high", "critical"]);
const LEDGER_STATUSES = new Set(["available", "degraded", "unavailable"]);

function exactKeys(value, keys) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function safeText(value, { id = false } = {}) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > MAX_DISPLAY_BYTES ||
    (id && !SAFE_ID.test(value))
  ) {
    return false;
  }
  const display = safeDisplayText(value, MAX_DISPLAY_BYTES);
  return !display.redacted && !display.truncated && display.text === value;
}

function safeTextArray(value, { ids = false } = {}) {
  return (
    Array.isArray(value) &&
    value.length <= MAX_ARRAY_ITEMS &&
    value.every((item) => safeText(item, { id: ids }))
  );
}

function safeCount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function assertFinding(finding) {
  if (
    !exactKeys(finding, [
      "finding_id",
      "severity",
      "summary",
      "evidence_refs",
    ]) ||
    !safeText(finding.finding_id, { id: true }) ||
    !SEVERITIES.has(finding.severity) ||
    !safeText(finding.summary) ||
    !safeTextArray(finding.evidence_refs)
  ) {
    throw new WorkbenchError("REVIEW_REPORT_VIEW_INVALID");
  }
}

function assertReview(review) {
  if (
    !exactKeys(review, [
      "decision_id",
      "receipt_id",
      "receipt_type",
      "declared_role",
      "declared_isolation",
      "advisory",
      "input_canonical_root_sha256",
      "resulting_canonical_root_sha256",
      "input_canonical_digest_match",
      "resulting_canonical_digest_match",
      "findings",
      "alternatives",
      "limitations",
      "reviewed_receipts",
    ]) ||
    !safeText(review.decision_id, { id: true }) ||
    !safeText(review.receipt_id, { id: true }) ||
    !RECEIPT_TYPES.has(review.receipt_type) ||
    !ROLES.has(review.declared_role) ||
    !ISOLATIONS.has(review.declared_isolation) ||
    review.advisory !== true ||
    !HEX_64.test(review.input_canonical_root_sha256) ||
    (review.resulting_canonical_root_sha256 !== null &&
      !HEX_64.test(review.resulting_canonical_root_sha256)) ||
    typeof review.input_canonical_digest_match !== "boolean" ||
    (review.resulting_canonical_digest_match !== null &&
      typeof review.resulting_canonical_digest_match !== "boolean") ||
    !Array.isArray(review.findings) ||
    review.findings.length > MAX_ARRAY_ITEMS ||
    !safeTextArray(review.alternatives) ||
    !safeTextArray(review.limitations) ||
    !safeTextArray(review.reviewed_receipts, { ids: true })
  ) {
    throw new WorkbenchError("REVIEW_REPORT_VIEW_INVALID");
  }
  for (const finding of review.findings) {
    assertFinding(finding);
  }
}

function assertReviewLedger(view, ledger) {
  if (
    !exactKeys(ledger, [
      "format",
      "authority",
      "producer",
      "source",
      "ledger",
      "reviews",
      "privacy",
      "projection_sha256",
    ]) ||
    ledger.format !== REVIEW_LEDGER_FORMAT ||
    ledger.authority !== WORKBENCH_AUTHORITY ||
    !exactKeys(ledger.producer, ["name", "version"]) ||
    !safeText(ledger.producer.name) ||
    !safeText(ledger.producer.version) ||
    !exactKeys(ledger.source, [
      "domain",
      "id",
      "canonical_root_sha256",
      "snapshot_sha256",
    ]) ||
    ledger.source.domain !== view?.source?.domain ||
    (ledger.source.id !== null && !safeText(ledger.source.id, { id: true })) ||
    !HEX_64.test(ledger.source.canonical_root_sha256) ||
    ledger.source.snapshot_sha256 !== view?.source?.snapshot_sha256 ||
    !exactKeys(ledger.ledger, [
      "status",
      "receipt_set_sha256",
      "discovered_count",
      "valid_count",
      "omitted_count",
      "diagnostics",
    ]) ||
    !LEDGER_STATUSES.has(ledger.ledger.status) ||
    !Array.isArray(ledger.ledger.diagnostics) ||
    ledger.ledger.diagnostics.length > MAX_ARRAY_ITEMS ||
    !Array.isArray(ledger.reviews) ||
    ledger.reviews.length > MAX_REVIEW_ITEMS ||
    !exactKeys(ledger.privacy, [
      "redacted_fields",
      "truncated_fields",
      "omitted_fields",
    ]) ||
    !safeCount(ledger.privacy.redacted_fields) ||
    !safeCount(ledger.privacy.truncated_fields) ||
    !safeCount(ledger.privacy.omitted_fields) ||
    !HEX_64.test(ledger.projection_sha256) ||
    Buffer.byteLength(JSON.stringify(ledger), "utf8") > REVIEW_DETAIL_BUDGET_BYTES
  ) {
    throw new WorkbenchError("REVIEW_REPORT_VIEW_INVALID");
  }

  for (const diagnostic of ledger.ledger.diagnostics) {
    if (
      !exactKeys(diagnostic, ["code", "severity"]) ||
      !safeText(diagnostic.code) ||
      !new Set(["warning", "error"]).has(diagnostic.severity)
    ) {
      throw new WorkbenchError("REVIEW_REPORT_VIEW_INVALID");
    }
  }
  const reviewKeys = new Set();
  for (const review of ledger.reviews) {
    assertReview(review);
    const key = `${review.decision_id}\0${review.receipt_id}`;
    if (reviewKeys.has(key)) {
      throw new WorkbenchError("REVIEW_REPORT_VIEW_INVALID");
    }
    reviewKeys.add(key);
  }

  if (ledger.ledger.status === "unavailable") {
    if (
      ledger.ledger.receipt_set_sha256 !== null ||
      ledger.ledger.discovered_count !== null ||
      ledger.ledger.valid_count !== null ||
      ledger.ledger.omitted_count !== null ||
      ledger.reviews.length !== 0 ||
      ledger.ledger.diagnostics.length === 0
    ) {
      throw new WorkbenchError("REVIEW_REPORT_VIEW_INVALID");
    }
    return;
  }

  if (
    !HEX_64.test(ledger.ledger.receipt_set_sha256) ||
    !safeCount(ledger.ledger.discovered_count) ||
    !safeCount(ledger.ledger.valid_count) ||
    !safeCount(ledger.ledger.omitted_count) ||
    ledger.ledger.valid_count !== ledger.reviews.length ||
    ledger.ledger.omitted_count !==
      ledger.ledger.discovered_count - ledger.ledger.valid_count ||
    (ledger.ledger.status === "available" &&
      (ledger.ledger.omitted_count !== 0 ||
        ledger.ledger.diagnostics.length !== 0)) ||
    (ledger.ledger.status === "degraded" &&
      ledger.ledger.diagnostics.length === 0)
  ) {
    throw new WorkbenchError("REVIEW_REPORT_VIEW_INVALID");
  }
}

function list(items, emptyText) {
  if (items.length === 0) {
    return [`            <li>${escapeHtmlText(emptyText)}</li>`];
  }
  return items.map((item) => `            <li>${escapeHtmlText(item)}</li>`);
}

function renderFinding(finding) {
  return [
    "          <article class=\"card\">",
    `            <p class="eyebrow">Advisory review finding — ${escapeHtmlText(finding.severity)}</p>`,
    `            <h3>${escapeHtmlText(finding.finding_id)}</h3>`,
    `            <p>${escapeHtmlText(finding.summary)}</p>`,
    "            <ul class=\"formats\">",
    ...list(finding.evidence_refs, "No displayed evidence reference."),
    "            </ul>",
    "          </article>",
  ].join("\n");
}

function renderReview(review) {
  const resultingRoot = review.resulting_canonical_root_sha256 ?? "not applicable";
  const resultingMatch =
    review.resulting_canonical_digest_match === null
      ? "not applicable"
      : String(review.resulting_canonical_digest_match);
  const findings =
    review.findings.length === 0
      ? ["          <p class=\"empty\">No advisory review finding displayed.</p>"]
      : review.findings.map(renderFinding);
  const interpretation =
    review.receipt_type === "reconciliation" &&
    review.resulting_canonical_digest_match === true
      ? "Réconciliation déclarée — résultat byte-identique au canon actuel — objection conservée"
      : review.input_canonical_digest_match
        ? "Avis consultatif — mêmes octets canoniques"
        : "Avis consultatif historique — octets canoniques différents";
  return [
    "      <details class=\"card\">",
    `        <summary>${escapeHtmlText(review.decision_id)} / ${escapeHtmlText(review.receipt_id)} — advisory ${escapeHtmlText(review.receipt_type)}</summary>`,
    `        <p class="notice">${escapeHtmlText(interpretation)}</p>`,
    "        <ul class=\"facts\">",
    `          <li><span>Declared role</span><strong>${escapeHtmlText(review.declared_role)}</strong></li>`,
    `          <li><span>Declared isolation</span><strong>${escapeHtmlText(review.declared_isolation)}</strong></li>`,
    `          <li><span>Input canonical root</span><strong><code>${review.input_canonical_root_sha256}</code></strong></li>`,
    `          <li><span>Input digest match</span><strong>${review.input_canonical_digest_match}</strong></li>`,
    `          <li><span>Resulting canonical root</span><strong><code>${resultingRoot}</code></strong></li>`,
    `          <li><span>Resulting digest match</span><strong>${resultingMatch}</strong></li>`,
    "        </ul>",
    "        <h3>Advisory review findings</h3>",
    ...findings,
    "        <h3>Alternatives</h3>",
    "        <ul class=\"formats\">",
    ...list(review.alternatives, "No displayed alternative."),
    "        </ul>",
    "        <h3>Limitations</h3>",
    "        <ul class=\"formats\">",
    ...list(review.limitations, "No displayed limitation."),
    "        </ul>",
    "        <h3>Direct review lineage</h3>",
    "        <ul class=\"formats\">",
    ...list(review.reviewed_receipts, "No directly reviewed receipt."),
    "        </ul>",
    "      </details>",
  ].join("\n");
}

function statusBanner(ledger) {
  const { status, valid_count: valid, omitted_count: omitted, diagnostics } =
    ledger.ledger;
  if (status === "available") {
    return `Advisory Review Ledger — available — ${valid} validé(s), 0 omis — ne modifie pas l’état canonique`;
  }
  if (status === "degraded") {
    return `Advisory Review Ledger — degraded — ${valid} validé(s), ${omitted} omis — données consultatives partielles`;
  }
  return `Advisory Review Ledger — unavailable — comptage indisponible — aucune donnée partielle publiée — ${diagnostics.at(0).code}`;
}

function renderReviewSection(view, ledger, details, omittedByRender) {
  const renderedCount = details.length;
  const presentation = omittedByRender > 0 ? "summary-only" : "full";
  const reduced =
    presentation === "summary-only"
      ? `Rendu consultatif réduit — ${renderedCount}/${ledger.ledger.valid_count} avis affichés — ${omittedByRender} masqués par le budget — canonique intact — projection assainie complète disponible via dubsar reviews --json`
      : null;
  const receiptSet = ledger.ledger.receipt_set_sha256 ?? "unavailable";
  const sourceId = ledger.source.id ?? "withheld";
  const reviewLines =
    details.length === 0
      ? ["      <p class=\"empty\">No advisory review detail is displayed.</p>"]
      : details;
  return {
    presentation,
    html: [
      "  <section class=\"advisory-ledger\">",
      "    <h2>Advisory Review Ledger</h2>",
      ...(view.blockers.length === 0
        ? []
        : [
            "    <p class=\"notice\">Blocage canonique — affecte readiness : voir la section Blockers ci-dessus.</p>",
          ]),
      `    <article class="card"><p>${escapeHtmlText(statusBanner(ledger))}</p>`,
      ...(reduced === null
        ? []
        : [`      <p class="notice">${escapeHtmlText(reduced)}</p>`]),
      "      <ul class=\"facts\">",
      `        <li><span>Source</span><strong>${escapeHtmlText(sourceId)}</strong></li>`,
      `        <li><span>Canonical root SHA-256</span><strong><code>${ledger.source.canonical_root_sha256}</code></strong></li>`,
      `        <li><span>Receipt set SHA-256</span><strong><code>${receiptSet}</code></strong></li>`,
      `        <li><span>Review projection SHA-256</span><strong><code>${ledger.projection_sha256}</code></strong></li>`,
      `        <li><span>Presentation</span><strong>${presentation}</strong></li>`,
      "      </ul>",
      "    </article>",
      "    <div class=\"grid\">",
      ...reviewLines,
      "    </div>",
      "  </section>",
    ].join("\n"),
  };
}

export function renderReviewLedgerReport(view, ledger, options = {}) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new WorkbenchError("REPORT_LIMIT_INVALID");
  }
  const maxBytes = options.maxBytes ?? MAX_REPORT_BYTES;
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes <= 0 ||
    maxBytes > MAX_REPORT_BYTES
  ) {
    throw new WorkbenchError("REPORT_LIMIT_INVALID");
  }
  assertReviewLedger(view, ledger);
  const canonical = renderWorkbenchReport(view, { maxBytes });
  const canonicalBytes = Buffer.byteLength(canonical.html, "utf8");
  const remaining = maxBytes - canonicalBytes;
  if (remaining < REVIEW_SHELL_RESERVE_BYTES) {
    throw new WorkbenchError("REVIEW_PRESENTATION_BUDGET_UNAVAILABLE");
  }

  const detailBudget = Math.min(
    REVIEW_DETAIL_BUDGET_BYTES,
    remaining - REVIEW_SHELL_RESERVE_BYTES,
  );
  let retainedBytes = 0;
  let omittedByRender = 0;
  const details = [];
  for (const review of ledger.reviews) {
    const detail = renderReview(review);
    const detailBytes = Buffer.byteLength(detail, "utf8");
    if (retainedBytes + detailBytes > detailBudget) {
      omittedByRender += 1;
      continue;
    }
    retainedBytes += detailBytes;
    details.push(detail);
  }

  const section = renderReviewSection(view, ledger, details, omittedByRender);
  const sectionBytes = Buffer.byteLength(section.html, "utf8");
  if (sectionBytes - retainedBytes > REVIEW_SHELL_RESERVE_BYTES) {
    throw new WorkbenchError("REVIEW_PRESENTATION_BUDGET_UNAVAILABLE");
  }
  const marker = "  <footer>";
  const markerIndex = canonical.html.lastIndexOf(marker);
  if (markerIndex < 0) {
    throw new WorkbenchError("REVIEW_REPORT_VIEW_INVALID");
  }
  const html = `${canonical.html.slice(0, markerIndex)}${section.html}\n${canonical.html.slice(markerIndex)}`;
  const bytes = Buffer.byteLength(html, "utf8");
  if (bytes > maxBytes) {
    throw new WorkbenchError("REVIEW_PRESENTATION_BUDGET_UNAVAILABLE");
  }

  return Object.freeze({
    html,
    manifest: Object.freeze({
      format: REVIEW_LEDGER_REPORT_FORMAT,
      authority: WORKBENCH_AUTHORITY,
      renderer: WORKBENCH_REPORT_RENDERER,
      source_snapshot_sha256: view.source.snapshot_sha256,
      source_canonical_root_sha256: ledger.source.canonical_root_sha256,
      canonical_view_format: view.format,
      review_ledger_format: ledger.format,
      receipt_set_sha256: ledger.ledger.receipt_set_sha256,
      review_projection_sha256: ledger.projection_sha256,
      review_presentation: section.presentation,
      bytes,
      sha256: sha256Bytes(Buffer.from(html, "utf8")),
    }),
  });
}
