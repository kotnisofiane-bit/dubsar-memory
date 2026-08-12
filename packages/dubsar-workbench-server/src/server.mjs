import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";

export const WORKBENCH_SERVER_IDENTITY = Object.freeze({
  name: "@dubsar/workbench-server",
  version: "0.1.0-dev",
});

export const WORKBENCH_SERVER_LIMITS = Object.freeze({
  absoluteLifetimeMs: 30 * 60 * 1000,
  connectionsCheckingIntervalMs: 250,
  headerBytes: 8 * 1024,
  headersCount: 32,
  headersTimeoutMs: 5 * 1000,
  idleMs: 5 * 60 * 1000,
  keepAliveTimeoutMs: 1000,
  maxConnections: 32,
  maxHtmlBytes: 2 * 1024 * 1024,
  maxRequestsPerSocket: 16,
  requestTimeoutMs: 5 * 1000,
  responseDeadlineMs: 10 * 1000,
  shutdownGraceMs: 1000,
  shutdownHardMs: 2 * 1000,
  socketTimeoutMs: 5 * 1000,
});

const LOOPBACK_HOST = "127.0.0.1";
const SESSION_TOKEN_CHARS = 43;
const SHA256_HEX = /^[0-9a-f]{64}$/u;
const PROJECT_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const ERROR_BODY = Buffer.from("Not available.\n", "utf8");
const CSP = [
  "base-uri 'none'",
  "connect-src 'none'",
  "default-src 'none'",
  "font-src 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "frame-src 'none'",
  "img-src 'none'",
  "media-src 'none'",
  "object-src 'none'",
  "script-src 'none'",
  "style-src 'unsafe-inline'",
  "worker-src 'none'",
].join("; ");
const PERMISSIONS_POLICY = [
  "accelerometer=()",
  "autoplay=()",
  "camera=()",
  "display-capture=()",
  "encrypted-media=()",
  "fullscreen=()",
  "geolocation=()",
  "gyroscope=()",
  "magnetometer=()",
  "microphone=()",
  "midi=()",
  "payment=()",
  "picture-in-picture=()",
  "publickey-credentials-get=()",
  "screen-wake-lock=()",
  "serial=()",
  "usb=()",
  "web-share=()",
  "xr-spatial-tracking=()",
].join(", ");
const COMMON_HEADERS = Object.freeze({
  "Cache-Control": "no-store, max-age=0",
  "Content-Security-Policy": CSP,
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Permissions-Policy": PERMISSIONS_POLICY,
  Pragma: "no-cache",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
});
const ONE_SHOT_LIMITS = Object.freeze({
  ...WORKBENCH_SERVER_LIMITS,
  absoluteLifetimeMs: 60 * 1000,
  idleMs: 30 * 1000,
});
const LIVE_SESSION_LIMITS = Object.freeze({
  ...WORKBENCH_SERVER_LIMITS,
  absoluteLifetimeMs: 8 * 60 * 60 * 1000,
  idleMs: 2 * 60 * 1000,
});
const LIFECYCLE_STATES = new Set([
  "initializing",
  "listening",
  "ready",
  "closing",
  "closed",
]);

export class WorkbenchServerError extends Error {
  constructor(code) {
    super(code);
    this.name = "WorkbenchServerError";
    this.code = code;
  }
}

function normalizeLimits(overrides, ceilings = WORKBENCH_SERVER_LIMITS) {
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) {
    throw new WorkbenchServerError("SERVER_LIMITS_INVALID");
  }
  const unknown = Object.keys(overrides).filter(
    (key) => !Object.hasOwn(ceilings, key),
  );
  if (unknown.length > 0) {
    throw new WorkbenchServerError("SERVER_LIMITS_INVALID");
  }
  const entries = Object.entries(ceilings).map(
    ([key, ceiling]) => {
      const supplied = Object.entries(overrides).find(
        ([candidate]) => candidate === key,
      );
      return [key, supplied?.at(1) ?? ceiling, ceiling];
    },
  );
  for (const [_key, value, ceiling] of entries) {
    if (!Number.isSafeInteger(value) || value <= 0 || value > ceiling) {
      throw new WorkbenchServerError("SERVER_LIMITS_INVALID");
    }
  }
  const limits = Object.fromEntries(
    entries.map(([key, value]) => [key, value]),
  );
  if (limits.shutdownGraceMs > limits.shutdownHardMs) {
    throw new WorkbenchServerError("SERVER_LIMITS_INVALID");
  }
  if (limits.connectionsCheckingIntervalMs >= limits.headersTimeoutMs) {
    throw new WorkbenchServerError("SERVER_LIMITS_INVALID");
  }
  return Object.freeze(limits);
}

function validatedHtmlBuffer(value, maxBytes) {
  if (!Buffer.isBuffer(value) || value.length === 0 || value.length > maxBytes) {
    throw new WorkbenchServerError("SERVER_HTML_INVALID");
  }
  return Buffer.from(value);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function digestBytes(value) {
  return Buffer.from(value, "hex");
}

function interactiveContentSecurityPolicy(scriptSha256, styleSha256, live = false) {
  const script = digestBytes(scriptSha256).toString("base64");
  const style = digestBytes(styleSha256).toString("base64");
  return [
    "base-uri 'none'",
    live ? "connect-src 'self'" : "connect-src 'none'",
    "default-src 'none'",
    "font-src 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "frame-src 'none'",
    "img-src 'none'",
    "media-src 'none'",
    "object-src 'none'",
    `script-src 'sha256-${script}'`,
    "script-src-attr 'none'",
    `style-src 'sha256-${style}'`,
    "style-src-attr 'none'",
    "worker-src 'none'",
  ].join("; ");
}

function validatedInteractivePayload(payload, maxBytes) {
  if (
    payload === null ||
    typeof payload !== "object" ||
    Array.isArray(payload) ||
    Object.keys(payload).length !== 4 ||
    !Object.hasOwn(payload, "html") ||
    !Object.hasOwn(payload, "htmlSha256") ||
    !Object.hasOwn(payload, "scriptSha256") ||
    !Object.hasOwn(payload, "styleSha256") ||
    !SHA256_HEX.test(payload.htmlSha256) ||
    !SHA256_HEX.test(payload.scriptSha256) ||
    !SHA256_HEX.test(payload.styleSha256)
  ) {
    throw new WorkbenchServerError("SERVER_INTERACTIVE_PAYLOAD_INVALID");
  }
  const html = validatedHtmlBuffer(payload.html, maxBytes);
  if (
    !timingSafeEqual(
      digestBytes(sha256(html)),
      digestBytes(payload.htmlSha256),
    )
  ) {
    throw new WorkbenchServerError("SERVER_INTERACTIVE_DIGEST_MISMATCH");
  }
  return Object.freeze({
    csp: interactiveContentSecurityPolicy(
      payload.scriptSha256,
      payload.styleSha256,
    ),
    html,
  });
}

function validatedLiveInteractivePayload(payload, maxBytes) {
  if (
    payload === null ||
    typeof payload !== "object" ||
    Array.isArray(payload) ||
    Object.keys(payload).length !== 5 ||
    !Object.hasOwn(payload, "dataSha256") ||
    !SHA256_HEX.test(payload.dataSha256)
  ) {
    throw new WorkbenchServerError("SERVER_LIVE_PAYLOAD_INVALID");
  }
  const interactive = validatedInteractivePayload({
    html: payload.html,
    htmlSha256: payload.htmlSha256,
    scriptSha256: payload.scriptSha256,
    styleSha256: payload.styleSha256,
  }, maxBytes);
  return Object.freeze({
    ...interactive,
    csp: interactiveContentSecurityPolicy(
      payload.scriptSha256,
      payload.styleSha256,
      true,
    ),
    dataSha256: payload.dataSha256,
  });
}

function singletonHeader(request, name, required = false) {
  const values = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders.at(index).toLowerCase() === name) {
      values.push(request.rawHeaders.at(index + 1));
    }
  }
  if (values.length > 1 || (required && values.length !== 1)) {
    return Object.freeze({ ok: false, value: null });
  }
  return Object.freeze({ ok: true, value: values.at(0) ?? null });
}

function exactTarget(actual, expected) {
  if (typeof actual !== "string") {
    return false;
  }
  const actualBytes = Buffer.from(actual, "utf8");
  if (actualBytes.length !== expected.length) {
    return false;
  }
  return timingSafeEqual(actualBytes, expected);
}

function requestAdmission(request, expected) {
  if (
    request.method !== "GET" ||
    request.rawHeaders.length / 2 > expected.limits.headersCount ||
    request.socket.localAddress !== LOOPBACK_HOST ||
    request.socket.remoteAddress !== LOOPBACK_HOST
  ) {
    return false;
  }

  const singletonNames = [
    "content-length",
    "host",
    "origin",
    "referer",
    "sec-fetch-dest",
    "sec-fetch-mode",
    "sec-fetch-site",
    "sec-fetch-user",
    "transfer-encoding",
  ];
  const headers = Object.fromEntries(
    singletonNames.map((name) => [
      name,
      singletonHeader(request, name, name === "host"),
    ]),
  );
  if (Object.values(headers).some((header) => !header.ok)) {
    return false;
  }
  if (
    headers.host.value !== expected.host ||
    headers["content-length"].value !== null ||
    headers["transfer-encoding"].value !== null ||
    (headers.origin.value !== null && headers.origin.value !== expected.origin) ||
    (headers.referer.value !== null && headers.referer.value !== expected.url)
  ) {
    return false;
  }

  const fetchValues = [
    headers["sec-fetch-site"].value,
    headers["sec-fetch-mode"].value,
    headers["sec-fetch-dest"].value,
  ];
  const fetchPresent = fetchValues.some((value) => value !== null);
  if (
    fetchPresent &&
    (fetchValues.some((value) => value === null) ||
      !new Set(["none", "same-origin"]).has(fetchValues.at(0)) ||
      fetchValues.at(1) !== "navigate" ||
      fetchValues.at(2) !== "document")
  ) {
    return false;
  }
  if (
    headers["sec-fetch-user"].value !== null &&
    headers["sec-fetch-user"].value !== "?1"
  ) {
    return false;
  }
  for (const purpose of ["purpose", "sec-purpose", "sec-fetch-purpose"]) {
    const header = singletonHeader(request, purpose);
    if (!header.ok || header.value !== null) {
      return false;
    }
  }
  return exactTarget(request.url, expected.target);
}

function liveStateTarget(requestUrl, expected) {
  if (typeof requestUrl !== "string") return null;
  const prefix = `/w/${expected.token}/state/`;
  if (!requestUrl.startsWith(prefix) || !requestUrl.endsWith("/")) return null;
  const parts = requestUrl.slice(prefix.length, -1).split("/");
  if (
    parts.length !== 2 ||
    !PROJECT_ID.test(parts[0]) ||
    !SHA256_HEX.test(parts[1])
  ) {
    return null;
  }
  return Object.freeze({ projectId: parts[0], dataSha256: parts[1] });
}

function liveStateAdmission(request, expected) {
  const target = liveStateTarget(request.url, expected);
  if (
    target === null ||
    request.method !== "POST" ||
    request.rawHeaders.length / 2 > expected.limits.headersCount ||
    request.socket.localAddress !== LOOPBACK_HOST ||
    request.socket.remoteAddress !== LOOPBACK_HOST
  ) {
    return null;
  }
  const singletonNames = [
    "content-length",
    "host",
    "origin",
    "referer",
    "sec-fetch-dest",
    "sec-fetch-mode",
    "sec-fetch-site",
    "sec-fetch-user",
    "transfer-encoding",
  ];
  const headers = Object.fromEntries(singletonNames.map((name) => [
    name,
    singletonHeader(request, name, name === "host"),
  ]));
  if (Object.values(headers).some((header) => !header.ok)) return null;
  if (
    headers.host.value !== expected.host ||
    !new Set([null, "0"]).has(headers["content-length"].value) ||
    headers["transfer-encoding"].value !== null ||
    headers.origin.value !== expected.origin ||
    headers.referer.value !== expected.url ||
    headers["sec-fetch-site"].value !== "same-origin" ||
    headers["sec-fetch-mode"].value !== "cors" ||
    headers["sec-fetch-dest"].value !== "empty" ||
    headers["sec-fetch-user"].value !== null
  ) {
    return null;
  }
  for (const purpose of ["purpose", "sec-purpose", "sec-fetch-purpose"]) {
    const header = singletonHeader(request, purpose);
    if (!header.ok || header.value !== null) return null;
  }
  return target;
}

function responseHeaders(
  contentType,
  bytes,
  contentSecurityPolicy = CSP,
  referrerPolicy = COMMON_HEADERS["Referrer-Policy"],
) {
  return {
    ...COMMON_HEADERS,
    "Content-Security-Policy": contentSecurityPolicy,
    Connection: "close",
    "Content-Length": String(bytes),
    "Content-Type": contentType,
    "Referrer-Policy": referrerPolicy,
  };
}

function writeResponse(
  response,
  status,
  contentType,
  body,
  contentSecurityPolicy = CSP,
  referrerPolicy = COMMON_HEADERS["Referrer-Policy"],
) {
  response.sendDate = false;
  response.writeHead(
    status,
    responseHeaders(
      contentType,
      body.length,
      contentSecurityPolicy,
      referrerPolicy,
    ),
  );
  response.end(body);
}

function rawErrorResponse(statusLine) {
  const headers = responseHeaders(
    "text/plain; charset=utf-8",
    ERROR_BODY.length,
  );
  const lines = [statusLine];
  for (const [name, value] of Object.entries(headers)) {
    lines.push(`${name}: ${value}`);
  }
  return Buffer.concat([
    Buffer.from(`${lines.join("\r\n")}\r\n\r\n`, "utf8"),
    ERROR_BODY,
  ]);
}

const RAW_BAD_REQUEST = rawErrorResponse("HTTP/1.1 400 Bad Request");
const RAW_NOT_AVAILABLE = rawErrorResponse("HTTP/1.1 404 Not Found");

function endRawSocket(socket, response) {
  if (socket.writable) {
    socket.end(response);
  } else {
    socket.destroy();
  }
}

function validAddress(address) {
  return (
    address !== null &&
    typeof address === "object" &&
    address.address === LOOPBACK_HOST &&
    new Set([4, "IPv4"]).has(address.family) &&
    Number.isSafeInteger(address.port) &&
    address.port > 0
  );
}

async function startServer(html, overrides, behavior = {}) {
  const limits = normalizeLimits(
    overrides,
    behavior.limitCeilings ?? WORKBENCH_SERVER_LIMITS,
  );
  let body = validatedHtmlBuffer(html, limits.maxHtmlBytes);
  const oneShot = behavior.oneShot === true;
  const liveRefresh = typeof behavior.refreshProject === "function";
  const contentSecurityPolicy = behavior.contentSecurityPolicy ?? CSP;
  const token = randomBytes(32).toString("base64url");
  if (token.length !== SESSION_TOKEN_CHARS) {
    throw new WorkbenchServerError("SERVER_TOKEN_INVALID");
  }

  let state = "initializing";
  let expected = null;
  let closeReason = "explicit";
  let idleTimer = null;
  let absoluteTimer = null;
  let shutdownTimer = null;
  let shutdownHardTimer = null;
  let oneShotState = oneShot ? "available" : null;
  let refreshInFlight = null;
  let refreshProjectId = null;
  let lastRefresh = null;
  const responseTimers = new Set();
  const sockets = new Set();
  const headerTimers = new Set();
  let resolveClosed;
  const closed = new Promise((resolve) => {
    resolveClosed = resolve;
  });

  function setState(next) {
    if (!LIFECYCLE_STATES.has(next)) {
      throw new WorkbenchServerError("SERVER_STATE_INVALID");
    }
    state = next;
  }

  function clearRuntimeTimers() {
    for (const timer of responseTimers) {
      clearTimeout(timer);
    }
    responseTimers.clear();
    for (const record of headerTimers) {
      clearTimeout(record.timer);
    }
    headerTimers.clear();
    for (const timer of [
      idleTimer,
      absoluteTimer,
      shutdownTimer,
      shutdownHardTimer,
    ]) {
      if (timer !== null) {
        clearTimeout(timer);
      }
    }
    idleTimer = null;
    absoluteTimer = null;
    shutdownTimer = null;
    shutdownHardTimer = null;
  }

  function finalizeClosed() {
    if (state === "closed") {
      return;
    }
    clearRuntimeTimers();
    expected = null;
    body = Buffer.alloc(0);
    setState("closed");
    resolveClosed(
      Object.freeze({
        format: "dubsar.workbench-session-closed/1",
        reason: closeReason,
      }),
    );
  }

  async function close(reason = "explicit") {
    if (state === "closed" || state === "closing") {
      return closed;
    }
    closeReason = typeof reason === "string" && reason !== "" ? reason : "explicit";
    setState("closing");
    if (idleTimer !== null) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    if (absoluteTimer !== null) {
      clearTimeout(absoluteTimer);
      absoluteTimer = null;
    }
    server.close();
    server.closeIdleConnections();
    shutdownTimer = setTimeout(() => {
      for (const socket of sockets) {
        socket.destroy();
      }
    }, limits.shutdownGraceMs);
    shutdownHardTimer = setTimeout(() => {
      for (const socket of sockets) {
        socket.destroy();
      }
      finalizeClosed();
    }, limits.shutdownHardMs);
    return closed;
  }

  function scheduleIdle() {
    if (idleTimer !== null) {
      clearTimeout(idleTimer);
    }
    idleTimer = setTimeout(() => {
      void close("idle");
    }, limits.idleMs);
  }

  function markHeadersComplete(socket) {
    const record = [...headerTimers].find(
      (candidate) => candidate.socket === socket,
    );
    if (record !== undefined) {
      clearTimeout(record.timer);
      headerTimers.delete(record);
    }
  }

  async function refreshLiveProject(projectId) {
    if (!liveRefresh) {
      throw new WorkbenchServerError("SERVER_LIVE_REFRESH_UNAVAILABLE");
    }
    if (
      lastRefresh !== null &&
      lastRefresh.projectId === projectId &&
      Date.now() - lastRefresh.completedAt < 1000
    ) {
      return lastRefresh.payload;
    }
    if (refreshInFlight !== null) {
      if (refreshProjectId !== projectId) {
        throw new WorkbenchServerError("SERVER_LIVE_REFRESH_BUSY");
      }
      return refreshInFlight;
    }
    refreshProjectId = projectId;
    refreshInFlight = Promise.resolve()
      .then(() => behavior.refreshProject(projectId))
      .then((payload) => validatedLiveInteractivePayload(payload, limits.maxHtmlBytes))
      .then((payload) => {
        lastRefresh = Object.freeze({
          completedAt: Date.now(),
          payload,
          projectId,
        });
        return payload;
      })
      .finally(() => {
        refreshInFlight = null;
        refreshProjectId = null;
      });
    return refreshInFlight;
  }

  function attachResponseDeadline(response) {
    let delivered = false;
    const deadline = setTimeout(() => {
      response.destroy();
    }, limits.responseDeadlineMs);
    responseTimers.add(deadline);
    response.once("close", () => {
      clearTimeout(deadline);
      responseTimers.delete(deadline);
      if (oneShot && !delivered && state === "ready") {
        oneShotState = "aborted";
        void close("delivery-aborted");
      }
    });
    response.once("finish", () => {
      delivered = true;
      clearTimeout(deadline);
      responseTimers.delete(deadline);
      if (oneShot && state === "ready") {
        oneShotState = "consumed";
        void close("served-once");
      } else if (state === "ready") {
        scheduleIdle();
      }
    });
  }

  async function handleLiveStateRequest(target, response) {
    scheduleIdle();
    attachResponseDeadline(response);
    try {
      const payload = await refreshLiveProject(target.projectId);
      if (state !== "ready" || response.destroyed) return;
      if (payload.dataSha256 === target.dataSha256) {
        writeResponse(response, 204, "text/plain; charset=utf-8", Buffer.alloc(0));
        return;
      }
      writeResponse(
        response,
        200,
        "text/html; charset=utf-8",
        payload.html,
        payload.csp,
      );
    } catch {
      if (state === "ready" && !response.headersSent && !response.destroyed) {
        writeResponse(response, 503, "text/plain; charset=utf-8", ERROR_BODY);
      } else if (!response.destroyed) {
        response.destroy();
      }
    }
  }

  function handleRequest(request, response) {
    try {
      markHeadersComplete(request.socket);
      const liveTarget = liveRefresh && state === "ready"
        ? liveStateAdmission(request, expected)
        : null;
      if (liveTarget !== null) {
        void handleLiveStateRequest(liveTarget, response);
        return;
      }
      if (state !== "ready" || !requestAdmission(request, expected)) {
        writeResponse(
          response,
          404,
          "text/plain; charset=utf-8",
          ERROR_BODY,
        );
        return;
      }
      if (oneShot && oneShotState !== "available") {
        writeResponse(
          response,
          404,
          "text/plain; charset=utf-8",
          ERROR_BODY,
        );
        return;
      }
      if (oneShot) {
        oneShotState = "serving";
      }
      attachResponseDeadline(response);
      writeResponse(
        response,
        200,
        "text/html; charset=utf-8",
        body,
        contentSecurityPolicy,
        liveRefresh ? "same-origin" : COMMON_HEADERS["Referrer-Policy"],
      );
    } catch {
      if (!response.headersSent) {
        writeResponse(
          response,
          404,
          "text/plain; charset=utf-8",
          ERROR_BODY,
        );
      } else {
        response.destroy();
      }
      void close("server-error");
    }
  }

  const server = createServer(
    {
      connectionsCheckingInterval: limits.connectionsCheckingIntervalMs,
      insecureHTTPParser: false,
      maxHeaderSize: limits.headerBytes,
    },
    handleRequest,
  );
  // Preserve one over-limit sentinel so requestAdmission can reject instead of
  // accepting a silently truncated header set.
  server.maxHeadersCount = limits.headersCount + 1;
  server.headersTimeout = limits.headersTimeoutMs;
  server.requestTimeout = limits.requestTimeoutMs;
  server.keepAliveTimeout = limits.keepAliveTimeoutMs;
  server.maxRequestsPerSocket = limits.maxRequestsPerSocket;
  server.maxConnections = limits.maxConnections;
  server.setTimeout(limits.socketTimeoutMs, (socket) => {
    socket.destroy();
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    const headerTimer = setTimeout(() => {
      socket.destroy();
    }, limits.headersTimeoutMs);
    headerTimers.add({ socket, timer: headerTimer });
    socket.once("close", () => {
      markHeadersComplete(socket);
      sockets.delete(socket);
    });
  });
  server.on("checkContinue", (request, response) => {
    markHeadersComplete(request.socket);
    writeResponse(response, 404, "text/plain; charset=utf-8", ERROR_BODY);
  });
  server.on("checkExpectation", (request, response) => {
    markHeadersComplete(request.socket);
    writeResponse(response, 404, "text/plain; charset=utf-8", ERROR_BODY);
  });
  server.on("connect", (_request, socket) => {
    markHeadersComplete(socket);
    endRawSocket(socket, RAW_NOT_AVAILABLE);
  });
  server.on("upgrade", (_request, socket) => {
    markHeadersComplete(socket);
    endRawSocket(socket, RAW_NOT_AVAILABLE);
  });
  server.on("clientError", (_error, socket) => {
    markHeadersComplete(socket);
    endRawSocket(socket, RAW_BAD_REQUEST);
  });
  server.on("close", finalizeClosed);

  const controller = await new Promise((resolve, reject) => {
    let ready = false;
    server.on("error", () => {
      if (!ready) {
        clearRuntimeTimers();
        setState("closed");
        resolveClosed(
          Object.freeze({
            format: "dubsar.workbench-session-closed/1",
            reason: "start-error",
          }),
        );
        reject(new WorkbenchServerError("SERVER_START_FAILED"));
      } else {
        void close("server-error");
      }
    });
    setState("listening");
    server.listen({ exclusive: true, host: "127.0.0.1", port: 0 }, () => {
      const address = server.address();
      if (!validAddress(address)) {
        void close("address-invalid");
        reject(new WorkbenchServerError("SERVER_ADDRESS_INVALID"));
        return;
      }
      const origin = `http://${LOOPBACK_HOST}:${address.port}`;
      const url = `${origin}/w/${token}/`;
      expected = Object.freeze({
        host: `${LOOPBACK_HOST}:${address.port}`,
        limits,
        origin,
        token,
        target: Buffer.from(`/w/${token}/`, "utf8"),
        url,
      });
      ready = true;
      setState("ready");
      scheduleIdle();
      absoluteTimer = setTimeout(() => {
        void close("absolute-lifetime");
      }, limits.absoluteLifetimeMs);
      resolve(
        Object.freeze({
          address: Object.freeze({
            host: LOOPBACK_HOST,
            port: address.port,
          }),
          close,
          closed,
          get state() {
            return state;
          },
          url,
        }),
      );
    });
  });
  return controller;
}

export function startWorkbenchServer(html) {
  return startServer(html, WORKBENCH_SERVER_LIMITS);
}

export function startWorkbenchServerForTest(html, overrides = {}) {
  return startServer(html, overrides);
}

export function startOneShotInteractiveWorkbenchServer(payload) {
  const validated = validatedInteractivePayload(
    payload,
    ONE_SHOT_LIMITS.maxHtmlBytes,
  );
  return startServer(validated.html, ONE_SHOT_LIMITS, {
    contentSecurityPolicy: validated.csp,
    oneShot: true,
  });
}

export function startOneShotInteractiveWorkbenchServerForTest(
  payload,
  overrides = {},
) {
  const limits = normalizeLimits(overrides);
  const validated = validatedInteractivePayload(payload, limits.maxHtmlBytes);
  return startServer(validated.html, limits, {
    contentSecurityPolicy: validated.csp,
    oneShot: true,
  });
}

export function startLiveInteractiveWorkbenchServer(payload, refreshProject) {
  if (typeof refreshProject !== "function") {
    throw new WorkbenchServerError("SERVER_LIVE_REFRESH_INVALID");
  }
  const validated = validatedLiveInteractivePayload(
    payload,
    LIVE_SESSION_LIMITS.maxHtmlBytes,
  );
  return startServer(validated.html, LIVE_SESSION_LIMITS, {
    contentSecurityPolicy: validated.csp,
    limitCeilings: LIVE_SESSION_LIMITS,
    refreshProject,
  });
}

export function startLiveInteractiveWorkbenchServerForTest(
  payload,
  refreshProject,
  overrides = {},
) {
  if (typeof refreshProject !== "function") {
    throw new WorkbenchServerError("SERVER_LIVE_REFRESH_INVALID");
  }
  const limits = normalizeLimits(overrides, LIVE_SESSION_LIMITS);
  const validated = validatedLiveInteractivePayload(payload, limits.maxHtmlBytes);
  return startServer(validated.html, limits, {
    contentSecurityPolicy: validated.csp,
    limitCeilings: LIVE_SESSION_LIMITS,
    refreshProject,
  });
}
