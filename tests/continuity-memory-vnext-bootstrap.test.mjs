import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, open, readdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runContinuityCli } from "../packages/dubsar-project-continuity/runtime/cli.mjs";
import {
  applyMemoryBootstrap,
  previewMemoryBootstrap,
} from "../packages/dubsar-project-continuity/runtime/memory-vnext-bootstrap.mjs";
import {
  applyMemoryInitialization,
  previewMemoryInitialization,
} from "../packages/dubsar-project-continuity/runtime/memory-vnext-initializer.mjs";
import {
  applyMemoryChange,
  previewMemoryChange,
} from "../packages/dubsar-project-continuity/runtime/memory-vnext-writer.mjs";
import {
  buildMemoryResumeCapsule,
} from "../packages/dubsar-project-continuity/runtime/memory-vnext-capsule.mjs";
import { inspectWorkspace } from "../packages/dubsar-project-continuity/runtime/index.mjs";
import { parseMemoryMarkdown } from "../packages/dubsar-project-continuity/runtime/memory-vnext-markdown.mjs";

const PROJECT_ID = "project-bootstrap-001";
const INIT_LOCK = ".dubsar-memory-init.lock";

function errorCode(code) {
  return (error) => error?.code === code;
}

function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function bootstrapProposal(overrides = {}) {
  return {
    format: "dubsar.memory-bootstrap-proposal/1",
    project_id: PROJECT_ID,
    title: "Bootstrap continuity project",
    work: {
      format: "dubsar.work/1",
      work_id: "validate-cursor-continuity",
      title: "Validate Cursor continuity",
      status: "open",
      scope: "multi_session",
      objective: "Prove that Cursor can record and later resume Spec Kit work.",
      acceptance_criteria: [],
      knowledge_ids: [],
      references: [],
    },
    work_body: "",
    selected_work_id: "validate-cursor-continuity",
    checkpoint: {
      checkpoint_id: "cp-bootstrap-first",
      work_id: "validate-cursor-continuity",
      kind: "progress",
      summary: "Create project memory recorded the first continuity fact.",
      references: [],
      validation: [],
      limitations: [],
      resolves: null,
      attempt: null,
      resulting_state: {
        status: "active",
        summary: "Active work selected with First recorded checkpoint.",
        blockers: [],
        next_action: "Resume later to verify continuity of this recorded checkpoint.",
      },
    },
    ...overrides,
  };
}

async function runCli(argv) {
  let stdout = "";
  let stderr = "";
  const result = await runContinuityCli(argv, {
    writeOut(value) { stdout += value; },
    writeErr(value) { stderr += value; },
  });
  return { ...result, stdout, stderr };
}

async function assertCleanRefusal(projectRoot, { allowHeldLock = false } = {}) {
  await assert.rejects(readFile(path.join(projectRoot, ".dubsar", "manifest.json")), /ENOENT/u);
  const entries = await readdir(projectRoot);
  assert.equal(
    entries.some((name) => name.startsWith(".dubsar-memory-bootstrap-")),
    false,
    "no bootstrap staging residue",
  );
  if (!allowHeldLock) {
    assert.equal(entries.includes(INIT_LOCK), false, "no residual init/bootstrap lock");
  }
}

test("memory bootstrap is previewed, digest-bound, and published atomically", async (t) => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "dubsar-memory-bootstrap-"));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  const specPath = path.join(projectRoot, "specs", "001-feature", "spec.md");
  await mkdir(path.dirname(specPath), { recursive: true });
  const specBytes = Buffer.from("# Spec\n\nBootstrap reference.\n", "utf8");
  await writeFile(specPath, specBytes);
  const proposal = bootstrapProposal({
    checkpoint: {
      ...bootstrapProposal().checkpoint,
      references: [{
        path: "specs/001-feature/spec.md",
        sha256: sha256Hex(specBytes),
      }],
    },
  });

  const first = await previewMemoryBootstrap({ start: projectRoot, proposal });
  const second = await previewMemoryBootstrap({ start: projectRoot, proposal });
  assert.deepEqual(second, first);
  assert.equal(first.format, "dubsar.memory-bootstrap-preview/1");
  assert.equal(first.status, "preview");
  assert.equal(first.operation, "bootstrap_memory_vnext");
  assert.equal(first.target, ".dubsar");
  assert.equal(first.work_id, "validate-cursor-continuity");
  assert.equal(first.checkpoint_id, "cp-bootstrap-first");
  assert.match(first.change_sha256, /^[0-9a-f]{64}$/u);
  assert.deepEqual(Object.keys(first).sort(), [
    "change_sha256",
    "checkpoint_id",
    "consequence",
    "file_sha256",
    "format",
    "operation",
    "project_id",
    "proposal_sha256",
    "status",
    "summary",
    "target",
    "work_id",
  ], "bootstrap preview /1 JSON keys stay closed");
  assert.equal(
    first.summary,
    "Create project memory with one Active work and one First recorded checkpoint.",
  );
  await assert.rejects(readFile(path.join(projectRoot, ".dubsar", "manifest.json")), /ENOENT/u);
  await assert.rejects(
    applyMemoryBootstrap({
      start: projectRoot,
      proposal,
      expectedChange: "0".repeat(64),
    }),
    errorCode("MEMORY_BOOTSTRAP_CONFIRMATION_MISMATCH"),
  );
  await assert.rejects(readFile(path.join(projectRoot, ".dubsar", "manifest.json")), /ENOENT/u);

  const applied = await applyMemoryBootstrap({
    start: projectRoot,
    proposal,
    expectedChange: first.change_sha256,
  });
  assert.equal(applied.format, "dubsar.memory-bootstrap-apply/1");
  assert.equal(applied.status, "applied");
  assert.equal(applied.change_sha256, first.change_sha256);
  assert.equal(applied.work_id, "validate-cursor-continuity");
  assert.equal(applied.checkpoint_id, "cp-bootstrap-first");

  const local = JSON.parse(await readFile(path.join(projectRoot, ".dubsar", "local.json"), "utf8"));
  assert.equal(local.selected_work_id, "validate-cursor-continuity");
  const checkpoints = JSON.parse(
    await readFile(path.join(projectRoot, ".dubsar", "checkpoints.json"), "utf8"),
  );
  assert.equal(checkpoints.entries.length, 1);
  assert.equal(checkpoints.entries[0].index, 0);
  assert.equal(checkpoints.entries[0].work_id, "validate-cursor-continuity");
  const work = parseMemoryMarkdown(
    await readFile(path.join(projectRoot, ".dubsar", "work", "validate-cursor-continuity.md"), "utf8"),
  );
  assert.equal(work.frontmatter.work_id, "validate-cursor-continuity");

  const inspection = await inspectWorkspace({
    start: projectRoot,
    domain: "project",
    observeReferences: true,
  });
  const capsule = buildMemoryResumeCapsule({ inspection, producer: {
    name: "@dubsar/project-continuity",
    version: "0.3.0-dev",
  } });
  assert.equal(capsule.active_work.work_id, "validate-cursor-continuity");
  assert.equal(capsule.recorded_continuity.length, 1);
  assert.equal(capsule.format, "dubsar.resume-capsule/4");
  assert.equal(capsule.evidence_freshness.status, "fresh");
  assert.equal(
    capsule.next_action.label,
    proposal.checkpoint.resulting_state.next_action,
    "recorded next_action survives apply unchanged into the resume capsule",
  );

  await assert.rejects(
    previewMemoryBootstrap({ start: projectRoot, proposal }),
    errorCode("WORKSPACE_ALREADY_EXISTS"),
  );
});

test("memory bootstrap refuses selection mismatch, non-null resolves, and in-project proposals", async (t) => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "dubsar-memory-bootstrap-refuse-"));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));

  await assert.rejects(
    previewMemoryBootstrap({
      start: projectRoot,
      proposal: bootstrapProposal({ selected_work_id: "other-work" }),
    }),
    errorCode("MEMORY_BOOTSTRAP_SELECTION_MISMATCH"),
  );
  await assertCleanRefusal(projectRoot);
  await assert.rejects(
    previewMemoryBootstrap({
      start: projectRoot,
      proposal: bootstrapProposal({
        checkpoint: { ...bootstrapProposal().checkpoint, resolves: "cp-missing" },
      }),
    }),
    errorCode("MEMORY_BOOTSTRAP_PROPOSAL_INVALID"),
  );
  await assertCleanRefusal(projectRoot);
  await assert.rejects(
    previewMemoryBootstrap({
      start: projectRoot,
      proposal: bootstrapProposal({
        work: {
          ...bootstrapProposal().work,
          knowledge_ids: ["knowledge-missing"],
        },
      }),
    }),
    errorCode("MEMORY_KNOWLEDGE_NOT_FOUND"),
  );
  await assertCleanRefusal(projectRoot);

  const inside = path.join(projectRoot, "proposal.json");
  await writeFile(inside, JSON.stringify(bootstrapProposal()));
  await assert.rejects(
    previewMemoryBootstrap({ start: projectRoot, proposalPath: inside }),
    errorCode("MEMORY_BOOTSTRAP_PROPOSAL_LOCATION_INVALID"),
  );
  await assertCleanRefusal(projectRoot);
});

test("shared init lock blocks bootstrap apply and init publish", async (t) => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "dubsar-memory-bootstrap-held-lock-"));
  const proposal = bootstrapProposal();
  const preview = await previewMemoryBootstrap({ start: projectRoot, proposal });
  const lockPath = path.join(projectRoot, INIT_LOCK);
  const lockHandle = await open(lockPath, "wx", 0o600);
  t.after(async () => {
    await lockHandle.close().catch(() => {});
    await unlink(lockPath).catch(() => {});
    await rm(projectRoot, { recursive: true, force: true });
  });

  await assert.rejects(
    applyMemoryBootstrap({
      start: projectRoot,
      proposal,
      expectedChange: preview.change_sha256,
    }),
    errorCode("MEMORY_BOOTSTRAP_LOCKED"),
  );
  await assertCleanRefusal(projectRoot, { allowHeldLock: true });

  const initProposal = {
    format: "dubsar.memory-init-proposal/1",
    project_id: PROJECT_ID,
    title: "Init blocked by shared lock",
  };
  const initPreview = await previewMemoryInitialization({ start: projectRoot, proposal: initProposal });
  await assert.rejects(
    applyMemoryInitialization({
      start: projectRoot,
      proposal: initProposal,
      expectedChange: initPreview.change_sha256,
    }),
    errorCode("MEMORY_INIT_LOCKED"),
  );
  await assertCleanRefusal(projectRoot, { allowHeldLock: true });
});

test("memory bootstrap refuses legacy sibling, bad references, and extra proposal keys", async (t) => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "dubsar-memory-bootstrap-refuse-more-"));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));

  await mkdir(path.join(projectRoot, ".dubsar-project"));
  await assert.rejects(
    previewMemoryBootstrap({ start: projectRoot, proposal: bootstrapProposal() }),
    errorCode("MEMORY_MIGRATION_REQUIRED"),
  );
  await assertCleanRefusal(projectRoot);
  await rm(path.join(projectRoot, ".dubsar-project"), { recursive: true, force: true });

  const specPath = path.join(projectRoot, "specs", "001-feature", "spec.md");
  await mkdir(path.dirname(specPath), { recursive: true });
  const specBytes = Buffer.from("# Spec\n\nBootstrap reference.\n", "utf8");
  await writeFile(specPath, specBytes);

  await assert.rejects(
    previewMemoryBootstrap({
      start: projectRoot,
      proposal: bootstrapProposal({
        checkpoint: {
          ...bootstrapProposal().checkpoint,
          references: [{
            path: "specs/001-feature/spec.md",
            sha256: "a".repeat(64),
          }],
        },
      }),
    }),
    errorCode("MEMORY_REFERENCE_INVALID"),
  );
  await assertCleanRefusal(projectRoot);

  await assert.rejects(
    previewMemoryBootstrap({
      start: projectRoot,
      proposal: bootstrapProposal({
        checkpoint: {
          ...bootstrapProposal().checkpoint,
          references: [{
            path: ".dubsar/manifest.json",
            sha256: "b".repeat(64),
          }],
        },
      }),
    }),
    errorCode("MEMORY_REFERENCE_UNSAFE"),
  );
  await assertCleanRefusal(projectRoot);

  await assert.rejects(
    previewMemoryBootstrap({
      start: projectRoot,
      proposal: {
        ...bootstrapProposal(),
        unexpected: true,
      },
    }),
    errorCode("MEMORY_BOOTSTRAP_PROPOSAL_INVALID"),
  );
  await assertCleanRefusal(projectRoot);
});

test("memory bootstrap shares the init lock and leaves granular writes available afterward", async (t) => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "dubsar-memory-bootstrap-lock-"));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  const proposal = bootstrapProposal();
  const preview = await previewMemoryBootstrap({ start: projectRoot, proposal });
  await applyMemoryBootstrap({
    start: projectRoot,
    proposal,
    expectedChange: preview.change_sha256,
  });

  const workProposal = {
    format: "dubsar.memory-change-proposal/1",
    project_id: PROJECT_ID,
    operation: "work_create",
    payload: {
      work: {
        format: "dubsar.work/1",
        work_id: "work-second",
        title: "Second work item",
        status: "open",
        scope: "bounded",
        objective: "Prove granular writes still work after bootstrap.",
        acceptance_criteria: [],
        knowledge_ids: [],
        references: [],
      },
      body: "",
    },
  };
  const workPreview = await previewMemoryChange({ start: projectRoot, proposal: workProposal });
  await applyMemoryChange({
    start: projectRoot,
    proposal: workProposal,
    expectedChange: workPreview.change_sha256,
  });
  assert.equal(
    (await readFile(path.join(projectRoot, ".dubsar", "work", "work-second.md"), "utf8")).length > 0,
    true,
  );
});

test("CLI bootstrap mirrors the module preview and apply contract", async (t) => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "dubsar-memory-bootstrap-cli-"));
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "dubsar-memory-bootstrap-cli-prop-"));
  t.after(async () => {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(tempRoot, { recursive: true, force: true });
  });
  const proposalPath = path.join(tempRoot, "bootstrap.json");
  await writeFile(proposalPath, `${JSON.stringify(bootstrapProposal(), null, 2)}\n`);

  const preview = await runCli([
    "bootstrap", "--start", projectRoot, "--proposal", proposalPath, "--json",
  ]);
  assert.equal(preview.exitCode, 0);
  const previewDoc = JSON.parse(preview.stdout);
  assert.equal(previewDoc.format, "dubsar.memory-bootstrap-preview/1");

  const applied = await runCli([
    "bootstrap", "--start", projectRoot, "--proposal", proposalPath,
    "--apply", "--expected-change", previewDoc.change_sha256, "--json",
  ]);
  assert.equal(applied.exitCode, 0);
  const applyDoc = JSON.parse(applied.stdout);
  assert.equal(applyDoc.format, "dubsar.memory-bootstrap-apply/1");
  assert.equal(applyDoc.status, "applied");
});

test("CLI human bootstrap preview names Create project memory, Active work, and First recorded checkpoint", async (t) => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "dubsar-memory-bootstrap-human-"));
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "dubsar-memory-bootstrap-human-prop-"));
  t.after(async () => {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(tempRoot, { recursive: true, force: true });
  });
  const proposal = bootstrapProposal();
  const proposalPath = path.join(tempRoot, "bootstrap.json");
  await writeFile(proposalPath, `${JSON.stringify(proposal, null, 2)}\n`);

  const preview = await runCli([
    "bootstrap", "--start", projectRoot, "--proposal", proposalPath,
  ]);
  assert.equal(preview.exitCode, 0);
  assert.match(preview.stdout, /Create project memory/u);
  assert.match(preview.stdout, /Active work: validate-cursor-continuity/u);
  assert.match(preview.stdout, /First recorded checkpoint: cp-bootstrap-first/u);
  assert.match(
    preview.stdout,
    new RegExp(`After bootstrap, do next: ${proposal.checkpoint.resulting_state.next_action}`, "u"),
  );
  const digests = [...preview.stdout.matchAll(/Change SHA-256: ([0-9a-f]{64})/gu)];
  assert.equal(digests.length, 1);
  await assertCleanRefusal(projectRoot);

  const jsonPreview = await runCli([
    "bootstrap", "--start", projectRoot, "--proposal", proposalPath, "--json",
  ]);
  assert.equal(jsonPreview.exitCode, 0);
  const previewDoc = JSON.parse(jsonPreview.stdout);
  assert.equal(Object.hasOwn(previewDoc, "next_action"), false,
    "JSON bootstrap preview /1 must not gain a next_action field");
});

test("bootstrap capsule keeps the authored post-apply next_action", async (t) => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "dubsar-memory-bootstrap-next-"));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  const nextAction = "Review the catalog submission draft before requesting publication approval.";
  const proposal = bootstrapProposal({
    checkpoint: {
      ...bootstrapProposal().checkpoint,
      resulting_state: {
        ...bootstrapProposal().checkpoint.resulting_state,
        next_action: nextAction,
      },
    },
  });
  const preview = await previewMemoryBootstrap({ start: projectRoot, proposal });
  await applyMemoryBootstrap({
    start: projectRoot,
    proposal,
    expectedChange: preview.change_sha256,
  });
  const inspection = await inspectWorkspace({
    start: projectRoot,
    domain: "project",
    observeReferences: true,
  });
  const capsule = buildMemoryResumeCapsule({
    inspection,
    producer: { name: "@dubsar/project-continuity", version: "0.3.0-dev" },
  });
  assert.equal(capsule.next_action.label, nextAction);
  const checkpoints = JSON.parse(
    await readFile(path.join(projectRoot, ".dubsar", "checkpoints.json"), "utf8"),
  );
  assert.equal(checkpoints.entries[0].resulting_state.next_action, nextAction);
});

test("init still publishes an empty workspace without bootstrap", async (t) => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "dubsar-memory-init-compat-"));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  const proposal = {
    format: "dubsar.memory-init-proposal/1",
    project_id: PROJECT_ID,
    title: "Init remains available",
  };
  const preview = await previewMemoryInitialization({ start: projectRoot, proposal });
  await applyMemoryInitialization({
    start: projectRoot,
    proposal,
    expectedChange: preview.change_sha256,
  });
  const local = JSON.parse(await readFile(path.join(projectRoot, ".dubsar", "local.json"), "utf8"));
  assert.equal(local.selected_work_id, null);
  const checkpoints = JSON.parse(
    await readFile(path.join(projectRoot, ".dubsar", "checkpoints.json"), "utf8"),
  );
  assert.deepEqual(checkpoints.entries, []);
});
