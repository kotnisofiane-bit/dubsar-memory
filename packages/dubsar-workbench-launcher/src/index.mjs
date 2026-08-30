import path from "node:path";
import { captureRegularFile } from "../../dubsar-operator-core/src/safe-capture.mjs";
import {
  WORKBENCH_LAUNCHER_IDENTITY,
  WORKBENCH_CATALOG_LAUNCH_FORMAT,
  WORKBENCH_LAUNCH_CHECK_FORMAT,
  WORKBENCH_LAUNCH_ERROR_FORMAT,
  WORKBENCH_LAUNCH_FORMAT,
  WORKBENCH_PROJECT_MANAGEMENT_FORMAT,
  WorkbenchLauncherError,
  launchWorkbench,
  manageWorkbenchProjects,
  runTicketCli as runLauncherTicketCli,
  createTicketDashboardHandler,
} from "./launcher.mjs";
import {
  TicketError,
  applyTicketChange,
  previewTicketChange,
} from "./registry-store.mjs";

export {
  WORKBENCH_LAUNCHER_IDENTITY,
  WORKBENCH_CATALOG_LAUNCH_FORMAT,
  WORKBENCH_LAUNCH_CHECK_FORMAT,
  WORKBENCH_LAUNCH_ERROR_FORMAT,
  WORKBENCH_LAUNCH_FORMAT,
  WORKBENCH_PROJECT_MANAGEMENT_FORMAT,
  WorkbenchLauncherError,
  launchWorkbench,
  manageWorkbenchProjects,
  createTicketDashboardHandler,
};
export {
  TicketError,
  applyTicketChange,
  previewTicketChange,
  readTicketAllocations,
  readTickets,
  synchronizeEligibleTickets,
} from "./registry-store.mjs";

function parseSyncCli(argv) {
  const options = { apply: false, json: false };
  for (let index = 2; index < argv.length; index += 1) {
    const token = argv.at(index);
    if (token === "--apply") { options.apply = true; continue; }
    if (token === "--json") { options.json = true; continue; }
    const value = argv.at(++index);
    if (value === undefined) throw new TicketError("TICKET_CLI_ARGUMENT_INVALID");
    if (token === "--start") options.start = value;
    else if (token === "--proposal") options.proposal = value;
    else if (token === "--expected-change") options.expected_change = value;
    else if (token === "--allocation-root") options.allocation_root = value;
    else if (token === "--project-id") options.project_id = value;
    else throw new TicketError("TICKET_CLI_ARGUMENT_INVALID");
  }
  if (!options.start || !options.allocation_root || !options.project_id || !options.proposal) throw new TicketError("TICKET_CLI_ARGUMENT_INVALID");
  return options;
}

export async function runTicketCli(argv, io = console, boundaries = {}) {
  if (argv.at(0) === "tickets" && argv.at(1) === "sync-cursor-status") {
    try {
      const options = parseSyncCli(argv);
      if (options.apply && !options.expected_change) throw new TicketError("TICKET_CLI_ARGUMENT_INVALID");
      const proposalPath = path.resolve(options.proposal);
      const operation = JSON.parse((await captureRegularFile(path.dirname(proposalPath), path.basename(proposalPath), 64 * 1024)).content.toString("utf8"));
      if (operation.type !== "sync-cursor-status") throw new TicketError("TICKET_CLI_ARGUMENT_INVALID");
      const request = { start: options.start, allocationRoot: options.allocation_root, projectId: options.project_id, operation, observeGithubMerge: boundaries.observeGithubMerge };
      const value = options.apply
        ? await applyTicketChange({ ...request, expectedChange: options.expected_change })
        : await previewTicketChange(request);
      io.log(JSON.stringify(value, null, options.json ? 0 : 2));
      return { exitCode: 0, value };
    } catch (error) {
      const code = error instanceof TicketError ? error.code : "TICKET_CLI_FAILED";
      io.error(JSON.stringify({ format: "dubsar.ticket-cli-error/1", code }));
      return { exitCode: 1, error: code };
    }
  }
  return runLauncherTicketCli(argv, io, boundaries);
}
