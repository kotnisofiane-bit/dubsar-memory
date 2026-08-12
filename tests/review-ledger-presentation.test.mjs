import assert from "node:assert/strict";
import { get } from "node:http";
import { cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runCli } from "../packages/dubsar-operator-cli/src/cli.mjs";
import {
  renderReviewLedgerReport,
  renderWorkbenchReport,
} from "../packages/dubsar-workbench-report/src/index.mjs";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const vectors = JSON.parse(
  await readFile(
    path.join(repositoryRoot, "docs", "DUBSAR_REVIEW_LEDGER_VECTORS.json"),
    "utf8",
  ),
);

function canonicalView() {
  return {
    format: "dubsar.workbench-view/1",
    authority: "local_preparation_record",
    source: {
      domain: "project",
      id: "mission-synthetic-001",
      formats: ["dubsar.project-mission/1"],
      snapshot_sha256: "b".repeat(64),
    },
    integrity: { status: "valid", diagnostics: [] },
    readiness: { status: "not_ready", reasons: ["SYNTHETIC_BLOCKER"] },
    next_action: { code: "human_review", label: "Human review required." },
    overview: {
      title: "Synthetic Workbench",
      summary: "Synthetic canonical presentation.",
      counts: { blockers: 1 },
    },
    blockers: [
      {
        code: "SYNTHETIC_BLOCKER",
        severity: "warning",
        title: "Canonical blocker remains visible.",
      },
    ],
    evidence: [],
    decisions: [],
    privacy: { redacted_fields: 0, truncated_fields: 0 },
    producer: { name: "@dubsar/operator-cli", version: "0.1.0-dev" },
  };
}

async function projectFixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "dubsar-review-ui-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(path.join(root, ".git"));
  await cp(
    path.join(repositoryRoot, "examples", "project-continuity"),
    path.join(root, ".dubsar-project"),
    { recursive: true },
  );
  return root;
}

async function invoke(argv) {
  let stdout = "";
  let stderr = "";
  const result = await runCli(argv, {
    writeOut(value) {
      stdout += value;
    },
    writeErr(value) {
      stderr += value;
    },
  });
  return { ...result, stdout, stderr };
}

async function getBody(url) {
  return new Promise((resolve, reject) => {
    get(url, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        resolve({ body: Buffer.concat(chunks), status: response.statusCode });
      });
    }).on("error", reject);
  });
}

test("the composite report keeps canonical blockers and labels reviews advisory", () => {
  const view = canonicalView();
  const ledger = vectors.projection_vectors.at(1).projection;
  const canonical = renderWorkbenchReport(view);
  const composite = renderReviewLedgerReport(view, ledger);

  assert.equal(composite.manifest.format, "dubsar.review-ledger-report/1");
  assert.equal(composite.manifest.review_presentation, "full");
  assert.equal(
    composite.manifest.source_canonical_root_sha256,
    ledger.source.canonical_root_sha256,
  );
  assert.match(composite.html, /Canonical blocker remains visible\./u);
  assert.match(
    composite.html,
    /Advisory Review Ledger — available — 1 validé\(s\), 0 omis/u,
  );
  assert.match(composite.html, /Advisory review finding/u);
  assert.match(composite.html, /Blocage canonique — affecte readiness/u);
  assert.match(composite.html, /Avis consultatif — mêmes octets canoniques/u);
  assert.match(composite.html, /Synthetic boundary observation\./u);
  assert.match(
    composite.html,
    /\.advisory-ledger details\[open\] \{ grid-column: 1 \/ -1; \}/u,
  );
  assert.match(composite.html, /@media \(max-width: 640px\)/u);
  assert.equal(/<script\b/iu.test(composite.html), false);
  assert.ok(composite.manifest.bytes > canonical.manifest.bytes);
});

test("historical advice and reconciliation retain distinct closed labels", () => {
  const view = canonicalView();
  const ledger = vectors.projection_vectors.at(2).projection;
  const composite = renderReviewLedgerReport(view, ledger);

  assert.match(
    composite.html,
    /Avis consultatif historique — octets canoniques différents/u,
  );
  assert.match(
    composite.html,
    /Réconciliation déclarée — résultat byte-identique au canon actuel — objection conservée/u,
  );
  assert.match(composite.html, /Synthetic historical objection\./u);
  assert.match(composite.html, /receipt-a/u);
  assert.match(composite.html, /Canonical blocker remains visible\./u);
});

test("the composite renderer never widens the two MiB transport cap", () => {
  const view = canonicalView();
  const ledger = vectors.projection_vectors.at(1).projection;
  assert.doesNotThrow(() =>
    renderReviewLedgerReport(view, ledger, { maxBytes: 2 * 1024 * 1024 }),
  );
  assert.throws(
    () =>
      renderReviewLedgerReport(view, ledger, {
        maxBytes: 2 * 1024 * 1024 + 1,
      }),
    (error) => error?.code === "REPORT_LIMIT_INVALID",
  );
});

test("the canonical blocker label is absent when the canonical view has none", () => {
  const view = canonicalView();
  view.blockers = [];
  view.readiness = { status: "ready", reasons: [] };
  view.overview.counts = { blockers: 0 };
  const ledger = vectors.projection_vectors.at(1).projection;
  const composite = renderReviewLedgerReport(view, ledger);
  assert.doesNotMatch(composite.html, /Blocage canonique — affecte readiness/u);
});

test("render pressure reduces only advisory details and keeps the canonical blocker", () => {
  const view = canonicalView();
  const base = structuredClone(vectors.projection_vectors.at(1).projection);
  const largeText = "&".repeat(1_900);
  base.reviews = Array.from({ length: 4 }, (_, index) => ({
    ...structuredClone(base.reviews.at(0)),
    receipt_id: `receipt-${String(index).padStart(3, "0")}`,
    alternatives: Array.from({ length: 50 }, () => largeText),
  }));
  base.ledger = {
    ...base.ledger,
    discovered_count: 4,
    valid_count: 4,
    omitted_count: 0,
  };
  base.projection_sha256 = "0".repeat(64);

  const composite = renderReviewLedgerReport(view, base);
  assert.equal(composite.manifest.review_presentation, "summary-only");
  assert.match(composite.html, /Canonical blocker remains visible\./u);
  assert.match(composite.html, /Rendu consultatif réduit/u);
  assert.match(composite.html, /canonique intact/u);
  assert.ok(composite.manifest.bytes <= 2 * 1024 * 1024);
});

test("the opt-in CLI exposes reviews, report and ui without changing defaults", async (t) => {
  const root = await projectFixture(t);
  const before = await invoke([
    "status",
    "--start",
    root,
    "--domain",
    "project",
    "--json",
  ]);
  const reviews = await invoke([
    "reviews",
    "--start",
    root,
    "--domain",
    "project",
    "--json",
  ]);
  assert.equal(reviews.exitCode, 0);
  assert.equal(reviews.stderr, "");
  const ledger = JSON.parse(reviews.stdout);
  assert.equal(ledger.format, "dubsar.review-ledger-view/1");
  assert.equal(ledger.ledger.status, "available");
  assert.equal(ledger.ledger.valid_count, 0);

  const report = await invoke([
    "report",
    "--reviews",
    "--start",
    root,
    "--domain",
    "project",
    "--json",
  ]);
  assert.equal(report.exitCode, 0);
  assert.equal(JSON.parse(report.stdout).format, "dubsar.review-ledger-report/1");

  const launched = await invoke([
    "ui",
    "--reviews",
    "--start",
    root,
    "--domain",
    "project",
    "--json",
  ]);
  t.after(async () => {
    await launched.session?.close("test-cleanup");
  });
  const ready = JSON.parse(launched.stdout);
  assert.equal(ready.format, "dubsar.review-ledger-ui-session/1");
  assert.equal(ready.review_presentation, "full");
  const response = await getBody(ready.url);
  assert.equal(response.status, 200);
  assert.match(response.body.toString("utf8"), /Advisory Review Ledger/u);
  await launched.session.close("test");

  const after = await invoke([
    "status",
    "--start",
    root,
    "--domain",
    "project",
    "--json",
  ]);
  assert.equal(after.stdout, before.stdout);
  assert.equal(after.stderr, "");
});

test("the reviews flag is rejected outside report and ui", async () => {
  const result = await invoke(["status", "--reviews", "--start", "."]);
  assert.equal(result.exitCode, 1);
  assert.equal(result.stdout, "");
  assert.equal(JSON.parse(result.stderr).code, "CLI_ARGUMENT_INVALID");
});
