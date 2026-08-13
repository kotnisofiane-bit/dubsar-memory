import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
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
import { ensureAuditWorkspace } from "../packages/dubsar-audit-readiness/scripts/ensure-audit-workspace.mjs";
import { runAuditValidation } from "../packages/dubsar-audit-readiness/scripts/validate-audit-workspace.mjs";
import { ensureProjectWorkspace } from "../legacy/hermes-skills/dubsar-project-continuity/scripts/ensure-project-workspace.mjs";
import { locateProjectWorkspace } from "../legacy/hermes-skills/dubsar-project-continuity/scripts/locate-project-workspace.mjs";
import { runProjectValidation } from "../legacy/hermes-skills/dubsar-project-continuity/scripts/validate-project-workspace.mjs";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

async function writeJson(file, value) {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function rejectsWith(code) {
  return (error) => error?.code === code;
}

function runCli(script, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: repositoryRoot,
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
      resolve({ code, stderr, stdout });
    });
  });
}

test("project discovery initializes once, reuses from nested paths, and honors an override", async (t) => {
  const testRoot = await mkdtemp(path.join(tmpdir(), "dubsar-ensure-project-"));
  t.after(async () => {
    await rm(testRoot, { recursive: true, force: true });
  });
  const projectRoot = path.join(testRoot, "repo");
  const nested = path.join(projectRoot, "packages", "app", "src");
  await mkdir(path.join(projectRoot, ".git"), { recursive: true });
  await mkdir(nested, { recursive: true });

  const beforeLocate = await readdir(projectRoot);
  assert.deepEqual(await locateProjectWorkspace({ start: nested }), {
    status: "continuity_absent",
    mission_id: null,
    workspace: null,
  });
  assert.deepEqual(await readdir(projectRoot), beforeLocate);

  const initialized = await ensureProjectWorkspace({ start: projectRoot });
  assert.deepEqual(Object.keys(initialized).sort(), [
    "mission_id",
    "status",
    "workspace",
  ]);
  assert.equal(initialized.status, "initialized");
  assert.equal(initialized.workspace, ".dubsar-project");
  assert.equal(path.isAbsolute(initialized.workspace), false);

  const reused = await ensureProjectWorkspace({ start: nested });
  assert.equal(reused.status, "reused");
  assert.equal(reused.workspace, "../../../.dubsar-project");
  assert.equal(reused.mission_id, initialized.mission_id);
  assert.equal(
    (await runProjectValidation(path.resolve(nested, reused.workspace))).status,
    "valid",
  );
  assert.deepEqual(await locateProjectWorkspace({ start: nested }), {
    status: "located",
    mission_id: initialized.mission_id,
    workspace: "../../../.dubsar-project",
  });

  const override = path.join(
    projectRoot,
    "packages",
    "app",
    ".dubsar-project",
  );
  const overridden = await ensureProjectWorkspace({
    start: nested,
    workspace: override,
    missionId: "mission-override-001",
  });
  assert.deepEqual(overridden, {
    status: "initialized",
    mission_id: "mission-override-001",
    workspace: "../.dubsar-project",
  });

  const nearest = await ensureProjectWorkspace({ start: nested });
  assert.deepEqual(nearest, {
    status: "reused",
    mission_id: "mission-override-001",
    workspace: "../.dubsar-project",
  });
  assert.deepEqual(await locateProjectWorkspace({ start: nested }), {
    status: "located",
    mission_id: "mission-override-001",
    workspace: "../.dubsar-project",
  });

  await assert.rejects(
    ensureProjectWorkspace({
      start: nested,
      workspace: path.join(testRoot, "outside", ".dubsar-project"),
    }),
    rejectsWith("WORKSPACE_OUTSIDE_PROJECT"),
  );
  await assert.rejects(
    ensureProjectWorkspace({
      start: nested,
      workspace: path.join(projectRoot, "wrong-name"),
    }),
    rejectsWith("INVALID_WORKSPACE_MARKER"),
  );
});

test("audit discovery initializes once, reuses from nested paths, and honors an override", async (t) => {
  const testRoot = await mkdtemp(path.join(tmpdir(), "dubsar-ensure-audit-"));
  t.after(async () => {
    await rm(testRoot, { recursive: true, force: true });
  });
  const projectRoot = path.join(testRoot, "repo");
  const nested = path.join(projectRoot, "services", "worker", "src");
  await mkdir(path.join(projectRoot, ".git"), { recursive: true });
  await mkdir(nested, { recursive: true });

  const initialized = await ensureAuditWorkspace({ start: projectRoot });
  assert.deepEqual(Object.keys(initialized).sort(), [
    "case_id",
    "status",
    "workspace",
  ]);
  assert.equal(initialized.status, "initialized");
  assert.equal(initialized.workspace, ".dubsar-audit");
  assert.equal(path.isAbsolute(initialized.workspace), false);

  const reused = await ensureAuditWorkspace({ start: nested });
  assert.equal(reused.status, "reused");
  assert.equal(reused.workspace, "../../../.dubsar-audit");
  assert.equal(reused.case_id, initialized.case_id);
  assert.equal(
    (await runAuditValidation(path.resolve(nested, reused.workspace))).status,
    "valid",
  );

  const override = path.join(
    projectRoot,
    "services",
    "worker",
    ".dubsar-audit",
  );
  const overridden = await ensureAuditWorkspace({
    start: nested,
    workspace: override,
    caseId: "case-override-001",
  });
  assert.deepEqual(overridden, {
    status: "initialized",
    case_id: "case-override-001",
    workspace: "../.dubsar-audit",
  });

  const nearest = await ensureAuditWorkspace({ start: nested });
  assert.deepEqual(nearest, {
    status: "reused",
    case_id: "case-override-001",
    workspace: "../.dubsar-audit",
  });

  await assert.rejects(
    ensureAuditWorkspace({
      start: nested,
      workspace: path.join(testRoot, "outside", ".dubsar-audit"),
    }),
    rejectsWith("WORKSPACE_OUTSIDE_PROJECT"),
  );
  await assert.rejects(
    ensureAuditWorkspace({
      start: nested,
      workspace: path.join(projectRoot, "wrong-name"),
    }),
    rejectsWith("INVALID_WORKSPACE_MARKER"),
  );
});

test("discovery falls back to the supplied start when no Git root exists", async (t) => {
  const testRoot = await mkdtemp(path.join(tmpdir(), "dubsar-ensure-fallback-"));
  t.after(async () => {
    await rm(testRoot, { recursive: true, force: true });
  });
  const start = path.join(testRoot, "standalone");
  await mkdir(start);

  const project = await ensureProjectWorkspace({ start });
  const audit = await ensureAuditWorkspace({ start });
  assert.equal(project.workspace, ".dubsar-project");
  assert.equal(audit.workspace, ".dubsar-audit");
});

test("incomplete, identity-mismatched, or malformed markers block reuse", async (t) => {
  const testRoot = await mkdtemp(path.join(tmpdir(), "dubsar-ensure-invalid-"));
  t.after(async () => {
    await rm(testRoot, { recursive: true, force: true });
  });
  const projectRoot = path.join(testRoot, "repo");
  await mkdir(path.join(projectRoot, ".git"), { recursive: true });
  await mkdir(path.join(projectRoot, ".dubsar-project"));
  await mkdir(path.join(projectRoot, ".dubsar-audit"));

  await assert.rejects(
    ensureProjectWorkspace({ start: projectRoot }),
    rejectsWith("WORKSPACE_INCOMPLETE"),
  );
  await assert.rejects(
    ensureAuditWorkspace({ start: projectRoot }),
    rejectsWith("WORKSPACE_INCOMPLETE"),
  );

  await rm(path.join(projectRoot, ".dubsar-project"), {
    recursive: true,
    force: true,
  });
  await rm(path.join(projectRoot, ".dubsar-audit"), {
    recursive: true,
    force: true,
  });
  await ensureProjectWorkspace({
    start: projectRoot,
    missionId: "mission-consistent-001",
  });
  await ensureAuditWorkspace({
    start: projectRoot,
    caseId: "case-consistent-001",
  });

  const lotsPath = path.join(projectRoot, ".dubsar-project", "lots.json");
  const lots = await readJson(lotsPath);
  lots.mission_id = "mission-divergent-001";
  await writeJson(lotsPath, lots);
  const inventoryPath = path.join(
    projectRoot,
    ".dubsar-audit",
    "automation-inventory.json",
  );
  const inventory = await readJson(inventoryPath);
  inventory.case_id = "case-divergent-001";
  await writeJson(inventoryPath, inventory);

  await assert.rejects(
    ensureProjectWorkspace({ start: projectRoot }),
    rejectsWith("MISSION_ID_MISMATCH"),
  );
  await assert.rejects(
    ensureAuditWorkspace({ start: projectRoot }),
    rejectsWith("CASE_ID_MISMATCH"),
  );

  lots.mission_id = "mission-consistent-001";
  lots.format = "invalid.project-lots";
  await writeJson(lotsPath, lots);
  inventory.case_id = "case-consistent-001";
  inventory.format = "invalid.automation-inventory";
  await writeJson(inventoryPath, inventory);

  await assert.rejects(
    ensureProjectWorkspace({ start: projectRoot }),
    rejectsWith("WORKSPACE_INVALID"),
  );
  await assert.rejects(
    ensureAuditWorkspace({ start: projectRoot }),
    rejectsWith("WORKSPACE_INVALID"),
  );
});

test("linked markers are rejected during discovery", async (t) => {
  const testRoot = await mkdtemp(path.join(tmpdir(), "dubsar-ensure-links-"));
  t.after(async () => {
    await rm(testRoot, { recursive: true, force: true });
  });
  const projectRoot = path.join(testRoot, "repo");
  const nested = path.join(projectRoot, "src");
  const outsideProject = path.join(testRoot, "outside-project");
  const outsideAudit = path.join(testRoot, "outside-audit");
  await mkdir(path.join(projectRoot, ".git"), { recursive: true });
  await mkdir(nested);
  await mkdir(outsideProject);
  await mkdir(outsideAudit);

  const linkType = process.platform === "win32" ? "junction" : "dir";
  try {
    await symlink(
      outsideProject,
      path.join(projectRoot, ".dubsar-project"),
      linkType,
    );
    await symlink(
      outsideAudit,
      path.join(projectRoot, ".dubsar-audit"),
      linkType,
    );
  } catch (error) {
    if (error?.code === "EPERM") {
      t.skip("Directory-link creation is not permitted on this profile.");
      return;
    }
    throw error;
  }

  await assert.rejects(
    ensureProjectWorkspace({ start: nested }),
    rejectsWith("SYMLINK_ANCESTOR_REJECTED"),
  );
  await assert.rejects(
    ensureAuditWorkspace({ start: nested }),
    rejectsWith("SYMLINK_ANCESTOR_REJECTED"),
  );
});

test("unknown discovery CLI options are rejected before initialization", async () => {
  const projectCli = path.join(
    repositoryRoot,
    "legacy",
    "hermes-skills",
    "dubsar-project-continuity",
    "scripts",
    "ensure-project-workspace.mjs",
  );
  const auditCli = path.join(
    repositoryRoot,
    "packages",
    "dubsar-audit-readiness",
    "scripts",
    "ensure-audit-workspace.mjs",
  );
  const locateCli = path.join(
    repositoryRoot,
    "legacy",
    "hermes-skills",
    "dubsar-project-continuity",
    "scripts",
    "locate-project-workspace.mjs",
  );
  for (const script of [projectCli, auditCli, locateCli]) {
    const result = await runCli(script, ["--workpace", "typo"]);
    assert.equal(result.code, 1);
    assert.equal(JSON.parse(result.stderr).code, "INVALID_ARGUMENTS");
    assert.equal(result.stdout, "");
  }
});
