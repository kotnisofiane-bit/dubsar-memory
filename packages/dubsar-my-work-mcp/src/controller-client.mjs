import { CONTROLLER_TOOL } from "./mission-args.mjs";
import { MyWorkMcpError } from "./canonical.mjs";
import { readCredentials } from "./oauth-store.mjs";

let testTransport = null;

export function setTestControllerTransport(transport) {
  testTransport = transport;
}

export function resetTestControllerTransport() {
  testTransport = null;
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

export async function callCreateDubsarWorkCursorAgent(args, { fetchImpl = fetch } = {}) {
  const forwarded = assertControllerArgumentsOnly(args);
  if (typeof testTransport === "function") {
    return testTransport({ tool: CONTROLLER_TOOL, arguments: forwarded });
  }
  const credentials = await readCredentials();
  if (!credentials?.access_token || typeof credentials.controller_url !== "string") {
    throw new MyWorkMcpError("MY_WORK_CONTROLLER_NOT_CONNECTED");
  }
  let response;
  try {
    response = await fetchImpl(credentials.controller_url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${credentials.access_token}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: CONTROLLER_TOOL,
          arguments: forwarded,
        },
      }),
    });
  } catch {
    throw new MyWorkMcpError("MY_WORK_LAUNCH_AMBIGUOUS");
  }
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new MyWorkMcpError("MY_WORK_LAUNCH_AMBIGUOUS");
  }
  const parsed = receiptFromToolResult(payload);
  if (parsed.ambiguous || !parsed.receipt) throw new MyWorkMcpError("MY_WORK_LAUNCH_AMBIGUOUS");
  return parsed.receipt;
}
