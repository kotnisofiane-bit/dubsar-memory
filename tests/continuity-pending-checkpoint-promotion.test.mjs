import assert from "node:assert/strict";
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
  MEMORY_MAX_CHECKPOINTS,
} from "../packages/dubsar-project-continuity/runtime/memory-vnext-contracts.mjs";
import {
  applyPendingCheckpointPromotion,
  previewPendingCheckpointPromotion,
} from "../packages/dubsar-project-continuity/runtime/memory-vnext-pending-promotion.mjs";
import {
  applyPendingCheckpointRecord,
  previewPendingCheckpointRecord,
} from "../packages/dubsar-project-continuity/runtime/memory-vnext-pending-writer.mjs";
import { snapshotMemoryWorkspace } from "../packages/dubsar-project-continuity/runtime/memory-vnext-snapshot.mjs";
import { locateProjectWorkspace } from "../packages/dubsar-project-continuity/runtime/locate.mjs";
import { resolveLimits, stableJson } from "../packages/dubsar-project-continuity/runtime/contracts.mjs";
import { parseMemoryMarkdown } from "../packages/dubsar-project-continuity/runtime/memory-vnext-markdown.mjs";
import {
  applyMemoryChange,
  previewMemoryChange,
} from "../packages/dubsar-project-continuity/runtime/memory-vnext-writer.mjs";

const PROJECT_ID = "pending-promote-project";
const WORK_ID = "pending-promote-work";
const SOURCE = "worktree-a";

async function invoke(argv) {
  let stdout = "";
  let stderr = "";
  const result = await runContinuityCli(argv, {
    writeOut(value) { stdout += value; },
    writeErr(value) { stderr += value; },
  });
  return { ...result, stdout, stderr };
}

function bootstrapProposal() {
  return {
    format: "dubsar.memory-bootstrap-proposal/1",
    project_id: PROJECT_ID,
    title: "Pending promote test project",
    work: {
      format: "dubsar.work/1",
      work_id: WORK_ID,
      title: "Promote pending candidates",
      status: "open",
      scope: "multi_step",
      objective: "Prove explicit promotion into the canonical chain.",
      acceptance_criteria: [],
      knowledge_ids: [],
      references: [],
    },
    work_body: "",
    selected_work_id: WORK_ID,
    checkpoint: {
      checkpoint_id: "cp-promote-base",
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
        summary: "Ready for pending promotion.",
        blockers: [],
        next_action: "Promote one pending candidate after convergence.",
      },
    },
  };
}

function pendingProposal({
  source = SOURCE,
  checkpointId = "cp-promote-candidate-001",
  resolves = null,
  workId = WORK_ID,
  projectId = PROJECT_ID,
  references = [],
  summary = "Candidate result from one worktree.",
  resultingSummary = "Candidate recorded for later promotion.",
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
        summary: resultingSummary,
        blockers: [],
        next_action: "Promote only after explicit convergence.",
      },
    },
  };
}

function changeProposal(entry) {
  return {
    format: "dubsar.memory-change-proposal/1",
    project_id: PROJECT_ID,
    operation: "checkpoint_append",
    payload: { entry },
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

async function fingerprint(root, folder) {
  return (await shaTree(path.join(root, folder))).join("\n");
}

async function withProject(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), "dubsar-promote-"));
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

async function appendCanonical(root, entry) {
  const proposal = changeProposal(entry);
  const preview = await previewMemoryChange({
    start: root,
    proposal,
    expectedOperation: "checkpoint_append",
  });
  return applyMemoryChange({
    start: root,
    proposal,
    expectedChange: preview.change_sha256,
    expectedOperation: "checkpoint_append",
  });
}

async function expectPromoteReject(root, run, code) {
  const beforeDubsar = await fingerprint(root, ".dubsar");
  const beforePending = await fingerprint(root, ".dubsar-pending").catch(() => "");
  const accepted = new Set(Array.isArray(code) ? code : [code]);
  await assert.rejects(run, (error) => accepted.has(error.code));
  assert.equal(await fingerprint(root, ".dubsar"), beforeDubsar);
  const afterPending = await fingerprint(root, ".dubsar-pending").catch(() => "");
  assert.equal(afterPending, beforePending);
}

async function pendingBytes(root, source, checkpointId) {
  return readFile(path.join(root, ".dubsar-pending", source, `${checkpointId}.md`));
}

test("ready candidate preview and apply promote only checkpoints.json", async () => {
  await withProject(async (root) => {
    const checkpointId = "cp-ready-001";
    await recordCandidate(root, pendingProposal({ checkpointId }));
    const beforeDubsar = await fingerprint(root, ".dubsar");
    const beforePending = await fingerprint(root, ".dubsar-pending");
    const pendingBefore = await pendingBytes(root, SOURCE, checkpointId);

    const resumeBefore = await invoke(["resume", "--start", root, "--capsule", "--json"]);
    const routeBefore = await invoke(["route", "--start", root, "--json"]);

    const preview = await previewPendingCheckpointPromotion({
      start: root,
      source: SOURCE,
      checkpoint: checkpointId,
    });
    assert.equal(preview.format, "dubsar.pending-checkpoint-promotion-preview/1");
    assert.equal(preview.status, "preview");
    assert.equal(preview.candidate_state, "ready");
    assert.equal(preview.stale_chain, false);
    assert.equal(preview.target, "checkpoints.json");
    assert.equal(preview.declared_source, SOURCE);
    assert.equal(preview.checkpoint_id, checkpointId);
    assert.match(preview.consequence, /checkpoints\.json/u);
    assert.match(preview.change_sha256, /^[0-9a-f]{64}$/u);

    const applied = await applyPendingCheckpointPromotion({
      start: root,
      source: SOURCE,
      checkpoint: checkpointId,
      expectedChange: preview.change_sha256,
    });
    assert.equal(applied.format, "dubsar.pending-checkpoint-promotion-apply/1");
    assert.equal(applied.status, "applied");

    const afterPending = await fingerprint(root, ".dubsar-pending");
    assert.equal(afterPending, beforePending);
    assert.deepEqual(await pendingBytes(root, SOURCE, checkpointId), pendingBefore);

    const afterFiles = (await shaTree(path.join(root, ".dubsar")))
      .filter((line) => !line.endsWith("  checkpoints.json"));
    const beforeFiles = beforeDubsar.split("\n").filter((line) => !line.endsWith("  checkpoints.json"));
    assert.deepEqual(afterFiles, beforeFiles);

    const location = await locateProjectWorkspace({ start: root });
    const snapshot = await snapshotMemoryWorkspace(location, resolveLimits());
    assert.equal(snapshot.documents.checkpoints.entries.at(-1).checkpoint_id, checkpointId);

    const resumeAfter = await invoke(["resume", "--start", root, "--capsule", "--json"]);
    const routeAfter = await invoke(["route", "--start", root, "--json"]);
    assert.notEqual(resumeAfter.stdout, resumeBefore.stdout);
    assert.notEqual(routeAfter.stdout, routeBefore.stdout);
  });
});

test("stale_chain on global-only advance allows preview warning and apply", async () => {
  await withProject(async (root) => {
    const secondWork = {
      format: "dubsar.work/1",
      work_id: "pending-promote-work-b",
      title: "Second work",
      status: "open",
      scope: "bounded",
      objective: "Advance global head without touching first work.",
      acceptance_criteria: [],
      knowledge_ids: [],
      references: [],
    };
    const workPreview = await previewMemoryChange({
      start: root,
      proposal: {
        format: "dubsar.memory-change-proposal/1",
        project_id: PROJECT_ID,
        operation: "work_create",
        payload: { work: secondWork, body: "" },
      },
      expectedOperation: "work_create",
    });
    await applyMemoryChange({
      start: root,
      proposal: {
        format: "dubsar.memory-change-proposal/1",
        project_id: PROJECT_ID,
        operation: "work_create",
        payload: { work: secondWork, body: "" },
      },
      expectedChange: workPreview.change_sha256,
      expectedOperation: "work_create",
    });

    const checkpointId = "cp-stale-chain-002";
    await recordCandidate(root, pendingProposal({ checkpointId }));
    await appendCanonical(root, {
      checkpoint_id: "cp-other-work-progress",
      work_id: "pending-promote-work-b",
      kind: "progress",
      summary: "Other work advances global head only.",
      references: [],
      validation: [],
      limitations: [],
      resolves: null,
      attempt: null,
      resulting_state: {
        status: "active",
        summary: "Global advanced; first work head unchanged.",
        blockers: [],
        next_action: "Promote stale_chain candidate.",
      },
    });

    const beforePending = await fingerprint(root, ".dubsar-pending");
    const preview = await previewPendingCheckpointPromotion({
      start: root,
      source: SOURCE,
      checkpoint: checkpointId,
    });
    assert.equal(preview.candidate_state, "stale_chain");
    assert.equal(preview.stale_chain, true);
    assert.match(preview.consequence, /current global parent/u);
    assert.match(preview.consequence, /differs from base_checkpoint_sha256/u);

    const applied = await applyPendingCheckpointPromotion({
      start: root,
      source: SOURCE,
      checkpoint: checkpointId,
      expectedChange: preview.change_sha256,
    });
    assert.equal(applied.status, "applied");
    assert.equal(await fingerprint(root, ".dubsar-pending"), beforePending);

    const location = await locateProjectWorkspace({ start: root });
    const snapshot = await snapshotMemoryWorkspace(location, resolveLimits());
    const last = snapshot.documents.checkpoints.entries.at(-1);
    assert.equal(last.checkpoint_id, checkpointId);
    assert.equal(
      last.previous_checkpoint_sha256,
      snapshot.documents.checkpoints.entries.at(-2).checkpoint_sha256,
    );
  });
});

test("stale_work hard refusal", async () => {
  await withProject(async (root) => {
    const checkpointId = "cp-stale-work-001";
    await recordCandidate(root, pendingProposal({ checkpointId }));
    await appendCanonical(root, {
      checkpoint_id: "cp-same-work-later",
      work_id: WORK_ID,
      kind: "progress",
      summary: "Same work advanced after candidate.",
      references: [],
      validation: [],
      limitations: [],
      resolves: null,
      attempt: null,
      resulting_state: {
        status: "active",
        summary: "Work head moved.",
        blockers: [],
        next_action: "Do not reuse old resulting_state.",
      },
    });
    await expectPromoteReject(
      root,
      () => previewPendingCheckpointPromotion({
        start: root,
        source: SOURCE,
        checkpoint: checkpointId,
      }),
      "PENDING_PROMOTION_STALE_WORK",
    );
  });
});

test("reference changed and missing refuse", async () => {
  await withProject(async (root) => {
    await mkdir(path.join(root, "notes"));
    const relative = "notes/evidence.txt";
    await writeFile(path.join(root, relative), "evidence-v1\n");
    const digest = createHash("sha256").update("evidence-v1\n").digest("hex");
    const checkpointId = "cp-ref-changed-001";
    await recordCandidate(root, pendingProposal({
      checkpointId,
      references: [{ path: relative, sha256: digest }],
    }));

    await writeFile(path.join(root, relative), "evidence-v2\n");
    await expectPromoteReject(
      root,
      () => previewPendingCheckpointPromotion({
        start: root,
        source: SOURCE,
        checkpoint: checkpointId,
      }),
      "PENDING_REFERENCE_INVALID",
    );

    await writeFile(path.join(root, relative), "evidence-v1\n");
    await rm(path.join(root, relative));
    await expectPromoteReject(
      root,
      () => previewPendingCheckpointPromotion({
        start: root,
        source: SOURCE,
        checkpoint: checkpointId,
      }),
      ["PATH_NOT_FOUND", "REQUIRED_FILE_MISSING"],
    );
  });
});

test("sensitive reference refusal", async () => {
  await withProject(async (root) => {
    await mkdir(path.join(root, "notes"));
    const relative = "notes/secret.env";
    await writeFile(path.join(root, relative), "API_KEY=supersecretvalue\n");
    const digest = createHash("sha256").update("API_KEY=supersecretvalue\n").digest("hex");
    const checkpointId = "cp-ref-sensitive-001";
    await recordCandidate(root, pendingProposal({ checkpointId }));
    const candidatePath = path.join(root, ".dubsar-pending", SOURCE, `${checkpointId}.md`);
    const text = await readFile(candidatePath, "utf8");
    const parsed = parseMemoryMarkdown(text);
    const { memoryPendingCandidateDigest } = await import(
      "../packages/dubsar-project-continuity/runtime/memory-vnext-contracts.mjs"
    );
    const { serializeMemoryMarkdown } = await import(
      "../packages/dubsar-project-continuity/runtime/memory-vnext-markdown.mjs"
    );
    const { candidate_sha256: ignored, ...without } = parsed.frontmatter;
    without.checkpoint = {
      ...without.checkpoint,
      references: [{ path: relative, sha256: digest }],
    };
    const next = {
      ...without,
      candidate_sha256: memoryPendingCandidateDigest(without),
    };
    await writeFile(candidatePath, serializeMemoryMarkdown({ frontmatter: next, body: "" }));
    await expectPromoteReject(
      root,
      () => previewPendingCheckpointPromotion({
        start: root,
        source: SOURCE,
        checkpoint: checkpointId,
      }),
      "PENDING_REFERENCE_INVALID",
    );
  });
});

test("missing work hard refusal", async () => {
  await withProject(async (root) => {
    const checkpointId = "cp-missing-work-001";
    await recordCandidate(root, pendingProposal({ checkpointId }));
    const candidatePath = path.join(root, ".dubsar-pending", SOURCE, `${checkpointId}.md`);
    const text = await readFile(candidatePath, "utf8");
    const parsed = parseMemoryMarkdown(text);
    const { memoryPendingCandidateDigest } = await import(
      "../packages/dubsar-project-continuity/runtime/memory-vnext-contracts.mjs"
    );
    const { serializeMemoryMarkdown } = await import(
      "../packages/dubsar-project-continuity/runtime/memory-vnext-markdown.mjs"
    );
    const { candidate_sha256: ignored, ...without } = parsed.frontmatter;
    without.checkpoint = { ...without.checkpoint, work_id: "work-does-not-exist" };
    const next = {
      ...without,
      candidate_sha256: memoryPendingCandidateDigest(without),
    };
    await writeFile(candidatePath, serializeMemoryMarkdown({ frontmatter: next, body: "" }));
    await expectPromoteReject(
      root,
      () => previewPendingCheckpointPromotion({
        start: root,
        source: SOURCE,
        checkpoint: checkpointId,
      }),
      ["PENDING_WORK_NOT_FOUND", "PENDING_ENTRY_INVALID"],
    );
  });
});

test("missing resolves hard refusal", async () => {
  await withProject(async (root) => {
    const checkpointId = "cp-missing-resolves-001";
    await recordCandidate(root, pendingProposal({
      checkpointId,
      resolves: "cp-promote-base",
    }));
    const candidatePath = path.join(root, ".dubsar-pending", SOURCE, `${checkpointId}.md`);
    const text = await readFile(candidatePath, "utf8");
    const parsed = parseMemoryMarkdown(text);
    const { memoryPendingCandidateDigest } = await import(
      "../packages/dubsar-project-continuity/runtime/memory-vnext-contracts.mjs"
    );
    const { serializeMemoryMarkdown } = await import(
      "../packages/dubsar-project-continuity/runtime/memory-vnext-markdown.mjs"
    );
    const { candidate_sha256: ignored, ...without } = parsed.frontmatter;
    without.checkpoint = { ...without.checkpoint, resolves: "cp-never-existed" };
    const next = {
      ...without,
      candidate_sha256: memoryPendingCandidateDigest(without),
    };
    await writeFile(candidatePath, serializeMemoryMarkdown({ frontmatter: next, body: "" }));
    await expectPromoteReject(
      root,
      () => previewPendingCheckpointPromotion({
        start: root,
        source: SOURCE,
        checkpoint: checkpointId,
      }),
      ["PENDING_RESOLVES_INVALID", "PENDING_ENTRY_INVALID"],
    );
  });
});

test("duplicate pending checkpoint id across sources refuses", async () => {
  await withProject(async (root) => {
    const checkpointId = "cp-dup-id-001";
    await recordCandidate(root, pendingProposal({ source: "worktree-a", checkpointId }));
    await recordCandidate(root, pendingProposal({ source: "worktree-b", checkpointId }));
    await expectPromoteReject(
      root,
      () => previewPendingCheckpointPromotion({
        start: root,
        source: "worktree-a",
        checkpoint: checkpointId,
      }),
      "PENDING_PROMOTION_DUPLICATE_ID",
    );
  });
});

test("canonical identical id is already_promoted without write", async () => {
  await withProject(async (root) => {
    const checkpointId = "cp-already-001";
    await recordCandidate(root, pendingProposal({ checkpointId }));
    const firstPreview = await previewPendingCheckpointPromotion({
      start: root,
      source: SOURCE,
      checkpoint: checkpointId,
    });
    await applyPendingCheckpointPromotion({
      start: root,
      source: SOURCE,
      checkpoint: checkpointId,
      expectedChange: firstPreview.change_sha256,
    });
    const beforeDubsar = await fingerprint(root, ".dubsar");
    const beforePending = await fingerprint(root, ".dubsar-pending");
    const secondPreview = await previewPendingCheckpointPromotion({
      start: root,
      source: SOURCE,
      checkpoint: checkpointId,
    });
    assert.equal(secondPreview.status, "already_promoted");
    assert.equal(secondPreview.candidate_state, "already_promoted");
    assert.equal(secondPreview.before_sha256, secondPreview.after_sha256);
    const applied = await applyPendingCheckpointPromotion({
      start: root,
      source: SOURCE,
      checkpoint: checkpointId,
      expectedChange: secondPreview.change_sha256,
    });
    assert.equal(applied.status, "already_promoted");
    assert.equal(await fingerprint(root, ".dubsar"), beforeDubsar);
    assert.equal(await fingerprint(root, ".dubsar-pending"), beforePending);
  });
});

test("canonical same id different author fields collide", async () => {
  await withProject(async (root) => {
    const checkpointId = "cp-collide-001";
    await appendCanonical(root, {
      checkpoint_id: checkpointId,
      work_id: WORK_ID,
      kind: "progress",
      summary: "Canonical entry with different summary.",
      references: [],
      validation: [],
      limitations: [],
      resolves: null,
      attempt: null,
      resulting_state: {
        status: "active",
        summary: "Different author fields.",
        blockers: [],
        next_action: "Collision.",
      },
    });
    await recordCandidate(root, pendingProposal({
      checkpointId,
      summary: "Pending entry with different summary.",
    }));
    await expectPromoteReject(
      root,
      () => previewPendingCheckpointPromotion({
        start: root,
        source: SOURCE,
        checkpoint: checkpointId,
      }),
      "PENDING_PROMOTION_COLLISION",
    );
  });
});

test("candidate changed between capture passes", async () => {
  await withProject(async (root) => {
    const checkpointId = "cp-race-capture-001";
    await recordCandidate(root, pendingProposal({ checkpointId }));
    const beforeDubsar = await fingerprint(root, ".dubsar");
    const candidatePath = path.join(root, ".dubsar-pending", SOURCE, `${checkpointId}.md`);
    await assert.rejects(
      () => previewPendingCheckpointPromotion({
        start: root,
        source: SOURCE,
        checkpoint: checkpointId,
        afterCandidateCapture: async () => {
          await writeFile(candidatePath, `${await readFile(candidatePath, "utf8")}\n`);
        },
      }),
      (error) => ["PENDING_CAPTURE_RACE", "PENDING_ENTRY_INVALID", "PENDING_ROOT_UNSAFE"].includes(error.code),
    );
    assert.equal(await fingerprint(root, ".dubsar"), beforeDubsar);
  });
});

test("candidate changed between preview and apply", async () => {
  await withProject(async (root) => {
    const checkpointId = "cp-race-apply-001";
    await recordCandidate(root, pendingProposal({ checkpointId }));
    const preview = await previewPendingCheckpointPromotion({
      start: root,
      source: SOURCE,
      checkpoint: checkpointId,
    });
    const candidatePath = path.join(root, ".dubsar-pending", SOURCE, `${checkpointId}.md`);
    const text = await readFile(candidatePath, "utf8");
    await writeFile(candidatePath, `${text} `);
    await expectPromoteReject(
      root,
      () => applyPendingCheckpointPromotion({
        start: root,
        source: SOURCE,
        checkpoint: checkpointId,
        expectedChange: preview.change_sha256,
      }),
      ["PENDING_PROMOTION_CONCURRENT", "PENDING_ENTRY_INVALID", "PENDING_CAPTURE_RACE", "PENDING_DOCUMENT_INVALID"],
    );
  });
});

test("canonical chain changed between preview and apply", async () => {
  await withProject(async (root) => {
    const checkpointId = "cp-race-canonical-001";
    await recordCandidate(root, pendingProposal({ checkpointId }));
    const preview = await previewPendingCheckpointPromotion({
      start: root,
      source: SOURCE,
      checkpoint: checkpointId,
    });
    await appendCanonical(root, {
      checkpoint_id: "cp-intervening-before-apply",
      work_id: WORK_ID,
      kind: "progress",
      summary: "Intervening append.",
      references: [],
      validation: [],
      limitations: [],
      resolves: null,
      attempt: null,
      resulting_state: {
        status: "active",
        summary: "Chain moved.",
        blockers: [],
        next_action: "Reject stale promotion apply.",
      },
    });
    await expectPromoteReject(
      root,
      () => applyPendingCheckpointPromotion({
        start: root,
        source: SOURCE,
        checkpoint: checkpointId,
        expectedChange: preview.change_sha256,
      }),
      ["PENDING_PROMOTION_CONCURRENT", "PENDING_PROMOTION_STALE_WORK"],
    );
  });
});

test("symlink junction hardlink and unsafe pending paths refuse", async () => {
  await withProject(async (root) => {
    const pendingRoot = path.join(root, ".dubsar-pending");
    await mkdir(pendingRoot);
    const outside = await mkdtemp(path.join(os.tmpdir(), "dubsar-promote-outside-"));
    try {
      const linkType = process.platform === "win32" ? "junction" : "dir";
      try {
        await symlink(outside, path.join(pendingRoot, "worktree-link"), linkType);
      } catch (error) {
        if (error?.code === "EPERM" || error?.code === "ENOTSUP") return;
        throw error;
      }
      await expectPromoteReject(
        root,
        () => previewPendingCheckpointPromotion({
          start: root,
          source: SOURCE,
          checkpoint: "cp-symlink-guard",
        }),
        ["PENDING_ROOT_UNSAFE", "SYMBOLIC_PATH_REJECTED"],
      );
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  await withProject(async (root) => {
    const checkpointId = "cp-hardlink-promote";
    await recordCandidate(root, pendingProposal({ checkpointId }));
    const sourceDir = path.join(root, ".dubsar-pending", SOURCE);
    const first = path.join(sourceDir, `${checkpointId}.md`);
    const second = path.join(sourceDir, "cp-hard-alias.md");
    try {
      await link(first, second);
    } catch (error) {
      if (error?.code === "EPERM" || error?.code === "ENOTSUP") return;
      throw error;
    }
    await expectPromoteReject(
      root,
      () => previewPendingCheckpointPromotion({
        start: root,
        source: SOURCE,
        checkpoint: checkpointId,
      }),
      ["PENDING_ROOT_UNSAFE", "FILE_UNSAFE"],
    );
  });
});

test("checkpoint journal at capacity refuses append", async () => {
  await withProject(async (root) => {
    const location = await locateProjectWorkspace({ start: root });
    let snapshot = await snapshotMemoryWorkspace(location, resolveLimits());
    let index = snapshot.documents.checkpoints.entries.length;
    while (index < MEMORY_MAX_CHECKPOINTS) {
      await appendCanonical(root, {
        checkpoint_id: `cp-fill-${String(index).padStart(3, "0")}`,
        work_id: WORK_ID,
        kind: "progress",
        summary: `Fill ${index}.`,
        references: [],
        validation: [],
        limitations: [],
        resolves: null,
        attempt: null,
        resulting_state: {
          status: "active",
          summary: `Filled ${index}.`,
          blockers: [],
          next_action: "Continue filling.",
        },
      });
      index += 1;
    }
    const checkpointId = "cp-over-capacity-001";
    await recordCandidate(root, pendingProposal({ checkpointId }));
    await expectPromoteReject(
      root,
      () => previewPendingCheckpointPromotion({
        start: root,
        source: SOURCE,
        checkpoint: checkpointId,
      }),
      "PENDING_PROMOTION_JOURNAL_FULL",
    );
  });
});

test("failed confirmation leaves both roots byte-identical", async () => {
  await withProject(async (root) => {
    const checkpointId = "cp-bad-confirm-001";
    await recordCandidate(root, pendingProposal({ checkpointId }));
    const preview = await previewPendingCheckpointPromotion({
      start: root,
      source: SOURCE,
      checkpoint: checkpointId,
    });
    await expectPromoteReject(
      root,
      () => applyPendingCheckpointPromotion({
        start: root,
        source: SOURCE,
        checkpoint: checkpointId,
        expectedChange: "a".repeat(64),
      }),
      "PENDING_CONFIRMATION_MISMATCH",
    );
    assert.match(preview.change_sha256, /^[0-9a-f]{64}$/u);
  });
});

test("deterministic preview digest and human CLI output", async () => {
  await withProject(async (root) => {
    const checkpointId = "cp-deterministic-promote";
    await recordCandidate(root, pendingProposal({ checkpointId }));
    const first = await previewPendingCheckpointPromotion({
      start: root,
      source: SOURCE,
      checkpoint: checkpointId,
    });
    const second = await previewPendingCheckpointPromotion({
      start: root,
      source: SOURCE,
      checkpoint: checkpointId,
    });
    assert.equal(first.change_sha256, second.change_sha256);
    assert.deepEqual(first, second);

    const capabilities = await invoke(["capabilities", "--json"]);
    assert.equal(capabilities.exitCode, 0);
    const listed = JSON.parse(capabilities.stdout).capabilities;
    assert.equal(
      listed.find((item) => item === "memory.pending-checkpoint-promotion.v1"),
      "memory.pending-checkpoint-promotion.v1",
    );

    const human = await invoke([
      "pending", "promote",
      "--start", root,
      "--source", SOURCE,
      "--checkpoint", checkpointId,
    ]);
    assert.equal(human.exitCode, 0, human.stderr);
    assert.match(human.stdout, new RegExp(`Source: ${SOURCE}`, "u"));
    assert.match(human.stdout, new RegExp(`Checkpoint: ${checkpointId}`, "u"));
    assert.match(human.stdout, /Change SHA-256: [0-9a-f]{64}/u);
    assert.match(human.stdout, /checkpoints\.json/u);

    const applyHuman = await invoke([
      "pending", "promote",
      "--start", root,
      "--source", SOURCE,
      "--checkpoint", checkpointId,
      "--apply",
      "--expected-change", first.change_sha256,
    ]);
    assert.equal(applyHuman.exitCode, 0, applyHuman.stderr);
    assert.match(applyHuman.stdout, new RegExp(`Source: ${SOURCE}`, "u"));
    assert.match(applyHuman.stdout, new RegExp(`Checkpoint: ${checkpointId}`, "u"));
    assert.match(applyHuman.stdout, new RegExp(`Change SHA-256: ${first.change_sha256}`, "u"));
  });
});

test("resume and route unchanged until successful canonical apply", async () => {
  await withProject(async (root) => {
    const checkpointId = "cp-resume-route-001";
    await recordCandidate(root, pendingProposal({ checkpointId }));
    const resumeBefore = await invoke(["resume", "--start", root, "--capsule", "--json"]);
    const routeBefore = await invoke(["route", "--start", root, "--json"]);
    const preview = await previewPendingCheckpointPromotion({
      start: root,
      source: SOURCE,
      checkpoint: checkpointId,
    });
    const resumePreview = await invoke(["resume", "--start", root, "--capsule", "--json"]);
    const routePreview = await invoke(["route", "--start", root, "--json"]);
    assert.equal(resumePreview.stdout, resumeBefore.stdout);
    assert.equal(routePreview.stdout, routeBefore.stdout);

    await applyPendingCheckpointPromotion({
      start: root,
      source: SOURCE,
      checkpoint: checkpointId,
      expectedChange: preview.change_sha256,
    });
    const resumeAfter = await invoke(["resume", "--start", root, "--capsule", "--json"]);
    const routeAfter = await invoke(["route", "--start", root, "--json"]);
    assert.notEqual(resumeAfter.stdout, resumeBefore.stdout);
    assert.notEqual(routeAfter.stdout, routeBefore.stdout);
    assert.ok(stableJson(JSON.parse(resumeAfter.stdout)));
  });
});
