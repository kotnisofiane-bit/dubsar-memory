import { connectionStatus } from "./oauth-store.mjs";
import { connectController } from "./oauth-flow.mjs";
import { redactObject } from "./redact.mjs";
import { attachStdio } from "./server.mjs";

export async function runCli(argv = process.argv.slice(2), stdio = process) {
  const command = argv[0];
  if (command === "connect") {
    await connectController({ write: stdio.stdout });
    return 0;
  }
  if (command === "status") {
    const status = await connectionStatus();
    stdio.stdout.write(`${JSON.stringify(redactObject(status), null, 2)}\n`);
    return 0;
  }
  attachStdio(stdio);
  return 0;
}
