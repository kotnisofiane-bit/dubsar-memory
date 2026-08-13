import {
  WORKBENCH_AUTHORITY,
  WORKBENCH_VIEW_FORMAT,
  WorkbenchError,
  sha256Bytes,
} from "../../dubsar-operator-core/src/contracts.mjs";
import {
  safeDisplayText,
  safeStructuralText,
} from "../../dubsar-operator-core/src/display-safety.mjs";

export const WORKBENCH_REPORT_FORMAT = "dubsar.workbench-report/1";
export const WORKBENCH_REPORT_RENDERER = Object.freeze({
  name: "@dubsar/workbench-report",
  version: "0.1.0-dev",
});
export const MAX_REPORT_BYTES = 2 * 1024 * 1024;

const MAX_RENDER_ITEMS = 256;
const MAX_RENDER_TEXT_CHARS = 2_000;
const MAX_COUNT_KEYS = 32;
const STATIC_BYTE_BUDGET = 16 * 1024;
const ITEM_MARKUP_BYTE_BUDGET = 1024;
const STRUCTURAL_TOKEN = /^[a-z0-9][a-z0-9._-]{1,127}$/iu;
const STRUCTURAL_ID = /^[a-z0-9][a-z0-9._-]{2,127}$/iu;
const STRUCTURAL_FORMAT = /^[a-z0-9][a-z0-9._/-]{2,127}$/iu;
const STRUCTURAL_PRODUCER_NAME = /^@?[a-z0-9][a-z0-9@/._-]{1,127}$/iu;
const STRUCTURAL_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
const TOP_LEVEL_STATUSES = Object.freeze({
  integrity: new Set(["invalid", "valid"]),
  readiness: new Set(["not_ready", "ready", "unknown"]),
});

function text(value, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function boundedText(value) {
  return typeof value === "string" && value.length <= MAX_RENDER_TEXT_CHARS;
}

function assertDisplaySafe(value) {
  if (!boundedText(value)) {
    throw new WorkbenchError("REPORT_VIEW_INVALID");
  }
  const display = safeDisplayText(value, MAX_RENDER_TEXT_CHARS);
  if (display.redacted) {
    throw new WorkbenchError("REPORT_VIEW_SENSITIVE");
  }
  if (display.truncated || display.text !== value) {
    throw new WorkbenchError("REPORT_VIEW_INVALID");
  }
}

function assertStructural(value, pattern = STRUCTURAL_TOKEN) {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new WorkbenchError("REPORT_VIEW_INVALID");
  }
  const checked = safeStructuralText(value, MAX_RENDER_TEXT_CHARS);
  if (checked.redacted || checked.truncated || checked.text !== value) {
    throw new WorkbenchError("REPORT_VIEW_SENSITIVE");
  }
}

function countEntries(counts) {
  if (!counts || typeof counts !== "object" || Array.isArray(counts)) {
    throw new WorkbenchError("REPORT_VIEW_INVALID");
  }
  const entries = Object.entries(counts);
  if (entries.length > MAX_COUNT_KEYS) {
    throw new WorkbenchError("REPORT_VIEW_INVALID");
  }
  for (const [key, value] of entries) {
    assertStructural(key);
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new WorkbenchError("REPORT_VIEW_INVALID");
    }
  }
  return entries.sort(([left], [right]) => compareText(left, right));
}

export function escapeHtmlText(value) {
  return text(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function assertRenderableView(view) {
  const boundedCollections = [
    view?.source?.formats,
    view?.integrity?.diagnostics,
    view?.readiness?.reasons,
    view?.blockers,
    view?.evidence,
    view?.decisions,
  ];
  const primaryText = [
    view?.next_action?.label,
    view?.overview?.title,
    view?.overview?.summary,
  ];
  if (
    !view ||
    typeof view !== "object" ||
    Array.isArray(view) ||
    view.format !== WORKBENCH_VIEW_FORMAT ||
    view.authority !== WORKBENCH_AUTHORITY ||
    !view.source ||
    !new Set(["audit", "project"]).has(view.source.domain) ||
    typeof view.source.snapshot_sha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(view.source.snapshot_sha256) ||
    !boundedCollections.every(
      (items) => Array.isArray(items) && items.length <= MAX_RENDER_ITEMS,
    ) ||
    !view.integrity ||
    !TOP_LEVEL_STATUSES.integrity.has(view.integrity.status) ||
    !view.readiness ||
    !TOP_LEVEL_STATUSES.readiness.has(view.readiness.status) ||
    !view.next_action ||
    !view.overview ||
    !primaryText.every(boundedText) ||
    !view.producer ||
    !boundedText(view.producer.name) ||
    !boundedText(view.producer.version) ||
    !/^@?[a-z0-9][a-z0-9@/._-]{1,127}$/iu.test(view.producer.name) ||
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(view.producer.version) ||
    !view.privacy ||
    !Number.isSafeInteger(view.privacy.redacted_fields) ||
    view.privacy.redacted_fields < 0 ||
    !Number.isSafeInteger(view.privacy.truncated_fields) ||
    view.privacy.truncated_fields < 0 ||
    (view.source.id !== null && !STRUCTURAL_ID.test(view.source.id))
  ) {
    throw new WorkbenchError("REPORT_VIEW_INVALID");
  }

  if (view.source.id !== null) assertStructural(view.source.id, STRUCTURAL_ID);
  assertStructural(view.producer.name, STRUCTURAL_PRODUCER_NAME);
  assertStructural(view.producer.version, STRUCTURAL_VERSION);
  assertStructural(view.next_action.code);
  for (const format of view.source.formats) assertStructural(format, STRUCTURAL_FORMAT);
  for (const item of view.integrity.diagnostics) {
    assertStructural(item?.code);
    assertStructural(item?.severity);
  }
  for (const reason of view.readiness.reasons) assertStructural(reason);
  for (const item of view.blockers) {
    assertStructural(item?.code);
    assertStructural(item?.severity);
  }
  for (const item of view.evidence) {
    assertStructural(item?.id, STRUCTURAL_ID);
    assertStructural(item?.status);
  }
  for (const item of view.decisions) {
    assertStructural(item?.id, STRUCTURAL_ID);
    assertStructural(item?.status);
  }

  const displayedText = [
    ...primaryText,
    ...view.blockers.map((item) => item?.title),
    ...view.evidence.map((item) => item?.statement),
    ...view.decisions.map((item) => item?.label),
  ];
  for (const value of displayedText) {
    assertDisplaySafe(value);
  }
  countEntries(view.overview.counts);
}

function itemLines(items, renderItem, emptyMessage) {
  if (items.length === 0) {
    return [`      <p class="empty">${escapeHtmlText(emptyMessage)}</p>`];
  }
  return items.flatMap((item, index) => renderItem(item, index));
}

function compareText(left, right) {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

function overviewCountLines(counts) {
  const entries = countEntries(counts);
  if (entries.length === 0) {
    return ["          <li><span>Recorded counts</span><strong>Unavailable</strong></li>"];
  }
  return entries.map(
    ([key, value]) =>
      `          <li><span>${escapeHtmlText(key.replaceAll("_", " "))}</span><strong>${value}</strong></li>`,
  );
}

function escapedUtf8Bytes(value) {
  let bytes = Buffer.byteLength(value, "utf8");
  for (const character of value) {
    if (character === "&") {
      bytes += 4;
    } else if (character === "<" || character === ">") {
      bytes += 3;
    } else if (character === '"') {
      bytes += 5;
    } else if (character === "'") {
      bytes += 4;
    }
  }
  return bytes;
}

function assertPreflightBudget(view, maxBytes) {
  const counts = countEntries(view.overview.counts);
  const values = [
    view.overview.title,
    view.overview.summary,
    view.next_action.label,
    view.source.id ?? "Withheld or unavailable",
    view.source.snapshot_sha256,
    view.producer.name,
    view.producer.version,
    ...view.source.formats,
    ...view.blockers.flatMap((item) => [item.code, item.severity, item.title]),
    ...view.evidence.flatMap((item) => [item.id, item.statement, item.status]),
    ...view.decisions.flatMap((item) => [item.id, item.label, item.status]),
    ...counts.flatMap(([key, value]) => [key, String(value)]),
  ];
  const itemCount =
    view.blockers.length + view.evidence.length + view.decisions.length;
  let estimatedBytes =
    STATIC_BYTE_BUDGET +
    itemCount * ITEM_MARKUP_BYTE_BUDGET +
    view.source.formats.length * 128 +
    counts.length * 128;
  for (const value of values) {
    estimatedBytes += escapedUtf8Bytes(value);
    if (estimatedBytes > maxBytes) {
      throw new WorkbenchError("REPORT_SIZE_LIMIT_EXCEEDED");
    }
  }
}

function joinBoundedLines(lines, maxBytes) {
  let bytes = 0;
  for (let index = 0; index < lines.length; index += 1) {
    bytes += Buffer.byteLength(lines.at(index), "utf8");
    if (index > 0) {
      bytes += 1;
    }
    if (bytes > maxBytes) {
      throw new WorkbenchError("REPORT_SIZE_LIMIT_EXCEEDED");
    }
  }
  return lines.join("\n");
}

function renderDocument(view, maxBytes) {
  const sourceId =
    typeof view.source.id === "string" && view.source.id !== ""
      ? view.source.id
      : "Withheld or unavailable";
  const formatLines = view.source.formats.map(
    (format) => `          <li>${escapeHtmlText(format)}</li>`,
  );
  const blockerLines = itemLines(
    view.blockers,
    (blocker) => [
      "      <article class=\"card\">",
      `        <p class="eyebrow">${escapeHtmlText(blocker.severity)}</p>`,
      `        <h3>${escapeHtmlText(blocker.title)}</h3>`,
      `        <p>${escapeHtmlText(blocker.code)}</p>`,
      "      </article>",
    ],
    "No recorded blocker in this derived view.",
  );
  const evidenceLines = itemLines(
    view.evidence,
    (entry, index) => [
      "      <article class=\"card\">",
      `        <p class="eyebrow">Evidence ${index + 1} - ${escapeHtmlText(entry.status)}</p>`,
      `        <h3>${escapeHtmlText(entry.id)}</h3>`,
      `        <p>${escapeHtmlText(entry.statement)}</p>`,
      entry.content_redacted === true
        ? "        <p class=\"notice\">Sensitive content was redacted by the read model.</p>"
        : "        <p class=\"notice\">No display redaction recorded for this statement.</p>",
      "      </article>",
    ],
    "No evidence entry is present in this derived view.",
  );
  const decisionLines = itemLines(
    view.decisions,
    (decision, index) => [
      "      <article class=\"card\">",
      `        <p class="eyebrow">Decision ${index + 1} - ${escapeHtmlText(decision.status)}</p>`,
      `        <h3>${escapeHtmlText(decision.id)}</h3>`,
      `        <p>${escapeHtmlText(decision.label)}</p>`,
      decision.content_redacted === true
        ? "        <p class=\"notice\">Sensitive content was redacted by the read model.</p>"
        : "        <p class=\"notice\">No display redaction recorded for this decision.</p>",
      "      </article>",
    ],
    "No open decision is present in this derived view.",
  );

  return joinBoundedLines([
    "<!doctype html>",
    "<html lang=\"en\">",
    "<head>",
    "  <meta charset=\"utf-8\">",
    "  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">",
    "  <meta name=\"referrer\" content=\"no-referrer\">",
    "  <meta http-equiv=\"Content-Security-Policy\" content=\"base-uri 'none'; connect-src 'none'; default-src 'none'; font-src 'none'; form-action 'none'; frame-ancestors 'none'; frame-src 'none'; img-src 'none'; media-src 'none'; object-src 'none'; script-src 'none'; style-src 'unsafe-inline'\">",
    "  <title>DUBSAR Workbench - Static report</title>",
    "  <style>",
    "    :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, sans-serif; background: #090d12; color: #edf3f8; }",
    "    * { box-sizing: border-box; }",
    "    body { margin: 0; background: #090d12; color: #edf3f8; }",
    "    main { width: min(1120px, calc(100% - 32px)); margin: 0 auto; padding: 48px 0 72px; }",
    "    header { padding: 28px; border: 1px solid #273340; border-radius: 22px; background: #101720; }",
    "    h1, h2, h3, p { margin-top: 0; }",
    "    h1 { max-width: 820px; margin-bottom: 12px; font-size: clamp(2rem, 5vw, 4.5rem); letter-spacing: -0.04em; }",
    "    h2 { margin-bottom: 18px; font-size: 1.3rem; }",
    "    h3 { margin-bottom: 10px; font-size: 1rem; overflow-wrap: anywhere; }",
    "    p, li { color: #b8c6d3; line-height: 1.55; overflow-wrap: anywhere; }",
    "    section { margin-top: 34px; }",
    "    .eyebrow { margin-bottom: 8px; color: #79e8be; font-size: 0.75rem; font-weight: 750; letter-spacing: 0.12em; text-transform: uppercase; }",
    "    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 14px; }",
    "    .card { min-width: 0; padding: 18px; border: 1px solid #273340; border-radius: 16px; background: #0e141c; }",
    "    .metric { display: block; margin-top: 8px; color: #edf3f8; font-size: 1.15rem; font-weight: 750; overflow-wrap: anywhere; }",
    "    .notice, .empty { color: #8292a1; font-size: 0.86rem; }",
    "    .facts { margin: 0; padding: 0; list-style: none; }",
    "    .facts li { display: flex; justify-content: space-between; gap: 18px; padding: 8px 0; border-bottom: 1px solid #202b36; }",
    "    .facts strong { color: #edf3f8; text-align: right; overflow-wrap: anywhere; }",
    "    .formats { margin-bottom: 0; padding-left: 18px; }",
    "    summary { cursor: pointer; font-weight: 700; line-height: 1.4; overflow-wrap: anywhere; }",
    "    details[open] > summary { margin-bottom: 14px; }",
    "    .advisory-ledger .grid { align-items: start; }",
    "    .advisory-ledger details[open] { grid-column: 1 / -1; }",
    "    footer { margin-top: 42px; padding-top: 20px; border-top: 1px solid #273340; }",
    "    code { color: #c4f7e3; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; overflow-wrap: anywhere; }",
    "    @media (max-width: 640px) {",
    "      main { width: min(100% - 20px, 1120px); padding-top: 20px; }",
    "      header { padding: 20px; }",
    "      .facts li { align-items: flex-start; flex-direction: column; gap: 4px; }",
    "      .facts strong { text-align: left; }",
    "    }",
    "  </style>",
    "</head>",
    "<body>",
    "<main>",
    "  <header>",
    "    <p class=\"eyebrow\">DUBSAR Workbench - derived local view</p>",
    `    <h1>${escapeHtmlText(view.overview.title)}</h1>`,
    `    <p>${escapeHtmlText(view.overview.summary)}</p>`,
    "  </header>",
    "  <section>",
    "    <h2>Status and next action</h2>",
    "    <div class=\"grid\">",
    "      <article class=\"card\"><p class=\"eyebrow\">Integrity</p>",
    `        <span class="metric">${escapeHtmlText(view.integrity.status)}</span></article>`,
    "      <article class=\"card\"><p class=\"eyebrow\">Readiness</p>",
    `        <span class="metric">${escapeHtmlText(view.readiness.status)}</span></article>`,
    "      <article class=\"card\"><p class=\"eyebrow\">Next action</p>",
    `        <span class="metric">${escapeHtmlText(view.next_action.label)}</span></article>`,
    "    </div>",
    "  </section>",
    "  <section>",
    "    <h2>Recorded counts</h2>",
    "    <article class=\"card\"><ul class=\"facts\">",
    ...overviewCountLines(view.overview.counts),
    "    </ul></article>",
    "  </section>",
    "  <section>",
    "    <h2>Blockers</h2>",
    "    <div class=\"grid\">",
    ...blockerLines,
    "    </div>",
    "  </section>",
    "  <section>",
    "    <h2>Evidence</h2>",
    "    <div class=\"grid\">",
    ...evidenceLines,
    "    </div>",
    "  </section>",
    "  <section>",
    "    <h2>Decisions</h2>",
    "    <div class=\"grid\">",
    ...decisionLines,
    "    </div>",
    "  </section>",
    "  <section>",
    "    <h2>Provenance and privacy</h2>",
    "    <div class=\"grid\">",
    "      <article class=\"card\"><ul class=\"facts\">",
    `        <li><span>Authority</span><strong>${escapeHtmlText(view.authority)}</strong></li>`,
    `        <li><span>Domain</span><strong>${escapeHtmlText(view.source.domain)}</strong></li>`,
    `        <li><span>Source ID</span><strong>${escapeHtmlText(sourceId)}</strong></li>`,
    `        <li><span>Snapshot SHA-256</span><strong><code>${escapeHtmlText(view.source.snapshot_sha256)}</code></strong></li>`,
    `        <li><span>View format</span><strong>${escapeHtmlText(view.format)}</strong></li>`,
    `        <li><span>View producer</span><strong>${escapeHtmlText(`${view.producer.name}@${view.producer.version}`)}</strong></li>`,
    `        <li><span>Renderer</span><strong>${escapeHtmlText(`${WORKBENCH_REPORT_RENDERER.name}@${WORKBENCH_REPORT_RENDERER.version}`)}</strong></li>`,
    "      </ul></article>",
    "      <article class=\"card\"><ul class=\"facts\">",
    `        <li><span>Redacted fields</span><strong>${view.privacy.redacted_fields}</strong></li>`,
    `        <li><span>Truncated fields</span><strong>${view.privacy.truncated_fields}</strong></li>`,
    "        <li><span>Canonical formats</span><strong>Listed below</strong></li>",
    "      </ul><ul class=\"formats\">",
    ...formatLines,
    "      </ul></article>",
    "    </div>",
    "  </section>",
    "  <footer>",
    "    <p>This read-only report is a derived local preparation record. It is not an audit verdict, certification, deployment approval, or substitute for human review.</p>",
    "  </footer>",
    "</main>",
    "</body>",
    "</html>",
    "",
  ], maxBytes);
}

export function renderWorkbenchReport(view, options = {}) {
  assertRenderableView(view);
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new WorkbenchError("REPORT_LIMIT_INVALID");
  }
  const maxBytes = options.maxBytes ?? MAX_REPORT_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new WorkbenchError("REPORT_LIMIT_INVALID");
  }
  assertPreflightBudget(view, maxBytes);
  const html = renderDocument(view, maxBytes);
  const bytes = Buffer.byteLength(html, "utf8");
  if (bytes > maxBytes) {
    throw new WorkbenchError("REPORT_SIZE_LIMIT_EXCEEDED");
  }
  return Object.freeze({
    html,
    manifest: Object.freeze({
      format: WORKBENCH_REPORT_FORMAT,
      authority: WORKBENCH_AUTHORITY,
      renderer: WORKBENCH_REPORT_RENDERER,
      source_snapshot_sha256: view.source.snapshot_sha256,
      view_format: view.format,
      view_producer: Object.freeze({
        name: view.producer.name,
        version: view.producer.version,
      }),
      bytes,
      sha256: sha256Bytes(Buffer.from(html, "utf8")),
    }),
  });
}
