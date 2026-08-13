import { fileURLToPath } from "node:url";
import {
  currentAuditRootDigest,
  readReceiptFromStdin,
  recordAuditReviewReceipt,
} from "../skills/dubsar-audit-readiness/scripts/record-review-receipt.mjs";
import { parseArgs, printFailure, printResult } from "../skills/dubsar-audit-readiness/scripts/safe-io.mjs";

export { currentAuditRootDigest, recordAuditReviewReceipt };

async function main() {
  try {
    const args = parseArgs(process.argv.slice(2), ["root"], ["root"]);
    printResult(await recordAuditReviewReceipt(args.root, await readReceiptFromStdin()));
  } catch (error) { printFailure(error); }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
