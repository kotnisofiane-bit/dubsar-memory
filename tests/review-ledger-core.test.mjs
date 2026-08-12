import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  cp,
  link,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  inspectWorkspace,
  inspectWorkspaceWithReviews,
  stableJson,
} from "../packages/dubsar-operator-core/src/index.mjs";
import {
  REVIEW_LIMITS,
  accountedReviewPeak,
  classifyReviewText,
  parseReviewReceiptBytes,
  projectionDigest,
  projectionJsonByteLength,
  projectionPreimage,
  receiptSetDigest,
  receiptSetPreimage,
  readReviewLedger,
  reviewMemoryBudgetExceeded,
  reviewTimeBudgetExceeded,
} from "../packages/dubsar-operator-core/src/review-ledger.mjs";
import { currentAuditRootDigest } from "../packages/dubsar-audit-readiness/scripts/record-review-receipt.mjs";
import { currentProjectRootDigest } from "../legacy/hermes-skills/dubsar-project-continuity/scripts/record-review-receipt.mjs";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const vectors = JSON.parse(
  await readFile(
    path.join(repositoryRoot, "docs", "DUBSAR_REVIEW_LEDGER_VECTORS.json"),
    "utf8",
  ),
);

async function fixtureWorkspace(t, domain) {
  const root = await mkdtemp(path.join(tmpdir(), `dubsar-ledger-${domain}-`));
  t.after(async () => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, ".git"));
  const marker = domain === "project" ? ".dubsar-project" : ".dubsar-audit";
  const source = path.join(
    repositoryRoot,
    "examples",
    domain === "project" ? "project-continuity" : "audit-readiness",
  );
  const workspace = path.join(root, marker);
  await cp(source, workspace, { recursive: true });
  await rm(path.join(workspace, "reviews"), { recursive: true, force: true });
  return { root, workspace, domain };
}

function contextId(inspection) {
  return inspection.snapshot.domain === "project"
    ? inspection.snapshot.documents["mission.json"].mission_id
    : inspection.snapshot.documents["audit-scope.json"].case_id;
}

function receiptFor(inspection, overrides = {}) {
  const domain = inspection.snapshot.domain;
  return {
    format: "dubsar.review-receipt/1",
    context_kind: domain === "project" ? "project-mission" : "audit-case",
    context_id: contextId(inspection),
    decision_id: "decision-001",
    receipt_id: "review-001",
    receipt_type: "domain-review",
    role: "architecture",
    isolation: "isolated-subagent",
    advisory: true,
    input_root_sha256:
      inspection.review_ledger.source.canonical_root_sha256,
    resulting_root_sha256: null,
    findings: [
      {
        finding_id: "finding-001",
        severity: "medium",
        summary: "A bounded advisory observation.",
        evidence_refs: ["mission.json#risks"],
      },
    ],
    alternatives: ["Keep the existing local boundary."],
    limitations: ["No external runtime was inspected."],
    reviewed_receipts: [],
    ...overrides,
  };
}

async function writeReceipt(workspace, receipt, bytes = null, names = {}) {
  const decisionId = names.decisionId ?? receipt.decision_id;
  const receiptId = names.receiptId ?? receipt.receipt_id;
  const directory = path.join(workspace, "reviews", decisionId);
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, `${receiptId}.json`),
    bytes ?? `${JSON.stringify(receipt, null, 2)}\n`,
  );
}

function independentReceiptPreimage(records) {
  const body = [...records]
    .sort((left, right) =>
      left.portable_path < right.portable_path
        ? -1
        : left.portable_path > right.portable_path
          ? 1
          : 0,
    )
    .map((record) => `${record.content_sha256}  ${record.portable_path}\n`)
    .join("");
  return Buffer.concat([
    Buffer.from("dubsar.review-ledger-receipt-set/1\0", "utf8"),
    Buffer.from(body, "utf8"),
  ]);
}

const objectOrders = new Map([
  ["$", ["format", "authority", "producer", "source", "ledger", "reviews", "privacy", "projection_sha256"]],
  ["$/producer", ["name", "version"]],
  ["$/source", ["domain", "id", "canonical_root_sha256", "snapshot_sha256"]],
  ["$/ledger", ["status", "receipt_set_sha256", "discovered_count", "valid_count", "omitted_count", "diagnostics"]],
  ["$/privacy", ["redacted_fields", "truncated_fields", "omitted_fields"]],
]);
const reviewOrder = [
  "decision_id", "receipt_id", "receipt_type", "declared_role",
  "declared_isolation", "advisory", "input_canonical_root_sha256",
  "resulting_canonical_root_sha256", "input_canonical_digest_match",
  "resulting_canonical_digest_match", "findings", "alternatives",
  "limitations", "reviewed_receipts",
];
const findingOrder = ["finding_id", "severity", "summary", "evidence_refs"];

function independentProjectionPreimage(projection) {
  const records = [];
  const encode = (type, schemaPath, bytes) =>
    Buffer.from(`${type}\t${schemaPath}\t${bytes.length}\t${bytes.toString("hex")}\n`, "utf8");
  function visit(value, schemaPath) {
    if (value === null) {
      records.push(encode("null", schemaPath, Buffer.alloc(0)));
    } else if (Array.isArray(value)) {
      records.push(encode("array", schemaPath, Buffer.from(String(value.length))));
      value.forEach((child, index) =>
        visit(child, `${schemaPath}/${String(index).padStart(6, "0")}`),
      );
    } else if (typeof value === "object") {
      records.push(encode("object", schemaPath, Buffer.alloc(0)));
      const order = objectOrders.get(schemaPath) ??
        (/^\$\/ledger\/diagnostics\/\d{6}$/u.test(schemaPath)
          ? ["code", "severity"]
          : /^\$\/reviews\/\d{6}\/findings\/\d{6}$/u.test(schemaPath)
            ? findingOrder
            : /^\$\/reviews\/\d{6}$/u.test(schemaPath)
              ? reviewOrder
              : null);
      assert.ok(order, `closed projection schema path ${schemaPath}`);
      for (const key of order) {
        if (schemaPath === "$" && key === "projection_sha256") continue;
        visit(value[key], `${schemaPath}/${key}`);
      }
    } else {
      const type = typeof value === "string"
        ? "string"
        : typeof value === "boolean"
          ? "boolean"
          : "integer";
      records.push(encode(type, schemaPath, Buffer.from(String(value), "utf8")));
    }
  }
  visit(projection, "$");
  return Buffer.concat([
    Buffer.from("dubsar.review-ledger-projection/1\0", "utf8"),
    ...records,
  ]);
}

test("all frozen digest and projection vectors are reproduced independently", () => {
  assert.equal(vectors.digest_vectors.length, 4);
  assert.equal(vectors.projection_vectors.length, 7);
  for (const vector of vectors.digest_vectors) {
    const records = vector.records.map((record) => ({
      portable_path: record.portable_path,
      content_sha256: record.content_sha256,
    }));
    const independent = independentReceiptPreimage(records);
    assert.equal(independent.toString("hex"), vector.expected_preimage_utf8_hex);
    assert.equal(receiptSetPreimage(records).toString("hex"), vector.expected_preimage_utf8_hex);
    assert.equal(receiptSetDigest(records), vector.expected_sha256);
    assert.equal(createHash("sha256").update(independent).digest("hex"), vector.expected_sha256);
  }
  for (const vector of vectors.projection_vectors) {
    const independent = independentProjectionPreimage(vector.projection);
    assert.equal(independent.toString("hex"), vector.expected_preimage_utf8_hex);
    assert.equal(projectionPreimage(vector.projection).toString("hex"), vector.expected_preimage_utf8_hex);
    assert.equal(projectionDigest(vector.projection), vector.expected_projection_sha256);
    assert.equal(
      projectionJsonByteLength(vector.projection),
      Buffer.byteLength(JSON.stringify(vector.projection), "utf8"),
    );
    assert.equal(createHash("sha256").update(independent).digest("hex"), vector.expected_projection_sha256);
  }
});

test("the opt-in API preserves canonical truth for empty project and audit ledgers", async (t) => {
  for (const domain of ["project", "audit"]) {
    await t.test(domain, async (subtest) => {
      const fixture = await fixtureWorkspace(subtest, domain);
      const canonical = await inspectWorkspace({ start: fixture.root, domain });
      const advisory = await inspectWorkspaceWithReviews({ start: fixture.root, domain });
      assert.deepEqual(Object.keys(advisory), [
        "location", "snapshot", "evaluation", "view", "graph", "review_ledger",
      ]);
      assert.equal(Object.isFrozen(advisory), true);
      assert.equal(Object.isFrozen(advisory.review_ledger), true);
      assert.deepEqual(advisory.location, canonical.location);
      assert.deepEqual(advisory.snapshot, canonical.snapshot);
      assert.deepEqual(advisory.evaluation, canonical.evaluation);
      assert.deepEqual(advisory.view, canonical.view);
      assert.deepEqual(advisory.graph, canonical.graph);
      assert.equal(advisory.review_ledger.ledger.status, "available");
      assert.equal(
        advisory.review_ledger.ledger.receipt_set_sha256,
        "f2568437de4befaeb9899c784a73f1462ac7da67c3af3610a25f025f0c58d6dc",
      );
      assert.deepEqual(
        [
          advisory.review_ledger.ledger.discovered_count,
          advisory.review_ledger.ledger.valid_count,
          advisory.review_ledger.ledger.omitted_count,
        ],
        [0, 0, 0],
      );
      assert.equal(stableJson(advisory.review_ledger).includes(fixture.root), false);
      const recorderRoot = domain === "project"
        ? await currentProjectRootDigest(fixture.workspace)
        : await currentAuditRootDigest(fixture.workspace);
      assert.equal(
        advisory.review_ledger.source.canonical_root_sha256,
        recorderRoot,
      );
    });
  }
});

test("matching, historical, and direct reconciliation entries remain advisory and visible", async (t) => {
  const fixture = await fixtureWorkspace(t, "project");
  const empty = await inspectWorkspaceWithReviews({ start: fixture.root, domain: "project" });
  const currentRoot = empty.review_ledger.source.canonical_root_sha256;
  const historicalRoot = "1".repeat(64);
  await writeReceipt(fixture.workspace, receiptFor(empty, {
    receipt_id: "review-current-001",
  }));
  await writeReceipt(fixture.workspace, receiptFor(empty, {
    receipt_id: "review-history-001",
    input_root_sha256: historicalRoot,
    findings: [{
      finding_id: "finding-history-001",
      severity: "high",
      summary: "Historical objection remains visible.",
      evidence_refs: [],
    }],
  }));
  await writeReceipt(fixture.workspace, receiptFor(empty, {
    receipt_id: "reconcile-history-001",
    receipt_type: "reconciliation",
    role: "principal",
    isolation: "self-check",
    input_root_sha256: historicalRoot,
    resulting_root_sha256: currentRoot,
    findings: [],
    reviewed_receipts: ["review-history-001"],
  }));
  const result = await inspectWorkspaceWithReviews({ start: fixture.root, domain: "project" });
  assert.equal(result.review_ledger.ledger.status, "available");
  assert.equal(result.review_ledger.reviews.length, 3);
  const current = result.review_ledger.reviews.find((item) => item.receipt_id === "review-current-001");
  const historical = result.review_ledger.reviews.find((item) => item.receipt_id === "review-history-001");
  const reconciliation = result.review_ledger.reviews.find((item) => item.receipt_id === "reconcile-history-001");
  assert.equal(current.input_canonical_digest_match, true);
  assert.equal(historical.input_canonical_digest_match, false);
  assert.deepEqual(reconciliation.reviewed_receipts, ["review-history-001"]);
  assert.equal(reconciliation.input_canonical_digest_match, false);
  assert.equal(reconciliation.resulting_canonical_digest_match, true);
  assert.equal(historical.findings[0].summary, "Historical objection remains visible.");
  assert.equal(result.view.integrity.status, empty.view.integrity.status);
  assert.equal(result.view.readiness.status, empty.view.readiness.status);
});

test("an audit receipt uses canonical JSON freshness, not the full artifact snapshot identity", async (t) => {
  const fixture = await fixtureWorkspace(t, "audit");
  const empty = await inspectWorkspaceWithReviews({ start: fixture.root, domain: "audit" });
  await writeReceipt(fixture.workspace, receiptFor(empty, {
    decision_id: "audit-scope-001",
    receipt_id: "audit-review-001",
    role: "security",
  }));
  const result = await inspectWorkspaceWithReviews({ start: fixture.root, domain: "audit" });
  assert.equal(result.review_ledger.ledger.status, "available");
  assert.equal(result.review_ledger.reviews.length, 1);
  assert.equal(result.review_ledger.reviews[0].input_canonical_digest_match, true);
  assert.equal(
    result.review_ledger.reviews[0].input_canonical_root_sha256,
    result.review_ledger.source.canonical_root_sha256,
  );
  assert.equal(result.snapshot.snapshot_sha256, result.review_ledger.source.snapshot_sha256);
});

test("bounded malformed entries degrade without suppressing independent valid entries", async (t) => {
  const cases = [
    ["malformed-001", Buffer.from("{not-json", "utf8")],
    ["duplicate-key-001", Buffer.from('{"format":"dubsar.review-receipt/1","format":"duplicate"}', "utf8")],
    ["invalid-utf8-001", Buffer.from([0xc3, 0x28])],
    ["surrogate-001", Buffer.from('{"value":"\\uD800"}', "utf8")],
  ];
  for (const [receiptId, bytes] of cases) {
    await t.test(receiptId, async (subtest) => {
      const fixture = await fixtureWorkspace(subtest, "project");
      const empty = await inspectWorkspaceWithReviews({ start: fixture.root, domain: "project" });
      await writeReceipt(fixture.workspace, receiptFor(empty));
      await writeReceipt(
        fixture.workspace,
        receiptFor(empty, { receipt_id: receiptId }),
        bytes,
      );
      const result = await inspectWorkspaceWithReviews({ start: fixture.root, domain: "project" });
      assert.equal(result.review_ledger.ledger.status, "degraded");
      assert.deepEqual(result.review_ledger.ledger.diagnostics, [
        { code: "REVIEW_ENTRY_INVALID", severity: "warning" },
      ]);
      assert.deepEqual(
        [result.review_ledger.ledger.discovered_count, result.review_ledger.ledger.valid_count, result.review_ledger.ledger.omitted_count],
        [2, 1, 1],
      );
      assert.deepEqual(result.review_ledger.reviews.map((item) => item.receipt_id), ["review-001"]);
    });
  }
});

test("credential-shaped receipt material is omitted without echoing source text", async (t) => {
  const fixture = await fixtureWorkspace(t, "project");
  const empty = await inspectWorkspaceWithReviews({ start: fixture.root, domain: "project" });
  await writeReceipt(fixture.workspace, receiptFor(empty));
  const invalid = receiptFor(empty, {
    receipt_id: "credential-shaped-001",
    limitations: ["Bearer SYNTHETICAAAAAAAAAAAA"],
  });
  await writeReceipt(fixture.workspace, invalid);
  const result = await inspectWorkspaceWithReviews({ start: fixture.root, domain: "project" });
  assert.equal(result.review_ledger.ledger.status, "degraded");
  assert.deepEqual(result.review_ledger.reviews.map((item) => item.receipt_id), ["review-001"]);
  assert.equal(stableJson(result.review_ledger).includes("SYNTHETICAAAAAAAAAAAA"), false);
  assert.deepEqual(result.review_ledger.ledger.diagnostics, [
    { code: "REVIEW_ENTRY_INVALID", severity: "warning" },
  ]);
});

test("path-content, duplicate findings, and ambiguous lineage omit only invalid receipts", async (t) => {
  const fixture = await fixtureWorkspace(t, "project");
  const empty = await inspectWorkspaceWithReviews({ start: fixture.root, domain: "project" });
  await writeReceipt(fixture.workspace, receiptFor(empty));
  await writeReceipt(
    fixture.workspace,
    receiptFor(empty, { receipt_id: "declared-other-001" }),
    null,
    { receiptId: "path-mismatch-001" },
  );
  await writeReceipt(fixture.workspace, receiptFor(empty, {
    receipt_id: "duplicate-findings-001",
    findings: [
      { finding_id: "same-finding-001", severity: "low", summary: "First.", evidence_refs: [] },
      { finding_id: "same-finding-001", severity: "high", summary: "Second.", evidence_refs: [] },
    ],
  }));
  await writeReceipt(fixture.workspace, receiptFor(empty, {
    receipt_id: "reconcile-ambiguous-001",
    receipt_type: "reconciliation",
    role: "principal",
    isolation: "self-check",
    resulting_root_sha256: empty.review_ledger.source.canonical_root_sha256,
    reviewed_receipts: ["review-001", "review-001"],
  }));
  const result = await inspectWorkspaceWithReviews({ start: fixture.root, domain: "project" });
  assert.equal(result.review_ledger.ledger.status, "degraded");
  assert.deepEqual(result.review_ledger.ledger.diagnostics, [
    { code: "REVIEW_ENTRY_INVALID", severity: "warning" },
  ]);
  assert.deepEqual(
    [result.review_ledger.ledger.discovered_count, result.review_ledger.ledger.valid_count, result.review_ledger.ledger.omitted_count],
    [4, 1, 3],
  );
});

test("oversized files are never charged to the retained raw aggregate", async (t) => {
  const fixture = await fixtureWorkspace(t, "project");
  const empty = await inspectWorkspaceWithReviews({ start: fixture.root, domain: "project" });
  await writeReceipt(fixture.workspace, receiptFor(empty));
  const oversized = Buffer.alloc(REVIEW_LIMITS.maxReceiptBytes + 1, 0x20);
  await writeReceipt(
    fixture.workspace,
    receiptFor(empty, { receipt_id: "oversized-001" }),
    oversized,
  );
  const result = await inspectWorkspaceWithReviews({ start: fixture.root, domain: "project" });
  assert.equal(result.review_ledger.ledger.status, "degraded");
  assert.deepEqual(result.review_ledger.ledger.diagnostics, [
    { code: "REVIEW_ENTRY_TOO_LARGE", severity: "warning" },
  ]);
  assert.deepEqual(
    [result.review_ledger.ledger.discovered_count, result.review_ledger.ledger.valid_count, result.review_ledger.ledger.omitted_count],
    [2, 1, 1],
  );
});

test("global receipt-count and aggregate-byte limits publish no partial set", async (t) => {
  await t.test("receipt count", async (subtest) => {
    const fixture = await fixtureWorkspace(subtest, "project");
    await mkdir(path.join(fixture.workspace, "reviews", "decision-001"), { recursive: true });
    for (let index = 0; index <= REVIEW_LIMITS.maxReceiptFiles; index += 1) {
      await writeFile(
        path.join(fixture.workspace, "reviews", "decision-001", `receipt-${String(index).padStart(4, "0")}.json`),
        "{}\n",
      );
    }
    const result = await inspectWorkspaceWithReviews({ start: fixture.root, domain: "project" });
    assert.equal(result.review_ledger.ledger.status, "unavailable");
    assert.equal(result.review_ledger.ledger.receipt_set_sha256, null);
    assert.deepEqual(result.review_ledger.ledger.diagnostics, [
      { code: "REVIEW_DISCOVERY_LIMIT_EXCEEDED", severity: "error" },
    ]);
    assert.deepEqual(result.review_ledger.reviews, []);
  });

  await t.test("aggregate bytes", async (subtest) => {
    const fixture = await fixtureWorkspace(subtest, "project");
    const empty = await inspectWorkspaceWithReviews({ start: fixture.root, domain: "project" });
    const targetSize = 260_000;
    for (let index = 0; index < 33; index += 1) {
      const receiptId = `aggregate-${String(index).padStart(3, "0")}`;
      const receipt = receiptFor(empty, { receipt_id: receiptId });
      const body = Buffer.from(JSON.stringify(receipt), "utf8");
      const padded = Buffer.concat([body, Buffer.alloc(targetSize - body.length, 0x20)]);
      await writeReceipt(fixture.workspace, receipt, padded);
    }
    const result = await inspectWorkspaceWithReviews({ start: fixture.root, domain: "project" });
    assert.equal(result.review_ledger.ledger.status, "unavailable");
    assert.deepEqual(result.review_ledger.ledger.diagnostics, [
      { code: "REVIEW_LEDGER_SIZE_LIMIT_EXCEEDED", severity: "error" },
    ]);
    assert.deepEqual(result.review_ledger.reviews, []);
  });
});

test("unsafe review structures fail closed while default inspection stays unchanged", async (t) => {
  const fixture = await fixtureWorkspace(t, "project");
  const outside = path.join(fixture.root, "outside");
  await mkdir(outside);
  try {
    await symlink(
      outside,
      path.join(fixture.workspace, "reviews"),
      process.platform === "win32" ? "junction" : "dir",
    );
  } catch (error) {
    if (new Set(["EPERM", "EACCES", "ENOTSUP"]).has(error?.code)) {
      t.skip("Directory-link creation is unavailable on this profile.");
      return;
    }
    throw error;
  }
  const canonical = await inspectWorkspace({ start: fixture.root, domain: "project" });
  const advisory = await inspectWorkspaceWithReviews({ start: fixture.root, domain: "project" });
  assert.deepEqual(advisory.snapshot, canonical.snapshot);
  assert.deepEqual(advisory.view, canonical.view);
  assert.equal(advisory.review_ledger.ledger.status, "unavailable");
  assert.deepEqual(advisory.review_ledger.ledger.diagnostics, [
    { code: "REVIEW_PATH_UNSAFE", severity: "error" },
  ]);
  assert.deepEqual(advisory.review_ledger.reviews, []);
});

test("a parent swap after open is rejected before any receipt byte is read", async (t) => {
  const fixture = await fixtureWorkspace(t, "project");
  const empty = await inspectWorkspaceWithReviews({ start: fixture.root, domain: "project" });
  const receipt = receiptFor(empty);
  await writeReceipt(fixture.workspace, receipt);
  const decisionPath = path.join(fixture.workspace, "reviews", receipt.decision_id);
  const movedPath = path.join(fixture.workspace, "reviews", "moved-decision-001");
  const receiptPath = path.join(decisionPath, `${receipt.receipt_id}.json`);
  const probe = await open(receiptPath, "r");
  const fileHandlePrototype = Object.getPrototypeOf(probe);
  await probe.close();
  const originalStat = fileHandlePrototype.stat;
  const originalRead = fileHandlePrototype.read;
  let readCalls = 0;
  let swapped = false;
  fileHandlePrototype.read = async function instrumentedRead(...args) {
    readCalls += 1;
    return originalRead.apply(this, args);
  };
  fileHandlePrototype.stat = async function swapAfterOpenedHandle(...args) {
    const info = await originalStat.apply(this, args);
    if (!swapped) {
      swapped = true;
      await rename(decisionPath, movedPath);
      await mkdir(decisionPath);
      await writeFile(receiptPath, `${JSON.stringify(receipt)}\n`, "utf8");
    }
    return info;
  };
  let result;
  try {
    result = await readReviewLedger(fixture.workspace, Object.freeze({
      domain: "project",
      context_id: contextId(empty),
      canonical_root_sha256: empty.review_ledger.source.canonical_root_sha256,
      snapshot_sha256: empty.snapshot.snapshot_sha256,
    }));
  } catch (error) {
    if (new Set(["EPERM", "EACCES", "EBUSY"]).has(error?.code)) {
      t.skip("The current filesystem cannot perform the bounded parent-swap fixture.");
      return;
    }
    throw error;
  } finally {
    fileHandlePrototype.read = originalRead;
    fileHandlePrototype.stat = originalStat;
  }
  assert.equal(swapped, true);
  assert.equal(readCalls, 0);
  assert.equal(result.ledger.status, "unavailable");
  assert.deepEqual(result.ledger.diagnostics, [
    { code: "REVIEW_CAPTURE_RACE", severity: "error" },
  ]);
  assert.deepEqual(result.reviews, []);
});

test("a mutation after receipt read discards every partial advisory value", async (t) => {
  const fixture = await fixtureWorkspace(t, "project");
  const empty = await inspectWorkspaceWithReviews({ start: fixture.root, domain: "project" });
  const receipt = receiptFor(empty);
  await writeReceipt(fixture.workspace, receipt);
  const receiptPath = path.join(
    fixture.workspace,
    "reviews",
    receipt.decision_id,
    `${receipt.receipt_id}.json`,
  );
  const probe = await open(receiptPath, "r");
  const fileHandlePrototype = Object.getPrototypeOf(probe);
  await probe.close();
  const originalRead = fileHandlePrototype.read;
  let mutated = false;
  fileHandlePrototype.read = async function mutateAfterRead(...args) {
    const result = await originalRead.apply(this, args);
    if (!mutated) {
      mutated = true;
      await writeFile(receiptPath, "{}\n", "utf8");
    }
    return result;
  };
  let result;
  try {
    result = await readReviewLedger(fixture.workspace, Object.freeze({
      domain: "project",
      context_id: contextId(empty),
      canonical_root_sha256: empty.review_ledger.source.canonical_root_sha256,
      snapshot_sha256: empty.snapshot.snapshot_sha256,
    }));
  } finally {
    fileHandlePrototype.read = originalRead;
  }
  assert.equal(mutated, true);
  assert.equal(result.ledger.status, "unavailable");
  assert.deepEqual(result.ledger.diagnostics, [
    { code: "REVIEW_CAPTURE_RACE", severity: "error" },
  ]);
  assert.equal(result.ledger.receipt_set_sha256, null);
  assert.deepEqual(result.reviews, []);
});

test("the monotonic five-second acquisition budget returns a closed unavailable state", async (t) => {
  const fixture = await fixtureWorkspace(t, "project");
  const empty = await inspectWorkspaceWithReviews({ start: fixture.root, domain: "project" });
  const receipt = receiptFor(empty);
  await writeReceipt(fixture.workspace, receipt);
  const receiptPath = path.join(
    fixture.workspace,
    "reviews",
    receipt.decision_id,
    `${receipt.receipt_id}.json`,
  );
  const probe = await open(receiptPath, "r");
  const fileHandlePrototype = Object.getPrototypeOf(probe);
  await probe.close();
  const originalStat = fileHandlePrototype.stat;
  let delayed = false;
  fileHandlePrototype.stat = async function delayedFirstStat(...args) {
    const info = await originalStat.apply(this, args);
    if (!delayed) {
      delayed = true;
      await new Promise((resolve) => setTimeout(resolve, 5_010));
    }
    return info;
  };
  let result;
  try {
    result = await readReviewLedger(fixture.workspace, Object.freeze({
      domain: "project",
      context_id: contextId(empty),
      canonical_root_sha256: empty.review_ledger.source.canonical_root_sha256,
      snapshot_sha256: empty.snapshot.snapshot_sha256,
    }));
  } finally {
    fileHandlePrototype.stat = originalStat;
  }
  assert.equal(delayed, true);
  assert.equal(result.ledger.status, "unavailable");
  assert.deepEqual(result.ledger.diagnostics, [
    { code: "REVIEW_TIME_LIMIT_EXCEEDED", severity: "error" },
  ]);
  assert.deepEqual(result.reviews, []);
});

test("hardlinks, non-files, and non-portable segments are rejected before projection", async (t) => {
  await t.test("duplicate physical identity", async (subtest) => {
    const fixture = await fixtureWorkspace(subtest, "project");
    const empty = await inspectWorkspaceWithReviews({ start: fixture.root, domain: "project" });
    const receipt = receiptFor(empty);
    await writeReceipt(fixture.workspace, receipt);
    const source = path.join(fixture.workspace, "reviews", "decision-001", "review-001.json");
    const alias = path.join(fixture.workspace, "reviews", "decision-001", "review-002.json");
    try {
      await link(source, alias);
    } catch (error) {
      if (new Set(["EPERM", "EACCES", "ENOTSUP"]).has(error?.code)) {
        subtest.skip("Hardlinks are unavailable on this profile.");
        return;
      }
      throw error;
    }
    const result = await inspectWorkspaceWithReviews({ start: fixture.root, domain: "project" });
    assert.equal(result.review_ledger.ledger.status, "unavailable");
    assert.deepEqual(result.review_ledger.ledger.diagnostics, [
      { code: "REVIEW_PATH_UNSAFE", severity: "error" },
    ]);
  });

  await t.test("non-file at receipt depth", async (subtest) => {
    const fixture = await fixtureWorkspace(subtest, "project");
    await mkdir(path.join(fixture.workspace, "reviews", "decision-001", "receipt-001.json"), { recursive: true });
    const result = await inspectWorkspaceWithReviews({ start: fixture.root, domain: "project" });
    assert.equal(result.review_ledger.ledger.status, "unavailable");
    assert.deepEqual(result.review_ledger.ledger.diagnostics, [
      { code: "REVIEW_PATH_UNSAFE", severity: "error" },
    ]);
  });

  await t.test("normalization or case ambiguity", async (subtest) => {
    const fixture = await fixtureWorkspace(subtest, "project");
    await mkdir(path.join(fixture.workspace, "reviews", "Décision-001"), { recursive: true });
    const result = await inspectWorkspaceWithReviews({ start: fixture.root, domain: "project" });
    assert.equal(result.review_ledger.ledger.status, "unavailable");
    assert.deepEqual(result.review_ledger.ledger.diagnostics, [
      { code: "REVIEW_STRUCTURE_UNSAFE", severity: "error" },
    ]);
  });
});

test("sensitive identifiers and text are reduced deterministically with inert lineage", async (t) => {
  const fixture = await fixtureWorkspace(t, "project");
  const empty = await inspectWorkspaceWithReviews({ start: fixture.root, domain: "project" });
  const decisionId = `decision-${"a".repeat(24)}`;
  const originalId = `review-${"b".repeat(24)}`;
  const reconciliationId = `review-${"c".repeat(24)}`;
  await writeReceipt(fixture.workspace, receiptFor(empty, {
    decision_id: decisionId,
    receipt_id: originalId,
    findings: [{
      finding_id: `finding-${"d".repeat(24)}`,
      severity: "high",
      summary: "Contact someone@example.test before <opening> this note.\u202e",
      evidence_refs: ["private/folder/item.json"],
    }],
    alternatives: ["Use local:path only."],
    limitations: ["Identifier 123456789 is synthetic."],
  }));
  await writeReceipt(fixture.workspace, receiptFor(empty, {
    decision_id: decisionId,
    receipt_id: reconciliationId,
    receipt_type: "reconciliation",
    role: "principal",
    isolation: "self-check",
    resulting_root_sha256: empty.review_ledger.source.canonical_root_sha256,
    findings: [],
    reviewed_receipts: [originalId],
  }));
  const first = await inspectWorkspaceWithReviews({ start: fixture.root, domain: "project" });
  const second = await inspectWorkspaceWithReviews({ start: fixture.root, domain: "project" });
  assert.equal(first.review_ledger.ledger.status, "available");
  assert.equal(stableJson(first.review_ledger), stableJson(second.review_ledger));
  assert.deepEqual(first.review_ledger.reviews.map((item) => item.decision_id), ["~d000001", "~d000001"]);
  assert.deepEqual(first.review_ledger.reviews.map((item) => item.receipt_id), ["~r000001", "~r000002"]);
  assert.equal(first.review_ledger.reviews[0].findings[0].finding_id, "~f000001");
  assert.equal(first.review_ledger.reviews[0].findings[0].summary, "[REDACTED:CONTROL_OR_BIDI]");
  assert.deepEqual(first.review_ledger.reviews[0].findings[0].evidence_refs, []);
  assert.deepEqual(first.review_ledger.reviews[1].reviewed_receipts, ["~r000001"]);
  const output = stableJson(first.review_ledger);
  assert.equal(output.includes("someone@example.test"), false);
  assert.equal(output.includes("private/folder"), false);
  assert.equal(output.includes("\u202e"), false);
  assert.ok(first.review_ledger.privacy.redacted_fields > 0);
  assert.ok(first.review_ledger.privacy.omitted_fields > 0);
});

test("projection, time, memory, and UTF-8 scalar budgets fail closed or stay deterministic", async (t) => {
  assert.equal(reviewTimeBudgetExceeded(0, REVIEW_LIMITS.maxElapsedMilliseconds + 1), true);
  assert.equal(reviewTimeBudgetExceeded(0, REVIEW_LIMITS.maxElapsedMilliseconds), false);
  assert.equal(
    reviewMemoryBudgetExceeded(REVIEW_LIMITS.maxReceiptBytes, REVIEW_LIMITS.maxAccountedMemoryBytes),
    true,
  );
  assert.ok(accountedReviewPeak(100, 200, 3) > 300);
  assert.equal(classifyReviewText("plain words only"), null);
  assert.equal(classifyReviewText("safe text\u202e"), "CONTROL_OR_BIDI");
  assert.equal(classifyReviewText("contact@example.test"), "PERSONAL_DATA_SHAPED");
  assert.throws(
    () => parseReviewReceiptBytes(Buffer.from('{"a":1,"a":2}', "utf8")),
    /REVIEW_ENTRY_INVALID/u,
  );

  const fixture = await fixtureWorkspace(t, "project");
  const empty = await inspectWorkspaceWithReviews({ start: fixture.root, domain: "project" });
  const longSafeText = "word ".repeat(390).trim();
  for (let index = 0; index < 6; index += 1) {
    const receiptId = `projection-${String(index).padStart(3, "0")}`;
    await writeReceipt(fixture.workspace, receiptFor(empty, {
      receipt_id: receiptId,
      findings: [],
      alternatives: Array.from({ length: 50 }, () => longSafeText),
      limitations: Array.from({ length: 50 }, () => longSafeText),
    }));
  }
  const result = await inspectWorkspaceWithReviews({ start: fixture.root, domain: "project" });
  assert.equal(result.review_ledger.ledger.status, "unavailable");
  assert.deepEqual(result.review_ledger.ledger.diagnostics, [
    { code: "REVIEW_PROJECTION_LIMIT_EXCEEDED", severity: "error" },
  ]);
  assert.deepEqual(result.review_ledger.reviews, []);
});

test("the behavior-case ledger covers 23 Core cases and defers only two presentation cases", () => {
  const coreOwned = vectors.future_behavior_cases.filter(
    (item) => !new Set([
      "canonical-pressure-preserves-blockers",
      "html-escape-expansion-budget",
    ]).has(item.case_id),
  );
  assert.equal(coreOwned.length, 23);
  assert.deepEqual(
    vectors.future_behavior_cases.slice(-2).map((item) => item.case_id),
    ["canonical-pressure-preserves-blockers", "html-escape-expansion-budget"],
  );
});
