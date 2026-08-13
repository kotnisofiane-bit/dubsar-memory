import {
  WORKBENCH_AUTHORITY,
  WorkbenchError,
  exactKeys,
  sha256Bytes,
  stableJson,
} from "../../dubsar-operator-core/src/contracts.mjs";
import {
  safeDisplayText,
  safeStructuralText,
} from "../../dubsar-operator-core/src/display-safety.mjs";
import { WORKBENCH_GRAPH_FORMAT } from "../../dubsar-operator-core/src/graph-model.mjs";
import {
  MAX_REPORT_BYTES,
  WORKBENCH_REPORT_RENDERER,
  escapeHtmlText,
  renderWorkbenchReport,
} from "./render.mjs";
import {
  INTERACTIVE_SCRIPT,
  INTERACTIVE_STYLE,
} from "./interactive-assets.mjs";

export const WORKBENCH_INTERACTIVE_REPORT_FORMAT =
  "dubsar.workbench-interactive-report/2";
export const WORKBENCH_INTERACTIVE_DATA_FORMAT =
  "dubsar.workbench-interactive-data/2";

export function cspHash(value) {
  return Buffer.from(
    sha256Bytes(Buffer.from(value, "utf8")),
    "hex",
  ).toString("base64");
}

export function encodeJsonForHtml(value) {
  return stableJson(value)
    .replaceAll("&", "\\u0026")
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

export function reviewSummary(reviewLedger) {
  if (reviewLedger === undefined || reviewLedger === null) {
    return null;
  }
  const ledger = reviewLedger.ledger;
  if (
    reviewLedger.format !== "dubsar.review-ledger-view/1" ||
    reviewLedger.authority !== WORKBENCH_AUTHORITY ||
    !ledger ||
    !new Set(["available", "degraded", "unavailable"]).has(ledger.status) ||
    !Number.isSafeInteger(ledger.valid_count) ||
    ledger.valid_count < 0 ||
    !Number.isSafeInteger(ledger.omitted_count) ||
    ledger.omitted_count < 0
  ) {
    throw new WorkbenchError("INTERACTIVE_REVIEW_VIEW_INVALID");
  }
  return Object.freeze({
    status: ledger.status,
    valid_count: ledger.valid_count,
    omitted_count: ledger.omitted_count,
  });
}

function statusFor(view) {
  if (view.integrity.status === "invalid") {
    return Object.freeze({ label: "Dossier invalide", className: "invalid" });
  }
  if (view.readiness.status === "ready") {
    return Object.freeze({ label: "Prêt", className: "ready" });
  }
  if (view.readiness.status === "unknown") {
    return Object.freeze({ label: "État à confirmer", className: "unknown" });
  }
  return Object.freeze({ label: "Action requise", className: "action" });
}

function nextActionFor(view) {
  return view.next_action.code === "approve_execution_contract"
    ? "Approuver le contrat d’exécution"
    : view.next_action.label;
}

function blockerFor(blocker) {
  return blocker.code === "EXECUTION_CONTRACT_NOT_APPROVED"
    ? "Le contrat d’exécution n’est pas encore approuvé."
    : blocker.title;
}

function countValue(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function memoryCategories(view) {
  return Object.freeze([
    Object.freeze({
      id: "decisions",
      label: "Décisions",
      included: true,
      count: view.decisions.length,
      source: "dossier canonique",
    }),
    Object.freeze({
      id: "learnings",
      label: "Apprentissages",
      included: false,
      count: 0,
      source: "mémoire privée non incluse",
    }),
    Object.freeze({
      id: "blockers",
      label: "Blocages",
      included: true,
      count: view.blockers.length,
      source: "dossier canonique",
    }),
    Object.freeze({
      id: "journal",
      label: "Journal",
      included: false,
      count: 0,
      source: "mémoire privée non incluse",
    }),
    Object.freeze({
      id: "evals",
      label: "Évaluations",
      included: false,
      count: 0,
      source: "mémoire privée non incluse",
    }),
  ]);
}

export function memoryProjection(memory) {
  const expected = Object.freeze([
    Object.freeze({ id: "decisions", label: "D\u00e9cisions" }),
    Object.freeze({ id: "learnings", label: "Apprentissages" }),
    Object.freeze({ id: "blockers", label: "Blocages" }),
    Object.freeze({ id: "journal", label: "Journal" }),
    Object.freeze({ id: "evals", label: "\u00c9valuations" }),
  ]);
  if (memory === undefined || memory === null) {
    return Object.freeze({
      format: "dubsar.personal-memory-presentation/1",
      authority: "private_advisory_snapshot",
      status: "not_included",
      snapshot_sha256: null,
      categories: Object.freeze(expected.map((definition) => Object.freeze({
        id: definition.id,
        label: definition.label,
        included: false,
        count: 0,
        source: "memoire privee non incluse",
        entries: Object.freeze([]),
      }))),
    });
  }
  if (
    !exactKeys(memory, [
      "authority",
      "canonical_authority",
      "categories",
      "format",
      "snapshot_sha256",
      "status",
    ]) ||
    memory.format !== "dubsar.personal-memory-snapshot/1" ||
    memory.authority !== "private_advisory_snapshot" ||
    memory.canonical_authority !== WORKBENCH_AUTHORITY ||
    memory.status !== "included" ||
    !/^[0-9a-f]{64}$/u.test(memory.snapshot_sha256) ||
    !Array.isArray(memory.categories) ||
    memory.categories.length !== expected.length
  ) {
    throw new WorkbenchError("INTERACTIVE_MEMORY_INVALID");
  }
  const presentationText = (value, maxChars) => {
    const checked = safeDisplayText(value, maxChars);
    if (
      checked.redacted ||
      checked.truncated ||
      checked.text !== value
    ) {
      throw new WorkbenchError("INTERACTIVE_MEMORY_INVALID");
    }
    return checked.text;
  };
  const categories = memory.categories.map((category, categoryIndex) => {
    const definition = expected.at(categoryIndex);
    if (
      !exactKeys(category, ["count", "entries", "id", "label"]) ||
      category.id !== definition.id ||
      category.label !== definition.label ||
      !Number.isSafeInteger(category.count) ||
      category.count < 0 ||
      category.count > 10 ||
      !Array.isArray(category.entries) ||
      category.entries.length !== category.count
    ) {
      throw new WorkbenchError("INTERACTIVE_MEMORY_INVALID");
    }
    const entries = category.entries.map((entry) => {
      if (
        !exactKeys(entry, ["date", "id", "links", "preview", "title"]) ||
        typeof entry.id !== "string" ||
        entry.id.length === 0 ||
        entry.id.length > 200 ||
        typeof entry.date !== "string" ||
        entry.date.length > 32 ||
        typeof entry.title !== "string" ||
        entry.title.length === 0 ||
        entry.title.length > 180 ||
        typeof entry.preview !== "string" ||
        entry.preview.length === 0 ||
        entry.preview.length > 320 ||
        !Array.isArray(entry.links) ||
        entry.links.length > 16 ||
        entry.links.some((link) => typeof link !== "string" || link.length === 0 || link.length > 160)
      ) {
        throw new WorkbenchError("INTERACTIVE_MEMORY_INVALID");
      }
      const id = presentationText(entry.id, 200);
      const date = presentationText(entry.date, 32);
      const title = presentationText(entry.title, 180);
      const preview = presentationText(entry.preview, 320);
      const links = entry.links.map((link) => presentationText(link, 160));
      return Object.freeze({
        id,
        date,
        title,
        preview,
        links: Object.freeze(links),
      });
    });
    return Object.freeze({
      id: category.id,
      label: definition.label,
      included: true,
      count: entries.length,
      source: "memoire privee opt-in",
      entries: Object.freeze(entries),
    });
  });
  return Object.freeze({
    format: "dubsar.personal-memory-presentation/1",
    authority: "private_advisory_snapshot",
    status: "included",
    snapshot_sha256: memory.snapshot_sha256,
    categories: Object.freeze(categories),
  });
}

export function interactiveProjectView(view) {
  return Object.freeze({
    format: view.format,
    overview: Object.freeze({
      title: view.overview.title,
      summary: view.overview.summary,
    }),
    blockers: Object.freeze(
      view.blockers.map((item) =>
        Object.freeze({ code: item.code, title: item.title }),
      ),
    ),
    decisions: Object.freeze(
      view.decisions.map((item) =>
        Object.freeze({ label: item.label, status: item.status }),
      ),
    ),
    evidence: Object.freeze(
      view.evidence.map((item) =>
        Object.freeze({ statement: item.statement, status: item.status }),
      ),
    ),
  });
}

export function graphProjection(graph, view) {
  const graphId = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
  const graphDetailToken = /^[a-z0-9][a-z0-9._-]{0,127}$/iu;
  const diagnosticCode = /^[A-Z][A-Z0-9_]{1,127}$/u;
  const nodeKinds = new Set([
    "mission",
    "lot",
    "contract",
    "evidence",
    "decision",
    "blocker",
  ]);
  const edgeKinds = new Set([
    "contains",
    "depends_on",
    "governs",
    "supports",
    "has_open_decision",
    "has_blocker",
  ]);
  const boundedText = (value) =>
    typeof value === "string" && value.length > 0 && value.length <= 2_000;
  const safeGraphToken = (value) => {
    const checked = safeStructuralText(value, 2_000);
    return !checked.redacted && !checked.truncated && checked.text === value;
  };
  const safeGraphDisplayText = (value) => {
    if (!boundedText(value)) return false;
    const displayChecked = safeDisplayText(value, 2_000);
    const structuralChecked = safeStructuralText(value, 2_000);
    return !displayChecked.redacted && !displayChecked.truncated &&
      displayChecked.text === value && !structuralChecked.redacted &&
      !structuralChecked.truncated && structuralChecked.text === value;
  };
  if (
    !graph ||
    !exactKeys(graph, [
      "authority",
      "diagnostics",
      "edges",
      "format",
      "nodes",
      "source_snapshot_sha256",
      "status",
    ]) ||
    graph.format !== WORKBENCH_GRAPH_FORMAT ||
    graph.authority !== WORKBENCH_AUTHORITY ||
    graph.source_snapshot_sha256 !== view.source.snapshot_sha256 ||
    !new Set(["available", "unavailable"]).has(graph.status) ||
    !Array.isArray(graph.nodes) ||
    !Array.isArray(graph.edges) ||
    !Array.isArray(graph.diagnostics) ||
    graph.nodes.length > 256 ||
    graph.edges.length > 512 ||
    graph.diagnostics.length > 256
  ) {
    throw new WorkbenchError("INTERACTIVE_GRAPH_INVALID");
  }
  const nodeIds = new Set();
  for (const node of graph.nodes) {
    if (
      !exactKeys(node, ["detail", "id", "kind", "label"]) ||
      !graphId.test(node.id) ||
      !safeGraphToken(node.id) ||
      !safeGraphDisplayText(node.label) ||
      (!["mission", "decision"].includes(node.kind)
        ? (!boundedText(node.detail) || !graphDetailToken.test(node.detail) ||
          !safeGraphToken(node.detail))
        : !safeGraphDisplayText(node.detail)) ||
      !nodeKinds.has(node.kind) ||
      nodeIds.has(node.id)
    ) {
      throw new WorkbenchError("INTERACTIVE_GRAPH_INVALID");
    }
    nodeIds.add(node.id);
  }
  for (const edge of graph.edges) {
    if (
      !exactKeys(edge, ["from", "id", "kind", "to"]) ||
      !graphId.test(edge.id) ||
      !safeGraphToken(edge.id) ||
      !graphId.test(edge.from) ||
      !safeGraphToken(edge.from) ||
      !graphId.test(edge.to) ||
      !safeGraphToken(edge.to) ||
      !edgeKinds.has(edge.kind) ||
      !nodeIds.has(edge.from) ||
      !nodeIds.has(edge.to)
    ) {
      throw new WorkbenchError("INTERACTIVE_GRAPH_INVALID");
    }
  }
  if (
    graph.diagnostics.some(
      (item) =>
        !exactKeys(item, ["code", "severity"]) ||
        !diagnosticCode.test(item.code) ||
        !safeGraphToken(item.code) ||
        item.severity !== "warning",
    ) ||
    (graph.status === "unavailable" &&
      (graph.nodes.length !== 0 || graph.edges.length !== 0))
  ) {
    throw new WorkbenchError("INTERACTIVE_GRAPH_INVALID");
  }
  return Object.freeze({
    format: WORKBENCH_GRAPH_FORMAT,
    status: graph.status,
    nodes: Object.freeze(
      graph.nodes.map((node) =>
        Object.freeze({
          id: node.id,
          kind: node.kind,
          label: node.label,
          detail: node.detail,
        }),
      ),
    ),
    edges: Object.freeze(
      graph.edges.map((edge) =>
        Object.freeze({
          id: edge.id,
          from: edge.from,
          to: edge.to,
          kind: edge.kind,
        }),
      ),
    ),
    diagnostics: Object.freeze(
      graph.diagnostics.map((item) =>
        Object.freeze({ code: item.code, severity: item.severity }),
      ),
    ),
  });
}

function interactiveData(view, reviews, graph, memory) {
  return Object.freeze({
    format: WORKBENCH_INTERACTIVE_DATA_FORMAT,
    authority: WORKBENCH_AUTHORITY,
    view: interactiveProjectView(view),
    graph,
    reviews,
    memory,
  });
}

function memoryLines(categories) {
  return categories.flatMap((category, index) => {
    const entries = category.entries.flatMap((entry) => [
      "            <li class=\"memory-preview\">",
      `              <span>${escapeHtmlText(entry.date)}</span>`,
      `              <strong>${escapeHtmlText(entry.title)}</strong>`,
      `              <p>${escapeHtmlText(entry.preview)}</p>`,
      "            </li>",
    ]);
    return [
      "      <li class=\"memory-item\">",
      `        <span class="memory-index" aria-hidden="true">${String(index + 1).padStart(2, "0")}</span>`,
      "        <span class=\"memory-copy\">",
      `          <strong>${escapeHtmlText(category.label)}</strong>`,
      `          <span>${escapeHtmlText(category.source)}</span>`,
      "        </span>",
      category.included
        ? `        <span class="memory-count">${category.count} élément${category.count === 1 ? "" : "s"}</span>`
        : "        <span class=\"memory-count pending\">Non inclus</span>",
      ...(entries.length === 0
        ? []
        : [
            "        <details class=\"memory-previews\">",
            "          <summary>Aperçus récents</summary>",
            "          <ol>",
            ...entries,
            "          </ol>",
            "        </details>",
          ]),
      "      </li>",
    ];
  });
}

function decisionLines(decisions) {
  if (decisions.length === 0) {
    return ["      <li class=\"empty-state\">Aucune décision ouverte dans cet instantané.</li>"];
  }
  return decisions.flatMap((decision, index) => [
    "      <li class=\"decision-item\">",
    `        <span class="decision-index">${index + 1}</span>`,
    "        <span class=\"decision-copy\">",
    `          <strong>${escapeHtmlText(decision.label)}</strong>`,
    "          <span>Décision enregistrée dans le dossier local</span>",
    "        </span>",
    `        <span class="decision-state">${decision.status === "open" ? "Ouverte" : escapeHtmlText(decision.status)}</span>`,
    "      </li>",
  ]);
}

function graphChoiceLines(graph, memory) {
  const canonicalChoices = graph.status === "available"
    ? [...graph.nodes].sort((left, right) => {
        if (left.kind === "mission") return -1;
        if (right.kind === "mission") return 1;
        return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
      }).map((node) => ({ ...node, scope: "project" }))
    : [];
  const memoryChoices = memory.status === "included"
    ? memory.categories.flatMap((category) => [
        {
          id: `memory-category-${category.id}`,
          label: category.label,
          scope: `memory-${category.id}`,
        },
        ...category.entries.map((entry) => ({
          id: entry.id,
          label: entry.title,
          scope: `memory-${category.id}`,
        })),
      ])
    : [];
  const choices = [...canonicalChoices, ...memoryChoices];
  if (choices.length === 0) {
    return [
      "          <li class=\"empty-state\">Graph indisponible pour cet instantane.</li>",
    ];
  }
  return choices.map(
    (choice, index) =>
      `          <li data-node-scope="${escapeHtmlText(choice.scope)}"${choice.scope === "project" ? "" : " hidden"}><button type="button" class="graph-node-choice" data-node-id="${escapeHtmlText(choice.id)}" aria-current="${index === 0}">${escapeHtmlText(choice.label)}</button></li>`,
  );
}

function graphScopeLines(graph, memory) {
  const projectCount = graph.status === "available" ? graph.nodes.length : 1;
  const lines = [
    `        <button type="button" class="graph-scope-button" data-graph-scope="project" aria-pressed="true"><span>Projet</span><strong>${projectCount}</strong></button>`,
  ];
  if (memory.status !== "included") return lines;
  for (const category of memory.categories) {
    lines.push(
      `        <button type="button" class="graph-scope-button" data-graph-scope="memory-${escapeHtmlText(category.id)}" aria-pressed="false"><span>${escapeHtmlText(category.label)}</span><strong>${category.count}</strong></button>`,
    );
  }
  return lines;
}

function graphSummaryLines(graph) {
  const nodes = graph.status === "available" ? graph.nodes : [];
  const lots = nodes.filter((node) => node.kind === "lot");
  const completeLots = lots.filter((node) => node.detail === "complete").length;
  const blockerCount = nodes.filter((node) => node.kind === "blocker").length;
  const decisionCount = nodes.filter((node) => node.kind === "decision").length;
  const contract = nodes.find((node) => node.kind === "contract");
  const contractStatus = contract?.detail === "draft"
    ? "Brouillon"
    : contract?.detail === "approved"
      ? "Approuvé"
      : contract?.detail ?? "Absent";
  return [
    `        <li><strong>${completeLots}/${lots.length}</strong><span>Lots terminés</span></li>`,
    `        <li><strong>${blockerCount}</strong><span>Blocage${blockerCount === 1 ? "" : "s"}</span></li>`,
    `        <li><strong>${decisionCount}</strong><span>Décisions ouvertes</span></li>`,
    `        <li><strong>${escapeHtmlText(contractStatus)}</strong><span>Contrat</span></li>`,
  ];
}

function technicalFormatLines(formats) {
  return formats.map((format) => escapeHtmlText(format)).join(", ");
}

function renderInteractiveDocument(view, reviews, graph, memory, dataJson) {
  const status = statusFor(view);
  const categories = memory.categories;
  const lotsComplete = countValue(view.overview.counts.complete_lots);
  const lotsTotal = countValue(view.overview.counts.lots);
  const blockerText =
    view.blockers.length === 0
      ? "Aucun blocage enregistré."
      : blockerFor(view.blockers.at(0));
  const reviewSignal =
    reviews === null
      ? []
      : [
          "          <li><span>Avis consultatifs valides</span>",
          `            <strong>${reviews.valid_count}</strong></li>`,
        ];
  const styleHash = cspHash(INTERACTIVE_STYLE);
  const scriptHash = cspHash(INTERACTIVE_SCRIPT);
  const sourceId = view.source.id ?? "non affiché";

  return [
    "<!doctype html>",
    "<html lang=\"fr\" data-runtime=\"fallback\">",
    "<head>",
    "  <meta charset=\"utf-8\">",
    "  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">",
    "  <meta name=\"referrer\" content=\"no-referrer\">",
    `  <meta http-equiv="Content-Security-Policy" content="base-uri 'none'; connect-src 'none'; default-src 'none'; font-src 'none'; form-action 'none'; frame-src 'none'; img-src 'none'; manifest-src 'none'; media-src 'none'; object-src 'none'; script-src 'sha256-${scriptHash}'; script-src-attr 'none'; style-src 'sha256-${styleHash}'; style-src-attr 'none'; worker-src 'none'">`,
    "  <meta name=\"color-scheme\" content=\"dark\">",
    "  <title>DUBSAR Workbench — Vue locale</title>",
    `  <style>${INTERACTIVE_STYLE}</style>`,
    "</head>",
    "<body>",
    "<div class=\"app-shell\" id=\"app-shell\">",
    "  <aside class=\"rail\" aria-label=\"Navigation principale\">",
    "    <div class=\"brand\">DUBSAR</div>",
    "    <nav class=\"nav-list\" role=\"tablist\" aria-label=\"Vues du Workbench\">",
    "      <button type=\"button\" class=\"nav-button\" data-view=\"dashboard\" role=\"tab\" aria-controls=\"dashboard-view\" aria-selected=\"true\">Dashboard</button>",
    "      <button type=\"button\" class=\"nav-button\" data-view=\"graph\" role=\"tab\" aria-controls=\"graph-view\" aria-selected=\"false\">Graph</button>",
    "    </nav>",
    "    <div class=\"rail-meta\">",
    "      <div class=\"offline-line\"><span class=\"offline-dot\" aria-hidden=\"true\"></span><span>Local / Hors ligne</span></div>",
    `      <div>Instantané <span class="snapshot-code">${escapeHtmlText(view.source.snapshot_sha256.slice(0, 10))}</span></div>`,
    "    </div>",
    "  </aside>",
    "  <main class=\"workspace\">",
    "    <section id=\"dashboard-view\" role=\"tabpanel\" aria-label=\"Dashboard\">",
    "      <header class=\"project-header\">",
    "        <div class=\"project-topline\">",
    "          <span class=\"project-kicker\">Projet</span>",
    "          <span class=\"snapshot-note\">Instantané local — régénérer pour actualiser</span>",
    "        </div>",
    `        <h1>${escapeHtmlText(view.overview.title)}</h1>`,
    "        <div class=\"state-row\">",
    "          <div class=\"state-block\">",
    "            <span class=\"state-label\">État humain</span>",
    `            <strong class="state-value">${escapeHtmlText(status.label)}</strong>`,
    `            <span class="state-detail">Intégrité ${view.integrity.status === "valid" ? "validée" : "à corriger"}</span>`,
    "          </div>",
    "          <div class=\"state-block blocked\">",
    "            <span class=\"state-label\">Blocage</span>",
    `            <strong class="state-value">${escapeHtmlText(view.blockers.length === 0 ? "Aucun" : "À résoudre")}</strong>`,
    `            <span class="state-detail">${escapeHtmlText(blockerText)}</span>`,
    "          </div>",
    "        </div>",
    "      </header>",
    "      <section class=\"next-section\" aria-labelledby=\"next-action-heading\">",
    "        <span class=\"section-label\" id=\"next-action-heading\">Prochaine action</span>",
    "        <div class=\"next-action\">",
    "          <span class=\"next-action-bar\" aria-hidden=\"true\"></span>",
    "          <span class=\"next-action-copy\">",
    `            <strong>${escapeHtmlText(nextActionFor(view))}</strong>`,
    `            <span>${escapeHtmlText(view.next_action.label)}</span>`,
    "          </span>",
    "          <span class=\"next-action-tag\">Lecture seule</span>",
    "        </div>",
    "      </section>",
    "      <section class=\"signal-grid\" aria-label=\"État et progression\">",
    "        <div class=\"signal-column\">",
    "          <span class=\"signal-label\">Intégrité du projet</span>",
    `          <strong class="health-value${view.integrity.status === "valid" ? "" : " invalid"}">${view.integrity.status === "valid" ? "Valide" : "À corriger"}</strong>`,
    "          <div class=\"progress-line\">",
    `            <strong>${lotsComplete} / ${lotsTotal} lots</strong>`,
    "            <span>Progression enregistrée</span>",
    "          </div>",
    `          <progress max="${Math.max(lotsTotal, 1)}" value="${Math.min(lotsComplete, Math.max(lotsTotal, 1))}">${lotsComplete} sur ${lotsTotal}</progress>`,
    "        </div>",
    "        <div class=\"signal-column\">",
    "          <span class=\"signal-label\">Signaux disponibles</span>",
    "          <ul class=\"signal-list\">",
    `            <li><span>Éléments de preuve</span><strong>${view.evidence.length}</strong></li>`,
    `            <li><span>Décisions ouvertes</span><strong>${view.decisions.length}</strong></li>`,
    `            <li><span>Blocages</span><strong>${view.blockers.length}</strong></li>`,
    ...reviewSignal,
    "          </ul>",
    "        </div>",
    "      </section>",
    "      <section class=\"decisions-section\" aria-labelledby=\"decisions-heading\">",
    "        <span class=\"section-label\" id=\"decisions-heading\">Décisions ouvertes</span>",
    "        <ol class=\"decision-list\">",
    ...decisionLines(view.decisions),
    "        </ol>",
    "      </section>",
    "      <details class=\"technical\">",
    "        <summary>Détails techniques et traçabilité</summary>",
    "        <dl>",
    `          <dt>Autorité</dt><dd>${escapeHtmlText(view.authority)}</dd>`,
    `          <dt>Domaine</dt><dd>${escapeHtmlText(view.source.domain)}</dd>`,
    `          <dt>Source</dt><dd>${escapeHtmlText(sourceId)}</dd>`,
    `          <dt>Empreinte</dt><dd><code>${escapeHtmlText(view.source.snapshot_sha256)}</code></dd>`,
    `          <dt>Formats</dt><dd>${technicalFormatLines(view.source.formats)}</dd>`,
    `          <dt>État brut</dt><dd>integrity=${escapeHtmlText(view.integrity.status)} · readiness=${escapeHtmlText(view.readiness.status)}</dd>`,
    "        </dl>",
    "      </details>",
    "    </section>",
    "    <section id=\"graph-view\" class=\"graph-view\" role=\"tabpanel\" aria-label=\"Graph\" hidden>",
    "      <header class=\"graph-header\">",
    "        <div>",
    "          <span class=\"graph-kicker\">Vue relationnelle</span>",
    "          <h1>Graph du projet</h1>",
    "          <p>Commence par l’état du projet. Affiche ensuite une seule catégorie de mémoire à la fois pour explorer sans perdre le fil.</p>",
    "        </div>",
    "        <div class=\"graph-toolbar\" aria-label=\"Contrôles du graph\">",
    "          <button type=\"button\" class=\"tool-button\" id=\"graph-zoom-out\" aria-label=\"Réduire le graph\">−</button>",
    "          <button type=\"button\" class=\"tool-button\" id=\"graph-reset\">Centrer</button>",
    "          <button type=\"button\" class=\"tool-button\" id=\"graph-zoom-in\" aria-label=\"Agrandir le graph\">+</button>",
    "        </div>",
    "      </header>",
    "      <ul class=\"graph-summary\" aria-label=\"Résumé du projet\">",
    ...graphSummaryLines(graph),
    "      </ul>",
    "      <div class=\"graph-scope-bar\" role=\"group\" aria-label=\"Contenu affiché dans le graph\">",
    ...graphScopeLines(graph, memory),
    "      </div>",
    "      <div class=\"graph-layout\">",
    "        <div class=\"canvas-wrap\">",
    "          <canvas id=\"graph-canvas\" aria-label=\"Graph interactif du projet. Utiliser les filtres et la liste adjacente pour parcourir les nœuds au clavier.\"></canvas>",
    "        </div>",
    "        <aside class=\"graph-details\" aria-live=\"polite\">",
    "          <span class=\"graph-kicker\" id=\"graph-detail-kind\">project</span>",
    `          <h2 id="graph-detail-title">${escapeHtmlText(view.overview.title)}</h2>`,
    `          <p id="graph-detail-text">${escapeHtmlText(view.overview.summary)}</p>`,
    "          <p class=\"graph-detail-relations\" id=\"graph-detail-relations\"></p>",
    "          <ul class=\"graph-node-list\" aria-label=\"Nœuds affichés dans le graph\">",
    ...graphChoiceLines(graph, memory),
    "          </ul>",
    "        </aside>",
    "      </div>",
    "    </section>",
    "  </main>",
    "  <aside class=\"memory-panel\" id=\"memory-panel\" aria-labelledby=\"memory-heading\">",
    "    <h2 class=\"memory-title\" id=\"memory-heading\">Mémoire du projet</h2>",
    "    <ol class=\"memory-list\">",
    ...memoryLines(categories),
    "    </ol>",
    `    <p class="memory-warning">${memory.status === "included" ? "Mémoire privée incluse sur consentement pour ce rapport. Partager ce fichier partage aussi ces aperçus." : "La mémoire personnelle n’est pas incluse. Utiliser explicitement l’option mémoire lors de la génération pour l’ajouter."}</p>`,
    "  </aside>",
    "</div>",
    `  <script id="workbench-data" type="application/json">${dataJson}</script>`,
    `  <script>${INTERACTIVE_SCRIPT}</script>`,
    "</body>",
    "</html>",
    "",
  ].join("\n");
}

export function renderWorkbenchInteractiveReport(view, options = {}) {
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

  renderWorkbenchReport(view);
  const reviews = reviewSummary(options.reviewLedger);
  const graph = graphProjection(options.graph, view);
  const memory = memoryProjection(options.memory);
  const dataJson = encodeJsonForHtml(interactiveData(view, reviews, graph, memory));
  const html = renderInteractiveDocument(view, reviews, graph, memory, dataJson);
  const bytes = Buffer.byteLength(html, "utf8");
  if (bytes > maxBytes) {
    throw new WorkbenchError("REPORT_SIZE_LIMIT_EXCEEDED");
  }
  const buffer = Buffer.from(html, "utf8");
  return Object.freeze({
    html,
    manifest: Object.freeze({
      format: WORKBENCH_INTERACTIVE_REPORT_FORMAT,
      authority: WORKBENCH_AUTHORITY,
      renderer: WORKBENCH_REPORT_RENDERER,
      source_snapshot_sha256: view.source.snapshot_sha256,
      view_format: view.format,
      graph_format: graph.format,
      memory_included: memory.status === "included",
      memory_snapshot_sha256: memory.snapshot_sha256,
      view_producer: Object.freeze({
        name: view.producer.name,
        version: view.producer.version,
      }),
      bytes,
      sha256: sha256Bytes(buffer),
      script_sha256: sha256Bytes(Buffer.from(INTERACTIVE_SCRIPT, "utf8")),
      style_sha256: sha256Bytes(Buffer.from(INTERACTIVE_STYLE, "utf8")),
      data_sha256: sha256Bytes(Buffer.from(dataJson, "utf8")),
    }),
  });
}
