#!/usr/bin/env node
/**
 * Isolated qualification candidate for the complete My Work → Herdr pane
 * → systemd --user scope → Codex path.
 *
 * This script does not contact a VPS, secrets, or user memories.
 * Default --simulate uses protocol doubles. Vendor binaries remain a
 * human local_install / vm_cloud gate.
 */
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { executeTool } from "../packages/dubsar-my-work-mcp/src/tools.mjs";
import { resetTestCodexExecutor } from "../packages/dubsar-my-work-mcp/src/codex-executor.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const simulate = process.argv.includes("--simulate");

if (!simulate && !process.env.DUBSAR_HERDR_BIN) {
  process.stderr.write("vendor qualification requires DUBSAR_HERDR_BIN, DUBSAR_CODEX_BIN, XDG_RUNTIME_DIR, systemd --user; use --simulate for doubles\n");
  process.exit(2);
}

if (simulate) {
  process.env.DUBSAR_HERDR_BIN = path.join(root, "tests/helpers/herdr-protocol/herdr.mjs");
  process.env.DUBSAR_CODEX_BIN = path.join(root, "tests/helpers/codex-protocol/codex.mjs");
  process.env.DUBSAR_SYSTEMD_RUN_BIN = path.join(root, "tests/helpers/systemd-protocol/systemd-run.mjs");
  process.env.DUBSAR_SYSTEMCTL_BIN = path.join(root, "tests/helpers/systemd-protocol/systemctl.mjs");
}

resetTestCodexExecutor();
const start = await mkdtemp(path.join(tmpdir(), "dubsar-qualify-project-"));
const allocationRoot = await mkdtemp(path.join(tmpdir(), "dubsar-qualify-global-"));
const runtimeDir = await mkdtemp(path.join(tmpdir(), "dubsar-qualify-xdg-"));
await mkdir(path.join(start, ".dubsar"));
process.env.XDG_RUNTIME_DIR = process.env.XDG_RUNTIME_DIR && !simulate ? process.env.XDG_RUNTIME_DIR : runtimeDir;
process.env.CODEX_CONFIG_SENTINEL = process.env.CODEX_CONFIG_SENTINEL ?? "qualify-sentinel";

const context = {
  start,
  allocation_root: allocationRoot,
  project_id: "project-qualify",
  title: "Qualification candidate",
  objective: "Ticket temporaire isolé",
  criteria: ["Fichier attendu"],
  allowed_paths: ["packages/dubsar-my-work-mcp/**"],
  mission: "QUALIFY_LAUNCH_OK",
};

try {
  const launched = await executeTool("launch_codex_mission", context);
  const body = await readFile(path.join(start, "codex-launch.txt"), "utf8");
  if (body.trim() !== "QUALIFY_LAUNCH_OK") throw new Error("independent file mismatch");
  const continued = await executeTool("continue_codex_mission", {
    ...context,
    ticket_id: launched.ticket_id,
    prompt: "QUALIFY_RESUME_OK",
  });
  if (continued.codex_session_id !== launched.codex_session_id) throw new Error("session id changed");
  const resumeBody = await readFile(path.join(start, "codex-continue.txt"), "utf8");
  if (resumeBody.trim() !== "QUALIFY_RESUME_OK") throw new Error("resume file mismatch");
  const stopped = await executeTool("stop_codex_mission", { ...context, ticket_id: launched.ticket_id });
  if (stopped.mission_success === true) throw new Error("stop must not mean mission success");
  process.stdout.write(
    `${JSON.stringify({
      format: "dubsar.codex-qualify-candidate/1",
      simulate,
      ticket_id: launched.ticket_id,
      herdr_id: launched.herdr_id,
      codex_session_id: launched.codex_session_id,
      stop: stopped.status ?? stopped.already_finished,
      note: "not a VPS or Hermes E2E proof",
    })}\n`,
  );
} finally {
  await rm(start, { recursive: true, force: true });
  await rm(allocationRoot, { recursive: true, force: true });
  if (simulate) await rm(runtimeDir, { recursive: true, force: true });
}
