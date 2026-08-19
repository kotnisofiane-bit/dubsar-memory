import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  CURSOR_CLOUD_LOT_CONTRACT_FORMAT,
  CURSOR_CLOUD_PENDING_FORMAT,
  CursorCloudError,
  RUNTIME_RELATIVE_BIN,
  REPOSITORY_ROOT,
  assertNoLeak,
  assertSupportedNode,
  errorDocument,
  inventoryFingerprint,
  invokeDubsar,
  isMainModule,
  parseBoundedJson,
  printJson,
  requireFormat,
  resolveRuntimeBin,
} from "./runtime.mjs";

export function parseRecordPendingArgs(argv) {
  const options = { apply: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--apply") {
      options.apply = true;
    } else if (
      (flag === "--start" || flag === "--contract" || flag === "--proposal" || flag === "--expected-change") &&
      argv[index + 1]
    ) {
      options[flag.slice(2).replaceAll("-", "_")] = argv[index + 1];
      index += 1;
    } else {
      throw new CursorCloudError("CURSOR_CLOUD_ARGUMENT_INVALID");
    }
  }
  const applying = options.apply === true;
  const hasDigest = typeof options.expected_change === "string" && options.expected_change.length > 0;
  if (
    typeof options.start !== "string" ||
    typeof options.contract !== "string" ||
    typeof options.proposal !== "string" ||
    applying !== hasDigest
  ) {
    throw new CursorCloudError("CURSOR_CLOUD_ARGUMENT_INVALID");
  }
  return options;
}

export async function loadLotContract(contractPath) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(contractPath, "utf8"));
  } catch {
    throw new CursorCloudError("CURSOR_CLOUD_AUTHORIZATION_REQUIRED");
  }
  requireFormat(parsed, CURSOR_CLOUD_LOT_CONTRACT_FORMAT);
  if (parsed.authorize_pending_promotion !== false || parsed.authorize_canonical_write !== false) {
    throw new CursorCloudError("CURSOR_CLOUD_PROMOTE_FORBIDDEN");
  }
  if (parsed.authorize_pending_checkpoint !== true) {
    throw new CursorCloudError("CURSOR_CLOUD_AUTHORIZATION_REQUIRED");
  }
  if (typeof parsed.lot_id !== "string" || parsed.lot_id.length < 3) {
    throw new CursorCloudError("CURSOR_CLOUD_AUTHORIZATION_REQUIRED");
  }
  return parsed;
}

async function readCommand(bin, args, start) {
  const invoked = await invokeDubsar({ bin, args, cwd: start });
  const stream = invoked.exitCode === 0 ? invoked.stdout : invoked.stderr || invoked.stdout;
  const document = parseBoundedJson(stream);
  if (invoked.exitCode !== 0) {
    throw new CursorCloudError(document.code ?? "CURSOR_CLOUD_FORMAT_INVALID");
  }
  return document;
}

export async function recordPendingCheckpoint({
  start,
  contractPath,
  proposalPath,
  apply = false,
  expectedChange,
  repositoryRoot = REPOSITORY_ROOT,
  runtimeBin,
} = {}) {
  assertSupportedNode();
  const contract = await loadLotContract(contractPath);
  const projectRoot = path.resolve(start);
  const proposalAbsolute = path.resolve(proposalPath);
  const bin = runtimeBin ?? await resolveRuntimeBin(repositoryRoot);
  const beforeDubsar = await inventoryFingerprint(path.join(projectRoot, ".dubsar"));

  const args = [
    "pending",
    "record",
    "--start",
    projectRoot,
    "--proposal",
    proposalAbsolute,
    "--json",
  ];
  if (apply) {
    args.push("--apply", "--expected-change", expectedChange);
  }
  const result = await readCommand(bin, args, projectRoot);
  if (apply) {
    requireFormat(result, "dubsar.pending-checkpoint-apply/1");
  } else {
    requireFormat(result, "dubsar.pending-checkpoint-preview/1");
  }
  if (typeof result.target !== "string" || !result.target.startsWith(".dubsar-pending/")) {
    throw new CursorCloudError("CURSOR_CLOUD_FORMAT_INVALID");
  }
  const afterDubsar = await inventoryFingerprint(path.join(projectRoot, ".dubsar"));
  if (afterDubsar !== beforeDubsar) {
    throw new CursorCloudError("CURSOR_CLOUD_INVENTORY_MUTATED");
  }

  const document = {
    format: CURSOR_CLOUD_PENDING_FORMAT,
    status: apply ? "applied" : "preview",
    lot_id: contract.lot_id,
    authorize_pending_checkpoint: true,
    promote: false,
    canonical_write: false,
    route_execution_authority: false,
    memory_trust: "untrusted-data",
    path_resolution: "repository",
    runtime: RUNTIME_RELATIVE_BIN,
    target: result.target,
    change_sha256: result.change_sha256,
    inventories: {
      dubsar_sha256: afterDubsar,
      unchanged: true,
    },
    result,
  };
  assertNoLeak(JSON.stringify(document), [projectRoot, repositoryRoot, bin, proposalAbsolute]);
  return document;
}

if (isMainModule(import.meta.url)) {
  try {
    const options = parseRecordPendingArgs(process.argv.slice(2));
    process.exitCode = printJson(await recordPendingCheckpoint({
      start: options.start,
      contractPath: options.contract,
      proposalPath: options.proposal,
      apply: options.apply === true,
      expectedChange: options.expected_change,
    }));
  } catch (error) {
    process.exitCode = printJson(errorDocument(error), { exitCode: 1 });
  }
}
