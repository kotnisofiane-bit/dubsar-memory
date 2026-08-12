import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { initAuditWorkspace } from "../packages/dubsar-audit-readiness/scripts/init-audit-workspace.mjs";
import { initProjectWorkspace } from "../legacy/hermes-skills/dubsar-project-continuity/scripts/init-project-workspace.mjs";

const UUID_V4 =
  "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const CASE_ID_PATTERN = new RegExp(`^case-local-${UUID_V4}$`, "u");
const MISSION_ID_PATTERN = new RegExp(`^mission-local-${UUID_V4}$`, "u");

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

async function assertSharedId(root, files, field, expected) {
  const documents = await Promise.all(
    files.map((file) => readJson(path.join(root, file))),
  );
  assert.deepEqual(
    [...new Set(documents.map((document) => document[field]))],
    [expected],
  );
}

test("audit initialization generates one unique local case ID per workspace", async (t) => {
  const testRoot = await mkdtemp(path.join(tmpdir(), "dubsar-case-id-"));
  t.after(async () => {
    await rm(testRoot, { recursive: true, force: true });
  });

  const firstRoot = path.join(testRoot, "first");
  const secondRoot = path.join(testRoot, "second");
  const explicitRoot = path.join(testRoot, "explicit");
  const first = await initAuditWorkspace(firstRoot);
  const second = await initAuditWorkspace(secondRoot);
  const explicit = await initAuditWorkspace(explicitRoot, "case-user-001");

  assert.match(first.case_id, CASE_ID_PATTERN);
  assert.match(second.case_id, CASE_ID_PATTERN);
  assert.notEqual(first.case_id, second.case_id);
  await assertSharedId(firstRoot, first.files, "case_id", first.case_id);
  await assertSharedId(secondRoot, second.files, "case_id", second.case_id);

  assert.equal(explicit.case_id, "case-user-001");
  await assertSharedId(
    explicitRoot,
    explicit.files,
    "case_id",
    "case-user-001",
  );
});

test("project initialization generates one unique local mission ID per workspace", async (t) => {
  const testRoot = await mkdtemp(path.join(tmpdir(), "dubsar-mission-id-"));
  t.after(async () => {
    await rm(testRoot, { recursive: true, force: true });
  });

  const firstRoot = path.join(testRoot, "first");
  const secondRoot = path.join(testRoot, "second");
  const explicitRoot = path.join(testRoot, "explicit");
  const first = await initProjectWorkspace(firstRoot);
  const second = await initProjectWorkspace(secondRoot);
  const explicit = await initProjectWorkspace(
    explicitRoot,
    "mission-user-001",
  );

  assert.match(first.mission_id, MISSION_ID_PATTERN);
  assert.match(second.mission_id, MISSION_ID_PATTERN);
  assert.notEqual(first.mission_id, second.mission_id);
  await assertSharedId(
    firstRoot,
    first.files,
    "mission_id",
    first.mission_id,
  );
  await assertSharedId(
    secondRoot,
    second.files,
    "mission_id",
    second.mission_id,
  );

  assert.equal(explicit.mission_id, "mission-user-001");
  await assertSharedId(
    explicitRoot,
    explicit.files,
    "mission_id",
    "mission-user-001",
  );
});
