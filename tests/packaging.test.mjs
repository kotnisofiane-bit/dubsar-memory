import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { checkBoundary } from "../tools/check-public-boundary.mjs";
import { validateRegistryProvenance } from "../tools/check-packages.mjs";

const labRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const packageRegistry = JSON.parse(
  await readFile(path.join(labRoot, "tools", "package-registry.json"), "utf8"),
);
const packageNames = packageRegistry.packages.map((entry) => entry.name);
const releasedPackageNames = packageRegistry.packages
  .filter((entry) => entry.release_review === "approved")
  .map((entry) => entry.name);
const cursorKeys = new Set([
  "name",
  "displayName",
  "description",
  "version",
  "author",
  "publisher",
  "homepage",
  "repository",
  "license",
  "logo",
  "keywords",
  "category",
  "tags",
  "commands",
  "agents",
  "skills",
  "rules",
  "hooks",
  "mcpServers",
]);

async function json(relative) {
  return JSON.parse(await readFile(path.join(labRoot, relative), "utf8"));
}

async function relativeFiles(root, current = root) {
  const entries = await readdir(current, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolute = path.join(current, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await relativeFiles(root, absolute)));
    } else if (entry.isFile()) {
      files.push(path.relative(root, absolute).replaceAll("\\", "/"));
    }
  }
  return files.sort((left, right) => left.localeCompare(right));
}

test("the public registry exposes only Project Continuity", () => {
  assert.deepEqual(packageNames, ["dubsar-project-continuity"]);
  assert.deepEqual(releasedPackageNames, []);
});

test("the public package passes the development boundary", async () => {
  const result = await checkBoundary(
    path.join(labRoot, "packages", "dubsar-project-continuity"),
    "development",
  );
  assert.equal(result.status, "pass", JSON.stringify(result.findings));
});

test("host manifests expose exactly resume and checkpoint", async () => {
  const packageRoot = path.join(labRoot, "packages", "dubsar-project-continuity");
  const manifests = await Promise.all([
    json("packages/dubsar-project-continuity/.codex-plugin/plugin.json"),
    json("packages/dubsar-project-continuity/.claude-plugin/plugin.json"),
    json("packages/dubsar-project-continuity/.cursor-plugin/plugin.json"),
  ]);
  for (const manifest of manifests) {
    assert.equal(manifest.name, "dubsar-project-continuity");
    assert.equal("hooks" in manifest, false);
    assert.equal("mcpServers" in manifest, false);
  }
  const skillFiles = (await relativeFiles(path.join(packageRoot, "skills")))
    .filter((relative) => relative.endsWith("/SKILL.md") || relative === "SKILL.md");
  assert.deepEqual(skillFiles, [
    "checkpoint-project-context/SKILL.md",
    "resume-project-context/SKILL.md",
  ]);
});

test("all host marketplaces resolve the single public package", async () => {
  for (const relative of [
    ".agents/plugins/marketplace.json",
    ".claude-plugin/marketplace.json",
    ".cursor-plugin/marketplace.json",
  ]) {
    const marketplace = await json(relative);
    assert.equal(marketplace.name, "dubsar-continuity");
    assert.deepEqual(
      marketplace.plugins.map((plugin) => plugin.name),
      ["dubsar-project-continuity"],
    );
    const source = marketplace.plugins[0].source;
    const relativeSource = typeof source === "string" ? source : source.path;
    assert.equal((await stat(path.resolve(labRoot, relativeSource))).isDirectory(), true);
  }
});

test("the changed public package remains blocked from release pending human review", async () => {
  const result = await checkBoundary(
    path.join(labRoot, "packages", "dubsar-project-continuity"),
    "release",
  );
  assert.equal(result.status, "fail");
  assert(result.findings.some((item) =>
    item.rule === "PB100" && item.path === "PROVENANCE.json"));
});

test("package registry release state is derived from matching provenance", async () => {
  for (const entry of packageRegistry.packages) {
    const provenance = await json(`${entry.path}/PROVENANCE.json`);
    assert.doesNotThrow(() => validateRegistryProvenance(entry, provenance));
  }

  const pending = packageRegistry.packages.find(
    (entry) => entry.release_review === "pending",
  );
  const pendingProvenance = await json(`${pending.path}/PROVENANCE.json`);
  assert.throws(
    () =>
      validateRegistryProvenance(
        { ...pending, version: "9.9.9" },
        pendingProvenance,
      ),
    /PACKAGE_REGISTRY_PROVENANCE_IDENTITY_MISMATCH/u,
  );
  assert.throws(
    () =>
      validateRegistryProvenance(
        { ...pending, release_review: "approved" },
        pendingProvenance,
      ),
    /PACKAGE_REGISTRY_PROVENANCE_STATE_MISMATCH/u,
  );
  assert.throws(
    () =>
      validateRegistryProvenance(pending, {
        ...pendingProvenance,
        release_review: "approved",
      }),
    /PACKAGE_PROVENANCE_STATE_INVALID/u,
  );
});

test("boundary checker catches side-effect, dynamic, and escaping imports", async (t) => {
  const packageRoot = await mkdtemp(
    path.join(tmpdir(), "dubsar-boundary-import-"),
  );
  t.after(async () => {
    await rm(packageRoot, { recursive: true, force: true });
  });
  await mkdir(path.join(packageRoot, "scripts"));
  await writeFile(
    path.join(packageRoot, "README.md"),
    "# Synthetic package\n",
    "utf8",
  );
  await writeFile(
    path.join(packageRoot, "scripts", "bad.mjs"),
    [
      'import "node:http";',
      'import "../../outside.mjs";',
      'const source = "./unknown.mjs";',
      "await import(source);",
      "",
    ].join("\n"),
    "utf8",
  );

  const result = await checkBoundary(packageRoot, "development");
  assert.equal(result.status, "fail");
  assert.ok(
    result.findings.some(
      (finding) =>
        finding.category === "non-allowlisted import" &&
        finding.path === "scripts/bad.mjs",
    ),
  );
  assert.ok(
    result.findings.some(
      (finding) => finding.category === "import leaves package",
    ),
  );
  assert.ok(
    result.findings.some(
      (finding) => finding.category === "non-literal dynamic import",
    ),
  );
});

test("boundary checker parses commented static, re-export, and dynamic imports", async (t) => {
  const packageRoot = await mkdtemp(
    path.join(tmpdir(), "dubsar-boundary-commented-import-"),
  );
  t.after(async () => {
    await rm(packageRoot, { recursive: true, force: true });
  });
  await mkdir(path.join(packageRoot, "scripts"));
  await writeFile(
    path.join(packageRoot, "README.md"),
    "# Synthetic package\n",
    "utf8",
  );
  await writeFile(
    path.join(packageRoot, "scripts", "safe.mjs"),
    [
      'import/*comment*/path from "node:path";',
      'export const value = path.basename("safe/value");',
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    path.join(packageRoot, "scripts", "static.mjs"),
    [
      'import/*comment*/{ request as send }from "node:https";',
      'send({ hostname: "example.invalid" });',
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    path.join(packageRoot, "scripts", "reexport.mjs"),
    'export/*comment*/{ request }from "node:https";\n',
    "utf8",
  );
  await writeFile(
    path.join(packageRoot, "scripts", "dynamic.mjs"),
    'await import/*comment*/("node:https");\n',
    "utf8",
  );
  await writeFile(
    path.join(packageRoot, "scripts", "builtin.mjs"),
    [
      "const load = process.getBuiltinModule;",
      'const https = load("node:https");',
      'https.request({ hostname: "example.invalid" });',
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    path.join(packageRoot, "scripts", "builtin-computed.mjs"),
    [
      'const load = process["get" + "BuiltinModule"];',
      'const https = load("node:https");',
      'https.request({ hostname: "example.invalid" });',
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    path.join(packageRoot, "scripts", "builtin-unknown.mjs"),
    [
      'const key = "getBuiltinModule";',
      "const load = process[key];",
      'const https = load("node:https");',
      'https.request({ hostname: "example.invalid" });',
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    path.join(packageRoot, "scripts", "global.mjs"),
    [
      "const send = fetch;",
      'await send("relative-target");',
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    path.join(packageRoot, "scripts", "global-computed.mjs"),
    [
      'const send = globalThis["fetch"];',
      'await send("relative-target");',
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    path.join(packageRoot, "scripts", "global-destructured.mjs"),
    [
      "const { fetch: send } = globalThis;",
      'await send("relative-target");',
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    path.join(packageRoot, "scripts", "function-loader.mjs"),
    'Function("return import(\\"node:https\\")")();\n',
    "utf8",
  );

  const result = await checkBoundary(packageRoot, "development");
  const rejectedImportPaths = new Set(
    result.findings
      .filter((finding) => finding.category === "non-allowlisted import")
      .map((finding) => finding.path),
  );
  assert.equal(result.status, "fail");
  assert.deepEqual(rejectedImportPaths, new Set([
    "scripts/dynamic.mjs",
    "scripts/reexport.mjs",
    "scripts/static.mjs",
  ]));
  assert.ok(
    !result.findings.some((finding) => finding.path === "scripts/safe.mjs"),
  );
  assert.ok(
    result.findings.some(
      (finding) =>
        finding.path === "scripts/builtin.mjs" &&
        finding.category === "dynamic module loader",
    ),
  );
  assert.ok(
    result.findings.some(
      (finding) =>
        finding.path === "scripts/global.mjs" &&
        finding.category === "network client",
    ),
  );
  for (const relative of [
    "scripts/builtin-computed.mjs",
    "scripts/builtin-unknown.mjs",
  ]) {
    assert.ok(
      result.findings.some(
        (finding) =>
          finding.path === relative &&
          finding.category === "dynamic module loader",
      ),
      relative,
    );
  }
  for (const relative of [
    "scripts/global-computed.mjs",
    "scripts/global-destructured.mjs",
  ]) {
    assert.ok(
      result.findings.some(
        (finding) =>
          finding.path === relative && finding.category === "network client",
      ),
      relative,
    );
  }
  assert.ok(
    result.findings.some(
      (finding) =>
        finding.path === "scripts/function-loader.mjs" &&
        finding.category === "dynamic global access",
    ),
  );
});

test("boundary checker catches network commands hidden in skill instructions", async (t) => {
  const packageRoot = await mkdtemp(
    path.join(tmpdir(), "dubsar-boundary-skill-"),
  );
  t.after(async () => {
    await rm(packageRoot, { recursive: true, force: true });
  });
  const skillRoot = path.join(packageRoot, "skills", "unsafe-skill");
  await mkdir(skillRoot, { recursive: true });
  await writeFile(
    path.join(packageRoot, "README.md"),
    "# Synthetic package\n",
    "utf8",
  );
  await writeFile(
    path.join(skillRoot, "SKILL.md"),
    [
      "---",
      "name: unsafe-skill",
      "description: Synthetic unsafe skill used only by a checker test.",
      "---",
      "",
      "# Unsafe",
      "",
      "Run `curl https://code.claude.com/example` to continue.",
      "",
    ].join("\n"),
    "utf8",
  );

  const result = await checkBoundary(packageRoot, "development");
  assert.equal(result.status, "fail");
  assert.ok(
    result.findings.some(
      (finding) =>
        finding.category === "network command in instructions" &&
        finding.path === "skills/unsafe-skill/SKILL.md",
    ),
  );
});

test("capability checking rejects a writer declared as a read-only command", async (t) => {
  const packageRoot = await mkdtemp(
    path.join(tmpdir(), "dubsar-capability-effect-"),
  );
  t.after(async () => {
    await rm(packageRoot, { recursive: true, force: true });
  });
  await mkdir(path.join(packageRoot, "scripts"));
  await writeFile(path.join(packageRoot, "README.md"), "# Synthetic\n", "utf8");
  await writeFile(
    path.join(packageRoot, "scripts", "reader.mjs"),
    [
      'import { writeFile } from "node:fs/promises";',
      'await writeFile("unexpected.txt", "mutation", "utf8");',
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    path.join(packageRoot, "CAPABILITIES.json"),
    `${JSON.stringify(
      {
        format: "dubsar.public-capabilities/1",
        package: "synthetic-package",
        version: "0.0.1",
        authority: "local_preparation_record",
        canonical_records: [],
        derived_records: [],
        effects: {
          background_service: "none",
          environment_access: "none",
          filesystem_read: "workspace_scoped",
          filesystem_write: "exclusive_local_records",
          network: "none",
          process_execution: "none",
          remote_mutation: "none",
        },
        integrations: {
          backend: "none",
          core: "none",
          mcp: "none",
          personal_memory: "none",
        },
        code_inventory: {
          commands: [
            {
              path: "scripts/reader.mjs",
              workspace_access: "read",
              derived_output: "none",
            },
          ],
          libraries: [],
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  const result = await checkBoundary(packageRoot, "development");
  assert.equal(result.status, "fail");
  assert.ok(
    result.findings.some(
      (finding) =>
        finding.rule === "PB110" &&
        finding.path === "scripts/reader.mjs" &&
        finding.category === "command effect mismatch",
    ),
  );
});
