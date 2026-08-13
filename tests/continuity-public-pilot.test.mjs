import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { prepareContinuityPilot } from "../tools/continuity-public-pilot.mjs";

const repositoryRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const packageInventory = JSON.parse(await readFile(
  path.join(repositoryRoot, "packages", "dubsar-project-continuity", "FILES.sha256.json"),
  "utf8",
));

const hosts = Object.freeze([
  { name: "codex", manifest: ".codex-plugin/plugin.json" },
  { name: "claude-code", manifest: ".claude-plugin/plugin.json" },
  { name: "cursor", manifest: ".cursor-plugin/plugin.json" },
]);

async function invoke(bin, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bin, ...args], {
      cwd,
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

test("public pilot preflight yields byte-identical CLI output for the three host labels", async (t) => {
  const parent = await mkdtemp(path.join(tmpdir(), "dubsar-public-pilot-preflight-"));
  t.after(async () => rm(parent, { recursive: true, force: true }));
  const campaignRoot = path.join(parent, "campaign");
  const prepared = await prepareContinuityPilot({
    outputRoot: campaignRoot,
    expectedPackageRootSha256: packageInventory.root_sha256,
  });
  assert.equal(prepared.session_count, 12);

  const packageRoot = path.join(campaignRoot, "artifacts", "dubsar-project-continuity");
  const bin = path.join(packageRoot, "bin", "dubsar.mjs");
  for (const scenario of ["eligible", "stale", "blocked", "legacy"]) {
    const results = [];
    for (const host of hosts) {
      const manifest = JSON.parse(await readFile(path.join(packageRoot, host.manifest), "utf8"));
      assert.equal(manifest.name, "dubsar-project-continuity");
      const project = path.join(campaignRoot, "sessions", host.name, scenario, "project");
      const resume = await invoke(bin, ["resume", "--start", project, "--capsule", "--json"], project);
      const lots = await invoke(bin, ["lots", "--start", project, "--json"], project);
      assert.equal(resume.exitCode, 0, `${host.name}:${scenario}:${resume.stderr}`);
      assert.equal(lots.exitCode, 0, `${host.name}:${scenario}:${lots.stderr}`);
      results.push({ resume: resume.stdout, lots: lots.stdout });
    }
    assert.equal(new Set(results.map((item) => item.resume)).size, 1);
    assert.equal(new Set(results.map((item) => item.lots)).size, 1);

    const capsule = JSON.parse(results[0].resume);
    const lotView = JSON.parse(results[0].lots);
    if (scenario === "eligible") assert.equal(lotView.summary.eligible, 1);
    if (scenario === "stale") assert.equal(capsule.evidence.freshness.stale, 1);
    if (scenario === "blocked") assert.equal(capsule.blockers.length, 1);
    if (scenario === "legacy") {
      assert.equal(capsule.state.readiness, "not_ready");
      assert.equal(capsule.next_action.code, "migrate_project_evidence");
      assert.equal(capsule.evidence.supported_records, 0);
    }
  }
});
