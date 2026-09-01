import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { homedir } from "node:os";
import { MyWorkMcpError } from "./canonical.mjs";
import { redactObject } from "./redact.mjs";

export const CREDENTIALS_FORMAT = "dubsar.my-work-controller-credentials/1";
export const CREDENTIALS_FILENAME = "credentials.json";

export function controllerConfigDir() {
  if (typeof process.env.DUBSAR_MY_WORK_CONFIG_DIR === "string" && process.env.DUBSAR_MY_WORK_CONFIG_DIR.length > 0) {
    return process.env.DUBSAR_MY_WORK_CONFIG_DIR;
  }
  return path.join(homedir(), ".dubsar", "my-work-controller");
}

export function credentialsPath() {
  return path.join(controllerConfigDir(), CREDENTIALS_FILENAME);
}

export function controllerEndpointConfig() {
  const controllerUrl = process.env.DUBSAR_CONTROLLER_URL ?? "";
  const authorizationEndpoint = process.env.DUBSAR_CONTROLLER_AUTHORIZATION_ENDPOINT ?? "";
  const tokenEndpoint = process.env.DUBSAR_CONTROLLER_TOKEN_ENDPOINT ?? "";
  const clientId = process.env.DUBSAR_CONTROLLER_CLIENT_ID ?? "";
  return { controllerUrl, authorizationEndpoint, tokenEndpoint, clientId };
}

export async function readCredentials() {
  try {
    const raw = JSON.parse(await readFile(credentialsPath(), "utf8"));
    if (raw?.format !== CREDENTIALS_FORMAT) return null;
    return raw;
  } catch {
    return null;
  }
}

export async function writeCredentials(record) {
  if (!record || typeof record.access_token !== "string" || record.access_token.length < 1) {
    throw new MyWorkMcpError("MY_WORK_CONTROLLER_NOT_CONNECTED");
  }
  const dir = controllerConfigDir();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const payload = {
    format: CREDENTIALS_FORMAT,
    controller_url: record.controller_url,
    token_type: record.token_type ?? "Bearer",
    access_token: record.access_token,
    refresh_token: record.refresh_token ?? null,
    expires_at: record.expires_at ?? null,
    stored_at: new Date().toISOString(),
  };
  await writeFile(credentialsPath(), `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  return payload;
}

export async function connectionStatus() {
  const stored = await readCredentials();
  const endpoints = controllerEndpointConfig();
  const connected = Boolean(stored?.access_token);
  return redactObject({
    format: "dubsar.my-work-controller-status/1",
    connected,
    credentials_path: credentialsPath(),
    credentials_store: "local_file_outside_repository",
    controller_url: stored?.controller_url ?? endpoints.controllerUrl ?? null,
    token_present: connected,
    expires_at: stored?.expires_at ?? null,
    access_token: stored?.access_token ?? null,
    refresh_token: stored?.refresh_token ?? null,
  });
}
