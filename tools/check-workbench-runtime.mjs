import { createHash } from "node:crypto";
import { lstat, open, opendir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "acorn";

const defaultRepositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const MAX_RUNTIME_DEPTH = 16;
const MAX_RUNTIME_ENTRIES = 4096;
const MAX_RUNTIME_FILES = 512;
const MAX_RUNTIME_FILE_BYTES = 1024 * 1024;
const MAX_RUNTIME_TOTAL_BYTES = 16 * 1024 * 1024;
const MAX_POWERSHELL_ASSET_BYTES = 256 * 1024;
const MAX_POWERSHELL_ENTRIES = 64;
const powershellAssetDigests = new Map([
  [
    "packages/dubsar-workbench-launcher/scripts/install-shortcut.ps1",
    "9f57fa42429d45441a225714177beb0d13f0cfcc63234fbe891e38472da75051",
  ],
  [
    "packages/dubsar-workbench-launcher/scripts/open-workbench.ps1",
    "78747d535b9c27ca7287f90bfc1415d694ddf98a3f5e156d305fc4da589ba7a8",
  ],
  [
    "packages/dubsar-workbench-launcher/scripts/select-project-folder.ps1",
    "4e8247323ef510cbcb8926303a883fe545753595375d23177cea33367c254ea1",
  ],
]);
const runtimePolicies = Object.freeze([
  Object.freeze({
    key: "core",
    root: "packages/dubsar-operator-core",
    entrypoint: "packages/dubsar-operator-core/src/index.mjs",
    allowedNodeImports: new Set([
      "node:crypto",
      "node:fs/promises",
      "node:path",
      "node:perf_hooks",
    ]),
    allowedCrossRootTargets: new Set([
      "packages/dubsar-project-continuity/runtime/capsule.mjs",
      "packages/dubsar-project-continuity/runtime/continuity-views.mjs",
      "packages/dubsar-project-continuity/runtime/continuity.mjs",
      "packages/dubsar-project-continuity/runtime/contracts.mjs",
      "packages/dubsar-project-continuity/runtime/display-safety.mjs",
      "packages/dubsar-project-continuity/runtime/index.mjs",
      "packages/dubsar-project-continuity/runtime/memory-vnext-capsule.mjs",
      "packages/dubsar-project-continuity/runtime/memory-vnext-contracts.mjs",
      "packages/dubsar-project-continuity/runtime/path-safety.mjs",
      "packages/dubsar-project-continuity/runtime/project.mjs",
      "packages/dubsar-project-continuity/runtime/safe-capture.mjs",
      "packages/dubsar-project-continuity/runtime/sensitive-content.mjs",
    ]),
  }),
  Object.freeze({
    key: "cli",
    root: "packages/dubsar-operator-cli",
    entrypoint: "packages/dubsar-operator-cli/bin/dubsar.mjs",
    allowedNodeImports: new Set([
      "node:crypto",
      "node:fs/promises",
      "node:path",
      "node:readline/promises",
    ]),
    allowedCrossRootTargets: new Set([
      "packages/dubsar-operator-core/src/index.mjs",
      "packages/dubsar-operator-core/src/display-safety.mjs",
      "packages/dubsar-operator-core/src/path-safety.mjs",
      "packages/dubsar-operator-core/src/safe-capture.mjs",
      "packages/dubsar-operator-core/src/sensitive-content.mjs",
      "packages/dubsar-personal-memory/src/index.mjs",
      "packages/dubsar-project-continuity/runtime/checkpoint-writer.mjs",
      "packages/dubsar-project-continuity/runtime/cli.mjs",
      "packages/dubsar-project-continuity/runtime/close-session.mjs",
      "packages/dubsar-project-continuity/runtime/memory-session.mjs",
      "packages/dubsar-project-continuity/runtime/index.mjs",
      "packages/dubsar-workbench-report/src/index.mjs",
      "packages/dubsar-workbench-server/src/index.mjs",
    ]),
  }),
  Object.freeze({
    key: "personal-memory",
    root: "packages/dubsar-personal-memory",
    entrypoint: "packages/dubsar-personal-memory/src/index.mjs",
    allowedNodeImports: new Set([
      "node:crypto",
      "node:fs/promises",
      "node:path",
    ]),
    allowedCrossRootTargets: new Set([
      "packages/dubsar-project-continuity/runtime/personal-memory.mjs",
    ]),
  }),
  Object.freeze({
    key: "continuity-runtime",
    root: "packages/dubsar-project-continuity/runtime",
    entrypoint: "packages/dubsar-project-continuity/runtime/cli.mjs",
    allowedNodeImports: new Set([
      "node:crypto",
      "node:fs/promises",
      "node:path",
      "node:readline/promises",
    ]),
    allowedCrossRootTargets: new Set(),
  }),
  Object.freeze({
    key: "report",
    root: "packages/dubsar-workbench-report",
    entrypoint: "packages/dubsar-workbench-report/src/index.mjs",
    allowedNodeImports: new Set(),
    allowedCrossRootTargets: new Set([
      "packages/dubsar-operator-core/src/contracts.mjs",
      "packages/dubsar-operator-core/src/display-safety.mjs",
      "packages/dubsar-operator-core/src/graph-model.mjs",
      "packages/dubsar-operator-core/src/index.mjs",
      "packages/dubsar-operator-core/src/project-identifiers.mjs",
      "packages/dubsar-project-continuity/runtime/index.mjs",
    ]),
  }),
  Object.freeze({
    key: "launcher",
    root: "packages/dubsar-workbench-launcher",
    entrypoint: "packages/dubsar-workbench-launcher/bin/dubsar-workbench-open.mjs",
    allowedNodeImports: new Set([
      "node:child_process",
      "node:crypto",
      "node:fs/promises",
      "node:path",
      "node:readline/promises",
      "node:url",
      "node:util",
    ]),
    allowedCrossRootTargets: new Set([
      "packages/dubsar-operator-core/src/contracts.mjs",
      "packages/dubsar-operator-core/src/display-safety.mjs",
      "packages/dubsar-operator-core/src/index.mjs",
      "packages/dubsar-operator-core/src/path-safety.mjs",
      "packages/dubsar-operator-core/src/safe-capture.mjs",
      "packages/dubsar-project-continuity/runtime/index.mjs",
      "packages/dubsar-workbench-report/src/index.mjs",
      "packages/dubsar-workbench-server/src/index.mjs",
    ]),
  }),
  Object.freeze({
    key: "server",
    root: "packages/dubsar-workbench-server",
    entrypoint: "packages/dubsar-workbench-server/src/index.mjs",
    allowedNodeImports: new Set(["node:crypto", "node:http"]),
    allowedCrossRootTargets: new Set(),
  }),
  Object.freeze({
    key: "codex-adapter",
    root: "packages/dubsar-codex-workbench",
    entrypoint: "packages/dubsar-codex-workbench/skills/resume-dubsar-workbench/scripts/read-capsule.mjs",
    allowedNodeImports: new Set([
      "node:child_process",
      "node:path",
      "node:url",
    ]),
    allowedCrossRootTargets: new Set([
      "packages/dubsar-operator-core/src/index.mjs",
      "packages/dubsar-project-continuity/runtime/index.mjs",
    ]),
  }),
]);

const fsBindingsByFile = new Map([
  [
    "packages/dubsar-project-continuity/runtime/checkpoint-writer.mjs",
    new Set(["open", "rename", "unlink"]),
  ],
  [
    "packages/dubsar-project-continuity/runtime/lite-initializer.mjs",
    new Set(["mkdir", "open", "rename", "rmdir", "unlink"]),
  ],
  [
    "packages/dubsar-project-continuity/runtime/lite.mjs",
    new Set(["opendir"]),
  ],
  [
    "packages/dubsar-project-continuity/runtime/memory-vnext-initializer.mjs",
    new Set(["mkdir", "open", "rename", "rmdir", "unlink"]),
  ],
  [
    "packages/dubsar-project-continuity/runtime/memory-vnext-bootstrap.mjs",
    new Set(["mkdir", "open", "rename", "rmdir", "unlink"]),
  ],
  [
    "packages/dubsar-project-continuity/runtime/memory-vnext-migration.mjs",
    new Set(["mkdir", "open", "rename", "rmdir", "unlink"]),
  ],
  [
    "packages/dubsar-project-continuity/runtime/memory-vnext-snapshot.mjs",
    new Set(["opendir"]),
  ],
  [
    "packages/dubsar-project-continuity/runtime/memory-vnext-views.mjs",
    new Set(["opendir"]),
  ],
  [
    "packages/dubsar-project-continuity/runtime/memory-vnext-writer.mjs",
    new Set(["open", "rename", "unlink"]),
  ],
  [
    "packages/dubsar-project-continuity/runtime/personal-memory.mjs",
    new Set(["lstat", "mkdir", "open", "readdir", "rename", "rm", "unlink"]),
  ],
  [
    "packages/dubsar-project-continuity/runtime/path-safety.mjs",
    new Set(["lstat", "realpath"]),
  ],
  ["packages/dubsar-project-continuity/runtime/safe-capture.mjs", new Set(["open"])],
  [
    "packages/dubsar-workbench-launcher/src/launcher.mjs",
    new Set(["mkdir", "open", "rename", "unlink"]),
  ],
  [
    "packages/dubsar-workbench-launcher/src/registry-store.mjs",
    new Set(["open", "rename", "unlink"]),
  ],
  [
    "packages/dubsar-operator-core/src/review-ledger.mjs",
    new Set(["lstat", "open", "opendir", "realpath"]),
  ],
]);

const readOnlyOpenPolicies = new Map([
  [
    "packages/dubsar-project-continuity/runtime/safe-capture.mjs",
    { object: null, property: null, identifier: "candidate", calls: 1 },
  ],
  [
    "packages/dubsar-project-continuity/runtime/personal-memory.mjs",
    { object: null, property: null, identifier: "target", calls: 1 },
  ],
  [
    "packages/dubsar-operator-core/src/review-ledger.mjs",
    {
      object: "candidate",
      property: "absolutePath",
      identifier: null,
      calls: 1,
    },
  ],
]);

const exclusiveWriteOpenPolicies = new Map([
  [
    "packages/dubsar-project-continuity/runtime/checkpoint-writer.mjs",
    [
      { identifier: "lockPath", calls: 1 },
      { identifier: "temporary", calls: 1 },
    ],
  ],
  [
    "packages/dubsar-project-continuity/runtime/lite-initializer.mjs",
    [
      { identifier: "lockPath", calls: 1 },
      { identifier: "stagingState", calls: 1 },
      { identifier: "stagingCheckpoints", calls: 1 },
    ],
  ],
  [
    "packages/dubsar-project-continuity/runtime/memory-vnext-initializer.mjs",
    [
      { identifier: "target", calls: 1 },
      { identifier: "lockPath", calls: 1 },
    ],
  ],
  [
    "packages/dubsar-project-continuity/runtime/memory-vnext-bootstrap.mjs",
    [
      { identifier: "target", calls: 1 },
      { identifier: "lockPath", calls: 1 },
    ],
  ],
  [
    "packages/dubsar-project-continuity/runtime/memory-vnext-migration.mjs",
    [
      { identifier: "target", calls: 1 },
      { identifier: "lockPath", calls: 1 },
    ],
  ],
  [
    "packages/dubsar-project-continuity/runtime/memory-vnext-writer.mjs",
    [
      { identifier: "lockPath", calls: 1 },
      { identifier: "temporary", calls: 1 },
    ],
  ],
  [
    "packages/dubsar-project-continuity/runtime/personal-memory.mjs",
    [
      { identifier: "target", calls: 1 },
      { identifier: "lockPath", calls: 1 },
      { identifier: "temporary", calls: 1 },
    ],
  ],
  [
    "packages/dubsar-workbench-launcher/src/launcher.mjs",
    { identifier: "temporary", calls: 1 },
  ],
  [
    "packages/dubsar-workbench-launcher/src/registry-store.mjs",
    { identifier: "temporary", calls: 1 },
  ],
]);

const allowedFilesystemMutationsByFile = new Map([
  [
    "packages/dubsar-project-continuity/runtime/checkpoint-writer.mjs",
    new Set(["rename", "sync", "unlink", "writeFile"]),
  ],
  [
    "packages/dubsar-project-continuity/runtime/lite-initializer.mjs",
    new Set(["mkdir", "rename", "rmdir", "sync", "unlink", "writeFile"]),
  ],
  [
    "packages/dubsar-project-continuity/runtime/memory-vnext-initializer.mjs",
    new Set(["mkdir", "rename", "rmdir", "sync", "unlink", "writeFile"]),
  ],
  [
    "packages/dubsar-project-continuity/runtime/memory-vnext-bootstrap.mjs",
    new Set(["mkdir", "rename", "rmdir", "sync", "unlink", "writeFile"]),
  ],
  [
    "packages/dubsar-project-continuity/runtime/memory-vnext-migration.mjs",
    new Set(["mkdir", "rename", "rmdir", "sync", "unlink", "writeFile"]),
  ],
  [
    "packages/dubsar-project-continuity/runtime/memory-vnext-writer.mjs",
    new Set(["rename", "sync", "unlink", "writeFile"]),
  ],
  [
    "packages/dubsar-project-continuity/runtime/personal-memory.mjs",
    new Set(["mkdir", "rename", "rm", "sync", "unlink", "writeFile"]),
  ],
  [
    "packages/dubsar-workbench-launcher/src/launcher.mjs",
    new Set(["mkdir", "rename", "sync", "unlink", "writeFile"]),
  ],
  [
    "packages/dubsar-workbench-launcher/src/registry-store.mjs",
    new Set(["rename", "sync", "unlink", "writeFile"]),
  ],
]);

const childProcessBindingsByFile = new Map([
  [
    "packages/dubsar-workbench-launcher/src/launcher.mjs",
    new Set(["spawn"]),
  ],
  [
    "packages/dubsar-workbench-launcher/src/folder-picker.mjs",
    new Set(["spawn"]),
  ],
  [
    "packages/dubsar-codex-workbench/skills/resume-dubsar-workbench/scripts/read-capsule.mjs",
    new Set(["spawnSync"]),
  ],
]);

const serverBindingsByFile = new Map([
  [
    "packages/dubsar-workbench-server/src/server.mjs",
    new Map([
      ["node:crypto", new Set(["createHash", "randomBytes", "timingSafeEqual"])],
      ["node:http", new Set(["createServer"])],
    ]),
  ],
]);

const filesystemMutators = [
  "appendFile",
  "appendFileSync",
  "chmod",
  "chmodSync",
  "chown",
  "chownSync",
  "copyFile",
  "copyFileSync",
  "cp",
  "cpSync",
  "createWriteStream",
  "datasync",
  "fdatasyncSync",
  "fchmod",
  "fchmodSync",
  "fchown",
  "fchownSync",
  "fsync",
  "fsyncSync",
  "ftruncate",
  "ftruncateSync",
  "link",
  "linkSync",
  "lchmod",
  "lchmodSync",
  "lchown",
  "lchownSync",
  "lutimes",
  "lutimesSync",
  "mkdir",
  "mkdirSync",
  "mkdtemp",
  "mkdtempSync",
  "openSync",
  "rename",
  "renameSync",
  "rm",
  "rmSync",
  "rmdir",
  "rmdirSync",
  "symlink",
  "symlinkSync",
  "sync",
  "truncate",
  "truncateSync",
  "unlink",
  "unlinkSync",
  "utimes",
  "utimesSync",
  "write",
  "writeFile",
  "writeFileSync",
  "writeSync",
  "writev",
  "writevSync",
];

const filesystemMutatorSet = new Set(filesystemMutators);
const processExecutionNames = new Set([
  "exec",
  "execFile",
  "execFileSync",
  "execSync",
  "fork",
  "spawn",
  "spawnSync",
]);
const networkCallNames = new Set([
  "EventSource",
  "WebSocket",
  "XMLHttpRequest",
  "fetch",
]);
const networkModuleNames = new Set(["dgram", "http", "https", "net", "tls"]);
const networkMethodNames = new Set([
  "connect",
  "createConnection",
  "createServer",
  "get",
  "listen",
  "request",
  "sendBeacon",
]);
const serverOutboundMemberNames = new Set([
  "connect",
  "createConnection",
  "get",
  "request",
  "sendBeacon",
]);
const allowedProcessProperties = new Set([
  "argv",
  "cwd",
  "exitCode",
  "platform",
  "stderr",
  "stdout",
  "version",
  "versions",
]);
const allowedProcessPropertiesByFile = new Map([
  [
    "packages/dubsar-operator-cli/bin/dubsar.mjs",
    new Set(["once", "removeListener"]),
  ],
  [
    "packages/dubsar-operator-cli/src/cli.mjs",
    new Set(["stdin"]),
  ],
  [
    "packages/dubsar-project-continuity/runtime/cli.mjs",
    new Set(["stdin"]),
  ],
  [
    "packages/dubsar-project-continuity/runtime/personal-memory.mjs",
    new Set(["env"]),
  ],
  [
    "packages/dubsar-workbench-launcher/bin/dubsar-workbench-open.mjs",
    new Set(["stdin"]),
  ],
  [
    "packages/dubsar-workbench-launcher/src/launcher.mjs",
    new Set(["env"]),
  ],
  [
    "packages/dubsar-codex-workbench/skills/resume-dubsar-workbench/scripts/read-capsule.mjs",
    new Set(["env", "execPath"]),
  ],
]);
const allowedEnvironmentPropertiesByFile = new Map([
  ["packages/dubsar-project-continuity/runtime/personal-memory.mjs", new Set(["LOCALAPPDATA"])],
  [
    "packages/dubsar-workbench-launcher/src/launcher.mjs",
    new Set(["LOCALAPPDATA", "ProgramFiles", "ProgramFiles(x86)", "SystemRoot"]),
  ],
  [
    "packages/dubsar-codex-workbench/skills/resume-dubsar-workbench/scripts/read-capsule.mjs",
    new Set(["LOCALAPPDATA"]),
  ],
]);
const allowedDynamicImportsByFile = new Map([
  [
    "packages/dubsar-project-continuity/runtime/cli.mjs",
    new Set(["./memory-session.mjs"]),
  ],
  [
    "packages/dubsar-project-continuity/runtime/close-session.mjs",
    new Set(["./personal-memory.mjs"]),
  ],
]);
const allowedImportMetaFiles = new Set([
  "packages/dubsar-workbench-launcher/src/folder-picker.mjs",
  "packages/dubsar-codex-workbench/skills/resume-dubsar-workbench/scripts/read-capsule.mjs",
]);
const dynamicGlobalNames = new Set([
  "Function",
  "Proxy",
  "Reflect",
  "WebAssembly",
  "eval",
  "global",
  "globalThis",
  "require",
]);
const allowedObjectMethods = new Set([
  "entries",
  "freeze",
  "fromEntries",
  "hasOwn",
  "keys",
  "values",
]);
const dangerousPropertyNames = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);
const reflectiveMethodNames = new Set([
  "defineProperties",
  "defineProperty",
  "getOwnPropertyDescriptor",
  "getOwnPropertyDescriptors",
  "getPrototypeOf",
  "setPrototypeOf",
]);
const loaderPropertyNames = new Set([
  "_linkedBinding",
  "binding",
  "getBuiltinModule",
]);

function portable(relative) {
  return relative.replaceAll("\\", "/");
}

function compareText(left, right) {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

function absoluteKey(absolute) {
  const resolved = path.resolve(absolute);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function addFinding(findings, code, relativePath, detail) {
  findings.push({
    code,
    path: portable(relativePath),
    ...(detail === undefined ? {} : { detail }),
  });
}

async function collectCodeFiles(repositoryRoot, policy, findings, collection) {
  if (collection.exhausted) return [];
  const root = path.join(repositoryRoot, policy.root);
  let rootInfo;
  try {
    rootInfo = await lstat(root);
  } catch {
    addFinding(findings, "RUNTIME_ROOT_MISSING", policy.root);
    return [];
  }
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    addFinding(findings, "RUNTIME_SYMBOLIC_PATH_FORBIDDEN", policy.root);
    return [];
  }

  const result = [];
  const pending = [{ absolute: root, depth: 0 }];
  while (pending.length > 0) {
    const { absolute: current, depth } = pending.pop();
    const entries = [];
    for await (const entry of await opendir(current)) {
      collection.entries += 1;
      if (collection.entries > MAX_RUNTIME_ENTRIES) {
        addFinding(findings, "RUNTIME_ENTRY_LIMIT_EXCEEDED", policy.root);
        collection.exhausted = true;
        return result;
      }
      entries.push(entry);
    }
    entries.sort((left, right) => compareText(left.name, right.name));
    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      const relative = portable(path.relative(repositoryRoot, absolute));
      let sourceInfo;
      try {
        sourceInfo = await lstat(absolute);
      } catch {
        addFinding(findings, "RUNTIME_SOURCE_FILE_INVALID", relative);
        continue;
      }
      if (sourceInfo.isSymbolicLink()) {
        addFinding(findings, "RUNTIME_SYMBOLIC_PATH_FORBIDDEN", relative);
      } else if (sourceInfo.isDirectory()) {
        if (depth + 1 > MAX_RUNTIME_DEPTH) {
          addFinding(findings, "RUNTIME_DEPTH_LIMIT_EXCEEDED", relative);
        } else {
          pending.push({ absolute, depth: depth + 1 });
        }
      } else if (sourceInfo.isFile() && entry.name.endsWith(".mjs")) {
        if (sourceInfo.size > MAX_RUNTIME_FILE_BYTES) {
          addFinding(findings, "RUNTIME_SOURCE_SIZE_LIMIT_EXCEEDED", relative);
          continue;
        }
        collection.files += 1;
        collection.bytes += sourceInfo.size;
        if (collection.files > MAX_RUNTIME_FILES) {
          addFinding(findings, "RUNTIME_FILE_COUNT_LIMIT_EXCEEDED", policy.root);
          collection.exhausted = true;
          return result;
        }
        if (collection.bytes > MAX_RUNTIME_TOTAL_BYTES) {
          addFinding(findings, "RUNTIME_TOTAL_SIZE_LIMIT_EXCEEDED", policy.root);
          collection.exhausted = true;
          return result;
        }
        result.push({ absolute, relative, policy });
      }
    }
  }
  return result.sort((left, right) => compareText(left.relative, right.relative));
}

async function readBoundedBytes(absolute, limit) {
  let handle;
  try {
    handle = await open(absolute, "r");
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size > BigInt(limit)) return null;
    const bytes = Buffer.alloc(limit + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (
      offset > limit ||
      after.size !== BigInt(offset) ||
      after.size !== before.size ||
      after.mtimeNs !== before.mtimeNs
    ) return null;
    return bytes.subarray(0, offset);
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
}

async function readRuntimeSource(file, findings) {
  const bytes = await readBoundedBytes(file.absolute, MAX_RUNTIME_FILE_BYTES);
  if (bytes === null) {
    addFinding(findings, "RUNTIME_SOURCE_SIZE_LIMIT_EXCEEDED", file.relative);
    return null;
  }
  return { source: bytes.toString("utf8"), bytesRead: bytes.length };
}

async function inspectPowerShellAssets(repositoryRoot, findings) {
  const scriptsRoot = path.join(
    repositoryRoot,
    "packages",
    "dubsar-workbench-launcher",
    "scripts",
  );
  const entries = [];
  for await (const entry of await opendir(scriptsRoot)) {
    if (entries.length >= MAX_POWERSHELL_ENTRIES) {
      addFinding(findings, "RUNTIME_POWERSHELL_ENTRY_LIMIT_EXCEEDED", portable(
        path.relative(repositoryRoot, scriptsRoot),
      ));
      return;
    }
    entries.push(entry);
  }
  entries.sort((left, right) => compareText(left.name, right.name));
  const observed = new Set();
  for (const entry of entries) {
    if (!entry.name.endsWith(".ps1")) continue;
    const absolute = path.join(scriptsRoot, entry.name);
    const relative = portable(path.relative(repositoryRoot, absolute));
    observed.add(relative);
    const expectedDigest = powershellAssetDigests.get(relative);
    const info = await lstat(absolute);
    if (!entry.isFile() || entry.isSymbolicLink() || !info.isFile() || info.isSymbolicLink() || info.nlink > 1) {
      addFinding(findings, "RUNTIME_POWERSHELL_ASSET_INVALID", relative);
      continue;
    }
    if (!expectedDigest) {
      addFinding(findings, "RUNTIME_POWERSHELL_ASSET_UNCLASSIFIED", relative);
      continue;
    }
    if (info.size > MAX_POWERSHELL_ASSET_BYTES) {
      addFinding(findings, "RUNTIME_POWERSHELL_ASSET_SIZE_LIMIT_EXCEEDED", relative);
      continue;
    }
    const bytes = await readBoundedBytes(absolute, MAX_POWERSHELL_ASSET_BYTES);
    if (bytes === null) {
      addFinding(findings, "RUNTIME_POWERSHELL_ASSET_SIZE_LIMIT_EXCEEDED", relative);
      continue;
    }
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== expectedDigest) {
      addFinding(findings, "RUNTIME_POWERSHELL_ASSET_DIGEST_MISMATCH", relative);
    }
  }
  for (const relative of powershellAssetDigests.keys()) {
    if (!observed.has(relative)) {
      addFinding(findings, "RUNTIME_POWERSHELL_ASSET_MISSING", relative);
    }
  }
}

function parseModule(source, file, findings) {
  try {
    return parse(source, {
      allowHashBang: true,
      ecmaVersion: "latest",
      locations: true,
      sourceType: "module",
    });
  } catch (error) {
    addFinding(
      findings,
      "RUNTIME_SOURCE_PARSE_FAILED",
      file.relative,
      typeof error?.message === "string" ? error.message : undefined,
    );
    return null;
  }
}

function staticImports(ast) {
  return ast.body
    .filter(
      (node) =>
        node.type === "ImportDeclaration" ||
        ((node.type === "ExportNamedDeclaration" ||
          node.type === "ExportAllDeclaration") &&
          node.source),
    )
    .map((node) => node.source?.value)
    .filter((value) => typeof value === "string");
}

function walk(node, visitor, parent = null) {
  if (!node || typeof node !== "object" || typeof node.type !== "string") {
    return;
  }
  visitor(node, parent);
  for (const [key, value] of Object.entries(node)) {
    if (key === "type" || key === "start" || key === "end") {
      continue;
    }
    if (Array.isArray(value)) {
      for (const child of value) {
        walk(child, visitor, node);
      }
    } else {
      walk(value, visitor, node);
    }
  }
}

function staticString(node) {
  if (
    node?.type === "Literal" &&
    new Set(["number", "string"]).has(typeof node.value)
  ) {
    return String(node.value);
  }
  if (
    node?.type === "TemplateLiteral" &&
    node.expressions.length === 0 &&
    node.quasis.length === 1
  ) {
    return node.quasis[0].value.cooked;
  }
  if (node?.type === "BinaryExpression" && node.operator === "+") {
    const left = staticString(node.left);
    const right = staticString(node.right);
    return typeof left === "string" && typeof right === "string"
      ? `${left}${right}`
      : null;
  }
  return null;
}

function memberName(node) {
  if (node?.type !== "MemberExpression") {
    return null;
  }
  if (!node.computed && node.property.type === "Identifier") {
    return node.property.name;
  }
  return staticString(node.property);
}

function propertyKeyName(node) {
  if (node?.type !== "Property") {
    return null;
  }
  if (!node.computed && node.key.type === "Identifier") {
    return node.key.name;
  }
  return staticString(node.key);
}

function rootIdentifier(node) {
  let current = node;
  while (current?.type === "MemberExpression") {
    current = current.object;
  }
  return current?.type === "Identifier" ? current.name : null;
}

function isProcessOutputWrite(node) {
  if (node?.type !== "MemberExpression" || memberName(node) !== "write") {
    return false;
  }
  const output = node.object;
  return (
    output?.type === "MemberExpression" &&
    rootIdentifier(output) === "process" &&
    new Set(["stderr", "stdout"]).has(memberName(output))
  );
}

function inspectFilesystemBindings(ast, file, findings) {
  const declarations = ast.body.filter(
    (node) =>
      node.type === "ImportDeclaration" &&
      node.source.value === "node:fs/promises",
  );
  const expected = fsBindingsByFile.get(file.relative);
  if (!expected) {
    if (declarations.length > 0) {
      addFinding(
        findings,
        "RUNTIME_FILESYSTEM_IMPORT_FORBIDDEN",
        file.relative,
      );
    }
    return;
  }
  if (declarations.length !== 1) {
    addFinding(findings, "RUNTIME_FILESYSTEM_BINDINGS_INVALID", file.relative);
    return;
  }
  const declaration = declarations[0];
  const bindings = declaration.specifiers.map((specifier) => ({
    imported:
      specifier.type === "ImportSpecifier"
        ? specifier.imported.name ?? specifier.imported.value
        : null,
    local: specifier.local?.name ?? null,
    type: specifier.type,
  }));
  if (
    bindings.length !== expected.size ||
    bindings.some(
      (binding) =>
        binding.type !== "ImportSpecifier" ||
        binding.imported !== binding.local ||
        !expected.has(binding.imported),
    ) ||
    (declaration.attributes?.length ?? declaration.assertions?.length ?? 0) > 0
  ) {
    addFinding(findings, "RUNTIME_FILESYSTEM_BINDINGS_INVALID", file.relative);
  }
  if (
    bindings.some(
      (binding) =>
        filesystemMutatorSet.has(binding.imported) ||
        filesystemMutatorSet.has(binding.local),
    ) && !allowedFilesystemMutationsByFile.has(file.relative)
  ) {
    addFinding(findings, "RUNTIME_FILESYSTEM_WRITE_FORBIDDEN", file.relative);
  }
}

function inspectOpenBinding(ast, file, findings) {
  const readPolicy = readOnlyOpenPolicies.get(file.relative);
  const rawWritePolicy = exclusiveWriteOpenPolicies.get(file.relative);
  const writePolicies = rawWritePolicy === undefined
    ? []
    : Array.isArray(rawWritePolicy)
      ? rawWritePolicy
      : [rawWritePolicy];
  if (!readPolicy && writePolicies.length === 0) {
    return;
  }
  let validReadCallCount = 0;
  const validWriteCallCounts = new Map(
    writePolicies.map((policy) => [policy.identifier, 0]),
  );
  let invalidReference = false;
  walk(ast, (node, parent) => {
    if (node.type !== "Identifier" || node.name !== "open") {
      return;
    }
    if (parent?.type === "ImportSpecifier") {
      return;
    }
    if (
      parent?.type === "CallExpression" &&
      parent.callee === node &&
      !parent.optional &&
      readPolicy &&
      parent.arguments.length === 2 &&
      ((readPolicy.identifier !== null &&
        parent.arguments[0]?.type === "Identifier" &&
        parent.arguments[0].name === readPolicy.identifier) ||
        (readPolicy.object !== null &&
          parent.arguments[0]?.type === "MemberExpression" &&
          !parent.arguments[0].computed &&
          parent.arguments[0].object?.type === "Identifier" &&
          parent.arguments[0].object.name === readPolicy.object &&
          memberName(parent.arguments[0]) === readPolicy.property)) &&
      staticString(parent.arguments[1]) === "r"
    ) {
      validReadCallCount += 1;
      return;
    }
    const matchingWritePolicy = writePolicies.find((policy) =>
      parent?.type === "CallExpression" &&
      parent.callee === node &&
      !parent.optional &&
      parent.arguments.length === 3 &&
      parent.arguments[0]?.type === "Identifier" &&
      parent.arguments[0].name === policy.identifier &&
      staticString(parent.arguments[1]) === "wx" &&
      parent.arguments[2]?.type === "Literal" &&
      parent.arguments[2].value === 0o600
    );
    if (matchingWritePolicy) {
      validWriteCallCounts.set(
        matchingWritePolicy.identifier,
        validWriteCallCounts.get(matchingWritePolicy.identifier) + 1,
      );
      return;
    }
    invalidReference = true;
  });
  const invalidReadCount = readPolicy && validReadCallCount !== readPolicy.calls;
  const invalidWriteCount = writePolicies.some(
    (policy) => validWriteCallCounts.get(policy.identifier) !== policy.calls,
  );
  if (invalidReadCount || invalidWriteCount || invalidReference) {
    addFinding(findings, "RUNTIME_FILE_OPEN_MODE_INVALID", file.relative);
  }
}

function inspectCheckpointMutationGraph(ast, file, findings) {
  if (file.relative !== "packages/dubsar-project-continuity/runtime/checkpoint-writer.mjs") {
    return;
  }
  const counts = new Map([
    ["rename", 0],
    ["unlink-lock", 0],
    ["unlink-temporary", 0],
    ["write", 0],
    ["sync", 0],
  ]);
  let invalid = false;
  walk(ast, (node) => {
    if (node.type !== "CallExpression" || node.optional) return;
    if (node.callee?.type === "Identifier" && node.callee.name === "rename") {
      const valid =
        node.arguments.length === 2 &&
        node.arguments[0]?.type === "Identifier" &&
        node.arguments[0].name === "temporary" &&
        node.arguments[1]?.type === "Identifier" &&
        node.arguments[1].name === "target";
      if (valid) counts.set("rename", counts.get("rename") + 1);
      else invalid = true;
      return;
    }
    if (node.callee?.type === "Identifier" && node.callee.name === "unlink") {
      const argument = node.arguments.length === 1 && node.arguments[0]?.type === "Identifier"
        ? node.arguments[0].name
        : null;
      if (argument === "temporary") {
        counts.set("unlink-temporary", counts.get("unlink-temporary") + 1);
      } else if (argument === "lockPath") {
        counts.set("unlink-lock", counts.get("unlink-lock") + 1);
      } else {
        invalid = true;
      }
      return;
    }
    if (node.callee?.type !== "MemberExpression" || node.callee.computed) return;
    const object = node.callee.object;
    const property = memberName(node.callee);
    if (object?.type === "Identifier" && object.name === "handle" && property === "writeFile") {
      const argument = node.arguments[0];
      const valid =
        node.arguments.length === 1 &&
        argument?.type === "MemberExpression" &&
        !argument.computed &&
        argument.object?.type === "Identifier" &&
        argument.object.name === "change" &&
        memberName(argument) === "afterBytes";
      if (valid) counts.set("write", counts.get("write") + 1);
      else invalid = true;
      return;
    }
    if (object?.type === "Identifier" && object.name === "handle" && property === "sync") {
      if (node.arguments.length === 0) counts.set("sync", counts.get("sync") + 1);
      else invalid = true;
    }
  });
  if (invalid || [...counts.values()].some((count) => count !== 1)) {
    addFinding(findings, "RUNTIME_CHECKPOINT_MUTATION_GRAPH_INVALID", file.relative);
  }
}

function inspectLiteInitializerMutationGraph(ast, file, findings) {
  if (file.relative !== "packages/dubsar-project-continuity/runtime/lite-initializer.mjs") return;
  const counts = new Map([
    ["mkdir", 0], ["rename", 0], ["rmdir", 0],
    ["unlink-state", 0], ["unlink-checkpoints", 0], ["unlink-lock", 0],
    ["write-state", 0], ["write-checkpoints", 0], ["sync-state", 0], ["sync-checkpoints", 0],
  ]);
  let invalid = false;
  walk(ast, (node) => {
    if (node.type !== "CallExpression" || node.optional) return;
    if (node.callee?.type === "Identifier" && node.callee.name === "mkdir") {
      if (identifierNamed(node.arguments[0], "staging")) counts.set("mkdir", counts.get("mkdir") + 1);
      else invalid = true;
      return;
    }
    if (node.callee?.type === "Identifier" && node.callee.name === "rename") {
      if (
        identifierNamed(node.arguments[0], "staging") &&
        memberOf(node.arguments[1], "change", "marker")
      ) counts.set("rename", counts.get("rename") + 1);
      else invalid = true;
      return;
    }
    if (node.callee?.type === "Identifier" && node.callee.name === "rmdir") {
      if (identifierNamed(node.arguments[0], "staging")) counts.set("rmdir", counts.get("rmdir") + 1);
      else invalid = true;
      return;
    }
    if (node.callee?.type === "Identifier" && node.callee.name === "unlink") {
      const name = node.arguments[0]?.type === "Identifier" ? node.arguments[0].name : null;
      const key = name === "stagingState" ? "unlink-state"
        : name === "stagingCheckpoints" ? "unlink-checkpoints"
          : name === "lockPath" ? "unlink-lock" : null;
      if (key) counts.set(key, counts.get(key) + 1);
      else invalid = true;
      return;
    }
    if (node.callee?.type !== "MemberExpression" || node.callee.computed) return;
    const object = node.callee.object;
    const property = memberName(node.callee);
    if (object?.type !== "Identifier") return;
    const handleKey = object.name === "stateHandle" ? "state"
      : object.name === "checkpointsHandle" ? "checkpoints" : null;
    if (!handleKey) return;
    if (property === "writeFile") {
      const expected = handleKey === "state" ? "stateBytes" : "checkpointsBytes";
      if (node.arguments.length === 1 && memberOf(node.arguments[0], "change", expected)) {
        counts.set(`write-${handleKey}`, counts.get(`write-${handleKey}`) + 1);
      } else invalid = true;
    } else if (property === "sync") {
      if (node.arguments.length === 0) counts.set(`sync-${handleKey}`, counts.get(`sync-${handleKey}`) + 1);
      else invalid = true;
    }
  });
  if (invalid || [...counts.values()].some((count) => count !== 1)) {
    addFinding(findings, "RUNTIME_LITE_INITIALIZER_MUTATION_GRAPH_INVALID", file.relative);
  }
}

function pathJoinStartsWith(node, identifier) {
  return node?.type === "CallExpression" &&
    node.callee?.type === "MemberExpression" &&
    identifierNamed(node.callee.object, "path") &&
    memberName(node.callee) === "join" &&
    identifierNamed(node.arguments[0], identifier);
}

function inspectMemoryVnextMutationGraph(ast, file, findings) {
  const writer = "packages/dubsar-project-continuity/runtime/memory-vnext-writer.mjs";
  const initializer = "packages/dubsar-project-continuity/runtime/memory-vnext-initializer.mjs";
  const bootstrap = "packages/dubsar-project-continuity/runtime/memory-vnext-bootstrap.mjs";
  const migration = "packages/dubsar-project-continuity/runtime/memory-vnext-migration.mjs";
  if (!new Set([writer, initializer, bootstrap, migration]).has(file.relative)) return;
  const stagingMode = file.relative !== writer;
  const expected = stagingMode
    ? { mkdir: 2, rename: 1, rmdir: 2, unlink: 2, writeFile: 1, sync: 1 }
    : { mkdir: 0, rename: 1, rmdir: 0, unlink: 2, writeFile: 1, sync: 1 };
  const counts = new Map(Object.keys(expected).map((key) => [key, 0]));
  let invalid = false;
  walk(ast, (node) => {
    if (node.type !== "CallExpression" || node.optional) return;
    const calleeName = node.callee?.type === "Identifier" ? node.callee.name : memberName(node.callee);
    if (!counts.has(calleeName)) return;
    counts.set(calleeName, counts.get(calleeName) + 1);
    if (calleeName === "rename") {
      const valid = node.arguments.length === 2 && (
        stagingMode
          ? identifierNamed(node.arguments[0], "staging") && memberOf(node.arguments[1], "change", "marker")
          : identifierNamed(node.arguments[0], "temporary") && identifierNamed(node.arguments[1], "target")
      );
      if (!valid) invalid = true;
    } else if (calleeName === "unlink") {
      const argument = node.arguments[0];
      const valid = stagingMode
        ? identifierNamed(argument, "lockPath") || pathJoinStartsWith(argument, "staging")
        : identifierNamed(argument, "lockPath") || identifierNamed(argument, "temporary");
      if (node.arguments.length !== 1 || !valid) invalid = true;
    } else if (calleeName === "mkdir" || calleeName === "rmdir") {
      const valid = stagingMode && node.arguments.length >= 1 &&
        (identifierNamed(node.arguments[0], "staging") || pathJoinStartsWith(node.arguments[0], "staging"));
      if (!valid) invalid = true;
    } else if (calleeName === "writeFile" || calleeName === "sync") {
      const object = node.callee?.type === "MemberExpression" ? node.callee.object : null;
      if (!identifierNamed(object, "handle") ||
        (calleeName === "sync" && node.arguments.length !== 0) ||
        (calleeName === "writeFile" && node.arguments.length !== 1)) invalid = true;
    }
  });
  if (invalid || Object.entries(expected).some(([key, count]) => counts.get(key) !== count)) {
    addFinding(findings, "RUNTIME_MEMORY_VNEXT_MUTATION_GRAPH_INVALID", file.relative);
  }
}

function exactBooleanObject(node, expected) {
  const entries = objectLiteralEntries(node);
  if (entries?.size !== Object.keys(expected).length) return false;
  return Object.entries(expected).every(([key, value]) => {
    const observed = entries.get(key);
    return observed?.type === "Literal" && observed.value === value;
  });
}

function identifierNamed(node, name) {
  return node?.type === "Identifier" && node.name === name;
}

function memberOf(node, objectName, propertyName) {
  return (
    node?.type === "MemberExpression" &&
    identifierNamed(node.object, objectName) &&
    memberName(node) === propertyName
  );
}

function inspectPersonalMemoryMutationGraph(ast, file, findings) {
  if (file.relative !== "packages/dubsar-project-continuity/runtime/personal-memory.mjs") return;
  const counts = new Map([
    ["mkdir-parent", 0],
    ["mkdir-staging", 0],
    ["rename-root", 0],
    ["rename-target", 0],
    ["rm-staging", 0],
    ["unlink-lock", 0],
    ["unlink-temporary", 0],
    ["handle-sync", 0],
    ["handle-write", 0],
    ["temporary-sync", 0],
    ["temporary-write", 0],
    ["write-exclusive", 0],
  ]);
  let invalid = false;
  let writeExclusiveReferences = 0;
  const increment = (key) => counts.set(key, counts.get(key) + 1);
  walk(ast, (node) => {
    if (identifierNamed(node, "writeExclusiveFile")) {
      writeExclusiveReferences += 1;
    }
    if (node.type !== "CallExpression" || node.optional) return;
    const direct = node.callee?.type === "Identifier" ? node.callee.name : null;
    if (direct === "mkdir") {
      const mode = objectLiteralEntries(node.arguments[1])?.get("mode");
      const validMode =
        node.arguments.length === 2 &&
        mode?.type === "Literal" &&
        mode.value === 0o700 &&
        objectLiteralEntries(node.arguments[1])?.size === 1;
      if (validMode && identifierNamed(node.arguments[0], "staging")) {
        increment("mkdir-staging");
      } else if (validMode && memberOf(node.arguments[0], "paths", "parent")) {
        increment("mkdir-parent");
      } else invalid = true;
      return;
    }
    if (direct === "rm") {
      if (
        node.arguments.length === 2 &&
        identifierNamed(node.arguments[0], "staging") &&
        exactBooleanObject(node.arguments[1], { force: true, recursive: true })
      ) increment("rm-staging");
      else invalid = true;
      return;
    }
    if (direct === "rename") {
      if (
        node.arguments.length === 2 &&
        identifierNamed(node.arguments[0], "staging") &&
        memberOf(node.arguments[1], "paths", "root")
      ) increment("rename-root");
      else if (
        node.arguments.length === 2 &&
        identifierNamed(node.arguments[0], "temporary") &&
        identifierNamed(node.arguments[1], "target")
      ) increment("rename-target");
      else invalid = true;
      return;
    }
    if (direct === "unlink") {
      if (node.arguments.length === 1 && identifierNamed(node.arguments[0], "temporary")) {
        increment("unlink-temporary");
      } else if (node.arguments.length === 1 && identifierNamed(node.arguments[0], "lockPath")) {
        increment("unlink-lock");
      } else invalid = true;
      return;
    }
    if (direct === "writeExclusiveFile") {
      const target = node.arguments[0];
      const bytes = node.arguments[1];
      const validTarget =
        target?.type === "CallExpression" &&
        memberOf(target.callee, "path", "join") &&
        target.arguments.length === 2 &&
        identifierNamed(target.arguments[0], "staging") &&
        identifierNamed(target.arguments[1], "file");
      const validBytes =
        bytes?.type === "CallExpression" &&
        memberOf(bytes.callee, "Buffer", "from") &&
        bytes.arguments.length === 2 &&
        bytes.arguments[0]?.type === "CallExpression" &&
        identifierNamed(bytes.arguments[0].callee, "initialContent") &&
        bytes.arguments[0].arguments.length === 1 &&
        identifierNamed(bytes.arguments[0].arguments[0], "file") &&
        staticString(bytes.arguments[1]) === "utf8";
      if (node.arguments.length === 2 && validTarget && validBytes) increment("write-exclusive");
      else invalid = true;
      return;
    }
    if (node.callee?.type !== "MemberExpression") return;
    const property = memberName(node.callee);
    if (memberOf(node.callee, "handle", "writeFile")) {
      if (node.arguments.length === 1 && identifierNamed(node.arguments[0], "bytes")) {
        increment("handle-write");
      } else invalid = true;
    } else if (memberOf(node.callee, "handle", "sync")) {
      if (node.arguments.length === 0) increment("handle-sync");
      else invalid = true;
    } else if (memberOf(node.callee, "temporaryHandle", "writeFile")) {
      if (node.arguments.length === 1 && identifierNamed(node.arguments[0], "afterBytes")) {
        increment("temporary-write");
      } else invalid = true;
    } else if (memberOf(node.callee, "temporaryHandle", "sync")) {
      if (node.arguments.length === 0) increment("temporary-sync");
      else invalid = true;
    } else if (
      new Set(["mkdir", "rename", "rm", "sync", "unlink", "writeFile"]).has(property)
    ) {
      invalid = true;
    }
  });
  const expected = new Map([
    ["mkdir-parent", 1],
    ["mkdir-staging", 1],
    ["rename-root", 1],
    ["rename-target", 1],
    ["rm-staging", 2],
    ["unlink-lock", 1],
    ["unlink-temporary", 1],
    ["handle-sync", 1],
    ["handle-write", 1],
    ["temporary-sync", 1],
    ["temporary-write", 1],
    ["write-exclusive", 1],
  ]);
  if (
    invalid ||
    writeExclusiveReferences !== 2 ||
    [...expected].some(([key, value]) => counts.get(key) !== value)
  ) {
    addFinding(findings, "RUNTIME_PERSONAL_MEMORY_MUTATION_GRAPH_INVALID", file.relative);
  }
}

function inspectChildProcessBindings(ast, file, findings) {
  const expected = childProcessBindingsByFile.get(file.relative);
  const declarations = ast.body.filter(
    (node) =>
      node.type === "ImportDeclaration" &&
      node.source.value === "node:child_process",
  );
  if (!expected) {
    if (declarations.length > 0) {
      addFinding(findings, "RUNTIME_PROCESS_BINDINGS_INVALID", file.relative);
    }
    return;
  }
  if (declarations.length !== 1) {
    addFinding(findings, "RUNTIME_PROCESS_BINDINGS_INVALID", file.relative);
    return;
  }
  const declaration = declarations[0];
  const bindings = declaration.specifiers.map(importedBinding);
  if (
    bindings.length !== expected.size ||
    bindings.some(
      (binding) =>
        binding.type !== "ImportSpecifier" ||
        binding.imported !== binding.local ||
        !expected.has(binding.imported),
    ) ||
    (declaration.attributes?.length ?? declaration.assertions?.length ?? 0) > 0
  ) {
    addFinding(findings, "RUNTIME_PROCESS_BINDINGS_INVALID", file.relative);
  }
}

function importedBinding(specifier) {
  return {
    imported:
      specifier.type === "ImportSpecifier"
        ? specifier.imported.name ?? specifier.imported.value
        : null,
    local: specifier.local?.name ?? null,
    type: specifier.type,
  };
}

function objectLiteralEntries(node) {
  if (node?.type !== "ObjectExpression") {
    return null;
  }
  const entries = new Map();
  for (const property of node.properties) {
    const key = propertyKeyName(property);
    if (
      property.type !== "Property" ||
      property.kind !== "init" ||
      property.method ||
      property.computed ||
      property.shorthand ||
      key === null ||
      entries.has(key)
    ) {
      return null;
    }
    entries.set(key, property.value);
  }
  return entries;
}

function inspectServerBindings(ast, file, findings) {
  if (file.policy.key !== "server") {
    return;
  }
  const expectedModules = serverBindingsByFile.get(file.relative) ?? new Map();
  const nodeDeclarations = ast.body.filter(
    (node) =>
      (node.type === "ImportDeclaration" ||
        node.type === "ExportNamedDeclaration" ||
        node.type === "ExportAllDeclaration") &&
      node.source &&
      new Set(["node:crypto", "node:http"]).has(node.source.value),
  );
  const declarations = nodeDeclarations.filter(
    (node) => node.type === "ImportDeclaration",
  );
  const actualModules = new Map();
  let bindingsInvalid =
    declarations.length !== expectedModules.size ||
    declarations.length !== nodeDeclarations.length;
  for (const declaration of declarations) {
    const module = declaration.source.value;
    if (actualModules.has(module)) {
      bindingsInvalid = true;
      continue;
    }
    const bindings = declaration.specifiers.map(importedBinding);
    actualModules.set(module, bindings);
    const expected = expectedModules.get(module);
    if (
      !expected ||
      bindings.length !== expected.size ||
      bindings.some(
        (binding) =>
          binding.type !== "ImportSpecifier" ||
          binding.imported !== binding.local ||
          !expected.has(binding.imported),
      ) ||
      (declaration.attributes?.length ?? declaration.assertions?.length ?? 0) > 0
    ) {
      bindingsInvalid = true;
    }
  }
  if (bindingsInvalid) {
    addFinding(findings, "RUNTIME_SERVER_BINDINGS_INVALID", file.relative);
  }
  if (file.relative !== "packages/dubsar-workbench-server/src/server.mjs") {
    return;
  }

  const validCalls = new Map([
    ["createHash", 0],
    ["createServer", 0],
    ["randomBytes", 0],
    ["timingSafeEqual", 0],
  ]);
  let invalidBindingReference = false;
  let validListenCount = 0;
  let invalidListen = false;
  walk(ast, (node, parent) => {
    if (
      node.type === "Identifier" &&
      validCalls.has(node.name) &&
      parent?.type !== "ImportSpecifier"
    ) {
      const createOptions = objectLiteralEntries(parent?.arguments?.at(0));
      const checkingInterval = createOptions?.get(
        "connectionsCheckingInterval",
      );
      const maxHeaderSize = createOptions?.get("maxHeaderSize");
      const validCreateServer =
        node.name !== "createServer" ||
        (parent?.arguments?.length === 2 &&
          createOptions?.size === 3 &&
          checkingInterval?.type === "MemberExpression" &&
          !checkingInterval.computed &&
          checkingInterval.object?.type === "Identifier" &&
          checkingInterval.object.name === "limits" &&
          memberName(checkingInterval) === "connectionsCheckingIntervalMs" &&
          createOptions.get("insecureHTTPParser")?.type === "Literal" &&
          createOptions.get("insecureHTTPParser").value === false &&
          maxHeaderSize?.type === "MemberExpression" &&
          !maxHeaderSize.computed &&
          maxHeaderSize.object?.type === "Identifier" &&
          maxHeaderSize.object.name === "limits" &&
          memberName(maxHeaderSize) === "headerBytes" &&
          parent.arguments.at(1)?.type === "Identifier" &&
          parent.arguments.at(1).name === "handleRequest");
      const validCreateHash =
        node.name !== "createHash" ||
        (parent?.arguments?.length === 1 &&
          staticString(parent.arguments.at(0)) === "sha256");
      if (
        parent?.type === "CallExpression" &&
        parent.callee === node &&
        !parent.optional &&
        validCreateServer &&
        validCreateHash &&
        (node.name !== "randomBytes" ||
          (parent.arguments.length === 1 &&
            staticString(parent.arguments.at(0)) === "32"))
      ) {
        validCalls.set(node.name, validCalls.get(node.name) + 1);
      } else {
        invalidBindingReference = true;
      }
    }
    if (
      node.type === "MemberExpression" &&
      serverOutboundMemberNames.has(memberName(node))
    ) {
      addFinding(
        findings,
        "RUNTIME_SERVER_OUTBOUND_FORBIDDEN",
        file.relative,
        memberName(node),
      );
    }
    if (node.type === "MemberExpression" && memberName(node) === "listen") {
      const call =
        parent?.type === "CallExpression" && parent.callee === node
          ? parent
          : null;
      const options = objectLiteralEntries(call?.arguments.at(0));
      const callback = call?.arguments.at(1);
      const valid =
        call !== null &&
        node.object?.type === "Identifier" &&
        node.object.name === "server" &&
        !node.computed &&
        call.arguments.length === 2 &&
        options?.size === 3 &&
        staticString(options.get("host")) === "127.0.0.1" &&
        staticString(options.get("port")) === "0" &&
        options.get("exclusive")?.type === "Literal" &&
        options.get("exclusive").value === true &&
        callback?.type === "ArrowFunctionExpression";
      if (valid) {
        validListenCount += 1;
      } else {
        invalidListen = true;
      }
    }
  });
  if (
    invalidBindingReference ||
    validCalls.get("createHash") !== 1 ||
    validCalls.get("createServer") !== 1 ||
    validCalls.get("randomBytes") !== 1 ||
    validCalls.get("timingSafeEqual") !== 2
  ) {
    addFinding(findings, "RUNTIME_SERVER_BINDING_USE_INVALID", file.relative);
  }
  if (invalidListen || validListenCount !== 1) {
    addFinding(findings, "RUNTIME_SERVER_LISTEN_INVALID", file.relative);
  }
}

function inspectSourceCapabilities(ast, file, findings) {
  inspectFilesystemBindings(ast, file, findings);
  inspectOpenBinding(ast, file, findings);
  inspectCheckpointMutationGraph(ast, file, findings);
  inspectLiteInitializerMutationGraph(ast, file, findings);
  inspectMemoryVnextMutationGraph(ast, file, findings);
  inspectPersonalMemoryMutationGraph(ast, file, findings);
  inspectChildProcessBindings(ast, file, findings);
  inspectServerBindings(ast, file, findings);
  const allowedFilesystemMutations =
    allowedFilesystemMutationsByFile.get(file.relative) ?? new Set();
  const allowedProcessExecutions =
    childProcessBindingsByFile.get(file.relative) ?? new Set();
  const importedFilesystemBindings = new Set(
    ast.body
      .filter((node) => node.type === "ImportDeclaration" && node.source.value === "node:fs/promises")
      .flatMap((node) => node.specifiers)
      .filter((specifier) => specifier.type === "ImportSpecifier")
      .map((specifier) => specifier.local.name),
  );
  const allowedEnvironmentProperties =
    allowedEnvironmentPropertiesByFile.get(file.relative) ?? new Set();
  const emitted = new Set();
  const emit = (code, detail) => {
    const key = `${code}:${detail ?? ""}`;
    if (!emitted.has(key)) {
      emitted.add(key);
      addFinding(findings, code, file.relative, detail);
    }
  };

  walk(ast, (node, parent) => {
    if (
      node.type === "Identifier" &&
      importedFilesystemBindings.has(node.name) &&
      parent?.type !== "ImportSpecifier" &&
      !(
        parent?.type === "CallExpression" &&
        parent.callee === node &&
        !parent.optional
      )
    ) {
      emit("RUNTIME_FILESYSTEM_BINDING_REFERENCE_INVALID", node.name);
    }
    if (node.type === "Identifier" && node.name === "process") {
      if (
        node !== parent?.object ||
        parent?.type !== "MemberExpression" ||
        !allowedProcessProperties.has(memberName(parent)) &&
        !allowedProcessPropertiesByFile
          .get(file.relative)
          ?.has(memberName(parent))
      ) {
        emit("RUNTIME_DYNAMIC_CODE_FORBIDDEN", "process reference");
      }
    }
    if (node.type === "Identifier" && dynamicGlobalNames.has(node.name)) {
      emit("RUNTIME_DYNAMIC_CODE_FORBIDDEN", node.name);
    }
    if (node.type === "Identifier" && node.name === "Object") {
      if (
        node !== parent?.object ||
        parent?.type !== "MemberExpression" ||
        parent.computed ||
        !allowedObjectMethods.has(memberName(parent))
      ) {
        emit("RUNTIME_DYNAMIC_CODE_FORBIDDEN", "Object reference");
      }
    }
    if (node.type === "Identifier" && networkCallNames.has(node.name)) {
      emit("RUNTIME_NETWORK_FORBIDDEN", node.name);
    }

    if (node.type === "Property") {
      const key = propertyKeyName(node);
      if (
        dangerousPropertyNames.has(key) ||
        reflectiveMethodNames.has(key)
      ) {
        emit("RUNTIME_DYNAMIC_CODE_FORBIDDEN", key);
      }
      if (parent?.type === "ObjectPattern") {
        if (node.computed && key === null) {
          emit(
            "RUNTIME_DYNAMIC_MEMBER_FORBIDDEN",
            `line ${node.loc.start.line}`,
          );
        }
        if (
          filesystemMutatorSet.has(key) &&
          !allowedFilesystemMutations.has(key)
        ) {
          emit("RUNTIME_FILESYSTEM_WRITE_FORBIDDEN", key);
        }
        if (
          processExecutionNames.has(key) &&
          !allowedProcessExecutions.has(key)
        ) {
          emit("RUNTIME_PROCESS_EXECUTION_FORBIDDEN", key);
        }
        if (networkCallNames.has(key) || networkMethodNames.has(key)) {
          emit("RUNTIME_NETWORK_FORBIDDEN", key);
        }
        if (loaderPropertyNames.has(key)) {
          emit("RUNTIME_DYNAMIC_CODE_FORBIDDEN", key);
        }
      }
    }

    if (node.type === "ImportExpression") {
      const source = staticString(node.source);
      if (!allowedDynamicImportsByFile.get(file.relative)?.has(source)) {
        emit("RUNTIME_DYNAMIC_IMPORT_FORBIDDEN");
      }
      return;
    }

    if (
      node.type === "MetaProperty" &&
      node.meta?.name === "import" &&
      !allowedImportMetaFiles.has(file.relative)
    ) {
      emit("RUNTIME_DYNAMIC_CODE_FORBIDDEN", "import.meta");
    }

    if (node.type === "MemberExpression") {
      const property = memberName(node);
      const root = rootIdentifier(node);
      const isProcessEnvironment =
        node.object?.type === "MemberExpression" &&
        node.object.object?.type === "Identifier" &&
        node.object.object.name === "process" &&
        memberName(node.object) === "env";
      if (
        isProcessEnvironment &&
        (property === null || !allowedEnvironmentProperties.has(property))
      ) {
        emit("RUNTIME_ENVIRONMENT_FORBIDDEN", property ?? "computed environment property");
      }
      if (node.computed && property === null) {
        emit(
          "RUNTIME_DYNAMIC_MEMBER_FORBIDDEN",
          `line ${node.loc.start.line}`,
        );
      }
      if (
        dangerousPropertyNames.has(property) ||
        reflectiveMethodNames.has(property) ||
        (root === "process" && property === null)
      ) {
        emit("RUNTIME_DYNAMIC_CODE_FORBIDDEN", property ?? "computed process property");
      }
      if (
        filesystemMutatorSet.has(property) &&
        !isProcessOutputWrite(node) &&
        !allowedFilesystemMutations.has(property)
      ) {
        emit("RUNTIME_FILESYSTEM_WRITE_FORBIDDEN", property);
      }
      if (
        networkMethodNames.has(property) &&
        (networkModuleNames.has(root) ||
          root === "navigator" ||
          root === "globalThis")
      ) {
        emit("RUNTIME_NETWORK_FORBIDDEN", property);
      }
      if (
        processExecutionNames.has(property) &&
        !allowedProcessExecutions.has(property)
      ) {
        emit("RUNTIME_PROCESS_EXECUTION_FORBIDDEN", property);
      }
      if (
        root === "process" &&
        new Set(["binding", "env", "getBuiltinModule", "_linkedBinding"]).has(
          property,
        ) &&
        !(
          property === "env" &&
          parent?.type === "MemberExpression" &&
          parent.object === node &&
          memberName(parent) !== null &&
          allowedEnvironmentProperties.has(memberName(parent))
        )
      ) {
        emit(
          property === "env"
            ? "RUNTIME_ENVIRONMENT_FORBIDDEN"
            : "RUNTIME_DYNAMIC_CODE_FORBIDDEN",
          property,
        );
      }
      if (
        new Set(["Bun", "Deno"]).has(root) &&
        new Set(["Command", "env", "spawn"]).has(property)
      ) {
        emit(
          property === "env"
            ? "RUNTIME_ENVIRONMENT_FORBIDDEN"
            : "RUNTIME_PROCESS_EXECUTION_FORBIDDEN",
          `${root}.${property}`,
        );
      }
      if (
        root === "Reflect" ||
        reflectiveMethodNames.has(property)
      ) {
        emit("RUNTIME_DYNAMIC_CODE_FORBIDDEN", `${root}.${property}`);
      }
    }

    if (node.type !== "CallExpression" && node.type !== "NewExpression") {
      return;
    }
    const callee = node.callee;
    const name =
      callee?.type === "Identifier" ? callee.name : memberName(callee);
    if (
      filesystemMutatorSet.has(name) &&
      !isProcessOutputWrite(callee) &&
      !allowedFilesystemMutations.has(name)
    ) {
      emit("RUNTIME_FILESYSTEM_WRITE_FORBIDDEN", name);
    }
    if (
      processExecutionNames.has(name) &&
      !allowedProcessExecutions.has(name)
    ) {
      emit("RUNTIME_PROCESS_EXECUTION_FORBIDDEN", name);
    }
    if (networkCallNames.has(name)) {
      emit("RUNTIME_NETWORK_FORBIDDEN", name);
    }
    if (new Set(["Function", "Proxy", "eval", "require"]).has(name)) {
      emit("RUNTIME_DYNAMIC_CODE_FORBIDDEN", name);
    }
  });
}

function ownerPolicy(relativePath) {
  return runtimePolicies.find(
    (policy) =>
      relativePath === policy.root || relativePath.startsWith(`${policy.root}/`),
  );
}

export async function checkWorkbenchRuntime(repositoryRoot = defaultRepositoryRoot) {
  const resolvedRoot = path.resolve(repositoryRoot);
  const findings = [];
  await inspectPowerShellAssets(resolvedRoot, findings);
  const files = [];
  const collection = { bytes: 0, entries: 0, exhausted: false, files: 0 };
  for (const policy of runtimePolicies) {
    files.push(...(await collectCodeFiles(resolvedRoot, policy, findings, collection)));
  }
  const byAbsolute = new Map(
    files.map((file) => [absoluteKey(file.absolute), file]),
  );
  const byRelative = new Map(files.map((file) => [file.relative, file]));
  const graph = new Map(files.map((file) => [absoluteKey(file.absolute), []]));

  let observedSourceBytes = 0;
  for (const file of files) {
    const capturedSource = await readRuntimeSource(file, findings);
    if (capturedSource === null) continue;
    observedSourceBytes += capturedSource.bytesRead;
    if (observedSourceBytes > MAX_RUNTIME_TOTAL_BYTES) {
      addFinding(findings, "RUNTIME_TOTAL_SIZE_LIMIT_EXCEEDED", file.policy.root);
      break;
    }
    const source = capturedSource.source;
    const ast = parseModule(source, file, findings);
    if (!ast) {
      continue;
    }
    const imports = staticImports(ast);
    inspectSourceCapabilities(ast, file, findings);
    for (const imported of imports) {
      if (imported.startsWith("node:")) {
        if (!file.policy.allowedNodeImports.has(imported)) {
          addFinding(
            findings,
            "RUNTIME_NODE_IMPORT_FORBIDDEN",
            file.relative,
            imported,
          );
        }
        continue;
      }
      if (!imported.startsWith(".")) {
        addFinding(
          findings,
          "RUNTIME_DEPENDENCY_FORBIDDEN",
          file.relative,
          imported,
        );
        continue;
      }
      const targetAbsolute = path.resolve(path.dirname(file.absolute), imported);
      const target = byAbsolute.get(absoluteKey(targetAbsolute));
      if (!target) {
        addFinding(
          findings,
          "RUNTIME_IMPORT_OUTSIDE_BOUNDARY",
          file.relative,
          imported,
        );
        continue;
      }
      const targetPolicy = ownerPolicy(target.relative);
      if (
        targetPolicy?.key !== file.policy.key &&
        !file.policy.allowedCrossRootTargets.has(target.relative)
      ) {
        addFinding(
          findings,
          "RUNTIME_IMPORT_BOUNDARY_FORBIDDEN",
          file.relative,
          target.relative,
        );
        continue;
      }
      graph.get(absoluteKey(file.absolute)).push(absoluteKey(target.absolute));
    }
  }

  const reachable = new Set();
  const pending = [];
  for (const policy of runtimePolicies) {
    const entrypoint = byRelative.get(policy.entrypoint);
    if (!entrypoint) {
      addFinding(findings, "RUNTIME_ENTRYPOINT_MISSING", policy.entrypoint);
    } else {
      pending.push(absoluteKey(entrypoint.absolute));
    }
  }
  while (pending.length > 0) {
    const current = pending.pop();
    if (reachable.has(current)) {
      continue;
    }
    reachable.add(current);
    for (const dependency of graph.get(current) ?? []) {
      pending.push(dependency);
    }
  }
  for (const file of files) {
    if (!reachable.has(absoluteKey(file.absolute))) {
      addFinding(findings, "RUNTIME_MODULE_UNCLASSIFIED", file.relative);
    }
  }

  findings.sort((left, right) =>
    compareText(
      `${left.path}:${left.code}:${left.detail ?? ""}`,
      `${right.path}:${right.code}:${right.detail ?? ""}`,
    ),
  );
  return {
    status: findings.length === 0 ? "pass" : "fail",
    roots: runtimePolicies.map((policy) => policy.root),
    findings,
  };
}

const isMain =
  typeof process.argv[1] === "string" &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const result = await checkWorkbenchRuntime();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.status !== "pass") {
    process.exitCode = 1;
  }
}
