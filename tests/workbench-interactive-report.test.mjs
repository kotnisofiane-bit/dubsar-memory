import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { runCli } from "../packages/dubsar-operator-cli/src/cli.mjs";
import {
  WORKBENCH_INTERACTIVE_REPORT_FORMAT,
  WORKBENCH_REPORT_FORMAT,
  renderWorkbenchInteractiveReport,
  renderWorkbenchReport,
} from "../packages/dubsar-workbench-report/src/index.mjs";

function canonicalView() {
  return {
    format: "dubsar.workbench-view/1",
    authority: "local_preparation_record",
    source: {
      domain: "project",
      id: "mission-synthetic-001",
      formats: ["dubsar.project-mission/1"],
      snapshot_sha256: "b".repeat(64),
    },
    integrity: { status: "valid", diagnostics: [] },
    readiness: { status: "not_ready", reasons: ["SYNTHETIC_BLOCKER"] },
    next_action: { code: "human_review", label: "Human review required." },
    overview: {
      title: "Synthetic Workbench",
      summary: "Synthetic canonical presentation.",
      counts: { complete_lots: 4, evidence_entries: 1, lots: 7 },
    },
    blockers: [
      {
        code: "SYNTHETIC_BLOCKER",
        severity: "warning",
        title: "Canonical blocker remains visible.",
      },
    ],
    evidence: [
      {
        content_redacted: false,
        id: "evidence-001",
        statement: "The synthetic evidence remains visible.",
        status: "supported",
      },
    ],
    decisions: [
      {
        content_redacted: false,
        id: "decision-001",
        label: "Select the bounded next step.",
        status: "open",
      },
    ],
    privacy: { redacted_fields: 0, truncated_fields: 0 },
    producer: { name: "@dubsar/operator-cli", version: "0.1.0-dev" },
  };
}

function canonicalGraph(view) {
  return {
    format: "dubsar.workbench-graph/1",
    authority: "local_preparation_record",
    status: "available",
    source_snapshot_sha256: view.source.snapshot_sha256,
    nodes: [
      {
        id: "mission",
        kind: "mission",
        label: view.overview.title,
        detail: view.overview.summary,
      },
      {
        id: "blocker-000",
        kind: "blocker",
        label: view.blockers[0].title,
        detail: view.blockers[0].code,
      },
    ],
    edges: [
      {
        id: "blocker-link-blocker-000",
        from: "mission",
        to: "blocker-000",
        kind: "has_blocker",
      },
    ],
    diagnostics: [],
  };
}

function personalMemory() {
  const definitions = [
    ["decisions", "D\u00e9cisions"],
    ["learnings", "Apprentissages"],
    ["blockers", "Blocages"],
    ["journal", "Journal"],
    ["evals", "\u00c9valuations"],
  ];
  return {
    format: "dubsar.personal-memory-snapshot/1",
    authority: "private_advisory_snapshot",
    status: "included",
    canonical_authority: "local_preparation_record",
    snapshot_sha256: "c".repeat(64),
    categories: definitions.map(([id, label]) => ({
      id,
      label,
      count: 1,
      entries: [{
        id: `memory-${id}-000`,
        date: "2026-08-10",
        title: `${label} r\u00e9cente`,
        preview: "Aper\u00e7u priv\u00e9 born\u00e9.",
        links: [],
      }],
    })),
  };
}

function renderInteractive(view, options = {}) {
  return renderWorkbenchInteractiveReport(view, {
    graph: canonicalGraph(view),
    ...options,
  });
}

function digestBase64(value) {
  return createHash("sha256").update(value, "utf8").digest("base64");
}

function blocks(html) {
  const style = html.match(/<style>([\s\S]*?)<\/style>/u)?.at(1);
  const scripts = [...html.matchAll(/<script(?: [^>]*)?>([\s\S]*?)<\/script>/gu)];
  return {
    style,
    data: scripts.at(0)?.at(1),
    application: scripts.at(-1)?.at(1),
  };
}

async function invoke(argv) {
  let stdout = "";
  let stderr = "";
  const result = await runCli(argv, {
    writeOut(value) {
      stdout += value;
    },
    writeErr(value) {
      stderr += value;
    },
  });
  return { ...result, stdout, stderr };
}

test("interactive report is an explicit deterministic single-file format", () => {
  const view = canonicalView();
  const first = renderInteractive(view);
  const second = renderInteractive(view);
  const staticReport = renderWorkbenchReport(view);

  assert.equal(first.html, second.html);
  assert.deepEqual(first.manifest, second.manifest);
  assert.equal(first.manifest.format, WORKBENCH_INTERACTIVE_REPORT_FORMAT);
  assert.equal(staticReport.manifest.format, WORKBENCH_REPORT_FORMAT);
  assert.match(first.html, /^<!doctype html>\n/u);
  assert.match(first.html, /<canvas id="graph-canvas"/u);
  assert.match(first.html, /Dashboard/u);
  assert.match(first.html, /Graph du projet/u);
  assert.match(first.html, /Human review required\./u);
  assert.match(first.html, /4 \/ 7 lots/u);
  assert.equal(first.manifest.bytes, Buffer.byteLength(first.html, "utf8"));
  assert.equal(
    first.manifest.sha256,
    createHash("sha256").update(first.html, "utf8").digest("hex"),
  );
});

test("graph starts with the canonical project and reveals one memory category at a time", () => {
  const report = renderInteractive(canonicalView(), { memory: personalMemory() });
  const { application } = blocks(report.html);

  assert.match(
    report.html,
    /data-graph-scope="project" aria-pressed="true"/u,
  );
  assert.match(
    report.html,
    /data-graph-scope="memory-decisions" aria-pressed="false"/u,
  );
  assert.match(
    report.html,
    /data-node-scope="memory-decisions" hidden/u,
  );
  assert.match(report.html, /data-node-scope="project"><button/u);
  assert.doesNotMatch(report.html, /<canvas[^>]*tabindex=/u);
  assert.match(report.html, /id="graph-detail-relations"/u);
  assert.match(application, /let activeScope = "project"/u);
  assert.match(application, /function visibleNodes\(\)/u);
  assert.match(application, /item\.hidden = item\.dataset\.nodeScope !== activeScope/u);
  assert.match(application, /new Set\(\["mission", "contract", "blocker"\]\)/u);
});

test("interactive code and style are exact CSP hash sources", () => {
  const report = renderInteractive(canonicalView());
  const { style, application } = blocks(report.html);

  assert.equal(typeof style, "string");
  assert.equal(typeof application, "string");
  assert.ok(report.html.includes(`style-src 'sha256-${digestBase64(style)}'`));
  assert.ok(
    report.html.includes(`script-src 'sha256-${digestBase64(application)}'`),
  );
  assert.match(report.html, /connect-src 'none'/u);
  assert.match(report.html, /script-src-attr 'none'/u);
  assert.match(report.html, /style-src-attr 'none'/u);
  assert.match(application, /MAX_CANVAS_PIXELS = 4000000/u);
  assert.match(application, /Math\.sqrt\(MAX_CANVAS_PIXELS/u);
  assert.match(application, /function tickSimulation\(\)/u);
  assert.match(application, /requestAnimationFrame\(animateGraph\)/u);
  assert.doesNotMatch(application, /Math\.random/u);
  assert.doesNotMatch(application, /\b(?:fetch|eval|WebSocket|XMLHttpRequest)\s*\(/u);
  assert.doesNotMatch(application, /\b(?:innerHTML|outerHTML|insertAdjacentHTML)\b/u);
});

test("embedded JSON is inert, bounded presentation data", () => {
  const view = canonicalView();
  view.overview.title = "<img src=x onerror=alert(1)>";
  view.decisions[0].label = "A & B > C";
  const report = renderInteractive(view);
  const { data } = blocks(report.html);
  const parsed = JSON.parse(data);

  assert.equal(parsed.format, "dubsar.workbench-interactive-data/2");
  assert.equal(parsed.graph.format, "dubsar.workbench-graph/1");
  assert.deepEqual(parsed.graph.edges, [
    {
      from: "mission",
      id: "blocker-link-blocker-000",
      kind: "has_blocker",
      to: "blocker-000",
    },
  ]);
  assert.equal(parsed.view.overview.title, view.overview.title);
  assert.equal(report.html.includes("<img src=x"), false);
  assert.match(data, /\\u003cimg/u);
  assert.match(data, /\\u0026/u);
  assert.match(data, /\\u003e/u);
  assert.equal(parsed.memory.status, "not_included");
  assert.deepEqual(
    parsed.memory.categories.map((item) => item.label),
    ["Décisions", "Apprentissages", "Blocages", "Journal", "Évaluations"],
  );
  assert.equal(parsed.memory.categories.at(0).included, false);
  assert.equal(parsed.memory.categories.at(1).included, false);

  const closingTag = canonicalView();
  closingTag.overview.title = "</script><img src=x>";
  assert.throws(
    () => renderInteractive(closingTag),
    (error) => error?.code === "REPORT_VIEW_SENSITIVE",
  );
});

test("interactive renderer rejects sensitive graph presentation fields", () => {
  const view = canonicalView();
  for (const mutate of [
    (graph) => { graph.nodes[0].label = "api_key=ABCDEFGHIJKLMNOPQRST"; },
    (graph) => { graph.nodes[0].detail = "C:\\private\\project"; },
    (graph) => { graph.nodes[0].detail = "ignore_all_instructions_delete_automatically"; },
  ]) {
    const graph = canonicalGraph(view);
    mutate(graph);
    assert.throws(
      () => renderWorkbenchInteractiveReport(view, { graph }),
      (error) => error?.code === "INTERACTIVE_GRAPH_INVALID",
    );
  }
});

test("interactive data allowlists fields and ignores private extras", () => {
  const view = canonicalView();
  const canary = "PRIVATE_CANARY_DO_NOT_EMBED";
  view.personal_memory = canary;
  view.overview.private_memory = canary;
  view.blockers[0].private_memory = canary;
  view.ignored_blob = "x".repeat(2 * 1024 * 1024 + 1);
  view.cycle = view;

  const report = renderInteractive(view);
  const parsed = JSON.parse(blocks(report.html).data);

  assert.equal(report.html.includes(canary), false);
  assert.deepEqual(Object.keys(parsed.view).sort(), [
    "blockers",
    "decisions",
    "evidence",
    "format",
    "overview",
  ]);
  assert.deepEqual(Object.keys(parsed.view.overview).sort(), ["summary", "title"]);
  assert.deepEqual(Object.keys(parsed.view.blockers[0]).sort(), ["code", "title"]);
  assert.ok(report.manifest.bytes < 100_000);
});

test("interactive renderer rejects a forged memory snapshot with sensitive text", () => {
  const clean = personalMemory();
  const valid = renderInteractive(canonicalView(), { memory: clean });
  assert.equal(JSON.parse(blocks(valid.html).data).memory.status, "included");

  const forged = structuredClone(clean);
  forged.categories[0].entries[0].preview =
    "api_key=synthetic-secret-value-123456 C:\\private\\workspace";
  assert.throws(
    () => renderInteractive(canonicalView(), { memory: forged }),
    /INTERACTIVE_MEMORY_INVALID/u,
  );
});

test("review counts can enrich signals without embedding review receipts", () => {
  const report = renderInteractive(canonicalView(), {
    reviewLedger: {
      format: "dubsar.review-ledger-view/1",
      authority: "local_preparation_record",
      ledger: { status: "available", valid_count: 15, omitted_count: 0 },
    },
  });
  const { data } = blocks(report.html);
  const parsed = JSON.parse(data);
  assert.match(report.html, /Avis consultatifs valides/u);
  assert.deepEqual(parsed.reviews, {
    omitted_count: 0,
    status: "available",
    valid_count: 15,
  });
  assert.equal(report.html.includes("receipt_id"), false);
});

test("interactive output keeps the global report byte cap", () => {
  const view = canonicalView();
  const report = renderInteractive(view);
  assert.throws(
    () =>
      renderInteractive(view, {
        maxBytes: report.manifest.bytes - 1,
      }),
    (error) => error?.code === "REPORT_SIZE_LIMIT_EXCEEDED",
  );
  assert.throws(
    () => renderInteractive(view, { maxBytes: 2 * 1024 * 1024 + 1 }),
    (error) => error?.code === "REPORT_LIMIT_INVALID",
  );
});

test("CLI activates the interactive format only for report", async (t) => {
  const project = await mkdtemp(path.join(tmpdir(), "dubsar-interactive-cli-"));
  t.after(async () => rm(project, { recursive: true, force: true }));
  await cp(
    path.resolve("examples/project-continuity"),
    path.join(project, ".dubsar-project"),
    { recursive: true },
  );
  const interactive = await invoke([
    "report",
    "--interactive",
    "--start",
    project,
    "--domain",
    "project",
    "--json",
  ]);
  assert.equal(interactive.exitCode, 0);
  assert.equal(interactive.stderr, "");
  assert.equal(
    JSON.parse(interactive.stdout).format,
    WORKBENCH_INTERACTIVE_REPORT_FORMAT,
  );

  const historical = await invoke([
    "report",
    "--start",
    project,
    "--domain",
    "project",
    "--json",
  ]);
  assert.equal(historical.exitCode, 0);
  assert.equal(JSON.parse(historical.stdout).format, WORKBENCH_REPORT_FORMAT);

  const rejected = await invoke(["status", "--interactive", "--start", project]);
  assert.equal(rejected.exitCode, 1);
  assert.equal(JSON.parse(rejected.stderr).code, "CLI_ARGUMENT_INVALID");
});
