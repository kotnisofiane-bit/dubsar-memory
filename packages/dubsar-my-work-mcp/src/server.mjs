import { TOOL_DEFINITIONS, executeTool } from "./tools.mjs";
import { MyWorkMcpError } from "./canonical.mjs";
import { TicketError } from "../../dubsar-workbench-launcher/src/registry-store.mjs";

export const MY_WORK_MCP_IDENTITY = Object.freeze({
  name: "dubsar-my-work",
  version: "0.1.0-dev",
});

export const PROTOCOL_VERSION = "2024-11-05";

function jsonResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function jsonError(id, code, message, data) {
  return { jsonrpc: "2.0", id, error: { code, message, data } };
}

export async function handleMessage(message) {
  if (!message || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
    return jsonError(message?.id ?? null, -32600, "Invalid Request");
  }
  const { method, params, id } = message;
  if (method === "notifications/initialized" || method.startsWith("notifications/")) {
    return null;
  }
  if (method === "initialize") {
    return jsonResult(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: MY_WORK_MCP_IDENTITY,
    });
  }
  if (method === "ping") {
    return jsonResult(id, {});
  }
  if (method === "tools/list") {
    return jsonResult(id, { tools: TOOL_DEFINITIONS });
  }
  if (method === "tools/call") {
    const name = params?.name;
    const args = params?.arguments ?? {};
    try {
      const result = await executeTool(name, args);
      return jsonResult(id, {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: result,
        isError: false,
      });
    } catch (error) {
      const code = error instanceof MyWorkMcpError || error instanceof TicketError ? error.code : "MY_WORK_OPERATION_FAILED";
      return jsonResult(id, {
        content: [{ type: "text", text: JSON.stringify({ format: "dubsar.my-work-mcp-error/1", code }) }],
        structuredContent: { format: "dubsar.my-work-mcp-error/1", code },
        isError: true,
      });
    }
  }
  return jsonError(id ?? null, -32601, "Method not found");
}

export function encodeFrame(payload) {
  return Buffer.from(`${JSON.stringify(payload)}\n`, "utf8");
}

export function encodeContentLengthFrame(payload) {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "utf8"), body]);
}

function parseJsonMessage(text, onMessage) {
  const trimmed = text.replace(/^\uFEFF/, "").trim();
  if (trimmed === "") return;
  onMessage(JSON.parse(trimmed));
}

export function createFrameParser(onMessage) {
  let buffer = Buffer.alloc(0);
  return (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length > 0) {
      const asciiStart = buffer.subarray(0, Math.min(buffer.length, 64)).toString("latin1");
      if (/^content-length\s*:/i.test(asciiStart) || asciiStart.startsWith("Content-Length")) {
        const headerEnd = buffer.indexOf("\r\n\r\n");
        if (headerEnd === -1) return;
        const header = buffer.subarray(0, headerEnd).toString("utf8");
        const match = header.match(/^Content-Length:\s*(\d+)$/imu);
        if (!match) {
          buffer = buffer.subarray(headerEnd + 4);
          continue;
        }
        const length = Number(match[1]);
        const start = headerEnd + 4;
        if (buffer.length < start + length) return;
        const body = buffer.subarray(start, start + length).toString("utf8");
        buffer = buffer.subarray(start + length);
        parseJsonMessage(body, onMessage);
        continue;
      }
      const newline = buffer.indexOf(0x0a);
      if (newline === -1) return;
      const line = buffer.subarray(0, newline).toString("utf8").replace(/\r$/, "");
      buffer = buffer.subarray(newline + 1);
      parseJsonMessage(line, onMessage);
    }
  };
}

export function attachStdio(stdio = process) {
  const write = (payload) => {
    if (payload == null) return;
    stdio.stdout.write(encodeFrame(payload));
  };
  const onChunk = createFrameParser((message) => {
    Promise.resolve(handleMessage(message)).then(write, () => {
      write(jsonError(message?.id ?? null, -32603, "Internal error"));
    });
  });
  stdio.stdin.on("data", onChunk);
  stdio.stdin.on("end", () => {
    if (typeof stdio.stdout.end === "function") stdio.stdout.end();
  });
}
