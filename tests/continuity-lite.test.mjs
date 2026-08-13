import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runContinuityCli } from "../packages/dubsar-project-continuity/runtime/cli.mjs";
import { runInteractiveClose } from "../packages/dubsar-project-continuity/runtime/close-session.mjs";
import { inspectWorkspace, stableJson } from "../packages/dubsar-project-continuity/runtime/index.mjs";
import { inspectProjectContinuityCatalog } from "../packages/dubsar-operator-core/src/index.mjs";
import { renderWorkbenchContinuityInteractiveReport } from "../packages/dubsar-workbench-report/src/index.mjs";

const producer = { name: "@dubsar/project-continuity", version: "0.2.0" };

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "dubsar-lite-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = path.join(root, "project");
  await mkdir(project);
  const proposalPath = path.join(root, "init.json");
  const proposal = {
    format: "dubsar.continuity-init-proposal/1",
    project_id: "project-lite-example",
    title: "Continuity Lite example",
    mission: "Keep a concise and trustworthy handoff between coding sessions.",
    initial_state: {
      status: "active",
      summary: "The lightweight continuity workspace is ready to be initialized.",
      blockers: [],
      next_action: "Create the first bounded checkpoint after verified work.",
    },
  };
  await writeFile(proposalPath, stableJson(proposal), "utf8");
  const preview = await runContinuityCli([
    "init", "--start", project, "--proposal", proposalPath, "--json",
  ], { writeOut() {}, writeErr() {} });
  assert.equal(preview.exitCode, 0);
  const applied = await runContinuityCli([
    "init", "--start", project, "--proposal", proposalPath, "--apply",
    "--expected-change", preview.value.change_sha256, "--json",
  ], { writeOut() {}, writeErr() {} });
  assert.equal(applied.exitCode, 0);
  return { root, project };
}

function checkpointProposal(overrides = {}) {
  return {
    format: "dubsar.continuity-checkpoint-proposal/1",
    project_id: "project-lite-example",
    kind: "progress",
    summary: "The public runtime now resumes the two-file Lite workspace.",
    references: ["work-item.txt"],
    validation: ["The runtime command completed successfully."],
    limitations: [],
    resolves: null,
    resulting_state: {
      status: "active",
      summary: "The Lite runtime is functional and remains locally testable.",
      blockers: [],
      next_action: "Validate the Codex resume skill against this capsule.",
    },
    ...overrides,
  };
}

test("Continuity Lite initializes, resumes, and checkpoints one canonical file", async (t) => {
  const { root, project } = await fixture(t);
  await writeFile(path.join(project, "work-item.txt"), "verified local work\n", "utf8");
  const beforeState = await readFile(path.join(project, ".dubsar-project", "state.json"));
  const proposalPath = path.join(root, "checkpoint.json");
  await writeFile(proposalPath, stableJson(checkpointProposal()), "utf8");

  const preview = await runContinuityCli([
    "checkpoint", "--start", project, "--proposal", proposalPath, "--json",
  ], { writeOut() {}, writeErr() {} });
  assert.equal(preview.exitCode, 0);
  assert.equal(preview.value.target, "checkpoints.json");
  assert.match(preview.value.consequence, /state\.json remains unchanged/u);
  const applied = await runContinuityCli([
    "checkpoint", "--start", project, "--proposal", proposalPath, "--apply",
    "--expected-change", preview.value.change_sha256, "--json",
  ], { writeOut() {}, writeErr() {} });
  assert.equal(applied.exitCode, 0);
  assert.deepEqual(await readFile(path.join(project, ".dubsar-project", "state.json")), beforeState);

  const resume = await runContinuityCli([
    "resume", "--start", project, "--capsule", "--json",
  ], { writeOut() {}, writeErr() {} });
  assert.equal(resume.exitCode, 0);
  assert.equal(resume.value.format, "dubsar.resume-capsule/2");
  assert.equal(resume.value.active_lot, null);
  assert.equal(resume.value.next_action.label, "Validate the Codex resume skill against this capsule.");
  assert.equal(resume.value.evidence.total_records, 1);
  assert.equal(resume.value.evidence.supported_records, 1);

  const history = await runContinuityCli([
    "history", "--start", project, "--json",
  ], { writeOut() {}, writeErr() {} });
  assert.equal(history.value.entries.length, 1);
  assert.equal(history.value.entries[0].type, "progress");
  const precedents = await runContinuityCli([
    "precedents", "--start", project, "--ref", "work-item.txt", "--json",
  ], { writeOut() {}, writeErr() {} });
  assert.equal(precedents.value.results.length, 1);
  const lots = await runContinuityCli(["lots", "--start", project, "--json"], {
    writeOut() {}, writeErr() {},
  });
  assert.deepEqual(lots.value.lots, []);
});

test("Continuity Lite detects two repeated unsupported attempts without blocking", async (t) => {
  const { root, project } = await fixture(t);
  const proposalPath = path.join(root, "attempt.json");
  const attempt = checkpointProposal({
    kind: "attempt",
    summary: "The same approach was attempted without new supporting material.",
    references: [],
    validation: [],
    limitations: ["No new artifact reference was recorded."],
  });
  for (let index = 0; index < 2; index += 1) {
    await writeFile(proposalPath, stableJson(attempt), "utf8");
    const preview = await runContinuityCli([
      "checkpoint", "--start", project, "--proposal", proposalPath, "--json",
    ], { writeOut() {}, writeErr() {} });
    assert.equal(preview.exitCode, 0);
    const applied = await runContinuityCli([
      "checkpoint", "--start", project, "--proposal", proposalPath, "--apply",
      "--expected-change", preview.value.change_sha256, "--json",
    ], { writeOut() {}, writeErr() {} });
    assert.equal(applied.exitCode, 0);
  }
  const inspection = await inspectWorkspace({ start: project });
  assert.equal(inspection.evaluation.next_action.code, "reframe_recommended");
  assert.equal(inspection.evaluation.lite.repeated_attempt, true);
  const route = await runContinuityCli(["route", "--start", project, "--json"], {
    writeOut() {}, writeErr() {},
  });
  assert.equal(route.exitCode, 0);
  assert.equal(route.value.format, "dubsar.memory-route/2");
  assert.equal(route.value.guidance.action, "reconsider");
  assert.equal(route.value.guidance.auto_execute, false);
  assert.equal(route.value.memory_state, "limited");
  assert.equal(route.value.artifact_lifecycle.state, "integrity_checked");
  assert.deepEqual(route.value.exact_relations.matches[0].basis, ["same_resulting_state"]);
  assert.equal(route.value.native_guidance.plan.recommendation, "consider");
});

test("Memory Guidance exposes normal absence and refuses unsupported reactivation", async (t) => {
  const { root, project } = await fixture(t);
  const initial = await runContinuityCli(["route", "--start", project, "--json"], {
    writeOut() {}, writeErr() {},
  });
  assert.equal(initial.exitCode, 0);
  assert.equal(initial.value.guidance.action, "record");
  assert.equal(initial.value.memory_state, "empty");
  assert.equal(initial.value.artifact_lifecycle.state, "empty");
  assert.deepEqual(initial.value.exact_relations.matches, []);
  assert.equal(initial.value.native_guidance.plan.recommendation, "not_indicated");

  const proposalPath = path.join(root, "route.json");
  const proposals = [
    checkpointProposal({
      references: [],
      validation: [],
      resulting_state: {
        status: "active",
        summary: "The bounded implementation step is active.",
        blockers: [],
        next_action: "Complete the bounded implementation step.",
      },
    }),
    checkpointProposal({
      kind: "decision",
      summary: "Work paused before the next coding session.",
      references: [],
      validation: [],
      resulting_state: {
        status: "paused",
        summary: "The bounded implementation step is paused.",
        blockers: [],
        next_action: "Confirm whether to reactivate the recorded implementation step.",
      },
    }),
  ];
  for (const proposal of proposals) {
    await writeFile(proposalPath, stableJson(proposal), "utf8");
    const preview = await runContinuityCli([
      "checkpoint", "--start", project, "--proposal", proposalPath, "--json",
    ], { writeOut() {}, writeErr() {} });
    const applied = await runContinuityCli([
      "checkpoint", "--start", project, "--proposal", proposalPath, "--apply",
      "--expected-change", preview.value.change_sha256, "--json",
    ], { writeOut() {}, writeErr() {} });
    assert.equal(applied.exitCode, 0);
  }

  const route = await runContinuityCli(["route", "--start", project, "--json"], {
    writeOut() {}, writeErr() {},
  });
  assert.equal(route.exitCode, 0);
  assert.equal(route.value.guidance.action, "pause");
  assert.equal(route.value.guidance.related_record_id, null);
  assert.deepEqual(route.value.exact_relations.matches, []);
  assert.equal(route.value.native_guidance.plan.recommendation, "not_indicated");
  assert.equal(route.value.native_guidance.goal.recommendation, "consider");
});

test("Memory Guidance proposes resume only through an exact recorded relation", async (t) => {
  const { root, project } = await fixture(t);
  await writeFile(path.join(project, "work-item.txt"), "same bounded work\n", "utf8");
  const proposalPath = path.join(root, "related-route.json");
  const proposals = [
    checkpointProposal(),
    checkpointProposal({
      kind: "decision",
      summary: "Work paused while retaining the same exact artifact reference.",
      resulting_state: {
        status: "paused",
        summary: "The same bounded implementation step is paused.",
        blockers: [],
        next_action: "Confirm whether to resume this exactly referenced work.",
      },
    }),
  ];
  for (const proposal of proposals) {
    await writeFile(proposalPath, stableJson(proposal), "utf8");
    const preview = await runContinuityCli([
      "checkpoint", "--start", project, "--proposal", proposalPath, "--json",
    ], { writeOut() {}, writeErr() {} });
    const applied = await runContinuityCli([
      "checkpoint", "--start", project, "--proposal", proposalPath, "--apply",
      "--expected-change", preview.value.change_sha256, "--json",
    ], { writeOut() {}, writeErr() {} });
    assert.equal(applied.exitCode, 0);
  }
  const stored = JSON.parse(await readFile(
    path.join(project, ".dubsar-project", "checkpoints.json"), "utf8",
  ));
  const route = await runContinuityCli(["route", "--start", project, "--json"], {
    writeOut() {}, writeErr() {},
  });
  assert.equal(route.value.guidance.action, "resume_candidate");
  assert.equal(route.value.guidance.related_record_id, stored.entries[0].checkpoint_id);
  assert.deepEqual(route.value.exact_relations.matches[0].basis, ["same_reference"]);
  assert.equal(route.value.memory_state, "referenced");
  assert.equal(route.value.guidance.auto_execute, false);
});

test("Memory Guidance keeps completion separate from lifecycle integrity", async (t) => {
  const { root, project } = await fixture(t);
  const proposalPath = path.join(root, "complete.json");
  await writeFile(proposalPath, stableJson(checkpointProposal({
    references: [],
    validation: [],
    resulting_state: {
      status: "complete",
      summary: "The bounded work is recorded as complete.",
      blockers: [],
      next_action: "Review the recorded completion before starting new work.",
    },
  })), "utf8");
  const preview = await runContinuityCli([
    "checkpoint", "--start", project, "--proposal", proposalPath, "--json",
  ], { writeOut() {}, writeErr() {} });
  const applied = await runContinuityCli([
    "checkpoint", "--start", project, "--proposal", proposalPath, "--apply",
    "--expected-change", preview.value.change_sha256, "--json",
  ], { writeOut() {}, writeErr() {} });
  assert.equal(applied.exitCode, 0);
  const first = await runContinuityCli(["route", "--start", project, "--json"], {
    writeOut() {}, writeErr() {},
  });
  const second = await runContinuityCli(["route", "--start", project, "--json"], {
    writeOut() {}, writeErr() {},
  });
  assert.deepEqual(second.value, first.value);
  assert.equal(first.value.guidance.action, "finish_recorded");
  assert.equal(first.value.memory_state, "closed_recorded");
  assert.equal(first.value.artifact_lifecycle.state, "closed_recorded");
  assert.equal(first.value.artifact_lifecycle.auto_execute, false);
  assert.equal(JSON.stringify(first.value).includes("stabilized"), false);
});

test("Continuity Lite close writes a checkpoint but never opens personal memory", async (t) => {
  const { project } = await fixture(t);
  const answers = [
    "A concise checkpoint was prepared from the completed local edit.",
    "",
    "Review the generated capsule in a fresh Codex session.",
    "",
    "CONTINUE",
  ];
  const result = await runInteractiveClose({
    start: project,
    producer,
    io: {
      isInputTTY: true,
      isOutputTTY: true,
      writeOut() {},
      async readLine(prompt) {
        if (prompt.includes("Type APPLY")) return "APPLY";
        return answers.shift() ?? "";
      },
    },
  });
  assert.equal(result.status, "checkpoint_applied");
  assert.deepEqual(result.memory, { status: "not_requested" });
  assert.equal(result.capsule.evidence.total_records, 1);
});

test("Continuity Lite rejects mixed legacy and Lite workspace files", async (t) => {
  const { project } = await fixture(t);
  await writeFile(path.join(project, ".dubsar-project", "mission.json"), "{}\n", "utf8");
  const result = await runContinuityCli([
    "resume", "--start", project, "--capsule", "--json",
  ], { writeOut() {}, writeErr() {} });
  assert.equal(result.exitCode, 1);
  assert.equal(result.value.code, "WORKSPACE_FORMAT_INVALID");
});

test("Continuity Lite rejects an undeclared third canonical file", async (t) => {
  const { project } = await fixture(t);
  await writeFile(path.join(project, ".dubsar-project", "ambient.json"), "{}\n", "utf8");
  const result = await runContinuityCli([
    "resume", "--start", project, "--capsule", "--json",
  ], { writeOut() {}, writeErr() {} });
  assert.equal(result.exitCode, 1);
  assert.equal(result.value.code, "WORKSPACE_FORMAT_INVALID");
});

test("Workbench exposes a Lite project through the existing catalog without personal memory", async (t) => {
  const { project } = await fixture(t);
  const catalog = await inspectProjectContinuityCatalog({
    entries: [{ project_id: "registry-lite-project", root: project }],
    producer: { name: "@dubsar/operator-core", version: "0.1.0-dev" },
  });
  assert.equal(catalog.projects[0].capture_status, "available");
  assert.equal(catalog.projects[0].continuity.capsule.active_lot, null);
  assert.deepEqual(catalog.projects[0].continuity.lots.lots, []);
  const rendered = renderWorkbenchContinuityInteractiveReport(catalog, {
    producer: { name: "@dubsar/workbench-report", version: "0.1.0-dev" },
  });
  assert.equal(rendered.manifest.format, "dubsar.workbench-continuity-interactive-report/4");
  assert.doesNotMatch(rendered.html, /"personal_memory"\s*:/u);
  assert.doesNotMatch(rendered.html, /C:\\/u);
});
