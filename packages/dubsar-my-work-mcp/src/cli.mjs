import { connectionStatus } from "./oauth-store.mjs";
import { connectController } from "./oauth-flow.mjs";
import { redactObject } from "./redact.mjs";
import { attachStdio, setMcpProfile } from "./server.mjs";
import { listenHermesMcpSocket } from "./hermes-transport.mjs";

export async function runCli(argv = process.argv.slice(2), stdio = process) {
  const rest = [...argv];
  let profile = process.env.DUBSAR_MY_WORK_MCP_PROFILE ?? "default";
  let mcpSocket = null;
  while (rest[0] === "--profile" || rest[0] === "--mcp-socket") {
    if (rest[0] === "--profile") {
      profile = rest[1];
      rest.splice(0, 2);
      continue;
    }
    mcpSocket = rest[1];
    rest.splice(0, 2);
  }
  setMcpProfile(profile);
  const command = rest[0];
  if (command === "connect") {
    if (profile === "hermes") {
      stdio.stderr.write(`${JSON.stringify({ format: "dubsar.my-work-mcp-error/1", code: "MY_WORK_HERMES_TOOL_FORBIDDEN" })}\n`);
      return 1;
    }
    await connectController({ write: stdio.stdout });
    return 0;
  }
  if (command === "status") {
    const status = await connectionStatus();
    stdio.stdout.write(`${JSON.stringify(redactObject(status), null, 2)}\n`);
    return 0;
  }
  if (mcpSocket) {
    if (profile !== "hermes") {
      stdio.stderr.write(`${JSON.stringify({ format: "dubsar.my-work-mcp-error/1", code: "MY_WORK_HERMES_SOCKET_FORBIDDEN" })}\n`);
      return 1;
    }
    await listenHermesMcpSocket(mcpSocket, stdio);
    return 0;
  }
  attachStdio(stdio);
  return 0;
}
