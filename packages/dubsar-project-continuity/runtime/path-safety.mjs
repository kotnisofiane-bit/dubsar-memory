import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { WorkbenchError } from "./contracts.mjs";

const WINDOWS_RESERVED = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/iu;

function comparable(input) {
  const resolved = path.resolve(input);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function isInsideOrEqual(root, candidate) {
  const parent = comparable(root);
  const child = comparable(candidate);
  return child === parent || child.startsWith(`${parent}${path.sep}`);
}

function rejectUnsupportedAbsolutePath(input) {
  const resolved = path.resolve(input);
  if (
    resolved.startsWith("\\\\") ||
    resolved.startsWith("//") ||
    resolved.startsWith("\\\\?\\") ||
    resolved.startsWith("\\\\.\\")
  ) {
    throw new WorkbenchError("UNSUPPORTED_ABSOLUTE_PATH");
  }
  return resolved;
}

export async function lstatBigInt(target, missingCode = "PATH_NOT_FOUND") {
  try {
    return await lstat(target, { bigint: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new WorkbenchError(missingCode);
    }
    throw new WorkbenchError("PATH_INSPECTION_FAILED");
  }
}

export function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

export async function assertNoSymbolicComponents(input) {
  const target = rejectUnsupportedAbsolutePath(input);
  const parsed = path.parse(target);
  const relative = path.relative(parsed.root, target);
  let current = parsed.root;
  const components = relative === "" ? [] : relative.split(path.sep);
  for (const component of components) {
    current = path.join(current, component);
    const info = await lstatBigInt(current);
    if (info.isSymbolicLink()) {
      throw new WorkbenchError("SYMBOLIC_PATH_REJECTED");
    }
  }
  return target;
}

export async function openDirectory(input) {
  const target = await assertNoSymbolicComponents(input);
  const info = await lstatBigInt(target, "DIRECTORY_NOT_FOUND");
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new WorkbenchError("DIRECTORY_UNSAFE");
  }
  const canonical = await realpath(target);
  if (comparable(canonical) !== comparable(target)) {
    throw new WorkbenchError("DIRECTORY_ALIAS_REJECTED");
  }
  return canonical;
}

export async function entryInfo(target) {
  try {
    return await lstat(target, { bigint: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw new WorkbenchError("PATH_INSPECTION_FAILED");
  }
}

export function normalizeRelativePath(relativePath) {
  if (
    typeof relativePath !== "string" ||
    relativePath.length === 0 ||
    relativePath.length > 512 ||
    relativePath.includes("\0")
  ) {
    throw new WorkbenchError("UNSAFE_RELATIVE_PATH");
  }
  const portable = relativePath.replaceAll("\\", "/");
  if (
    path.posix.isAbsolute(portable) ||
    portable.startsWith("//") ||
    /[\u0000-\u001f\u007f]/u.test(portable)
  ) {
    throw new WorkbenchError("UNSAFE_RELATIVE_PATH");
  }
  const parts = portable.split("/");
  if (
    parts.some(
      (part) =>
        part.length === 0 ||
        part === "." ||
        part === ".." ||
        part.includes(":") ||
        /[. ]$/u.test(part) ||
        WINDOWS_RESERVED.test(part),
    )
  ) {
    throw new WorkbenchError("UNSAFE_RELATIVE_PATH");
  }
  return parts.join("/");
}

export function resolveSafeChild(root, relativePath) {
  const portable = normalizeRelativePath(relativePath);
  const candidate = path.resolve(root, ...portable.split("/"));
  if (!isInsideOrEqual(root, candidate) || comparable(root) === comparable(candidate)) {
    throw new WorkbenchError("PATH_OUTSIDE_WORKSPACE");
  }
  return { portable, candidate };
}
