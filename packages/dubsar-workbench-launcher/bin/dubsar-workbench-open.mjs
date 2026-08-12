#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import {
  WORKBENCH_LAUNCH_ERROR_FORMAT,
  WorkbenchLauncherError,
  launchWorkbench,
  manageWorkbenchProjects,
} from "../src/index.mjs";

function parseArguments(argv) {
  const options = {
    includeReviews: false,
    checkOnly: false,
    manage: false,
    transport: "loopback",
  };
  const remaining = [...argv];
  while (remaining.length > 0) {
    const token = remaining.shift();
    if (token === "--reviews") {
      if (options.includeReviews) throw new WorkbenchLauncherError("LAUNCHER_ARGUMENT_DUPLICATE");
      options.includeReviews = true;
      continue;
    }
    if (token === "--check") {
      if (options.checkOnly) throw new WorkbenchLauncherError("LAUNCHER_ARGUMENT_DUPLICATE");
      options.checkOnly = true;
      continue;
    }
    if (token === "--manage") {
      if (options.manage) throw new WorkbenchLauncherError("LAUNCHER_ARGUMENT_DUPLICATE");
      options.manage = true;
      continue;
    }
    if (token === "--file") {
      if (options.transport === "file") throw new WorkbenchLauncherError("LAUNCHER_ARGUMENT_DUPLICATE");
      options.transport = "file";
      continue;
    }
    if (token === "--start" && remaining.length > 0) {
      if (options.start !== undefined) throw new WorkbenchLauncherError("LAUNCHER_ARGUMENT_DUPLICATE");
      options.start = remaining.shift();
      continue;
    }
    if (token === "--memory-root" && remaining.length > 0) {
      if (options.memoryRoot !== undefined) throw new WorkbenchLauncherError("LAUNCHER_ARGUMENT_DUPLICATE");
      options.memoryRoot = remaining.shift();
      continue;
    }
    throw new WorkbenchLauncherError("LAUNCHER_ARGUMENT_INVALID");
  }
  if (
    options.manage &&
    (options.start !== undefined ||
      options.memoryRoot !== undefined ||
      options.includeReviews ||
      options.checkOnly ||
      options.transport !== "loopback")
  ) {
    throw new WorkbenchLauncherError("LAUNCHER_ARGUMENT_INVALID");
  }
  return options;
}

function errorEnvelope(code) {
  return {
    format: WORKBENCH_LAUNCH_ERROR_FORMAT,
    status: "error",
    code,
  };
}

async function manageInteractively() {
  const input = createInterface({ input: process.stdin, output: process.stdout });
  try {
    let running = true;
    while (running) {
      const state = await manageWorkbenchProjects({ action: "list" });
      process.stdout.write("\nProjets DUBSAR\n");
      if (state.projects.length === 0) {
        process.stdout.write("  Aucun projet enregistre.\n");
      } else {
        state.projects.forEach((project, index) => {
          process.stdout.write(`  ${index + 1}. ${project.title} [${project.capture_status}]\n`);
        });
      }
      const choice = (await input.question("\n[A]jouter  [R]etirer  [V]erifier  [Q]uitter : ")).trim().toLowerCase();
      if (choice === "a") {
        await manageWorkbenchProjects({ action: "add" });
      } else if (choice === "r") {
        if (state.projects.length === 0) continue;
        const selected = Number.parseInt((await input.question("Numero du projet a retirer : ")).trim(), 10);
        const project = state.projects.at(selected - 1);
        if (!project) {
          process.stdout.write("Selection invalide.\n");
          continue;
        }
        await manageWorkbenchProjects({ action: "remove", projectId: project.project_id });
      } else if (choice === "v") {
        const verified = await manageWorkbenchProjects({ action: "verify" });
        verified.projects.forEach((project) => {
          process.stdout.write(`  ${project.title}: ${project.integrity}/${project.readiness} — ${project.next_action}\n`);
        });
      } else if (choice === "q") {
        running = false;
      } else {
        process.stdout.write("Choix invalide.\n");
      }
    }
  } finally {
    input.close();
  }
}

try {
  const options = parseArguments(process.argv.slice(2));
  if (options.manage) {
    await manageInteractively();
  } else {
    const result = await launchWorkbench(options);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }
} catch (error) {
  const code = error instanceof WorkbenchLauncherError
    ? error.code
    : "LAUNCHER_UNEXPECTED_FAILURE";
  if (code === "CATALOG_REPORT_TOO_LARGE") {
    process.stderr.write("Le rapport depasse 2 Mio. Retirez des projets dans Gerer les projets DUBSAR, puis reessayez.\n");
  }
  process.stderr.write(`${JSON.stringify(errorEnvelope(code))}\n`);
  process.exitCode = 1;
}
