import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

export class PublicPluginError extends Error {
  constructor(code) {
    super(code);
    this.name = "PublicPluginError";
    this.code = code;
  }
}

export function parseArgs(argv, required, allowed = null) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--") || index + 1 >= argv.length) {
      throw new PublicPluginError("INVALID_ARGUMENTS");
    }
    const name = token.slice(2);
    if (allowed !== null && !allowed.includes(name)) {
      throw new PublicPluginError("INVALID_ARGUMENTS");
    }
    if (values.has(name)) {
      throw new PublicPluginError("DUPLICATE_ARGUMENT");
    }
    values.set(name, argv[index + 1]);
    index += 1;
  }
  for (const name of required) {
    if (!values.get(name)) {
      throw new PublicPluginError(`MISSING_${name.toUpperCase()}`);
    }
  }
  return Object.fromEntries(values);
}

function containsTraversal(input) {
  return input
    .replaceAll("\\", "/")
    .split("/")
    .some((part) => part === "..");
}

function comparablePath(input) {
  const resolved = path.resolve(input);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function isInsideOrEqual(root, candidate) {
  const parent = comparablePath(root);
  const child = comparablePath(candidate);
  return child === parent || child.startsWith(`${parent}${path.sep}`);
}

async function existingAncestor(candidate) {
  let current = candidate;
  while (true) {
    try {
      await lstat(current);
      return current;
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw new PublicPluginError("PATH_INSPECTION_FAILED");
      }
      const parent = path.dirname(current);
      if (parent === current) {
        throw new PublicPluginError("NO_EXISTING_PARENT");
      }
      current = parent;
    }
  }
}

async function assertNoSymlinkAncestors(candidate) {
  let current = await existingAncestor(candidate);
  const ancestor = current;
  while (true) {
    let info;
    try {
      info = await lstat(current);
    } catch {
      throw new PublicPluginError("PATH_INSPECTION_FAILED");
    }
    if (info.isSymbolicLink()) {
      throw new PublicPluginError("SYMLINK_ANCESTOR_REJECTED");
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return ancestor;
    }
    current = parent;
  }
}

export async function canonicalCandidate(input) {
  if (containsTraversal(input)) {
    throw new PublicPluginError("PATH_TRAVERSAL_REJECTED");
  }
  const target = path.resolve(input);
  const ancestor = await assertNoSymlinkAncestors(target);
  const resolvedAncestor = await realpath(ancestor);
  return path.resolve(resolvedAncestor, path.relative(ancestor, target));
}

export async function prepareOutputDirectory(input) {
  const target = await canonicalCandidate(input);

  try {
    const info = await lstat(target);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new PublicPluginError("OUTPUT_NOT_DIRECTORY");
    }
    if ((await readdir(target)).length > 0) {
      throw new PublicPluginError("OUTPUT_NOT_EMPTY");
    }
  } catch (error) {
    if (error instanceof PublicPluginError) {
      throw error;
    }
    if (error?.code !== "ENOENT") {
      throw new PublicPluginError("OUTPUT_INSPECTION_FAILED");
    }
    await mkdir(target, { recursive: true });
  }
  return realpath(target);
}

export async function openWorkspace(input) {
  if (containsTraversal(input)) {
    throw new PublicPluginError("PATH_TRAVERSAL_REJECTED");
  }
  const root = path.resolve(input);
  let info;
  try {
    info = await lstat(root);
  } catch {
    throw new PublicPluginError("WORKSPACE_NOT_FOUND");
  }
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new PublicPluginError("WORKSPACE_NOT_DIRECTORY");
  }
  await assertNoSymlinkAncestors(root);
  return realpath(root);
}

export function safeChild(root, relativePath) {
  if (
    !relativePath ||
    path.isAbsolute(relativePath) ||
    containsTraversal(relativePath)
  ) {
    throw new PublicPluginError("UNSAFE_RELATIVE_PATH");
  }
  const target = path.resolve(root, relativePath);
  const prefix = `${comparablePath(root)}${path.sep}`;
  if (!comparablePath(target).startsWith(prefix)) {
    throw new PublicPluginError("PATH_OUTSIDE_WORKSPACE");
  }
  return target;
}

export async function readJson(root, relativePath) {
  const target = safeChild(root, relativePath);
  let info;
  try {
    info = await lstat(target);
  } catch {
    throw new PublicPluginError("REQUIRED_FILE_MISSING");
  }
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new PublicPluginError("REQUIRED_FILE_UNSAFE");
  }
  try {
    return JSON.parse(await readFile(target, "utf8"));
  } catch {
    throw new PublicPluginError("INVALID_JSON");
  }
}

function sortValue(value) {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortValue(value[key])]),
    );
  }
  return value;
}

export function stableJson(value) {
  return `${JSON.stringify(sortValue(value), null, 2)}\n`;
}

async function prepareWriteParent(root, target) {
  const parent = path.dirname(target);
  await assertNoSymlinkAncestors(parent);
  await mkdir(parent, { recursive: true });
  await assertNoSymlinkAncestors(parent);
  if (!isInsideOrEqual(root, await realpath(parent))) {
    throw new PublicPluginError("WRITE_PARENT_OUTSIDE_WORKSPACE");
  }
}

export async function writeJsonExclusive(root, relativePath, value) {
  const target = safeChild(root, relativePath);
  await prepareWriteParent(root, target);
  try {
    await writeFile(target, stableJson(value), {
      encoding: "utf8",
      flag: "wx",
    });
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw new PublicPluginError("OUTPUT_FILE_EXISTS");
    }
    throw new PublicPluginError("WRITE_FAILED");
  }
}

export async function writeTextExclusive(root, relativePath, value) {
  const target = safeChild(root, relativePath);
  await prepareWriteParent(root, target);
  try {
    await writeFile(target, value, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw new PublicPluginError("OUTPUT_FILE_EXISTS");
    }
    throw new PublicPluginError("WRITE_FAILED");
  }
}

export async function sha256File(root, relativePath) {
  const target = safeChild(root, relativePath);
  const info = await lstat(target);
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new PublicPluginError("HASH_TARGET_NOT_FILE");
  }
  const resolved = await realpath(target);
  if (!isInsideOrEqual(root, resolved)) {
    throw new PublicPluginError("HASH_TARGET_OUTSIDE_WORKSPACE");
  }
  return createHash("sha256")
    .update(await readFile(target))
    .digest("hex");
}

export function rootDigest(entries) {
  const lines = [...entries]
    .sort((left, right) => left.path.localeCompare(right.path))
    .map((entry) => `${entry.sha256}  ${entry.path}\n`)
    .join("");
  return createHash("sha256").update(lines, "utf8").digest("hex");
}

export function printResult(value) {
  process.stdout.write(stableJson(value));
}

export function printFailure(error) {
  const code =
    error instanceof PublicPluginError ? error.code : "UNEXPECTED_FAILURE";
  process.stderr.write(stableJson({ status: "error", code }));
  process.exitCode = 1;
}
