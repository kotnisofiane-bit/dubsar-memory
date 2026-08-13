import { fileURLToPath } from "node:url";
import {
  openWorkspace,
  parseArgs,
  printFailure,
  printResult,
} from "./safe-io.mjs";
import { validateProjectWorkspace } from "./project-model.mjs";

export async function runProjectValidation(input) {
  const root = await openWorkspace(input);
  return validateProjectWorkspace(root);
}

async function main() {
  try {
    const args = parseArgs(process.argv.slice(2), ["root"]);
    const result = await runProjectValidation(args.root);
    printResult(result);
    if (result.status !== "valid") {
      process.exitCode = 2;
    }
  } catch (error) {
    printFailure(error);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
