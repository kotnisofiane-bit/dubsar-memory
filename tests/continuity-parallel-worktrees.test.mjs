import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { assertMemoryCheckpoints } from "../packages/dubsar-project-continuity/runtime/memory-vnext-contracts.mjs";
import {
  applyMemoryBootstrap,
  previewMemoryBootstrap,
} from "../packages/dubsar-project-continuity/runtime/memory-vnext-bootstrap.mjs";
import {
  applyMemoryChange,
  previewMemoryChange,
} from "../packages/dubsar-project-continuity/runtime/memory-vnext-writer.mjs";

const PROJECT_ID = "parallel-worktrees-project";
const WORK_ID = "parallel-worktrees-work";

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
    title: "Parallel worktree test project",
    work: {
      format: "dubsar.work/1",
      work_id: WORK_ID,
      title: "Validate parallel worktree behavior",
      status: "open",
      scope: "multi_step",
      objective: "Prove that concurrent canonical appends cannot be merged as one chain.",
      acceptance_criteria: [],
      knowledge_ids: [],
      references: [],
    },
    work_body: "",
    selected_work_id: WORK_ID,
    checkpoint: {
      checkpoint_id: "cp-common-base",
      work_id: WORK_ID,
      kind: "progress",
      summary: "Recorded the common checkpoint base.",
      references: [],
      validation: [],
      limitations: [],
      resolves: null,
      attempt: null,
      resulting_state: {
        status: "active",
        summary: "Both worktrees start from the same recorded state.",
        blockers: [],
        next_action: "Run the two independent worktree experiments.",
      },
    },
  };
}

function checkpointProposal(checkpointId, label) {
  return {
    format: "dubsar.memory-change-proposal/1",
    project_id: PROJECT_ID,
    operation: "checkpoint_append",
    payload: {
      entry: {
        checkpoint_id: checkpointId,
        work_id: WORK_ID,
        kind: "progress",
        summary: `Recorded the ${label} worktree result.`,
        references: [],
        validation: [],
        limitations: [],
        resolves: null,
        attempt: null,
        resulting_state: {
          status: "active",
          summary: `The ${label} worktree has a separately valid result.`,
          blockers: [],
          next_action: "Converge the source changes before recording canonical continuity.",
        },
      },
    },
  };
}

async function appendCheckpoint(worktree, checkpointId, label) {
  const proposal = checkpointProposal(checkpointId, label);
  const preview = await previewMemoryChange({ start: worktree, proposal });
  return applyMemoryChange({
    start: worktree,
    proposal,
    expectedChange: preview.change_sha256,
  });
}

test("two Git worktrees create valid sibling checkpoint chains that Git cannot merge", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dubsar-parallel-worktrees-"));
  const repository = path.join(root, "repository");
  const worktreeA = path.join(root, "worktree-a");
  const worktreeB = path.join(root, "worktree-b");
  await mkdir(repository);
  t.after(async () => {
    if (git(repository, ["rev-parse", "--git-dir"], { allowFailure: true }).status === 0) {
      git(repository, ["merge", "--abort"], { allowFailure: true });
      git(repository, ["worktree", "remove", "--force", worktreeA], { allowFailure: true });
      git(repository, ["worktree", "remove", "--force", worktreeB], { allowFailure: true });
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
  git(repository, ["commit", "-m", "test: record common memory base"]);
  git(repository, ["worktree", "add", "-b", "agent-a", worktreeA, "main"]);
  git(repository, ["worktree", "add", "-b", "agent-b", worktreeB, "main"]);

  await appendCheckpoint(worktreeA, "cp-agent-a", "first");
  await appendCheckpoint(worktreeB, "cp-agent-b", "second");
  git(worktreeA, ["add", ".dubsar/checkpoints.json"]);
  git(worktreeA, ["commit", "-m", "test: append agent A checkpoint"]);
  git(worktreeB, ["add", ".dubsar/checkpoints.json"]);
  git(worktreeB, ["commit", "-m", "test: append agent B checkpoint"]);

  const chainA = JSON.parse(await readFile(path.join(worktreeA, ".dubsar", "checkpoints.json"), "utf8"));
  const chainB = JSON.parse(await readFile(path.join(worktreeB, ".dubsar", "checkpoints.json"), "utf8"));
  assertMemoryCheckpoints(chainA, PROJECT_ID);
  assertMemoryCheckpoints(chainB, PROJECT_ID);
  assert.equal(chainA.entries.length, 2);
  assert.equal(chainB.entries.length, 2);
  assert.equal(chainA.entries[1].index, 1);
  assert.equal(chainB.entries[1].index, 1);
  assert.equal(
    chainA.entries[1].previous_checkpoint_sha256,
    chainB.entries[1].previous_checkpoint_sha256,
  );

  const naiveConcatenation = {
    ...chainA,
    entries: [...chainA.entries, chainB.entries[1]],
  };
  assert.throws(
    () => assertMemoryCheckpoints(naiveConcatenation, PROJECT_ID),
    (error) => error?.code === "MEMORY_CHECKPOINTS_INVALID",
  );

  git(repository, ["merge", "--no-ff", "agent-a", "-m", "test: merge agent A"]);
  const conflictingMerge = git(
    repository,
    ["merge", "--no-ff", "agent-b", "-m", "test: merge agent B"],
    { allowFailure: true },
  );
  assert.notEqual(conflictingMerge.status, 0);
  assert.match(
    git(repository, ["status", "--porcelain"]).stdout,
    /^UU \.dubsar\/checkpoints\.json$/mu,
  );
});
