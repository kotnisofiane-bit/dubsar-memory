import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildMemoryResumeCapsule,
  buildMemoryRoute,
  inspectWorkspace,
} from "../packages/dubsar-project-continuity/runtime/index.mjs";

const PRODUCER = Object.freeze({
  name: "@dubsar/project-continuity",
  version: "0.3.0-dev",
});

export async function runDemo(root) {
  const start = path.join(root, "examples", "memory-vnext-project");
  const inspection = await inspectWorkspace({ start });
  const capsule = buildMemoryResumeCapsule({ inspection, producer: PRODUCER });
  const route = buildMemoryRoute({ inspection });
  const memory = inspection.evaluation.memory;
  return {
    status:
      inspection.evaluation.integrity.status === "valid" &&
      capsule.format === "dubsar.resume-capsule/3" &&
      route.format === "dubsar.memory-route/2"
        ? "pass"
        : "fail",
    project: {
      workspace_mode: "memory_vnext",
      integrity: inspection.evaluation.integrity.status,
      readiness: inspection.evaluation.readiness.status,
      active_work_id: capsule.active_work?.work_id ?? null,
      checkpoint_count: memory.checkpoints.length,
      next_action: capsule.next_action.code,
      route_action: route.guidance.action,
      shared_snapshot_sha256: capsule.project.shared_snapshot_sha256,
      snapshot_sha256: capsule.project.snapshot_sha256,
      disclaimer: "No project action was executed or authorized.",
    },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const result = await runDemo(root);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.status !== "pass") process.exitCode = 1;
}
