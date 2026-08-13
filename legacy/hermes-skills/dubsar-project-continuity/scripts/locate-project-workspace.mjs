import { fileURLToPath } from "node:url";
import { locateProjectWorkspace } from "./ensure-project-workspace.mjs";
import {
  parseArgs,
  printFailure,
  printResult,
} from "./safe-io.mjs";

export { locateProjectWorkspace };

async function main() {
  try {
    const args = parseArgs(process.argv.slice(2), [], ["start", "workspace"]);
    printResult(
      await locateProjectWorkspace({
        start: args.start,
        workspace: args.workspace,
      }),
    );
  } catch (error) {
    printFailure(error);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
