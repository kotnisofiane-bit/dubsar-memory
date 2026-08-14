import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { stableJson } from "../packages/dubsar-project-continuity/runtime/contracts.mjs";
import { inspectWorkspace } from "../packages/dubsar-project-continuity/runtime/index.mjs";
import {
  assertMemoryReferenceObservation,
  collectReferenceTargets,
  observeMemoryReferences,
  planCapture,
} from "../packages/dubsar-project-continuity/runtime/memory-vnext-freshness.mjs";
import {
  revalidateMemorySnapshot,
} from "../packages/dubsar-project-continuity/runtime/memory-vnext-snapshot.mjs";
import {
  evaluateMemorySnapshot,
} from "../packages/dubsar-project-continuity/runtime/memory-vnext-evaluator.mjs";
import {
  memoryCheckpointDigest,
} from "../packages/dubsar-project-continuity/runtime/memory-vnext-contracts.mjs";
import {
  buildProjectHistory,
} from "../packages/dubsar-project-continuity/runtime/continuity-views.mjs";
import {
  buildMemoryResumeCapsule,
  assertMemoryResumeCapsule,
} from "../packages/dubsar-project-continuity/runtime/memory-vnext-capsule.mjs";
import {
  applyMemoryChange,
  previewMemoryChange,
} from "../packages/dubsar-project-continuity/runtime/memory-vnext-writer.mjs";

const PROJECT_ID = "project-freshness";
const WORK_ID = "work-freshness-001";
const OTHER_WORK_ID = "work-other-001";
const PRODUCER = { name: "@dubsar/project-continuity", version: "0.3.0-test" };

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function markdown(frontmatter, body) {
  return `---\n${stableJson(frontmatter)}---\n${body}`;
}

function work(overrides = {}) {
  return {
    format: "dubsar.work/1",
    work_id: WORK_ID,
    title: "Observe reference freshness",
    status: "open",
    scope: "bounded",
    objective: "Verify that recorded references are re-read on resume.",
    acceptance_criteria: ["Freshness is reported."],
    knowledge_ids: [],
    references: [],
    ...overrides,
  };
}

function entry(index, previous, overrides = {}) {
  const base = {
    checkpoint_id: `checkpoint-${index}`,
    work_id: WORK_ID,
    kind: "progress",
    summary: `Recorded step ${index}.`,
    references: [],
    validation: ["Reviewed"],
    limitations: ["None"],
    resolves: null,
    attempt: null,
    resulting_state: {
      status: "active",
      summary: "Recorded state.",
      blockers: [],
      next_action: "Continue.",
    },
    ...overrides,
    index,
    previous_checkpoint_sha256: previous,
  };
  return { ...base, checkpoint_sha256: memoryCheckpointDigest(base) };
}

function chain(specs) {
  const entries = [];
  let previous = null;
  specs.forEach((spec, index) => {
    const built = entry(index, previous, spec);
    entries.push(built);
    previous = built.checkpoint_sha256;
  });
  return entries;
}

async function workspace(t, { entries = [], files = {}, works = [work()] } = {}) {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "dubsar-freshness-"));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  const root = path.join(projectRoot, ".dubsar");
  await Promise.all([
    mkdir(path.join(root, "work"), { recursive: true }),
    mkdir(path.join(root, "knowledge"), { recursive: true }),
    mkdir(path.join(root, "inbox"), { recursive: true }),
    mkdir(path.join(root, "generated"), { recursive: true }),
    mkdir(path.join(projectRoot, "src"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(path.join(root, "manifest.json"), stableJson({
      format: "dubsar.memory-project/1",
      project_id: PROJECT_ID,
      title: "Freshness example",
      legacy_snapshot_sha256: null,
    }), "utf8"),
    writeFile(path.join(root, "checkpoints.json"), stableJson({
      format: "dubsar.continuity-checkpoints/2",
      project_id: PROJECT_ID,
      entries,
    }), "utf8"),
    writeFile(path.join(root, "local.json"), stableJson({
      format: "dubsar.local-state/1",
      project_id: PROJECT_ID,
      selected_work_id: WORK_ID,
    }), "utf8"),
    writeFile(path.join(root, ".gitignore"), "inbox/\ngenerated/\nlocal.json\n", "utf8"),
    ...works.map((item) => writeFile(
      path.join(root, "work", `${item.work_id}.md`),
      markdown(item, `# ${item.title}\n`),
      "utf8",
    )),
    ...Object.entries(files).map(([name, content]) =>
      writeFile(path.join(projectRoot, name), content, "utf8")),
  ]);
  return { projectRoot, root };
}

async function inspect(projectRoot) {
  return inspectWorkspace({ start: projectRoot, observeReferences: true });
}

test("an unchanged reference is fresh and the capsule reports it as /4", async (t) => {
  const source = "export const value = 1;\n";
  const { projectRoot } = await workspace(t, {
    files: { "src/a.mjs": source },
    entries: chain([{ references: [{ path: "src/a.mjs", sha256: sha256(source) }] }]),
  });
  const inspection = await inspect(projectRoot);

  assert.equal(inspection.observation.counts.fresh, 1);
  assert.equal(inspection.observation.truncated, false);
  assert.equal(assertMemoryReferenceObservation(inspection.observation), inspection.observation);
  assert.deepEqual(inspection.evaluation.continuity.freshness,
    { fresh: 1, stale: 0, missing: 0, unknown: 0 });
  assert.equal(inspection.evaluation.continuity.records.at(0).supported, true);

  const capsule = buildMemoryResumeCapsule({ inspection, producer: PRODUCER });
  assert.equal(capsule.format, "dubsar.resume-capsule/4");
  assert.equal(capsule.evidence_freshness.status, "fresh");
  assert.equal(assertMemoryResumeCapsule(capsule), capsule);
  assert.equal(buildProjectHistory({ inspection }).entries.at(0).freshness, "fresh");
});

test("a reference whose file changed is stale and the record becomes unsupported", async (t) => {
  const recorded = "export const value = 1;\n";
  const { projectRoot } = await workspace(t, {
    files: { "src/a.mjs": "export const value = 2;\n" },
    entries: chain([{ references: [{ path: "src/a.mjs", sha256: sha256(recorded) }] }]),
  });
  const inspection = await inspect(projectRoot);

  assert.equal(inspection.observation.counts.stale, 1);
  assert.equal(inspection.observation.references.at(0).observed_sha256,
    sha256("export const value = 2;\n"));
  assert.equal(inspection.evaluation.continuity.records.at(0).supported, false);

  const history = buildProjectHistory({ inspection });
  assert.equal(history.entries.at(0).freshness, "stale");
  assert.equal(history.entries.at(0).support, "unsupported");
  assert.equal(history.entries.at(0).class, "observed");

  const capsule = buildMemoryResumeCapsule({ inspection, producer: PRODUCER });
  assert.equal(capsule.evidence_freshness.status, "stale");
});

test("a deleted reference is missing", async (t) => {
  const recorded = "export const value = 1;\n";
  const { projectRoot } = await workspace(t, {
    entries: chain([{ references: [{ path: "src/gone.mjs", sha256: sha256(recorded) }] }]),
  });
  const inspection = await inspect(projectRoot);

  assert.equal(inspection.observation.counts.missing, 1);
  assert.equal(inspection.observation.references.at(0).observed_sha256, null);
  assert.equal(buildProjectHistory({ inspection }).entries.at(0).freshness, "missing");
  assert.equal(
    buildMemoryResumeCapsule({ inspection, producer: PRODUCER }).evidence_freshness.status,
    "missing",
  );
});

test("one path with two recorded digests is captured once and classified twice", async (t) => {
  const first = "export const value = 1;\n";
  const second = "export const value = 2;\n";
  const { projectRoot } = await workspace(t, {
    files: { "src/a.mjs": second },
    entries: chain([
      { references: [{ path: "src/a.mjs", sha256: sha256(first) }] },
      { references: [{ path: "src/a.mjs", sha256: sha256(second) }] },
    ]),
  });
  const inspection = await inspect(projectRoot);

  // One distinct path.
  const targets = collectReferenceTargets(
    inspection.snapshot.documents.checkpoints.entries,
  );
  assert.equal(targets.length, 1);
  assert.equal(targets.at(0).expected.length, 2);

  // Two classifications, counted as two reference occurrences.
  assert.deepEqual(inspection.observation.counts,
    { fresh: 1, stale: 1, missing: 0, unknown: 0 });
  const byDigest = new Map(
    inspection.observation.references.map((item) => [item.recorded_sha256, item.status]),
  );
  assert.equal(byDigest.get(sha256(first)), "stale");
  assert.equal(byDigest.get(sha256(second)), "fresh");

  const history = buildProjectHistory({ inspection });
  const byId = new Map(history.entries.map((item) => [item.evidence_id, item]));
  assert.equal(byId.get("checkpoint-0").freshness, "stale");
  assert.equal(byId.get("checkpoint-0").support, "unsupported");
  assert.equal(byId.get("checkpoint-1").freshness, "fresh");
  assert.equal(byId.get("checkpoint-1").support, "supported");
});

test("a checkpoint mixing a fresh and a stale reference reports mixed and unsupported", async (t) => {
  const good = "export const good = 1;\n";
  const recorded = "export const drifted = 1;\n";
  const { projectRoot } = await workspace(t, {
    files: { "src/a.mjs": good, "src/b.mjs": "export const drifted = 2;\n" },
    entries: chain([{
      references: [
        { path: "src/a.mjs", sha256: sha256(good) },
        { path: "src/b.mjs", sha256: sha256(recorded) },
      ],
    }]),
  });
  const inspection = await inspect(projectRoot);

  assert.deepEqual(inspection.observation.counts,
    { fresh: 1, stale: 1, missing: 0, unknown: 0 });
  assert.equal(buildProjectHistory({ inspection }).entries.at(0).freshness, "mixed");
  assert.equal(buildProjectHistory({ inspection }).entries.at(0).support, "unsupported");
});

test("observation_sha256 distinguishes two different stale contents", async (t) => {
  const recorded = "export const value = 1;\n";
  const entries = chain([{ references: [{ path: "src/a.mjs", sha256: sha256(recorded) }] }]);

  const first = await workspace(t, { files: { "src/a.mjs": "stale A\n" }, entries });
  const second = await workspace(t, { files: { "src/a.mjs": "stale B\n" }, entries });
  const a = await inspect(first.projectRoot);
  const b = await inspect(second.projectRoot);

  assert.equal(a.observation.counts.stale, 1);
  assert.equal(b.observation.counts.stale, 1);
  // Both are stale, but the observation binds the content actually seen.
  assert.notEqual(a.observation.observation_sha256, b.observation.observation_sha256);
  assert.notEqual(a.observation.references.at(0).observed_sha256,
    b.observation.references.at(0).observed_sha256);
});

test("a reference appearing between the two passes is a capture race", async (t) => {
  const recorded = "export const value = 1;\n";
  const { projectRoot } = await workspace(t, {
    entries: chain([{ references: [{ path: "src/late.mjs", sha256: sha256(recorded) }] }]),
  });
  const { snapshot } = await inspectWorkspace({ start: projectRoot });

  await assert.rejects(
    observeMemoryReferences({
      projectRoot,
      snapshot,
      limits: undefined,
      // The first pass sees the file as missing; it appears before the second.
      afterFirstPass: () => writeFile(path.join(projectRoot, "src", "late.mjs"), recorded, "utf8"),
    }),
    (error) => error?.code === "SNAPSHOT_CAPTURE_RACE",
  );
});

test("a reference disappearing during revalidation is a capture race", async (t) => {
  const source = "export const value = 1;\n";
  const { projectRoot } = await workspace(t, {
    files: { "src/a.mjs": source },
    entries: chain([{ references: [{ path: "src/a.mjs", sha256: sha256(source) }] }]),
  });
  const { snapshot } = await inspectWorkspace({ start: projectRoot });

  await assert.rejects(
    observeMemoryReferences({
      projectRoot,
      snapshot,
      limits: undefined,
      afterFirstPass: () => rm(path.join(projectRoot, "src", "a.mjs"), { force: true }),
    }),
    (error) => error?.code === "SNAPSHOT_CAPTURE_RACE",
  );
});

test("a reference mutated during revalidation is a capture race", async (t) => {
  const source = "export const value = 1;\n";
  const { projectRoot } = await workspace(t, {
    files: { "src/a.mjs": source },
    entries: chain([{ references: [{ path: "src/a.mjs", sha256: sha256(source) }] }]),
  });
  const { snapshot } = await inspectWorkspace({ start: projectRoot });

  await assert.rejects(
    observeMemoryReferences({
      projectRoot,
      snapshot,
      limits: undefined,
      afterFirstPass: () =>
        writeFile(path.join(projectRoot, "src", "a.mjs"), "mutated\n", "utf8"),
    }),
    (error) => error?.code === "SNAPSHOT_CAPTURE_RACE",
  );
});

test("the canonical revalidation used by inspectWorkspace rejects a mid-read change", async (t) => {
  const source = "export const value = 1;\n";
  const { projectRoot, root } = await workspace(t, {
    files: { "src/a.mjs": source },
    entries: chain([{ references: [{ path: "src/a.mjs", sha256: sha256(source) }] }]),
  });
  const { location, snapshot } = await inspectWorkspace({ start: projectRoot });

  // Unchanged: the production revalidation accepts and returns the snapshot.
  const stable = await revalidateMemorySnapshot(location, undefined, snapshot.snapshot_sha256);
  assert.equal(stable.snapshot_sha256, snapshot.snapshot_sha256);

  // A canonical file changes after the snapshot and the observation: the very
  // function inspectWorkspace calls must refuse to bind them together.
  await writeFile(path.join(root, "local.json"), stableJson({
    format: "dubsar.local-state/1",
    project_id: PROJECT_ID,
    selected_work_id: null,
  }), "utf8");
  await assert.rejects(
    revalidateMemorySnapshot(location, undefined, snapshot.snapshot_sha256),
    (error) => error?.code === "SNAPSHOT_CAPTURE_RACE",
  );

  // And a workspace removed mid-read is a race rather than an unrelated error.
  await rm(root, { recursive: true, force: true });
  await assert.rejects(
    revalidateMemorySnapshot(location, undefined, snapshot.snapshot_sha256),
    (error) => error?.code === "SNAPSHOT_CAPTURE_RACE",
  );
});

test("budget exhaustion marks the remainder unknown and never fresh", async (t) => {
  const first = "a".repeat(4096);
  const second = "b".repeat(4096);
  const { projectRoot } = await workspace(t, {
    files: { "src/a.mjs": first, "src/b.mjs": second },
    entries: chain([{
      references: [
        { path: "src/a.mjs", sha256: sha256(first) },
        { path: "src/b.mjs", sha256: sha256(second) },
      ],
    }]),
  });
  const { snapshot } = await inspectWorkspace({ start: projectRoot });
  const observation = await observeMemoryReferences({
    projectRoot,
    snapshot,
    limits: { maxFreshnessBytes: 4096, maxFreshnessPaths: 128, maxArtifactFileBytes: 25 * 1024 * 1024 },
  });

  assert.equal(observation.truncated, true);
  assert.equal(observation.counts.unknown >= 1, true);
  assert.equal(observation.counts.fresh <= 1, true);
  assert.equal(assertMemoryReferenceObservation(observation), observation);
});

test("the path count limit degrades to unknown rather than throwing", async (t) => {
  const contents = ["one\n", "two\n", "three\n"];
  const files = Object.fromEntries(contents.map((value, index) => [`src/f${index}.mjs`, value]));
  const { projectRoot } = await workspace(t, {
    files,
    entries: chain([{
      references: contents.map((value, index) => ({
        path: `src/f${index}.mjs`,
        sha256: sha256(value),
      })),
    }]),
  });
  const { snapshot } = await inspectWorkspace({ start: projectRoot });
  const observation = await observeMemoryReferences({
    projectRoot,
    snapshot,
    limits: { maxFreshnessPaths: 2, maxFreshnessBytes: 64 * 1024 * 1024, maxArtifactFileBytes: 1024 },
  });

  assert.equal(observation.truncated, true);
  assert.equal(observation.counts.fresh, 2);
  assert.equal(observation.counts.unknown, 1);
});

test("a checkpoint of a Work that is not selected is still classified in history", async (t) => {
  const recorded = "export const value = 1;\n";
  const entries = chain([
    { references: [{ path: "src/a.mjs", sha256: sha256(recorded) }] },
  ]).map((item) => ({ ...item, work_id: OTHER_WORK_ID }));
  const rebuilt = entries.map((item) => {
    const { checkpoint_sha256: ignored, ...base } = item;
    return { ...base, checkpoint_sha256: memoryCheckpointDigest(base) };
  });
  const { projectRoot } = await workspace(t, {
    files: { "src/a.mjs": "export const value = 999;\n" },
    entries: rebuilt,
    works: [work(), work({ work_id: OTHER_WORK_ID, title: "Other work" })],
  });
  const inspection = await inspect(projectRoot);

  // The selected Work has no checkpoint, so the capsule counts stay empty …
  assert.deepEqual(inspection.evaluation.continuity.freshness,
    { fresh: 0, stale: 0, missing: 0, unknown: 0 });
  // … while history, which spans every Work, still classifies the record.
  const history = buildProjectHistory({ inspection });
  assert.equal(history.entries.at(0).lot_id, OTHER_WORK_ID);
  assert.equal(history.entries.at(0).freshness, "stale");
  assert.equal(history.entries.at(0).support, "unsupported");
});

test("a writer stays usable while an older reference is missing", async (t) => {
  const recorded = "export const value = 1;\n";
  const { projectRoot } = await workspace(t, {
    entries: chain([{ references: [{ path: "src/gone.mjs", sha256: sha256(recorded) }] }]),
  });
  const proposal = {
    format: "dubsar.memory-change-proposal/1",
    project_id: PROJECT_ID,
    operation: "checkpoint_append",
    payload: {
      entry: {
        checkpoint_id: "checkpoint-new",
        work_id: WORK_ID,
        kind: "decision",
        summary: "A human decision recorded despite a missing older artifact.",
        references: [],
        validation: ["Confirmed"],
        limitations: ["None"],
        resolves: null,
        attempt: null,
        resulting_state: {
          status: "active",
          summary: "Decision recorded.",
          blockers: [],
          next_action: "Continue.",
        },
      },
    },
  };
  const preview = await previewMemoryChange({ start: projectRoot, proposal });
  assert.equal(preview.status, "preview");
  const applied = await applyMemoryChange({
    start: projectRoot,
    proposal,
    expectedChange: preview.change_sha256,
  });
  assert.equal(applied.status, "applied");
});

test("without observation the workspace keeps its unverified reading", async (t) => {
  const source = "export const value = 1;\n";
  const { projectRoot } = await workspace(t, {
    files: { "src/a.mjs": source },
    entries: chain([{ references: [{ path: "src/a.mjs", sha256: sha256(source) }] }]),
  });
  const inspection = await inspectWorkspace({ start: projectRoot });

  assert.equal(inspection.observation, null);
  assert.deepEqual(inspection.evaluation.continuity.freshness,
    { fresh: 0, stale: 0, missing: 0, unknown: 1 });
  assert.equal(buildProjectHistory({ inspection }).entries.at(0).freshness, "unknown");
  // A capsule built without an observation stays /3 and claims no freshness.
  const capsule = buildMemoryResumeCapsule({ inspection, producer: PRODUCER });
  assert.equal(capsule.format, "dubsar.resume-capsule/3");
  assert.equal(capsule.evidence_freshness, undefined);
  assert.equal(assertMemoryResumeCapsule(capsule), capsule);
});

test("a /3 capsule and a /4 capsule are both accepted, and their shapes stay closed", async (t) => {
  const source = "export const value = 1;\n";
  const { projectRoot } = await workspace(t, {
    files: { "src/a.mjs": source },
    entries: chain([{ references: [{ path: "src/a.mjs", sha256: sha256(source) }] }]),
  });
  const observed = buildMemoryResumeCapsule({
    inspection: await inspect(projectRoot),
    producer: PRODUCER,
  });
  const plain = buildMemoryResumeCapsule({
    inspection: await inspectWorkspace({ start: projectRoot }),
    producer: PRODUCER,
  });

  assert.equal(observed.format, "dubsar.resume-capsule/4");
  assert.equal(plain.format, "dubsar.resume-capsule/3");
  assert.equal(assertMemoryResumeCapsule(observed), observed);
  assert.equal(assertMemoryResumeCapsule(plain), plain);

  // /3 carrying the extra key is invalid.
  assert.throws(
    () => assertMemoryResumeCapsule({ ...plain, evidence_freshness: observed.evidence_freshness }),
    (error) => error?.code === "MEMORY_CAPSULE_INVALID",
  );
  // /4 missing the key is invalid.
  const { evidence_freshness: dropped, ...withoutFreshness } = observed;
  void dropped;
  assert.throws(
    () => assertMemoryResumeCapsule(withoutFreshness),
    (error) => error?.code === "MEMORY_CAPSULE_INVALID",
  );
  // A status inconsistent with its counts is invalid.
  assert.throws(
    () => assertMemoryResumeCapsule({
      ...observed,
      evidence_freshness: { status: "fresh", counts: { fresh: 0, stale: 1, missing: 0, unknown: 0 } },
    }),
    (error) => error?.code === "MEMORY_CAPSULE_INVALID",
  );
});

test("planCapture never grants more than the remaining budget", () => {
  const maxFile = 25 * 1024 * 1024;

  // Nothing spent: the per-file cap applies.
  assert.deepEqual(planCapture(0, 64 * 1024 * 1024, maxFile),
    { outcome: "capture", limit: maxFile, remaining: 64 * 1024 * 1024 });

  // Most of the budget spent: the remainder caps the read, not the file cap.
  const second = planCapture(4000, 4096, maxFile);
  assert.equal(second.outcome, "capture");
  assert.equal(second.limit, 96);
  assert.equal(second.remaining, 96);
  assert.equal(second.limit < maxFile, true);

  // Budget exactly consumed, and overshoot, both stop the read.
  assert.deepEqual(planCapture(4096, 4096, maxFile), { outcome: "budget", limit: 0, remaining: 0 });
  assert.equal(planCapture(5000, 4096, maxFile).outcome, "budget");

  // The limit is always the smaller of the two bounds.
  for (const [spent, budget, cap] of [[0, 10, 4], [6, 10, 8], [9, 10, 1], [0, 3, 3]]) {
    const plan = planCapture(spent, budget, cap);
    if (plan.outcome !== "capture") continue;
    assert.equal(plan.limit, Math.min(cap, budget - spent));
    assert.equal(plan.limit <= budget - spent, true);
  }
});

test("a file larger than the per-file cap stays unknown rather than budget", async (t) => {
  const big = "x".repeat(4096);
  const { projectRoot } = await workspace(t, {
    files: { "src/big.mjs": big },
    entries: chain([{ references: [{ path: "src/big.mjs", sha256: sha256(big) }] }]),
  });
  const { snapshot } = await inspectWorkspace({ start: projectRoot });
  const observation = await observeMemoryReferences({
    projectRoot,
    snapshot,
    // The per-file cap is the binding constraint, not the budget.
    limits: { maxArtifactFileBytes: 16, maxFreshnessBytes: 64 * 1024 * 1024, maxFreshnessPaths: 128 },
  });

  assert.equal(observation.counts.unknown, 1);
  assert.equal(observation.counts.fresh, 0);
  assert.equal(observation.truncated, false, "an intrinsically oversized file is not a budget stop");
  assert.equal(observation.references.at(0).observed_sha256, null);
});

test("the observation contract rejects forged documents", async (t) => {
  const source = "export const value = 1;\n";
  const { projectRoot } = await workspace(t, {
    files: { "src/a.mjs": source },
    entries: chain([{ references: [{ path: "src/a.mjs", sha256: sha256(source) }] }]),
  });
  const valid = (await inspect(projectRoot)).observation;
  assert.equal(assertMemoryReferenceObservation(valid), valid);

  const reseal = (draft) => {
    const { observation_sha256: ignored, ...base } = draft;
    void ignored;
    return {
      ...base,
      observation_sha256: createHash("sha256")
        .update(Buffer.from(stableJson(base), "utf8"))
        .digest("hex"),
    };
  };
  const invalid = (draft) => assert.throws(
    () => assertMemoryReferenceObservation(reseal(draft)),
    (error) => error?.code === "MEMORY_REFERENCE_OBSERVATION_INVALID",
  );

  // Counts that do not match the classified references.
  invalid({ ...valid, counts: { fresh: 7, stale: 0, missing: 0, unknown: 0 } });
  // The same path and recorded digest declared twice.
  invalid({ ...valid, references: [...valid.references, ...valid.references] });
  // A path that is not canonical.
  invalid({
    ...valid,
    references: [{ ...valid.references.at(0), path: "./src/../src/a.mjs" }],
  });
  // stale without an observed digest, and stale whose digest equals the record.
  invalid({
    ...valid,
    counts: { fresh: 0, stale: 1, missing: 0, unknown: 0 },
    references: [{ ...valid.references.at(0), status: "stale", observed_sha256: null }],
  });
  invalid({
    ...valid,
    counts: { fresh: 0, stale: 1, missing: 0, unknown: 0 },
    references: [{
      ...valid.references.at(0),
      status: "stale",
      observed_sha256: valid.references.at(0).recorded_sha256,
    }],
  });
  // unknown and missing must carry no observed digest.
  for (const status of ["unknown", "missing"]) {
    invalid({
      ...valid,
      counts: { fresh: 0, stale: 0, missing: status === "missing" ? 1 : 0, unknown: status === "unknown" ? 1 : 0 },
      references: [{ ...valid.references.at(0), status }],
    });
  }
  // fresh whose observed digest differs from the recorded one.
  invalid({
    ...valid,
    references: [{ ...valid.references.at(0), observed_sha256: "0".repeat(64) }],
  });
  // A tampered digest is caught even when every field is otherwise valid.
  assert.throws(
    () => assertMemoryReferenceObservation({ ...valid, observation_sha256: "f".repeat(64) }),
    (error) => error?.code === "OBSERVATION_DIGEST_MISMATCH",
  );
});

test("the observation contract rejects a reordered reference list", async (t) => {
  const first = "export const value = 1;\n";
  const second = "export const value = 2;\n";
  const { projectRoot } = await workspace(t, {
    files: { "src/a.mjs": second },
    entries: chain([
      { references: [{ path: "src/a.mjs", sha256: sha256(first) }] },
      { references: [{ path: "src/a.mjs", sha256: sha256(second) }] },
    ]),
  });
  const valid = (await inspect(projectRoot)).observation;
  assert.equal(valid.references.length, 2);

  const base = { ...valid, references: [...valid.references].reverse() };
  const { observation_sha256: ignored, ...rest } = base;
  void ignored;
  const resealed = {
    ...rest,
    observation_sha256: createHash("sha256")
      .update(Buffer.from(stableJson(rest), "utf8"))
      .digest("hex"),
  };
  assert.throws(
    () => assertMemoryReferenceObservation(resealed),
    (error) => error?.code === "MEMORY_REFERENCE_OBSERVATION_INVALID",
  );
});

test("the evaluator validates an observation before trusting its snapshot claim", async (t) => {
  const source = "export const value = 1;\n";
  const { projectRoot } = await workspace(t, {
    files: { "src/a.mjs": source },
    entries: chain([{ references: [{ path: "src/a.mjs", sha256: sha256(source) }] }]),
  });
  const { snapshot, observation } = await inspect(projectRoot);

  // Forged counts are refused even though the snapshot digest still matches.
  const forged = { ...observation, counts: { fresh: 99, stale: 0, missing: 0, unknown: 0 } };
  assert.throws(
    () => evaluateMemorySnapshot(snapshot, forged),
    (error) => error?.code === "MEMORY_REFERENCE_OBSERVATION_INVALID" ||
      error?.code === "OBSERVATION_DIGEST_MISMATCH",
  );

  // A valid observation describing another snapshot is refused too.
  assert.throws(
    () => evaluateMemorySnapshot(
      { ...snapshot, snapshot_sha256: "a".repeat(64) },
      observation,
    ),
    (error) => error?.code === "MEMORY_OBSERVATION_SNAPSHOT_MISMATCH",
  );
});

test("an observed workspace whose selected Work records no reference stays /3", async (t) => {
  const source = "export const value = 1;\n";
  // The reference belongs to another Work, so the selected Work has none.
  const entries = chain([
    { references: [{ path: "src/a.mjs", sha256: sha256(source) }] },
  ]).map((item) => {
    const { checkpoint_sha256: ignored, ...base } = { ...item, work_id: OTHER_WORK_ID };
    void ignored;
    return { ...base, checkpoint_sha256: memoryCheckpointDigest(base) };
  });
  const { projectRoot } = await workspace(t, {
    files: { "src/a.mjs": source },
    entries,
    works: [work(), work({ work_id: OTHER_WORK_ID, title: "Other work" })],
  });
  const inspection = await inspect(projectRoot);

  // The observation exists and did classify the other Work's reference …
  assert.notEqual(inspection.observation, null);
  assert.equal(inspection.observation.counts.fresh, 1);
  // … but the capsule has nothing to claim, so it stays /3.
  const capsule = buildMemoryResumeCapsule({ inspection, producer: PRODUCER });
  assert.equal(capsule.format, "dubsar.resume-capsule/3");
  assert.equal(capsule.evidence_freshness, undefined);
  assert.equal(assertMemoryResumeCapsule(capsule), capsule);
});

test("the freshness module source carries no raw control byte", async () => {
  const source = await readFile(
    new URL("../packages/dubsar-project-continuity/runtime/memory-vnext-freshness.mjs",
      import.meta.url),
  );
  assert.equal(source.includes(0x00), false, "source must not embed a NUL byte");
  assert.equal(/REFERENCE_KEY_SEPARATOR = "\\u0000"/u.test(source.toString("utf8")), true);
});

test("a budget stop ends the pass: later paths are never inspected", async (t) => {
  const big = "x".repeat(4096);
  const missingRecord = "export const absent = 1;\n";
  const { projectRoot } = await workspace(t, {
    // Only the first sorted path exists on disk. The second is absent, so if
    // the pass continued it would be classified missing.
    files: { "src/a-big.mjs": big },
    entries: chain([{
      references: [
        { path: "src/a-big.mjs", sha256: sha256(big) },
        { path: "src/b-gone.mjs", sha256: sha256(missingRecord) },
      ],
    }]),
  });
  const { snapshot } = await inspectWorkspace({ start: projectRoot });

  const targets = collectReferenceTargets(snapshot.documents.checkpoints.entries);
  assert.deepEqual(targets.map((item) => item.path), ["src/a-big.mjs", "src/b-gone.mjs"]);

  const observation = await observeMemoryReferences({
    projectRoot,
    snapshot,
    // The first file cannot fit in the budget, so the pass stops there.
    limits: {
      maxFreshnessBytes: 100,
      maxFreshnessPaths: 128,
      maxArtifactFileBytes: 25 * 1024 * 1024,
    },
  });

  assert.equal(observation.truncated, true);
  assert.deepEqual(observation.counts, { fresh: 0, stale: 0, missing: 0, unknown: 2 });
  // The absent path is unknown, not missing: proof it was never inspected.
  const byPath = new Map(observation.references.map((item) => [item.path, item]));
  assert.equal(byPath.get("src/a-big.mjs").status, "unknown");
  assert.equal(byPath.get("src/b-gone.mjs").status, "unknown");
  assert.equal(byPath.get("src/b-gone.mjs").observed_sha256, null);
  assert.equal(assertMemoryReferenceObservation(observation), observation);
});

test("a budget stop also halts the pass after an exhausting capture", async (t) => {
  const first = "a".repeat(64);
  const second = "b".repeat(64);
  const { projectRoot } = await workspace(t, {
    files: { "src/a-first.mjs": first, "src/b-second.mjs": second },
    entries: chain([{
      references: [
        { path: "src/a-first.mjs", sha256: sha256(first) },
        { path: "src/b-second.mjs", sha256: sha256(second) },
      ],
    }]),
  });
  const { snapshot } = await inspectWorkspace({ start: projectRoot });

  const observation = await observeMemoryReferences({
    projectRoot,
    snapshot,
    // Exactly enough for the first file, nothing left for the second.
    limits: {
      maxFreshnessBytes: 64,
      maxFreshnessPaths: 128,
      maxArtifactFileBytes: 25 * 1024 * 1024,
    },
  });

  assert.equal(observation.truncated, true);
  assert.deepEqual(observation.counts, { fresh: 1, stale: 0, missing: 0, unknown: 1 });
  const byPath = new Map(observation.references.map((item) => [item.path, item]));
  assert.equal(byPath.get("src/a-first.mjs").status, "fresh");
  assert.equal(byPath.get("src/b-second.mjs").status, "unknown");
});
