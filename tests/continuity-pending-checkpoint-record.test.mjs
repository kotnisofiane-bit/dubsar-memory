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

import { runContinuityCli } from "../packages/dubsar-project-continuity/runtime/cli.mjs";
import {
  applyMemoryBootstrap,
  previewMemoryBootstrap,
} from "../packages/dubsar-project-continuity/runtime/memory-vnext-bootstrap.mjs";
import {
  MEMORY_PENDING_MAX_CANDIDATES,
  MEMORY_PENDING_MAX_FILE_BYTES,
  MEMORY_PENDING_MAX_SOURCES,
} from "../packages/dubsar-project-continuity/runtime/memory-vnext-contracts.mjs";
import {
  applyPendingCheckpointRecord,
  previewPendingCheckpointRecord,
} from "../packages/dubsar-project-continuity/runtime/memory-vnext-pending-writer.mjs";
import { snapshotMemoryWorkspace } from "../packages/dubsar-project-continuity/runtime/memory-vnext-snapshot.mjs";
import { locateProjectWorkspace } from "../packages/dubsar-project-continuity/runtime/locate.mjs";
import { resolveLimits } from "../packages/dubsar-project-continuity/runtime/contracts.mjs";
import { parseMemoryMarkdown } from "../packages/dubsar-project-continuity/runtime/memory-vnext-markdown.mjs";
import {
  applyMemoryChange,
  previewMemoryChange,
} from "../packages/dubsar-project-continuity/runtime/memory-vnext-writer.mjs";

const PROJECT_ID = "pending-record-project";
const WORK_ID = "pending-record-work";

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
    title: "Pending record test project",
    work: {
      format: "dubsar.work/1",
      work_id: WORK_ID,
      title: "Record pending candidates",
      status: "open",
      scope: "multi_step",
      objective: "Prove pending candidates never mutate canonical memory.",
      acceptance_criteria: [],
      knowledge_ids: [],
      references: [],
    },
    work_body: "",
    selected_work_id: WORK_ID,
    checkpoint: {
      checkpoint_id: "cp-pending-base",
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
        summary: "Ready for pending candidates.",
        blockers: [],
        next_action: "Record one pending candidate from a worktree.",
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
  extra = null,
} = {}) {
  const proposal = {
    format: "dubsar.pending-checkpoint-proposal/1",
    project_id: projectId,
    declared_source: source,
    checkpoint: {
      checkpoint_id: checkpointId,
      work_id: workId,
      kind: "progress",
      summary: "Candidate result from one worktree.",
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
  if (extra !== null) Object.assign(proposal, extra);
  return proposal;
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

async function withProject(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), "dubsar-pending-"));
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

async function expectPendingReject(root, run, code) {
  const before = await dubsarFingerprint(root);
  await assert.rejects(run, (error) => error.code === code);
  assert.equal(await dubsarFingerprint(root), before);
}

async function recordCandidate(root, proposal) {
  const preview = await previewPendingCheckpointRecord({ start: root, proposal });
  return applyPendingCheckpointRecord({
    start: root,
    proposal,
    expectedChange: preview.change_sha256,
  });
}

test("pending record writes only .dubsar-pending and leaves .dubsar byte-identical", async () => {
  await withProject(async (root) => {
    const location = await locateProjectWorkspace({ start: root });
    const before = await snapshotMemoryWorkspace(location, resolveLimits());
    const beforeDubsar = await dubsarFingerprint(root);
    const proposal = pendingProposal();
    const preview = await previewPendingCheckpointRecord({ start: root, proposal });
    assert.equal(preview.format, "dubsar.pending-checkpoint-preview/1");
    assert.equal(preview.status, "preview");
    assert.equal(preview.target, ".dubsar-pending/worktree-a/cp-pending-candidate-001.md");
    assert.match(preview.consequence, /\.dubsar\//u);

    const applied = await applyPendingCheckpointRecord({
      start: root,
      proposal,
      expectedChange: preview.change_sha256,
    });
    assert.equal(applied.format, "dubsar.pending-checkpoint-apply/1");
    assert.equal(applied.status, "applied");
    assert.equal(applied.shared_snapshot_sha256, before.shared_snapshot_sha256);
    assert.equal(await dubsarFingerprint(root), beforeDubsar);

    const after = await snapshotMemoryWorkspace(location, resolveLimits());
    assert.equal(after.shared_snapshot_sha256, before.shared_snapshot_sha256);
    assert.equal(after.snapshot_sha256, before.snapshot_sha256);

    const markdown = await readFile(
      path.join(root, ".dubsar-pending", "worktree-a", "cp-pending-candidate-001.md"),
      "utf8",
    );
    const parsed = parseMemoryMarkdown(markdown);
    assert.equal(parsed.body, "");
    assert.equal(parsed.frontmatter.format, "dubsar.pending-checkpoint/1");
    assert.equal(parsed.frontmatter.declared_source, "worktree-a");
    assert.equal(parsed.frontmatter.checkpoint.checkpoint_id, "cp-pending-candidate-001");
    assert.equal(parsed.frontmatter.source_shared_snapshot_sha256, before.shared_snapshot_sha256);
    assert.equal(parsed.frontmatter.base_checkpoint_sha256, before.documents.checkpoints.entries.at(-1).checkpoint_sha256);
  });
});

test("pending record CLI preview/apply and exact capability token", async () => {
  await withProject(async (root) => {
    const proposalPath = path.join(root, "..", `pending-proposal-${Date.now()}.json`);
    await writeFile(proposalPath, `${JSON.stringify(pendingProposal(), null, 2)}\n`);
    try {
      const capabilities = await invoke(["capabilities", "--json"]);
      assert.equal(capabilities.exitCode, 0);
      const listed = JSON.parse(capabilities.stdout).capabilities;
      assert.equal(
        listed.find((item) => item === "memory.pending-checkpoint-record.v1"),
        "memory.pending-checkpoint-record.v1",
      );
      assert.equal(
        listed.includes("memory.pending-checkpoint-recording.v1"),
        false,
      );

      const preview = await invoke([
        "pending", "record",
        "--start", root,
        "--proposal", proposalPath,
        "--json",
      ]);
      assert.equal(preview.exitCode, 0, preview.stderr);
      const previewValue = JSON.parse(preview.stdout);
      assert.equal(previewValue.format, "dubsar.pending-checkpoint-preview/1");

      const apply = await invoke([
        "pending", "record",
        "--start", root,
        "--proposal", proposalPath,
        "--apply",
        "--expected-change", previewValue.change_sha256,
        "--json",
      ]);
      assert.equal(apply.exitCode, 0, apply.stderr);
      const applyValue = JSON.parse(apply.stdout);
      assert.equal(applyValue.format, "dubsar.pending-checkpoint-apply/1");
      assert.equal(applyValue.target, ".dubsar-pending/worktree-a/cp-pending-candidate-001.md");
    } finally {
      await rm(proposalPath, { force: true });
    }
  });
});

test("pending record rejects duplicate candidate and proposal inside project", async () => {
  await withProject(async (root) => {
    const proposal = pendingProposal();
    await recordCandidate(root, proposal);
    await expectPendingReject(
      root,
      () => previewPendingCheckpointRecord({ start: root, proposal }),
      "PENDING_TARGET_EXISTS",
    );

    const inside = path.join(root, "bad-proposal.json");
    await writeFile(inside, `${JSON.stringify(proposal)}\n`);
    await expectPendingReject(
      root,
      () => previewPendingCheckpointRecord({ start: root, proposalPath: inside }),
      "PENDING_PROPOSAL_LOCATION_INVALID",
    );
  });
});

test("pending record rejects bad expected-change and concurrent canonical drift", async () => {
  await withProject(async (root) => {
    const proposal = pendingProposal({ checkpointId: "cp-expected-change" });
    const preview = await previewPendingCheckpointRecord({ start: root, proposal });
    const before = await dubsarFingerprint(root);
    await assert.rejects(
      () => applyPendingCheckpointRecord({
        start: root,
        proposal,
        expectedChange: "0".repeat(64),
      }),
      (error) => error.code === "PENDING_CONFIRMATION_MISMATCH",
    );
    assert.equal(await dubsarFingerprint(root), before);

    const driftProposal = {
      format: "dubsar.memory-change-proposal/1",
      project_id: PROJECT_ID,
      operation: "checkpoint_append",
      payload: {
        entry: {
          checkpoint_id: "cp-drift-between-preview-apply",
          work_id: WORK_ID,
          kind: "progress",
          summary: "Canonical mutation between pending preview and apply.",
          references: [],
          validation: [],
          limitations: [],
          resolves: null,
          attempt: null,
          resulting_state: {
            status: "active",
            summary: "Drift injected.",
            blockers: [],
            next_action: "Prove pending apply refuses.",
          },
        },
      },
    };
    const pendingPreview = await previewPendingCheckpointRecord({
      start: root,
      proposal: pendingProposal({ checkpointId: "cp-after-drift" }),
    });
    const driftPreview = await previewMemoryChange({ start: root, proposal: driftProposal });
    await applyMemoryChange({
      start: root,
      proposal: driftProposal,
      expectedChange: driftPreview.change_sha256,
    });
    // Rebuild sees the drifted snapshot first, so the preview token no longer
    // matches before the under-lock concurrent guard runs.
    await expectPendingReject(
      root,
      () => applyPendingCheckpointRecord({
        start: root,
        proposal: pendingProposal({ checkpointId: "cp-after-drift" }),
        expectedChange: pendingPreview.change_sha256,
      }),
      "PENDING_CONFIRMATION_MISMATCH",
    );
  });
});

test("pending record rejects malformed proposals and wrong project", async () => {
  await withProject(async (root) => {
    await expectPendingReject(
      root,
      () => previewPendingCheckpointRecord({
        start: root,
        proposal: { format: "nope" },
      }),
      "PENDING_PROPOSAL_INVALID",
    );
    await expectPendingReject(
      root,
      () => previewPendingCheckpointRecord({
        start: root,
        proposal: pendingProposal({ extra: { unexpected: true } }),
      }),
      "PENDING_PROPOSAL_INVALID",
    );
    await expectPendingReject(
      root,
      () => previewPendingCheckpointRecord({
        start: root,
        proposal: pendingProposal({ projectId: "other-project-id-xxx" }),
      }),
      "PENDING_PROPOSAL_INVALID",
    );
  });
});

test("pending record rejects reserved and aliased portable segments", async () => {
  await withProject(async (root) => {
    for (const source of ["con", "prn.txt", "aux", "nul", "com1", "lpt9", "bad.", "com2.md"]) {
      await expectPendingReject(
        root,
        () => previewPendingCheckpointRecord({
          start: root,
          proposal: pendingProposal({ source, checkpointId: "cp-ok-segment-001" }),
        }),
        "PENDING_PROPOSAL_INVALID",
      );
    }
    for (const checkpointId of ["con", "aux.log", "lpt1", "trailing.", "nul"]) {
      await expectPendingReject(
        root,
        () => previewPendingCheckpointRecord({
          start: root,
          proposal: pendingProposal({ checkpointId }),
        }),
        "PENDING_DOCUMENT_INVALID",
      );
    }
  });
});

test("pending record rejects missing work and invalid resolves", async () => {
  await withProject(async (root) => {
    await expectPendingReject(
      root,
      () => previewPendingCheckpointRecord({
        start: root,
        proposal: pendingProposal({ workId: "missing-work-item-001" }),
      }),
      "PENDING_WORK_NOT_FOUND",
    );
    await expectPendingReject(
      root,
      () => previewPendingCheckpointRecord({
        start: root,
        proposal: pendingProposal({ resolves: "cp-does-not-exist-001" }),
      }),
      "PENDING_RESOLVES_INVALID",
    );
  });
});

test("pending record validates references for freshness, absence, hardlink, and secrets", async () => {
  await withProject(async (root) => {
    const relative = "notes/evidence.txt";
    await mkdir(path.join(root, "notes"));
    await writeFile(path.join(root, relative), "fresh evidence\n");
    const digest = createHash("sha256").update("fresh evidence\n").digest("hex");

    await recordCandidate(root, pendingProposal({
      checkpointId: "cp-ref-fresh",
      references: [{ path: relative, sha256: digest }],
    }));

    await expectPendingReject(
      root,
      () => previewPendingCheckpointRecord({
        start: root,
        proposal: pendingProposal({
          checkpointId: "cp-ref-stale",
          references: [{ path: relative, sha256: "a".repeat(64) }],
        }),
      }),
      "PENDING_REFERENCE_INVALID",
    );

    await expectPendingReject(
      root,
      () => previewPendingCheckpointRecord({
        start: root,
        proposal: pendingProposal({
          checkpointId: "cp-ref-missing",
          references: [{ path: "notes/missing.txt", sha256: digest }],
        }),
      }),
      "PATH_NOT_FOUND",
    );

    await writeFile(path.join(root, "notes", "secret.env"), "API_KEY=supersecretvalue\n");
    const secretDigest = createHash("sha256")
      .update("API_KEY=supersecretvalue\n")
      .digest("hex");
    await expectPendingReject(
      root,
      () => previewPendingCheckpointRecord({
        start: root,
        proposal: pendingProposal({
          checkpointId: "cp-ref-secret",
          references: [{ path: "notes/secret.env", sha256: secretDigest }],
        }),
      }),
      "PENDING_REFERENCE_INVALID",
    );

    const hardTarget = path.join(root, "notes", "hard-target.txt");
    const hardAlias = path.join(root, "notes", "hard-alias.txt");
    await writeFile(hardTarget, "hardlinked\n");
    try {
      await link(hardTarget, hardAlias);
    } catch (error) {
      if (error?.code === "EPERM" || error?.code === "ENOTSUP") return;
      throw error;
    }
    const hardDigest = createHash("sha256").update("hardlinked\n").digest("hex");
    await expectPendingReject(
      root,
      () => previewPendingCheckpointRecord({
        start: root,
        proposal: pendingProposal({
          checkpointId: "cp-ref-hardlink",
          references: [{ path: "notes/hard-alias.txt", sha256: hardDigest }],
        }),
      }),
      "FILE_UNSAFE",
    );
  });
});

test("pending record rejects symlink junction reparse under pending when available", async () => {
  await withProject(async (root) => {
    const pendingRoot = path.join(root, ".dubsar-pending");
    await mkdir(pendingRoot);
    const outside = await mkdtemp(path.join(os.tmpdir(), "dubsar-pending-outside-"));
    try {
      const linkType = process.platform === "win32" ? "junction" : "dir";
      try {
        await symlink(outside, path.join(pendingRoot, "worktree-link"), linkType);
      } catch (error) {
        if (error?.code === "EPERM" || error?.code === "ENOTSUP") return;
        throw error;
      }
      await expectPendingReject(
        root,
        () => previewPendingCheckpointRecord({
          start: root,
          proposal: pendingProposal({ checkpointId: "cp-symlink-guard" }),
        }),
        "PENDING_ROOT_UNSAFE",
      );
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

test("pending record rejects hardlink and duplicate physical identity in pending", async () => {
  await withProject(async (root) => {
    const sourceDir = path.join(root, ".dubsar-pending", "worktree-a");
    await mkdir(sourceDir, { recursive: true });
    const first = path.join(sourceDir, "cp-hard-one.md");
    const second = path.join(sourceDir, "cp-hard-two.md");
    await writeFile(first, "candidate\n");
    try {
      await link(first, second);
    } catch (error) {
      if (error?.code === "EPERM" || error?.code === "ENOTSUP") return;
      throw error;
    }
    await expectPendingReject(
      root,
      () => previewPendingCheckpointRecord({
        start: root,
        proposal: pendingProposal({ checkpointId: "cp-after-hardlink" }),
      }),
      "PENDING_ROOT_UNSAFE",
    );
  });
});

test("pending record rejects unknown entries and residual temporary files", async () => {
  await withProject(async (root) => {
    const pendingRoot = path.join(root, ".dubsar-pending");
    await mkdir(pendingRoot);
    await writeFile(path.join(pendingRoot, "README.txt"), "nope\n");
    await expectPendingReject(
      root,
      () => previewPendingCheckpointRecord({
        start: root,
        proposal: pendingProposal({ checkpointId: "cp-unknown-entry" }),
      }),
      "PENDING_ROOT_UNSAFE",
    );
    await rm(path.join(pendingRoot, "README.txt"));
    const sourceDir = path.join(pendingRoot, "worktree-a");
    await mkdir(sourceDir);
    await writeFile(path.join(sourceDir, ".dubsar-pending-deadbeefdeadbeefdeadbeef.tmp"), "tmp\n");
    await expectPendingReject(
      root,
      () => previewPendingCheckpointRecord({
        start: root,
        proposal: pendingProposal({ checkpointId: "cp-residual-tmp" }),
      }),
      "PENDING_ROOT_UNSAFE",
    );
  });
});

test("pending record enforces source candidate size and reference limits", async () => {
  await withProject(async (root) => {
    const pendingRoot = path.join(root, ".dubsar-pending");
    await mkdir(pendingRoot);
    for (let index = 0; index < MEMORY_PENDING_MAX_SOURCES; index += 1) {
      const source = `source-${String(index).padStart(2, "0")}`;
      const dir = path.join(pendingRoot, source);
      await mkdir(dir);
      await writeFile(path.join(dir, `cp-fill-${String(index).padStart(3, "0")}.md`), "x\n");
    }
    await expectPendingReject(
      root,
      () => previewPendingCheckpointRecord({
        start: root,
        proposal: pendingProposal({
          source: "source-extra",
          checkpointId: "cp-source-limit",
        }),
      }),
      "PENDING_LIMIT_EXCEEDED",
    );
    await rm(pendingRoot, { recursive: true, force: true });

    await mkdir(path.join(pendingRoot, "worktree-a"), { recursive: true });
    for (let index = 0; index < MEMORY_PENDING_MAX_CANDIDATES; index += 1) {
      await writeFile(
        path.join(pendingRoot, "worktree-a", `cp-cand-${String(index).padStart(3, "0")}.md`),
        "x\n",
      );
    }
    await expectPendingReject(
      root,
      () => previewPendingCheckpointRecord({
        start: root,
        proposal: pendingProposal({ checkpointId: "cp-cand-overflow" }),
      }),
      "PENDING_LIMIT_EXCEEDED",
    );
    await rm(pendingRoot, { recursive: true, force: true });

    await mkdir(path.join(pendingRoot, "worktree-a"), { recursive: true });
    await writeFile(
      path.join(pendingRoot, "worktree-a", "cp-too-large.md"),
      "x".repeat(MEMORY_PENDING_MAX_FILE_BYTES + 1),
    );
    await expectPendingReject(
      root,
      () => previewPendingCheckpointRecord({
        start: root,
        proposal: pendingProposal({ checkpointId: "cp-after-large" }),
      }),
      "PENDING_LIMIT_EXCEEDED",
    );

    const refs = [];
    for (let index = 0; index < 9; index += 1) {
      const relative = `notes/ref-${index}.txt`;
      await mkdir(path.join(root, "notes"), { recursive: true });
      await writeFile(path.join(root, relative), `ref-${index}\n`);
      refs.push({
        path: relative,
        sha256: createHash("sha256").update(`ref-${index}\n`).digest("hex"),
      });
    }
    await expectPendingReject(
      root,
      () => previewPendingCheckpointRecord({
        start: root,
        proposal: pendingProposal({
          checkpointId: "cp-too-many-refs",
          references: refs,
        }),
      }),
      "PENDING_DOCUMENT_INVALID",
    );
  });
});

test("pending record preview bytes are deterministic and resume/route stay identical", async () => {
  await withProject(async (root) => {
    const proposal = pendingProposal({ checkpointId: "cp-deterministic-001" });
    const first = await previewPendingCheckpointRecord({ start: root, proposal });
    const second = await previewPendingCheckpointRecord({ start: root, proposal });
    assert.equal(first.change_sha256, second.change_sha256);
    assert.equal(first.after_sha256, second.after_sha256);
    assert.equal(first.candidate_sha256, second.candidate_sha256);
    assert.deepEqual(first, second);

    const resumeBefore = await invoke(["resume", "--start", root, "--capsule", "--json"]);
    const routeBefore = await invoke(["route", "--start", root, "--json"]);
    assert.equal(resumeBefore.exitCode, 0, resumeBefore.stderr);
    assert.equal(routeBefore.exitCode, 0, routeBefore.stderr);

    await applyPendingCheckpointRecord({
      start: root,
      proposal,
      expectedChange: first.change_sha256,
    });

    const resumeAfter = await invoke(["resume", "--start", root, "--capsule", "--json"]);
    const routeAfter = await invoke(["route", "--start", root, "--json"]);
    assert.equal(resumeAfter.exitCode, 0, resumeAfter.stderr);
    assert.equal(routeAfter.exitCode, 0, routeAfter.stderr);
    assert.equal(resumeAfter.stdout, resumeBefore.stdout);
    assert.equal(routeAfter.stdout, routeBefore.stdout);

    const published = await readFile(
      path.join(root, ".dubsar-pending", "worktree-a", "cp-deterministic-001.md"),
    );
    assert.equal(createHash("sha256").update(published).digest("hex"), first.after_sha256);
  });
});

test("two Git worktrees record distinct pending sources then merge without canonical mutation", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dubsar-pending-wt-"));
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
  git(repository, ["commit", "-m", "test: pending record common base"]);
  const baseLocation = await locateProjectWorkspace({ start: repository });
  const beforeShared = (await snapshotMemoryWorkspace(baseLocation, resolveLimits()))
    .shared_snapshot_sha256;

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

  const mergedA = path.join(integration, ".dubsar-pending", "agent-a", "cp-from-agent-a.md");
  const mergedB = path.join(integration, ".dubsar-pending", "agent-b", "cp-from-agent-b.md");
  assert.equal((await readFile(mergedA, "utf8")).length > 0, true);
  assert.equal((await readFile(mergedB, "utf8")).length > 0, true);
  for (const tree of [integration, worktreeA, worktreeB]) {
    const location = await locateProjectWorkspace({ start: tree });
    const snapshot = await snapshotMemoryWorkspace(location, resolveLimits());
    assert.equal(snapshot.shared_snapshot_sha256, beforeShared);
  }
});
