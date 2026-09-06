import { CONTROLLER_RUN_TOOL, CONTROLLER_TOOL } from "./mission-args.mjs";
import { MyWorkMcpError } from "./canonical.mjs";
import { readCredentials } from "./oauth-store.mjs";

export const MCP_STREAMABLE_ACCEPT = "application/json, text/event-stream";

let testTransport = null;

export function setTestControllerTransport(transport) {
  testTransport = transport;
}

export function resetTestControllerTransport() {
  testTransport = null;
}

export function legacyControllerLaunchHeaders(accessToken) {
  return {
    "content-type": "application/json",
    authorization: `Bearer ${accessToken}`,
  };
}

export function streamableMcpLaunchHeaders(accessToken) {
  return {
    "content-type": "application/json",
    accept: MCP_STREAMABLE_ACCEPT,
    authorization: `Bearer ${accessToken}`,
  };
}

export function controllerToolsCallBody(args, tool = CONTROLLER_TOOL) {
  return {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: tool,
      arguments: args,
    },
  };
}

export function parseSseJsonRpc(text) {
  if (typeof text !== "string" || text.length < 1) return null;
  const blocks = text.split(/\r?\n\r?\n/u);
  let last = null;
  for (const block of blocks) {
    const dataLines = [];
    for (const line of block.split(/\r?\n/u)) {
      if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^\s/u, ""));
    }
    if (dataLines.length < 1) continue;
    try {
      last = JSON.parse(dataLines.join("\n"));
    } catch {
      last = null;
    }
  }
  return last;
}

function receiptFromToolResult(payload) {
  if (!payload || typeof payload !== "object") return null;
  if (payload.error) return { ambiguous: true, receipt: null };
  const result = payload.result;
  if (result?.isError === true) return { ambiguous: true, receipt: null };
  if (result?.structuredContent && typeof result.structuredContent === "object") {
    return { ambiguous: false, receipt: result.structuredContent };
  }
  const text = result?.content?.[0]?.text;
  if (typeof text === "string") {
    try {
      return { ambiguous: false, receipt: JSON.parse(text) };
    } catch {
      return { ambiguous: true, receipt: null };
    }
  }
  if (result && typeof result === "object" && result.receipt_version) {
    return { ambiguous: false, receipt: result };
  }
  return { ambiguous: true, receipt: null };
}

export async function readMcpJsonRpc(response, ambiguousCode = "MY_WORK_LAUNCH_AMBIGUOUS") {
  if (!response || typeof response.text !== "function") {
    throw new MyWorkMcpError(ambiguousCode);
  }
  const text = await response.text();
  const type = String(response.headers?.get?.("content-type") ?? "");
  if (type.includes("text/event-stream")) {
    const payload = parseSseJsonRpc(text);
    if (!payload) throw new MyWorkMcpError(ambiguousCode);
    return payload;
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new MyWorkMcpError(ambiguousCode);
  }
}

export function assertControllerArgumentsOnly(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new MyWorkMcpError("MY_WORK_MISSION_INCOMPLETE");
  }
  if ("contract_fingerprint" in args || "receipt_bounds" in args || "format" in args) {
    throw new MyWorkMcpError("MY_WORK_CONTROLLER_ARGUMENT_LEAK");
  }
  return args;
}

export function controllerLaunchConfigured() {
  if (typeof testTransport === "function") return true;
  return null;
}

async function postControllerTool(tool, args, ambiguousCode, { fetchImpl = fetch } = {}) {
  const forwarded = assertControllerArgumentsOnly(args);
  if (typeof testTransport === "function") {
    return testTransport({ tool, arguments: forwarded });
  }
  const credentials = await readCredentials();
  if (!credentials?.access_token || typeof credentials.controller_url !== "string") {
    throw new MyWorkMcpError("MY_WORK_CONTROLLER_NOT_CONNECTED");
  }
  let response;
  try {
    response = await fetchImpl(credentials.controller_url, {
      method: "POST",
      headers: streamableMcpLaunchHeaders(credentials.access_token),
      body: JSON.stringify(controllerToolsCallBody(forwarded, tool)),
    });
  } catch {
    throw new MyWorkMcpError(ambiguousCode);
  }
  let payload;
  try {
    payload = await readMcpJsonRpc(response, ambiguousCode);
  } catch (error) {
    throw error instanceof MyWorkMcpError ? error : new MyWorkMcpError(ambiguousCode);
  }
  const parsed = receiptFromToolResult(payload);
  if (parsed.ambiguous || !parsed.receipt) throw new MyWorkMcpError(ambiguousCode);
  return parsed.receipt;
}

export async function callCreateDubsarWorkCursorAgent(args, options = {}) {
  return postControllerTool(CONTROLLER_TOOL, args, "MY_WORK_LAUNCH_AMBIGUOUS", options);
}

export async function callCreateDubsarWorkCursorAgentRun(args, options = {}) {
  return postControllerTool(CONTROLLER_RUN_TOOL, args, "MY_WORK_CONTINUE_AMBIGUOUS", options);
}
