import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { initAuditWorkspace } from "../packages/dubsar-audit-readiness/scripts/init-audit-workspace.mjs";
import { runAuditValidation } from "../packages/dubsar-audit-readiness/scripts/validate-audit-workspace.mjs";
import { exportAuditBundle } from "../packages/dubsar-audit-readiness/scripts/export-audit-bundle.mjs";
import { renderAuditSummary } from "../packages/dubsar-audit-readiness/scripts/render-audit-summary.mjs";

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

async function writeJson(file, value) {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

test("audit bundle is deterministic and remains non-certifying", async (t) => {
  const testRoot = await mkdtemp(path.join(tmpdir(), "dubsar-audit-"));
  t.after(async () => {
    await rm(testRoot, { recursive: true, force: true });
  });
  const workspace = path.join(testRoot, "workspace");
  await initAuditWorkspace(workspace, "case-demo-001");

  const evidenceDirectory = path.join(workspace, "evidence");
  await mkdir(evidenceDirectory);
  const evidenceBody = '{"workflow":"synthetic","writes":false}\n';
  const evidencePath = path.join(evidenceDirectory, "workflow.json");
  await writeFile(evidencePath, evidenceBody, "utf8");
  const evidenceDigest = createHash("sha256")
    .update(evidenceBody, "utf8")
    .digest("hex");

  const scopePath = path.join(workspace, "audit-scope.json");
  const scope = await readJson(scopePath);
  Object.assign(scope, {
    objective: "Check whether a synthetic suppression rule is represented.",
    in_scope: ["Synthetic CRM state", "Synthetic workflow export"],
    approved_evidence: ["artifact-workflow"],
    completion_criteria: ["Both synthetic sources are represented."],
    approval: {
      approved_by: "demo-owner",
      approved_at: "2026-01-01T12:00:00Z",
      approval_ref: "demo-approval-001",
      source: "user-provided",
    },
    status: "approved",
  });
  await writeJson(scopePath, scope);

  await writeJson(path.join(workspace, "automation-inventory.json"), {
    format: "dubsar.automation-inventory/1",
    case_id: "case-demo-001",
    generated_from: ["artifact-workflow"],
    items: [
      {
        id: "automation-demo-001",
        name: "Synthetic follow-up",
        kind: "workflow",
        purpose: "Demonstrate a read-only review.",
        owner: "demo-role",
        trigger: "synthetic-event",
        inputs: ["synthetic-contact-state"],
        outputs: ["synthetic-message-candidate"],
        connected_systems: ["demo-crm"],
        state: "active",
        evidence_state: "observed",
        evidence_refs: ["artifact-workflow"],
      },
    ],
    gaps: [],
  });

  await writeJson(path.join(workspace, "sensitive-actions.json"), {
    format: "dubsar.sensitive-actions/1",
    case_id: "case-demo-001",
    review_status: "reviewed",
    actions: [
      {
        id: "action-demo-001",
        automation_id: "automation-demo-001",
        effect: "Prepare an external message candidate.",
        classes: ["communication"],
        current_safeguards: ["Synthetic fixture only"],
        evidence_refs: ["artifact-workflow"],
        uncertainties: [],
        proposed_review_point: "Review before sending.",
        proposed_stop_condition: "Suppression state is unknown.",
        accountable_role: "demo-owner",
        human_status: "unreviewed",
      },
    ],
  });

  await writeJson(path.join(workspace, "evidence-index.json"), {
    format: "dubsar.evidence-index/1",
    case_id: "case-demo-001",
    artifacts: [
      {
        artifact_id: "artifact-workflow",
        path: "evidence/workflow.json",
        sha256: evidenceDigest,
      },
    ],
  });

  await writeJson(path.join(workspace, "evidence-review.json"), {
    format: "dubsar.evidence-review/1",
    case_id: "case-demo-001",
    supported_observations: [
      {
        statement: "The synthetic export is internally readable.",
        evidence_refs: ["artifact-workflow"],
      },
    ],
    reported_statements: [],
    contradictions: [],
    missing_evidence: [],
    limitations: ["No production service was contacted."],
    preparation_status: "ready_for_human_review",
  });

  const validation = await runAuditValidation(workspace);
  assert.equal(validation.status, "valid");
  assert.equal(validation.preparation_status, "ready_for_human_review");
  assert.deepEqual(validation.findings, []);

  const firstOutput = path.join(testRoot, "bundle-a");
  const secondOutput = path.join(testRoot, "bundle-b");
  const first = await exportAuditBundle(workspace, firstOutput);
  const second = await exportAuditBundle(workspace, secondOutput);
  assert.equal(first.root_sha256, second.root_sha256);
  assert.equal(first.label, "prepared_for_human_review");
  assert.equal(first.file_count, 7);
  const summary = await readFile(
    path.join(firstOutput, "AUDIT-PREPARATION-SUMMARY.md"),
    "utf8",
  );
  assert.match(summary, /# Audit preparation summary/u);
  assert.match(summary, /not an audit result/u);

  const firstManifest = await readFile(
    path.join(firstOutput, "MANIFEST.sha256.json"),
    "utf8",
  );
  const secondManifest = await readFile(
    path.join(secondOutput, "MANIFEST.sha256.json"),
    "utf8",
  );
  assert.equal(firstManifest, secondManifest);
  assert.match(firstManifest, /not an audit result or certification/u);
});

test("an incomplete audit workspace is valid structure but not ready", async (t) => {
  const testRoot = await mkdtemp(path.join(tmpdir(), "dubsar-audit-gap-"));
  t.after(async () => {
    await rm(testRoot, { recursive: true, force: true });
  });
  const workspace = path.join(testRoot, "workspace");
  await initAuditWorkspace(workspace, "case-demo-002");

  const validation = await runAuditValidation(workspace);
  assert.equal(validation.status, "valid");
  assert.equal(validation.preparation_status, "not_ready");
  assert.deepEqual(validation.readiness_reasons, [
    "APPROVED_EVIDENCE_MISSING",
    "ATTRIBUTABLE_SCOPE_APPROVAL_MISSING",
    "AUTOMATION_INVENTORY_EMPTY",
    "COMPLETION_CRITERIA_MISSING",
    "EVIDENCE_ARTIFACTS_MISSING",
    "EVIDENCE_GAPS_DECLARED",
    "INVENTORY_SOURCE_LINK_MISSING",
    "OBJECTIVE_MISSING",
    "SCOPE_ITEMS_MISSING",
    "SCOPE_NOT_APPROVED",
    "SENSITIVE_ACTION_REVIEW_PENDING",
  ]);

  const summaryOutput = path.join(testRoot, "not-ready-summary");
  const rendered = await renderAuditSummary(workspace, summaryOutput);
  assert.equal(rendered.preparation_status, "not_ready");
  assert.match(
    await readFile(
      path.join(summaryOutput, "AUDIT-PREPARATION-SUMMARY.md"),
      "utf8",
    ),
    /SCOPE\\_NOT\\_APPROVED/u,
  );

  await assert.rejects(
    exportAuditBundle(workspace, path.join(testRoot, "refused-bundle")),
    /WORKSPACE_NOT_READY/u,
  );
  await assert.rejects(
    initAuditWorkspace(workspace, "case-demo-002"),
    /OUTPUT_NOT_EMPTY/u,
  );
});
