import { createServer } from "node:net";
import { MyWorkMcpError } from "./canonical.mjs";
import { createFrameParser, encodeFrame, handleMessage } from "./server.mjs";

const FORBIDDEN_SOCKET_NAMES = new Set(["herdr.sock", "docker.sock", "docker.sock.raw"]);

export function assertPrivateMcpSocketPath(socketPath) {
  if (typeof socketPath !== "string" || socketPath.length < 1) {
    throw new MyWorkMcpError("MY_WORK_HERMES_SOCKET_INVALID");
  }
  const base = socketPath.split(/[/\\]/u).at(-1);
  if (FORBIDDEN_SOCKET_NAMES.has(base) || /herdr\.sock|docker\.sock/iu.test(socketPath)) {
    throw new MyWorkMcpError("MY_WORK_HERMES_SOCKET_FORBIDDEN");
  }
  return socketPath;
}

export async function listenHermesMcpSocket(socketPath, stdio = process) {
  assertPrivateMcpSocketPath(socketPath);
  if (process.platform === "win32") {
    throw new MyWorkMcpError("MY_WORK_HERMES_SOCKET_UNSUPPORTED");
  }
  const server = createServer((socket) => {
    const write = (payload) => {
      if (payload == null) return;
      socket.write(encodeFrame(payload));
    };
    const onChunk = createFrameParser((message) => {
      Promise.resolve(handleMessage(message)).then(write, () => {
        write({ jsonrpc: "2.0", id: message?.id ?? null, error: { code: -32603, message: "Internal error" } });
      });
    });
    socket.on("data", onChunk);
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      stdio.stderr.write(`${JSON.stringify({ format: "dubsar.hermes-mcp-socket/1", path: socketPath })}\n`);
      resolve(server);
    });
  });
}
