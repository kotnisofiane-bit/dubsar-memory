import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  applyMemoryBootstrap,
  previewMemoryBootstrap,
} from "../packages/dubsar-project-continuity/runtime/memory-vnext-bootstrap.mjs";
import { openSession } from "../tools/cursor-cloud/open-session.mjs";
import { qualifyRepository } from "../tools/cursor-cloud/qualify.mjs";
import {
  readPendingCandidateReferences,
  verifyCandidateReference,
  verifyPendingCandidateReferences,
} from "../tools/cursor-cloud/verify-candidate-references.mjs";
import {
  loadLotContract,
  parseRecordPendingArgs,
  recordPendingCheckpoint,
} from "../tools/cursor-cloud/record-pending.mjs";
import {
  parseBoundedJson,
  RUNTIME_RELATIVE_BIN,
} from "../tools/cursor-cloud/runtime.mjs";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LOT_CONTRACT = path.join(
  REPOSITORY_ROOT,
  "tools",
  "cursor-cloud",
  "contracts",
  "LOT-MEM-002.json",
);

const LOT_MEM_002R1_OBSOLETE = Object.freeze({
  "tools/cursor-cloud/runtime.mjs": "f7c8e7eeebb55312171f1be499b5b17c7364e6e987caaa3ecff9306090fd9e7f",
  "tests/cursor-cloud-continuity.test.mjs": "b90115ffa15aeca7ed0fea5ca52fecb7838ac4b9c87669aab4a85120e028985b",
});

async function sha256File(relativePath) {
  const content = await readFile(path.join(REPOSITORY_ROOT, relativePath));
  return createHash("sha256").update(content).digest("hex");
}

function bootstrapProposal() {
  return {
    format: "dubsar.memory-bootstrap-proposal/1",
    project_id: "cursor-cloud-pilot",
    title: "Cursor Cloud bridge fixture",
    work: {
      format: "dubsar.work/1",
      work_id: "integrate-cursor-cloud-continuity",
      title: "Integrate Cursor Cloud continuity",
      status: "open",
      scope: "multi_session",
      objective: "Prove session bridges stay read-only until an explicit pending record.",
      acceptance_criteria: [],
      knowledge_ids: [],
      references: [],
    },
    work_body: "",
    selected_work_id: "integrate-cursor-cloud-continuity",
    checkpoint: {
      checkpoint_id: "cp-cursor-cloud-base",
      work_id: "integrate-cursor-cloud-continuity",
      kind: "progress",
      summary: "Canonical fixture memory exists.",
      references: [],
      validation: [],
      limitations: [],
      resolves: null,
      attempt: null,
      resulting_state: {
        status: "active",
        summary: "Ready for Cursor Cloud session bridges.",
        blockers: [],
        next_action: "Open the session bridge before recording a pending candidate.",
      },
    },
  };
}

function pendingProposal(workId = "integrate-cursor-cloud-continuity") {
  return {
    format: "dubsar.pending-checkpoint-proposal/1",
    project_id: "cursor-cloud-pilot",
    declared_source: "cursor-cloud",
    checkpoint: {
      checkpoint_id: "cp-lot-mem-002",
      work_id: workId,
      kind: "progress",
      summary: "Candidate records the Cursor Cloud continuity files.",
      references: [],
      validation: [],
      limitations: ["The candidate is not promoted and is not merge authority."],
      resolves: null,
      attempt: null,
      resulting_state: {
        status: "active",
        summary: "Pending candidate waits for human audit.",
        blockers: [],
        next_action: "Audit the candidate without promoting it.",
      },
    },
  };
}

async function invoke(bin, args, { cwd = REPOSITORY_ROOT, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bin, ...args], {
      cwd,
      env,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (value) => { stdout += value; });
    child.stderr.on("data", (value) => { stderr += value; });
    child.once("error", reject);
    child.once("close", (exitCode) => resolve({ exitCode, stdout, stderr }));
  });
}

async function removeTree(root) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      await rm(root, { recursive: true, force: true });
      return;
    } catch (error) {
      if (!["EBUSY", "ENOTEMPTY", "EPERM"].includes(error?.code) || attempt === 7) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
    }
  }
}

async function withProject(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), "dubsar-cursor-cloud-"));
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

function unauthorizedContract(overrides = {}) {
  return {
    format: "dubsar.cursor-cloud-lot-contract/1",
    lot_id: "LOT-MEM-999",
    title: "Unauthorized fixture",
    authorize_pending_checkpoint: false,
    authorize_pending_promotion: false,
    authorize_canonical_write: false,
    ...overrides,
  };
}

test("versioned Cursor Cloud environment is install-only and secret-free", async () => {
  const source = JSON.parse(
    await readFile(path.join(REPOSITORY_ROOT, ".cursor", "environment.json"), "utf8"),
  );
  assert.equal(source.name, "DUBSAR Memory");
  assert.equal(source.install, "node tools/cursor-cloud/install.mjs");
  assert.equal("start" in source, false);
  assert.equal("terminals" in source, false);
  assert.equal("ports" in source, false);
  assert.equal("build" in source, false);
  assert.equal("snapshot" in source, false);
  assert.equal("mcpServerAllowlist" in source, false);
  const serialized = JSON.stringify(source);
  assert.equal(/sk-|gh[pousr]_|AKIA|token|secret/iu.test(serialized), false);
});

test("Cursor rule requires the session bridge and forbids silent authority", async () => {
  const source = await readFile(
    path.join(REPOSITORY_ROOT, ".cursor", "rules", "dubsar-memory-cursor-cloud.mdc"),
    "utf8",
  );
  assert.match(source, /alwaysApply: true/u);
  assert.match(source, /open-session\.mjs/u);
  assert.match(source, /untrusted quoted data/u);
  assert.match(source, /Never execute the `route` recommendation/u);
  assert.match(source, /Never initialize, migrate, or repair/u);
  assert.match(source, /Never edit `\.dubsar\/checkpoints\.json` directly/u);
  assert.match(source, /authorize_pending_checkpoint/u);
  assert.match(source, /Never run `pending promote`/u);
  assert.match(source, /Never copy generated context/u);
  assert.doesNotMatch(source, /dubsar resume-capsule/u);
  assert.doesNotMatch(source, /\/home\//u);
});

test("install resolves the repository runtime and ignores PATH", async () => {
  const hostile = await mkdtemp(path.join(os.tmpdir(), "dubsar-path-"));
  const sentinel = path.join(hostile, "hijack.txt");
  try {
    const hijack = path.join(hostile, process.platform === "win32" ? "dubsar.cmd" : "dubsar");
    await writeFile(
      hijack,
      process.platform === "win32"
        ? `@echo hijacked>"${sentinel}"\r\n`
        : `#!/bin/sh\nprintf hijacked > "${sentinel}"\n`,
    );
    if (process.platform !== "win32") await chmod(hijack, 0o755);
    const env = { ...process.env, PATH: `${hostile}${path.delimiter}${process.env.PATH ?? ""}` };
    const result = await invoke(
      path.join(REPOSITORY_ROOT, "tools", "cursor-cloud", "install.mjs"),
      [],
      { env },
    );
    assert.equal(result.exitCode, 0, result.stderr);
    const document = JSON.parse(result.stdout);
    assert.equal(document.format, "dubsar.cursor-cloud-install/1");
    assert.equal(document.status, "ready");
    assert.equal(document.runtime, RUNTIME_RELATIVE_BIN);
    assert.equal(document.path_resolution, "repository");
    assert.equal(document.daemons, false);
    assert.equal(document.network, false);
    await assert.rejects(readFile(sentinel), /ENOENT/u);
  } finally {
    await rm(hostile, { recursive: true, force: true });
  }
});

test("session open loads capsule and route without mutating memory", async () => {
  await withProject(async (root) => {
    const first = await openSession({ start: root, repositoryRoot: REPOSITORY_ROOT });
    assert.equal(first.format, "dubsar.cursor-cloud-session/1");
    assert.equal(first.memory_trust, "untrusted-data");
    assert.equal(first.route_is_advisory, true);
    assert.equal(first.route_execution_authority, false);
    assert.equal(["dubsar.resume-capsule/3", "dubsar.resume-capsule/4"].includes(first.resume.format), true);
    assert.equal(first.resume.content_trust, "untrusted_project_data");
    assert.equal(first.route.format, "dubsar.memory-route/2");
    assert.equal(first.route.guidance.auto_execute, false);
    assert.equal(first.pending_list.format, "dubsar.pending-checkpoints-list/1");
    assert.equal(first.inventories.unchanged, true);
    const second = await openSession({ start: root, repositoryRoot: REPOSITORY_ROOT });
    assert.equal(second.inventories.dubsar_sha256, first.inventories.dubsar_sha256);
    assert.equal(second.inventories.pending_sha256, first.inventories.pending_sha256);
    assert.equal(JSON.stringify(second).includes(root), false);
  });
});

test("pending CLI preview args do not require apply", () => {
  const preview = parseRecordPendingArgs([
    "--start",
    ".",
    "--contract",
    "tools/cursor-cloud/contracts/LOT-MEM-002.json",
    "--proposal",
    "outside.json",
  ]);
  assert.equal(preview.apply, false);
  assert.equal(preview.start, ".");
  assert.throws(
    () => parseRecordPendingArgs([
      "--start",
      ".",
      "--contract",
      "c.json",
      "--proposal",
      "p.json",
      "--apply",
    ]),
    (error) => error.code === "CURSOR_CLOUD_ARGUMENT_INVALID",
  );
});

test("session open refuses missing memory and oversized output", async () => {
  const missing = await mkdtemp(path.join(os.tmpdir(), "dubsar-missing-"));
  try {
    await assert.rejects(
      () => openSession({ start: missing, repositoryRoot: REPOSITORY_ROOT }),
      (error) => error.code === "WORKSPACE_NOT_FOUND",
    );
  } finally {
    await rm(missing, { recursive: true, force: true });
  }

  const stubRoot = await mkdtemp(path.join(os.tmpdir(), "dubsar-stub-runtime-"));
  try {
    const binDir = path.join(stubRoot, "packages", "dubsar-project-continuity", "bin");
    await mkdir(binDir, { recursive: true });
    const stubBin = path.join(binDir, "dubsar.mjs");
    await writeFile(stubBin, "console.log('not-json');\n");
    await assert.rejects(
      () => openSession({ start: stubRoot, repositoryRoot: stubRoot }),
      (error) => error.code === "CURSOR_CLOUD_OUTPUT_INVALID",
    );
    await writeFile(stubBin, "console.log(JSON.stringify({ pad: 'x'.repeat(70_000) }));\n");
    await assert.rejects(
      () => openSession({ start: stubRoot, repositoryRoot: stubRoot }),
      (error) => error.code === "CURSOR_CLOUD_OUTPUT_TOO_LARGE",
    );
    assert.throws(
      () => parseBoundedJson(`{"pad":"${"x".repeat(70_000)}"}`, { maxBytes: 1024 }),
      (error) => error.code === "CURSOR_CLOUD_OUTPUT_TOO_LARGE",
    );
    assert.throws(
      () => parseBoundedJson("not-json"),
      (error) => error.code === "CURSOR_CLOUD_OUTPUT_INVALID",
    );
  } finally {
    await removeTree(stubRoot);
  }
});

test("pending record without explicit lot authorization is refused", async () => {
  await withProject(async (root) => {
    const contractPath = path.join(root, "..", `unauth-${Date.now()}.json`);
    const proposalPath = path.join(root, "..", `proposal-${Date.now()}.json`);
    await writeFile(contractPath, `${JSON.stringify(unauthorizedContract())}\n`);
    await writeFile(proposalPath, `${JSON.stringify(pendingProposal())}\n`);
    try {
      await assert.rejects(
        () => recordPendingCheckpoint({
          start: root,
          contractPath,
          proposalPath,
          repositoryRoot: REPOSITORY_ROOT,
        }),
        (error) => error.code === "CURSOR_CLOUD_AUTHORIZATION_REQUIRED",
      );
      await assert.rejects(
        () => recordPendingCheckpoint({
          start: root,
          contractPath: LOT_CONTRACT,
          proposalPath,
          apply: true,
          expectedChange: "0".repeat(64),
          repositoryRoot: REPOSITORY_ROOT,
        }),
        (error) => error.code === "PENDING_CONFIRMATION_MISMATCH",
      );
    } finally {
      await rm(contractPath, { force: true });
      await rm(proposalPath, { force: true });
    }
  });
});

test("authorized pending record is digest-bound and leaves canonical memory unchanged", async () => {
  await withProject(async (root) => {
    const proposalPath = path.join(root, "..", `authorized-${Date.now()}.json`);
    await writeFile(proposalPath, `${JSON.stringify(pendingProposal())}\n`);
    try {
      const preview = await recordPendingCheckpoint({
        start: root,
        contractPath: LOT_CONTRACT,
        proposalPath,
        repositoryRoot: REPOSITORY_ROOT,
      });
      assert.equal(preview.format, "dubsar.cursor-cloud-pending-record/1");
      assert.equal(preview.status, "preview");
      assert.equal(preview.promote, false);
      assert.equal(preview.canonical_write, false);
      assert.match(preview.target, /^\.dubsar-pending\/cursor-cloud\/cp-lot-mem-002\.md$/u);
      const applied = await recordPendingCheckpoint({
        start: root,
        contractPath: LOT_CONTRACT,
        proposalPath,
        apply: true,
        expectedChange: preview.change_sha256,
        repositoryRoot: REPOSITORY_ROOT,
      });
      assert.equal(applied.status, "applied");
      assert.equal(applied.inventories.unchanged, true);
      assert.equal(applied.inventories.dubsar_sha256, preview.inventories.dubsar_sha256);
      const session = await openSession({ start: root, repositoryRoot: REPOSITORY_ROOT });
      assert.equal(session.pending_list.count, 1);
      assert.equal(session.pending_list.candidates[0].checkpoint_id, "cp-lot-mem-002");
      assert.equal(session.pending_list.candidates[0].declared_source, "cursor-cloud");
    } finally {
      await rm(proposalPath, { force: true });
    }
  });
});

test("lot contract and record adapter never authorize promotion", async () => {
  const contract = await loadLotContract(LOT_CONTRACT);
  assert.equal(contract.authorize_pending_checkpoint, true);
  assert.equal(contract.authorize_pending_promotion, false);
  assert.equal(contract.authorize_canonical_write, false);
  const source = await readFile(
    path.join(REPOSITORY_ROOT, "tools", "cursor-cloud", "record-pending.mjs"),
    "utf8",
  );
  assert.equal(source.includes("pending promote"), false);
  assert.equal(source.includes("applyPendingCheckpointPromotion"), false);
  assert.match(source, /pending",\s*"record"/u);
});

test("LOT-MEM-002R1 regression documents stale digests recorded at base f7d238e", () => {
  assert.equal(
    LOT_MEM_002R1_OBSOLETE["tools/cursor-cloud/runtime.mjs"],
    "f7c8e7eeebb55312171f1be499b5b17c7364e6e987caaa3ecff9306090fd9e7f",
  );
  assert.equal(
    LOT_MEM_002R1_OBSOLETE["tests/cursor-cloud-continuity.test.mjs"],
    "b90115ffa15aeca7ed0fea5ca52fecb7838ac4b9c87669aab4a85120e028985b",
  );
});

test("LOT-MEM-002R1 regression proves HEAD diverged from obsolete recorded digests", async () => {
  for (const [relativePath, obsoleteDigest] of Object.entries(LOT_MEM_002R1_OBSOLETE)) {
    assert.notEqual(await sha256File(relativePath), obsoleteDigest);
  }
});

test("LOT-MEM-002R1 qualification rejects stale candidate references", async () => {
  const references = await readPendingCandidateReferences({
    repositoryRoot: REPOSITORY_ROOT,
    declaredSource: "cursor-cloud",
    checkpointId: "cp-lot-mem-002",
  });
  const stale = references.map((item) => (
    item.path === "tools/cursor-cloud/runtime.mjs"
      ? { ...item, sha256: "0".repeat(64) }
      : item
  ));
  await assert.rejects(
    () => verifyPendingCandidateReferences({
      repositoryRoot: REPOSITORY_ROOT,
      declaredSource: "cursor-cloud",
      checkpointId: "cp-lot-mem-002",
      references: stale,
    }),
    (error) => error.code === "CURSOR_CLOUD_CANDIDATE_REFERENCE_INVALID",
  );
});

test("candidate reference verification accepts coherent references without mutating memory", async () => {
  const references = await readPendingCandidateReferences({
    repositoryRoot: REPOSITORY_ROOT,
    declaredSource: "cursor-cloud",
    checkpointId: "cp-lot-mem-002",
  });
  const currentReferences = [];
  for (const item of references) {
    currentReferences.push({
      path: item.path,
      sha256: await sha256File(item.path),
    });
  }
  const proof = await verifyPendingCandidateReferences({
    repositoryRoot: REPOSITORY_ROOT,
    declaredSource: "cursor-cloud",
    checkpointId: "cp-lot-mem-002",
    references: currentReferences,
  });
  assert.equal(proof.inventories.unchanged, true);
  assert.equal(proof.count, references.length);
});

test("candidate reference verification refuses modified missing unsafe and oversized files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dubsar-ref-verify-"));
  try {
    await mkdir(path.join(root, "notes"));
    await writeFile(path.join(root, "notes", "good.txt"), "good\n");
    const goodDigest = createHash("sha256").update("good\n").digest("hex");
    const good = { path: "notes/good.txt", sha256: goodDigest };

    await verifyPendingCandidateReferences({
      repositoryRoot: root,
      declaredSource: "fixture",
      checkpointId: "cp-ref-good",
      references: [good],
    });

    await assert.rejects(
      () => verifyPendingCandidateReferences({
        repositoryRoot: root,
        declaredSource: "fixture",
        checkpointId: "cp-ref-stale",
        references: [{ path: "notes/good.txt", sha256: "a".repeat(64) }],
      }),
      (error) => error.code === "CURSOR_CLOUD_CANDIDATE_REFERENCE_INVALID",
    );

    await assert.rejects(
      () => verifyCandidateReference({
        repositoryRoot: root,
        reference: { path: "notes/missing.txt", sha256: goodDigest },
      }),
      (error) => error.code === "CURSOR_CLOUD_CANDIDATE_REFERENCE_MISSING",
    );

    for (const unsafePath of ["../outside.txt", "/etc/passwd", "foo/../bar.txt"]) {
      await assert.rejects(
        () => verifyCandidateReference({
          repositoryRoot: root,
          reference: { path: unsafePath, sha256: goodDigest },
        }),
        (error) => error.code === "CURSOR_CLOUD_CANDIDATE_REFERENCE_UNSAFE",
      );
    }

    const linkTarget = path.join(root, "notes", "link-target.txt");
    const linkAlias = path.join(root, "notes", "link-alias.txt");
    await writeFile(linkTarget, "linked\n");
    const linkedDigest = createHash("sha256").update("linked\n").digest("hex");
    try {
      await symlink(linkTarget, linkAlias);
      await assert.rejects(
        () => verifyCandidateReference({
          repositoryRoot: root,
          reference: { path: "notes/link-alias.txt", sha256: linkedDigest },
        }),
        (error) => error.code === "CURSOR_CLOUD_CANDIDATE_REFERENCE_UNSAFE",
      );
    } catch (error) {
      if (error?.code !== "EPERM" && error?.code !== "ENOTSUP") throw error;
    }

    await writeFile(path.join(root, "notes", "big.txt"), "x".repeat(2048));
    const bigDigest = createHash("sha256").update("x".repeat(2048)).digest("hex");
    await assert.rejects(
      () => verifyCandidateReference({
        repositoryRoot: root,
        reference: { path: "notes/big.txt", sha256: bigDigest },
        maxBytes: 512,
      }),
      (error) => error.code === "CURSOR_CLOUD_CANDIDATE_REFERENCE_TOO_LARGE",
    );
  } finally {
    await removeTree(root);
  }
});

test("this repository memory is readable through the session bridge", async () => {
  const session = await openSession({ start: REPOSITORY_ROOT });
  assert.equal(session.format, "dubsar.cursor-cloud-session/1");
  assert.equal(["dubsar.resume-capsule/3", "dubsar.resume-capsule/4"].includes(session.resume.format), true);
  assert.equal(session.route.format, "dubsar.memory-route/2");
  assert.equal(session.route_execution_authority, false);
  assert.equal(session.inventories.unchanged, true);
  assert.equal(session.resume.project.project_id, "dubsar-memory");
  assert.equal(session.pending_list.count, 1);
  assert.equal(session.pending_list.candidates[0].checkpoint_id, "cp-lot-mem-002");
  assert.equal(session.pending_list.candidates[0].declared_source, "cursor-cloud");
  const qualification = await qualifyRepository(REPOSITORY_ROOT);
  assert.equal(qualification.format, "dubsar.cursor-cloud-qualify/1");
  assert.equal(qualification.status, "ready");
  assert.equal(qualification.inventories.unchanged, true);
  assert.equal(qualification.session.pending_checkpoint_id, "cp-lot-mem-002");
  assert.equal(qualification.candidate_references.verified, true);
  assert.equal(qualification.refusals.stale_reference, "CURSOR_CLOUD_CANDIDATE_REFERENCE_INVALID");
  assert.equal(qualification.refusals.pending_promote, false);
});
