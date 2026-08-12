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
import { spawn } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const labRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

function runCli(script, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: labRoot,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

async function writeJson(file, value) {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

test("audit CLI completes a synthetic user journey", async (t) => {
  const testRoot = await mkdtemp(path.join(tmpdir(), "dubsar-cli-audit-"));
  t.after(async () => {
    await rm(testRoot, { recursive: true, force: true });
  });

  const scripts = path.join(
    labRoot,
    "packages",
    "dubsar-audit-readiness",
    "scripts",
  );
  const workspace = path.join(testRoot, "workspace");
  const output = path.join(testRoot, "bundle");

  const initialized = await runCli(
    path.join(scripts, "init-audit-workspace.mjs"),
    ["--output", workspace, "--case-id", "case-cli-001"],
  );
  assert.equal(initialized.code, 0, initialized.stderr);
  assert.equal(JSON.parse(initialized.stdout).status, "initialized");

  const initialValidation = await runCli(
    path.join(scripts, "validate-audit-workspace.mjs"),
    ["--root", workspace],
  );
  assert.equal(initialValidation.code, 2);
  assert.equal(
    JSON.parse(initialValidation.stdout).preparation_status,
    "not_ready",
  );

  await mkdir(path.join(workspace, "evidence"));
  const artifactBody = '{"kind":"synthetic-workflow"}\n';
  await writeFile(
    path.join(workspace, "evidence", "workflow.json"),
    artifactBody,
    "utf8",
  );
  const sha256 = createHash("sha256")
    .update(artifactBody, "utf8")
    .digest("hex");

  const scope = await readJson(path.join(workspace, "audit-scope.json"));
  Object.assign(scope, {
    objective: "Prepare a synthetic workflow for human review.",
    in_scope: ["Synthetic workflow"],
    approved_evidence: ["artifact-cli-001"],
    completion_criteria: ["The supplied export is indexed."],
    approval: {
      approved_by: "demo-owner",
      approved_at: "2026-01-01T12:00:00Z",
      approval_ref: "demo-approval-cli-001",
      source: "user-provided",
    },
    status: "approved",
  });
  await writeJson(path.join(workspace, "audit-scope.json"), scope);
  await writeJson(path.join(workspace, "automation-inventory.json"), {
    format: "dubsar.automation-inventory/1",
    case_id: "case-cli-001",
    generated_from: ["artifact-cli-001"],
    items: [
      {
        id: "automation-cli-001",
        name: "Synthetic workflow",
        kind: "workflow",
        state: "unknown",
        evidence_state: "observed",
        evidence_refs: ["artifact-cli-001"],
      },
    ],
    gaps: [],
  });
  await writeJson(path.join(workspace, "sensitive-actions.json"), {
    format: "dubsar.sensitive-actions/1",
    case_id: "case-cli-001",
    review_status: "reviewed",
    actions: [],
  });
  await writeJson(path.join(workspace, "evidence-index.json"), {
    format: "dubsar.evidence-index/1",
    case_id: "case-cli-001",
    artifacts: [
      {
        artifact_id: "artifact-cli-001",
        path: "evidence/workflow.json",
        sha256,
      },
    ],
  });
  await writeJson(path.join(workspace, "evidence-review.json"), {
    format: "dubsar.evidence-review/1",
    case_id: "case-cli-001",
    supported_observations: [
      {
        statement: "The synthetic file digest resolves.",
        evidence_refs: ["artifact-cli-001"],
      },
    ],
    reported_statements: [],
    contradictions: [],
    missing_evidence: [],
    limitations: ["No production service was contacted."],
    preparation_status: "ready_for_human_review",
  });

  const readyValidation = await runCli(
    path.join(scripts, "validate-audit-workspace.mjs"),
    ["--root", workspace],
  );
  assert.equal(readyValidation.code, 0, readyValidation.stderr);
  assert.equal(
    JSON.parse(readyValidation.stdout).preparation_status,
    "ready_for_human_review",
  );

  const exported = await runCli(
    path.join(scripts, "export-audit-bundle.mjs"),
    ["--root", workspace, "--output", output],
  );
  assert.equal(exported.code, 0, exported.stderr);
  assert.equal(JSON.parse(exported.stdout).label, "prepared_for_human_review");
  assert.equal(
    (await readJson(path.join(output, "MANIFEST.sha256.json"))).disclaimer,
    "Byte integrity only; this bundle is not an audit result or certification.",
  );
});

test("Hermes pack script completes a project init, validate, and handoff", async (t) => {
  const testRoot = await mkdtemp(path.join(tmpdir(), "dubsar-cli-project-"));
  t.after(async () => {
    await rm(testRoot, { recursive: true, force: true });
  });

  const scripts = path.join(
    labRoot,
    "legacy",
    "hermes-skills",
    "dubsar-project-continuity",
    "scripts",
  );
  const workspace = path.join(testRoot, "workspace");
  const output = path.join(testRoot, "handoff");

  const initialized = await runCli(
    path.join(scripts, "init-project-workspace.mjs"),
    ["--output", workspace, "--mission-id", "mission-cli-001"],
  );
  assert.equal(initialized.code, 0, initialized.stderr);

  const validation = await runCli(
    path.join(scripts, "validate-project-workspace.mjs"),
    ["--root", workspace],
  );
  assert.equal(validation.code, 0, validation.stderr);
  assert.equal(
    JSON.parse(validation.stdout).continuity_status,
    "continuity_valid",
  );

  const rendered = await runCli(
    path.join(scripts, "render-project-summary.mjs"),
    ["--root", workspace, "--output", output],
  );
  assert.equal(rendered.code, 0, rendered.stderr);
  const summary = await readFile(
    path.join(output, "PROJECT-SUMMARY.md"),
    "utf8",
  );
  assert.match(summary, /does not authorize execution/u);
});

test("CLI rejects path traversal before writing", async (t) => {
  const testRoot = await mkdtemp(path.join(tmpdir(), "dubsar-cli-path-"));
  t.after(async () => {
    await rm(testRoot, { recursive: true, force: true });
  });
  const script = path.join(
    labRoot,
    "legacy",
    "hermes-skills",
    "dubsar-project-continuity",
    "scripts",
    "init-project-workspace.mjs",
  );
  const traversal = `${testRoot}${path.sep}nested${path.sep}..${path.sep}escape`;
  const result = await runCli(script, ["--output", traversal]);
  assert.equal(result.code, 1);
  assert.equal(JSON.parse(result.stderr).code, "PATH_TRAVERSAL_REJECTED");
});
