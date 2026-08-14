import { createHash } from "node:crypto";

export const WORKBENCH_VIEW_FORMAT = "dubsar.workbench-view/1";
export const WORKBENCH_AUTHORITY = "local_preparation_record";

export const DEFAULT_LIMITS = Object.freeze({
  maxParents: 64,
  maxCanonicalFileBytes: 1024 * 1024,
  maxArtifactFileBytes: 25 * 1024 * 1024,
  maxSnapshotBytes: 64 * 1024 * 1024,
  maxArtifacts: 128,
  maxFreshnessPaths: 128,
  maxFreshnessBytes: 64 * 1024 * 1024,
  maxJsonDepth: 32,
  maxJsonNodes: 20_000,
  maxArrayItems: 2_048,
  maxObjectKeys: 256,
  maxStringChars: 65_536,
  maxViewItems: 256,
  maxViewTextChars: 2_000,
});

const LIMIT_KEYS = new Set(Object.keys(DEFAULT_LIMITS));

export class WorkbenchError extends Error {
  constructor(code) {
    super(code);
    this.name = "WorkbenchError";
    this.code = code;
  }
}

export function resolveLimits(overrides = {}) {
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) {
    throw new WorkbenchError("LIMITS_INVALID");
  }
  const overrideEntries = Object.entries(overrides);
  for (const [key, value] of overrideEntries) {
    if (
      !LIMIT_KEYS.has(key) ||
      !Number.isSafeInteger(value) ||
      value <= 0
    ) {
      throw new WorkbenchError("LIMITS_INVALID");
    }
  }
  const limits = {
    ...DEFAULT_LIMITS,
    ...Object.fromEntries(overrideEntries),
  };
  if (
    limits.maxCanonicalFileBytes > limits.maxSnapshotBytes ||
    limits.maxArtifactFileBytes > limits.maxSnapshotBytes
  ) {
    throw new WorkbenchError("LIMITS_INCONSISTENT");
  }
  return Object.freeze(limits);
}

export function comparePortable(left, right) {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

function sortValue(value) {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => comparePortable(left, right))
        .map(([key, child]) => [key, sortValue(child)]),
    );
  }
  return value;
}

export function stableJson(value) {
  return `${JSON.stringify(sortValue(value), null, 2)}\n`;
}

export function sha256Bytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function rootDigest(entries) {
  const lines = [...entries]
    .sort((left, right) => comparePortable(left.path, right.path))
    .map((entry) => `${entry.sha256}  ${entry.path}\n`)
    .join("");
  return sha256Bytes(Buffer.from(lines, "utf8"));
}

export function uniqueSorted(values) {
  return [...new Set(values)].sort(comparePortable);
}

export function deepFreeze(value) {
  if (!value || typeof value !== "object") {
    return value;
  }
  const pending = [value];
  const seen = new Set();
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || typeof current !== "object" || seen.has(current)) {
      continue;
    }
    seen.add(current);
    for (const child of Object.values(current)) {
      if (child && typeof child === "object") {
        pending.push(child);
      }
    }
    Object.freeze(current);
  }
  return value;
}

export function exactKeys(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  return (
    JSON.stringify(Object.keys(value).sort(comparePortable)) ===
    JSON.stringify([...expected].sort(comparePortable))
  );
}

export function asArray(value, finding, findings) {
  if (!Array.isArray(value)) {
    findings.push(finding);
    return [];
  }
  return value;
}

export function ownValue(value, key) {
  if (!value || typeof value !== "object" || typeof key !== "string") {
    return undefined;
  }
  return Object.entries(value).find(([candidate]) => candidate === key)?.at(1);
}

export function duplicateIds(items, field) {
  const seen = new Set();
  const duplicates = new Set();
  for (const item of items) {
    const id = ownValue(item, field);
    if (typeof id !== "string" || id.length === 0) {
      continue;
    }
    if (seen.has(id)) {
      duplicates.add(id);
    }
    seen.add(id);
  }
  return duplicates;
}

export function codedDiagnostic(code, severity = "error") {
  return Object.freeze({ code, severity });
}
