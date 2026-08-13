import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  parseArgs,
  prepareOutputDirectory,
  printFailure,
  printResult,
  PublicPluginError,
  writeJsonExclusive,
} from "./safe-io.mjs";

export async function initProjectWorkspace(
  output,
  missionId = `mission-local-${randomUUID()}`,
) {
  if (!/^[a-z0-9][a-z0-9._-]{2,63}$/i.test(missionId)) {
    throw new PublicPluginError("INVALID_MISSION_ID");
  }
  const root = await prepareOutputDirectory(output);
  const documents = {
    "mission.json": {
      format: "dubsar.project-mission/1",
      mission_id: missionId,
      title: "",
      desired_outcome: "",
      purpose: "",
      in_scope: [],
      excluded: [],
      known_inputs: [],
      constraints: [],
      acceptance_evidence: [],
      risks: [],
      open_decisions: [],
      stop_conditions: [],
      status: "draft",
    },
    "lots.json": {
      format: "dubsar.project-lots/1",
      mission_id: missionId,
      lots: [],
    },
    "execution-contract.json": {
      format: "dubsar.execution-contract/1",
      mission_id: missionId,
      lot_id: null,
      contract_id: null,
      targets: [],
      allowed_actions: [],
      forbidden_actions: [],
      protected_areas: [],
      validation: [],
      required_evidence: [],
      recovery_expectations: [],
      stop_conditions: [],
      status: "draft",
    },
    "evidence.json": {
      format: "dubsar.project-evidence/2",
      mission_id: missionId,
      entries: [],
    },
  };

  for (const [file, document] of Object.entries(documents)) {
    await writeJsonExclusive(root, file, document);
  }
  return {
    status: "initialized",
    mission_id: missionId,
    files: Object.keys(documents).sort(),
  };
}

async function main() {
  try {
    const args = parseArgs(process.argv.slice(2), ["output"]);
    printResult(await initProjectWorkspace(args.output, args["mission-id"]));
  } catch (error) {
    printFailure(error);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
