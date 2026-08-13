import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { get } from "node:http";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runCli } from "../packages/dubsar-operator-cli/src/cli.mjs";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

async function projectFixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "dubsar-cli-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(path.join(root, ".git"));
  await cp(
    path.join(repositoryRoot, "examples", "project-continuity"),
    path.join(root, ".dubsar-project"),
    { recursive: true },
  );
  return root;
}

async function invoke(argv) {
  let stdout = "";
  let stderr = "";
  const result = await runCli(argv, {
    writeOut(value) {
      stdout += value;
    },
    writeErr(value) {
      stderr += value;
    },
  });
  return { ...result, stdout, stderr };
}

async function getBody(url) {
  return new Promise((resolve, reject) => {
    get(url, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        resolve({ body: Buffer.concat(chunks), status: response.statusCode });
      });
    }).on("error", reject);
  });
}

test("status JSON is byte-deterministic and contains no absolute root", async (t) => {
  const root = await projectFixture(t);
  const evidencePath = path.join(root, ".dubsar-project", "evidence.json");
  const evidence = JSON.parse(await readFile(evidencePath, "utf8"));
  evidence.format = "api_key=synthetic-secret-value";
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  const first = await invoke(["status", "--start", root, "--domain", "project", "--json"]);
  const second = await invoke(["resume", "--start", root, "--domain", "project", "--json"]);
  assert.equal(first.exitCode, 0);
  assert.equal(second.exitCode, 0);
  assert.equal(first.stderr, "");
  assert.equal(first.stdout, second.stdout);
  assert.equal(first.stdout.includes(root), false);
  assert.equal(first.stdout.includes("synthetic-secret-value"), false);
  const value = JSON.parse(first.stdout);
  assert.equal(value.format, "dubsar.workbench-view/1");
  assert.equal(value.authority, "local_preparation_record");
  assert.equal(value.source.formats.includes("dubsar.project-evidence/1"), true);
});

test("locate exposes only the marker and bounded distance", async (t) => {
  const root = await projectFixture(t);
  const result = await invoke(["locate", "--start", root, "--json"]);
  assert.equal(result.exitCode, 0);
  const value = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(value).sort(), [
    "authority",
    "distance",
    "domain",
    "format",
    "marker",
  ]);
  assert.equal(result.stdout.includes(root), false);
});

test("invalid CLI input fails with a closed path-free diagnostic", async () => {
  const result = await invoke(["unknown", "--start", "C:\\private\\path"]);
  assert.equal(result.exitCode, 1);
  assert.equal(result.stdout, "");
  const value = JSON.parse(result.stderr);
  assert.equal(value.code, "CLI_COMMAND_INVALID");
  assert.equal(result.stderr.includes("private"), false);
});

test("catalog and capsule commands remain path-free", async (t) => {
  const root = await projectFixture(t);
  const registryPath = path.join(path.dirname(root), `registry-${path.basename(root)}.json`);
  t.after(async () => rm(registryPath, { force: true }));
  await writeFile(
    registryPath,
    `${JSON.stringify({
      format: "dubsar.workbench-projects/1",
      authority: "local_preparation_record",
      projects: [{ project_id: "cli-project", root }],
    }, null, 2)}\n`,
    "utf8",
  );
  const catalog = await invoke(["catalog", "--registry", registryPath, "--json"]);
  assert.equal(catalog.exitCode, 0);
  assert.equal(catalog.stdout.includes(root), false);
  const catalogValue = JSON.parse(catalog.stdout);
  assert.equal(catalogValue.projects.length, 1);
  const capsule = await invoke([
    "capsule",
    "--registry",
    registryPath,
    "--project",
    "cli-project",
    "--json",
  ]);
  assert.equal(capsule.exitCode, 0);
  assert.equal(capsule.stdout.includes(root), false);
  const capsuleValue = JSON.parse(capsule.stdout);
  assert.equal(capsuleValue.format, "dubsar.resume-capsule/2");
  assert.equal(capsuleValue.project.project_id, "mission-example-001");
  assert.match(capsuleValue.capsule_sha256, /^[0-9a-f]{64}$/u);
});

test("ui publishes one ready record, serves the report, and leaves the workspace unchanged", async (t) => {
  const root = await projectFixture(t);
  const before = await invoke([
    "status",
    "--start",
    root,
    "--domain",
    "project",
    "--json",
  ]);
  const launched = await invoke([
    "ui",
    "--start",
    root,
    "--domain",
    "project",
    "--json",
  ]);
  assert.equal(launched.exitCode, 0);
  assert.equal(launched.stderr, "");
  assert.ok(launched.session);
  assert.equal(launched.stdout.trim().split("\n").length, 1);
  const ready = JSON.parse(launched.stdout);
  assert.equal(ready.format, "dubsar.ui-session/1");
  assert.equal(ready.status, "ready");
  assert.equal(ready.authority, "local_preparation_record");
  assert.equal(ready.snapshot_sha256, JSON.parse(before.stdout).source.snapshot_sha256);
  assert.equal(ready.url, launched.session.url);
  assert.equal(launched.stdout.includes(root), false);

  const response = await getBody(ready.url);
  assert.equal(response.status, 200);
  assert.match(response.body.toString("utf8"), /DUBSAR Workbench - Static report/u);
  await launched.session.close("test");

  const after = await invoke([
    "status",
    "--start",
    root,
    "--domain",
    "project",
    "--json",
  ]);
  assert.equal(after.stdout, before.stdout);
});

for (const [shutdownSignal, expectedCode] of [
  ["SIGINT", 130],
  ["SIGTERM", 143],
]) {
  test(`the foreground ui process owns ${shutdownSignal} and leaves no orphan listener`, async (t) => {
    const root = await projectFixture(t);
    const child = spawn(
      process.execPath,
      [
        path.join(
          repositoryRoot,
          "packages",
          "dubsar-operator-cli",
          "bin",
          "dubsar.mjs",
        ),
        "ui",
        "--start",
        root,
        "--domain",
        "project",
        "--json",
      ],
      {
        cwd: repositoryRoot,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    t.after(() => {
      if (child.exitCode === null) {
        child.kill("SIGTERM");
      }
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const ready = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("UI_READY_TIMEOUT")), 5000);
      child.once("error", reject);
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
        const newline = stdout.indexOf("\n");
        if (newline !== -1) {
          clearTimeout(timeout);
          resolve(JSON.parse(stdout.slice(0, newline)));
        }
      });
    });
    assert.equal((await getBody(ready.url)).status, 200);
    assert.equal(child.kill(shutdownSignal), true);
    const [code, signal] = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("UI_EXIT_TIMEOUT")), 4000);
      once(child, "exit").then((result) => {
        clearTimeout(timeout);
        resolve(result);
      }, reject);
    });
    assert.equal(stderr, "");
    assert.equal(stdout.trim().split("\n").length, 1);
    if (process.platform === "win32") {
      assert.ok(code !== null || signal !== null);
    } else {
      assert.equal(code, expectedCode);
      assert.equal(signal, null);
    }
    await assert.rejects(() => getBody(ready.url));
  });
}

test("a synchronous readiness-output failure closes the newly started ui", async (t) => {
  const root = await projectFixture(t);
  let stderr = "";
  const result = await runCli(
    ["ui", "--start", root, "--domain", "project"],
    {
      writeOut() {
        throw new Error("OUTPUT_CLOSED");
      },
      writeErr(value) {
        stderr += value;
      },
    },
  );
  assert.equal(result.exitCode, 1);
  assert.equal(result.session, undefined);
  assert.equal(JSON.parse(stderr).code, "UNEXPECTED_FAILURE");
  assert.equal(stderr.includes(root), false);
});
