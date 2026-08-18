import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { runContinuityCli } from "../packages/dubsar-project-continuity/runtime/cli.mjs";
import {
  applyMemoryBootstrap,
  previewMemoryBootstrap,
} from "../packages/dubsar-project-continuity/runtime/memory-vnext-bootstrap.mjs";
import {
  MEMORY_PENDING_MAX_CANDIDATES,
  MEMORY_PENDING_MAX_FILE_BYTES,
  MEMORY_PENDING_MAX_SOURCES,
  assertPendingCheckpointId,
  assertPendingCheckpointsList,
  assertPendingDeclaredSource,
  memoryPendingCandidateDigest,
  memoryPendingListDigest,
  memoryPendingSetDigest,
} from "../packages/dubsar-project-continuity/runtime/memory-vnext-contracts.mjs";
import {
  parseMemoryMarkdown,
  serializeMemoryMarkdown,
} from "../packages/dubsar-project-continuity/runtime/memory-vnext-markdown.mjs";
import { listPendingCheckpoints } from "../packages/dubsar-project-continuity/runtime/memory-vnext-pending-list.mjs";
import {
  applyPendingCheckpointRecord,
  previewPendingCheckpointRecord,
} from "../packages/dubsar-project-continuity/runtime/memory-vnext-pending-writer.mjs";
import { snapshotMemoryWorkspace } from "../packages/dubsar-project-continuity/runtime/memory-vnext-snapshot.mjs";
import { locateProjectWorkspace } from "../packages/dubsar-project-continuity/runtime/locate.mjs";
import { resolveLimits } from "../packages/dubsar-project-continuity/runtime/contracts.mjs";

const PROJECT_ID = "pending-list-project";
const WORK_ID = "pending-list-work";

async function invoke(argv) {
  let stdout = "";
  let stderr = "";
  const result = await runContinuityCli(argv, {
    writeOut(value) { stdout += value; },
    writeErr(value) { stderr += value; },
  });
  return { ...result, stdout, stderr };
}

function git(cwd, args, { allowFailure = false } = {}) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
  });
  if (!allowFailure && (result.error || result.status !== 0)) {
    throw result.error ?? new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result;
}

function bootstrapProposal() {
  return {
    format: "dubsar.memory-bootstrap-proposal/1",
    project_id: PROJECT_ID,
    title: "Pending list test project",
    work: {
      format: "dubsar.work/1",
      work_id: WORK_ID,
      title: "List pending candidates",
      status: "open",
      scope: "multi_step",
      objective: "Prove pending list never mutates canonical memory.",
      acceptance_criteria: [],
      knowledge_ids: [],
      references: [],
    },
    work_body: "",
    selected_work_id: WORK_ID,
    checkpoint: {
      checkpoint_id: "cp-list-base",
      work_id: WORK_ID,
      kind: "progress",
      summary: "Canonical base exists.",
      references: [],
      validation: [],
      limitations: [],
      resolves: null,
      attempt: null,
      resulting_state: {
        status: "active",
        summary: "Ready for pending list.",
        blockers: [],
        next_action: "Record and list pending candidates.",
      },
    },
  };
}

function pendingProposal({
  source = "worktree-a",
  checkpointId = "cp-pending-candidate-001",
  resolves = null,
  workId = WORK_ID,
  projectId = PROJECT_ID,
  references = [],
  summary = "Candidate result from one worktree.",
} = {}) {
  return {
    format: "dubsar.pending-checkpoint-proposal/1",
    project_id: projectId,
    declared_source: source,
    checkpoint: {
      checkpoint_id: checkpointId,
      work_id: workId,
      kind: "progress",
      summary,
      references,
      validation: [],
      limitations: [],
      resolves,
      attempt: null,
      resulting_state: {
        status: "active",
        summary: "Candidate recorded for later promotion.",
        blockers: [],
        next_action: "Promote only after explicit convergence.",
      },
    },
  };
}

async function shaTree(root, relative = "") {
  const current = path.join(root, relative);
  const names = (await readdir(current, { withFileTypes: true }))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
  const lines = [];
  for (const name of names) {
    const childRelative = relative ? `${relative}/${name}` : name;
    const absolute = path.join(root, childRelative);
    const { lstat } = await import("node:fs/promises");
    const info = await lstat(absolute);
    if (info.isDirectory()) {
      lines.push(...(await shaTree(root, childRelative)));
    } else if (info.isFile()) {
      const digest = createHash("sha256").update(await readFile(absolute)).digest("hex");
      lines.push(`${digest}  ${childRelative}`);
    }
  }
  return lines;
}

async function dubsarFingerprint(root) {
  return (await shaTree(path.join(root, ".dubsar"))).join("\n");
}

async function pendingFingerprint(root) {
  const pendingRoot = path.join(root, ".dubsar-pending");
  try {
    return (await shaTree(pendingRoot)).join("\n");
  } catch (error) {
    if (error?.code === "ENOENT") return "";
    throw error;
  }
}

async function withProject(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), "dubsar-pending-list-"));
  try {
    const preview = await previewMemoryBootstrap({ start: root, proposal: bootstrapProposal() });
    await applyMemoryBootstrap({
      start: root,
      proposal: bootstrapProposal(),
      expectedChange: preview.change_sha256,
    });
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function recordCandidate(root, proposal) {
  const preview = await previewPendingCheckpointRecord({ start: root, proposal });
  return applyPendingCheckpointRecord({
    start: root,
    proposal,
    expectedChange: preview.change_sha256,
  });
}

function pendingPath(root, source, checkpointId) {
  return path.join(root, ".dubsar-pending", source, `${checkpointId}.md`);
}

async function rewritePendingDocument(filePath, mutate, { body = "" } = {}) {
  const parsed = parseMemoryMarkdown(await readFile(filePath, "utf8"));
  const base = {
    base_checkpoint_sha256: parsed.frontmatter.base_checkpoint_sha256,
    base_work_checkpoint_sha256: parsed.frontmatter.base_work_checkpoint_sha256,
    checkpoint: parsed.frontmatter.checkpoint,
    declared_source: parsed.frontmatter.declared_source,
    format: parsed.frontmatter.format,
    project_id: parsed.frontmatter.project_id,
    source_shared_snapshot_sha256: parsed.frontmatter.source_shared_snapshot_sha256,
  };
  mutate(base);
  const frontmatter = {
    ...base,
    candidate_sha256: memoryPendingCandidateDigest(base),
  };
  await writeFile(filePath, serializeMemoryMarkdown({ frontmatter, body }));
}

async function fillPlaceholderCandidate(dir, checkpointId) {
  await writeFile(path.join(dir, `${checkpointId}.md`), "x\n");
}

const PENDING_LIST_CLOSED_DIAGNOSTICS = Object.freeze(new Set([
  "PENDING_CAPTURE_RACE",
  "PENDING_ENTRY_INVALID",
  "PENDING_LIMIT_EXCEEDED",
  "PENDING_LIST_INVALID",
  "PENDING_ROOT_UNSAFE",
  "PENDING_WORKSPACE_REQUIRED",
]));

async function expectListReject(root, run, code) {
  assert.equal(
    PENDING_LIST_CLOSED_DIAGNOSTICS.has(code),
    true,
    `${code} is outside the closed pending-list diagnostic set`,
  );
  const beforeDubsar = await dubsarFingerprint(root);
  const beforePending = await pendingFingerprint(root);
  await assert.rejects(run, (error) => error.code === code);
  assert.equal(await dubsarFingerprint(root), beforeDubsar);
  assert.equal(await pendingFingerprint(root), beforePending);
}

test("absent pending root yields empty valid list", async () => {
  await withProject(async (root) => {
    const list = await listPendingCheckpoints({ start: root });
    assert.equal(list.format, "dubsar.pending-checkpoints-list/1");
    assert.equal(list.project_id, PROJECT_ID);
    assert.equal(list.count, 0);
    assert.deepEqual(list.candidates, []);
    assert.equal(list.pending_set_sha256, memoryPendingSetDigest([]));
    assertPendingCheckpointsList(list);

    const capabilities = await invoke(["capabilities", "--json"]);
    assert.equal(capabilities.exitCode, 0);
    const listed = JSON.parse(capabilities.stdout).capabilities;
    assert.equal(
      listed.find((item) => item === "memory.pending-checkpoint-list.v1"),
      "memory.pending-checkpoint-list.v1",
    );
    assert.equal(
      listed.find((item) => item === "memory.pending-checkpoint-record.v1"),
      "memory.pending-checkpoint-record.v1",
    );

    const cli = await invoke(["pending", "list", "--start", root, "--json"]);
    assert.equal(cli.exitCode, 0, cli.stderr);
    assert.deepEqual(JSON.parse(cli.stdout), list);

    const human = await invoke(["pending", "list", "--start", root]);
    assert.equal(human.exitCode, 0, human.stderr);
    assert.match(human.stdout, /DUBSAR pending checkpoints/);
    assert.match(human.stdout, /Candidates: 0/);
  });
});

test("assertPendingCheckpointsList rejects mismatched pending_set_sha256", () => {
  const candidate = {
    declared_source: "worktree-a",
    checkpoint_id: "cp-set-mismatch",
    work_id: WORK_ID,
    kind: "progress",
    summary: "Structurally valid candidate.",
    candidate_sha256: "c".repeat(64),
    source_file_sha256: "d".repeat(64),
  };
  const withoutDigest = {
    format: "dubsar.pending-checkpoints-list/1",
    project_id: PROJECT_ID,
    source_shared_snapshot_sha256: "a".repeat(64),
    pending_set_sha256: "b".repeat(64),
    count: 1,
    candidates: [candidate],
  };
  assert.notEqual(
    withoutDigest.pending_set_sha256,
    memoryPendingSetDigest([{
      path: "worktree-a/cp-set-mismatch.md",
      sha256: candidate.source_file_sha256,
    }]),
  );
  assert.throws(
    () => assertPendingCheckpointsList({
      ...withoutDigest,
      list_sha256: memoryPendingListDigest(withoutDigest),
    }),
    (error) => error.code === "PENDING_LIST_INVALID",
  );
});

test("one valid candidate is listed", async () => {
  await withProject(async (root) => {
    await recordCandidate(root, pendingProposal({
      checkpointId: "cp-one",
      summary: "Single listed candidate.",
    }));
    const list = await listPendingCheckpoints({ start: root });
    assert.equal(list.count, 1);
    assert.equal(list.candidates[0].declared_source, "worktree-a");
    assert.equal(list.candidates[0].checkpoint_id, "cp-one");
    assert.equal(list.candidates[0].work_id, WORK_ID);
    assert.equal(list.candidates[0].kind, "progress");
    assert.equal(list.candidates[0].summary, "Single listed candidate.");
    assert.equal("state" in list.candidates[0], false);
    assert.equal("references" in list.candidates[0], false);
    assertPendingCheckpointsList(list);

    const human = await invoke(["pending", "list", "--start", root]);
    assert.equal(human.exitCode, 0, human.stderr);
    assert.match(human.stdout, /Candidates: 1/);
    assert.match(
      human.stdout,
      /- worktree-a\/cp-one \[progress\] Single listed candidate\./,
    );
  });
});

test("order and digests are deterministic across runs", async () => {
  await withProject(async (root) => {
    await recordCandidate(root, pendingProposal({
      source: "worktree-b",
      checkpointId: "cp-order-b",
      summary: "Second source.",
    }));
    await recordCandidate(root, pendingProposal({
      source: "worktree-a",
      checkpointId: "cp-order-a",
      summary: "First source.",
    }));
    const first = await listPendingCheckpoints({ start: root });
    const second = await listPendingCheckpoints({ start: root });
    assert.deepEqual(first, second);
    assert.deepEqual(
      first.candidates.map((item) => `${item.declared_source}/${item.checkpoint_id}`),
      ["worktree-a/cp-order-a", "worktree-b/cp-order-b"],
    );
    assert.equal(
      first.pending_set_sha256,
      memoryPendingSetDigest([
        {
          path: "worktree-a/cp-order-a.md",
          sha256: first.candidates[0].source_file_sha256,
        },
        {
          path: "worktree-b/cp-order-b.md",
          sha256: first.candidates[1].source_file_sha256,
        },
      ]),
    );
    assertPendingCheckpointsList(first);
  });
});

test("unknown file or directory fails the entire list", async () => {
  await withProject(async (root) => {
    const pendingRoot = path.join(root, ".dubsar-pending");
    await mkdir(path.join(pendingRoot, "worktree-a"), { recursive: true });
    await writeFile(path.join(pendingRoot, "README.txt"), "nope\n");
    await expectListReject(
      root,
      () => listPendingCheckpoints({ start: root }),
      "PENDING_ROOT_UNSAFE",
    );

    await rm(pendingRoot, { recursive: true, force: true });
    await mkdir(path.join(pendingRoot, "worktree-a", "nested"), { recursive: true });
    await expectListReject(
      root,
      () => listPendingCheckpoints({ start: root }),
      "PENDING_ROOT_UNSAFE",
    );
  });
});

test("invalid document digest or body fails the entire list", async () => {
  await withProject(async (root) => {
    const pendingRoot = path.join(root, ".dubsar-pending");
    await mkdir(path.join(pendingRoot, "worktree-a"), { recursive: true });
    await writeFile(path.join(pendingRoot, "worktree-a", "cp-bad-raw.md"), "not-markdown\n");
    await expectListReject(
      root,
      () => listPendingCheckpoints({ start: root }),
      "PENDING_ENTRY_INVALID",
    );

    await rm(pendingRoot, { recursive: true, force: true });
    await recordCandidate(root, pendingProposal({ checkpointId: "cp-bad-digest" }));
    const digestPath = pendingPath(root, "worktree-a", "cp-bad-digest");
    const parsed = parseMemoryMarkdown(await readFile(digestPath, "utf8"));
    await writeFile(
      digestPath,
      serializeMemoryMarkdown({
        frontmatter: {
          ...parsed.frontmatter,
          candidate_sha256: "0".repeat(64),
        },
        body: "",
      }),
    );
    await expectListReject(
      root,
      () => listPendingCheckpoints({ start: root }),
      "PENDING_ENTRY_INVALID",
    );

    await rm(pendingRoot, { recursive: true, force: true });
    await recordCandidate(root, pendingProposal({ checkpointId: "cp-bad-body" }));
    const bodyPath = pendingPath(root, "worktree-a", "cp-bad-body");
    const bodyParsed = parseMemoryMarkdown(await readFile(bodyPath, "utf8"));
    await writeFile(
      bodyPath,
      serializeMemoryMarkdown({
        frontmatter: bodyParsed.frontmatter,
        body: "non-empty body is invalid\n",
      }),
    );
    await expectListReject(
      root,
      () => listPendingCheckpoints({ start: root }),
      "PENDING_ENTRY_INVALID",
    );
  });
});

test("missing work or resolves fails the entire list", async () => {
  await withProject(async (root) => {
    await recordCandidate(root, pendingProposal({ checkpointId: "cp-unknown-work" }));
    await rewritePendingDocument(
      pendingPath(root, "worktree-a", "cp-unknown-work"),
      (document) => {
        document.checkpoint = {
          ...document.checkpoint,
          work_id: "missing-work-item-001",
        };
      },
    );
    await expectListReject(
      root,
      () => listPendingCheckpoints({ start: root }),
      "PENDING_ENTRY_INVALID",
    );

    await rm(path.join(root, ".dubsar-pending"), { recursive: true, force: true });
    await recordCandidate(root, pendingProposal({ checkpointId: "cp-unknown-resolves" }));
    await rewritePendingDocument(
      pendingPath(root, "worktree-a", "cp-unknown-resolves"),
      (document) => {
        document.checkpoint = {
          ...document.checkpoint,
          resolves: "cp-does-not-exist-001",
        };
      },
    );
    await expectListReject(
      root,
      () => listPendingCheckpoints({ start: root }),
      "PENDING_ENTRY_INVALID",
    );
  });
});

test("exact limits pass and exceeding them fails", async () => {
  await withProject(async (root) => {
    const pendingRoot = path.join(root, ".dubsar-pending");
    await mkdir(pendingRoot);
    for (let index = 0; index < MEMORY_PENDING_MAX_SOURCES; index += 1) {
      const source = `source-${String(index).padStart(2, "0")}`;
      await mkdir(path.join(pendingRoot, source));
    }
    const atSourceLimit = await listPendingCheckpoints({ start: root });
    assert.equal(atSourceLimit.count, 0);
    assertPendingCheckpointsList(atSourceLimit);

    await mkdir(path.join(pendingRoot, `source-${String(MEMORY_PENDING_MAX_SOURCES).padStart(2, "0")}`));
    await expectListReject(
      root,
      () => listPendingCheckpoints({ start: root }),
      "PENDING_LIMIT_EXCEEDED",
    );

    await rm(pendingRoot, { recursive: true, force: true });
    await mkdir(path.join(pendingRoot, "worktree-a"), { recursive: true });
    for (let index = 0; index < MEMORY_PENDING_MAX_CANDIDATES; index += 1) {
      await fillPlaceholderCandidate(
        path.join(pendingRoot, "worktree-a"),
        `cp-cand-${String(index).padStart(3, "0")}`,
      );
    }
    await expectListReject(
      root,
      () => listPendingCheckpoints({ start: root }),
      "PENDING_ENTRY_INVALID",
    );

    await fillPlaceholderCandidate(
      path.join(pendingRoot, "worktree-a"),
      `cp-cand-${String(MEMORY_PENDING_MAX_CANDIDATES).padStart(3, "0")}`,
    );
    await expectListReject(
      root,
      () => listPendingCheckpoints({ start: root }),
      "PENDING_LIMIT_EXCEEDED",
    );

    await rm(pendingRoot, { recursive: true, force: true });
    await mkdir(path.join(pendingRoot, "worktree-a"), { recursive: true });
    await writeFile(
      path.join(pendingRoot, "worktree-a", "cp-too-large.md"),
      "x".repeat(MEMORY_PENDING_MAX_FILE_BYTES + 1),
    );
    await expectListReject(
      root,
      () => listPendingCheckpoints({ start: root }),
      "PENDING_LIMIT_EXCEEDED",
    );
  });
});

test("paths case unicode symlink junction and hardlink fail closed", async () => {
  await withProject(async (root) => {
    const pendingRoot = path.join(root, ".dubsar-pending");

    await mkdir(path.join(pendingRoot, "con"), { recursive: true });
    await fillPlaceholderCandidate(path.join(pendingRoot, "con"), "cp-reserved-001");
    await expectListReject(
      root,
      () => listPendingCheckpoints({ start: root }),
      "PENDING_ROOT_UNSAFE",
    );

    await rm(pendingRoot, { recursive: true, force: true });
    await mkdir(path.join(pendingRoot, "bad"), { recursive: true });
    await writeFile(path.join(pendingRoot, "bad", "Not-Portable.md"), "x\n");
    await expectListReject(
      root,
      () => listPendingCheckpoints({ start: root }),
      "PENDING_ROOT_UNSAFE",
    );

    await rm(pendingRoot, { recursive: true, force: true });
    const unicodeDir = path.join(pendingRoot, "unicodé-source");
    await mkdir(unicodeDir, { recursive: true });
    await fillPlaceholderCandidate(unicodeDir, "cp-unicode-001");
    await expectListReject(
      root,
      () => listPendingCheckpoints({ start: root }),
      "PENDING_ROOT_UNSAFE",
    );

    await rm(pendingRoot, { recursive: true, force: true });
    await mkdir(pendingRoot);
    const outside = await mkdtemp(path.join(os.tmpdir(), "dubsar-pending-out-"));
    try {
      const linkType = process.platform === "win32" ? "junction" : "dir";
      try {
        await symlink(outside, path.join(pendingRoot, "worktree-link"), linkType);
      } catch (error) {
        if (error?.code !== "EPERM" && error?.code !== "ENOTSUP") throw error;
      }
      if ((await readdir(pendingRoot)).includes("worktree-link")) {
        await expectListReject(
          root,
          () => listPendingCheckpoints({ start: root }),
          "PENDING_ROOT_UNSAFE",
        );
      }
    } finally {
      await rm(outside, { recursive: true, force: true });
    }

    await rm(pendingRoot, { recursive: true, force: true });
    const sourceDir = path.join(pendingRoot, "worktree-a");
    await mkdir(sourceDir, { recursive: true });
    const first = path.join(sourceDir, "cp-hard-one.md");
    const second = path.join(sourceDir, "cp-hard-two.md");
    await writeFile(first, "candidate\n");
    try {
      await link(first, second);
      await expectListReject(
        root,
        () => listPendingCheckpoints({ start: root }),
        "PENDING_ROOT_UNSAFE",
      );
    } catch (error) {
      if (error?.code !== "EPERM" && error?.code !== "ENOTSUP") throw error;
    }

    await rm(pendingRoot, { recursive: true, force: true });
    await mkdir(sourceDir, { recursive: true });
    await writeFile(first, "candidate\n");
    try {
      await symlink(first, path.join(sourceDir, "cp-symlink.md"));
      await expectListReject(
        root,
        () => listPendingCheckpoints({ start: root }),
        "PENDING_ROOT_UNSAFE",
      );
    } catch (error) {
      if (error?.code !== "EPERM" && error?.code !== "ENOTSUP") throw error;
    }

    await rm(pendingRoot, { recursive: true, force: true });
    const newlineSource = path.join(pendingRoot, "bad\nsource");
    try {
      await mkdir(newlineSource, { recursive: true });
      await fillPlaceholderCandidate(newlineSource, "cp-newline-001");
      await expectListReject(
        root,
        () => listPendingCheckpoints({ start: root }),
        "PENDING_ROOT_UNSAFE",
      );
    } catch (error) {
      if (error?.code !== "ENOENT" && error?.code !== "EINVAL") throw error;
    }
  });
});

test("mutation between inventory captures yields PENDING_CAPTURE_RACE", async () => {
  await withProject(async (root) => {
    await recordCandidate(root, pendingProposal({ checkpointId: "cp-race-001" }));
    const target = pendingPath(root, "worktree-a", "cp-race-001");
    const beforeDubsar = await dubsarFingerprint(root);
    await assert.rejects(
      () => listPendingCheckpoints({
        start: root,
        afterInventoryPass: async () => {
          await writeFile(target, `${await readFile(target, "utf8")}\nmutated\n`);
        },
      }),
      (error) => error.code === "PENDING_CAPTURE_RACE",
    );
    assert.equal(await dubsarFingerprint(root), beforeDubsar);
  });
});

test("absent root created between captures yields PENDING_CAPTURE_RACE", async () => {
  await withProject(async (root) => {
    await expectListReject(
      root,
      () => listPendingCheckpoints({
        start: root,
        afterInventoryPass: async () => {
          await mkdir(path.join(root, ".dubsar-pending"));
        },
      }),
      "PENDING_CAPTURE_RACE",
    );
  });
});

test("list JSON never leaks absolute paths bodies or secrets", async () => {
  await withProject(async (root) => {
    await mkdir(path.join(root, "notes"), { recursive: true });
    await writeFile(path.join(root, "notes", "safe.txt"), "safe evidence\n");
    const digest = createHash("sha256").update("safe evidence\n").digest("hex");
    await recordCandidate(root, pendingProposal({
      checkpointId: "cp-safe-ref",
      references: [{ path: "notes/safe.txt", sha256: digest }],
      summary: "Safe candidate without secret material.",
    }));

    const list = await listPendingCheckpoints({ start: root });
    const serialized = JSON.stringify(list);
    assert.equal(serialized.includes(root), false);
    assert.equal(serialized.includes(path.resolve(root)), false);
    assert.equal(serialized.includes("notes/safe.txt"), false);
    assert.equal(serialized.includes("\n---\n"), false);
    assert.equal(/[A-Za-z]:\\/u.test(serialized), false);
    assert.equal(serialized.includes("/Users/"), false);
    assert.equal(serialized.includes("/tmp/"), false);
    for (const candidate of list.candidates) {
      assert.equal("body" in candidate, false);
      assert.equal("path" in candidate, false);
      assert.equal("references" in candidate, false);
    }
    assertPendingCheckpointsList(list);
  });
});

test("list leaves .dubsar and .dubsar-pending byte-identical", async () => {
  await withProject(async (root) => {
    await recordCandidate(root, pendingProposal({ checkpointId: "cp-identity-001" }));
    const beforeDubsar = await dubsarFingerprint(root);
    const beforePending = await pendingFingerprint(root);
    const location = await locateProjectWorkspace({ start: root });
    const beforeSnapshot = await snapshotMemoryWorkspace(location, resolveLimits());

    const list = await listPendingCheckpoints({ start: root });
    assert.equal(list.count, 1);
    assertPendingCheckpointsList(list);

    assert.equal(await dubsarFingerprint(root), beforeDubsar);
    assert.equal(await pendingFingerprint(root), beforePending);
    const afterSnapshot = await snapshotMemoryWorkspace(location, resolveLimits());
    assert.equal(afterSnapshot.shared_snapshot_sha256, beforeSnapshot.shared_snapshot_sha256);
    assert.equal(afterSnapshot.snapshot_sha256, beforeSnapshot.snapshot_sha256);
  });
});

test("resume and route CLI stdout stay identical across list", async () => {
  await withProject(async (root) => {
    await recordCandidate(root, pendingProposal({ checkpointId: "cp-resume-route-001" }));

    const resumeBefore = await invoke(["resume", "--start", root, "--capsule", "--json"]);
    const routeBefore = await invoke(["route", "--start", root, "--json"]);
    assert.equal(resumeBefore.exitCode, 0, resumeBefore.stderr);
    assert.equal(routeBefore.exitCode, 0, routeBefore.stderr);

    const listed = await invoke(["pending", "list", "--start", root, "--json"]);
    assert.equal(listed.exitCode, 0, listed.stderr);
    assertPendingCheckpointsList(JSON.parse(listed.stdout));

    const resumeAfter = await invoke(["resume", "--start", root, "--capsule", "--json"]);
    const routeAfter = await invoke(["route", "--start", root, "--json"]);
    assert.equal(resumeAfter.exitCode, 0, resumeAfter.stderr);
    assert.equal(routeAfter.exitCode, 0, routeAfter.stderr);
    assert.equal(resumeAfter.stdout, resumeBefore.stdout);
    assert.equal(routeAfter.stdout, routeBefore.stdout);
  });
});

test("two Git worktrees record distinct sources then list sees both after merge", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dubsar-pending-list-wt-"));
  const repository = path.join(root, "repository");
  const worktreeA = path.join(root, "worktree-a");
  const worktreeB = path.join(root, "worktree-b");
  const integration = path.join(root, "integration");
  await mkdir(repository);
  t.after(async () => {
    if (git(repository, ["rev-parse", "--git-dir"], { allowFailure: true }).status === 0) {
      git(repository, ["merge", "--abort"], { allowFailure: true });
      for (const tree of [worktreeA, worktreeB, integration]) {
        git(repository, ["worktree", "remove", "--force", tree], { allowFailure: true });
      }
    }
    await rm(root, { recursive: true, force: true });
  });

  git(repository, ["init"]);
  git(repository, ["branch", "-M", "main"]);
  git(repository, ["config", "core.autocrlf", "false"]);
  git(repository, ["config", "user.name", "DUBSAR Test"]);
  git(repository, ["config", "user.email", "dubsar-test@example.invalid"]);

  const proposal = bootstrapProposal();
  const preview = await previewMemoryBootstrap({ start: repository, proposal });
  await applyMemoryBootstrap({
    start: repository,
    proposal,
    expectedChange: preview.change_sha256,
  });
  git(repository, ["add", ".dubsar"]);
  git(repository, ["commit", "-m", "test: pending list common base"]);

  git(repository, ["worktree", "add", "-b", "agent-a", worktreeA, "main"]);
  git(repository, ["worktree", "add", "-b", "agent-b", worktreeB, "main"]);
  git(repository, ["worktree", "add", "-b", "integration", integration, "main"]);

  await recordCandidate(
    worktreeA,
    pendingProposal({ source: "agent-a", checkpointId: "cp-from-agent-a" }),
  );
  await recordCandidate(
    worktreeB,
    pendingProposal({ source: "agent-b", checkpointId: "cp-from-agent-b" }),
  );
  git(worktreeA, ["add", ".dubsar-pending"]);
  git(worktreeA, ["commit", "-m", "test: pending candidate from agent A"]);
  git(worktreeB, ["add", ".dubsar-pending"]);
  git(worktreeB, ["commit", "-m", "test: pending candidate from agent B"]);

  git(integration, ["merge", "--no-ff", "agent-a", "-m", "test: integrate agent A pending"]);
  git(integration, ["merge", "--no-ff", "agent-b", "-m", "test: integrate agent B pending"]);

  const list = await listPendingCheckpoints({ start: integration });
  assert.equal(list.count, 2);
  assert.deepEqual(
    list.candidates.map((item) => `${item.declared_source}/${item.checkpoint_id}`),
    ["agent-a/cp-from-agent-a", "agent-b/cp-from-agent-b"],
  );
  assertPendingCheckpointsList(list);
});

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("CLI help and CLI reference classify pending list as read-only", async () => {
  const help = await invoke(["--help"]);
  assert.equal(help.exitCode, 0, help.stderr);
  const [readOnlyHelp, writeHelp] = help.stdout.split("Write style A");
  assert.match(readOnlyHelp, /Read-only commands:/u);
  assert.match(readOnlyHelp, /^\s*pending list\b/mu);
  assert.doesNotMatch(writeHelp, /^\s*pending list\b/mu);
  assert.match(readOnlyHelp, /route --start <project>\s+Advisory signal; never executed automatically/u);

  const reference = await readFile(path.join(REPOSITORY_ROOT, "docs", "CLI_REFERENCE.md"), "utf8");
  const [readSection, writeSection] = reference.split("## Explicit write commands");
  assert.match(readSection, /## Read commands/u);
  assert.match(readSection, /\| `pending list` \|/u);
  assert.doesNotMatch(writeSection, /\| `pending list` \|/u);
  assert.match(readSection, /`route` is\nadvisory and grants no execution authority\./u);
});

test("pending list --apply is rejected and writes nothing", async () => {
  await withProject(async (root) => {
    await recordCandidate(root, pendingProposal({ checkpointId: "cp-no-apply" }));
    const beforeDubsar = await dubsarFingerprint(root);
    const beforePending = await pendingFingerprint(root);
    const result = await invoke(["pending", "list", "--start", root, "--apply", "--json"]);
    assert.equal(result.exitCode, 1);
    assert.equal(JSON.parse(result.stderr).code, "CLI_ARGUMENT_INVALID");
    assert.equal(await dubsarFingerprint(root), beforeDubsar);
    assert.equal(await pendingFingerprint(root), beforePending);
  });
});

test("pending list requires a memory vnext workspace", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dubsar-pending-list-lite-"));
  try {
    await mkdir(path.join(root, ".dubsar-project"));
    await assert.rejects(
      () => listPendingCheckpoints({ start: root }),
      (error) => {
        assert.equal(PENDING_LIST_CLOSED_DIAGNOSTICS.has(error.code), true);
        return error.code === "PENDING_WORKSPACE_REQUIRED";
      },
    );
    assert.deepEqual(await readdir(root), [".dubsar-project"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("pending list diagnostics belong to a closed set", () => {
  assert.deepEqual(
    [...PENDING_LIST_CLOSED_DIAGNOSTICS],
    [
      "PENDING_CAPTURE_RACE",
      "PENDING_ENTRY_INVALID",
      "PENDING_LIMIT_EXCEEDED",
      "PENDING_LIST_INVALID",
      "PENDING_ROOT_UNSAFE",
      "PENDING_WORKSPACE_REQUIRED",
    ],
  );
  assert.equal(PENDING_LIST_CLOSED_DIAGNOSTICS.has("PENDING_ENTRIES_OMITTED"), false);
});

test("declared source and checkpoint id reject traversal newline and non-portable names", () => {
  const invalid = [
    "..",
    "../x",
    "a/b",
    "a\\b",
    "foo\nbar",
    "foo\rbar",
    ".hidden",
    "Worktree",
    "CON",
    "aux",
    `${"a".repeat(200)}`,
  ];
  for (const value of invalid) {
    assert.throws(
      () => assertPendingDeclaredSource(value, "PENDING_ROOT_UNSAFE"),
      (error) => error.code === "PENDING_ROOT_UNSAFE",
      value,
    );
    assert.throws(
      () => assertPendingCheckpointId(value, "PENDING_ROOT_UNSAFE"),
      (error) => error.code === "PENDING_ROOT_UNSAFE",
      value,
    );
  }
});

test("exact .dubsar-pending basename is required; a differently cased sibling is not a source", async () => {
  const source = await readFile(
    path.join(
      REPOSITORY_ROOT,
      "packages",
      "dubsar-project-continuity",
      "runtime",
      "memory-vnext-pending-list.mjs",
    ),
    "utf8",
  );
  assert.match(source, /const PENDING_ROOT_NAME = "\.dubsar-pending";/u);
  assert.match(source, /path\.basename\(opened\) !== PENDING_ROOT_NAME/u);
  assert.notEqual(".DUBSAR-PENDING", ".dubsar-pending");
  await withProject(async (root) => {
    const wrong = path.join(root, ".DUBSAR-PENDING");
    await mkdir(path.join(wrong, "worktree-a"), { recursive: true });
    await writeFile(path.join(wrong, "worktree-a", "cp-wrong-case.md"), "x\n");
    if (process.platform === "win32") {
      await expectListReject(
        root,
        () => listPendingCheckpoints({ start: root }),
        "PENDING_ROOT_UNSAFE",
      );
      return;
    }
    const list = await listPendingCheckpoints({ start: root });
    assert.equal(list.count, 0);
    assertPendingCheckpointsList(list);
    const cli = await invoke(["pending", "list", "--start", root, "--json"]);
    assert.equal(cli.exitCode, 0, cli.stderr);
    assert.equal(JSON.parse(cli.stdout).count, 0);
  });
});

test("list does not observe references and enforces the per-candidate bound", async () => {
  await withProject(async (root) => {
    await recordCandidate(root, pendingProposal({ checkpointId: "cp-ref-budget" }));
    const digest = "a".repeat(64);
    const eight = Array.from({ length: 8 }, (_, index) => ({
      path: `notes/file-${index}.txt`,
      sha256: digest,
    }));
    await rewritePendingDocument(
      pendingPath(root, "worktree-a", "cp-ref-budget"),
      (document) => {
        document.checkpoint = {
          ...document.checkpoint,
          references: eight,
        };
      },
    );
    const listed = await listPendingCheckpoints({ start: root });
    assert.equal(listed.count, 1);
    assert.equal("references" in listed.candidates[0], false);
    assertPendingCheckpointsList(listed);

    await rewritePendingDocument(
      pendingPath(root, "worktree-a", "cp-ref-budget"),
      (document) => {
        document.checkpoint = {
          ...document.checkpoint,
          references: [...eight, { path: "notes/file-8.txt", sha256: digest }],
        };
      },
    );
    await expectListReject(
      root,
      () => listPendingCheckpoints({ start: root }),
      "PENDING_ENTRY_INVALID",
    );
  });
});
