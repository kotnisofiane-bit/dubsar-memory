import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { runDemo } from "../tools/run-demo.mjs";

const labRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

test("the public Memory vNext example resumes without executing work", async () => {
  const result = await runDemo(labRoot);
  assert.equal(result.status, "pass");
  assert.equal(result.project.workspace_mode, "memory_vnext");
  assert.equal(result.project.integrity, "valid");
  assert.equal(result.project.active_work_id, "work-slug-normalization-001");
  assert.equal(result.project.checkpoint_count, 1);
  assert.match(result.project.disclaimer, /No project action/u);
  assert.match(result.project.shared_snapshot_sha256, /^[a-f0-9]{64}$/u);
  assert.match(result.project.snapshot_sha256, /^[a-f0-9]{64}$/u);
});
