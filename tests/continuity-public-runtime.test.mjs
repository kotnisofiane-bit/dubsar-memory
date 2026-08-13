import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { checkBoundary } from "../tools/check-public-boundary.mjs";
import { runContinuityCli } from "../packages/dubsar-project-continuity/runtime/cli.mjs";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

async function invoke(bin, args, { cwd, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bin, ...args], {
      cwd,
      env,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (value) => { stdout += value; });
    child.stderr.on("data", (value) => { stderr += value; });
    child.once("error", reject);
    child.once("close", (exitCode) => resolve({ exitCode, stdout, stderr }));
  });
}

async function cleanInstallFixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "DUBSAR public (clean) & "));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const installed = path.join(root, "installed plugin", "dubsar-project-continuity");
  const project = path.join(root, "hostile cwd", "synthetic project");
  const hostilePath = path.join(root, "hostile PATH");
  await mkdir(path.dirname(installed), { recursive: true });
  await cp(
    path.join(repositoryRoot, "packages", "dubsar-project-continuity"),
    installed,
    { recursive: true },
  );
  await mkdir(path.join(project, ".git"), { recursive: true });
  await cp(
    path.join(repositoryRoot, "examples", "project-continuity"),
    path.join(project, ".dubsar-project"),
    { recursive: true },
  );
  await mkdir(path.join(project, "scripts"), { recursive: true });
  await mkdir(hostilePath, { recursive: true });
  const sentinel = path.join(root, "path-hijack-sentinel.txt");
  await writeFile(
    path.join(hostilePath, "dubsar.cmd"),
    `@echo hijacked>"${sentinel}"\r\n`,
    "utf8",
  );
  return {
    bin: path.join(installed, "bin", "dubsar.mjs"),
    installed,
    project,
    hostilePath,
    sentinel,
  };
}

test("a clean public install runs every skill command without a global dubsar", async (t) => {
  const fixture = await cleanInstallFixture(t);
  const resumeSkillFile = path.join(
    fixture.installed,
    "skills",
    "resume-project-context",
    "SKILL.md",
  );
  const resolvedPluginRoot = path.resolve(path.dirname(resumeSkillFile), "..", "..");
  assert.equal(resolvedPluginRoot, fixture.installed);
  assert.equal(path.join(resolvedPluginRoot, "bin", "dubsar.mjs"), fixture.bin);
  await assert.rejects(readFile(path.join(
    fixture.installed,
    "skills",
    "dubsar-project-continuity",
    "references",
    "review-protocol.md",
  ), "utf8"), (error) => error?.code === "ENOENT");
  const environment = { ...process.env, PATH: fixture.hostilePath };
  const resume = await invoke(fixture.bin, [
    "resume", "--start", fixture.project, "--capsule", "--json",
  ], { cwd: fixture.project, env: environment });
  assert.equal(resume.exitCode, 0, resume.stderr);
  const capsule = JSON.parse(resume.stdout);
  assert.equal(capsule.format, "dubsar.resume-capsule/2");
  assert.equal(resume.stdout.includes(fixture.project), false);

  for (const args of [
    ["history", "--start", fixture.project, "--json"],
    ["lots", "--start", fixture.project, "--json"],
    ["route", "--start", fixture.project, "--json"],
    ["precedents", "--start", fixture.project, "--lot", "lot-example-001", "--json"],
  ]) {
    const result = await invoke(fixture.bin, args, { cwd: fixture.project, env: environment });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.doesNotThrow(() => JSON.parse(result.stdout));
  }
  const route = await invoke(fixture.bin, [
    "route", "--start", fixture.project, "--json",
  ], { cwd: fixture.project, env: environment });
  assert.equal(route.exitCode, 0, route.stderr);
  const routeValue = JSON.parse(route.stdout);
  assert.equal(routeValue.format, "dubsar.memory-route/2");
  assert.equal(routeValue.source.workspace_mode, "legacy");
  assert.equal(routeValue.guidance.auto_execute, false);
  assert.equal(routeValue.artifact_lifecycle.format, "dubsar.artifact-lifecycle/1");

  const proposal = path.join(tmpdir(), `public-checkpoint-${path.basename(fixture.project)}.json`);
  t.after(async () => rm(proposal, { force: true }));
  await writeFile(proposal, `${JSON.stringify({
    format: "dubsar.checkpoint-proposal/1",
    mission_id: "mission-example-001",
    entries: [{
      evidence_id: "public-checkpoint-001",
      lot_id: "lot-example-001",
      kind: "decision",
      statement: "Keep the public pilot local.",
      class: "reported",
      artifact_refs: [],
      validation: [],
      limitations: ["Synthetic clean-install test."],
      resolves: null,
    }],
  }, null, 2)}\n`, "utf8");
  const preview = await invoke(fixture.bin, [
    "checkpoint", "--start", fixture.project, "--proposal", proposal, "--json",
  ], { cwd: fixture.project, env: environment });
  assert.equal(preview.exitCode, 0, preview.stderr);
  assert.equal(JSON.parse(preview.stdout).status, "preview");

  for (const args of [
    ["close", "--start", fixture.project],
    ["memory", "init"],
  ]) {
    const result = await invoke(fixture.bin, args, { cwd: fixture.project, env: environment });
    assert.equal(result.exitCode, 2);
  }
  await assert.rejects(readFile(fixture.sentinel), /ENOENT/u);
});

test("Codex, Claude Code, and Cursor manifests share byte-identical runtime output", async (t) => {
  const fixture = await cleanInstallFixture(t);
  const manifests = [
    ".codex-plugin/plugin.json",
    ".claude-plugin/plugin.json",
    ".cursor-plugin/plugin.json",
  ];
  const outputs = [];
  for (const manifest of manifests) {
    const identity = JSON.parse(await readFile(path.join(fixture.installed, manifest), "utf8"));
    assert.equal(identity.name, "dubsar-project-continuity");
    const result = await invoke(fixture.bin, [
      "resume", "--start", fixture.project, "--capsule", "--json",
    ], { cwd: fixture.project });
    assert.equal(result.exitCode, 0, result.stderr);
    outputs.push(result.stdout);
  }
  assert.equal(new Set(outputs).size, 1);
});

test("the public CLI derives interactive authority only from the real terminal", async (t) => {
  const fixture = await cleanInstallFixture(t);
  let stderr = "";
  const result = await runContinuityCli([
    "close", "--start", fixture.project,
  ], {
    writeOut() {},
    writeErr(value) { stderr += value; },
    isInputTTY: true,
    isOutputTTY: true,
    async readLine() { return "APPLY"; },
  });
  assert.equal(result.exitCode, 2);
  assert.equal(JSON.parse(stderr).code, "CLOSE_INTERACTIVE_REQUIRED");
});

test("the packaged runtime boundary remains continuity-only", async () => {
  const packageRoot = path.join(repositoryRoot, "packages", "dubsar-project-continuity");
  const boundary = await checkBoundary(packageRoot, "development");
  assert.equal(boundary.status, "pass", JSON.stringify(boundary.findings));
  const manifest = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
  assert.deepEqual(Object.keys(manifest.bin), ["dubsar"]);
  assert.equal(manifest.bin.dubsar, "bin/dubsar.mjs");
  assert.equal(Object.hasOwn(manifest, "scripts"), false);
  assert.equal(Object.keys(manifest).some((key) => key.toLowerCase().includes("dependenc")), false);
});
