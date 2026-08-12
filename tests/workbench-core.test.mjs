import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  cp,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  WorkbenchError,
  inspectWorkspace,
  inspectWorkspaceWithReviews,
  locateWorkspace,
  resolveLimits,
  stableJson,
} from "../packages/dubsar-operator-core/src/index.mjs";
import { captureWorkspaceSnapshot } from "../packages/dubsar-operator-core/src/snapshot.mjs";
import { validateProjectWorkspace } from "../legacy/hermes-skills/dubsar-project-continuity/scripts/project-model.mjs";
import { validateAuditWorkspace } from "../packages/dubsar-audit-readiness/skills/dubsar-audit-readiness/scripts/audit-model.mjs";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

async function fixtureWorkspace(t, domain) {
  const root = await mkdtemp(path.join(tmpdir(), `dubsar-${domain}-`));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(path.join(root, ".git"));
  const marker = domain === "project" ? ".dubsar-project" : ".dubsar-audit";
  const source = path.join(
    repositoryRoot,
    "examples",
    domain === "project" ? "project-continuity" : "audit-readiness",
  );
  await cp(source, path.join(root, marker), { recursive: true });
  if (domain === "project") {
    await cp(
      path.join(repositoryRoot, "tests", "fixtures", "project-evidence-v1.json"),
      path.join(root, marker, "evidence.json"),
    );
    await writeFile(path.join(root, "fixture-example"), "legacy proof\n", "utf8");
  }
  return { root, marker, workspace: path.join(root, marker) };
}

async function fileSnapshot(root, current = root) {
  const entries = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const absolute = path.join(current, entry.name);
    if (entry.isDirectory()) {
      entries.push(...(await fileSnapshot(root, absolute)));
    } else if (entry.isFile()) {
      entries.push({
        path: path.relative(root, absolute).replaceAll("\\", "/"),
        content: (await readFile(absolute)).toString("base64"),
      });
    }
  }
  return entries.sort((left, right) => left.path.localeCompare(right.path, "en"));
}

test("project inspection is deterministic, bounded, and path-private", async (t) => {
  const fixture = await fixtureWorkspace(t, "project");
  const before = await fileSnapshot(fixture.workspace);
  const first = await inspectWorkspace({ start: fixture.root, domain: "project" });
  const second = await inspectWorkspace({ start: fixture.root, domain: "project" });
  const internal = await captureWorkspaceSnapshot(first.location, resolveLimits());
  const after = await fileSnapshot(fixture.workspace);
  assert.equal(first.view.integrity.status, "valid");
  assert.equal(first.view.readiness.status, "not_ready");
  assert.deepEqual(first.view.readiness.reasons, [
    "LEGACY_EVIDENCE_REQUIRES_MIGRATION",
  ]);
  const legacy = await validateProjectWorkspace(fixture.workspace);
  assert.equal(legacy.status, "valid");
  assert.deepEqual(first.evaluation.counts, legacy.counts);
  assert.equal(first.snapshot.snapshot_sha256, second.snapshot.snapshot_sha256);
  assert.equal(first.graph.format, "dubsar.workbench-graph/1");
  assert.equal(first.graph.status, "available");
  assert.equal(first.graph.source_snapshot_sha256, first.snapshot.snapshot_sha256);
  assert.equal(stableJson(first.graph), stableJson(second.graph));
  assert.equal(stableJson(first.graph).includes(fixture.root), false);
  const nodeIds = new Set(first.graph.nodes.map((node) => node.id));
  const nodeKinds = new Set(first.graph.nodes.map((node) => node.kind));
  const edgeKinds = new Set(first.graph.edges.map((edge) => edge.kind));
  for (const kind of ["contract", "evidence", "lot", "mission"]) {
    assert.equal(nodeKinds.has(kind), true);
  }
  for (const kind of ["contains", "governs", "supports"]) {
    assert.equal(edgeKinds.has(kind), true);
  }
  assert.equal(
    [...nodeKinds].every((kind) =>
      new Set(["blocker", "contract", "decision", "evidence", "lot", "mission"]).has(kind)),
    true,
  );
  assert.equal(
    first.graph.edges.every((edge) => nodeIds.has(edge.from) && nodeIds.has(edge.to)),
    true,
  );
  assert.deepEqual(Object.keys(internal), ["snapshot", "canonical_root_sha256"]);
  assert.equal(Object.isFrozen(internal), true);
  assert.deepEqual(internal.snapshot, first.snapshot);
  assert.match(internal.canonical_root_sha256, /^[0-9a-f]{64}$/u);
  assert.equal(stableJson(first.view), stableJson(second.view));
  assert.equal(stableJson(first.view).includes(fixture.root), false);
  assert.deepEqual(after, before);
});

test("audit inspection captures and verifies the approved artifact", async (t) => {
  const fixture = await fixtureWorkspace(t, "audit");
  const inspection = await inspectWorkspace({ start: fixture.root, domain: "audit" });
  assert.equal(inspection.view.integrity.status, "valid");
  assert.equal(inspection.view.readiness.status, "ready");
  const legacy = await validateAuditWorkspace(fixture.workspace);
  assert.equal(legacy.status, "valid");
  assert.equal(legacy.preparation_status, "ready_for_human_review");
  assert.deepEqual(inspection.evaluation.counts, legacy.counts);
  assert.equal(inspection.snapshot.artifacts.length, 1);
  assert.equal(inspection.snapshot.artifacts[0].policy_finding, null);
  assert.equal(inspection.view.source.formats.length, 5);
  assert.equal(inspection.graph.status, "unavailable");
  assert.deepEqual(inspection.graph.nodes, []);
  assert.deepEqual(inspection.graph.edges, []);
  assert.equal(stableJson(inspection.view).includes(fixture.root), false);
});

test("raw byte changes produce a distinct evidence snapshot digest", async (t) => {
  const left = await fixtureWorkspace(t, "project");
  const right = await fixtureWorkspace(t, "project");
  const missionPath = path.join(right.workspace, "mission.json");
  const mission = await readFile(missionPath, "utf8");
  await writeFile(missionPath, mission.replaceAll("\n", "\r\n"), "utf8");
  const leftInspection = await inspectWorkspace({ start: left.root, domain: "project" });
  const rightInspection = await inspectWorkspace({ start: right.root, domain: "project" });
  assert.notEqual(
    leftInspection.snapshot.snapshot_sha256,
    rightInspection.snapshot.snapshot_sha256,
  );
  assert.equal(leftInspection.view.integrity.status, rightInspection.view.integrity.status);
});

test("the snapshot enforces byte and JSON-depth limits during capture", async (t) => {
  const fixture = await fixtureWorkspace(t, "project");
  await assert.rejects(
    inspectWorkspace({
      start: fixture.root,
      domain: "project",
      limits: {
        maxArtifactFileBytes: 32,
        maxCanonicalFileBytes: 32,
        maxSnapshotBytes: 1024,
      },
    }),
    (error) => error instanceof WorkbenchError && error.code === "FILE_SIZE_LIMIT_EXCEEDED",
  );

  const missionPath = path.join(fixture.workspace, "mission.json");
  const mission = JSON.parse(await readFile(missionPath, "utf8"));
  mission.constraints = [[[[["too-deep"]]]]];
  await writeFile(missionPath, `${JSON.stringify(mission, null, 2)}\n`, "utf8");
  await assert.rejects(
    inspectWorkspace({
      start: fixture.root,
      domain: "project",
      limits: { maxJsonDepth: 4 },
    }),
    (error) => error instanceof WorkbenchError && error.code === "JSON_DEPTH_LIMIT_EXCEEDED",
  );
});

test("ambiguous colocated workspaces fail closed without a domain", async (t) => {
  const project = await fixtureWorkspace(t, "project");
  const auditSource = path.join(repositoryRoot, "examples", "audit-readiness");
  await cp(auditSource, path.join(project.root, ".dubsar-audit"), { recursive: true });
  await assert.rejects(
    locateWorkspace({ start: project.root }),
    (error) => error instanceof WorkbenchError && error.code === "WORKSPACE_DOMAIN_AMBIGUOUS",
  );
  const location = await locateWorkspace({ start: project.root, domain: "project" });
  assert.equal(location.domain, "project");
});

test("symbolic workspace markers are rejected", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "dubsar-link-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(path.join(root, ".git"));
  const target = path.join(repositoryRoot, "examples", "project-continuity");
  try {
    await symlink(target, path.join(root, ".dubsar-project"), "junction");
  } catch (error) {
    if (new Set(["EPERM", "EACCES"]).has(error?.code)) {
      t.skip("Symlink creation is unavailable in this Windows profile.");
      return;
    }
    throw error;
  }
  await assert.rejects(
    locateWorkspace({ start: root, domain: "project" }),
    (error) => error instanceof WorkbenchError && error.code === "WORKSPACE_MARKER_UNSAFE",
  );
});

test("dangerous JSON keys and sensitive display values never enter the view", async (t) => {
  const fixture = await fixtureWorkspace(t, "project");
  const missionPath = path.join(fixture.workspace, "mission.json");
  const raw = await readFile(missionPath, "utf8");
  await writeFile(
    missionPath,
    raw.replace(
      '"desired_outcome": "Produce a user-visible synthetic proof.",',
      '"desired_outcome": "api_key=synthetic-secret-value",\n  "__proto__": {"polluted": true},',
    ),
    "utf8",
  );
  await assert.rejects(
    inspectWorkspace({ start: fixture.root, domain: "project" }),
    (error) => error instanceof WorkbenchError && error.code === "JSON_DANGEROUS_KEY_REJECTED",
  );

  const clean = JSON.parse(raw);
  clean.desired_outcome = "api_key=synthetic-secret-value";
  await writeFile(missionPath, `${JSON.stringify(clean, null, 2)}\n`, "utf8");
  const inspection = await inspectWorkspace({ start: fixture.root, domain: "project" });
  const output = stableJson(inspection.view);
  assert.equal(output.includes("synthetic-secret-value"), false);
  assert.equal(inspection.view.overview.summary, "[content redacted]");
  assert.equal(inspection.view.privacy.redacted_fields, 1);
});

test("audit artifact paths cannot alias canonical or reserved outputs", async (t) => {
  for (const reservedPath of [
    "audit-scope.json",
    "AUDIT-SCOPE.JSON",
    "audit-preparation-summary.md",
    "manifest.sha256.json",
  ]) {
    await t.test(reservedPath, async (subtest) => {
      const fixture = await fixtureWorkspace(subtest, "audit");
      const indexPath = path.join(fixture.workspace, "evidence-index.json");
      const index = JSON.parse(await readFile(indexPath, "utf8"));
      index.artifacts[0].path = reservedPath;
      await writeFile(indexPath, `${JSON.stringify(index, null, 2)}\n`, "utf8");
      await assert.rejects(
        inspectWorkspace({ start: fixture.root, domain: "audit" }),
        (error) =>
          error instanceof WorkbenchError &&
          error.code === "ARTIFACT_PATH_RESERVED",
      );
    });
  }
});

test("audit capture rejects a hardlink alias of a canonical file", async (t) => {
  const fixture = await fixtureWorkspace(t, "audit");
  const aliasPath = path.join(fixture.workspace, "evidence", "scope-alias.json");
  try {
    await link(path.join(fixture.workspace, "audit-scope.json"), aliasPath);
  } catch (error) {
    if (new Set(["EPERM", "EACCES", "ENOTSUP"]).has(error?.code)) {
      t.skip("Hardlink creation is unavailable in this Windows profile.");
      return;
    }
    throw error;
  }
  const content = await readFile(aliasPath);
  const indexPath = path.join(fixture.workspace, "evidence-index.json");
  const index = JSON.parse(await readFile(indexPath, "utf8"));
  index.artifacts[0].path = "evidence/scope-alias.json";
  index.artifacts[0].sha256 = createHash("sha256").update(content).digest("hex");
  await writeFile(indexPath, `${JSON.stringify(index, null, 2)}\n`, "utf8");
  await assert.rejects(
    inspectWorkspace({ start: fixture.root, domain: "audit" }),
    (error) =>
      error instanceof WorkbenchError &&
      new Set(["FILE_UNSAFE", "FILE_IDENTITY_DUPLICATE"]).has(error.code),
  );
});

test("sensitive identifiers and untrusted source formats never enter the view", async (t) => {
  const fixture = await fixtureWorkspace(t, "project");
  const credentialId = "ghp_AAAAAAAAAAAAAAAAAAAAAAAA";
  const credentialEvidenceId = "ghp_BBBBBBBBBBBBBBBBBBBBBBBB";
  for (const file of [
    "mission.json",
    "lots.json",
    "execution-contract.json",
    "evidence.json",
  ]) {
    const filePath = path.join(fixture.workspace, file);
    const document = JSON.parse(await readFile(filePath, "utf8"));
    document.mission_id = credentialId;
    if (file === "mission.json") {
      document.format = "api_key=synthetic-secret-value";
      document.acceptance_evidence = [credentialEvidenceId];
    } else if (file === "lots.json") {
      document.lots[0].expected_evidence = [credentialEvidenceId];
    } else if (file === "evidence.json") {
      document.format = "api_key=synthetic-secret-value";
      document.entries[0].evidence_id = credentialEvidenceId;
    }
    await writeFile(filePath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  }
  const inspection = await inspectWorkspace({
    start: fixture.root,
    domain: "project",
  });
  const output = stableJson(inspection.view);
  assert.equal(inspection.view.integrity.status, "invalid");
  assert.equal(inspection.view.source.id, null);
  assert.equal(inspection.view.evidence[0].id, "evidence-1");
  assert.equal(output.includes(credentialId), false);
  assert.equal(output.includes(credentialEvidenceId), false);
  assert.equal(output.includes("synthetic-secret-value"), false);
  assert.deepEqual(inspection.view.source.formats, [
    "dubsar.execution-contract/1",
    "dubsar.project-evidence/1",
    "dubsar.project-lots/1",
    "dubsar.project-mission/1",
  ]);
});

test("phone-like structural identifiers remain visible in the core view", async (t) => {
  const fixture = await fixtureWorkspace(t, "project");
  const missionId = "mission-3d49ecd9-0294-4202-90c8-c2529005e143";
  const evidenceId = "evidence-0294-4202";
  for (const file of [
    "mission.json",
    "lots.json",
    "execution-contract.json",
    "evidence.json",
  ]) {
    const filePath = path.join(fixture.workspace, file);
    const document = JSON.parse(await readFile(filePath, "utf8"));
    document.mission_id = missionId;
    if (file === "mission.json") document.acceptance_evidence = [evidenceId];
    if (file === "lots.json") document.lots[0].expected_evidence = [evidenceId];
    if (file === "evidence.json") document.entries[0].evidence_id = evidenceId;
    await writeFile(filePath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  }
  const inspection = await inspectWorkspace({ start: fixture.root, domain: "project" });
  assert.equal(inspection.view.source.id, missionId);
  assert.equal(inspection.view.evidence[0].id, evidenceId);
  assert.equal(inspection.view.privacy.redacted_fields, 0);
});

test("a complete mission with incomplete lots is an integrity contradiction", async (t) => {
  const fixture = await fixtureWorkspace(t, "project");
  const missionPath = path.join(fixture.workspace, "mission.json");
  const mission = JSON.parse(await readFile(missionPath, "utf8"));
  mission.status = "complete";
  await writeFile(missionPath, `${JSON.stringify(mission, null, 2)}\n`, "utf8");
  const inspection = await inspectWorkspace({
    start: fixture.root,
    domain: "project",
  });
  assert.equal(inspection.view.integrity.status, "invalid");
  assert.equal(inspection.view.readiness.status, "unknown");
  assert.ok(
    inspection.view.integrity.diagnostics.some(
      (diagnostic) =>
        diagnostic.code === "MISSION_COMPLETE_WITH_INCOMPLETE_LOTS",
    ),
  );
});

test("essential mission fields gate readiness even when integrity is valid", async (t) => {
  const fixture = await fixtureWorkspace(t, "project");
  const missionPath = path.join(fixture.workspace, "mission.json");
  const mission = JSON.parse(await readFile(missionPath, "utf8"));
  mission.title = "";
  await writeFile(missionPath, `${JSON.stringify(mission, null, 2)}\n`, "utf8");
  const inspection = await inspectWorkspace({
    start: fixture.root,
    domain: "project",
  });
  assert.equal(inspection.view.integrity.status, "valid");
  assert.equal(inspection.view.readiness.status, "not_ready");
  assert.deepEqual(inspection.view.readiness.reasons, ["MISSION_TITLE_MISSING"]);
  assert.equal(
    inspection.view.next_action.code,
    "complete_mission_definition",
  );
  assert.notEqual(inspection.view.next_action.code, "prepare_approved_lot");
});

test("artifact scanning checks every credential assignment", async (t) => {
  const fixture = await fixtureWorkspace(t, "audit");
  const artifactPath = path.join(fixture.workspace, "evidence", "workflow.json");
  const content = Buffer.from(
    "token=redacted\npassword=real-secret-value\n",
    "utf8",
  );
  await writeFile(artifactPath, content);
  const indexPath = path.join(fixture.workspace, "evidence-index.json");
  const index = JSON.parse(await readFile(indexPath, "utf8"));
  index.artifacts[0].sha256 = createHash("sha256").update(content).digest("hex");
  await writeFile(indexPath, `${JSON.stringify(index, null, 2)}\n`, "utf8");
  const inspection = await inspectWorkspace({
    start: fixture.root,
    domain: "audit",
  });
  const output = stableJson(inspection.view);
  assert.equal(inspection.view.integrity.status, "invalid");
  assert.equal(inspection.view.readiness.status, "unknown");
  assert.ok(
    inspection.view.integrity.diagnostics.some(
      (diagnostic) => diagnostic.code === "ARTIFACT_CREDENTIAL_ASSIGNMENT",
    ),
  );
  assert.equal(output.includes("real-secret-value"), false);
});

test("review opt-in preserves canonical option and error behavior", async (t) => {
  const fixture = await fixtureWorkspace(t, "project");
  const canonical = await inspectWorkspace({
    start: fixture.root,
    domain: "project",
    producer: { name: "synthetic-producer", version: "1.0.0" },
  });
  const advisory = await inspectWorkspaceWithReviews({
    start: fixture.root,
    domain: "project",
    producer: { name: "synthetic-producer", version: "1.0.0" },
  });
  assert.deepEqual(advisory.location, canonical.location);
  assert.deepEqual(advisory.snapshot, canonical.snapshot);
  assert.deepEqual(advisory.evaluation, canonical.evaluation);
  assert.deepEqual(advisory.view, canonical.view);
  assert.deepEqual(advisory.review_ledger.producer, {
    name: "@dubsar/operator-core",
    version: "0.1.0-dev",
  });

  for (const inspect of [inspectWorkspace, inspectWorkspaceWithReviews]) {
    await assert.rejects(
      inspect({
        start: fixture.root,
        domain: "project",
        limits: { unknownLimit: 1 },
      }),
      (error) =>
        error instanceof WorkbenchError && error.code === "LIMITS_INVALID",
    );
  }
});
