import { createHash } from "node:crypto";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import {
  comparePortable,
  deepFreeze,
  exactKeys,
  sha256Bytes,
} from "./contracts.mjs";
import { assertNoSymbolicComponents } from "./path-safety.mjs";

export const REVIEW_LEDGER_FORMAT = "dubsar.review-ledger-view/1";
export const REVIEW_LEDGER_AUTHORITY = "local_preparation_record";
export const REVIEW_LEDGER_PRODUCER = Object.freeze({
  name: "@dubsar/operator-core",
  version: "0.1.0-dev",
});

export const REVIEW_LIMITS = Object.freeze({
  maxDecisionDirectories: 64,
  maxReceiptFiles: 256,
  maxReceiptBytes: 262_144,
  maxAggregateReceiptBytes: 8_388_608,
  maxJsonDepth: 16,
  maxJsonNodesPerReceipt: 4_096,
  maxJsonNodesAggregate: 65_536,
  maxArrayItems: 50,
  maxDisplayFieldBytes: 8_192,
  maxProjectionBytes: 524_288,
  maxElapsedMilliseconds: 5_000,
  maxAccountedMemoryBytes: 16_777_216,
});

const EMPTY_SET_SHA256 =
  "f2568437de4befaeb9899c784a73f1462ac7da67c3af3610a25f025f0c58d6dc";
const RECEIPT_SET_PREFIX = Buffer.from(
  "dubsar.review-ledger-receipt-set/1\0",
  "utf8",
);
const PROJECTION_PREFIX = Buffer.from(
  "dubsar.review-ledger-projection/1\0",
  "utf8",
);
const HEX_64 = /^[0-9a-f]{64}$/u;
const SAFE_RECEIPT_ID = /^[a-z0-9][a-z0-9._-]{2,63}$/u;
const SAFE_PUBLIC_ID = /^[a-z0-9][a-z0-9._-]{2,127}$/u;
const SAFE_SEGMENT = SAFE_RECEIPT_ID;
const RECEIPT_FILE = /^([a-z0-9][a-z0-9._-]{2,63})\.json$/u;
const WINDOWS_RESERVED =
  /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/iu;

const RECEIPT_KEYS = Object.freeze([
  "format",
  "context_kind",
  "context_id",
  "decision_id",
  "receipt_id",
  "receipt_type",
  "role",
  "isolation",
  "advisory",
  "input_root_sha256",
  "resulting_root_sha256",
  "findings",
  "alternatives",
  "limitations",
  "reviewed_receipts",
]);
const FINDING_KEYS = Object.freeze([
  "finding_id",
  "severity",
  "summary",
  "evidence_refs",
]);
const RECEIPT_TYPES = new Set([
  "domain-review",
  "challenge",
  "reconciliation",
]);
const ROLES = new Set([
  "product",
  "architecture",
  "security",
  "verification",
  "reliability",
  "challenger",
  "principal",
  "human",
]);
const ISOLATIONS = new Set([
  "isolated-subagent",
  "external-model",
  "human",
  "self-check",
]);
const SEVERITIES = new Set(["info", "low", "medium", "high", "critical"]);
const DOMAIN_ROLES = new Set([
  "product",
  "architecture",
  "security",
  "verification",
  "reliability",
]);

const DIAGNOSTIC_SEVERITY = new Map([
  ["REVIEW_ENTRY_INVALID", "warning"],
  ["REVIEW_ENTRY_TOO_LARGE", "warning"],
  ["REVIEW_ENTRY_JSON_LIMIT_EXCEEDED", "warning"],
  ["REVIEW_PATH_UNSAFE", "error"],
  ["REVIEW_STRUCTURE_UNSAFE", "error"],
  ["REVIEW_PLATFORM_IDENTITY_UNAVAILABLE", "error"],
  ["REVIEW_DISCOVERY_LIMIT_EXCEEDED", "error"],
  ["REVIEW_LEDGER_SIZE_LIMIT_EXCEEDED", "error"],
  ["REVIEW_CAPTURE_RACE", "error"],
  ["REVIEW_TIME_LIMIT_EXCEEDED", "error"],
  ["REVIEW_MEMORY_LIMIT_EXCEEDED", "error"],
  ["REVIEW_PROJECTION_LIMIT_EXCEEDED", "error"],
]);

const ROOT_ORDER = Object.freeze([
  "format",
  "authority",
  "producer",
  "source",
  "ledger",
  "reviews",
  "privacy",
  "projection_sha256",
]);
const PRODUCER_ORDER = Object.freeze(["name", "version"]);
const SOURCE_ORDER = Object.freeze([
  "domain",
  "id",
  "canonical_root_sha256",
  "snapshot_sha256",
]);
const LEDGER_ORDER = Object.freeze([
  "status",
  "receipt_set_sha256",
  "discovered_count",
  "valid_count",
  "omitted_count",
  "diagnostics",
]);
const DIAGNOSTIC_ORDER = Object.freeze(["code", "severity"]);
const REVIEW_ORDER = Object.freeze([
  "decision_id",
  "receipt_id",
  "receipt_type",
  "declared_role",
  "declared_isolation",
  "advisory",
  "input_canonical_root_sha256",
  "resulting_canonical_root_sha256",
  "input_canonical_digest_match",
  "resulting_canonical_digest_match",
  "findings",
  "alternatives",
  "limitations",
  "reviewed_receipts",
]);
const PROJECTED_FINDING_ORDER = Object.freeze([
  "finding_id",
  "severity",
  "summary",
  "evidence_refs",
]);
const PRIVACY_ORDER = Object.freeze([
  "redacted_fields",
  "truncated_fields",
  "omitted_fields",
]);

const CONTROL_OR_BIDI =
  /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u;
const CREDENTIAL_PATTERN =
  /-----BEGIN [A-Z ]+ PRIVATE KEY-----|\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16}|AIza[A-Za-z0-9_-]{30,}|xox[baprs]-[A-Za-z0-9-]{12,}|(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,})\b|\bBearer\s+[A-Za-z0-9._-]{12,}\b|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/iu;
const CREDENTIAL_ASSIGNMENT =
  /["']?\b(?:password|secret|client[_-]?secret|api[_-]?key|access[_-]?token|refresh[_-]?token|session[_-]?token|private[_-]?key|connection[_-]?string)\b["']?\s*[:=]\s*["']?[^\s"',}]{1,}/iu;
const LONG_TOKEN = /(?:^|[^A-Za-z0-9_-])[A-Za-z0-9_-]{24,}(?:$|[^A-Za-z0-9_-])/u;
const IPV4_SHAPE = /(?:^|[^0-9])(?:[0-9]{1,3}\.){3}[0-9]{1,3}(?:$|[^0-9])/u;
const URI_LIKE = /[A-Za-z][A-Za-z0-9+.-]{1,31}:/u;
const ACTIVE_CONTENT = /[<>`\[\]()!&]/u;

class ReviewFailure extends Error {
  constructor(code) {
    super(code);
    this.name = "ReviewFailure";
    this.code = code;
  }
}

function fail(code) {
  throw new ReviewFailure(code);
}

function comparable(input) {
  const resolved = path.resolve(input);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function elapsedExceeded(startedAt, now = performance.now()) {
  return now - startedAt > REVIEW_LIMITS.maxElapsedMilliseconds;
}

export function reviewTimeBudgetExceeded(startedAt, now) {
  return elapsedExceeded(startedAt, now);
}

function assertTime(startedAt) {
  if (elapsedExceeded(startedAt)) {
    fail("REVIEW_TIME_LIMIT_EXCEEDED");
  }
}

export function accountedReviewPeak(rawBytes, persistentBytes, jsonNodeLimit = REVIEW_LIMITS.maxJsonNodesPerReceipt) {
  if (
    !Number.isSafeInteger(rawBytes) ||
    rawBytes < 0 ||
    !Number.isSafeInteger(persistentBytes) ||
    persistentBytes < 0 ||
    !Number.isSafeInteger(jsonNodeLimit) ||
    jsonNodeLimit < 0
  ) {
    fail("REVIEW_MEMORY_LIMIT_EXCEEDED");
  }
  return persistentBytes + rawBytes * 7 + jsonNodeLimit * 96;
}

export function reviewMemoryBudgetExceeded(
  rawBytes,
  persistentBytes,
  jsonNodeLimit = REVIEW_LIMITS.maxJsonNodesPerReceipt,
) {
  return (
    accountedReviewPeak(rawBytes, persistentBytes, jsonNodeLimit) >
    REVIEW_LIMITS.maxAccountedMemoryBytes
  );
}

function assertMemory(bytes) {
  if (bytes > REVIEW_LIMITS.maxAccountedMemoryBytes) {
    fail("REVIEW_MEMORY_LIMIT_EXCEEDED");
  }
}

function scalarSafePrefix(value, maxBytes) {
  let output = "";
  let bytes = 0;
  for (const scalar of value) {
    const size = Buffer.byteLength(scalar, "utf8");
    if (bytes + size > maxBytes) {
      break;
    }
    output += scalar;
    bytes += size;
  }
  return output;
}

export function classifyReviewText(value) {
  if (CONTROL_OR_BIDI.test(value)) {
    return "CONTROL_OR_BIDI";
  }
  if (
    CREDENTIAL_PATTERN.test(value) ||
    CREDENTIAL_ASSIGNMENT.test(value) ||
    LONG_TOKEN.test(value)
  ) {
    return "CREDENTIAL_SHAPED";
  }
  const digitCount = [...value].filter((scalar) => /[0-9]/u.test(scalar)).length;
  if (value.includes("@") || IPV4_SHAPE.test(value) || digitCount >= 7) {
    return "PERSONAL_DATA_SHAPED";
  }
  if (URI_LIKE.test(value)) {
    return "URI_LIKE";
  }
  if (value.includes("/") || value.includes("\\")) {
    return "PRIVATE_PATH";
  }
  if (ACTIVE_CONTENT.test(value)) {
    return "ACTIVE_CONTENT";
  }
  return null;
}

function reduceText(value, privacy, { omitClassified = false } = {}) {
  const classification = classifyReviewText(value);
  if (classification) {
    if (omitClassified) {
      privacy.omitted_fields += 1;
      return null;
    }
    privacy.redacted_fields += 1;
    return `[REDACTED:${classification}]`;
  }
  if (Buffer.byteLength(value, "utf8") <= REVIEW_LIMITS.maxDisplayFieldBytes) {
    return value;
  }
  const suffix = "[TRUNCATED]";
  privacy.truncated_fields += 1;
  return `${scalarSafePrefix(
    value,
    REVIEW_LIMITS.maxDisplayFieldBytes - Buffer.byteLength(suffix, "utf8"),
  )}${suffix}`;
}

function isSensitiveId(value) {
  return classifyReviewText(value) !== null;
}

function diagnostic(code) {
  return Object.freeze({ code, severity: DIAGNOSTIC_SEVERITY.get(code) });
}

function sortedDiagnostics(codes) {
  return [...new Set(codes)]
    .sort(comparePortable)
    .map((code) => diagnostic(code));
}

function encodeRecord(type, schemaPath, valueBytes) {
  return Buffer.from(
    `${type}\t${schemaPath}\t${valueBytes.length}\t${valueBytes.toString("hex")}\n`,
    "utf8",
  );
}

function objectOrder(schemaPath) {
  if (schemaPath === "$") return ROOT_ORDER;
  if (schemaPath === "$/producer") return PRODUCER_ORDER;
  if (schemaPath === "$/source") return SOURCE_ORDER;
  if (schemaPath === "$/ledger") return LEDGER_ORDER;
  if (/^\$\/ledger\/diagnostics\/\d{6}$/u.test(schemaPath)) {
    return DIAGNOSTIC_ORDER;
  }
  if (/^\$\/reviews\/\d{6}$/u.test(schemaPath)) return REVIEW_ORDER;
  if (/^\$\/reviews\/\d{6}\/findings\/\d{6}$/u.test(schemaPath)) {
    return PROJECTED_FINDING_ORDER;
  }
  if (schemaPath === "$/privacy") return PRIVACY_ORDER;
  fail("REVIEW_PROJECTION_LIMIT_EXCEEDED");
}

function frameProjectionValue(value, schemaPath, emit) {
  if (value === null) {
    emit(encodeRecord("null", schemaPath, Buffer.alloc(0)));
    return;
  }
  if (Array.isArray(value)) {
    emit(
      encodeRecord("array", schemaPath, Buffer.from(String(value.length), "utf8")),
    );
    value.forEach((child, index) => {
      frameProjectionValue(
        child,
        `${schemaPath}/${String(index).padStart(6, "0")}`,
        emit,
      );
    });
    return;
  }
  if (typeof value === "object") {
    emit(encodeRecord("object", schemaPath, Buffer.alloc(0)));
    const order = objectOrder(schemaPath);
    if (!exactKeys(value, order)) {
      fail("REVIEW_PROJECTION_LIMIT_EXCEEDED");
    }
    for (const key of order) {
      if (schemaPath === "$" && key === "projection_sha256") {
        continue;
      }
      const child = Object.entries(value).find(([candidate]) => candidate === key)?.at(1);
      frameProjectionValue(child, `${schemaPath}/${key}`, emit);
    }
    return;
  }
  if (typeof value === "string") {
    emit(encodeRecord("string", schemaPath, Buffer.from(value, "utf8")));
    return;
  }
  if (typeof value === "boolean") {
    emit(
      encodeRecord("boolean", schemaPath, Buffer.from(String(value), "utf8")),
    );
    return;
  }
  if (Number.isSafeInteger(value)) {
    emit(
      encodeRecord("integer", schemaPath, Buffer.from(String(value), "utf8")),
    );
    return;
  }
  fail("REVIEW_PROJECTION_LIMIT_EXCEEDED");
}

export function projectionPreimage(projection) {
  const records = [];
  frameProjectionValue(projection, "$", (record) => records.push(record));
  return Buffer.concat([PROJECTION_PREFIX, ...records]);
}

export function projectionDigest(projection) {
  const hash = createHash("sha256");
  hash.update(PROJECTION_PREFIX);
  frameProjectionValue(projection, "$", (record) => hash.update(record));
  return hash.digest("hex");
}

export function receiptSetPreimage(records) {
  const framed = [...records]
    .sort((left, right) => comparePortable(left.portable_path, right.portable_path))
    .map((record) =>
      Buffer.from(`${record.content_sha256}  ${record.portable_path}\n`, "utf8"),
    );
  return Buffer.concat([RECEIPT_SET_PREFIX, ...framed]);
}

export function receiptSetDigest(records) {
  const hash = createHash("sha256");
  hash.update(RECEIPT_SET_PREFIX);
  for (const record of [...records].sort((left, right) =>
    comparePortable(left.portable_path, right.portable_path),
  )) {
    hash.update(`${record.content_sha256}  ${record.portable_path}\n`, "utf8");
  }
  return hash.digest("hex");
}

function jsonStringBytes(value) {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

export function projectionJsonByteLength(value, ceiling = Number.MAX_SAFE_INTEGER) {
  let bytes = 0;
  const add = (amount) => {
    bytes += amount;
    if (bytes > ceiling) fail("REVIEW_PROJECTION_LIMIT_EXCEEDED");
  };
  function visit(current) {
    if (current === null) {
      add(4);
    } else if (typeof current === "string") {
      add(jsonStringBytes(current));
    } else if (typeof current === "boolean") {
      add(current ? 4 : 5);
    } else if (Number.isSafeInteger(current)) {
      add(Buffer.byteLength(String(current), "utf8"));
    } else if (Array.isArray(current)) {
      add(2 + Math.max(0, current.length - 1));
      for (const child of current) visit(child);
    } else if (current && typeof current === "object") {
      const entries = Object.entries(current);
      add(2 + Math.max(0, entries.length - 1));
      for (const [key, child] of entries) {
        add(jsonStringBytes(key) + 1);
        visit(child);
      }
    } else {
      fail("REVIEW_PROJECTION_LIMIT_EXCEEDED");
    }
  }
  visit(value);
  return bytes;
}

function hasUnpairedSurrogate(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function scanJsonDocument(text) {
  let index = 0;
  let nodes = 0;

  function skipWhitespace() {
    while (/[\u0009\u000a\u000d\u0020]/u.test(text.at(index) ?? "")) index += 1;
  }

  function parseString() {
    const start = index;
    if (text.at(index) !== '"') fail("REVIEW_ENTRY_INVALID");
    index += 1;
    while (index < text.length) {
      const code = text.charCodeAt(index);
      if (code === 0x22) {
        index += 1;
        let value;
        try {
          value = JSON.parse(text.slice(start, index));
        } catch {
          fail("REVIEW_ENTRY_INVALID");
        }
        if (hasUnpairedSurrogate(value)) fail("REVIEW_ENTRY_INVALID");
        return value;
      }
      if (code < 0x20) fail("REVIEW_ENTRY_INVALID");
      if (code === 0x5c) {
        index += 1;
        const escaped = text.at(index);
        if (escaped === "u") {
          if (!/^[0-9a-fA-F]{4}$/u.test(text.slice(index + 1, index + 5))) {
            fail("REVIEW_ENTRY_INVALID");
          }
          index += 5;
          continue;
        }
        if (!'"\\/bfnrt'.includes(escaped ?? "")) fail("REVIEW_ENTRY_INVALID");
      }
      index += 1;
    }
    fail("REVIEW_ENTRY_INVALID");
  }

  function parseValue(depth) {
    nodes += 1;
    if (nodes > REVIEW_LIMITS.maxJsonNodesPerReceipt) {
      fail("REVIEW_ENTRY_JSON_LIMIT_EXCEEDED");
    }
    if (depth > REVIEW_LIMITS.maxJsonDepth) {
      fail("REVIEW_ENTRY_JSON_LIMIT_EXCEEDED");
    }
    skipWhitespace();
    const token = text.at(index);
    if (token === "{") {
      index += 1;
      skipWhitespace();
      const keys = new Set();
      let count = 0;
      if (text.at(index) === "}") {
        index += 1;
        return;
      }
      while (true) {
        skipWhitespace();
        const key = parseString();
        if (keys.has(key)) fail("REVIEW_ENTRY_INVALID");
        keys.add(key);
        count += 1;
        if (count > 256) fail("REVIEW_ENTRY_JSON_LIMIT_EXCEEDED");
        skipWhitespace();
        if (text.at(index) !== ":") fail("REVIEW_ENTRY_INVALID");
        index += 1;
        parseValue(depth + 1);
        skipWhitespace();
        if (text.at(index) === "}") {
          index += 1;
          return;
        }
        if (text.at(index) !== ",") fail("REVIEW_ENTRY_INVALID");
        index += 1;
      }
    }
    if (token === "[") {
      index += 1;
      skipWhitespace();
      let count = 0;
      if (text.at(index) === "]") {
        index += 1;
        return;
      }
      while (true) {
        count += 1;
        if (count > REVIEW_LIMITS.maxArrayItems) {
          fail("REVIEW_ENTRY_JSON_LIMIT_EXCEEDED");
        }
        parseValue(depth + 1);
        skipWhitespace();
        if (text.at(index) === "]") {
          index += 1;
          return;
        }
        if (text.at(index) !== ",") fail("REVIEW_ENTRY_INVALID");
        index += 1;
      }
    }
    if (token === '"') {
      parseString();
      return;
    }
    const remainder = text.slice(index);
    const literal = remainder.match(/^(?:true|false|null)/u)?.at(0);
    if (literal) {
      index += literal.length;
      return;
    }
    const number = remainder
      .match(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/u)
      ?.at(0);
    if (!number) fail("REVIEW_ENTRY_INVALID");
    index += number.length;
  }

  parseValue(1);
  skipWhitespace();
  if (index !== text.length) fail("REVIEW_ENTRY_INVALID");
  return nodes;
}

export function parseReviewReceiptBytes(bytes) {
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xef &&
    bytes[1] === 0xbb &&
    bytes[2] === 0xbf
  ) {
    fail("REVIEW_ENTRY_INVALID");
  }
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail("REVIEW_ENTRY_INVALID");
  }
  const nodes = scanJsonDocument(text);
  let document;
  try {
    document = JSON.parse(text);
  } catch {
    fail("REVIEW_ENTRY_INVALID");
  }
  return { document, nodes };
}

function validRoleIsolation(receipt) {
  if (receipt.receipt_type === "domain-review") {
    if (!DOMAIN_ROLES.has(receipt.role)) return false;
    return new Set(["isolated-subagent", "external-model"]).has(
      receipt.isolation,
    );
  }
  if (receipt.receipt_type === "challenge") {
    return (
      receipt.role === "challenger" &&
      new Set(["isolated-subagent", "external-model"]).has(receipt.isolation)
    );
  }
  if (receipt.receipt_type === "reconciliation") {
    return (
      (receipt.role === "principal" && receipt.isolation === "self-check") ||
      (receipt.role === "human" && receipt.isolation === "human")
    );
  }
  return false;
}

function conciseString(value, maxChars = 2_048) {
  return (
    typeof value === "string" &&
    value.trim() !== "" &&
    value.length <= maxChars &&
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value)
  );
}

function validStringArray(
  value,
  { allowEmpty = true, ids = false, references = false } = {},
) {
  return (
    Array.isArray(value) &&
    value.length <= REVIEW_LIMITS.maxArrayItems &&
    (allowEmpty || value.length > 0) &&
    value.every(
      (entry) =>
        conciseString(entry) &&
        (!ids || SAFE_RECEIPT_ID.test(entry)) &&
        (!references || validEvidenceReference(entry)),
    )
  );
}

function validEvidenceReference(value) {
  if (!conciseString(value)) {
    return false;
  }
  const portable = value.replaceAll("\\", "/");
  if (
    path.posix.isAbsolute(portable) ||
    /^[A-Za-z]:/u.test(value) ||
    portable.startsWith("//") ||
    portable.split("/").includes("..") ||
    URI_LIKE.test(value)
  ) {
    return false;
  }
  return true;
}

function rejectsRecorderCredentialMaterial(value) {
  const text = JSON.stringify(value);
  if (
    /-----BEGIN [A-Z ]+ PRIVATE KEY-----/u.test(text) ||
    /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16})\b/u.test(text) ||
    /\bBearer\s+[A-Za-z0-9._-]{12,}\b/iu.test(text) ||
    /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/iu.test(text)
  ) {
    return true;
  }
  const assignment =
    /["']?\b(?:password|secret|client[_-]?secret|api[_-]?key|access[_-]?token|refresh[_-]?token|session[_-]?token|private[_-]?key|connection[_-]?string)\b["']?\s*[:=]\s*["']?([^\s"',}]{6,})/giu;
  for (const match of text.matchAll(assignment)) {
    const candidate = match[1].replace(/[<>]/gu, "").toLowerCase();
    if (!new Set(["redacted", "example", "dummy", "null", "none"]).has(candidate)) {
      return true;
    }
  }
  return false;
}

function validateReceiptDocument(receipt, candidate, identities) {
  if (!exactKeys(receipt, RECEIPT_KEYS)) return false;
  if (
    receipt.format !== "dubsar.review-receipt/1" ||
    receipt.context_kind !==
      (identities.domain === "project" ? "project-mission" : "audit-case") ||
    receipt.context_id !== identities.context_id ||
    !SAFE_RECEIPT_ID.test(receipt.context_id) ||
    !SAFE_RECEIPT_ID.test(receipt.decision_id) ||
    !SAFE_RECEIPT_ID.test(receipt.receipt_id) ||
    receipt.decision_id !== candidate.decisionId ||
    receipt.receipt_id !== candidate.receiptId ||
    !RECEIPT_TYPES.has(receipt.receipt_type) ||
    !ROLES.has(receipt.role) ||
    !ISOLATIONS.has(receipt.isolation) ||
    !validRoleIsolation(receipt) ||
    receipt.advisory !== true ||
    !HEX_64.test(receipt.input_root_sha256) ||
    !Array.isArray(receipt.findings) ||
    receipt.findings.length > REVIEW_LIMITS.maxArrayItems ||
    !validStringArray(receipt.alternatives) ||
    !validStringArray(receipt.limitations) ||
    !validStringArray(receipt.reviewed_receipts, { ids: true }) ||
    rejectsRecorderCredentialMaterial(receipt)
  ) {
    return false;
  }
  const findingIds = new Set();
  for (const finding of receipt.findings) {
    if (
      !exactKeys(finding, FINDING_KEYS) ||
      !SAFE_RECEIPT_ID.test(finding.finding_id) ||
      findingIds.has(finding.finding_id) ||
      !SEVERITIES.has(finding.severity) ||
      !conciseString(finding.summary) ||
      !validStringArray(finding.evidence_refs, { references: true })
    ) {
      return false;
    }
    findingIds.add(finding.finding_id);
  }
  if (receipt.receipt_type === "reconciliation") {
    if (
      !HEX_64.test(receipt.resulting_root_sha256) ||
      receipt.reviewed_receipts.length === 0 ||
      new Set(receipt.reviewed_receipts).size !== receipt.reviewed_receipts.length ||
      !receipt.reviewed_receipts.every((entry) => SAFE_RECEIPT_ID.test(entry))
    ) {
      return false;
    }
  } else if (
    receipt.resulting_root_sha256 !== null ||
    receipt.reviewed_receipts.length !== 0
  ) {
    return false;
  }
  return true;
}

function statRecord(info) {
  return Object.freeze({
    dev: String(info.dev),
    ino: String(info.ino),
    type: info.isDirectory() ? "directory" : info.isFile() ? "file" : "other",
    nlink: String(info.nlink),
    size: String(info.size),
    mtimeNs: String(info.mtimeNs),
  });
}

function identityAvailable(record) {
  return record.dev !== "0" && record.ino !== "0";
}

function sameStat(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.type === right.type &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs
  );
}

async function safeLstat(target, missingAllowed = false) {
  try {
    return await lstat(target, { bigint: true });
  } catch (error) {
    if (missingAllowed && error?.code === "ENOENT") return null;
    fail("REVIEW_PATH_UNSAFE");
  }
}

function safeSegment(segment) {
  return (
    SAFE_SEGMENT.test(segment) &&
    !WINDOWS_RESERVED.test(segment) &&
    path.basename(path.join("x", segment)) === segment
  );
}

async function assertDirectoryPath(target) {
  try {
    await assertNoSymbolicComponents(target);
    const canonical = await realpath(target);
    if (comparable(canonical) !== comparable(target)) fail("REVIEW_PATH_UNSAFE");
  } catch (error) {
    if (error instanceof ReviewFailure) throw error;
    fail("REVIEW_PATH_UNSAFE");
  }
}

async function enumerateManifest(workspaceRoot, startedAt) {
  assertTime(startedAt);
  const workspaceInfo = await safeLstat(workspaceRoot);
  const workspace = statRecord(workspaceInfo);
  if (
    workspace.type !== "directory" ||
    !identityAvailable(workspace) ||
    workspaceInfo.isSymbolicLink()
  ) {
    fail(
      identityAvailable(workspace)
        ? "REVIEW_PATH_UNSAFE"
        : "REVIEW_PLATFORM_IDENTITY_UNAVAILABLE",
    );
  }
  await assertDirectoryPath(workspaceRoot);

  const reviewsRoot = path.join(workspaceRoot, "reviews");
  const reviewsInfo = await safeLstat(reviewsRoot, true);
  if (!reviewsInfo) {
    return deepFreeze({
      missing: true,
      manifest: { workspace, reviews: null, decisions: [] },
      candidates: [],
      decisionCount: 0,
    });
  }
  const reviews = statRecord(reviewsInfo);
  if (
    reviews.type !== "directory" ||
    reviewsInfo.isSymbolicLink()
  ) {
    fail("REVIEW_PATH_UNSAFE");
  }
  if (!identityAvailable(reviews)) fail("REVIEW_PLATFORM_IDENTITY_UNAVAILABLE");
  await assertDirectoryPath(reviewsRoot);

  const decisions = [];
  const candidates = [];
  const physical = new Set();
  let directoryCount = 0;
  let fileCount = 0;
  let reviewsDirectory;
  try {
    reviewsDirectory = await opendir(reviewsRoot);
    for await (const entry of reviewsDirectory) {
      assertTime(startedAt);
      directoryCount += 1;
      if (directoryCount > REVIEW_LIMITS.maxDecisionDirectories) {
        fail("REVIEW_DISCOVERY_LIMIT_EXCEEDED");
      }
      if (!safeSegment(entry.name)) fail("REVIEW_STRUCTURE_UNSAFE");
      const decisionPath = path.join(reviewsRoot, entry.name);
      const decisionInfo = await safeLstat(decisionPath);
      const decisionStat = statRecord(decisionInfo);
      if (
        decisionStat.type !== "directory" ||
        decisionInfo.isSymbolicLink()
      ) {
        fail("REVIEW_STRUCTURE_UNSAFE");
      }
      if (!identityAvailable(decisionStat)) {
        fail("REVIEW_PLATFORM_IDENTITY_UNAVAILABLE");
      }
      await assertDirectoryPath(decisionPath);

      const files = [];
      let decisionDirectory;
      try {
        decisionDirectory = await opendir(decisionPath);
        for await (const fileEntry of decisionDirectory) {
          assertTime(startedAt);
          fileCount += 1;
          if (fileCount > REVIEW_LIMITS.maxReceiptFiles) {
            fail("REVIEW_DISCOVERY_LIMIT_EXCEEDED");
          }
          const match = fileEntry.name.match(RECEIPT_FILE);
          if (!match || !safeSegment(match[1])) {
            fail("REVIEW_STRUCTURE_UNSAFE");
          }
          const receiptPath = path.join(decisionPath, fileEntry.name);
          const receiptInfo = await safeLstat(receiptPath);
          const receiptStat = statRecord(receiptInfo);
          if (
            receiptStat.type !== "file" ||
            receiptInfo.isSymbolicLink() ||
            receiptInfo.nlink > 1n
          ) {
            fail("REVIEW_PATH_UNSAFE");
          }
          if (!identityAvailable(receiptStat)) {
            fail("REVIEW_PLATFORM_IDENTITY_UNAVAILABLE");
          }
          const physicalId = `${receiptStat.dev}:${receiptStat.ino}`;
          if (physical.has(physicalId)) fail("REVIEW_PATH_UNSAFE");
          physical.add(physicalId);
          const portablePath = `reviews/${entry.name}/${fileEntry.name}`;
          const candidate = {
            absolutePath: receiptPath,
            portablePath,
            decisionId: entry.name,
            receiptId: match[1],
            stat: receiptStat,
          };
          files.push({ name: fileEntry.name, stat: receiptStat });
          candidates.push(candidate);
        }
      } catch (error) {
        if (error instanceof ReviewFailure) throw error;
        fail("REVIEW_STRUCTURE_UNSAFE");
      } finally {
        await decisionDirectory?.close().catch(() => {});
      }
      files.sort((left, right) => comparePortable(left.name, right.name));
      decisions.push({ name: entry.name, stat: decisionStat, files });
    }
  } catch (error) {
    if (error instanceof ReviewFailure) throw error;
    fail("REVIEW_STRUCTURE_UNSAFE");
  } finally {
    await reviewsDirectory?.close().catch(() => {});
  }
  decisions.sort((left, right) => comparePortable(left.name, right.name));
  candidates.sort((left, right) =>
    comparePortable(left.portablePath, right.portablePath),
  );
  const persistentBytes =
    128 * decisions.length +
    256 * candidates.length +
    192 * (decisions.length + candidates.length) +
    decisions.reduce((sum, item) => sum + Buffer.byteLength(item.name, "utf8"), 0) +
    candidates.reduce(
      (sum, item) => sum + Buffer.byteLength(item.portablePath, "utf8"),
      0,
    );
  assertMemory(persistentBytes);
  return deepFreeze({
    missing: false,
    manifest: { workspace, reviews, decisions },
    candidates,
    decisionCount: decisions.length,
    persistentBytes,
  });
}

function sameManifest(left, right) {
  return JSON.stringify(left.manifest) === JSON.stringify(right.manifest);
}

async function revalidateManifest(workspaceRoot, initial, startedAt) {
  let observed;
  try {
    observed = await enumerateManifest(workspaceRoot, startedAt);
  } catch (error) {
    if (
      error instanceof ReviewFailure &&
      error.code === "REVIEW_TIME_LIMIT_EXCEEDED"
    ) {
      throw error;
    }
    fail("REVIEW_CAPTURE_RACE");
  }
  if (!sameManifest(initial, observed)) fail("REVIEW_CAPTURE_RACE");
  return observed;
}

async function readCandidate(workspaceRoot, initial, candidate, startedAt) {
  let handle;
  try {
    handle = await open(candidate.absolutePath, "r");
    const beforeHandle = statRecord(await handle.stat({ bigint: true }));
    if (!sameStat(beforeHandle, candidate.stat) || beforeHandle.nlink !== "1") {
      fail("REVIEW_CAPTURE_RACE");
    }
    let preRead;
    try {
      preRead = await enumerateManifest(workspaceRoot, startedAt);
    } catch (error) {
      if (error instanceof ReviewFailure && error.code === "REVIEW_TIME_LIMIT_EXCEEDED") {
        throw error;
      }
      fail("REVIEW_CAPTURE_RACE");
    }
    if (!sameManifest(initial, preRead)) fail("REVIEW_CAPTURE_RACE");

    assertTime(startedAt);
    const expectedSize = Number(candidate.stat.size);
    const content = Buffer.allocUnsafe(expectedSize);
    let offset = 0;
    while (offset < expectedSize) {
      assertTime(startedAt);
      const { bytesRead } = await handle.read(
        content,
        offset,
        expectedSize - offset,
        offset,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset !== expectedSize) fail("REVIEW_CAPTURE_RACE");
    const afterHandle = statRecord(await handle.stat({ bigint: true }));
    const afterPath = statRecord(await safeLstat(candidate.absolutePath));
    if (
      !sameStat(beforeHandle, afterHandle) ||
      !sameStat(afterHandle, afterPath)
    ) {
      fail("REVIEW_CAPTURE_RACE");
    }
    let afterTree;
    try {
      afterTree = await enumerateManifest(workspaceRoot, startedAt);
    } catch (error) {
      if (error instanceof ReviewFailure && error.code === "REVIEW_TIME_LIMIT_EXCEEDED") {
        throw error;
      }
      fail("REVIEW_CAPTURE_RACE");
    }
    if (!sameManifest(initial, afterTree)) fail("REVIEW_CAPTURE_RACE");
    return content;
  } catch (error) {
    if (
      error instanceof ReviewFailure &&
      error.code === "REVIEW_TIME_LIMIT_EXCEEDED"
    ) {
      throw error;
    }
    fail("REVIEW_CAPTURE_RACE");
  } finally {
    await handle?.close().catch(() => {});
  }
}

function reduceReceipt(receipt, identities) {
  const privacy = {
    redacted_fields: 0,
    truncated_fields: 0,
    omitted_fields: 0,
  };
  return {
    privacy,
    review: {
      decision_id: receipt.decision_id,
      receipt_id: receipt.receipt_id,
      receipt_type: receipt.receipt_type,
      declared_role: receipt.role,
      declared_isolation: receipt.isolation,
      advisory: true,
      input_canonical_root_sha256: receipt.input_root_sha256,
      resulting_canonical_root_sha256: receipt.resulting_root_sha256,
      input_canonical_digest_match:
        receipt.input_root_sha256 === identities.canonical_root_sha256,
      resulting_canonical_digest_match:
        receipt.resulting_root_sha256 === null
          ? null
          : receipt.resulting_root_sha256 === identities.canonical_root_sha256,
      findings: receipt.findings.map((finding) => ({
        finding_id: finding.finding_id,
        severity: finding.severity,
        summary: reduceText(finding.summary, privacy),
        evidence_refs: finding.evidence_refs
          .map((value) => reduceText(value, privacy, { omitClassified: true }))
          .filter((value) => value !== null),
      })),
      alternatives: receipt.alternatives.map((value) =>
        reduceText(value, privacy),
      ),
      limitations: receipt.limitations.map((value) =>
        reduceText(value, privacy),
      ),
      reviewed_receipts: [...receipt.reviewed_receipts],
    },
  };
}

function finalizeReviewIds(receipts, privacy) {
  const sorted = [...receipts].sort((left, right) => {
    const decision = comparePortable(
      left.review.decision_id,
      right.review.decision_id,
    );
    return decision !== 0
      ? decision
      : comparePortable(left.review.receipt_id, right.review.receipt_id);
  });
  const decisionMap = new Map();
  const receiptMap = new Map();
  const findingMap = new Map();
  let decisionOrdinal = 0;
  let receiptOrdinal = 0;
  let findingOrdinal = 0;
  for (const item of sorted) {
    const review = item.review;
    if (isSensitiveId(review.decision_id) && !decisionMap.has(review.decision_id)) {
      decisionOrdinal += 1;
      decisionMap.set(review.decision_id, `~d${String(decisionOrdinal).padStart(6, "0")}`);
    }
    const receiptKey = `${review.decision_id}\0${review.receipt_id}`;
    if (isSensitiveId(review.receipt_id) && !receiptMap.has(receiptKey)) {
      receiptOrdinal += 1;
      receiptMap.set(receiptKey, `~r${String(receiptOrdinal).padStart(6, "0")}`);
    }
    for (const finding of review.findings) {
      const findingKey = `${receiptKey}\0${finding.finding_id}`;
      if (isSensitiveId(finding.finding_id) && !findingMap.has(findingKey)) {
        findingOrdinal += 1;
        findingMap.set(findingKey, `~f${String(findingOrdinal).padStart(6, "0")}`);
      }
    }
  }

  function mapped(value, map, key) {
    const output = map.get(key) ?? value;
    if (output !== value) privacy.redacted_fields += 1;
    return output;
  }

  return sorted.map((item) => {
    const review = item.review;
    const receiptKey = `${review.decision_id}\0${review.receipt_id}`;
    return {
      decision_id: mapped(review.decision_id, decisionMap, review.decision_id),
      receipt_id: mapped(review.receipt_id, receiptMap, receiptKey),
      receipt_type: review.receipt_type,
      declared_role: review.declared_role,
      declared_isolation: review.declared_isolation,
      advisory: true,
      input_canonical_root_sha256: review.input_canonical_root_sha256,
      resulting_canonical_root_sha256: review.resulting_canonical_root_sha256,
      input_canonical_digest_match: review.input_canonical_digest_match,
      resulting_canonical_digest_match: review.resulting_canonical_digest_match,
      findings: review.findings.map((finding) => {
        const findingKey = `${receiptKey}\0${finding.finding_id}`;
        return {
          finding_id: mapped(finding.finding_id, findingMap, findingKey),
          severity: finding.severity,
          summary: finding.summary,
          evidence_refs: finding.evidence_refs,
        };
      }),
      alternatives: review.alternatives,
      limitations: review.limitations,
      reviewed_receipts: review.reviewed_receipts.map((value) => {
        const key = `${review.decision_id}\0${value}`;
        return mapped(value, receiptMap, key);
      }),
    };
  });
}

function sourceId(contextId, privacy) {
  if (!SAFE_PUBLIC_ID.test(contextId) || isSensitiveId(contextId)) {
    privacy.redacted_fields += 1;
    return null;
  }
  return contextId;
}

function finalizeProjection(
  base,
  { allowProjectionFallback = true, accountedBaseBytes = 0 } = {},
) {
  const projection = { ...base, projection_sha256: "0".repeat(64) };
  let size;
  try {
    size = projectionJsonByteLength(
      projection,
      REVIEW_LIMITS.maxProjectionBytes,
    );
  } catch (error) {
    if (
      error instanceof ReviewFailure &&
      error.code === "REVIEW_PROJECTION_LIMIT_EXCEEDED" &&
      allowProjectionFallback
    ) {
      return unavailableProjection(
        {
          domain: base.source.domain,
          context_id: base.source.id ?? "invalid-context",
          canonical_root_sha256: base.source.canonical_root_sha256,
          snapshot_sha256: base.source.snapshot_sha256,
        },
        "REVIEW_PROJECTION_LIMIT_EXCEEDED",
        { preserveSourceId: base.source.id },
      );
    }
    throw error;
  }
  assertMemory(
    accountedBaseBytes +
      size +
      REVIEW_LIMITS.maxDisplayFieldBytes * 4 +
      4_096,
  );
  projection.projection_sha256 = projectionDigest(projection);
  return deepFreeze(projection);
}

function unavailableProjection(
  identities,
  code,
  { preserveSourceId = undefined } = {},
) {
  const privacy = {
    redacted_fields: 0,
    truncated_fields: 0,
    omitted_fields: 0,
  };
  const id =
    preserveSourceId === undefined
      ? sourceId(String(identities.context_id ?? ""), privacy)
      : preserveSourceId;
  return finalizeProjection(
    {
      format: REVIEW_LEDGER_FORMAT,
      authority: REVIEW_LEDGER_AUTHORITY,
      producer: { ...REVIEW_LEDGER_PRODUCER },
      source: {
        domain: identities.domain,
        id,
        canonical_root_sha256: identities.canonical_root_sha256,
        snapshot_sha256: identities.snapshot_sha256,
      },
      ledger: {
        status: "unavailable",
        receipt_set_sha256: null,
        discovered_count: null,
        valid_count: null,
        omitted_count: null,
        diagnostics: [diagnostic(code)],
      },
      reviews: [],
      privacy,
    },
    { allowProjectionFallback: false },
  );
}

function validateIdentities(identities) {
  return (
    exactKeys(identities, [
      "domain",
      "context_id",
      "canonical_root_sha256",
      "snapshot_sha256",
    ]) &&
    new Set(["project", "audit"]).has(identities.domain) &&
    typeof identities.context_id === "string" &&
    identities.context_id.length > 0 &&
    HEX_64.test(identities.canonical_root_sha256) &&
    HEX_64.test(identities.snapshot_sha256)
  );
}

export async function readReviewLedger(workspaceRoot, identities) {
  if (typeof workspaceRoot !== "string" || !validateIdentities(identities)) {
    return unavailableProjection(
      {
        domain: new Set(["project", "audit"]).has(identities?.domain)
          ? identities.domain
          : "project",
        context_id: "invalid-context",
        canonical_root_sha256: HEX_64.test(identities?.canonical_root_sha256 ?? "")
          ? identities.canonical_root_sha256
          : "0".repeat(64),
        snapshot_sha256: HEX_64.test(identities?.snapshot_sha256 ?? "")
          ? identities.snapshot_sha256
          : "0".repeat(64),
      },
      "REVIEW_STRUCTURE_UNSAFE",
    );
  }
  const startedAt = performance.now();
  try {
    const initial = await enumerateManifest(workspaceRoot, startedAt);
    await revalidateManifest(workspaceRoot, initial, startedAt);
    if (initial.missing) {
      await revalidateManifest(workspaceRoot, initial, startedAt);
      const privacy = {
        redacted_fields: 0,
        truncated_fields: 0,
        omitted_fields: 0,
      };
      const output = finalizeProjection(
        {
          format: REVIEW_LEDGER_FORMAT,
          authority: REVIEW_LEDGER_AUTHORITY,
          producer: { ...REVIEW_LEDGER_PRODUCER },
          source: {
            domain: identities.domain,
            id: sourceId(identities.context_id, privacy),
            canonical_root_sha256: identities.canonical_root_sha256,
            snapshot_sha256: identities.snapshot_sha256,
          },
          ledger: {
            status: "available",
            receipt_set_sha256: EMPTY_SET_SHA256,
            discovered_count: 0,
            valid_count: 0,
            omitted_count: 0,
            diagnostics: [],
          },
          reviews: [],
          privacy,
        },
        { accountedBaseBytes: initial.persistentBytes ?? 0 },
      );
      assertTime(startedAt);
      return output;
    }

    let declaredAggregateBytes = 0;
    for (const candidate of initial.candidates) {
      const size = Number(candidate.stat.size);
      if (size <= REVIEW_LIMITS.maxReceiptBytes) {
        declaredAggregateBytes += size;
        if (declaredAggregateBytes > REVIEW_LIMITS.maxAggregateReceiptBytes) {
          fail("REVIEW_LEDGER_SIZE_LIMIT_EXCEEDED");
        }
      }
    }

    const warnings = [];
    const retained = [];
    let aggregateBytes = 0;
    let aggregateNodes = 0;
    let persistentBytes = initial.persistentBytes ?? 0;
    for (const candidate of initial.candidates) {
      assertTime(startedAt);
      const size = Number(candidate.stat.size);
      if (size > REVIEW_LIMITS.maxReceiptBytes) {
        warnings.push("REVIEW_ENTRY_TOO_LARGE");
        continue;
      }
      aggregateBytes += size;
      if (aggregateBytes > REVIEW_LIMITS.maxAggregateReceiptBytes) {
        fail("REVIEW_LEDGER_SIZE_LIMIT_EXCEEDED");
      }
      assertMemory(
        accountedReviewPeak(size, persistentBytes),
      );
      const content = await readCandidate(
        workspaceRoot,
        initial,
        candidate,
        startedAt,
      );
      try {
        const result = parseReviewReceiptBytes(content);
        aggregateNodes += result.nodes;
        if (aggregateNodes > REVIEW_LIMITS.maxJsonNodesAggregate) {
          fail("REVIEW_MEMORY_LIMIT_EXCEEDED");
        }
        if (!validateReceiptDocument(result.document, candidate, identities)) {
          warnings.push("REVIEW_ENTRY_INVALID");
          continue;
        }
        const reduced = reduceReceipt(result.document, identities);
        const retainedBytes =
          Buffer.byteLength(JSON.stringify(reduced.review), "utf8") +
          Buffer.byteLength(candidate.portablePath, "utf8") +
          192;
        assertMemory(persistentBytes + retainedBytes);
        persistentBytes += retainedBytes;
        retained.push({
          decision_id: result.document.decision_id,
          receipt_id: result.document.receipt_id,
          receipt_type: result.document.receipt_type,
          input_root_sha256: result.document.input_root_sha256,
          reviewed_receipts: [...result.document.reviewed_receipts],
          review: reduced.review,
          privacy: reduced.privacy,
          portable_path: candidate.portablePath,
          content_sha256: createHash("sha256").update(content).digest("hex"),
        });
      } catch (error) {
        if (
          error instanceof ReviewFailure &&
          error.code === "REVIEW_ENTRY_JSON_LIMIT_EXCEEDED"
        ) {
          warnings.push(error.code);
          continue;
        }
        if (
          error instanceof ReviewFailure &&
          error.code === "REVIEW_ENTRY_INVALID"
        ) {
          warnings.push(error.code);
          continue;
        }
        throw error;
      }
    }

    const originals = new Map();
    for (const item of retained) {
      if (item.receipt_type === "reconciliation") continue;
      const key = `${item.decision_id}\0${item.input_root_sha256}\0${item.receipt_id}`;
      const values = originals.get(key) ?? [];
      values.push(item);
      originals.set(key, values);
    }
    const validated = [];
    for (const item of retained) {
      if (item.receipt_type !== "reconciliation") {
        validated.push(item);
        continue;
      }
      const valid = item.reviewed_receipts.every((receiptId) => {
        const key = `${item.decision_id}\0${item.input_root_sha256}\0${receiptId}`;
        return (originals.get(key) ?? []).length === 1;
      });
      if (!valid) warnings.push("REVIEW_ENTRY_INVALID");
      else validated.push(item);
    }

    await revalidateManifest(workspaceRoot, initial, startedAt);

    const privacy = {
      redacted_fields: 0,
      truncated_fields: 0,
      omitted_fields: 0,
    };
    for (const item of validated) {
      privacy.redacted_fields += item.privacy.redacted_fields;
      privacy.truncated_fields += item.privacy.truncated_fields;
      privacy.omitted_fields += item.privacy.omitted_fields;
    }
    const reviews = finalizeReviewIds(validated, privacy);
    const diagnostics = sortedDiagnostics(warnings);
    const status = diagnostics.length === 0 ? "available" : "degraded";
    const discoveredCount = initial.candidates.length;
    const projection = finalizeProjection(
      {
        format: REVIEW_LEDGER_FORMAT,
        authority: REVIEW_LEDGER_AUTHORITY,
        producer: { ...REVIEW_LEDGER_PRODUCER },
        source: {
          domain: identities.domain,
          id: sourceId(identities.context_id, privacy),
          canonical_root_sha256: identities.canonical_root_sha256,
          snapshot_sha256: identities.snapshot_sha256,
        },
        ledger: {
          status,
          receipt_set_sha256: receiptSetDigest(validated),
          discovered_count: discoveredCount,
          valid_count: validated.length,
          omitted_count: discoveredCount - validated.length,
          diagnostics,
        },
        reviews,
        privacy,
      },
      {
        accountedBaseBytes: persistentBytes + validated.length * 192,
      },
    );
    assertTime(startedAt);
    return projection;
  } catch (error) {
    if (error instanceof ReviewFailure) {
      return unavailableProjection(identities, error.code);
    }
    throw error;
  }
}
