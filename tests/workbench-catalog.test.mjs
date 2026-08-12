import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  WorkbenchError,
  assertResumeCapsule,
  buildResumeCapsule,
  createProjectRegistry,
  inspectProjectCatalog,
  inspectProjectContinuityCatalog,
  loadProjectRegistry,
  stableJson,
} from "../packages/dubsar-operator-core/src/index.mjs";
import { isProjectId } from "../packages/dubsar-operator-core/src/project-identifiers.mjs";
import {
  renderWorkbenchCatalogInteractiveReport,
  renderWorkbenchContinuityInteractiveReport,
} from "../packages/dubsar-workbench-report/src/index.mjs";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const producer = Object.freeze({ name: "catalog-test", version: "1.0.0" });
const PHONE_LIKE_PROJECT_ID = "project-3d49ecd9-0294-4202-90c8-c2529005e143";

function deterministicProjectId(index) {
  const hex = createHash("sha256").update(`dubsar-project-id-${index}`).digest("hex");
  return `project-${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function embeddedWorkbenchData(report) {
  const source = report.html.match(
    /<script id="workbench-data" type="application\/json">([\s\S]*?)<\/script>/u,
  )?.at(1);
  assert.equal(typeof source, "string");
  return JSON.parse(source);
}

async function projectFixture(t, count = 3) {
  const root = await mkdtemp(path.join(tmpdir(), "dubsar-catalog-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const projects = [];
  for (let index = 0; index < count; index += 1) {
    const project = path.join(root, `project-${index + 1}`);
    await mkdir(path.join(project, ".git"), { recursive: true });
    await cp(
      path.join(repositoryRoot, "examples", "project-continuity"),
      path.join(project, ".dubsar-project"),
      { recursive: true },
    );
    projects.push({ project_id: `project-${index + 1}`, root: project });
  }
  return { root, projects };
}

test("project registry is closed, bounded, and rejects nested roots", async (t) => {
  const item = await projectFixture(t, 2);
  const registry = createProjectRegistry(item.projects);
  assert.equal(registry.projects.length, 2);
  assert.throws(
    () => createProjectRegistry([
      item.projects[0],
      { project_id: "nested-project", root: path.join(item.projects[0].root, "child") },
    ]),
    (error) => error instanceof WorkbenchError && error.code === "PROJECT_REGISTRY_NESTED_ROOTS",
  );
  assert.throws(
    () => createProjectRegistry([{ ...item.projects[0], extra: true }]),
    (error) => error instanceof WorkbenchError && error.code === "PROJECT_REGISTRY_INVALID",
  );
  assert.throws(
    () => createProjectRegistry([item.projects[0], { ...item.projects[0], project_id: "duplicate-root" }]),
    (error) => error instanceof WorkbenchError && error.code === "PROJECT_REGISTRY_DUPLICATE",
  );
  assert.throws(
    () => createProjectRegistry([item.projects[0], { ...item.projects[1], project_id: item.projects[0].project_id }]),
    (error) => error instanceof WorkbenchError && error.code === "PROJECT_REGISTRY_DUPLICATE",
  );
  if (process.platform === "win32") {
    assert.throws(
      () => createProjectRegistry([{ project_id: "network-root", root: "\\\\server\\share\\project" }]),
      (error) => error instanceof WorkbenchError && error.code === "PROJECT_REGISTRY_ROOT_UNSUPPORTED",
    );
  }
});

test("corrupted registries fail closed without exposing their contents", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "dubsar-registry-corrupt-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const registryPath = path.join(root, "projects.json");
  await writeFile(registryPath, "{not-json PRIVATE_REGISTRY_CANARY", "utf8");
  await assert.rejects(
    () => loadProjectRegistry(registryPath),
    (error) => error instanceof WorkbenchError && error.code === "PROJECT_REGISTRY_INVALID" && !error.message.includes("PRIVATE_REGISTRY_CANARY"),
  );
});

test("Unicode roots remain usable and path-private", async (t) => {
  const item = await projectFixture(t, 0);
  const unicodeRoot = path.join(item.root, "Projet-équipe-東京");
  await mkdir(path.join(unicodeRoot, ".git"), { recursive: true });
  await cp(
    path.join(repositoryRoot, "examples", "project-continuity"),
    path.join(unicodeRoot, ".dubsar-project"),
    { recursive: true },
  );
  const catalog = await inspectProjectCatalog({
    entries: [{ project_id: "unicode-project", root: unicodeRoot }],
    includeReviews: false,
    producer,
  });
  assert.equal(catalog.summary.available, 1);
  assert.equal(stableJson(catalog).includes(unicodeRoot), false);
});

test("a linked project root degrades to unavailable when the platform supports junctions", async (t) => {
  const item = await projectFixture(t, 1);
  const linkedRoot = path.join(item.root, "linked-project");
  try {
    await symlink(item.projects[0].root, linkedRoot, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if (new Set(["EACCES", "EPERM", "ENOTSUP"]).has(error?.code)) {
      t.skip(`junction unavailable: ${error.code}`);
      return;
    }
    throw error;
  }
  const catalog = await inspectProjectCatalog({
    entries: [{ project_id: "linked-project", root: linkedRoot }],
    includeReviews: false,
    producer,
  });
  assert.equal(catalog.projects[0].capture_status, "unavailable");
  assert.equal(stableJson(catalog).includes(linkedRoot), false);
});

test("catalog inspects three projects and never exposes their roots", async (t) => {
  const item = await projectFixture(t);
  const catalog = await inspectProjectCatalog({
    entries: item.projects,
    includeReviews: false,
    producer,
  });
  assert.equal(catalog.format, "dubsar.workbench-catalog/1");
  assert.equal(catalog.summary.total, 3);
  assert.equal(catalog.summary.available, 3);
  assert.equal(catalog.projects.every((project) => project.capture_status === "available"), true);
  const output = stableJson(catalog);
  for (const project of item.projects) {
    assert.equal(output.includes(project.root), false);
  }
});

test("continuity catalog derives capsule, lots, history, view, and graph from one snapshot", async (t) => {
  const item = await projectFixture(t, 2);
  const catalog = await inspectProjectContinuityCatalog({
    entries: item.projects,
    includeReviews: false,
    producer,
  });
  assert.equal(catalog.format, "dubsar.workbench-continuity-data/3");
  assert.equal(catalog.summary.available, 2);
  for (const project of catalog.projects) {
    const continuity = project.continuity;
    assert.equal(continuity.capsule.format, "dubsar.resume-capsule/2");
    assert.equal(continuity.lots.format, "dubsar.project-lots-view/1");
    assert.equal(continuity.history.format, "dubsar.project-history/1");
    assert.equal(continuity.memory_route.format, "dubsar.memory-route/2");
    assert.equal(continuity.history.entries.length <= 8, true);
    assert.equal(continuity.capsule.project.snapshot_sha256, project.snapshot_sha256);
    assert.equal(continuity.lots.source.snapshot_sha256, project.snapshot_sha256);
    assert.equal(continuity.history.source.snapshot_sha256, project.snapshot_sha256);
    assert.equal(continuity.memory_route.source.snapshot_sha256, project.snapshot_sha256);
    assert.equal(continuity.source.workspace_mode, continuity.memory_route.source.workspace_mode);
    assert.equal(continuity.memory_route.guidance.auto_execute, false);
    assert.equal(continuity.memory_route.artifact_lifecycle.source.snapshot_sha256, project.snapshot_sha256);
    assert.equal(Object.hasOwn(continuity.memory_route.exact_relations, "relevance_ranking"), false);
    assert.equal(project.view.source.snapshot_sha256, project.snapshot_sha256);
    assert.equal(project.graph.source_snapshot_sha256, project.snapshot_sha256);
    assert.equal(Object.values(continuity.routes).every((route) => route.auto_execute === false), true);
  }
  const report = renderWorkbenchContinuityInteractiveReport(catalog);
  assert.ok(catalog.projects[0].graph.nodes.length >= 4);
  assert.ok(catalog.projects[0].graph.edges.length >= 3);
  assert.equal(report.manifest.format, "dubsar.workbench-continuity-interactive-report/4");
  assert.match(report.html, /dubsar\.workbench-continuity-interactive-data\/4/u);
  assert.match(report.html, /dubsar\.resume-capsule\/2/u);
  assert.match(report.html, /data-view="memory"/u);
  assert.match(report.html, /id="memory-view"/u);
  assert.match(report.html, /id="lot-list"/u);
  assert.match(report.html, /id="history-list"/u);
  assert.match(report.html, /id="precedent-lot-select"/u);
  assert.match(report.html, /id="memory-route"/u);
  assert.match(report.html, /data-graph-trivial="false"/u);
  assert.match(report.html, /dubsar\.memory-route\/2/u);
  assert.equal(report.html.includes("personal_memory"), false);
  assert.ok(report.manifest.bytes < 2 * 1024 * 1024);
  const embedded = embeddedWorkbenchData(report);
  for (const project of embedded.projects) {
    if (project.capture_status !== "available") continue;
    assert.equal(project.continuity.source.project_id, project.source_id);
    assert.equal(project.continuity.source.snapshot_sha256, project.snapshot_sha256);
    assert.equal(project.continuity.memory_route.source.snapshot_sha256, project.snapshot_sha256);
    assert.equal(project.view.source.id, project.source_id);
    assert.equal(project.view.source.snapshot_sha256, project.snapshot_sha256);
    assert.equal(project.graph.source_snapshot_sha256, project.snapshot_sha256);
    assert.equal(project.capsule.project.project_id, project.source_id);
    assert.equal(project.capsule.project.snapshot_sha256, project.snapshot_sha256);
  }
  assert.match(report.html, /globalThis\.crypto\.subtle\.digest/u);
  assert.match(report.html, /sourceDigest !== digest/u);
  const repeated = renderWorkbenchContinuityInteractiveReport(catalog);
  assert.equal(repeated.html, report.html);
  assert.deepEqual(repeated.manifest, report.manifest);

  const historicalCatalog = structuredClone(catalog);
  const historicalProject = historicalCatalog.projects[0];
  historicalProject.continuity.memory_route = {
    format: "dubsar.memory-route/1",
    authority: "local_preparation_record",
    source: {
      project_id: historicalProject.source_id,
      snapshot_sha256: historicalProject.snapshot_sha256,
      workspace_mode: "legacy",
    },
    route: {
      station: "continue", reason_codes: ["RECORDED_ACTION_AVAILABLE"], auto_execute: false,
    },
    maturation: {
      stage: "recorded", record_count: 0, supported_record_count: 0, limitation_count: 0,
    },
    resonance: { result: "none", basis: "exact_only", relevance_ranking: false, matches: [] },
    reactivation: {
      status: "not_applicable", checkpoint_id: null,
      reason_code: "NO_EXPLICIT_REACTIVATION_SIGNAL", auto_execute: false,
    },
    native_guidance: {
      plan: { recommendation: "not_indicated", reason_code: "NO_ROUTING_SIGNAL" },
      goal: { recommendation: "not_indicated", reason_code: "DURATION_NOT_RECORDED" },
    },
  };
  assert.doesNotThrow(() => renderWorkbenchContinuityInteractiveReport(historicalCatalog));
});

test("evidence v2 statements appear in the graph and unavailable continuity stays isolated", async (t) => {
  const item = await projectFixture(t, 1);
  const missing = path.join(item.root, "missing-continuity-project");
  const catalog = await inspectProjectContinuityCatalog({
    entries: [...item.projects, { project_id: "missing-continuity", root: missing }],
    includeReviews: false,
    producer,
  });
  const available = catalog.projects[0];
  const evidenceNode = available.graph.nodes.find((node) => node.kind === "evidence");
  assert.equal(evidenceNode.label, "The synthetic fixture was reported as inspected.");
  assert.equal(catalog.projects[1].capture_status, "unavailable");
  assert.equal(catalog.projects[1].continuity, null);
  assert.equal(stableJson(catalog).includes(missing), false);
});

test("legacy evidence remains readable in the graph without verified readiness", async (t) => {
  const item = await projectFixture(t, 1);
  await cp(
    path.join(repositoryRoot, "tests", "fixtures", "project-evidence-v1.json"),
    path.join(item.projects[0].root, ".dubsar-project", "evidence.json"),
  );
  const catalog = await inspectProjectContinuityCatalog({
    entries: item.projects,
    includeReviews: false,
    producer,
  });
  const project = catalog.projects[0];
  assert.equal(project.capture_status, "available");
  assert.notEqual(project.readiness.status, "ready");
  assert.equal(project.continuity.lots.source.evidence_format, "dubsar.project-evidence/1");
  assert.equal(project.graph.nodes.find((node) => node.kind === "evidence").label, "The synthetic fixture was inspected.");
});

test("continuity renderer rejects snapshot mixing and environment credential assignments", async (t) => {
  const item = await projectFixture(t, 1);
  const catalog = await inspectProjectContinuityCatalog({
    entries: item.projects,
    includeReviews: false,
    producer,
  });
  const mixed = structuredClone(catalog);
  mixed.projects[0].continuity.history.source.snapshot_sha256 = "0".repeat(64);
  assert.throws(
    () => renderWorkbenchContinuityInteractiveReport(mixed),
    (error) => error instanceof WorkbenchError && error.code === "CATALOG_REPORT_INPUT_INVALID",
  );
  const mixedRoute = structuredClone(catalog);
  mixedRoute.projects[0].continuity.memory_route.source.snapshot_sha256 = "0".repeat(64);
  assert.throws(
    () => renderWorkbenchContinuityInteractiveReport(mixedRoute),
    (error) => error instanceof WorkbenchError && error.code === "CATALOG_REPORT_INPUT_INVALID",
  );
  const credential = structuredClone(catalog);
  credential.projects[0].continuity.history.entries[0].statement =
    "AWS_SECRET_ACCESS_KEY=ABCDEFGHIJKLMNOPQRST";
  assert.throws(
    () => renderWorkbenchContinuityInteractiveReport(credential),
    (error) => error instanceof WorkbenchError && error.code === "CATALOG_REPORT_SENSITIVE_TEXT",
  );
  for (const secret of [
    "NPM_TOKEN: abcdefghijklmnop",
    "SENTRY_AUTH_TOKEN is abcdefghijklmnop",
    '\"POSTGRES_PASSWORD\":\"abcdefghijklmnop\"',
    "npm_token=abcdefghijklmnop",
    "postgres_password: abcdefghijklmnop",
  ]) {
    const variant = structuredClone(catalog);
    variant.projects[0].continuity.history.entries[0].statement = secret;
    assert.throws(
      () => renderWorkbenchContinuityInteractiveReport(variant),
      (error) => error instanceof WorkbenchError && error.code === "CATALOG_REPORT_SENSITIVE_TEXT",
    );
  }
});

test("one unavailable project does not hide the available projects", async (t) => {
  const item = await projectFixture(t, 2);
  const missing = path.join(item.root, "missing-project");
  const catalog = await inspectProjectCatalog({
    entries: [...item.projects, { project_id: "missing-project", root: missing }],
    includeReviews: false,
    producer,
  });
  assert.equal(catalog.summary.available, 2);
  assert.equal(catalog.summary.unavailable, 1);
  assert.equal(catalog.projects.at(2).capture_status, "unavailable");
  assert.equal(stableJson(catalog).includes(missing), false);
});

test("resume capsule is bounded, verifiable, and excludes raw or private fields", async (t) => {
  const item = await projectFixture(t, 1);
  const missionPath = path.join(item.projects[0].root, ".dubsar-project", "mission.json");
  const source = JSON.parse(await readFile(missionPath, "utf8"));
  source.desired_outcome = "Resume the local mission without reading PRIVATE_MEMORY_CANARY or C:\\private\\secret.txt";
  await writeFile(missionPath, `${JSON.stringify(source, null, 2)}\n`, "utf8");
  const catalog = await inspectProjectCatalog({
    entries: item.projects,
    includeReviews: false,
    producer,
  });
  const capsule = buildResumeCapsule({
    catalog,
    projectId: item.projects[0].project_id,
    producer,
  });
  const encoded = stableJson(capsule);
  assert.ok(Buffer.byteLength(encoded, "utf8") <= 8 * 1024);
  assert.equal(encoded.includes(item.projects[0].root), false);
  assert.equal(encoded.includes("PRIVATE_MEMORY_CANARY"), false);
  assert.equal(encoded.includes("private\\secret"), false);
  assert.equal(assertResumeCapsule(JSON.parse(encoded)).capsule_sha256, capsule.capsule_sha256);
  assert.throws(
    () => assertResumeCapsule({ ...capsule, capsule_sha256: "0".repeat(64) }),
    (error) => error instanceof WorkbenchError && error.code === "CAPSULE_DIGEST_MISMATCH",
  );
});

test("catalog renderer produces one autonomous path-free HTML document", async (t) => {
  const item = await projectFixture(t, 3);
  const catalog = await inspectProjectCatalog({
    entries: item.projects,
    includeReviews: false,
    producer,
  });
  const report = renderWorkbenchCatalogInteractiveReport(catalog, {
    capsuleProducer: producer,
  });
  assert.equal(report.manifest.project_count, 3);
  assert.equal(report.manifest.available_count, 3);
  assert.ok(report.manifest.bytes <= 2 * 1024 * 1024);
  assert.match(report.html, /^<!doctype html>/u);
  assert.match(report.html, /dubsar\.workbench-catalog-interactive-data\/1/u);
  assert.match(report.html, /Resume with Codex/u);
  assert.match(report.html, /id="nav-resume-tab" role="tab" data-view="dashboard" aria-controls="dashboard-view" aria-selected="true" tabindex="0" data-i18n="nav_resume">Resume</u);
  assert.match(report.html, /Copy capsule JSON/u);
  assert.match(report.html, /<select class="project-picker" id="project-select">/u);
  assert.match(report.html, /Snapshot read when opened — reopen DUBSAR to refresh/u);
  assert.match(report.html, /<html lang="en" data-runtime="fallback">/u);
  assert.match(report.html, /id="locale-switch" role="group" aria-label="Language"/u);
  assert.match(report.html, /data-locale="en" aria-pressed="true">EN</u);
  assert.match(report.html, /data-locale="fr" aria-pressed="false">FR</u);
  assert.match(report.html, /nav_resume: "Reprise"/u);
  assert.match(report.html, /applyLocale\("en"\)/u);
  assert.match(report.html, /connect-src 'none'/u);
  assert.match(report.html, /name="dubsar-live-session" content="disabled"/u);
  assert.match(report.html, /<details class="technical compact-panel" id="technical-details"><summary><span id="technical-summary-label"/u);
  assert.match(report.html, /data-graph-filter="essential" aria-pressed="true"/u);
  assert.match(report.html, /<canvas id="graph-canvas" aria-hidden="true">/u);
  assert.match(report.html, /aria-live="polite"/u);
  assert.equal(report.html.includes('id="memory-panel"'), false);
  assert.match(report.html, /button\.dataset\.nodeId === node\.id/u);
  assert.equal(report.html.includes("button.textContent === node.label"), false);
  assert.match(report.html, /@media \(min-width: 761px\) and \(min-height: 640px\)/u);
  assert.match(report.html, /height: 100dvh/u);
  assert.match(report.html, /decisions\.forEach\(\(decision, index\)/u);
  assert.equal(report.html.includes("decisions.slice(0, 2)"), false);
  assert.equal(report.html.includes("Date.now"), false);
  assert.equal(report.html.includes("localStorage"), false);
  assert.equal(/blocage principal/iu.test(report.html), false);
  assert.equal(report.html.indexOf('id="project-title"') < report.html.indexOf('id="state-value"'), true);
  assert.equal(report.html.indexOf('id="state-value"') < report.html.indexOf('id="action-heading"'), true);
  assert.equal(report.html.indexOf('id="action-heading"') < report.html.indexOf('id="blocker-overview"'), true);
  assert.equal(report.html.indexOf('id="blocker-overview"') < report.html.indexOf('id="resume-context"'), true);
  assert.equal(report.html.indexOf('id="signal-reviews"') > report.html.indexOf('id="technical-details"'), true);
  const repeated = renderWorkbenchCatalogInteractiveReport(catalog, { capsuleProducer: producer });
  assert.equal(repeated.html, report.html);
  assert.deepEqual(repeated.manifest, report.manifest);
  const live = renderWorkbenchCatalogInteractiveReport(catalog, {
    capsuleProducer: producer,
    live: true,
  });
  assert.match(live.html, /connect-src 'self'/u);
  assert.match(live.html, /name="dubsar-live-session" content="enabled"/u);
  assert.match(live.html, /Automatic updates active/u);
  assert.equal(live.manifest.data_sha256, report.manifest.data_sha256);
  assert.notEqual(live.manifest.sha256, report.manifest.sha256);
  assert.equal(report.html.includes("https://"), false);
  assert.equal(report.html.includes("http://"), false);
  assert.equal(report.html.includes("file://"), false);
  for (const project of item.projects) {
    assert.equal(report.html.includes(project.root), false);
  }
});

test("catalog renderer rejects forged paths and credentials at its public boundary", async (t) => {
  const item = await projectFixture(t, 2);
  const catalog = await inspectProjectCatalog({
    entries: item.projects,
    includeReviews: false,
    producer,
  });
  const unavailable = structuredClone(catalog);
  unavailable.projects[1].capture_status = "unavailable";
  unavailable.projects[1].source_id = null;
  unavailable.projects[1].snapshot_sha256 = null;
  unavailable.projects[1].title = "C:\\private\\project";
  unavailable.projects[1].integrity = {
    status: "unknown",
    diagnostic_codes: ["PROJECT_UNAVAILABLE"],
  };
  unavailable.projects[1].readiness = {
    status: "unknown",
    reason_codes: ["PROJECT_UNAVAILABLE"],
  };
  unavailable.projects[1].primary_blocker = {
    code: "PROJECT_UNAVAILABLE",
    severity: "error",
    title: "Check the project folder",
  };
  unavailable.projects[1].next_action = {
    code: "verify_project_root",
    label: "Check the project folder",
  };
  unavailable.projects[1].view = null;
  unavailable.projects[1].graph = null;
  assert.throws(
    () => renderWorkbenchCatalogInteractiveReport(unavailable, { capsuleProducer: producer }),
    (error) => error instanceof WorkbenchError && error.code === "CATALOG_REPORT_SENSITIVE_TEXT",
  );

  const nestedUnavailableText = structuredClone(unavailable);
  nestedUnavailableText.projects[1].title = {
    api_key: "ABCDEFGHIJKLMNOPQRST",
  };
  assert.throws(
    () => renderWorkbenchCatalogInteractiveReport(nestedUnavailableText, { capsuleProducer: producer }),
    (error) => error instanceof WorkbenchError && error.code === "CATALOG_REPORT_INPUT_INVALID",
  );

  const oversizedUnavailable = structuredClone(unavailable);
  oversizedUnavailable.projects[1].title = "x".repeat(2_001);
  assert.throws(
    () => renderWorkbenchCatalogInteractiveReport(oversizedUnavailable, { capsuleProducer: producer }),
    (error) => error instanceof WorkbenchError && error.code === "CATALOG_REPORT_INPUT_INVALID",
  );

  const forgedGraph = structuredClone(catalog);
  forgedGraph.projects[0].graph.nodes[0].label = "api_key=ABCDEFGHIJKLMNOPQRST";
  assert.throws(
    () => renderWorkbenchCatalogInteractiveReport(forgedGraph, { capsuleProducer: producer }),
    (error) => error instanceof WorkbenchError && error.code === "INTERACTIVE_GRAPH_INVALID",
  );

  const forgedPhone = structuredClone(catalog);
  forgedPhone.projects[0].graph.nodes[0].label = "+33 6 12 34 56 78";
  assert.throws(
    () => renderWorkbenchCatalogInteractiveReport(forgedPhone, { capsuleProducer: producer }),
    (error) => error instanceof WorkbenchError && error.code === "INTERACTIVE_GRAPH_INVALID",
  );

  const forgedDetail = structuredClone(catalog);
  const structuralNode = forgedDetail.projects[0].graph.nodes.find(
    (node) => !["mission", "decision"].includes(node.kind),
  );
  structuralNode.detail = "ghp_abcdefghijklmnopqrstuvwx";
  assert.throws(
    () => renderWorkbenchCatalogInteractiveReport(forgedDetail, { capsuleProducer: producer }),
    (error) => error instanceof WorkbenchError && error.code === "INTERACTIVE_GRAPH_INVALID",
  );

  const oversizedDiagnostics = structuredClone(catalog);
  oversizedDiagnostics.projects[0].graph.diagnostics = Array.from(
    { length: 257 },
    (_, index) => ({ code: `DIAGNOSTIC_${index}`, severity: "warning" }),
  );
  assert.throws(
    () => renderWorkbenchCatalogInteractiveReport(oversizedDiagnostics, { capsuleProducer: producer }),
    (error) => error instanceof WorkbenchError && error.code === "INTERACTIVE_GRAPH_INVALID",
  );

  const forgedSource = structuredClone(catalog);
  forgedSource.projects[0].source_id = "api_key=ABCDEFGHIJKLMNOPQRST";
  assert.throws(
    () => renderWorkbenchCatalogInteractiveReport(forgedSource, { capsuleProducer: producer }),
    (error) => error instanceof WorkbenchError && error.code === "CATALOG_REPORT_INPUT_INVALID",
  );

  const secretProjectId = structuredClone(catalog);
  secretProjectId.projects[0].project_id = "ghp_abcdefghijklmnopqrstuvwx";
  assert.throws(
    () => renderWorkbenchCatalogInteractiveReport(secretProjectId, { capsuleProducer: producer }),
    (error) => error instanceof WorkbenchError && error.code === "CATALOG_REPORT_SENSITIVE_TEXT",
  );

  const nestedExtra = structuredClone(catalog);
  nestedExtra.projects[0].next_action.secret = "api_key=ABCDEFGHIJKLMNOPQRST";
  assert.throws(
    () => renderWorkbenchCatalogInteractiveReport(nestedExtra, { capsuleProducer: producer }),
    (error) => error instanceof WorkbenchError && error.code === "CATALOG_REPORT_INPUT_INVALID",
  );

  const summaryExtra = structuredClone(catalog);
  summaryExtra.summary.secret = "api_key=ABCDEFGHIJKLMNOPQRST";
  assert.throws(
    () => renderWorkbenchCatalogInteractiveReport(summaryExtra, { capsuleProducer: producer }),
    (error) => error instanceof WorkbenchError && error.code === "CATALOG_REPORT_INPUT_INVALID",
  );
});

test("validated structural identifiers bypass display heuristics without weakening display filtering", async (t) => {
  for (let index = 0; index < 512; index += 1) {
    assert.equal(isProjectId(deterministicProjectId(index)), true);
  }
  assert.equal(isProjectId(PHONE_LIKE_PROJECT_ID), true);

  const item = await projectFixture(t, 1);
  item.projects[0].project_id = PHONE_LIKE_PROJECT_ID;
  const catalog = await inspectProjectCatalog({
    entries: item.projects,
    includeReviews: false,
    producer,
  });
  const structuralGraph = structuredClone(catalog);
  const originalNodeId = structuralGraph.projects[0].graph.nodes[0].id;
  const phoneLikeNodeId = "node-0294-4202";
  structuralGraph.projects[0].graph.nodes[0].id = phoneLikeNodeId;
  const structuralDetailNode = structuralGraph.projects[0].graph.nodes.find(
    (node) => !["mission", "decision"].includes(node.kind),
  );
  structuralDetailNode.detail = "status-0294-4202";
  for (const edge of structuralGraph.projects[0].graph.edges) {
    if (edge.from === originalNodeId) edge.from = phoneLikeNodeId;
    if (edge.to === originalNodeId) edge.to = phoneLikeNodeId;
  }
  const report = renderWorkbenchCatalogInteractiveReport(structuralGraph, {
    capsuleProducer: producer,
  });
  assert.equal(report.html.includes(PHONE_LIKE_PROJECT_ID), true);
  assert.equal(report.html.includes(phoneLikeNodeId), true);
  assert.equal(report.html.includes(structuralDetailNode.detail), true);
  assert.equal(report.html.includes("[content redacted]"), false);

  const datedProducer = structuredClone(catalog);
  datedProducer.producer = { name: "catalog-20241022", version: "1.0.0-20241022" };
  const datedReport = renderWorkbenchCatalogInteractiveReport(datedProducer, {
    capsuleProducer: datedProducer.producer,
  });
  assert.equal(datedReport.html.includes("[content redacted]"), false);
});

test("single-project catalog hides portfolio chrome and keeps the Codex action above technical data", async (t) => {
  const item = await projectFixture(t, 1);
  const catalog = await inspectProjectCatalog({
    entries: item.projects,
    includeReviews: false,
    producer,
  });
  const report = renderWorkbenchCatalogInteractiveReport(catalog, {
    capsuleProducer: producer,
  });
  assert.match(report.html, /<section class="portfolio-strip" aria-labelledby="portfolio-title" hidden>/u);
  assert.match(report.html, /id="resume-copy" data-i18n="resume_with_codex">Resume with Codex/u);
  assert.match(report.html, /id="resume-copy-status" aria-live="polite">Local instruction ready/u);
  assert.match(report.html, /id="next-action-code">unavailable/u);
  assert.match(report.html, /\$resume-dubsar-workbench/u);
  assert.equal(report.html.indexOf('id="resume-copy"') < report.html.indexOf('id="technical-details"'), true);
  assert.equal(report.html.includes(item.projects[0].root), false);
});

test("resume sheet presents zero, one, and many blockers without inventing priority", async (t) => {
  const item = await projectFixture(t, 1);
  const catalog = await inspectProjectCatalog({
    entries: item.projects,
    includeReviews: false,
    producer,
  });

  const one = structuredClone(catalog);
  one.projects[0].view.blockers = [
    { code: "BLOCKER_ONE", severity: "warning", title: "Premier blocage détecté" },
  ];
  one.projects[0].primary_blocker = one.projects[0].view.blockers.at(0);
  const oneReport = renderWorkbenchCatalogInteractiveReport(one, { capsuleProducer: producer });
  const oneShell = oneReport.html.slice(0, oneReport.html.indexOf('<script id="workbench-data"'));
  assert.match(oneShell, /id="blocker-count">1</u);
  assert.match(oneShell, /class="blocker-preview-item"/u);
  assert.match(oneShell, /id="blocker-details" hidden/u);

  const none = structuredClone(catalog);
  none.projects[0].view.blockers = [];
  none.projects[0].primary_blocker = null;
  none.projects[0].readiness = { status: "ready", reason_codes: [] };
  none.projects[0].view.readiness = { status: "ready", reasons: [] };
  none.projects[0].next_action = { code: "prepare_approved_lot", label: "Prepare the approved lot." };
  none.projects[0].view.next_action = { ...none.projects[0].next_action };
  const noneReport = renderWorkbenchCatalogInteractiveReport(none, { capsuleProducer: producer });
  const noneShell = noneReport.html.slice(0, noneReport.html.indexOf('<script id="workbench-data"'));
  assert.match(noneShell, /id="blocker-count">0</u);
  assert.match(noneShell, /No blockers detected/u);
  assert.match(noneShell, /id="blocker-details" hidden/u);
  assert.match(noneShell, /data-state="ready">Ready to continue</u);

  const many = structuredClone(catalog);
  many.projects[0].view.blockers = [
    { code: "FIRST_BLOCKER", severity: "warning", title: "Premier blocage détecté" },
    { code: "SECOND_BLOCKER", severity: "warning", title: "Second blocage détecté" },
    { code: "THIRD_BLOCKER", severity: "warning", title: "Troisième blocage détecté" },
  ];
  many.projects[0].primary_blocker = many.projects[0].view.blockers.at(0);
  const manyReport = renderWorkbenchCatalogInteractiveReport(many, { capsuleProducer: producer });
  const manyShell = manyReport.html.slice(0, manyReport.html.indexOf('<script id="workbench-data"'));
  assert.match(manyShell, /id="blocker-count">3</u);
  assert.equal((manyShell.match(/class="blocker-preview-item"/gu) ?? []).length, 2);
  assert.match(manyShell, /id="blocker-details">/u);
  assert.match(manyShell, /SECOND_BLOCKER/u);
  assert.match(manyShell, /THIRD_BLOCKER/u);
  assert.match(manyShell, /no business priority order/u);
  assert.equal(/principal|prioritaire/iu.test(manyShell), false);
});

test("invalid and unavailable projects keep corrective action ahead of resumption", async (t) => {
  const invalidItem = await projectFixture(t, 1);
  const missionPath = path.join(invalidItem.projects[0].root, ".dubsar-project", "mission.json");
  const mission = JSON.parse(await readFile(missionPath, "utf8"));
  mission.status = "broken";
  await writeFile(missionPath, `${JSON.stringify(mission, null, 2)}\n`, "utf8");
  const invalidCatalog = await inspectProjectCatalog({
    entries: invalidItem.projects,
    includeReviews: false,
    producer,
  });
  const invalidReport = renderWorkbenchCatalogInteractiveReport(invalidCatalog, { capsuleProducer: producer });
  const invalidShell = invalidReport.html.slice(0, invalidReport.html.indexOf('<script id="workbench-data"'));
  assert.match(invalidShell, /id="integrity-alert" role="alert"><strong data-i18n="integrity_alert_title">Project records conflict/u);
  assert.match(invalidShell, /Needs record review/u);
  assert.match(invalidShell, /Project records conflict, so readiness and active work cannot be confirmed/u);
  assert.match(invalidShell, /id="next-action-primary">Review record consistency\.<\/strong>/u);
  assert.match(invalidShell, /id="resume-why" hidden/u);
  assert.match(invalidShell, /id="blocker-count">Unverified/u);
  assert.match(invalidShell, /No trusted blocker list is available until the project records are consistent/u);
  assert.equal(invalidShell.includes("No blockers detected"), false);
  assert.match(invalidShell, /id="review-records" data-i18n="review_records">Review record consistency/u);
  assert.match(invalidShell, /id="resume-copy" disabled data-i18n="resume_with_codex">Resume with Codex/u);
  assert.match(invalidShell, /Unavailable until record consistency is reviewed/u);
  assert.match(invalidShell, /id="technical-summary-label" data-i18n="record_details">Record details/u);
  assert.match(invalidShell, /id="integrity-diagnostic-list">[^<]+<\/code>/u);
  assert.match(invalidShell, /work package(?:s)? recorded · unverified/u);
  assert.match(invalidReport.html, /const activeWorkId = integrityInvalid \? null/u);
  assert.match(invalidReport.html, /active_work\?\.work_id/u);
  assert.match(invalidReport.html, /unverified diagnostic · /u);

  const missingItem = await projectFixture(t, 0);
  const missingRoot = path.join(missingItem.root, "missing-project");
  const unavailableCatalog = await inspectProjectCatalog({
    entries: [{ project_id: "missing-project", root: missingRoot }],
    includeReviews: false,
    producer,
  });
  const unavailableReport = renderWorkbenchCatalogInteractiveReport(unavailableCatalog, { capsuleProducer: producer });
  const unavailableShell = unavailableReport.html.slice(0, unavailableReport.html.indexOf('<script id="workbench-data"'));
  assert.match(unavailableShell, /id="next-action-primary">Check the project folder\.<\/strong>/u);
  assert.match(unavailableShell, /id="resume-copy" disabled data-i18n="resume_with_codex">Resume with Codex/u);
  assert.match(unavailableShell, /Check the folder before resuming/u);
  assert.match(unavailableShell, /Progress unavailable/u);
});
