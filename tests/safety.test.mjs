import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { initAuditWorkspace } from "../packages/dubsar-audit-readiness/scripts/init-audit-workspace.mjs";
import { runAuditValidation } from "../packages/dubsar-audit-readiness/scripts/validate-audit-workspace.mjs";
import { exportAuditBundle } from "../packages/dubsar-audit-readiness/scripts/export-audit-bundle.mjs";
import { artifactPolicyFinding } from "../packages/dubsar-audit-readiness/skills/dubsar-audit-readiness/scripts/audit-model.mjs";
import { initProjectWorkspace } from "../legacy/hermes-skills/dubsar-project-continuity/scripts/init-project-workspace.mjs";
import { runProjectValidation } from "../legacy/hermes-skills/dubsar-project-continuity/scripts/validate-project-workspace.mjs";
import { renderProjectSummary } from "../legacy/hermes-skills/dubsar-project-continuity/scripts/render-project-summary.mjs";

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

async function writeJson(file, value) {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function prepareReadyScope(workspace, caseId, artifactId) {
  const scopePath = path.join(workspace, "audit-scope.json");
  const scope = await readJson(scopePath);
  Object.assign(scope, {
    objective: "Review a synthetic artifact.",
    in_scope: ["Synthetic artifact"],
    approved_evidence: [artifactId],
    completion_criteria: ["The artifact is safely indexable."],
    approval: {
      approved_by: "demo-owner",
      approved_at: "2026-01-01T12:00:00Z",
      approval_ref: `approval-${caseId}`,
      source: "user-provided",
    },
    status: "approved",
  });
  await writeJson(scopePath, scope);
  await writeJson(path.join(workspace, "automation-inventory.json"), {
    format: "dubsar.automation-inventory/1",
    case_id: caseId,
    generated_from: [artifactId],
    items: [
      {
        id: `automation-${caseId}`,
        evidence_refs: [artifactId],
      },
    ],
    gaps: [],
  });
  await writeJson(path.join(workspace, "sensitive-actions.json"), {
    format: "dubsar.sensitive-actions/1",
    case_id: caseId,
    review_status: "reviewed",
    actions: [],
  });
  await writeJson(path.join(workspace, "evidence-review.json"), {
    format: "dubsar.evidence-review/1",
    case_id: caseId,
    supported_observations: [],
    reported_statements: [],
    contradictions: [],
    missing_evidence: [],
    limitations: [],
    preparation_status: "ready_for_human_review",
  });
}

test("credential-like audit artifacts are blocked without echoing values", async (t) => {
  const testRoot = await mkdtemp(path.join(tmpdir(), "dubsar-safety-secret-"));
  t.after(async () => {
    await rm(testRoot, { recursive: true, force: true });
  });
  const workspace = path.join(testRoot, "workspace");
  await initAuditWorkspace(workspace, "case-safety-001");
  await prepareReadyScope(
    workspace,
    "case-safety-001",
    "artifact-safety-001",
  );

  const credentialBody = '{"password":"not-a-real-but-unsafe-value"}\n';
  const credentialPath = path.join(workspace, "unsafe-settings.json");
  await writeFile(credentialPath, credentialBody, "utf8");
  await writeJson(path.join(workspace, "evidence-index.json"), {
    format: "dubsar.evidence-index/1",
    case_id: "case-safety-001",
    artifacts: [
      {
        artifact_id: "artifact-safety-001",
        path: "unsafe-settings.json",
        sha256: createHash("sha256")
          .update(credentialBody, "utf8")
          .digest("hex"),
      },
    ],
  });

  const validation = await runAuditValidation(workspace);
  assert.equal(validation.status, "invalid");
  assert.ok(
    validation.findings.includes("ARTIFACT_CREDENTIAL_ASSIGNMENT"),
  );
  assert.equal(JSON.stringify(validation).includes("unsafe-value"), false);
});

test("common structured credential keys and credential URLs are detected", () => {
  for (const key of [
    "client_secret",
    "refresh_token",
    "private_key",
    "access_token",
    "connection_string",
  ]) {
    const content = Buffer.from(
      JSON.stringify({ [key]: "synthetic-unsafe-value" }),
      "utf8",
    );
    assert.equal(
      artifactPolicyFinding("config.json", content),
      "ARTIFACT_CREDENTIAL_ASSIGNMENT",
      key,
    );
  }
  assert.equal(
    artifactPolicyFinding(
      "config.txt",
      Buffer.from("database=postgres://demo:unsafe-pass@localhost/db", "utf8"),
    ),
    "ARTIFACT_CREDENTIAL_URL",
  );
});

test("audit export cannot target a child of its source workspace", async (t) => {
  const testRoot = await mkdtemp(path.join(tmpdir(), "dubsar-safety-output-"));
  t.after(async () => {
    await rm(testRoot, { recursive: true, force: true });
  });
  const workspace = path.join(testRoot, "workspace");
  await initAuditWorkspace(workspace, "case-safety-002");
  await assert.rejects(
    exportAuditBundle(workspace, path.join(workspace, "bundle")),
    /OUTPUT_INSIDE_WORKSPACE/u,
  );
});

test("audit evidence cannot reserve the generated summary path", async (t) => {
  const testRoot = await mkdtemp(path.join(tmpdir(), "dubsar-summary-collision-"));
  t.after(async () => {
    await rm(testRoot, { recursive: true, force: true });
  });
  const workspace = path.join(testRoot, "workspace");
  const caseId = "case-summary-collision";
  const artifactId = "artifact-summary-collision";
  await initAuditWorkspace(workspace, caseId);
  await prepareReadyScope(workspace, caseId, artifactId);
  const body = "reserved collision fixture\n";
  await writeFile(
    path.join(workspace, "AUDIT-PREPARATION-SUMMARY.md"),
    body,
    "utf8",
  );
  await writeJson(path.join(workspace, "evidence-index.json"), {
    format: "dubsar.evidence-index/1",
    case_id: caseId,
    artifacts: [
      {
        artifact_id: artifactId,
        path: "AUDIT-PREPARATION-SUMMARY.md",
        sha256: createHash("sha256").update(body, "utf8").digest("hex"),
      },
    ],
  });
  const validation = await runAuditValidation(workspace);
  assert.equal(validation.status, "invalid");
  assert.ok(validation.findings.includes("ARTIFACT_PATH_RESERVED"));
  await assert.rejects(
    exportAuditBundle(workspace, path.join(testRoot, "bundle")),
    /WORKSPACE_NOT_READY/u,
  );
});

test("project summary cannot target a child of its source workspace", async (t) => {
  const testRoot = await mkdtemp(
    path.join(tmpdir(), "dubsar-safety-project-output-"),
  );
  t.after(async () => {
    await rm(testRoot, { recursive: true, force: true });
  });
  const workspace = path.join(testRoot, "workspace");
  await initProjectWorkspace(workspace, "mission-safety-output");
  await assert.rejects(
    renderProjectSummary(workspace, path.join(workspace, "summary")),
    /OUTPUT_INSIDE_WORKSPACE/u,
  );
});

test("symbolic-link evidence is rejected when the platform permits the fixture", async (t) => {
  const testRoot = await mkdtemp(path.join(tmpdir(), "dubsar-safety-link-"));
  t.after(async () => {
    await rm(testRoot, { recursive: true, force: true });
  });
  const workspace = path.join(testRoot, "workspace");
  await initAuditWorkspace(workspace, "case-safety-003");
  await prepareReadyScope(
    workspace,
    "case-safety-003",
    "artifact-safety-003",
  );
  const outside = path.join(testRoot, "outside.txt");
  const body = "synthetic\n";
  await writeFile(outside, body, "utf8");
  const link = path.join(workspace, "linked-evidence.txt");
  try {
    await symlink(outside, link, "file");
  } catch (error) {
    if (error?.code === "EPERM") {
      t.skip("Symbolic-link creation is not permitted on this Windows profile.");
      return;
    }
    throw error;
  }
  await writeJson(path.join(workspace, "evidence-index.json"), {
    format: "dubsar.evidence-index/1",
    case_id: "case-safety-003",
    artifacts: [
      {
        artifact_id: "artifact-safety-003",
        path: "linked-evidence.txt",
        sha256: createHash("sha256").update(body, "utf8").digest("hex"),
      },
    ],
  });
  const validation = await runAuditValidation(workspace);
  assert.equal(validation.status, "invalid");
  assert.ok(
    validation.findings.some((finding) =>
      finding.includes("ARTIFACT_NOT_REGULAR_FILE"),
    ),
  );
});

test("a directory link cannot route evidence outside the workspace", async (t) => {
  const testRoot = await mkdtemp(path.join(tmpdir(), "dubsar-safety-junction-"));
  t.after(async () => {
    await rm(testRoot, { recursive: true, force: true });
  });
  const workspace = path.join(testRoot, "workspace");
  await initAuditWorkspace(workspace, "case-safety-junction");
  await prepareReadyScope(
    workspace,
    "case-safety-junction",
    "artifact-safety-junction",
  );
  const outsideDirectory = path.join(testRoot, "outside");
  await mkdir(outsideDirectory);
  const body = "synthetic junction evidence\n";
  await writeFile(path.join(outsideDirectory, "evidence.txt"), body, "utf8");
  const linkDirectory = path.join(workspace, "linked-directory");
  try {
    await symlink(
      outsideDirectory,
      linkDirectory,
      process.platform === "win32" ? "junction" : "dir",
    );
  } catch (error) {
    if (error?.code === "EPERM") {
      t.skip("Directory-link creation is not permitted on this profile.");
      return;
    }
    throw error;
  }
  await writeJson(path.join(workspace, "evidence-index.json"), {
    format: "dubsar.evidence-index/1",
    case_id: "case-safety-junction",
    artifacts: [
      {
        artifact_id: "artifact-safety-junction",
        path: "linked-directory/evidence.txt",
        sha256: createHash("sha256").update(body, "utf8").digest("hex"),
      },
    ],
  });

  const validation = await runAuditValidation(workspace);
  assert.equal(validation.status, "invalid");
  assert.ok(validation.findings.includes("ARTIFACT_OUTSIDE_WORKSPACE"));
});

test("workspace creation rejects linked targets and ancestors", async (t) => {
  const testRoot = await mkdtemp(
    path.join(tmpdir(), "dubsar-safety-workspace-link-"),
  );
  t.after(async () => {
    await rm(testRoot, { recursive: true, force: true });
  });

  const linkType = process.platform === "win32" ? "junction" : "dir";
  const outsideAudit = path.join(testRoot, "outside-audit");
  const outsideProject = path.join(testRoot, "outside-project");
  const outsideAncestor = path.join(testRoot, "outside-ancestor");
  await mkdir(outsideAudit);
  await mkdir(outsideProject);
  await mkdir(outsideAncestor);

  const auditTargetLink = path.join(testRoot, "audit-target-link");
  const projectTargetLink = path.join(testRoot, "project-target-link");
  const ancestorLink = path.join(testRoot, "ancestor-link");
  try {
    await symlink(outsideAudit, auditTargetLink, linkType);
    await symlink(outsideProject, projectTargetLink, linkType);
    await symlink(outsideAncestor, ancestorLink, linkType);
  } catch (error) {
    if (error?.code === "EPERM") {
      t.skip("Directory-link creation is not permitted on this profile.");
      return;
    }
    throw error;
  }

  const rejectsLinkedPath = (error) =>
    error?.code === "SYMLINK_ANCESTOR_REJECTED";
  await assert.rejects(
    initAuditWorkspace(auditTargetLink, "case-linked-target"),
    rejectsLinkedPath,
  );
  await assert.rejects(
    initProjectWorkspace(projectTargetLink, "mission-linked-target"),
    rejectsLinkedPath,
  );
  await assert.rejects(
    initAuditWorkspace(
      path.join(ancestorLink, "audit-child"),
      "case-linked-ancestor",
    ),
    rejectsLinkedPath,
  );
  await assert.rejects(
    initProjectWorkspace(
      path.join(ancestorLink, "project-child"),
      "mission-linked-ancestor",
    ),
    rejectsLinkedPath,
  );
});

test("cyclic project lots block continuity", async (t) => {
  const testRoot = await mkdtemp(path.join(tmpdir(), "dubsar-safety-cycle-"));
  t.after(async () => {
    await rm(testRoot, { recursive: true, force: true });
  });
  const workspace = path.join(testRoot, "workspace");
  await initProjectWorkspace(workspace, "mission-safety-001");
  await writeJson(path.join(workspace, "lots.json"), {
    format: "dubsar.project-lots/1",
    mission_id: "mission-safety-001",
    lots: [
      {
        lot_id: "lot-a",
        title: "Lot A",
        depends_on: ["lot-b"],
        expected_evidence: [],
        status: "candidate",
      },
      {
        lot_id: "lot-b",
        title: "Lot B",
        depends_on: ["lot-a"],
        expected_evidence: [],
        status: "planned",
      },
    ],
  });
  const validation = await runProjectValidation(workspace);
  assert.equal(validation.continuity_status, "continuity_blocked");
  assert.ok(validation.findings.includes("LOT_DEPENDENCY_CYCLE"));
});

test("an approved artifact must actually support the automation inventory", async (t) => {
  const testRoot = await mkdtemp(path.join(tmpdir(), "dubsar-safety-linkage-"));
  t.after(async () => {
    await rm(testRoot, { recursive: true, force: true });
  });
  const workspace = path.join(testRoot, "workspace");
  await initAuditWorkspace(workspace, "case-safety-004");
  await prepareReadyScope(
    workspace,
    "case-safety-004",
    "artifact-safety-004",
  );
  const body = "synthetic\n";
  await writeFile(path.join(workspace, "artifact.txt"), body, "utf8");
  await writeJson(path.join(workspace, "evidence-index.json"), {
    format: "dubsar.evidence-index/1",
    case_id: "case-safety-004",
    artifacts: [
      {
        artifact_id: "artifact-safety-004",
        path: "artifact.txt",
        sha256: createHash("sha256").update(body, "utf8").digest("hex"),
      },
    ],
  });
  const inventory = await readJson(
    path.join(workspace, "automation-inventory.json"),
  );
  inventory.generated_from = [];
  inventory.items[0].evidence_refs = [];
  await writeJson(
    path.join(workspace, "automation-inventory.json"),
    inventory,
  );

  const validation = await runAuditValidation(workspace);
  assert.equal(validation.status, "invalid");
  assert.ok(
    validation.readiness_reasons.includes("INVENTORY_SOURCE_LINK_MISSING"),
  );
  assert.ok(
    validation.readiness_reasons.includes(
      "INVENTORY_ITEM_EVIDENCE_LINK_MISSING",
    ),
  );
});

test("a supported audit observation must cite indexed evidence", async (t) => {
  const testRoot = await mkdtemp(
    path.join(tmpdir(), "dubsar-safety-observation-link-"),
  );
  t.after(async () => {
    await rm(testRoot, { recursive: true, force: true });
  });
  const workspace = path.join(testRoot, "workspace");
  const caseId = "case-observation-link-001";
  const artifactId = "artifact-observation-link-001";
  await initAuditWorkspace(workspace, caseId);
  await prepareReadyScope(workspace, caseId, artifactId);

  const evidenceBody = '{"workflow":"synthetic"}\n';
  await writeFile(
    path.join(workspace, "workflow.json"),
    evidenceBody,
    "utf8",
  );
  await writeJson(path.join(workspace, "evidence-index.json"), {
    format: "dubsar.evidence-index/1",
    case_id: caseId,
    artifacts: [
      {
        artifact_id: artifactId,
        path: "workflow.json",
        sha256: createHash("sha256")
          .update(evidenceBody, "utf8")
          .digest("hex"),
      },
    ],
  });
  const reviewPath = path.join(workspace, "evidence-review.json");
  const review = await readJson(reviewPath);
  review.supported_observations = [
    {
      statement: "The synthetic workflow exists.",
      evidence_refs: [],
    },
  ];
  await writeJson(reviewPath, review);

  const validation = await runAuditValidation(workspace);
  assert.equal(validation.status, "invalid");
  assert.ok(
    validation.findings.includes(
      "SUPPORTED_OBSERVATION_EVIDENCE_LINK_MISSING",
    ),
  );
});

test("observed evidence without artifact and validation support is rejected", async (t) => {
  const testRoot = await mkdtemp(path.join(tmpdir(), "dubsar-safety-proof-"));
  t.after(async () => {
    await rm(testRoot, { recursive: true, force: true });
  });
  const workspace = path.join(testRoot, "workspace");
  await initProjectWorkspace(workspace, "mission-safety-002");
  await writeJson(path.join(workspace, "lots.json"), {
    format: "dubsar.project-lots/1",
    mission_id: "mission-safety-002",
    lots: [
      {
        lot_id: "lot-proof",
        title: "Unsupported completion",
        depends_on: [],
        in_scope: [],
        excluded: [],
        expected_evidence: ["evidence-proof"],
        validation: [],
        stop_conditions: [],
        status: "complete",
      },
    ],
  });
  await writeJson(path.join(workspace, "evidence.json"), {
    format: "dubsar.project-evidence/2",
    mission_id: "mission-safety-002",
    entries: [
      {
        evidence_id: "evidence-proof",
        lot_id: "lot-proof",
        kind: "fact",
        statement: "The lot is complete.",
        class: "observed",
        artifact_refs: [],
        validation: [],
        limitations: [],
        resolves: null,
      },
    ],
  });
  const validation = await runProjectValidation(workspace);
  assert.equal(validation.status, "invalid");
  assert.ok(validation.findings.includes("EVIDENCE_SUPPORT_MISSING"));
  assert.ok(validation.findings.includes("COMPLETE_LOT_EVIDENCE_MISSING"));
});

test("derived evidence without artifact and validation support is rejected", async (t) => {
  const testRoot = await mkdtemp(path.join(tmpdir(), "dubsar-safety-derived-"));
  t.after(async () => {
    await rm(testRoot, { recursive: true, force: true });
  });
  const workspace = path.join(testRoot, "workspace");
  await initProjectWorkspace(workspace, "mission-safety-derived");
  await writeJson(path.join(workspace, "lots.json"), {
    format: "dubsar.project-lots/1",
    mission_id: "mission-safety-derived",
    lots: [
      {
        lot_id: "lot-derived",
        title: "Unsupported derived completion",
        depends_on: [],
        expected_evidence: ["evidence-derived"],
        status: "complete",
      },
    ],
  });
  await writeJson(path.join(workspace, "evidence.json"), {
    format: "dubsar.project-evidence/1",
    mission_id: "mission-safety-derived",
    entries: [
      {
        evidence_id: "evidence-derived",
        lot_id: "lot-derived",
        claim: "A derived value exists.",
        class: "derived",
        artifact_refs: [],
        validation: [],
        limitations: [],
      },
    ],
  });
  const validation = await runProjectValidation(workspace);
  assert.equal(validation.status, "invalid");
  assert.ok(validation.findings.includes("EVIDENCE_SUPPORT_MISSING"));
  assert.ok(validation.findings.includes("COMPLETE_LOT_EVIDENCE_MISSING"));
});

test("project handoff escapes remote-image Markdown and raw HTML", async (t) => {
  const testRoot = await mkdtemp(path.join(tmpdir(), "dubsar-safety-markdown-"));
  t.after(async () => {
    await rm(testRoot, { recursive: true, force: true });
  });
  const workspace = path.join(testRoot, "workspace");
  await initProjectWorkspace(workspace, "mission-safety-003");
  const mission = await readJson(path.join(workspace, "mission.json"));
  Object.assign(mission, {
    title: "![remote](https://example.invalid/pixel)<img src=x>",
    desired_outcome: "<script>synthetic</script>",
    status: "approved",
  });
  await writeJson(path.join(workspace, "mission.json"), mission);
  await writeJson(path.join(workspace, "lots.json"), {
    format: "dubsar.project-lots/1",
    mission_id: "mission-safety-003",
    lots: [
      {
        lot_id: "lot-markdown",
        title: "Synthetic handoff",
        depends_on: [],
        in_scope: [],
        excluded: [],
        expected_evidence: ["evidence-markdown"],
        validation: [],
        stop_conditions: [],
        status: "candidate",
      },
    ],
  });
  await writeJson(path.join(workspace, "execution-contract.json"), {
    format: "dubsar.execution-contract/1",
    mission_id: "mission-safety-003",
    lot_id: "lot-markdown",
    contract_id: "contract-markdown",
    targets: [],
    allowed_actions: [],
    forbidden_actions: [],
    protected_areas: [],
    validation: [],
    required_evidence: [],
    recovery_expectations: [],
    stop_conditions: [],
    status: "approved",
  });
  await writeJson(path.join(workspace, "evidence.json"), {
    format: "dubsar.project-evidence/2",
    mission_id: "mission-safety-003",
    entries: [
      {
        evidence_id: "evidence-markdown",
        lot_id: "lot-markdown",
        kind: "fact",
        statement: "Synthetic evidence was reported.",
        class: "reported",
        artifact_refs: [],
        validation: ["Human report only"],
        limitations: [],
        resolves: null,
      },
    ],
  });
  const output = path.join(testRoot, "handoff");
  await renderProjectSummary(workspace, output);
  const summary = await readFile(
    path.join(output, "PROJECT-SUMMARY.md"),
    "utf8",
  );
  assert.equal(summary.includes("![remote]("), false);
  assert.equal(summary.includes("<img"), false);
  assert.equal(summary.includes("<script>"), false);
  assert.match(summary, /&lt;img src=x&gt;/u);
});
