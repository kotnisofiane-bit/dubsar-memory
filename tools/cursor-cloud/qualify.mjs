import { readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { installEnvironment } from "./install.mjs";
import { openSession } from "./open-session.mjs";
import { recordPendingCheckpoint } from "./record-pending.mjs";
import { verifyPendingCandidateReferences } from "./verify-candidate-references.mjs";
import {
  CursorCloudError,
  REQUIRED_INSTALL_CAPABILITIES,
  REQUIRED_SESSION_CAPABILITIES,
  REPOSITORY_ROOT,
  RUNTIME_RELATIVE_BIN,
  assertNoLeak,
  errorDocument,
  inventoryFingerprint,
  isMainModule,
  parseBoundedJson,
  printJson,
} from "./runtime.mjs";

const QUALIFY_FORMAT = "dubsar.cursor-cloud-qualify/1";
const EXPECTED_PENDING_ID = "cp-lot-mem-002";
const EXPECTED_PENDING_SOURCE = "cursor-cloud";
const ADAPTER_FILES = Object.freeze([
  ["tools", "cursor-cloud", "install.mjs"],
  ["tools", "cursor-cloud", "open-session.mjs"],
  ["tools", "cursor-cloud", "record-pending.mjs"],
]);

function assertEnvironment(source) {
  if (source?.name !== "DUBSAR Memory") {
    throw new CursorCloudError("CURSOR_CLOUD_FORMAT_INVALID");
  }
  if (source.install !== "node tools/cursor-cloud/install.mjs") {
    throw new CursorCloudError("CURSOR_CLOUD_FORMAT_INVALID");
  }
  for (const forbidden of ["start", "terminals", "ports", "build", "snapshot", "mcpServerAllowlist"]) {
    if (Object.hasOwn(source, forbidden)) {
      throw new CursorCloudError("CURSOR_CLOUD_FORMAT_INVALID");
    }
  }
}

async function proveRefusals(repositoryRoot) {
  try {
    parseBoundedJson("not-json");
    throw new CursorCloudError("CURSOR_CLOUD_FORMAT_INVALID");
  } catch (error) {
    if (error?.code !== "CURSOR_CLOUD_OUTPUT_INVALID") throw error;
  }
  try {
    parseBoundedJson(`{"pad":"${"x".repeat(70_000)}"}`, { maxBytes: 1024 });
    throw new CursorCloudError("CURSOR_CLOUD_FORMAT_INVALID");
  } catch (error) {
    if (error?.code !== "CURSOR_CLOUD_OUTPUT_TOO_LARGE") throw error;
  }

  const contractPath = path.join(os.tmpdir(), `dubsar-unauth-${process.pid}.json`);
  const proposalPath = path.join(os.tmpdir(), `dubsar-unauth-proposal-${process.pid}.json`);
  await writeFile(contractPath, `${JSON.stringify({
    format: "dubsar.cursor-cloud-lot-contract/1",
    lot_id: "LOT-MEM-999",
    title: "Unauthorized fixture",
    authorize_pending_checkpoint: false,
    authorize_pending_promotion: false,
    authorize_canonical_write: false,
  })}\n`);
  await writeFile(proposalPath, `${JSON.stringify({
    format: "dubsar.pending-checkpoint-proposal/1",
    project_id: "dubsar-memory",
    declared_source: "cursor-cloud",
    checkpoint: {
      checkpoint_id: "cp-unauthorized",
      work_id: "integrate-cursor-cloud-continuity",
      kind: "progress",
      summary: "Unauthorized candidate must be refused.",
      references: [],
      validation: [],
      limitations: ["No write is authorized."],
      resolves: null,
      attempt: null,
      resulting_state: {
        status: "active",
        summary: "Refused.",
        blockers: [],
        next_action: "Do not record this candidate.",
      },
    },
  })}\n`);
  try {
    await recordPendingCheckpoint({
      start: repositoryRoot,
      contractPath,
      proposalPath,
      repositoryRoot,
    });
    throw new CursorCloudError("CURSOR_CLOUD_FORMAT_INVALID");
  } catch (error) {
    if (error?.code !== "CURSOR_CLOUD_AUTHORIZATION_REQUIRED") throw error;
  } finally {
    await rm(contractPath, { force: true });
    await rm(proposalPath, { force: true });
  }
}

export async function qualifyRepository(repositoryRoot = REPOSITORY_ROOT) {
  const environment = JSON.parse(
    await readFile(path.join(repositoryRoot, ".cursor", "environment.json"), "utf8"),
  );
  assertEnvironment(environment);

  for (const segments of ADAPTER_FILES) {
    const source = await readFile(path.join(repositoryRoot, ...segments), "utf8");
    if (source.includes("pending promote")) {
      throw new CursorCloudError("CURSOR_CLOUD_PROMOTE_FORBIDDEN");
    }
  }

  const beforeDubsar = await inventoryFingerprint(path.join(repositoryRoot, ".dubsar"));
  const beforePending = await inventoryFingerprint(path.join(repositoryRoot, ".dubsar-pending"));
  const install = await installEnvironment({ repositoryRoot });
  if (
    install.status !== "ready" ||
    install.runtime !== RUNTIME_RELATIVE_BIN ||
    install.path_resolution !== "repository" ||
    install.daemons !== false ||
    install.network !== false ||
    JSON.stringify(install.capabilities) !== JSON.stringify(REQUIRED_INSTALL_CAPABILITIES)
  ) {
    throw new CursorCloudError("CURSOR_CLOUD_FORMAT_INVALID");
  }

  const session = await openSession({ start: repositoryRoot, repositoryRoot });
  if (
    session.memory_trust !== "untrusted-data" ||
    session.route_is_advisory !== true ||
    session.route_execution_authority !== false ||
    session.route.guidance?.auto_execute !== false ||
    session.inventories.unchanged !== true ||
    session.path_resolution !== "repository" ||
    session.runtime !== RUNTIME_RELATIVE_BIN ||
    JSON.stringify(session.capabilities) !== JSON.stringify(REQUIRED_SESSION_CAPABILITIES)
  ) {
    throw new CursorCloudError("CURSOR_CLOUD_FORMAT_INVALID");
  }
  if (
    session.resume.format !== "dubsar.resume-capsule/3" &&
    session.resume.format !== "dubsar.resume-capsule/4"
  ) {
    throw new CursorCloudError("CURSOR_CLOUD_FORMAT_INVALID");
  }
  if (session.resume.content_trust !== "untrusted_project_data") {
    throw new CursorCloudError("CURSOR_CLOUD_FORMAT_INVALID");
  }
  if (session.resume.project.project_id !== "dubsar-memory") {
    throw new CursorCloudError("CURSOR_CLOUD_FORMAT_INVALID");
  }
  if (session.route.format !== "dubsar.memory-route/2") {
    throw new CursorCloudError("CURSOR_CLOUD_FORMAT_INVALID");
  }
  if (session.pending_list.format !== "dubsar.pending-checkpoints-list/1") {
    throw new CursorCloudError("CURSOR_CLOUD_FORMAT_INVALID");
  }
  if (session.pending_list.count !== 1) {
    throw new CursorCloudError("CURSOR_CLOUD_FORMAT_INVALID");
  }
  const candidate = session.pending_list.candidates[0];
  if (
    candidate.checkpoint_id !== EXPECTED_PENDING_ID ||
    candidate.declared_source !== EXPECTED_PENDING_SOURCE
  ) {
    throw new CursorCloudError("CURSOR_CLOUD_FORMAT_INVALID");
  }

  const referenceProof = await verifyPendingCandidateReferences({
    repositoryRoot,
    declaredSource: EXPECTED_PENDING_SOURCE,
    checkpointId: EXPECTED_PENDING_ID,
  });

  const afterDubsar = await inventoryFingerprint(path.join(repositoryRoot, ".dubsar"));
  const afterPending = await inventoryFingerprint(path.join(repositoryRoot, ".dubsar-pending"));
  if (afterDubsar !== beforeDubsar || afterPending !== beforePending) {
    throw new CursorCloudError("CURSOR_CLOUD_INVENTORY_MUTATED");
  }

  await proveRefusals(repositoryRoot);

  const document = {
    format: QUALIFY_FORMAT,
    status: "ready",
    memory_trust: "untrusted-data",
    route_execution_authority: false,
    path_resolution: "repository",
    runtime: RUNTIME_RELATIVE_BIN,
    node_major: Number.parseInt(process.versions.node.split(".")[0], 10),
    install: {
      status: install.status,
      daemons: false,
      network: false,
    },
    session: {
      resume_format: session.resume.format,
      route_format: session.route.format,
      pending_count: session.pending_list.count,
      pending_checkpoint_id: candidate.checkpoint_id,
      pending_declared_source: candidate.declared_source,
    },
    candidate_references: {
      count: referenceProof.count,
      verified: true,
    },
    inventories: {
      dubsar_sha256: afterDubsar,
      pending_sha256: afterPending,
      unchanged: true,
    },
    refusals: {
      malformed_output: "CURSOR_CLOUD_OUTPUT_INVALID",
      oversized_output: "CURSOR_CLOUD_OUTPUT_TOO_LARGE",
      unauthorized_record: "CURSOR_CLOUD_AUTHORIZATION_REQUIRED",
      stale_reference: "CURSOR_CLOUD_CANDIDATE_REFERENCE_INVALID",
      pending_promote: false,
    },
  };
  assertNoLeak(JSON.stringify(document), [repositoryRoot]);
  return document;
}

if (isMainModule(import.meta.url)) {
  try {
    process.exitCode = printJson(await qualifyRepository());
  } catch (error) {
    process.exitCode = printJson(errorDocument(error), { exitCode: 1 });
  }
}
