import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { WorkbenchError, stableJson } from "../packages/dubsar-operator-core/src/index.mjs";
import { capturePersonalMemory } from "../packages/dubsar-workbench-launcher/src/personal-memory.mjs";

const names = ["decisions", "learnings", "blockers", "journal", "evals"];

async function memoryFixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "dubsar-memory-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  for (const name of names) {
    await writeFile(
      path.join(root, `${name}.md`),
      `# ${name}\n\n## 2026-08-10 - ${name}\n\nApercu lie a [[decisions]].\n`,
      "utf8",
    );
  }
  return root;
}

test("personal memory reads only five fixed Markdown files", async (t) => {
  const root = await memoryFixture(t);
  await writeFile(path.join(root, "ignored.md"), "PRIVATE_IGNORED_CANARY", "utf8");
  const first = await capturePersonalMemory(root);
  const second = await capturePersonalMemory(root);
  assert.equal(first.status, "included");
  assert.equal(first.categories.length, 5);
  assert.equal(first.categories.every((item) => item.count === 1), true);
  assert.equal(stableJson(first), stableJson(second));
  assert.equal(stableJson(first).includes("PRIVATE_IGNORED_CANARY"), false);
  assert.equal(stableJson(first).includes(root), false);
});

test("credentials and absolute paths are redacted from previews", async (t) => {
  const root = await memoryFixture(t);
  const secret = "synthetic-secret-value-123456";
  await writeFile(
    path.join(root, "decisions.md"),
    `# Decisions\n\n## 2026-08-10 - private\n\napi_key=${secret} C:\\private\\workspace\n`,
    "utf8",
  );
  const memory = await capturePersonalMemory(root);
  const output = stableJson(memory);
  assert.equal(output.includes(secret), false);
  assert.equal(output.includes("C:\\\\private"), false);
  assert.equal(memory.categories[0].entries[0].preview, "[content redacted]");
});

test("missing, oversized, and linked memory files fail closed", async (t) => {
  const missing = await memoryFixture(t);
  await rm(path.join(missing, "evals.md"));
  await assert.rejects(
    capturePersonalMemory(missing),
    (error) => error instanceof WorkbenchError,
  );

  const oversized = await memoryFixture(t);
  await writeFile(path.join(oversized, "journal.md"), "x".repeat(256 * 1024 + 1));
  await assert.rejects(
    capturePersonalMemory(oversized),
    (error) => error instanceof WorkbenchError && error.code === "FILE_SIZE_LIMIT_EXCEEDED",
  );

  const linked = await memoryFixture(t);
  const target = path.join(linked, "target.md");
  await writeFile(target, "# Target", "utf8");
  await rm(path.join(linked, "evals.md"));
  try {
    await symlink(target, path.join(linked, "evals.md"), "file");
  } catch (error) {
    if (new Set(["EPERM", "EACCES"]).has(error?.code)) {
      t.diagnostic("Symlink creation is unavailable in this Windows profile.");
      return;
    }
    throw error;
  }
  await assert.rejects(
    capturePersonalMemory(linked),
    (error) => error instanceof WorkbenchError,
  );
});
