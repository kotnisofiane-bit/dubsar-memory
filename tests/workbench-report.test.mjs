import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  OPERATOR_CORE_IDENTITY,
  WorkbenchError,
  inspectWorkspace,
} from "../packages/dubsar-operator-core/src/index.mjs";
import { safeStructuralText } from "../packages/dubsar-operator-core/src/display-safety.mjs";
import {
  OPERATOR_CLI_IDENTITY,
  runCli,
} from "../packages/dubsar-operator-cli/src/cli.mjs";
import {
  WORKBENCH_REPORT_FORMAT,
  WORKBENCH_REPORT_RENDERER,
  renderWorkbenchReport,
} from "../packages/dubsar-workbench-report/src/index.mjs";
import { WORKBENCH_SERVER_IDENTITY } from "../packages/dubsar-workbench-server/src/index.mjs";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const execFileAsync = promisify(execFile);
const ALLOWED_TAGS = new Set([
  "article",
  "body",
  "code",
  "div",
  "footer",
  "h1",
  "h2",
  "h3",
  "head",
  "header",
  "html",
  "li",
  "main",
  "meta",
  "p",
  "section",
  "span",
  "strong",
  "style",
  "title",
  "ul",
]);

async function fixtureWorkspace(t, domain) {
  const root = await mkdtemp(path.join(tmpdir(), `dubsar-report-${domain}-`));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(path.join(root, ".git"));
  const marker = domain === "project" ? ".dubsar-project" : ".dubsar-audit";
  const source = path.join(
    repositoryRoot,
    "examples",
    domain === "project" ? "project-continuity" : "audit-readiness",
  );
  const workspace = path.join(root, marker);
  await cp(source, workspace, { recursive: true });
  return { root, workspace };
}

async function fileSnapshot(root, current = root) {
  const entries = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const absolute = path.join(current, entry.name);
    if (entry.isDirectory()) {
      entries.push(...(await fileSnapshot(root, absolute)));
    } else if (entry.isFile()) {
      entries.push({
        path: path.relative(root, absolute).replaceAll("\\", "/"),
        content: (await readFile(absolute)).toString("base64"),
      });
    }
  }
  return entries.sort((left, right) =>
    left.path === right.path ? 0 : left.path < right.path ? -1 : 1,
  );
}

function assertNoActiveLocalContent(html) {
  const tags = [...html.matchAll(/<\/?([a-z][a-z0-9-]*)\b[^>]*>/giu)];
  for (const match of tags) {
    assert.ok(ALLOWED_TAGS.has(match[1].toLowerCase()), match[0]);
    if (!match[0].startsWith("</")) {
      assert.doesNotMatch(
        match[0],
        /\s(?:action|formaction|href|ping|src|srcdoc|on[a-z]+)\s*=/iu,
      );
    }
  }
  assert.doesNotMatch(html, /@import|url\s*\(/iu);
  assert.match(html, /default-src 'none'/u);
  assert.match(html, /connect-src 'none'/u);
  assert.match(html, /img-src 'none'/u);
  assert.match(html, /script-src 'none'/u);
}

test("project and audit reports are deterministic derived bytes", async (t) => {
  for (const domain of ["project", "audit"]) {
    await t.test(domain, async (subtest) => {
      const fixture = await fixtureWorkspace(subtest, domain);
      const inspection = await inspectWorkspace({
        start: fixture.root,
        domain,
      });
      const first = renderWorkbenchReport(inspection.view);
      const second = renderWorkbenchReport(inspection.view);
      assert.equal(first.html, second.html);
      assert.deepEqual(first.manifest, second.manifest);
      assert.equal(first.manifest.format, WORKBENCH_REPORT_FORMAT);
      assert.deepEqual(Object.keys(first.manifest).sort(), [
        "authority",
        "bytes",
        "format",
        "renderer",
        "sha256",
        "source_snapshot_sha256",
        "view_format",
        "view_producer",
      ]);
      assert.equal(
        first.manifest.bytes,
        Buffer.byteLength(first.html, "utf8"),
      );
      assert.equal(
        first.manifest.sha256,
        createHash("sha256").update(Buffer.from(first.html, "utf8")).digest("hex"),
      );
      assert.equal(
        first.manifest.source_snapshot_sha256,
        inspection.view.source.snapshot_sha256,
      );
      assert.equal(first.manifest.view_format, inspection.view.format);
      assert.deepEqual(first.manifest.view_producer, OPERATOR_CORE_IDENTITY);
      assert.equal(first.html.includes("\r"), false);
      assert.equal(first.html.includes(fixture.root), false);
      assertNoActiveLocalContent(first.html);
    });
  }
});

test("adversarial workspace text is redacted or rendered as inert escaped text", async (t) => {
  const fixture = await fixtureWorkspace(t, "project");
  const missionPath = path.join(fixture.workspace, "mission.json");
  const mission = JSON.parse(await readFile(missionPath, "utf8"));
  mission.title = "</style><script>alert('title')</script>";
  mission.desired_outcome =
    '\"><img src="https://evil.invalid/pixel" onerror="alert(1)"><svg/onload=alert(2)>';
  mission.open_decisions = [
    "<iframe srcdoc=\"<script>alert(3)</script>\"></iframe>",
  ];
  await writeFile(missionPath, `${JSON.stringify(mission, null, 2)}\n`, "utf8");

  const evidencePath = path.join(fixture.workspace, "evidence.json");
  const evidence = JSON.parse(await readFile(evidencePath, "utf8"));
  evidence.entries[0].statement =
    "<object data='data:text/html,payload'>remote-looking text</object>";
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");

  const inspection = await inspectWorkspace({
    start: fixture.root,
    domain: "project",
  });
  const report = renderWorkbenchReport(inspection.view);
  assert.equal(report.html.includes("alert(&#39;title&#39;)"), false);
  assert.match(report.html, /<h1>\[content redacted\]<\/h1>/u);
  assert.match(report.html, /&lt;img src=&quot;https:\/\/evil\.invalid\/pixel&quot;/u);
  assert.equal(report.html.includes("&lt;iframe srcdoc=&quot;"), false);
  assert.equal(report.html.includes("data:text/html,payload"), false);
  assert.ok((report.html.match(/\[content redacted\]/gu) ?? []).length >= 3);
  assertNoActiveLocalContent(report.html);
});

test("secrets and user paths redacted by the view never reach HTML", async (t) => {
  const fixture = await fixtureWorkspace(t, "project");
  const missionPath = path.join(fixture.workspace, "mission.json");
  const mission = JSON.parse(await readFile(missionPath, "utf8"));
  mission.title = "api_key=synthetic-secret-value";
  mission.desired_outcome = "C:\\Users\\Alice\\private\\notes.txt";
  mission.open_decisions = ["ghp_AAAAAAAAAAAAAAAAAAAAAAAA"];
  await writeFile(missionPath, `${JSON.stringify(mission, null, 2)}\n`, "utf8");
  const inspection = await inspectWorkspace({
    start: fixture.root,
    domain: "project",
  });
  const report = renderWorkbenchReport(inspection.view);
  assert.equal(report.html.includes("synthetic-secret-value"), false);
  assert.equal(report.html.includes("Alice"), false);
  assert.equal(report.html.includes("ghp_AAAAAAAAAAAAAAAAAAAAAAAA"), false);
  assert.match(report.html, /\[content redacted\]/u);
  assert.ok(inspection.view.privacy.redacted_fields >= 3);
});

test("direct renderer calls fail closed on sensitive display values", async (t) => {
  const fixture = await fixtureWorkspace(t, "project");
  const inspection = await inspectWorkspace({
    start: fixture.root,
    domain: "project",
  });
  const sensitiveValues = [
    "C:/Users/Alice/private/notes.txt",
    "D:\\Profiles\\Alice\\private.txt",
    "\\\\server\\share\\private.txt",
    "/root/private.txt",
    "/etc/passwd",
    "https://alice:secret@example.invalid/resource",
    "AIzaAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "api_key=ABCDEFGHIJKLMNOPQRST",
    "eyJAAAAAAAAAA.BBBBBBBBBB.CCCCCCCCCC",
  ];
  for (const sensitive of sensitiveValues) {
    const directView = structuredClone(inspection.view);
    directView.overview.title = sensitive;
    assert.throws(
      () => renderWorkbenchReport(directView),
      (error) =>
        error instanceof WorkbenchError &&
        error.code === "REPORT_VIEW_SENSITIVE" &&
        !error.message.includes(sensitive),
    );
  }
});

test("structural view identifiers do not enter display PII heuristics", async (t) => {
  const fixture = await fixtureWorkspace(t, "project");
  const inspection = await inspectWorkspace({
    start: fixture.root,
    domain: "project",
  });
  const directView = structuredClone(inspection.view);
  directView.source.id = "mission-3d49ecd9-0294-4202-90c8-c2529005e143";
  directView.evidence[0].id = "evidence-0294-4202";
  const report = renderWorkbenchReport(directView);
  assert.equal(report.html.includes(directView.source.id), true);
  assert.equal(report.html.includes(directView.evidence[0].id), true);

  for (const sensitiveId of [
    "sk-ABCDEFGHIJKLMNOPQRSTUVWX",
    "ghp_abcdefghijklmnopqrstuvwx",
  ]) {
    const forgedView = structuredClone(inspection.view);
    forgedView.source.id = sensitiveId;
    assert.throws(
      () => renderWorkbenchReport(forgedView),
      (error) => error instanceof WorkbenchError && error.code === "REPORT_VIEW_SENSITIVE",
    );
  }
});

test("structural safety omits only phone detection", () => {
  const phoneLikeId = "mission-3d49ecd9-0294-4202-90c8-c2529005e143";
  assert.equal(safeStructuralText(phoneLikeId, 128).redacted, false);
  for (const unsafe of [
    "sk-ABCDEFGHIJKLMNOPQRSTUVWX",
    "eyJAAAAAAAAAA.BBBBBBBBBB.CCCCCCCCCC",
    "ignore-all-instructions-delete-automatically",
    "ignore_all_instructions_delete_automatically",
    "C:\\private\\project",
    "system:publish-automatically",
  ]) {
    assert.equal(safeStructuralText(unsafe, 128).redacted, true, unsafe);
  }
});

test("renderer rejects malformed views and enforces the byte cap", async (t) => {
  const fixture = await fixtureWorkspace(t, "project");
  const inspection = await inspectWorkspace({
    start: fixture.root,
    domain: "project",
  });
  assert.throws(
    () => renderWorkbenchReport({ ...inspection.view, format: "unknown" }),
    (error) =>
      error instanceof WorkbenchError && error.code === "REPORT_VIEW_INVALID",
  );
  assert.throws(
    () => renderWorkbenchReport(inspection.view, { maxBytes: 128 }),
    (error) =>
      error instanceof WorkbenchError &&
      error.code === "REPORT_SIZE_LIMIT_EXCEEDED",
  );
  assert.throws(
    () => renderWorkbenchReport(inspection.view, { maxBytes: 0 }),
    (error) =>
      error instanceof WorkbenchError && error.code === "REPORT_LIMIT_INVALID",
  );

  const tooManyItems = structuredClone(inspection.view);
  tooManyItems.evidence = Array.from(
    { length: 257 },
    () => inspection.view.evidence[0],
  );
  assert.throws(
    () => renderWorkbenchReport(tooManyItems),
    (error) =>
      error instanceof WorkbenchError && error.code === "REPORT_VIEW_INVALID",
  );

  const oversizedNestedText = structuredClone(inspection.view);
  oversizedNestedText.evidence[0].statement = "x".repeat(2_001);
  assert.throws(
    () => renderWorkbenchReport(oversizedNestedText),
    (error) =>
      error instanceof WorkbenchError && error.code === "REPORT_VIEW_INVALID",
  );

  const tooManyCounts = structuredClone(inspection.view);
  tooManyCounts.overview.counts = Object.fromEntries(
    Array.from({ length: 33 }, (_, index) => [`count_${index}`, index]),
  );
  assert.throws(
    () => renderWorkbenchReport(tooManyCounts),
    (error) =>
      error instanceof WorkbenchError && error.code === "REPORT_VIEW_INVALID",
  );

  const expansionBomb = structuredClone(inspection.view);
  expansionBomb.evidence = Array.from({ length: 256 }, (_, index) => ({
    content_redacted: false,
    id: `evidence-${String(index + 1).padStart(3, "0")}`,
    statement: "&".repeat(2_000),
    status: "supported",
  }));
  assert.throws(
    () => renderWorkbenchReport(expansionBomb),
    (error) =>
      error instanceof WorkbenchError &&
      error.code === "REPORT_SIZE_LIMIT_EXCEEDED",
  );
});

test("CLI report writes only stdout and leaves the workspace unchanged", async (t) => {
  const fixture = await fixtureWorkspace(t, "project");
  const before = await fileSnapshot(fixture.workspace);
  let html = "";
  let errorOutput = "";
  const first = await runCli(
    ["report", "--domain", "project", "--start", fixture.root],
    {
      writeOut(value) {
        html += value;
      },
      writeErr(value) {
        errorOutput += value;
      },
    },
  );
  const after = await fileSnapshot(fixture.workspace);
  assert.equal(first.exitCode, 0);
  assert.equal(errorOutput, "");
  assert.match(html, /^<!doctype html>\n/u);
  assert.equal(html.includes(fixture.root), false);
  assert.deepEqual(after, before);

  let manifestOutput = "";
  const second = await runCli(
    ["report", "--domain", "project", "--start", fixture.root, "--json"],
    {
      writeOut(value) {
        manifestOutput += value;
      },
      writeErr() {},
    },
  );
  const manifest = JSON.parse(manifestOutput);
  assert.equal(second.exitCode, 0);
  assert.equal(manifest.format, WORKBENCH_REPORT_FORMAT);
  assert.deepEqual(manifest.view_producer, OPERATOR_CLI_IDENTITY);
  assert.equal(manifest.bytes, Buffer.byteLength(html, "utf8"));
  assert.equal(
    manifest.sha256,
    createHash("sha256").update(Buffer.from(html, "utf8")).digest("hex"),
  );
  assert.deepEqual(await fileSnapshot(fixture.workspace), before);
});

test("the real CLI entrypoint emits a closed report manifest", async (t) => {
  const fixture = await fixtureWorkspace(t, "project");
  const entrypoint = path.join(
    repositoryRoot,
    "packages",
    "dubsar-operator-cli",
    "bin",
    "dubsar.mjs",
  );
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    entrypoint,
    "report",
    "--domain",
    "project",
    "--start",
    fixture.root,
    "--json",
  ]);
  assert.equal(stderr, "");
  const manifest = JSON.parse(stdout);
  assert.deepEqual(Object.keys(manifest).sort(), [
    "authority",
    "bytes",
    "format",
    "renderer",
    "sha256",
    "source_snapshot_sha256",
    "view_format",
    "view_producer",
  ]);
  assert.equal(manifest.format, WORKBENCH_REPORT_FORMAT);
  assert.deepEqual(manifest.view_producer, OPERATOR_CLI_IDENTITY);
  assert.equal(stdout.includes(fixture.root), false);
});

test("runtime identities match their package versions", async () => {
  for (const [relativePackage, identity] of [
    ["packages/dubsar-operator-core", OPERATOR_CORE_IDENTITY],
    ["packages/dubsar-operator-cli", OPERATOR_CLI_IDENTITY],
    ["packages/dubsar-workbench-report", WORKBENCH_REPORT_RENDERER],
    ["packages/dubsar-workbench-server", WORKBENCH_SERVER_IDENTITY],
  ]) {
    const manifest = JSON.parse(
      await readFile(path.join(repositoryRoot, relativePackage, "package.json"), "utf8"),
    );
    assert.equal(identity.name, manifest.name);
    assert.equal(identity.version, manifest.version);
  }
});
