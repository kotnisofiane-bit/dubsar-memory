import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { initProjectWorkspace } from "../legacy/hermes-skills/dubsar-project-continuity/scripts/init-project-workspace.mjs";
import { runProjectValidation } from "../legacy/hermes-skills/dubsar-project-continuity/scripts/validate-project-workspace.mjs";
import { renderProjectSummary } from "../legacy/hermes-skills/dubsar-project-continuity/scripts/render-project-summary.mjs";

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

async function writeJson(file, value) {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

test("project continuity summary is deterministic and grants no authority", async (t) => {
  const testRoot = await mkdtemp(path.join(tmpdir(), "dubsar-project-"));
  t.after(async () => {
    await rm(testRoot, { recursive: true, force: true });
  });
  const workspace = path.join(testRoot, "workspace");
  await initProjectWorkspace(workspace, "mission-demo-001");

  const missionPath = path.join(workspace, "mission.json");
  const mission = await readJson(missionPath);
  Object.assign(mission, {
    title: "Synthetic portal review",
    desired_outcome: "Produce a user-visible synthetic proof.",
    purpose: "Demonstrate safe project continuity.",
    in_scope: ["Synthetic fixture"],
    acceptance_evidence: ["evidence-demo-001"],
    stop_conditions: ["Unexpected external write"],
    status: "approved",
  });
  await writeJson(missionPath, mission);

  await writeJson(path.join(workspace, "lots.json"), {
    format: "dubsar.project-lots/1",
    mission_id: "mission-demo-001",
    lots: [
      {
        lot_id: "lot-demo-001",
        title: "Prepare the synthetic fixture",
        depends_on: [],
        in_scope: ["fixtures"],
        excluded: ["deployment"],
        expected_evidence: ["evidence-demo-001"],
        validation: ["Inspect the generated fixture."],
        stop_conditions: ["Source is ambiguous."],
        status: "candidate",
      },
    ],
  });

  await writeJson(path.join(workspace, "execution-contract.json"), {
    format: "dubsar.execution-contract/1",
    mission_id: "mission-demo-001",
    lot_id: "lot-demo-001",
    contract_id: "contract-demo-001",
    targets: ["fixtures"],
    allowed_actions: ["Create synthetic text files."],
    forbidden_actions: ["Deploy", "Merge"],
    protected_areas: ["Production systems"],
    validation: ["Inspect the generated fixture."],
    required_evidence: ["evidence-demo-001"],
    recovery_expectations: ["Keep the source fixture unchanged."],
    stop_conditions: ["Unexpected external write"],
    status: "approved",
  });

  await writeJson(path.join(workspace, "evidence.json"), {
    format: "dubsar.project-evidence/2",
    mission_id: "mission-demo-001",
    entries: [
      {
        evidence_id: "evidence-demo-001",
        lot_id: "lot-demo-001",
        kind: "fact",
        statement: "The synthetic fixture was reported as inspected.",
        class: "reported",
        artifact_refs: [],
        validation: ["Human report only"],
        limitations: ["No production workflow was exercised."],
        resolves: null,
      },
    ],
  });

  const validation = await runProjectValidation(workspace);
  assert.equal(validation.status, "valid");
  assert.equal(validation.continuity_status, "continuity_valid");
  assert.match(validation.next_preparation_step, /Prepare the approved lot/u);

  const firstOutput = path.join(testRoot, "summary-a");
  const secondOutput = path.join(testRoot, "summary-b");
  const first = await renderProjectSummary(workspace, firstOutput);
  const second = await renderProjectSummary(workspace, secondOutput);
  assert.equal(first.source_root_sha256, second.source_root_sha256);
  assert.equal(first.summary_sha256, second.summary_sha256);

  const firstSummary = await readFile(
    path.join(firstOutput, "PROJECT-SUMMARY.md"),
    "utf8",
  );
  const secondSummary = await readFile(
    path.join(secondOutput, "PROJECT-SUMMARY.md"),
    "utf8",
  );
  assert.equal(firstSummary, secondSummary);
  assert.match(firstSummary, /does not authorize execution/u);
});

test("contradictory project references block resume", async (t) => {
  const testRoot = await mkdtemp(path.join(tmpdir(), "dubsar-project-gap-"));
  t.after(async () => {
    await rm(testRoot, { recursive: true, force: true });
  });
  const workspace = path.join(testRoot, "workspace");
  await initProjectWorkspace(workspace, "mission-demo-002");

  const contractPath = path.join(workspace, "execution-contract.json");
  const contract = await readJson(contractPath);
  Object.assign(contract, {
    lot_id: "lot-does-not-exist",
    contract_id: "contract-orphan",
    status: "approved",
  });
  await writeJson(contractPath, contract);

  const validation = await runProjectValidation(workspace);
  assert.equal(validation.status, "invalid");
  assert.equal(validation.continuity_status, "continuity_blocked");
  assert.ok(validation.findings.includes("CONTRACT_LOT_REFERENCE_MISSING"));
  assert.ok(validation.findings.includes("APPROVED_CONTRACT_WITHOUT_CANDIDATE"));

  await assert.rejects(
    renderProjectSummary(workspace, path.join(testRoot, "refused-summary")),
    /CONTINUITY_BLOCKED/u,
  );
});
