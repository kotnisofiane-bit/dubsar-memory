import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runCli } from "../packages/dubsar-operator-cli/src/cli.mjs";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const goldenRoot = path.join(repositoryRoot, "tests", "golden", "workbench");

async function fixtureWorkspace(t, domain, { contradiction = false } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), `dubsar-golden-${domain}-`));
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
  const workspace = path.join(root, marker);
  await cp(source, workspace, { recursive: true });
  if (contradiction) {
    const reviewPath = path.join(workspace, "evidence-review.json");
    const review = JSON.parse(await readFile(reviewPath, "utf8"));
    review.contradictions = [
      "The synthetic source and the recorded claim disagree.",
    ];
    await writeFile(reviewPath, `${JSON.stringify(review, null, 2)}\n`);
  }
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

async function assertGolden(actual, filename, privateRoot = null) {
  const expected = await readFile(path.join(goldenRoot, filename));
  assert.deepEqual(Buffer.from(actual, "utf8"), expected);
  if (privateRoot !== null) {
    assert.equal(actual.includes(privateRoot), false);
  }
  assert.equal(actual.includes(repositoryRoot), false);
  assert.equal(/(?:[A-Za-z]:\\|\\\\)[^\n"]+/u.test(actual), false);
}

test("stable project CLI outputs match byte-exact path-private goldens", async (t) => {
  const root = await fixtureWorkspace(t, "project");
  const cases = [
    ["status", "project-status.json"],
    ["validate", "project-validate.json"],
    ["report", "project-report.json"],
  ];
  for (const [command, golden] of cases) {
    const result = await invoke([
      command,
      "--domain",
      "project",
      "--start",
      root,
      "--json",
    ]);
    assert.equal(result.exitCode, 0);
    assert.equal(result.stderr, "");
    await assertGolden(result.stdout, golden, root);
  }

  const resumed = await invoke([
    "resume",
    "--domain",
    "project",
    "--start",
    root,
    "--json",
  ]);
  await assertGolden(resumed.stdout, "project-status.json", root);
});

test("closed CLI errors match a byte-exact path-private golden", async () => {
  const result = await invoke(["unknown", "--start", "C:\\private\\path"]);
  assert.equal(result.exitCode, 1);
  assert.equal(result.stdout, "");
  await assertGolden(result.stderr, "closed-error.json");
  assert.equal(result.stderr.includes("private"), false);
});

test("a declared audit contradiction matches its byte-exact closed golden", async (t) => {
  const root = await fixtureWorkspace(t, "audit", { contradiction: true });
  const result = await invoke([
    "status",
    "--domain",
    "audit",
    "--start",
    root,
    "--json",
  ]);
  assert.equal(result.exitCode, 0);
  assert.equal(result.stderr, "");
  await assertGolden(result.stdout, "audit-contradiction.json", root);
});

test("doctor uses an exact closed shape while reporting the exact runtime semver", async (t) => {
  const root = await fixtureWorkspace(t, "project");
  const first = await invoke([
    "doctor",
    "--domain",
    "project",
    "--start",
    root,
    "--json",
  ]);
  const second = await invoke([
    "doctor",
    "--domain",
    "project",
    "--start",
    root,
    "--json",
  ]);
  assert.equal(first.exitCode, 0);
  assert.equal(first.stderr, "");
  assert.equal(first.stdout, second.stdout);
  assert.equal(first.stdout.includes(root), false);
  const value = JSON.parse(first.stdout);
  assert.deepEqual(Object.keys(value).sort(), [
    "authority",
    "diagnostics",
    "domain",
    "format",
    "integrity",
    "next_action",
    "readiness",
    "runtime",
  ]);
  assert.deepEqual(Object.keys(value.runtime).sort(), ["node", "supported"]);
  assert.equal(value.runtime.node, process.version);
  assert.match(value.runtime.node, /^v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u);
  assert.equal(value.runtime.supported, Number(process.versions.node.split(".")[0]) >= 20);
  assert.equal(value.format, "dubsar.doctor/1");
  assert.equal(value.authority, "local_preparation_record");
});
