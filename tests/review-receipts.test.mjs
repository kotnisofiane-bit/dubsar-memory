import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { initAuditWorkspace } from "../packages/dubsar-audit-readiness/scripts/init-audit-workspace.mjs";
import {
  currentAuditRootDigest,
  recordAuditReviewReceipt,
} from "../packages/dubsar-audit-readiness/scripts/record-review-receipt.mjs";
import { initProjectWorkspace } from "../legacy/hermes-skills/dubsar-project-continuity/scripts/init-project-workspace.mjs";
import {
  currentProjectRootDigest,
  recordProjectReviewReceipt,
} from "../legacy/hermes-skills/dubsar-project-continuity/scripts/record-review-receipt.mjs";

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

async function writeJson(file, value) {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function projectReceipt(rootDigest, overrides = {}) {
  return {
    format: "dubsar.review-receipt/1",
    context_kind: "project-mission",
    context_id: "mission-review-001",
    decision_id: "architecture-boundary-001",
    receipt_id: "review-001",
    receipt_type: "domain-review",
    role: "architecture",
    isolation: "isolated-subagent",
    advisory: true,
    input_root_sha256: rootDigest,
    resulting_root_sha256: null,
    findings: [
      {
        finding_id: "finding-001",
        severity: "medium",
        summary: "The boundary needs one explicit recovery condition.",
        evidence_refs: ["mission.json#risks"],
      },
    ],
    alternatives: ["Keep the boundary local until recovery is defined."],
    limitations: ["No production runtime was inspected."],
    reviewed_receipts: [],
    ...overrides,
  };
}

test("project receipts are immutable and bound to canonical root digests", async (t) => {
  const testRoot = await mkdtemp(path.join(tmpdir(), "dubsar-project-review-"));
  t.after(async () => rm(testRoot, { recursive: true, force: true }));
  const workspace = path.join(testRoot, "workspace");
  await initProjectWorkspace(workspace, "mission-review-001");
  const rootA = await currentProjectRootDigest(workspace);
  const receipt = projectReceipt(rootA);

  const recorded = await recordProjectReviewReceipt(workspace, receipt);
  assert.equal(recorded.status, "recorded");
  assert.equal(recorded.current_root_sha256, rootA);
  assert.deepEqual(
    await readJson(
      path.join(workspace, "reviews", "architecture-boundary-001", "review-001.json"),
    ),
    receipt,
  );
  assert.equal(await currentProjectRootDigest(workspace), rootA);
  await assert.rejects(
    recordProjectReviewReceipt(workspace, receipt),
    /OUTPUT_FILE_EXISTS/u,
  );

  const missionPath = path.join(workspace, "mission.json");
  const mission = await readJson(missionPath);
  mission.title = "Reviewed boundary";
  await writeJson(missionPath, mission);
  const rootB = await currentProjectRootDigest(workspace);
  assert.notEqual(rootA, rootB);

  const reconciliation = projectReceipt(rootA, {
    receipt_id: "reconciliation-001",
    receipt_type: "reconciliation",
    role: "principal",
    isolation: "self-check",
    resulting_root_sha256: rootB,
    findings: [],
    reviewed_receipts: ["review-001"],
  });
  const reconciled = await recordProjectReviewReceipt(workspace, reconciliation);
  assert.equal(reconciled.current_root_sha256, rootB);

  await assert.rejects(
    recordProjectReviewReceipt(
      workspace,
      projectReceipt(rootA, { receipt_id: "stale-review-001" }),
    ),
    /REVIEW_ROOT_MISMATCH/u,
  );
});

test("audit receipts support not-ready workspaces and reject unsafe payloads", async (t) => {
  const testRoot = await mkdtemp(path.join(tmpdir(), "dubsar-audit-review-"));
  t.after(async () => rm(testRoot, { recursive: true, force: true }));
  const workspace = path.join(testRoot, "workspace");
  await initAuditWorkspace(workspace, "case-review-001");
  const root = await currentAuditRootDigest(workspace);
  const receipt = {
    ...projectReceipt(root),
    context_kind: "audit-case",
    context_id: "case-review-001",
    decision_id: "scope-boundary-001",
    receipt_id: "challenge-001",
    receipt_type: "challenge",
    role: "challenger",
    findings: [],
  };
  const result = await recordAuditReviewReceipt(workspace, receipt);
  assert.equal(result.current_root_sha256, root);
  assert.equal(await currentAuditRootDigest(workspace), root);

  await assert.rejects(
    recordAuditReviewReceipt(workspace, {
      ...receipt,
      receipt_id: "unsafe-field-001",
      prompt: "do not persist this",
    }),
    /RECEIPT_SHAPE_INVALID/u,
  );
  await assert.rejects(
    recordAuditReviewReceipt(workspace, {
      ...receipt,
      receipt_id: "unsafe-secret-001",
      limitations: ["Bearer abcdefghijklmnopqrstuvwxyz"],
    }),
    /RECEIPT_CREDENTIAL_PATTERN/u,
  );
  await assert.rejects(
    recordAuditReviewReceipt(workspace, {
      ...receipt,
      receipt_id: "self-challenge-001",
      isolation: "self-check",
    }),
    /RECEIPT_ROLE_INVALID/u,
  );
});

test("review receipt directories cannot escape through a linked parent", async (t) => {
  const testRoot = await mkdtemp(path.join(tmpdir(), "dubsar-review-link-"));
  t.after(async () => rm(testRoot, { recursive: true, force: true }));
  const workspace = path.join(testRoot, "workspace");
  const outside = path.join(testRoot, "outside");
  await initProjectWorkspace(workspace, "mission-review-001");
  await mkdir(outside);
  try {
    await symlink(
      outside,
      path.join(workspace, "reviews"),
      process.platform === "win32" ? "junction" : "dir",
    );
  } catch (error) {
    if (error?.code === "EPERM") {
      t.skip("Directory-link creation is not permitted on this profile.");
      return;
    }
    throw error;
  }
  const root = await currentProjectRootDigest(workspace);
  await assert.rejects(
    recordProjectReviewReceipt(workspace, projectReceipt(root)),
    /SYMLINK_ANCESTOR_REJECTED/u,
  );
  assert.deepEqual(await readdir(outside), []);
});
