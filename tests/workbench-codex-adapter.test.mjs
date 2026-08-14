import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { stableJson } from "../packages/dubsar-project-continuity/runtime/index.mjs";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const script = path.join(
  repositoryRoot,
  "packages",
  "dubsar-codex-workbench",
  "skills",
  "resume-dubsar-workbench",
  "scripts",
  "read-capsule.mjs",
);

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "dubsar-codex-adapter-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const project = path.join(root, "project");
  await mkdir(path.join(project, ".git"), { recursive: true });
  await cp(
    path.join(repositoryRoot, "examples", "project-continuity"),
    path.join(project, ".dubsar-project"),
    { recursive: true },
  );
  const registryDirectory = path.join(root, "DUBSAR", "Workbench");
  await mkdir(registryDirectory, { recursive: true });
  const registry = path.join(registryDirectory, "projects.json");
  await writeFile(registry, `${JSON.stringify({
    format: "dubsar.workbench-projects/1",
    authority: "local_preparation_record",
    projects: [{ project_id: "adapter-project", root: project }],
  }, null, 2)}\n`, "utf8");
  return { localAppData: root, project, registry };
}

function markdown(frontmatter, body) {
  return `---\n${stableJson(frontmatter)}---\n${body}`;
}

function capsuleDigest(capsule) {
  const { capsule_sha256: ignored, ...base } = capsule;
  return createHash("sha256").update(Buffer.from(stableJson(base), "utf8")).digest("hex");
}

async function memoryFixture(t) {
  const localAppData = await mkdtemp(path.join(tmpdir(), "dubsar-codex-memory-adapter-"));
  t.after(async () => rm(localAppData, { recursive: true, force: true }));
  const project = path.join(localAppData, "memory-project");
  const memory = path.join(project, ".dubsar");
  const projectId = "project-adapter-memory-001";
  const workId = "work-adapter-memory-001";
  await Promise.all([
    mkdir(path.join(memory, "work"), { recursive: true }),
    mkdir(path.join(memory, "knowledge"), { recursive: true }),
    mkdir(path.join(memory, "inbox"), { recursive: true }),
    mkdir(path.join(memory, "generated"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(path.join(memory, "manifest.json"), stableJson({
      format: "dubsar.memory-project/1",
      project_id: projectId,
      title: "Adapter memory project",
      legacy_snapshot_sha256: null,
    }), "utf8"),
    writeFile(path.join(memory, "checkpoints.json"), stableJson({
      format: "dubsar.continuity-checkpoints/2",
      project_id: projectId,
      entries: [],
    }), "utf8"),
    writeFile(path.join(memory, "local.json"), stableJson({
      format: "dubsar.local-state/1",
      project_id: projectId,
      selected_work_id: workId,
    }), "utf8"),
    writeFile(path.join(memory, ".gitignore"), "inbox/\ngenerated/\nlocal.json\n", "utf8"),
    writeFile(path.join(memory, "work", `${workId}.md`), markdown({
      format: "dubsar.work/1",
      work_id: workId,
      title: "Verify the canonical adapter",
      status: "open",
      scope: "bounded",
      objective: "Expose one verified path-free continuity capsule.",
      acceptance_criteria: ["The adapter returns the canonical vNext capsule."],
      knowledge_ids: [],
      references: [],
    }, "# Verify the canonical adapter\n"), "utf8"),
  ]);
  const registryDirectory = path.join(localAppData, "DUBSAR", "Workbench");
  await mkdir(registryDirectory, { recursive: true });
  await writeFile(path.join(registryDirectory, "projects.json"), stableJson({
    format: "dubsar.workbench-projects/1",
    authority: "local_preparation_record",
    projects: [{ project_id: "adapter-memory-project", root: project }],
  }), "utf8");
  return { localAppData, project, projectId, workId };
}

test("Codex adapter emits one verified path-free continuity /2 capsule", async (t) => {
  const item = await fixture(t);
  const result = spawnSync(process.execPath, [
    script,
    "--project",
    "adapter-project",
  ], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: { ...process.env, LOCALAPPDATA: item.localAppData },
    maxBuffer: 32 * 1024,
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  const capsule = JSON.parse(result.stdout);
  assert.equal(capsule.format, "dubsar.resume-capsule/2");
  assert.equal(capsule.project.project_id, "mission-example-001");
  assert.equal(capsule.capsule_sha256, capsuleDigest(capsule));
  assert.equal(result.stdout.includes(item.project), false);
  assert.equal(result.stdout.includes(item.localAppData), false);
  assert.ok(Buffer.byteLength(result.stdout, "utf8") <= 8 * 1024);
});

test("Codex adapter emits one verified path-free memory vNext capsule", async (t) => {
  const item = await memoryFixture(t);
  const result = spawnSync(process.execPath, [
    script,
    "--project",
    "adapter-memory-project",
  ], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: { ...process.env, LOCALAPPDATA: item.localAppData },
    maxBuffer: 32 * 1024,
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  const capsule = JSON.parse(result.stdout);
  // The adapter reads through the observing capsule path and must accept both
  // shapes. This fixture records no reference, so it receives /3.
  assert.equal(capsule.format, "dubsar.resume-capsule/3");
  assert.equal(capsule.evidence_freshness, undefined);
  assert.equal(capsule.project.project_id, item.projectId);
  assert.equal(capsule.active_work.work_id, item.workId);
  assert.equal(capsule.capsule_sha256, capsuleDigest(capsule));
  assert.equal(result.stdout.includes(item.project), false);
  assert.equal(result.stdout.includes(item.localAppData), false);
  assert.ok(Buffer.byteLength(result.stdout, "utf8") <= 8 * 1024);
});

test("Codex skill is explicit-only and the adapter fails closed", async (t) => {
  const item = await fixture(t);
  const yaml = await readFile(
    path.join(
      repositoryRoot,
      "packages",
      "dubsar-codex-workbench",
      "skills",
      "resume-dubsar-workbench",
      "agents",
      "openai.yaml",
    ),
    "utf8",
  );
  assert.match(yaml, /allow_implicit_invocation: false/u);
  const result = spawnSync(process.execPath, [
    script,
    "--project",
    "missing-project",
  ], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: { ...process.env, LOCALAPPDATA: item.localAppData },
    maxBuffer: 32 * 1024,
    windowsHide: true,
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(JSON.parse(result.stderr).code, "ADAPTER_CAPSULE_READ_FAILED");
  assert.equal(result.stderr.includes(item.project), false);

  const override = spawnSync(process.execPath, [
    script,
    "--registry",
    item.registry,
    "--project",
    "adapter-project",
  ], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: { ...process.env, LOCALAPPDATA: item.localAppData },
    maxBuffer: 32 * 1024,
    windowsHide: true,
  });
  assert.equal(override.status, 1);
  assert.equal(JSON.parse(override.stderr).code, "ADAPTER_ARGUMENT_INVALID");
});
