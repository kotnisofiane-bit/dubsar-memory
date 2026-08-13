import { fileURLToPath } from "node:url";
import { renderAuditSummary } from "../skills/dubsar-audit-readiness/scripts/render-audit-summary.mjs";
import {
  parseArgs,
  printFailure,
  printResult,
} from "../skills/dubsar-audit-readiness/scripts/safe-io.mjs";

export { renderAuditSummary };

async function main() {
  try {
    const args = parseArgs(process.argv.slice(2), ["root", "output"]);
    printResult(await renderAuditSummary(args.root, args.output));
  } catch (error) {
    printFailure(error);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
