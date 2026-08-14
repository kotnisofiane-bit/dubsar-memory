import {
  WORKBENCH_AUTHORITY,
  WorkbenchError,
  comparePortable,
  deepFreeze,
  exactKeys,
  sha256Bytes,
  stableJson,
} from "./contracts.mjs";
import { captureRegularFile } from "./safe-capture.mjs";
import { normalizeRelativePath } from "./path-safety.mjs";

export const MEMORY_REFERENCE_OBSERVATION_FORMAT = "dubsar.reference-observation/1";

const SHA256 = /^[0-9a-f]{64}$/u;
const STATUS = new Set(["fresh", "stale", "missing", "unknown"]);
const MISSING_CODES = new Set(["PATH_NOT_FOUND", "REQUIRED_FILE_MISSING"]);
const MAX_OBSERVED_REFERENCES = 1024;
// Joins a path to a recorded digest for map lookups. Explicit so the source
// file never carries a raw control byte.
const REFERENCE_KEY_SEPARATOR = "\u0000";

function fail(code = "MEMORY_REFERENCE_OBSERVATION_INVALID") {
  throw new WorkbenchError(code);
}

function digest(value) {
  return sha256Bytes(Buffer.from(stableJson(value), "utf8"));
}

function emptyCounts() {
  return { fresh: 0, stale: 0, missing: 0, unknown: 0 };
}

function addCount(counts, status, amount) {
  if (status === "fresh") counts.fresh += amount;
  else if (status === "stale") counts.stale += amount;
  else if (status === "missing") counts.missing += amount;
  else counts.unknown += amount;
}

/**
 * Collect every distinct reference path, with the recorded digests expected for
 * it and how many checkpoint references point at each pair. One path may carry
 * several expected digests: an older checkpoint referencing content A and a
 * newer one referencing content B share a single capture but are classified
 * independently.
 */
export function collectReferenceTargets(entries) {
  const byPath = new Map();
  for (const entry of Array.isArray(entries) ? entries : []) {
    for (const reference of Array.isArray(entry?.references) ? entry.references : []) {
      if (!exactKeys(reference, ["path", "sha256"]) || !SHA256.test(reference.sha256 ?? "")) {
        fail();
      }
      const expected = byPath.get(reference.path) ?? new Map();
      expected.set(reference.sha256, (expected.get(reference.sha256) ?? 0) + 1);
      byPath.set(reference.path, expected);
    }
  }
  return [...byPath.entries()]
    .sort(([left], [right]) => comparePortable(left, right))
    .map(([path, expected]) => ({
      path,
      expected: [...expected.entries()]
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([sha256, occurrence_count]) => ({ sha256, occurrence_count })),
    }));
}

/**
 * Decide how many bytes a capture may read, given what the budget has already
 * spent. Pure and total, so the budget arithmetic is testable on its own.
 *
 * `limit` is never larger than the remaining budget, so the first pass reads at
 * most `maxFreshnessBytes` plus the one detection byte `captureRegularFile`
 * uses to notice an oversized file.
 */
export function planCapture(spent, budget, maxFileBytes) {
  const remaining = budget - spent;
  if (remaining <= 0) return { outcome: "budget", limit: 0, remaining: 0 };
  return {
    outcome: "capture",
    limit: Math.min(maxFileBytes, remaining),
    remaining,
  };
}

function classify(expectedSha256, capture) {
  if (capture.outcome === "missing") return "missing";
  if (capture.outcome !== "captured") return "unknown";
  return capture.sha256 === expectedSha256 ? "fresh" : "stale";
}

async function captureOnce(projectRoot, path, maxBytes) {
  try {
    const captured = await captureRegularFile(projectRoot, path, maxBytes);
    return {
      outcome: "captured",
      sha256: captured.sha256,
      size: captured.size,
      identity: captured.identity,
    };
  } catch (error) {
    if (!(error instanceof WorkbenchError)) throw error;
    return {
      outcome: MISSING_CODES.has(error.code) ? "missing" : "unavailable",
      sha256: null,
      size: null,
      identity: null,
      code: error.code,
    };
  }
}

/**
 * Observe the referenced artifacts of a memory-vNext workspace, read-only.
 *
 * Two bounded passes. The first captures each distinct path once. The second
 * re-reads everything the first pass resolved or reported missing, so a file
 * mutated, removed, or created underneath us is detected. Total reading is
 * therefore bounded by twice the byte budget.
 *
 * Only a successful capture whose digest equals the recorded one yields
 * "fresh". Every other outcome is "missing", "stale", or "unknown".
 */
export async function observeMemoryReferences({
  projectRoot,
  snapshot,
  limits,
  // @internal Test seam, awaited between the two passes so a race can be
  // exercised deterministically. Not exported through runtime/index.mjs and
  // never supplied by a production caller.
  afterFirstPass,
}) {
  if (snapshot?.workspace_mode !== "memory_vnext") fail("MEMORY_SNAPSHOT_REQUIRED");
  if (typeof projectRoot !== "string" || projectRoot.length === 0) fail();
  const maxPaths = limits?.maxFreshnessPaths ?? 128;
  const maxBytes = limits?.maxArtifactFileBytes ?? 25 * 1024 * 1024;
  const budget = limits?.maxFreshnessBytes ?? 64 * 1024 * 1024;

  const targets = collectReferenceTargets(snapshot.documents?.checkpoints?.entries);
  const admitted = targets.slice(0, maxPaths);
  let truncated = admitted.length < targets.length;

  const firstPass = new Map();
  const identities = new Map();
  let spent = 0;
  // Once the budget stops a capture, it stops the whole pass. Continuing would
  // let later, smaller paths be read after the limit was reached, so the set of
  // verified references would depend on file sizes and ordering rather than on
  // the declared budget. Everything after the stop is reported unknown.
  let budgetExhausted = false;
  for (const target of admitted) {
    const plan = budgetExhausted
      ? { outcome: "budget", limit: 0, remaining: 0 }
      : planCapture(spent, budget, maxBytes);
    if (plan.outcome === "budget") {
      truncated = true;
      budgetExhausted = true;
      firstPass.set(target.path, { outcome: "budget", sha256: null, size: null, identity: null });
      continue;
    }
    // Read with the remaining budget, never the whole per-file cap: a single
    // oversized file must not be allowed to exceed maxFreshnessBytes.
    const capture = await captureOnce(projectRoot, target.path, plan.limit);
    if (capture.outcome === "unavailable" && capture.code === "FILE_SIZE_LIMIT_EXCEEDED") {
      // Distinguish "larger than the remaining budget" from "larger than the
      // per-file cap". The first exhausts the budget, the second only makes
      // this one file unverifiable.
      const outcome = plan.limit < maxBytes ? "budget" : "unavailable";
      if (outcome === "budget") {
        truncated = true;
        budgetExhausted = true;
      }
      firstPass.set(target.path, { outcome, sha256: null, size: null, identity: null });
      continue;
    }
    if (capture.outcome === "captured") {
      spent += capture.size;
      // A second path resolving to the same inode is a hardlink alias.
      if (identities.has(capture.identity)) {
        const alias = identities.get(capture.identity);
        firstPass.set(alias, { outcome: "unavailable", sha256: null, size: null, identity: null });
        firstPass.set(target.path, { outcome: "unavailable", sha256: null, size: null, identity: null });
        continue;
      }
      identities.set(capture.identity, target.path);
    }
    firstPass.set(target.path, capture);
  }

  if (typeof afterFirstPass === "function") await afterFirstPass();

  // Second pass. Anything the first pass resolved or reported missing is read
  // again; a divergence in either direction is a race. References dropped for
  // budget are not re-read.
  for (const target of admitted) {
    const before = firstPass.get(target.path);
    if (before === undefined || before.outcome === "budget") continue;
    if (before.outcome === "unavailable") continue;
    // Re-read within the size the first pass admitted, so the second pass is
    // bounded by the same budget. A file that grew trips the limit and is
    // reported as a race, which is the correct outcome.
    const after = await captureOnce(projectRoot, target.path, before.size ?? 0);
    if (before.outcome === "missing") {
      // A file that appeared between the two passes invalidates the observation.
      if (after.outcome !== "missing") throw new WorkbenchError("SNAPSHOT_CAPTURE_RACE");
      continue;
    }
    if (
      after.outcome !== "captured" ||
      after.identity !== before.identity ||
      after.size !== before.size ||
      after.sha256 !== before.sha256
    ) {
      throw new WorkbenchError("SNAPSHOT_CAPTURE_RACE");
    }
  }

  const counts = emptyCounts();
  const references = [];
  for (const target of admitted) {
    const capture = firstPass.get(target.path) ?? { outcome: "unavailable" };
    const observedSha256 = capture.outcome === "captured" ? capture.sha256 : null;
    for (const expected of target.expected) {
      const status = classify(expected.sha256, capture);
      addCount(counts, status, expected.occurrence_count);
      references.push({
        path: target.path,
        recorded_sha256: expected.sha256,
        observed_sha256: observedSha256,
        status,
        occurrence_count: expected.occurrence_count,
      });
    }
  }
  for (const target of targets.slice(admitted.length)) {
    for (const expected of target.expected) {
      counts.unknown += expected.occurrence_count;
      references.push({
        path: target.path,
        recorded_sha256: expected.sha256,
        observed_sha256: null,
        status: "unknown",
        occurrence_count: expected.occurrence_count,
      });
    }
  }

  const base = {
    format: MEMORY_REFERENCE_OBSERVATION_FORMAT,
    authority: WORKBENCH_AUTHORITY,
    source_snapshot_sha256: snapshot.snapshot_sha256,
    truncated,
    references,
    counts,
  };
  return assertMemoryReferenceObservation({ ...base, observation_sha256: digest(base) });
}

export function assertMemoryReferenceObservation(value) {
  if (!exactKeys(value, [
    "authority", "counts", "format", "observation_sha256", "references",
    "source_snapshot_sha256", "truncated",
  ]) ||
    value.format !== MEMORY_REFERENCE_OBSERVATION_FORMAT ||
    value.authority !== WORKBENCH_AUTHORITY ||
    typeof value.truncated !== "boolean" ||
    !SHA256.test(value.source_snapshot_sha256 ?? "") ||
    !SHA256.test(value.observation_sha256 ?? "") ||
    !exactKeys(value.counts, ["fresh", "missing", "stale", "unknown"]) ||
    !Object.values(value.counts).every((item) => Number.isSafeInteger(item) && item >= 0) ||
    !Array.isArray(value.references) ||
    value.references.length > MAX_OBSERVED_REFERENCES
  ) fail();

  const recomputed = emptyCounts();
  const seen = new Set();
  let previousKey = null;
  for (const reference of value.references) {
    if (!exactKeys(reference, [
      "observed_sha256", "occurrence_count", "path", "recorded_sha256", "status",
    ]) ||
      typeof reference.path !== "string" || reference.path.length === 0 ||
      !SHA256.test(reference.recorded_sha256 ?? "") ||
      !(reference.observed_sha256 === null || SHA256.test(reference.observed_sha256)) ||
      !STATUS.has(reference.status) ||
      !Number.isSafeInteger(reference.occurrence_count) || reference.occurrence_count < 1
    ) fail();

    // The recorded path must survive canonical normalization unchanged.
    let normalized;
    try {
      normalized = normalizeRelativePath(reference.path);
    } catch {
      fail();
    }
    if (normalized !== reference.path) fail();

    // Each (path, recorded digest) pair appears at most once.
    const key = `${reference.path}${REFERENCE_KEY_SEPARATOR}${reference.recorded_sha256}`;
    if (seen.has(key)) fail();
    seen.add(key);

    // The constructor emits paths in portable order, digests ascending within a
    // path, so a reordered document is not a valid observation.
    if (previousKey !== null && !(previousKey < key)) fail();
    previousKey = key;

    // Status and observed digest must agree, in both directions.
    if (reference.status === "fresh" &&
      reference.observed_sha256 !== reference.recorded_sha256) fail();
    if (reference.status === "stale" && (
      reference.observed_sha256 === null ||
      reference.observed_sha256 === reference.recorded_sha256)) fail();
    if (new Set(["missing", "unknown"]).has(reference.status) &&
      reference.observed_sha256 !== null) fail();

    addCount(recomputed, reference.status, reference.occurrence_count);
  }
  if (stableJson(recomputed) !== stableJson(value.counts)) fail();

  const { observation_sha256: observed, ...base } = value;
  if (digest(base) !== observed) throw new WorkbenchError("OBSERVATION_DIGEST_MISMATCH");
  return deepFreeze(value);
}

/**
 * Per-checkpoint statuses, in the order the entry records its references.
 * Without an observation every reference stays "unknown", which is the
 * behaviour of a workspace read without verification.
 */
export function checkpointFreshness(entry, observation) {
  const references = Array.isArray(entry?.references) ? entry.references : [];
  if (references.length === 0) return [];
  if (observation === undefined || observation === null) {
    return references.map(() => "unknown");
  }
  const byKey = new Map(
    observation.references.map((item) => [`${item.path}${REFERENCE_KEY_SEPARATOR}${item.recorded_sha256}`, item.status]),
  );
  return references.map((item) => byKey.get(`${item.path}${REFERENCE_KEY_SEPARATOR}${item.sha256}`) ?? "unknown");
}
