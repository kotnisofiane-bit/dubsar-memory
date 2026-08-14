import { lstat, readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "acorn";

const ALLOWED_EXTENSIONS = new Set([".json", ".md", ".mjs", ".yaml"]);
const ALLOWED_ROOT_FILES = new Set([
  "README.md",
  "CAPABILITIES.json",
  "PROVENANCE.json",
  "FILES.sha256.json",
  "LICENSE",
  "LICENSE.md",
  "package.json",
]);
const ALLOWED_MANIFEST_DIRS = new Set([
  ".codex-plugin",
  ".claude-plugin",
  ".cursor-plugin",
]);
const FORBIDDEN_FILENAMES = [
  /^\.env(?:\.|$)/i,
  /^\.mcp\.json$/i,
  /^mcp\.json$/i,
  /^credentials/i,
  /^secrets/i,
  /^bearer/i,
  /^runtime.*\.json$/i,
  /^\.npmrc$/i,
  /^\.pypirc$/i,
  /^\.netrc$/i,
  /^auth\.json$/i,
  /^config\.local\./i,
  /^dockerfile$/i,
  /^compose.*\.ya?ml$/i,
  /^docker-compose/i,
  /^wrangler/i,
  /^\.gitmodules$/i,
];
const FORBIDDEN_EXTENSIONS = new Set([
  ".exe",
  ".dll",
  ".node",
  ".zip",
  ".tar",
  ".7z",
  ".pem",
  ".key",
  ".p12",
  ".pfx",
]);
const COMMERCIAL_ACTIVATION = [
  "license_key",
  "activation_key",
  "activation_token",
  "entitlement",
];
const HOOK_TOKENS = [
  "PreToolUse",
  "PostToolUse",
  "SessionStart",
  "SessionEnd",
  "PreCompact",
];
const EXECUTABLE_CODE_EXTENSIONS = new Set([".mjs"]);
const ALLOWED_CODE_IMPORTS = new Set([
  "node:fs/promises",
  "node:path",
  "node:crypto",
  "node:url",
  "node:readline/promises",
]);
const NETWORK_GLOBALS = new Set([
  "EventSource",
  "WebSocket",
  "XMLHttpRequest",
  "fetch",
]);
const DYNAMIC_GLOBALS = new Set([
  "Function",
  "Proxy",
  "Reflect",
  "WebAssembly",
  "eval",
  "global",
  "globalThis",
  "require",
]);
const PROCESS_LOADER_PROPERTIES = new Set([
  "_linkedBinding",
  "binding",
  "getBuiltinModule",
  "mainModule",
]);
const SYNTAX_METADATA_KEYS = new Set(["end", "loc", "start", "type"]);
const ALLOWED_DOCUMENT_DOMAINS = new Set([
  "agentskills.io",
  "code.claude.com",
  "cursor.com",
  "github.com",
  "hermes-agent.nousresearch.com",
  "opensource.org",
  "spdx.org",
  "dupsar.ai",
]);
// Release policy approved after the clean-room and licence review.
const APPROVED_RELEASE_SPDX_IDS = new Set(["MIT"]);

const CAPABILITY_FORMAT = "dubsar.public-capabilities/1";
const CAPABILITY_AUTHORITIES = new Set(["local_preparation_record"]);
const CAPABILITY_EFFECT_KEYS = [
  "background_service",
  "environment_access",
  "filesystem_read",
  "filesystem_write",
  "network",
  "process_execution",
  "remote_mutation",
];
const CAPABILITY_INTEGRATION_KEYS = [
  "backend",
  "core",
  "mcp",
  "personal_memory",
];

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const token = argv[index];
    const value = argv[index + 1];
    if (!token?.startsWith("--") || value === undefined) {
      throw new Error("INVALID_ARGUMENTS");
    }
    values[token.slice(2)] = value;
  }
  if (!values.root || !["development", "release"].includes(values.mode)) {
    throw new Error("INVALID_ARGUMENTS");
  }
  return values;
}

function relativePath(root, target) {
  return path.relative(root, target).replaceAll("\\", "/");
}

function addFinding(findings, rule, relative, category, line) {
  findings.push({
    rule,
    path: relative,
    ...(line ? { line } : {}),
    category,
  });
}

function pathAllowed(relative) {
  const parts = relative.split("/");
  if (parts.length === 1) {
    return ALLOWED_ROOT_FILES.has(parts[0]);
  }
  if (ALLOWED_MANIFEST_DIRS.has(parts[0])) {
    return parts.length === 2 && parts[1] === "plugin.json";
  }
  if (parts[0] === "bin") {
    return parts.length === 2 && parts[1] === "dubsar.mjs";
  }
  if (parts[0] === "runtime") {
    return parts.length === 2 && path.extname(parts[1]) === ".mjs";
  }
  if (parts[0] === "scripts") {
    return parts.length === 2 && path.extname(parts[1]) === ".mjs";
  }
  if (parts[0] !== "skills" || parts.length < 3) {
    return false;
  }
  if (parts.length === 3 && parts[2] === "SKILL.md") {
    return true;
  }
  if (
    parts.length === 4 &&
    parts[2] === "agents" &&
    parts[3] === "openai.yaml"
  ) {
    return true;
  }
  if (
    parts.length === 4 &&
    parts[2] === "scripts" &&
    path.extname(parts[3]) === ".mjs"
  ) {
    return true;
  }
  return (
    parts.length === 4 &&
    parts[2] === "references" &&
    path.extname(parts[3]) === ".md"
  );
}

async function collectFiles(root, current, findings) {
  const files = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const absolute = path.join(current, entry.name);
    const relative = relativePath(root, absolute);
    const info = await lstat(absolute);
    if (info.isSymbolicLink()) {
      addFinding(findings, "PB001", relative, "symbolic link");
      continue;
    }
    if (entry.isDirectory()) {
      if (
        entry.name === "hooks" ||
        entry.name === "node_modules" ||
        entry.name === ".git"
      ) {
        addFinding(findings, "PB010", relative, "forbidden directory");
        continue;
      }
      files.push(...(await collectFiles(root, absolute, findings)));
      continue;
    }
    files.push({ absolute, relative });
  }
  return files;
}

function scanLines(text, relative, findings) {
  const lines = text.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const lower = line.toLowerCase();
    for (const token of COMMERCIAL_ACTIVATION) {
      if (lower.includes(token)) {
        addFinding(
          findings,
          "PB050",
          relative,
          "commercial activation",
          index + 1,
        );
      }
    }
    for (const token of HOOK_TOKENS) {
      if (line.includes(token)) {
        addFinding(findings, "PB010", relative, "hook token", index + 1);
      }
    }
    if (/(?:[A-Za-z]:\\Users\\|\/home\/[^/]+\/|\/Users\/[^/]+\/)/u.test(line)) {
      addFinding(findings, "PB060", relative, "absolute user path", index + 1);
    }
    if (
      /(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16}|-----BEGIN [A-Z ]+ PRIVATE KEY-----)/u.test(
        line,
      )
    ) {
      addFinding(findings, "PB060", relative, "credential pattern", index + 1);
    }
  }
}

function comparablePath(input) {
  const resolved = path.resolve(input);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isInsideOrEqual(root, candidate) {
  const parent = comparablePath(root);
  const child = comparablePath(candidate);
  return child === parent || child.startsWith(`${parent}${path.sep}`);
}

function walkSyntax(node, visitor, parent = null) {
  if (!node || typeof node !== "object" || typeof node.type !== "string") {
    return;
  }
  visitor(node, parent);
  for (const [key, value] of Object.entries(node)) {
    if (SYNTAX_METADATA_KEYS.has(key)) {
      continue;
    }
    if (Array.isArray(value)) {
      for (const child of value) {
        walkSyntax(child, visitor, node);
      }
    } else {
      walkSyntax(value, visitor, node);
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

function staticMemberName(node) {
  if (node?.type !== "MemberExpression") {
    return null;
  }
  if (!node.computed && node.property.type === "Identifier") {
    return node.property.name;
  }
  return node.computed ? staticString(node.property) : null;
}

function propertyKeyName(node) {
  if (node?.type !== "Property") {
    return null;
  }
  if (!node.computed && node.key.type === "Identifier") {
    return node.key.name;
  }
  return node.computed ? staticString(node.key) : null;
}

function rootIdentifier(node) {
  let current = node;
  while (current?.type === "MemberExpression") {
    current = current.object;
  }
  return current?.type === "Identifier" ? current.name : null;
}

function isDeclarationIdentifier(node, parent) {
  return (
    (parent?.type === "VariableDeclarator" && parent.id === node) ||
    ((parent?.type === "FunctionDeclaration" ||
      parent?.type === "FunctionExpression" ||
      parent?.type === "ArrowFunctionExpression") &&
      (parent.id === node || parent.params.includes(node))) ||
    ((parent?.type === "ClassDeclaration" ||
      parent?.type === "ClassExpression") &&
      parent.id === node) ||
    (parent?.type === "ImportSpecifier") ||
    (parent?.type === "ImportDefaultSpecifier") ||
    (parent?.type === "ImportNamespaceSpecifier") ||
    (parent?.type === "Property" && !parent.computed && parent.key === node)
  );
}

function inspectLoaderAndNetworkGlobals(syntax, relative, findings) {
  const emitted = new Set();
  const emit = (rule, category, line) => {
    const key = `${rule}:${category}:${line ?? 0}`;
    if (emitted.has(key)) {
      return;
    }
    emitted.add(key);
    addFinding(findings, rule, relative, category, line);
  };
  walkSyntax(syntax, (node, parent) => {
    if (node.type === "Identifier" && DYNAMIC_GLOBALS.has(node.name)) {
      emit("PB070", "dynamic global access", node.loc?.start?.line);
    }
    if (
      node.type === "Identifier" &&
      NETWORK_GLOBALS.has(node.name) &&
      !isDeclarationIdentifier(node, parent)
    ) {
      emit("PB040", "network client", node.loc?.start?.line);
    }
    if (
      node.type === "Property" &&
      parent?.type === "ObjectPattern" &&
      NETWORK_GLOBALS.has(propertyKeyName(node))
    ) {
      emit("PB040", "network client", node.loc?.start?.line);
    }
    if (node.type === "MemberExpression") {
      const root = rootIdentifier(node);
      const property = staticMemberName(node);
      if (
        new Set(["global", "globalThis"]).has(root) &&
        NETWORK_GLOBALS.has(property)
      ) {
        emit("PB040", "network client", node.loc?.start?.line);
      }
      if (
        new Set(["global", "globalThis"]).has(root) &&
        node.computed &&
        property === null
      ) {
        emit("PB070", "dynamic global access", node.loc?.start?.line);
      }
    }
    if (node.type !== "Identifier" || node.name !== "process") {
      return;
    }
    if (parent?.type !== "MemberExpression" || parent.object !== node) {
      emit("PB070", "dynamic module loader", node.loc?.start?.line);
      return;
    }
    const property = staticMemberName(parent);
    if (
      PROCESS_LOADER_PROPERTIES.has(property) ||
      (parent.computed && property === null)
    ) {
      emit("PB070", "dynamic module loader", node.loc?.start?.line);
    }
  });
}

function parseImports(text, relative, findings) {
  let syntax;
  try {
    syntax = parse(text, {
      allowHashBang: true,
      ecmaVersion: "latest",
      locations: true,
      sourceType: "module",
    });
  } catch (error) {
    addFinding(
      findings,
      "PB070",
      relative,
      "source parse failed",
      error?.loc?.line,
    );
    return [];
  }

  const imports = [];
  for (const statement of syntax.body) {
    if (
      statement.type === "ImportDeclaration" ||
      ((statement.type === "ExportNamedDeclaration" ||
        statement.type === "ExportAllDeclaration") &&
        statement.source)
    ) {
      imports.push(statement.source.value);
    }
  }
  walkSyntax(syntax, (node) => {
    if (node.type !== "ImportExpression") {
      return;
    }
    if (
      node.source?.type === "Literal" &&
      typeof node.source.value === "string"
    ) {
      imports.push(node.source.value);
    } else {
      addFinding(
        findings,
        "PB070",
        relative,
        "non-literal dynamic import",
        node.loc?.start?.line,
      );
    }
  });
  inspectLoaderAndNetworkGlobals(syntax, relative, findings);
  return [...new Set(imports)];
}

async function scanExecutableCode(
  text,
  relative,
  absolute,
  root,
  findings,
) {
  const imports = parseImports(text, relative, findings);
  for (const source of imports) {
    if (source.startsWith(".")) {
      const resolvedImport = path.resolve(path.dirname(absolute), source);
      if (!isInsideOrEqual(root, resolvedImport)) {
        addFinding(findings, "PB070", relative, "import leaves package");
        continue;
      }
      try {
        const info = await lstat(resolvedImport);
        if (!info.isFile() || info.isSymbolicLink()) {
          addFinding(findings, "PB070", relative, "unsafe relative import");
        }
      } catch {
        addFinding(findings, "PB070", relative, "missing relative import");
      }
    } else if (!ALLOWED_CODE_IMPORTS.has(source)) {
      addFinding(findings, "PB070", relative, "non-allowlisted import");
    }
  }
  const continuityDeletionFile = new Set([
    "runtime/checkpoint-writer.mjs",
    "runtime/lite-initializer.mjs",
    "runtime/memory-vnext-initializer.mjs",
    "runtime/memory-vnext-migration.mjs",
    "runtime/memory-vnext-writer.mjs",
    "runtime/personal-memory.mjs",
  ]).has(relative);
  const continuityEnvironmentFile = relative === "runtime/personal-memory.mjs";
  const checks = [
    ["PB040", /\bfetch\s*\(/u, "network call"],
    ["PB040", /\b(?:axios|WebSocket|EventSource)\b/u, "network client"],
    ["PB070", /\bchild_process\b/u, "process execution"],
    ["PB070", /\b(?:exec|spawn|eval)\s*\(/u, "dynamic execution"],
    ["PB070", /\bnew\s+Function\b/u, "dynamic function"],
    ["PB070", /\brequire\s*\(/u, "CommonJS loader"],
    ...(!continuityEnvironmentFile
      ? [["PB070", /\bprocess\.env\b/u, "environment access"]]
      : []),
    ...(!continuityDeletionFile
      ? [["PB070", /\b(?:unlink|rmdir|rm)\s*\(/u, "deletion"]]
      : []),
  ];
  for (const [rule, pattern, category] of checks) {
    if (pattern.test(text)) {
      addFinding(findings, rule, relative, category);
    }
  }
  if (/https?:\/\//u.test(text)) {
    addFinding(findings, "PB040", relative, "URL in executable code");
  }
}

async function validateContinuityRuntime(files, findings) {
  const byName = new Map(files.map((file) => [file.relative, file]));
  const packageFile = byName.get("package.json");
  if (!packageFile) return;
  let manifest;
  try {
    manifest = JSON.parse(await readFile(packageFile.absolute, "utf8"));
  } catch {
    return;
  }
  if (manifest.name !== "@dubsar/project-continuity") return;
  const expectedRuntime = [
    "artifact-lifecycle.mjs", "capsule.mjs", "checkpoint-writer.mjs", "cli.mjs", "close-session.mjs",
    "continuity-facts.mjs",
    "continuity-views.mjs", "continuity.mjs", "contracts.mjs", "display-safety.mjs",
    "index.mjs", "lite-initializer.mjs", "lite.mjs", "locate.mjs", "memory-context.mjs", "memory-router.mjs", "memory-session.mjs",
    "memory-snapshot-compiler.mjs", "memory-vnext-capsule.mjs", "memory-vnext-contracts.mjs",
    "memory-vnext-evaluator.mjs", "memory-vnext-freshness.mjs",
    "memory-vnext-initializer.mjs", "memory-vnext-markdown.mjs",
    "memory-vnext-migration.mjs", "memory-vnext-snapshot.mjs", "memory-vnext-views.mjs", "memory-vnext-writer.mjs",
    "path-safety.mjs",
    "personal-memory.mjs", "project.mjs", "safe-capture.mjs",
    "sensitive-content.mjs", "snapshot.mjs",
  ].map((name) => `runtime/${name}`).sort();
  const actualRuntime = files
    .filter((file) => file.relative.startsWith("runtime/") && file.relative.endsWith(".mjs"))
    .map((file) => file.relative)
    .sort();
  if (
    JSON.stringify(actualRuntime) !== JSON.stringify(expectedRuntime) ||
    !byName.has("bin/dubsar.mjs")
  ) {
    addFinding(findings, "PB130", "runtime", "continuity runtime inventory mismatch");
    return;
  }
  const read = async (relative) => readFile(byName.get(relative).absolute, "utf8");
  const bin = await read("bin/dubsar.mjs");
  const cli = await read("runtime/cli.mjs");
  const close = await read("runtime/close-session.mjs");
  const checkpoint = await read("runtime/checkpoint-writer.mjs");
  const memory = await read("runtime/personal-memory.mjs");
  const memoryInitializer = await read("runtime/memory-vnext-initializer.mjs");
  const memoryMigration = await read("runtime/memory-vnext-migration.mjs");
  const memoryWriter = await read("runtime/memory-vnext-writer.mjs");
  if (
    !/^#!\/usr\/bin\/env node\r?\nimport \{ runContinuityCli \} from "\.\.\/runtime\/cli\.mjs";/u.test(bin) ||
    /^import .*memory-session/mu.test(cli) ||
    !/await import\("\.\/memory-session\.mjs"\)/u.test(cli) ||
    /^import .*personal-memory/mu.test(close) ||
    !/await import\("\.\/personal-memory\.mjs"\)/u.test(close)
  ) {
    addFinding(findings, "PB130", "bin/dubsar.mjs", "optional capability is not isolated");
  }
  const checkpointDeletes = [...checkpoint.matchAll(/\b(?:rm|unlink)\s*\(/gu)].length;
  const memoryDeletes = [...memory.matchAll(/\b(?:rm|unlink)\s*\(/gu)].length;
  const memoryInitializerDeletes = [...memoryInitializer.matchAll(/\b(?:rmdir|unlink)\s*\(/gu)].length;
  const memoryMigrationDeletes = [...memoryMigration.matchAll(/\b(?:rmdir|unlink)\s*\(/gu)].length;
  const memoryWriterDeletes = [...memoryWriter.matchAll(/\b(?:rmdir|unlink)\s*\(/gu)].length;
  const environmentReads = [...memory.matchAll(/process\.env\.LOCALAPPDATA/gu)].length;
  if (
    checkpointDeletes !== 2 || memoryDeletes !== 4 ||
    memoryInitializerDeletes !== 4 || memoryMigrationDeletes !== 4 || memoryWriterDeletes !== 2 ||
    environmentReads !== 1 ||
    /process\.env\.(?!LOCALAPPDATA)/u.test(memory)
  ) {
    addFinding(findings, "PB130", "runtime", "continuity privileged capability mismatch");
  }
  const forbidden = /(?:dubsar-workbench|workbench-report|workbench-server|review-ledger|\.dubsar-audit|mcpServers|child_process|https?:\/\/)/iu;
  for (const relative of ["bin/dubsar.mjs", ...expectedRuntime]) {
    const source = await read(relative);
    if (forbidden.test(source)) {
      addFinding(findings, "PB130", relative, "private or network component reference");
    }
  }
  const weightedOutput = /\b(?:score|rank|weight|threshold)\s*:/iu;
  for (const relative of [
    "runtime/artifact-lifecycle.mjs",
    "runtime/continuity-facts.mjs",
    "runtime/memory-context.mjs",
    "runtime/memory-router.mjs",
    "runtime/memory-snapshot-compiler.mjs",
    "runtime/memory-vnext-evaluator.mjs",
  ]) {
    const source = await read(relative);
    if (weightedOutput.test(source) || /auto_execute\s*:\s*true/u.test(source)) {
      addFinding(findings, "PB130", relative, "protected routing or automatic execution primitive");
    }
  }
}

function scanInstructionText(text, relative, findings) {
  const checks = [
    [
      "PB040",
      /(?:^|`)\s*(?:[-*]\s+)?(?:[$>]\s*)?(?:curl|wget|Invoke-WebRequest|Invoke-RestMethod|ftp|scp|ssh|nc)\b/imu,
      "network command in instructions",
    ],
    [
      "PB070",
      /(?:^|`)\s*(?:[-*]\s+)?(?:[$>]\s*)?(?:powershell|pwsh|cmd\s+\/c|bash\s+-c|sh\s+-c|npx|npm\s+install|pip\s+install|uv\s+pip\s+install)\b/imu,
      "unapproved process command in instructions",
    ],
    [
      "PB070",
      /\b(?:process\.env|os\.environ|getenv\s*\(|\$env:)/iu,
      "environment access in instructions",
    ],
    [
      "PB040",
      /(?:^|`)\s*(?:[-*]\s+)?(?:[$>]\s*)?(?:git\s+push|gh\s+release|aws\s+s3|az\s+storage|gcloud\s+storage)\b/imu,
      "upload command in instructions",
    ],
  ];
  for (const [rule, pattern, category] of checks) {
    if (pattern.test(text)) {
      addFinding(findings, rule, relative, category);
    }
  }
}

function scanDocumentUrls(text, relative, findings) {
  for (const match of text.matchAll(/https?:\/\/([^/\s"')]+)/gu)) {
    if (!ALLOWED_DOCUMENT_DOMAINS.has(match[1].toLowerCase())) {
      addFinding(findings, "PB040", relative, "non-allowlisted URL");
    }
  }
}

function inspectJson(text, relative, findings) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    addFinding(findings, "PB001", relative, "invalid JSON");
    return;
  }
  const serialized = JSON.stringify(value);
  if (
    /"(?:hooks|mcpServers|mcp_tools|toolRouter)"\s*:/u.test(serialized)
  ) {
    addFinding(findings, "PB010", relative, "forbidden manifest key");
  }
  if (relative === "package.json") {
    const expectedKeys = [
      "bin", "description", "engines", "files", "homepage", "license", "name",
      "repository", "type", "version",
    ];
    const expectedFiles = [
      ".claude-plugin", ".codex-plugin", ".cursor-plugin", "bin", "runtime",
      "skills/checkpoint-project-context", "skills/resume-project-context",
      "FILES.sha256.json", "LICENSE", "PROVENANCE.json", "README.md",
    ];
    if (
      !exactKeys(value, expectedKeys) ||
      value.name !== "@dubsar/project-continuity" ||
      value.description !== "Local, deterministic project-memory engine with a bounded Continuity CLI and optional thin host adapters." ||
      value.license !== "MIT" ||
      value.homepage !== "https://github.com/kotnisofiane-bit/dubsar-memory#readme" ||
      !exactKeys(value.repository, ["directory", "type", "url"]) ||
      value.repository.type !== "git" ||
      value.repository.url !== "git+https://github.com/kotnisofiane-bit/dubsar-memory.git" ||
      value.repository.directory !== "packages/dubsar-project-continuity" ||
      value.type !== "module" ||
      typeof value.version !== "string" ||
      !/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/iu.test(value.version) ||
      !exactKeys(value.bin, ["dubsar"]) ||
      value.bin.dubsar !== "bin/dubsar.mjs" ||
      !exactKeys(value.engines, ["node"]) ||
      value.engines.node !== ">=20" ||
      !Array.isArray(value.files) ||
      JSON.stringify(value.files) !== JSON.stringify(expectedFiles)
    ) {
      addFinding(findings, "PB120", relative, "unsafe package manifest");
    }
  }
}

function exactKeys(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  return (
    JSON.stringify(Object.keys(value).sort()) ===
    JSON.stringify([...expected].sort())
  );
}

async function validateCapabilityMetadata(root, files, findings) {
  const byName = new Map(files.map((file) => [file.relative, file]));
  const capabilityFile = byName.get("CAPABILITIES.json");
  if (!capabilityFile) {
    return;
  }

  let capabilities;
  try {
    capabilities = JSON.parse(
      await readFile(capabilityFile.absolute, "utf8"),
    );
  } catch {
    addFinding(
      findings,
      "PB110",
      "CAPABILITIES.json",
      "invalid capability manifest",
    );
    return;
  }

  const expectedRootKeys = [
    "authority",
    "canonical_records",
    "code_inventory",
    "derived_records",
    "effects",
    "format",
    "integrations",
    "package",
    "version",
  ];
  if (
    capabilities?.format !== CAPABILITY_FORMAT ||
    !exactKeys(capabilities, expectedRootKeys) ||
    !CAPABILITY_AUTHORITIES.has(capabilities?.authority) ||
    typeof capabilities?.package !== "string" ||
    typeof capabilities?.version !== "string"
  ) {
    addFinding(
      findings,
      "PB110",
      "CAPABILITIES.json",
      "capability schema mismatch",
    );
    return;
  }

  if (
    !exactKeys(capabilities.effects, CAPABILITY_EFFECT_KEYS) ||
    capabilities.effects.background_service !== "none" ||
    capabilities.effects.environment_access !== "none" ||
    capabilities.effects.filesystem_read !== "workspace_scoped" ||
    capabilities.effects.filesystem_write !== "exclusive_local_records" ||
    capabilities.effects.network !== "none" ||
    capabilities.effects.process_execution !== "none" ||
    capabilities.effects.remote_mutation !== "none" ||
    !exactKeys(capabilities.integrations, CAPABILITY_INTEGRATION_KEYS) ||
    CAPABILITY_INTEGRATION_KEYS.some(
      (key) => capabilities.integrations[key] !== "none",
    )
  ) {
    addFinding(
      findings,
      "PB110",
      "CAPABILITIES.json",
      "undeclared privileged capability",
    );
  }

  const recordLists = [
    capabilities.canonical_records,
    capabilities.derived_records,
  ];
  if (
    recordLists.some(
      (items) =>
        !Array.isArray(items) ||
        items.some(
          (item) => typeof item !== "string" || item.trim().length === 0,
        ),
    )
  ) {
    addFinding(
      findings,
      "PB110",
      "CAPABILITIES.json",
      "invalid record capability list",
    );
  }

  const inventory = capabilities.code_inventory;
  const inventoryKeys = ["commands", "libraries"];
  const commandEntries = Array.isArray(inventory?.commands)
    ? inventory.commands
    : [];
  const commandPaths = commandEntries
    .filter((entry) => entry && typeof entry.path === "string")
    .map((entry) => entry.path);
  const declaredCode = [
    ...commandPaths,
    ...(Array.isArray(inventory?.libraries) ? inventory.libraries : []),
  ];
  const actualCode = files
    .filter((file) => file.relative.endsWith(".mjs"))
    .map((file) => file.relative)
    .sort((left, right) => left.localeCompare(right));
  const normalizedDeclared = declaredCode
    .filter((entry) => typeof entry === "string")
    .sort((left, right) => left.localeCompare(right));
  if (
    !exactKeys(inventory, inventoryKeys) ||
    !Array.isArray(inventory?.commands) ||
    !Array.isArray(inventory?.libraries) ||
    commandEntries.some(
      (entry) =>
        !exactKeys(entry, ["derived_output", "path", "workspace_access"]) ||
        !["append_exclusive", "initialize_exclusive", "read"].includes(
          entry.workspace_access,
        ) ||
        !["create_exclusive", "none"].includes(entry.derived_output),
    ) ||
    new Set(declaredCode).size !== declaredCode.length ||
    JSON.stringify(normalizedDeclared) !== JSON.stringify(actualCode)
  ) {
    addFinding(
      findings,
      "PB110",
      "CAPABILITIES.json",
      "executable inventory mismatch",
    );
  }

  const writerPattern =
    /\b(?:appendFile|copyFile|cp|mkdir|rename|writeFile|writeJsonExclusive|writeTextExclusive|prepareOutputDirectory|initAuditWorkspace|initProjectWorkspace)\b/u;
  for (const entry of commandEntries) {
    if (!entry || typeof entry.path !== "string") {
      continue;
    }
    const commandFile = byName.get(entry.path);
    if (!commandFile) {
      continue;
    }
    const source = await readFile(commandFile.absolute, "utf8");
    const hasWriter = writerPattern.test(source);
    const declaredWriter =
      entry.workspace_access !== "read" ||
      entry.derived_output === "create_exclusive";
    if (hasWriter !== declaredWriter) {
      addFinding(
        findings,
        "PB110",
        entry.path,
        "command effect mismatch",
      );
    }
  }

  const metadataFiles = [
    "PROVENANCE.json",
    ".claude-plugin/plugin.json",
    ".codex-plugin/plugin.json",
    ".cursor-plugin/plugin.json",
  ];
  for (const relative of metadataFiles) {
    const file = byName.get(relative);
    if (!file) {
      continue;
    }
    try {
      const metadata = JSON.parse(await readFile(file.absolute, "utf8"));
      if (
        metadata.name !== undefined &&
        metadata.name !== capabilities.package
      ) {
        addFinding(findings, "PB110", relative, "package identity mismatch");
      }
      if (
        metadata.package !== undefined &&
        metadata.package !== capabilities.package
      ) {
        addFinding(findings, "PB110", relative, "package identity mismatch");
      }
      if (metadata.version !== capabilities.version) {
        addFinding(findings, "PB110", relative, "package version mismatch");
      }
    } catch {
      addFinding(findings, "PB110", relative, "invalid identity metadata");
    }
  }
}

async function validateReleaseMetadata(root, files, findings) {
  const byName = new Map(files.map((file) => [file.relative, file]));
  const licenceFile = byName.get("LICENSE") ?? byName.get("LICENSE.md");
  if (!licenceFile) {
    addFinding(findings, "PB100", "LICENSE", "missing approved licence");
  }

  let provenance = null;
  const provenanceFile = byName.get("PROVENANCE.json");
  if (!provenanceFile) {
    addFinding(findings, "PB100", "PROVENANCE.json", "missing provenance");
  } else {
    try {
      provenance = JSON.parse(await readFile(provenanceFile.absolute, "utf8"));
    } catch {
      addFinding(findings, "PB100", "PROVENANCE.json", "invalid provenance");
    }
  }

  const spdx = provenance?.license_spdx;
  if (
    provenance?.status !== "approved" ||
    provenance?.release_review !== "approved" ||
    typeof spdx !== "string" ||
    !/^[A-Za-z0-9.+-]+$/u.test(spdx) ||
    !APPROVED_RELEASE_SPDX_IDS.has(spdx)
  ) {
    addFinding(
      findings,
      "PB100",
      "PROVENANCE.json",
      "provenance not release-approved",
    );
  }
  if (licenceFile) {
    const licenceText = await readFile(licenceFile.absolute, "utf8");
    if (licenceText.trim().length < 100) {
      addFinding(findings, "PB100", licenceFile.relative, "invalid licence");
    }
  }
  for (const manifestPath of [
    ".claude-plugin/plugin.json",
    ".cursor-plugin/plugin.json",
  ]) {
    const manifestFile = byName.get(manifestPath);
    if (!manifestFile) {
      continue;
    }
    try {
      const manifest = JSON.parse(
        await readFile(manifestFile.absolute, "utf8"),
      );
      if (manifest.license !== spdx) {
        addFinding(
          findings,
          "PB100",
          manifestPath,
          "manifest licence mismatch",
        );
      }
    } catch {
      addFinding(findings, "PB100", manifestPath, "invalid manifest");
    }
  }

  const inventoryFile = byName.get("FILES.sha256.json");
  if (!inventoryFile) {
    addFinding(
      findings,
      "PB100",
      "FILES.sha256.json",
      "missing file inventory",
    );
    return;
  }
  let inventory;
  try {
    inventory = JSON.parse(await readFile(inventoryFile.absolute, "utf8"));
  } catch {
    addFinding(
      findings,
      "PB100",
      "FILES.sha256.json",
      "invalid file inventory",
    );
    return;
  }
  const expectedFiles = files
    .filter((file) => file.relative !== "FILES.sha256.json")
    .sort((left, right) => left.relative.localeCompare(right.relative));
  const actualEntries = [];
  for (const file of expectedFiles) {
    actualEntries.push({
      path: file.relative,
      sha256: createHash("sha256")
        .update(await readFile(file.absolute))
        .digest("hex"),
    });
  }
  const rootLines = actualEntries
    .map((entry) => `${entry.sha256}  ${entry.path}\n`)
    .join("");
  const actualRoot = createHash("sha256")
    .update(rootLines, "utf8")
    .digest("hex");
  if (
    inventory?.format !== "dubsar.public-file-inventory/1" ||
    JSON.stringify(inventory.files) !== JSON.stringify(actualEntries) ||
    inventory.root_sha256 !== actualRoot
  ) {
    addFinding(
      findings,
      "PB100",
      "FILES.sha256.json",
      "file inventory mismatch",
    );
  }
}

export async function checkBoundary(rootInput, mode) {
  const root = path.resolve(rootInput);
  const findings = [];
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error("INVALID_ROOT");
  }
  const files = await collectFiles(root, root, findings);

  for (const file of files) {
    const basename = path.basename(file.relative);
    const extension = path.extname(basename).toLowerCase();
    if (!pathAllowed(file.relative)) {
      addFinding(findings, "PB001", file.relative, "path not allowlisted");
    }
    if (
      FORBIDDEN_FILENAMES.some((pattern) => pattern.test(basename)) ||
      FORBIDDEN_EXTENSIONS.has(extension)
    ) {
      addFinding(findings, "PB001", file.relative, "forbidden file type");
      continue;
    }
    if (
      !ALLOWED_EXTENSIONS.has(extension) &&
      !["LICENSE"].includes(basename)
    ) {
      addFinding(findings, "PB001", file.relative, "extension not allowlisted");
      continue;
    }

    const text = await readFile(file.absolute, "utf8");
    scanLines(text, file.relative, findings);
    if (EXECUTABLE_CODE_EXTENSIONS.has(extension)) {
      await scanExecutableCode(
        text,
        file.relative,
        file.absolute,
        root,
        findings,
      );
    } else {
      scanDocumentUrls(text, file.relative, findings);
      if (extension === ".md" || extension === ".yaml") {
        scanInstructionText(text, file.relative, findings);
      }
    }
    if (extension === ".json") {
      inspectJson(text, file.relative, findings);
    }
  }

  await validateCapabilityMetadata(root, files, findings);
  await validateContinuityRuntime(files, findings);

  if (mode === "release") {
    await validateReleaseMetadata(root, files, findings);
  }

  const ordered = findings.sort(
    (left, right) =>
      left.path.localeCompare(right.path) ||
      left.rule.localeCompare(right.rule) ||
      (left.line ?? 0) - (right.line ?? 0),
  );
  return {
    status: ordered.length === 0 ? "pass" : "fail",
    mode,
    files_scanned: files.length,
    findings: ordered,
  };
}

async function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    const result = await checkBoundary(args.root, args.mode);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (result.status !== "pass") {
      process.exitCode = 1;
    }
  } catch {
    process.stderr.write(
      `${JSON.stringify({ status: "error", code: "BOUNDARY_CHECK_FAILED" })}\n`,
    );
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
