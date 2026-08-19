import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const CURSOR_CLOUD_INSTALL_FORMAT = "dubsar.cursor-cloud-install/1";
export const CURSOR_CLOUD_SESSION_FORMAT = "dubsar.cursor-cloud-session/1";
export const CURSOR_CLOUD_PENDING_FORMAT = "dubsar.cursor-cloud-pending-record/1";
export const CURSOR_CLOUD_LOT_CONTRACT_FORMAT = "dubsar.cursor-cloud-lot-contract/1";
export const CURSOR_CLOUD_ERROR_FORMAT = "dubsar.cursor-cloud-error/1";

export const RUNTIME_RELATIVE_BIN = "packages/dubsar-project-continuity/bin/dubsar.mjs";
export const DEFAULT_COMMAND_TIMEOUT_MS = 20_000;
export const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;
export const DEFAULT_MAX_DOCUMENT_BYTES = 128 * 1024;
export const MINIMUM_NODE_MAJOR = 20;

export const REQUIRED_INSTALL_CAPABILITIES = Object.freeze([
  "memory.atomic-bootstrap.v1",
  "memory.pending-checkpoint-list.v1",
  "memory.pending-checkpoint-record.v1",
  "memory.resume-capsule.v4",
  "memory.route.v2",
  "memory.workspace-vnext.v1",
  "write.preview-apply.v1",
]);

export const REQUIRED_SESSION_CAPABILITIES = Object.freeze([
  "memory.pending-checkpoint-list.v1",
  "memory.resume-capsule.v4",
  "memory.route.v2",
  "memory.workspace-vnext.v1",
]);

export const REPOSITORY_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

export class CursorCloudError extends Error {
  constructor(code) {
    super(code);
    this.name = "CursorCloudError";
    this.code = code;
  }
}

export function nodeMajor(version = process.versions.node) {
  const major = Number.parseInt(String(version).split(".")[0], 10);
  if (!Number.isInteger(major) || major < 1) {
    throw new CursorCloudError("CURSOR_CLOUD_NODE_UNSUPPORTED");
  }
  return major;
}

export function assertSupportedNode(version = process.versions.node) {
  const major = nodeMajor(version);
  if (major < MINIMUM_NODE_MAJOR) {
    throw new CursorCloudError("CURSOR_CLOUD_NODE_UNSUPPORTED");
  }
  return major;
}

export async function resolveRuntimeBin(repositoryRoot = REPOSITORY_ROOT) {
  const relative = RUNTIME_RELATIVE_BIN.split("/");
  const absolute = path.resolve(repositoryRoot, ...relative);
  const root = path.resolve(repositoryRoot);
  const relativeToRoot = path.relative(root, absolute);
  if (
    relativeToRoot.startsWith("..") ||
    path.isAbsolute(relativeToRoot)
  ) {
    throw new CursorCloudError("CURSOR_CLOUD_RUNTIME_MISSING");
  }
  let info;
  try {
    info = await lstat(absolute);
  } catch {
    throw new CursorCloudError("CURSOR_CLOUD_RUNTIME_MISSING");
  }
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new CursorCloudError("CURSOR_CLOUD_RUNTIME_MISSING");
  }
  return absolute;
}

export function parseBoundedJson(text, { maxBytes = DEFAULT_MAX_OUTPUT_BYTES } = {}) {
  if (typeof text !== "string") {
    throw new CursorCloudError("CURSOR_CLOUD_OUTPUT_INVALID");
  }
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > maxBytes) {
    throw new CursorCloudError("CURSOR_CLOUD_OUTPUT_TOO_LARGE");
  }
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    throw new CursorCloudError("CURSOR_CLOUD_OUTPUT_INVALID");
  }
  let value;
  try {
    value = JSON.parse(trimmed);
  } catch {
    throw new CursorCloudError("CURSOR_CLOUD_OUTPUT_INVALID");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new CursorCloudError("CURSOR_CLOUD_OUTPUT_INVALID");
  }
  return value;
}

export function assertNoLeak(text, leakRoots = []) {
  if (typeof text !== "string") {
    throw new CursorCloudError("CURSOR_CLOUD_PATH_LEAK");
  }
  for (const root of leakRoots) {
    if (typeof root === "string" && root.length > 1 && text.includes(root)) {
      throw new CursorCloudError("CURSOR_CLOUD_PATH_LEAK");
    }
  }
  if (
    /(?:^|[\s"'])\/(?:Users|home|opt|var|tmp|private)\/[^\s"]+/u.test(text) ||
    /(?:^|[\s"'])[A-Za-z]:[\\/][^\s"]+/u.test(text) ||
    /\\\\[^\\/\s]+[\\/][^\s"]+/u.test(text)
  ) {
    throw new CursorCloudError("CURSOR_CLOUD_PATH_LEAK");
  }
}

export async function inventoryFingerprint(root) {
  try {
    const info = await lstat(root);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      return "absent";
    }
  } catch (error) {
    if (error?.code === "ENOENT") return "absent";
    throw error;
  }
  const lines = await shaTree(root, "");
  return createHash("sha256").update(lines.join("\n"), "utf8").digest("hex");
}

async function shaTree(root, relative) {
  const current = relative ? path.join(root, relative) : root;
  const names = (await readdir(current, { withFileTypes: true }))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right, "en"));
  const lines = [];
  for (const name of names) {
    const childRelative = relative ? `${relative}/${name}` : name;
    const absolute = path.join(root, childRelative);
    const info = await lstat(absolute);
    if (info.isSymbolicLink()) {
      throw new CursorCloudError("CURSOR_CLOUD_INVENTORY_UNSAFE");
    }
    if (info.isDirectory()) {
      lines.push(...(await shaTree(root, childRelative)));
    } else if (info.isFile()) {
      const digest = createHash("sha256").update(await readFile(absolute)).digest("hex");
      lines.push(`${digest}  ${childRelative}`);
    }
  }
  return lines;
}

export async function invokeDubsar({
  bin,
  args,
  timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
  maxBytes = DEFAULT_MAX_OUTPUT_BYTES,
  cwd,
  env = process.env,
} = {}) {
  if (typeof bin !== "string" || bin.length === 0) {
    throw new CursorCloudError("CURSOR_CLOUD_RUNTIME_MISSING");
  }
  if (!Array.isArray(args) || args.some((item) => typeof item !== "string")) {
    throw new CursorCloudError("CURSOR_CLOUD_OUTPUT_INVALID");
  }
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bin, ...args], {
      cwd,
      env,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let settled = false;
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(new CursorCloudError("CURSOR_CLOUD_TIMEOUT"));
    }, timeoutMs);
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };
    child.stdout.on("data", (chunk) => {
      stdout = Buffer.concat([stdout, chunk]);
      if (stdout.length > maxBytes) {
        child.kill("SIGTERM");
        finish(new CursorCloudError("CURSOR_CLOUD_OUTPUT_TOO_LARGE"));
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr = Buffer.concat([stderr, chunk]);
      if (stderr.length > maxBytes) {
        child.kill("SIGTERM");
        finish(new CursorCloudError("CURSOR_CLOUD_OUTPUT_TOO_LARGE"));
      }
    });
    child.once("error", (error) => finish(error));
    child.once("close", (exitCode) => {
      finish(null, {
        exitCode: exitCode ?? 1,
        stdout: stdout.toString("utf8"),
        stderr: stderr.toString("utf8"),
      });
    });
  });
}

export function requireCapabilities(listed, required) {
  if (!Array.isArray(listed)) {
    throw new CursorCloudError("CURSOR_CLOUD_CAPABILITY_MISSING");
  }
  for (const token of required) {
    if (!listed.includes(token)) {
      throw new CursorCloudError("CURSOR_CLOUD_CAPABILITY_MISSING");
    }
  }
}

export function requireFormat(document, format) {
  if (document?.format !== format) {
    throw new CursorCloudError("CURSOR_CLOUD_FORMAT_INVALID");
  }
}

export function errorDocument(error) {
  const code = error instanceof CursorCloudError
    ? error.code
    : typeof error?.code === "string" ? error.code : "CURSOR_CLOUD_UNEXPECTED_FAILURE";
  return {
    format: CURSOR_CLOUD_ERROR_FORMAT,
    status: "error",
    code,
    route_execution_authority: false,
    memory_trust: "untrusted-data",
  };
}

export function printJson(value, { stdout = process.stdout, stderr = process.stderr, exitCode = 0 } = {}) {
  const serialized = `${JSON.stringify(value)}\n`;
  if (exitCode === 0) stdout.write(serialized);
  else stderr.write(serialized);
  return exitCode;
}

export function isMainModule(metaUrl) {
  const entry = process.argv[1];
  if (typeof entry !== "string" || entry.length === 0) return false;
  return path.resolve(fileURLToPath(metaUrl)) === path.resolve(entry);
}
