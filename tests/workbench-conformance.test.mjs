import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cp,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  CONFORMANCE_SUPPORT_ROOTS,
  WORKBENCH_COMPONENTS,
  buildWorkingTreeManifest,
  captureWorkbenchFiles,
  checkWorkbenchConformance,
  computeContentRoot,
} from "../tools/check-workbench-conformance.mjs";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const manifestPath = path.join(repositoryRoot, "WORKBENCH_CONFORMANCE.json");
const goldenRoot = path.join(repositoryRoot, "tests", "golden", "workbench");
const FIXTURE_ALLOWLIST = Object.freeze([
  ["examples/audit-readiness/audit-scope.json", 717, "ab53d3c1d2c15e79036075a404139d376db62249cc0e5adb29b5868306c08105"],
  ["examples/audit-readiness/automation-inventory.json", 729, "89518ccbfc5f201065dc5bdba9b7dbfa593daadce5e7b40ac55ef0780326a456"],
  ["examples/audit-readiness/evidence/workflow.json", 85, "72b2227a519497db4567d28109d1f22f337c296dfd62df9d53d30cb4ff052878"],
  ["examples/audit-readiness/evidence-index.json", 277, "816267f0a10d43c4ab71e0f39954418e91da5648b0e6b48e425e6f1db0abc55a"],
  ["examples/audit-readiness/evidence-review.json", 474, "f9417f36a11694f6c0fd4cd2ff1250abe4b56f6c302fc1fb220b54c5e80c18b6"],
  ["examples/audit-readiness/sensitive-actions.json", 696, "fff8e339a4edf84d5fd36d7e2b4cecccb5bc505e61070f6dee7d92735fd7b45d"],
  ["examples/project-continuity/evidence.json", 522, "27d7888fa3d613b795d8f6878debc7fffae6395e610320b493b7265a24945c0c"],
  ["examples/project-continuity/execution-contract.json", 640, "f38847f9219d6cd2138752c3e76884ca97d37901b63e866d2cc97f1c86be6c91"],
  ["examples/project-continuity/lots.json", 549, "f2800d80d42c6bed66bfb91aafb31bc9b2ae786b36e968770e68fa4477560d25"],
  ["examples/project-continuity/mission.json", 604, "5af6669ec77747749506ca18af44685ef81805ee90dc6a2fb0e2b8e6c27ff6b1"],
]);

function compareText(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function clone(value) {
  return structuredClone(value);
}

async function manifest() {
  return JSON.parse(await readFile(manifestPath, "utf8"));
}

function firstCode(report) {
  return report.findings.at(0)?.code;
}

async function assertRejectedManifest(mutator, expectedCode) {
  const candidate = await manifest();
  mutator(candidate);
  const report = await checkWorkbenchConformance({ manifestSource: candidate });
  assert.equal(report.status, "fail");
  assert.equal(report.conformant, false);
  assert.equal(report.release_ready, false);
  assert.equal(firstCode(report), expectedCode);
}

function publicInventory(files) {
  return files.map(({ path: filePath, bytes, sha256, role }) => ({
    path: filePath,
    bytes,
    sha256,
    role,
  }));
}

function stableCapture(files) {
  return files.map(({ path: filePath, bytes, sha256, identity }) => ({
    path: filePath,
    bytes,
    sha256,
    identity,
  }));
}

async function cleanupExactTemp(root, prefix) {
  const parent = await realpath(tmpdir());
  const resolved = await realpath(root);
  const relative = path.relative(parent, resolved);
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative) ||
    relative.includes(path.sep) ||
    !path.basename(relative).startsWith(prefix)
  ) {
    throw new Error("TEMP_CLEANUP_IDENTITY_INVALID");
  }
  await rm(resolved, { recursive: true, force: false });
}

async function mirrorWorkbench(t, prefix = "dubsar-conformance-mirror-") {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  t.after(async () => {
    await cleanupExactTemp(root, prefix);
  });
  for (const component of WORKBENCH_COMPONENTS) {
    const destination = path.join(root, ...component.root.split("/"));
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(path.join(repositoryRoot, ...component.root.split("/")), destination, {
      recursive: true,
    });
  }
  for (const support of CONFORMANCE_SUPPORT_ROOTS) {
    const destination = path.join(root, ...support.root.split("/"));
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(path.join(repositoryRoot, ...support.root.split("/")), destination, {
      recursive: true,
    });
  }
  const policy = path.join(root, "tools", "check-workbench-runtime.mjs");
  await mkdir(path.dirname(policy), { recursive: true });
  await cp(path.join(repositoryRoot, "tools", "check-workbench-runtime.mjs"), policy);
  return root;
}

function probeEnvironment(fakeHome, temporaryRoot, ambient = {}) {
  void ambient;
  return {
    HOME: fakeHome,
    USERPROFILE: fakeHome,
    TEMP: temporaryRoot,
    TMP: temporaryRoot,
    TZ: "UTC",
    NO_COLOR: "1",
  };
}

class ProbeError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

async function runBoundedNode(
  args,
  { cwd, env, timeoutMs = 5_000, maxOutputBytes = 256 * 1024 },
) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd,
      env,
      shell: false,
      windowsHide: true,
      detached: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let failure = null;
    const stop = (code) => {
      if (failure === null) {
        failure = new ProbeError(code);
        child.kill("SIGKILL");
      }
    };
    const timeout = setTimeout(() => stop("PROBE_TIMEOUT"), timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxOutputBytes) {
        stop("PROBE_STDOUT_LIMIT");
      } else {
        stdout.push(chunk);
      }
    });
    child.stderr.on("data", (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes > maxOutputBytes) {
        stop("PROBE_STDERR_LIMIT");
      } else {
        stderr.push(chunk);
      }
    });
    child.once("error", () => {
      clearTimeout(timeout);
      reject(new ProbeError("PROBE_SPAWN_FAILED"));
    });
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      if (failure !== null) {
        reject(failure);
      } else if (code !== 0 || signal !== null) {
        reject(new ProbeError("PROBE_CHILD_FAILED"));
      } else {
        resolve({
          stdout: Buffer.concat(stdout),
          stderr: Buffer.concat(stderr),
        });
      }
    });
  });
}

async function runCleanProbeCommand(args, options) {
  const result = await runBoundedNode(args, options);
  if (result.stderr.length !== 0) {
    throw new ProbeError("PROBE_STDERR_NOT_EMPTY");
  }
  return result;
}

async function copyCapturedFiles(destinationRoot, captured) {
  for (const file of captured) {
    const destination = path.resolve(
      destinationRoot,
      ...file.path.split("/"),
    );
    const relative = path.relative(destinationRoot, destination);
    if (
      relative === "" ||
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      throw new ProbeError("PROBE_DESTINATION_INVALID");
    }
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, file.content, { flag: "wx", mode: 0o600 });
  }
}

async function captureSyntheticFixtureSources() {
  const captured = [];
  for (const [portable, expectedBytes, expectedSha256] of FIXTURE_ALLOWLIST) {
    const absolute = path.resolve(repositoryRoot, ...portable.split("/"));
    const lexical = await lstat(absolute, { bigint: true });
    const physical = await realpath(absolute);
    const lexicalPhysical = path.resolve(absolute);
    const resolvedPhysical = path.resolve(physical);
    const samePhysical =
      process.platform === "win32"
        ? lexicalPhysical.toLowerCase() === resolvedPhysical.toLowerCase()
        : lexicalPhysical === resolvedPhysical;
    if (
      lexical.isSymbolicLink() ||
      !lexical.isFile() ||
      lexical.nlink !== 1n ||
      !samePhysical
    ) {
      throw new ProbeError("PROBE_FIXTURE_SOURCE_UNSAFE");
    }
    const handle = await open(absolute, "r");
    try {
      const before = await handle.stat({ bigint: true });
      const content = await handle.readFile();
      const after = await handle.stat({ bigint: true });
      const digest = createHash("sha256").update(content).digest("hex");
      if (
        before.dev !== lexical.dev ||
        before.ino !== lexical.ino ||
        before.size !== lexical.size ||
        before.nlink !== 1n ||
        before.dev !== after.dev ||
        before.ino !== after.ino ||
        before.size !== after.size ||
        before.mtimeNs !== after.mtimeNs ||
        content.length !== expectedBytes ||
        digest !== expectedSha256
      ) {
        throw new ProbeError("PROBE_FIXTURE_SOURCE_MISMATCH");
      }
      captured.push({
        path: portable,
        bytes: content.length,
        sha256: digest,
        identity: `${before.dev}:${before.ino}`,
        content,
      });
    } finally {
      await handle.close();
    }
  }
  return captured;
}

async function addSyntheticWorkspace(
  root,
  domain,
  fixtures,
  contradiction = false,
) {
  const workspaceRoot = path.join(root, `synthetic-${domain}`);
  await mkdir(path.join(workspaceRoot, ".git"), { recursive: true });
  const marker = domain === "project" ? ".dubsar-project" : ".dubsar-audit";
  const prefix = `examples/${domain === "project" ? "project-continuity" : "audit-readiness"}/`;
  for (const fixture of fixtures.filter((item) => item.path.startsWith(prefix))) {
    const relative = fixture.path.slice(prefix.length);
    const destination = path.join(workspaceRoot, marker, ...relative.split("/"));
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, fixture.content, { flag: "wx", mode: 0o600 });
  }
  if (contradiction) {
    const reviewPath = path.join(
      workspaceRoot,
      marker,
      "evidence-review.json",
    );
    const review = JSON.parse(await readFile(reviewPath, "utf8"));
    review.contradictions = [
      "The synthetic source and the recorded claim disagree.",
    ];
    await writeFile(reviewPath, `${JSON.stringify(review, null, 2)}\n`);
  }
  return workspaceRoot;
}

async function syntheticWorkspaceSnapshot(workspaceRoot, domain) {
  const marker = domain === "project" ? ".dubsar-project" : ".dubsar-audit";
  const prefix = `examples/${domain === "project" ? "project-continuity" : "audit-readiness"}/`;
  const records = [];
  for (const [portable] of FIXTURE_ALLOWLIST.filter(([item]) => item.startsWith(prefix))) {
    const relative = portable.slice(prefix.length);
    const content = await readFile(
      path.join(workspaceRoot, marker, ...relative.split("/")),
    );
    records.push({
      path: relative,
      bytes: content.length,
      sha256: createHash("sha256").update(content).digest("hex"),
    });
  }
  return records;
}

async function runSourceBundleProbe({
  sourceRoot = repositoryRoot,
  afterCopy,
  runCommands = true,
} = {}) {
  const prefix = "dubsar-source-bundle-";
  const destinationRoot = await mkdtemp(path.join(tmpdir(), prefix));
  try {
    const first = await captureWorkbenchFiles(sourceRoot, { includeContent: true });
    const second = await captureWorkbenchFiles(sourceRoot, { includeContent: true });
    assert.deepEqual(stableCapture(second), stableCapture(first));
    const fixtureFirst = runCommands ? await captureSyntheticFixtureSources() : null;
    const fixtureSecond = runCommands ? await captureSyntheticFixtureSources() : null;
    if (runCommands) {
      assert.deepEqual(stableCapture(fixtureSecond), stableCapture(fixtureFirst));
    }
    const declared = await manifest();
    assert.deepEqual(publicInventory(second), declared.files);
    await copyCapturedFiles(destinationRoot, second);

    const copied = await captureWorkbenchFiles(destinationRoot);
    assert.deepEqual(publicInventory(copied), publicInventory(second));
    if (afterCopy !== undefined) {
      await afterCopy();
    }

    if (runCommands) {
      const fakeHome = path.join(destinationRoot, "fake-home");
      await mkdir(fakeHome);
      const project = await addSyntheticWorkspace(
        destinationRoot,
        "project",
        fixtureSecond,
      );
      const audit = await addSyntheticWorkspace(
        destinationRoot,
        "audit",
        fixtureSecond,
        true,
      );
      const projectBefore = await syntheticWorkspaceSnapshot(project, "project");
      const auditBefore = await syntheticWorkspaceSnapshot(audit, "audit");
      const poisonedAmbient = {
        PATH: "C:\\untrusted-bin",
        NODE_OPTIONS: "--require=untrusted",
        NODE_PATH: "C:\\untrusted-modules",
        HTTPS_PROXY: "http://untrusted.invalid",
        AWS_SECRET_ACCESS_KEY: "not-forwarded",
        npm_config_registry: "https://untrusted.invalid",
      };
      const env = probeEnvironment(fakeHome, destinationRoot, poisonedAmbient);
      assert.deepEqual(Object.keys(env).sort(), [
        "HOME",
        "NO_COLOR",
        "TEMP",
        "TMP",
        "TZ",
        "USERPROFILE",
      ]);
      for (const forbidden of Object.keys(poisonedAmbient)) {
        assert.equal(Object.hasOwn(env, forbidden), false);
      }
      assert.equal(env.HOME, fakeHome);
      assert.equal(env.USERPROFILE, fakeHome);

      const entrypoint = path.join(
        destinationRoot,
        "packages",
        "dubsar-operator-cli",
        "bin",
        "dubsar.mjs",
      );
      const cases = [
        {
          args: ["status", "--domain", "project", "--start", project, "--json"],
          golden: "project-status.json",
        },
        {
          args: ["validate", "--domain", "project", "--start", project, "--json"],
          golden: "project-validate.json",
        },
        {
          args: ["report", "--domain", "project", "--start", project, "--json"],
          golden: "project-report.json",
        },
        {
          args: ["status", "--domain", "audit", "--start", audit, "--json"],
          golden: "audit-contradiction.json",
        },
      ];
      for (const item of cases) {
        const result = await runCleanProbeCommand([entrypoint, ...item.args], {
          cwd: destinationRoot,
          env,
        });
        assert.deepEqual(result.stdout, await readFile(path.join(goldenRoot, item.golden)));
      }
      assert.deepEqual(
        await syntheticWorkspaceSnapshot(project, "project"),
        projectBefore,
      );
      assert.deepEqual(
        await syntheticWorkspaceSnapshot(audit, "audit"),
        auditBefore,
      );
      const fixtureAfter = await captureSyntheticFixtureSources();
      assert.deepEqual(stableCapture(fixtureAfter), stableCapture(fixtureSecond));
    }

    const after = await captureWorkbenchFiles(sourceRoot);
    assert.deepEqual(stableCapture(after), stableCapture(second));
    const destinationAfter = await captureWorkbenchFiles(destinationRoot);
    assert.deepEqual(publicInventory(destinationAfter), publicInventory(second));
    return {
      fileCount: second.length,
      contentRoot: computeContentRoot(publicInventory(second)),
    };
  } finally {
    await cleanupExactTemp(destinationRoot, prefix);
  }
}

test("the approved working-tree capture passes development and blocks release", async () => {
  const approved = await manifest();
  const development = await checkWorkbenchConformance({ mode: "development" });
  assert.equal(development.status, "warn");
  assert.equal(development.conformant, true);
  assert.equal(development.release_ready, false);
  assert.deepEqual(
    development.findings.map((item) => item.code),
    [
      "SOURCE_NOT_COMMITTED",
      "COMMIT_BLOB_PROOF_MISSING",
      "HUMAN_REVIEW_PENDING",
      "SOURCE_BUNDLE_PROBE_NOT_RELEASE_EVIDENCE",
      ...(process.platform === "win32"
        ? ["WINDOWS_REPARSE_ATTRIBUTES_UNPROVEN"]
        : []),
    ],
  );
  assert.ok(development.findings.every((item) => item.state === "warn"));
  assert.equal(development.declared.file_count, approved.files.length);
  assert.equal(development.observed.runtime_gate.status, "pass");
  assert.deepEqual(
    development.observed.components.find((component) => component.key === "report")?.formats,
    [
      "dubsar.review-ledger-report/1",
      "dubsar.workbench-catalog-interactive-data/1",
      "dubsar.workbench-catalog-interactive-report/1",
      "dubsar.workbench-continuity-interactive-data/2",
      "dubsar.workbench-continuity-interactive-data/3",
      "dubsar.workbench-continuity-interactive-data/4",
      "dubsar.workbench-continuity-interactive-report/2",
      "dubsar.workbench-continuity-interactive-report/3",
      "dubsar.workbench-continuity-interactive-report/4",
      "dubsar.workbench-interactive-data/2",
      "dubsar.workbench-interactive-report/2",
      "dubsar.workbench-report/1",
    ],
  );
  assert.deepEqual(
    development.observed.components.find((component) => component.key === "launcher")?.formats,
    [
      "dubsar.personal-memory-snapshot/1",
      "dubsar.workbench-catalog-launch/1",
      "dubsar.workbench-launch-check/1",
      "dubsar.workbench-launch-error/1",
      "dubsar.workbench-launch/1",
      "dubsar.workbench-project-management/1",
    ],
  );
  assert.deepEqual(
    development.observed.components.find((component) => component.key === "personal-memory")?.formats,
    [
      "dubsar.personal-memory-init-apply/1",
      "dubsar.personal-memory-init-preview/1",
      "dubsar.personal-memory-update-apply/1",
      "dubsar.personal-memory-update-preview/1",
    ],
  );

  const release = await checkWorkbenchConformance({ mode: "release" });
  assert.equal(release.status, "blocked");
  assert.equal(release.conformant, true);
  assert.equal(release.release_ready, false);
  assert.ok(release.findings.every((item) => item.state === "blocked"));
});

test("the capture schema rejects extra, duplicate and malformed declarations", async () => {
  await assertRejectedManifest((value) => {
    value.unexpected = true;
  }, "MANIFEST_SCHEMA_INVALID");
  await assertRejectedManifest((value) => {
    value.files.splice(1, 0, clone(value.files.at(0)));
  }, "FILE_PATH_DUPLICATE");
  await assertRejectedManifest((value) => {
    const item = clone(
      value.files.find((entry) => entry.path.endsWith("/src/cli.mjs")),
    );
    item.path = item.path.replace("cli.mjs", "CLI.mjs");
    value.files.push(item);
    value.files.sort((left, right) => compareText(left.path, right.path));
  }, "FILE_PATH_CASE_COLLISION");
  await assertRejectedManifest((value) => {
    value.files.reverse();
  }, "FILE_ORDER_INVALID");
  for (const unsafePath of [
    "../outside.mjs",
    "/absolute/outside.mjs",
    "C:/outside.mjs",
    "//server/share/outside.mjs",
    "packages\\outside.mjs",
    "packages/core:stream.mjs",
    "packages/core/control\n.mjs",
    "packages/core/NUL",
    "packages/core/trailing.",
    "packages/core/trailing ",
    "packages//empty.mjs",
    "packages/core/e\u0301.mjs",
    "packages/core/\u202Eevil.mjs",
  ]) {
    await assertRejectedManifest((value) => {
      value.files.at(0).path = unsafePath;
    }, "PATH_INVALID");
  }
  await assertRejectedManifest((value) => {
    value.files.at(0).sha256 = value.files.at(0).sha256.toUpperCase();
  }, "FILE_RECORD_INVALID");

  const raw = await readFile(manifestPath, "utf8");
  const duplicateKey = raw.replace(
    "{\n",
    '{\n  "format": "dubsar.workbench-conformance/1",\n',
  );
  const report = await checkWorkbenchConformance({ manifestSource: duplicateKey });
  assert.equal(firstCode(report), "MANIFEST_KEY_DUPLICATE");

  const reflected = await manifest();
  reflected.components.at(0).key = "\u202Euntrusted";
  delete reflected.components.at(0).effects.output;
  const reflectedReport = await checkWorkbenchConformance({
    manifestSource: reflected,
  });
  assert.equal(firstCode(reflectedReport), "COMPONENT_EFFECTS_SCHEMA_INVALID");
  assert.equal(Object.hasOwn(reflectedReport.findings.at(0), "subject"), false);
  assert.equal(reflectedReport.declared, null);
  assert.equal(JSON.stringify(reflectedReport).includes("\u202E"), false);

  const privateCanary = ["PRIVATE", "_CANARY_", "\u202E", "C:/outside"].join("");
  for (const mutate of [
    (value) => {
      value.source = { kind: "working_tree", commit: privateCanary };
    },
    (value) => {
      value.review = { status: "pending", note: privateCanary };
    },
    (value) => {
      value.content_root_sha256 = privateCanary;
    },
  ]) {
    const hostile = await manifest();
    mutate(hostile);
    const hostileReport = await checkWorkbenchConformance({
      manifestSource: hostile,
    });
    const serialized = JSON.stringify(hostileReport);
    assert.equal(hostileReport.declared, null);
    assert.equal(serialized.includes(privateCanary), false);
    assert.equal(serialized.includes("\u202E"), false);
    assert.equal(serialized.includes("C:/outside"), false);
  }

  await assertRejectedManifest((value) => {
    value.source = { kind: "commit", commit: "0".repeat(40) };
  }, "SOURCE_STATE_INVALID");
  await assertRejectedManifest((value) => {
    value.review.status = "approved";
  }, "REVIEW_STATE_INVALID");
  await assertRejectedManifest((value) => {
    value.content_root_sha256 = "0".repeat(64);
  }, "CONTENT_ROOT_MISMATCH");
});

test("the independent policy rejects component, effect and digest drift", async () => {
  await assertRejectedManifest((value) => {
    value.components.at(0).version = "0.1.1-dev";
  }, "COMPONENT_DECLARATION_MISMATCH");
  await assertRejectedManifest((value) => {
    value.components.find((item) => item.key === "server").effects.inbound_network =
      "none";
  }, "COMPONENT_DECLARATION_MISMATCH");
  await assertRejectedManifest((value) => {
    value.components.find((item) => item.key === "cli").root =
      "packages/manifest-controlled-root";
  }, "COMPONENT_DECLARATION_MISMATCH");
  await assertRejectedManifest((value) => {
    value.policy.sha256 = "0".repeat(64);
  }, "POLICY_DIGEST_MISMATCH");
});

test("metadata, public bindings and produced format objects are checked from captured bytes", async (t) => {
  const metadataRoot = await mirrorWorkbench(t, "dubsar-conformance-metadata-");
  const metadataPath = path.join(
    metadataRoot,
    "packages",
    "dubsar-operator-core",
    "package.json",
  );
  const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
  metadata.version = "0.1.1-dev";
  await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
  await assert.rejects(
    () => buildWorkingTreeManifest(metadataRoot),
    (error) => error?.code === "PACKAGE_METADATA_MISMATCH",
  );

  const identityRoot = await mirrorWorkbench(t, "dubsar-conformance-identity-");
  const identityPath = path.join(
    identityRoot,
    "packages",
    "dubsar-operator-core",
    "src",
    "index.mjs",
  );
  const identitySource = await readFile(identityPath, "utf8");
  await writeFile(
    identityPath,
    identitySource.replace(
      "export const OPERATOR_CORE_IDENTITY",
      "const OPERATOR_CORE_IDENTITY",
    ),
  );
  await assert.rejects(
    () => buildWorkingTreeManifest(identityRoot),
    (error) => error?.code === "RUNTIME_BINDING_INVALID",
  );

  const formatRoot = await mirrorWorkbench(t, "dubsar-conformance-format-");
  const formatPath = path.join(
    formatRoot,
    "packages",
    "dubsar-operator-cli",
    "src",
    "cli.mjs",
  );
  const formatSource = await readFile(formatPath, "utf8");
  await writeFile(
    formatPath,
    `${formatSource.replace(
      'format: "dubsar.validation/1"',
      'format: "changed.validation"',
    )}\nfunction unusedReturn() { return { format: "dubsar.validation/1" }; }\nfunction unusedValue() { const value = { format: "dubsar.validation/1" }; return value; }\nfunction unusedDeepFreeze() { return deepFreeze({ format: "dubsar.validation/1" }); }\nfunction unusedObjectFreeze() { return Object.freeze({ format: "dubsar.validation/1" }); }\n`,
  );
  await assert.rejects(
    () => buildWorkingTreeManifest(formatRoot),
    (error) => error?.code === "RUNTIME_FORMAT_PRODUCER_INVALID",
  );
});

test("the policy digest is anchored to the loaded checker module, not a mirror", async (t) => {
  const root = await mirrorWorkbench(t, "dubsar-conformance-policy-anchor-");
  await writeFile(
    path.join(root, "tools", "check-workbench-runtime.mjs"),
    "throw new Error('mirror policy must not execute');\n",
  );
  const report = await checkWorkbenchConformance({
    repositoryRoot: root,
    manifestSource: await manifest(),
  });
  assert.equal(report.conformant, true);
  assert.equal(report.observed.policy.sha256, (await manifest()).policy.sha256);
});

test("inventory comparison fails on extra files and cooperative source mutation", async (t) => {
  const extraRoot = await mirrorWorkbench(t, "dubsar-conformance-extra-");
  await writeFile(
    path.join(extraRoot, "packages", "dubsar-operator-core", "extra.txt"),
    "unexpected\n",
  );
  const extra = await checkWorkbenchConformance({
    repositoryRoot: extraRoot,
    manifestSource: await manifest(),
  });
  assert.equal(firstCode(extra), "FILE_INVENTORY_MISMATCH");

  const changingRoot = await mirrorWorkbench(t, "dubsar-conformance-change-");
  const changingFile = path.join(
    changingRoot,
    "packages",
    "dubsar-operator-core",
    "README.md",
  );
  const changing = await checkWorkbenchConformance({
    repositoryRoot: changingRoot,
    manifestSource: await manifest(),
    async betweenCaptures() {
      const original = await readFile(changingFile);
      await writeFile(changingFile, Buffer.concat([original, Buffer.from("changed\n")]));
    },
  });
  assert.equal(firstCode(changing), "SOURCE_CHANGED_BETWEEN_CAPTURES");

  const runtimeChangingRoot = await mirrorWorkbench(
    t,
    "dubsar-conformance-runtime-change-",
  );
  const runtimeChangingFile = path.join(
    runtimeChangingRoot,
    "packages",
    "dubsar-operator-core",
    "README.md",
  );
  const runtimeChanging = await checkWorkbenchConformance({
    repositoryRoot: runtimeChangingRoot,
    manifestSource: await manifest(),
    async beforeRuntimeObservation() {
      const original = await readFile(runtimeChangingFile);
      await writeFile(
        runtimeChangingFile,
        Buffer.concat([original, Buffer.from("changed during runtime\n")]),
      );
    },
  });
  assert.equal(
    firstCode(runtimeChanging),
    "SOURCE_CHANGED_DURING_RUNTIME_OBSERVATION",
  );
});

test("links and physical aliases are rejected", async (t) => {
  const hardlinkRoot = await mirrorWorkbench(t, "dubsar-conformance-hardlink-");
  const first = path.join(
    hardlinkRoot,
    "packages",
    "dubsar-operator-core",
    "README.md",
  );
  const second = path.join(
    hardlinkRoot,
    "packages",
    "dubsar-operator-core",
    "package.json",
  );
  await unlink(second);
  await link(first, second);
  await assert.rejects(
    () => captureWorkbenchFiles(hardlinkRoot),
    (error) => error?.code === "FILE_LINK_COUNT_UNSAFE",
  );

  const symlinkRoot = await mirrorWorkbench(t, "dubsar-conformance-symlink-");
  const target = path.join(
    symlinkRoot,
    "packages",
    "dubsar-operator-core",
    "README.md",
  );
  const candidate = path.join(
    symlinkRoot,
    "packages",
    "dubsar-operator-core",
    "linked.md",
  );
  let symlinkCreated = false;
  try {
    await symlink(target, candidate, "file");
    symlinkCreated = true;
  } catch (error) {
    if (new Set(["EPERM", "EACCES", "ENOTSUP"]).has(error?.code)) {
      t.diagnostic(`symlink assertion skipped: ${error.code}`);
    } else {
      throw error;
    }
  }
  if (symlinkCreated) {
    await assert.rejects(
      () => captureWorkbenchFiles(symlinkRoot),
      (error) => error?.code === "PATH_LINK_UNSAFE",
    );
  }

  if (process.platform === "win32") {
    t.diagnostic("FIFO assertion requires a POSIX filesystem");
  } else {
    const fifoRoot = await mirrorWorkbench(t, "dubsar-conformance-fifo-");
    const fifoPath = path.join(
      fifoRoot,
      "packages",
      "dubsar-operator-core",
      "non-regular.fifo",
    );
    const created = spawnSync("mkfifo", [fifoPath], {
      shell: false,
      windowsHide: true,
      stdio: "ignore",
    });
    assert.equal(created.error, undefined);
    assert.equal(created.status, 0);
    await assert.rejects(
      () => captureWorkbenchFiles(fifoRoot),
      (error) => error?.code === "FILE_TYPE_UNSAFE",
    );
  }

  const junctionRoot = await mirrorWorkbench(t, "dubsar-conformance-junction-");
  const componentRoot = path.join(
    junctionRoot,
    "packages",
    "dubsar-operator-core",
  );
  const movedRoot = `${componentRoot}-physical`;
  await rename(componentRoot, movedRoot);
  try {
    await symlink(
      movedRoot,
      componentRoot,
      process.platform === "win32" ? "junction" : "dir",
    );
  } catch (error) {
    if (new Set(["EPERM", "EACCES", "ENOTSUP"]).has(error?.code)) {
      t.diagnostic(`junction assertion skipped: ${error.code}`);
      return;
    }
    throw error;
  }
  await assert.rejects(
    () => captureWorkbenchFiles(junctionRoot),
    (error) => error?.code === "DIRECTORY_TYPE_UNSAFE",
  );
});

test("the content root is ordered and domain-separated", async () => {
  const value = await manifest();
  assert.equal(computeContentRoot(value.files), value.content_root_sha256);
  const reversed = [...value.files].reverse();
  assert.notEqual(computeContentRoot(reversed), value.content_root_sha256);
  const withoutLast = value.files.slice(0, -1);
  assert.notEqual(computeContentRoot(withoutLast), value.content_root_sha256);
});

test("the hermetic source-bundle probe copies only the fixed allowlist", async () => {
  const result = await runSourceBundleProbe();
  const value = await manifest();
  assert.equal(result.fileCount, value.files.length);
  assert.equal(result.contentRoot, value.content_root_sha256);
});

test("the probe bounds hung and noisy children and strips ambient channels", async () => {
  const env = probeEnvironment("C:\\fake-home", "C:\\fake-temp", {
    PATH: "poisoned",
    NODE_OPTIONS: "--inspect",
    HTTPS_PROXY: "http://untrusted.invalid",
    TOKEN: "secret-shaped",
  });
  assert.equal(Object.hasOwn(env, "PATH"), false);
  assert.equal(Object.hasOwn(env, "NODE_OPTIONS"), false);
  assert.equal(Object.hasOwn(env, "HTTPS_PROXY"), false);
  assert.equal(Object.hasOwn(env, "TOKEN"), false);

  await assert.rejects(
    () =>
      runBoundedNode(["--eval", "setInterval(() => {}, 1000)"], {
        cwd: repositoryRoot,
        env,
        timeoutMs: 100,
      }),
    (error) => error?.code === "PROBE_TIMEOUT",
  );
  await assert.rejects(
    () =>
      runBoundedNode(
        ["--eval", 'process.stdout.write("x".repeat(8192))'],
        {
          cwd: repositoryRoot,
          env,
          maxOutputBytes: 1024,
        },
      ),
    (error) => error?.code === "PROBE_STDOUT_LIMIT",
  );
  await assert.rejects(
    () =>
      runCleanProbeCommand(
        ["--eval", 'process.stderr.write("unexpected\\n")'],
        { cwd: repositoryRoot, env },
      ),
    (error) => error?.code === "PROBE_STDERR_NOT_EMPTY",
  );
  await assert.rejects(
    () =>
      runBoundedNode(["--eval", "process.exit(7)"], {
        cwd: repositoryRoot,
        env,
      }),
    (error) => error?.code === "PROBE_CHILD_FAILED",
  );
});

test("the probe detects a source changed after copy", async (t) => {
  const sourceRoot = await mirrorWorkbench(t, "dubsar-conformance-probe-change-");
  const sourceFile = path.join(
    sourceRoot,
    "packages",
    "dubsar-operator-core",
    "README.md",
  );
  await assert.rejects(
    () =>
      runSourceBundleProbe({
        sourceRoot,
        runCommands: false,
        async afterCopy() {
          const original = await readFile(sourceFile);
          await writeFile(sourceFile, Buffer.concat([original, Buffer.from("changed\n")]));
        },
      }),
    (error) => error instanceof assert.AssertionError,
  );
});
