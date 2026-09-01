import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { MyWorkMcpError } from "./canonical.mjs";
import { controllerEndpointConfig, writeCredentials } from "./oauth-store.mjs";

function base64url(buffer) {
  return buffer.toString("base64").replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function pkce() {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

function openBrowser(url) {
  if (process.env.DUBSAR_MY_WORK_OPEN_BROWSER === "0") return;
  const opener = process.env.DUBSAR_MY_WORK_BROWSER_OPENER;
  if (typeof opener === "string" && opener.length > 0) {
    spawn(opener, [url], { detached: true, stdio: "ignore" }).unref();
    return;
  }
  if (process.platform === "darwin") spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
  else if (process.platform === "win32") spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
  else spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
}

function listenLoopback() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({ server, redirectUri: `http://127.0.0.1:${address.port}/callback` });
    });
  });
}

function waitForCode(server, expectedState) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      server.close();
      reject(new MyWorkMcpError("MY_WORK_OAUTH_TIMEOUT"));
    }, 120_000);
    server.on("request", (request, response) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== "/callback") {
        response.writeHead(404).end();
        return;
      }
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      response.end("DUBSAR My Work: you can close this window.");
      clearTimeout(timer);
      server.close();
      if (!code || state !== expectedState) {
        reject(new MyWorkMcpError("MY_WORK_OAUTH_FAILED"));
        return;
      }
      resolve(code);
    });
  });
}

export async function connectController({ fetchImpl = fetch, write = process.stdout, openBrowserImpl = openBrowser } = {}) {
  const endpoints = controllerEndpointConfig();
  if (
    endpoints.controllerUrl.length < 1 ||
    endpoints.authorizationEndpoint.length < 1 ||
    endpoints.tokenEndpoint.length < 1 ||
    endpoints.clientId.length < 1
  ) {
    throw new MyWorkMcpError("MY_WORK_OAUTH_CONFIG_INCOMPLETE");
  }
  const { verifier, challenge } = pkce();
  const state = base64url(randomBytes(16));
  const { server, redirectUri } = await listenLoopback();
  const authorize = new URL(endpoints.authorizationEndpoint);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("client_id", endpoints.clientId);
  authorize.searchParams.set("redirect_uri", redirectUri);
  authorize.searchParams.set("code_challenge", challenge);
  authorize.searchParams.set("code_challenge_method", "S256");
  authorize.searchParams.set("state", state);
  const authorizeUrl = authorize.toString();
  write.write(`Open this URL to connect the DUBSAR Controller:\n${authorizeUrl}\n`);
  const codePromise = waitForCode(server, state);
  await Promise.resolve(openBrowserImpl(authorizeUrl));
  const code = await codePromise;
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: endpoints.clientId,
    code_verifier: verifier,
  });
  const tokenResponse = await fetchImpl(endpoints.tokenEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!tokenResponse.ok) throw new MyWorkMcpError("MY_WORK_OAUTH_FAILED");
  const tokens = await tokenResponse.json();
  if (typeof tokens?.access_token !== "string" || tokens.access_token.length < 1) {
    throw new MyWorkMcpError("MY_WORK_OAUTH_FAILED");
  }
  await writeCredentials({
    controller_url: endpoints.controllerUrl,
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token ?? null,
    token_type: tokens.token_type ?? "Bearer",
    expires_at:
      typeof tokens.expires_in === "number"
        ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
        : null,
  });
  write.write("Connected. Credentials stored only in the local controller store.\n");
  return { connected: true };
}
