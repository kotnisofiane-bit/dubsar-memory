import assert from "node:assert/strict";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { checkWorkbenchRuntime } from "../tools/check-workbench-runtime.mjs";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const runtimePackages = [
  "dubsar-codex-workbench",
  "dubsar-operator-core",
  "dubsar-operator-cli",
  "dubsar-personal-memory",
  "dubsar-project-continuity",
  "dubsar-workbench-report",
  "dubsar-workbench-launcher",
  "dubsar-workbench-server",
];

async function runtimeFixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "dubsar-runtime-gate-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(path.join(root, "packages"));
  for (const packageName of runtimePackages) {
    await cp(
      path.join(repositoryRoot, "packages", packageName),
      path.join(root, "packages", packageName),
      { recursive: true },
    );
  }
  return root;
}

function findingCodes(result) {
  return new Set(result.findings.map((finding) => finding.code));
}

test("runtime capability gate accepts the exact reviewed graph", async (t) => {
  const root = await runtimeFixture(t);
  const result = await checkWorkbenchRuntime(root);
  assert.equal(result.status, "pass", JSON.stringify(result.findings));
  assert.deepEqual(result.findings, []);
});

test("runtime capability gate binds the reviewed PowerShell assets", async (t) => {
  const root = await runtimeFixture(t);
  const bootstrapPath = path.join(
    root,
    "packages",
    "dubsar-workbench-launcher",
    "scripts",
    "open-workbench.ps1",
  );
  await writeFile(bootstrapPath, `${await readFile(bootstrapPath, "utf8")}\nWrite-Output 'widened'\n`);
  const result = await checkWorkbenchRuntime(root);
  assert.equal(result.status, "fail");
  assert.ok(findingCodes(result).has("RUNTIME_POWERSHELL_ASSET_DIGEST_MISMATCH"));
});

test("runtime capability gate rejects Review Ledger filesystem widening", async (t) => {
  const root = await runtimeFixture(t);
  const ledgerPath = path.join(
    root,
    "packages",
    "dubsar-operator-core",
    "src",
    "review-ledger.mjs",
  );
  const source = (await readFile(ledgerPath, "utf8"))
    .replace(
      'import { lstat, open, opendir, realpath } from "node:fs/promises";',
      'import { lstat, open, opendir, realpath, writeFile } from "node:fs/promises";',
    )
    .replace('open(candidate.absolutePath, "r")', 'open(candidate.absolutePath, "w")');
  await writeFile(
    ledgerPath,
    `${source}\nawait writeFile("unexpected.txt", "mutation");\n`,
  );
  const result = await checkWorkbenchRuntime(root);
  const codes = findingCodes(result);
  assert.equal(result.status, "fail");
  assert.ok(codes.has("RUNTIME_FILESYSTEM_BINDINGS_INVALID"));
  assert.ok(codes.has("RUNTIME_FILESYSTEM_WRITE_FORBIDDEN"));
  assert.ok(codes.has("RUNTIME_FILE_OPEN_MODE_INVALID"));
});

test("runtime capability gate rejects aliased Review Ledger open", async (t) => {
  const root = await runtimeFixture(t);
  const ledgerPath = path.join(
    root,
    "packages",
    "dubsar-operator-core",
    "src",
    "review-ledger.mjs",
  );
  const source = (await readFile(ledgerPath, "utf8")).replace(
    'handle = await open(candidate.absolutePath, "r");',
    'const readOpen = open;\n    handle = await readOpen(candidate.absolutePath, "r");',
  );
  await writeFile(ledgerPath, source);
  const result = await checkWorkbenchRuntime(root);
  assert.equal(result.status, "fail");
  assert.ok(findingCodes(result).has("RUNTIME_FILE_OPEN_MODE_INVALID"));
});

test("runtime capability gate rejects a widened checkpoint mutation graph", async (t) => {
  const root = await runtimeFixture(t);
  const writerPath = path.join(
    root,
    "packages",
    "dubsar-project-continuity",
    "runtime",
    "checkpoint-writer.mjs",
  );
  const source = (await readFile(writerPath, "utf8")).replace(
    "await rename(temporary, target);",
    "await rename(temporary, target);\n    await rename(temporary, proposalPath);",
  );
  await writeFile(writerPath, source);
  const result = await checkWorkbenchRuntime(root);
  assert.equal(result.status, "fail");
  assert.ok(
    findingCodes(result).has("RUNTIME_CHECKPOINT_MUTATION_GRAPH_INVALID"),
  );
});

test("runtime capability gate rejects a widened Lite initializer mutation graph", async (t) => {
  const root = await runtimeFixture(t);
  const initializerPath = path.join(
    root,
    "packages",
    "dubsar-project-continuity",
    "runtime",
    "lite-initializer.mjs",
  );
  const source = (await readFile(initializerPath, "utf8")).replace(
    "await rename(staging, change.marker);",
    "await rename(staging, change.marker);\n    await rename(staging, change.projectRoot);",
  );
  await writeFile(initializerPath, source);
  const result = await checkWorkbenchRuntime(root);
  assert.equal(result.status, "fail");
  assert.ok(
    findingCodes(result).has("RUNTIME_LITE_INITIALIZER_MUTATION_GRAPH_INVALID"),
  );
});

test("runtime capability gate rejects widened memory vNext mutation graphs", async (t) => {
  const root = await runtimeFixture(t);
  const writerPath = path.join(
    root,
    "packages",
    "dubsar-project-continuity",
    "runtime",
    "memory-vnext-writer.mjs",
  );
  const source = (await readFile(writerPath, "utf8")).replace(
    "await rename(temporary, target);",
    "await rename(temporary, target);\n    await unlink(change.location.project_root);",
  );
  await writeFile(writerPath, source);
  const result = await checkWorkbenchRuntime(root);
  assert.equal(result.status, "fail");
  assert.ok(
    findingCodes(result).has("RUNTIME_MEMORY_VNEXT_MUTATION_GRAPH_INVALID"),
  );
});

test("runtime capability gate rejects aliased filesystem mutations", async (t) => {
  const root = await runtimeFixture(t);
  const writerPath = path.join(
    root,
    "packages",
    "dubsar-project-continuity",
    "runtime",
    "checkpoint-writer.mjs",
  );
  const source = (await readFile(writerPath, "utf8")).replace(
    "await rename(temporary, target);",
    "const move = rename;\n    await move(temporary, target);",
  );
  await writeFile(writerPath, source);
  const result = await checkWorkbenchRuntime(root);
  assert.equal(result.status, "fail");
  assert.ok(
    findingCodes(result).has("RUNTIME_FILESYSTEM_BINDING_REFERENCE_INVALID"),
  );
});

test("runtime capability gate permits only reviewed environment properties", async (t) => {
  const root = await runtimeFixture(t);
  const memoryPath = path.join(
    root,
    "packages",
    "dubsar-project-continuity",
    "runtime",
    "personal-memory.mjs",
  );
  await writeFile(
    memoryPath,
    `${await readFile(memoryPath, "utf8")}\nconst unrelatedHome = process.env.HOME;\n`,
  );
  const result = await checkWorkbenchRuntime(root);
  assert.equal(result.status, "fail");
  assert.ok(findingCodes(result).has("RUNTIME_ENVIRONMENT_FORBIDDEN"));
});

test("runtime capability gate rejects personal-memory mutation widening", async (t) => {
  const root = await runtimeFixture(t);
  const memoryPath = path.join(
    root,
    "packages",
    "dubsar-project-continuity",
    "runtime",
    "personal-memory.mjs",
  );
  await writeFile(
    memoryPath,
    `${await readFile(memoryPath, "utf8")}\nawait rm(staging, { recursive: true, force: true });\n`,
  );
  const result = await checkWorkbenchRuntime(root);
  assert.equal(result.status, "fail");
  assert.ok(
    findingCodes(result).has("RUNTIME_PERSONAL_MEMORY_MUTATION_GRAPH_INVALID"),
  );
});

test("runtime capability gate rejects aliased personal-memory exclusive writes", async (t) => {
  const root = await runtimeFixture(t);
  const memoryPath = path.join(
    root,
    "packages",
    "dubsar-project-continuity",
    "runtime",
    "personal-memory.mjs",
  );
  const source = (await readFile(memoryPath, "utf8")).replace(
    "await writeExclusiveFile(path.join(staging, file), Buffer.from(initialContent(file), \"utf8\"));",
    "const extraWrite = writeExclusiveFile;\n      await writeExclusiveFile(path.join(staging, file), Buffer.from(initialContent(file), \"utf8\"));\n      await extraWrite.call(null, path.join(staging, \"sixth.md\"), Buffer.from(\"x\"));",
  );
  await writeFile(memoryPath, source);
  const result = await checkWorkbenchRuntime(root);
  assert.equal(result.status, "fail");
  assert.ok(
    findingCodes(result).has("RUNTIME_PERSONAL_MEMORY_MUTATION_GRAPH_INVALID"),
  );
});

test("runtime capability gate bounds source size and directory depth", async (t) => {
  const root = await runtimeFixture(t);
  const renderPath = path.join(
    root,
    "packages",
    "dubsar-workbench-report",
    "src",
    "render.mjs",
  );
  await writeFile(renderPath, " ".repeat(1024 * 1024 + 1), "utf8");
  let nested = path.join(root, "packages", "dubsar-workbench-report", "src");
  for (let index = 0; index < 18; index += 1) {
    nested = path.join(nested, `depth-${index}`);
    await mkdir(nested);
  }
  await writeFile(path.join(nested, "too-deep.mjs"), "export const value = true;\n", "utf8");
  const result = await checkWorkbenchRuntime(root);
  const codes = findingCodes(result);
  assert.equal(result.status, "fail");
  assert.ok(codes.has("RUNTIME_SOURCE_SIZE_LIMIT_EXCEEDED"));
  assert.ok(codes.has("RUNTIME_DEPTH_LIMIT_EXCEEDED"));
});

test("runtime capability gate resolves and rejects escaping imports", async (t) => {
  const root = await runtimeFixture(t);
  const reportIndex = path.join(
    root,
    "packages",
    "dubsar-workbench-report",
    "src",
    "index.mjs",
  );
  const escapeModule = path.join(path.dirname(reportIndex), "escape.mjs");
  await writeFile(path.join(root, "outside.mjs"), "export const outside = true;\n");
  await writeFile(escapeModule, 'export * from "../../../outside.mjs";\n');
  await writeFile(
    reportIndex,
    `${await readFile(reportIndex, "utf8")}\nexport * from "./escape.mjs";\n`,
  );
  const result = await checkWorkbenchRuntime(root);
  assert.equal(result.status, "fail");
  assert.ok(findingCodes(result).has("RUNTIME_IMPORT_OUTSIDE_BOUNDARY"));
});

test("runtime capability gate rejects dynamic imports and unclassified modules", async (t) => {
  const root = await runtimeFixture(t);
  const renderPath = path.join(
    root,
    "packages",
    "dubsar-workbench-report",
    "src",
    "render.mjs",
  );
  await writeFile(
    renderPath,
    `${await readFile(renderPath, "utf8")}
await import /* hidden */ ("node:net");
const child = process.getBuiltinModule("node:child_process");
child.spawnSync("hidden-command");
const fs = process.getBuiltinModule("node:fs");
fs.writeFileSync("hidden.txt", "mutation");
const http = process.getBuiltinModule("node:http");
http.get("http://127.0.0.1/");
`,
  );
  await writeFile(
    path.join(path.dirname(renderPath), "unclassified.mjs"),
    "export const hidden = true;\n",
  );
  const result = await checkWorkbenchRuntime(root);
  const codes = findingCodes(result);
  assert.equal(result.status, "fail");
  assert.ok(codes.has("RUNTIME_DYNAMIC_IMPORT_FORBIDDEN"));
  assert.ok(codes.has("RUNTIME_DYNAMIC_CODE_FORBIDDEN"));
  assert.ok(codes.has("RUNTIME_FILESYSTEM_WRITE_FORBIDDEN"));
  assert.ok(codes.has("RUNTIME_MODULE_UNCLASSIFIED"));
  assert.ok(codes.has("RUNTIME_NETWORK_FORBIDDEN"));
  assert.ok(codes.has("RUNTIME_PROCESS_EXECUTION_FORBIDDEN"));
});

for (const fixture of [
  {
    name: "renamed filesystem loaders",
    source: `
const { getBuiltinModule: load } = process;
const { writeFileSync: save } = load("node:fs");
save("hidden.txt", "mutation");
`,
  },
  {
    name: "renamed subprocess loaders",
    source: `
const { getBuiltinModule: load } = process;
const { spawnSync: run } = load("node:child_process");
run("hidden-command");
`,
  },
  {
    name: "renamed network loaders",
    source: `
const { getBuiltinModule: load } = process;
const { get: request } = load("node:http");
request("http://127.0.0.1/");
`,
  },
]) {
  test(`runtime capability gate rejects ${fixture.name}`, async (t) => {
    const root = await runtimeFixture(t);
    const renderPath = path.join(
      root,
      "packages",
      "dubsar-workbench-report",
      "src",
      "render.mjs",
    );
    await writeFile(
      renderPath,
      `${await readFile(renderPath, "utf8")}\n${fixture.source}`,
    );
    const result = await checkWorkbenchRuntime(root);
    assert.equal(result.status, "fail");
    assert.ok(findingCodes(result).has("RUNTIME_DYNAMIC_CODE_FORBIDDEN"));
  });
}

for (const fixture of [
  {
    name: "function constructor loaders",
    source: `
const load = (() => {}).constructor("return process.getBuiltinModule")();
const { writeFileSync: save } = load("node:fs");
save("hidden.txt", "mutation");
`,
  },
  {
    name: "chained array constructors",
    source: `
const load = [].constructor.constructor("return process.getBuiltinModule")();
const { writeFileSync: save } = load("node:fs");
save("hidden.txt", "mutation");
`,
  },
  {
    name: "chained object constructors",
    source: `
({}).constructor.constructor(
  "return process.getBuiltinModule('node:fs').writeFileSync('hidden.txt','x')",
)();
`,
  },
  {
    name: "aliased Object prototype destructuring",
    source: `
const O = Object;
const { constructor: Compile } = O.getPrototypeOf(() => {});
const load = Compile("return process.getBuiltinModule")();
const { writeFileSync: save } = load("node:fs");
save("hidden.txt", "mutation");
`,
  },
  {
    name: "indirect computed constructor keys",
    source: `
const key = "constructor";
({})[key][key](
  "return process.getBuiltinModule('node:fs').writeFileSync('hidden.txt','x')",
)();
`,
  },
]) {
  test(`runtime capability gate rejects ${fixture.name}`, async (t) => {
    const root = await runtimeFixture(t);
    const renderPath = path.join(
      root,
      "packages",
      "dubsar-workbench-report",
      "src",
      "render.mjs",
    );
    await writeFile(
      renderPath,
      `${await readFile(renderPath, "utf8")}\n${fixture.source}`,
    );
    const result = await checkWorkbenchRuntime(root);
    assert.equal(result.status, "fail");
    if (fixture.name === "indirect computed constructor keys") {
      assert.ok(findingCodes(result).has("RUNTIME_DYNAMIC_MEMBER_FORBIDDEN"));
    } else {
      assert.ok(findingCodes(result).has("RUNTIME_DYNAMIC_CODE_FORBIDDEN"));
    }
  });
}

test("runtime capability gate rejects aliased network globals", async (t) => {
  const root = await runtimeFixture(t);
  const renderPath = path.join(
    root,
    "packages",
    "dubsar-workbench-report",
    "src",
    "render.mjs",
  );
  await writeFile(
    renderPath,
    `${await readFile(renderPath, "utf8")}
const send = fetch;
await send("https://example.invalid/");
`,
  );
  const result = await checkWorkbenchRuntime(root);
  assert.equal(result.status, "fail");
  assert.ok(findingCodes(result).has("RUNTIME_NETWORK_FORBIDDEN"));
});

for (const fixture of [
  {
    code: "RUNTIME_FILESYSTEM_WRITE_FORBIDDEN",
    name: "destructured FileHandle mutators",
    source: `
const { chmod: mutate } = handle;
await mutate.call(handle, 0);
`,
  },
  {
    code: "RUNTIME_DYNAMIC_MEMBER_FORBIDDEN",
    name: "computed destructured FileHandle mutators",
    source: `
const key = "chmod";
const { [key]: mutate } = handle;
await mutate.call(handle, 0);
`,
  },
]) {
  test(`runtime capability gate rejects ${fixture.name}`, async (t) => {
    const root = await runtimeFixture(t);
    const snapshotPath = path.join(
      root,
      "packages",
      "dubsar-operator-core",
      "src",
      "snapshot.mjs",
    );
    await writeFile(
      snapshotPath,
      `${await readFile(snapshotPath, "utf8")}\n${fixture.source}`,
    );
    const result = await checkWorkbenchRuntime(root);
    assert.equal(result.status, "fail");
    assert.ok(findingCodes(result).has(fixture.code));
  });
}

test("runtime capability gate rejects fs aliases, reflective calls, commented imports, writable open modes, and bracket writes", async (t) => {
  const root = await runtimeFixture(t);
  const capturePath = path.join(
    root,
    "packages",
    "dubsar-project-continuity",
    "runtime",
    "safe-capture.mjs",
  );
  const source = (await readFile(capturePath, "utf8"))
    .replace(
      'import { open } from "node:fs/promises";',
      'import { open, writeFile as persist } from "node:fs/promises";',
    )
    .replace('open(candidate, "r")', 'open(candidate, "w")');
  await writeFile(
    capturePath,
    `${source}
import/*comment*/{ writeFile as hiddenPersist }from"node:fs/promises";
const writableOpen = open;
await writableOpen(candidate, "w");
Reflect.apply(open, null, [candidate, "w"]);
await persist("hidden.txt", "mutation");
Reflect.apply(handle["write" + "File"], null, ["mutation"]);
`,
  );
  const result = await checkWorkbenchRuntime(root);
  const codes = findingCodes(result);
  assert.equal(result.status, "fail");
  assert.ok(codes.has("RUNTIME_FILESYSTEM_BINDINGS_INVALID"));
  assert.ok(codes.has("RUNTIME_FILE_OPEN_MODE_INVALID"));
  assert.ok(codes.has("RUNTIME_FILESYSTEM_WRITE_FORBIDDEN"));
  assert.ok(codes.has("RUNTIME_DYNAMIC_CODE_FORBIDDEN"));
});

test("runtime capability gate rejects linked source paths when supported", async (t) => {
  const root = await runtimeFixture(t);
  const outside = path.join(root, "linked-source");
  const linked = path.join(
    root,
    "packages",
    "dubsar-workbench-report",
    "src",
    "linked",
  );
  await mkdir(outside);
  await writeFile(path.join(outside, "hidden.mjs"), "export const hidden = true;\n");
  try {
    await symlink(outside, linked, "junction");
  } catch (error) {
    if (new Set(["EACCES", "EPERM"]).has(error?.code)) {
      t.skip("Linked-directory creation is unavailable in this Windows profile.");
      return;
    }
    throw error;
  }
  const result = await checkWorkbenchRuntime(root);
  assert.equal(result.status, "fail");
  assert.ok(findingCodes(result).has("RUNTIME_SYMBOLIC_PATH_FORBIDDEN"));
});

test("runtime capability gate confines inbound HTTP bindings to the reviewed server file", async (t) => {
  const root = await runtimeFixture(t);
  const serverPath = path.join(
    root,
    "packages",
    "dubsar-workbench-server",
    "src",
    "server.mjs",
  );
  const source = (await readFile(serverPath, "utf8"))
    .replace(
      'import { createServer } from "node:http";',
      'import { createServer, request } from "node:http";',
    )
    .replace(
      "const server = createServer(",
      'request("http://example.invalid/");\n  const server = createServer(',
    );
  await writeFile(serverPath, source);
  const result = await checkWorkbenchRuntime(root);
  assert.equal(result.status, "fail");
  assert.ok(findingCodes(result).has("RUNTIME_SERVER_BINDINGS_INVALID"));
});

test("runtime capability gate rejects aliased server creation", async (t) => {
  const root = await runtimeFixture(t);
  const serverPath = path.join(
    root,
    "packages",
    "dubsar-workbench-server",
    "src",
    "server.mjs",
  );
  const source = (await readFile(serverPath, "utf8")).replace(
    "const server = createServer(",
    "const makeServer = createServer;\n  const server = makeServer(",
  );
  await writeFile(serverPath, source);
  const result = await checkWorkbenchRuntime(root);
  assert.equal(result.status, "fail");
  assert.ok(findingCodes(result).has("RUNTIME_SERVER_BINDING_USE_INVALID"));
});

test("runtime capability gate rejects a widened listener address", async (t) => {
  const root = await runtimeFixture(t);
  const serverPath = path.join(
    root,
    "packages",
    "dubsar-workbench-server",
    "src",
    "server.mjs",
  );
  const source = (await readFile(serverPath, "utf8")).replace(
    'host: "127.0.0.1", port: 0',
    'host: "0.0.0.0", port: 0',
  );
  await writeFile(serverPath, source);
  const result = await checkWorkbenchRuntime(root);
  assert.equal(result.status, "fail");
  assert.ok(findingCodes(result).has("RUNTIME_SERVER_LISTEN_INVALID"));
});

test("runtime capability gate rejects Node HTTP re-exports", async (t) => {
  const root = await runtimeFixture(t);
  const indexPath = path.join(
    root,
    "packages",
    "dubsar-workbench-server",
    "src",
    "index.mjs",
  );
  await writeFile(
    indexPath,
    `${await readFile(indexPath, "utf8")}\nexport { request } from "node:http";\n`,
  );
  const result = await checkWorkbenchRuntime(root);
  assert.equal(result.status, "fail");
  assert.ok(findingCodes(result).has("RUNTIME_SERVER_BINDINGS_INVALID"));
});

test("runtime capability gate rejects indirect listen and socket outbound calls", async (t) => {
  const root = await runtimeFixture(t);
  const serverPath = path.join(
    root,
    "packages",
    "dubsar-workbench-server",
    "src",
    "server.mjs",
  );
  await writeFile(
    serverPath,
    `${await readFile(serverPath, "utf8")}
const hiddenListen = server.listen.bind(server);
hiddenListen({ host: "0.0.0.0", port: 0 });
socket.connect(443, "example.invalid");
`,
  );
  const result = await checkWorkbenchRuntime(root);
  const codes = findingCodes(result);
  assert.equal(result.status, "fail");
  assert.ok(codes.has("RUNTIME_SERVER_LISTEN_INVALID"));
  assert.ok(codes.has("RUNTIME_SERVER_OUTBOUND_FORBIDDEN"));
});

test("runtime capability gate rejects a permissive HTTP parser", async (t) => {
  const root = await runtimeFixture(t);
  const serverPath = path.join(
    root,
    "packages",
    "dubsar-workbench-server",
    "src",
    "server.mjs",
  );
  const source = (await readFile(serverPath, "utf8")).replace(
    "insecureHTTPParser: false",
    "insecureHTTPParser: true",
  );
  await writeFile(serverPath, source);
  const result = await checkWorkbenchRuntime(root);
  assert.equal(result.status, "fail");
  assert.ok(
    findingCodes(result).has("RUNTIME_SERVER_BINDING_USE_INVALID"),
  );
});

test("runtime capability gate requires the bounded connection-check interval", async (t) => {
  const root = await runtimeFixture(t);
  const serverPath = path.join(
    root,
    "packages",
    "dubsar-workbench-server",
    "src",
    "server.mjs",
  );
  const source = (await readFile(serverPath, "utf8")).replace(
    "connectionsCheckingInterval: limits.connectionsCheckingIntervalMs,",
    "",
  );
  await writeFile(serverPath, source);
  const result = await checkWorkbenchRuntime(root);
  assert.equal(result.status, "fail");
  assert.ok(
    findingCodes(result).has("RUNTIME_SERVER_BINDING_USE_INVALID"),
  );
});
