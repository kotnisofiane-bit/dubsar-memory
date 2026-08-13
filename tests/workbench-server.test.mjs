import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { request } from "node:http";
import { connect } from "node:net";
import test from "node:test";
import {
  WORKBENCH_SERVER_LIMITS,
  WorkbenchServerError,
  startOneShotInteractiveWorkbenchServer,
  startWorkbenchServer,
} from "../packages/dubsar-workbench-server/src/index.mjs";
import {
  startLiveInteractiveWorkbenchServerForTest,
  startOneShotInteractiveWorkbenchServerForTest,
  startWorkbenchServerForTest,
} from "../packages/dubsar-workbench-server/src/server.mjs";

const HTML = Buffer.from(
  "<!doctype html><html><head><title>DUBSAR</title></head><body>ready</body></html>\n",
  "utf8",
);
const SECURITY_HEADERS = Object.freeze({
  "cache-control": "no-store, max-age=0",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
});

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function interactiveFixture() {
  const style = "body{color:#fff;background:#0b0f19}";
  const script = "document.documentElement.dataset.runtime='ready';";
  const html = Buffer.from(
    `<!doctype html><html><head><style>${style}</style></head><body>DUBSAR<script>${script}</script></body></html>`,
    "utf8",
  );
  return Object.freeze({
    html,
    htmlSha256: digest(html),
    scriptSha256: digest(Buffer.from(script, "utf8")),
    styleSha256: digest(Buffer.from(style, "utf8")),
  });
}

function liveFixture() {
  return Object.freeze({
    ...interactiveFixture(),
    dataSha256: digest(Buffer.from("initial", "utf8")),
  });
}

async function httpCall(url, options = {}) {
  return new Promise((resolve, reject) => {
    const call = request(url, options, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        resolve({
          body: Buffer.concat(chunks),
          headers: response.headers,
          rawHeaders: response.rawHeaders,
          status: response.statusCode,
        });
      });
    });
    call.on("error", reject);
    if (options.body !== undefined) {
      call.write(options.body);
    }
    call.end();
  });
}

async function rawCall(port, source) {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port });
    const chunks = [];
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error("RAW_CALL_TIMEOUT"));
    }, 2000);
    socket.on("connect", () => socket.write(source));
    socket.on("data", (chunk) => chunks.push(chunk));
    socket.on("error", reject);
    socket.on("close", () => {
      clearTimeout(timeout);
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
  });
}

function assertSecurityHeaders(headers) {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    assert.equal(headers[name], value, name);
  }
  assert.match(headers["content-security-policy"], /default-src 'none'/u);
  assert.match(headers["content-security-policy"], /frame-ancestors 'none'/u);
  assert.match(headers["content-security-policy"], /script-src 'none'/u);
  assert.match(headers["permissions-policy"], /camera=\(\)/u);
  assert.equal(headers["access-control-allow-origin"], undefined);
  assert.equal(headers.date, undefined);
}

test("live session keeps navigation strict and refreshes one project through a separate same-origin route", async (t) => {
  const initial = liveFixture();
  const updated = Object.freeze({
    ...interactiveFixture(),
    dataSha256: digest(Buffer.from("updated", "utf8")),
  });
  let refreshes = 0;
  const server = await startLiveInteractiveWorkbenchServerForTest(
    initial,
    async (projectId) => {
      if (projectId === "broken-project") throw new Error("synthetic refresh failure");
      assert.equal(projectId, "project-1");
      refreshes += 1;
      return updated;
    },
    { absoluteLifetimeMs: 2000, idleMs: 1000 },
  );
  t.after(() => server.close("test-cleanup"));
  const documentResponse = await httpCall(server.url, {
    headers: {
      "Sec-Fetch-Dest": "document",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Site": "none",
      "Sec-Fetch-User": "?1",
    },
  });
  assert.equal(documentResponse.status, 200);
  assert.match(documentResponse.headers["content-security-policy"], /connect-src 'self'/u);
  assert.equal(documentResponse.headers["referrer-policy"], "same-origin");

  const origin = new URL(server.url).origin;
  const stateUrl = `${server.url}state/project-1/${"0".repeat(64)}/`;
  const headers = {
    Origin: origin,
    Referer: server.url,
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
  };
  const changed = await httpCall(stateUrl, { method: "POST", headers });
  assert.equal(changed.status, 200);
  assert.deepEqual(changed.body, updated.html);
  assert.equal(refreshes, 1);

  const unchanged = await httpCall(
    `${server.url}state/project-1/${updated.dataSha256}/`,
    { method: "POST", headers },
  );
  assert.equal(unchanged.status, 204);
  assert.equal(refreshes, 1);

  const wrongReferer = await httpCall(stateUrl, {
    method: "POST",
    headers: { ...headers, Referer: "https://evil.invalid/" },
  });
  assert.equal(wrongReferer.status, 404);

  const { Origin: _origin, ...withoutOrigin } = headers;
  const missingOrigin = await httpCall(stateUrl, {
    method: "POST",
    headers: withoutOrigin,
  });
  assert.equal(missingOrigin.status, 404);
  assert.equal(refreshes, 1);

  const failed = await httpCall(
    `${server.url}state/broken-project/${"0".repeat(64)}/`,
    { method: "POST", headers },
  );
  assert.equal(failed.status, 503);
  assert.equal(failed.body.toString("utf8"), "Not available.\n");
  assert.equal(server.state, "ready");
});

test("server exposes exact immutable HTML on one IPv4 capability route", async (t) => {
  const server = await startWorkbenchServer(HTML);
  t.after(() => server.close("test-cleanup"));
  assert.equal(server.address.host, "127.0.0.1");
  assert.ok(server.address.port > 0);
  assert.match(
    server.url,
    /^http:\/\/127\.0\.0\.1:\d+\/w\/[A-Za-z0-9_-]{43}\/$/u,
  );
  assert.equal(server.state, "ready");

  const response = await httpCall(server.url, {
    headers: {
      "Sec-Fetch-Dest": "document",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Site": "none",
      "Sec-Fetch-User": "?1",
    },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, HTML);
  assert.equal(response.headers["content-type"], "text/html; charset=utf-8");
  assert.equal(response.headers["content-length"], String(HTML.length));
  assert.equal(response.headers.connection, "close");
  assertSecurityHeaders(response.headers);
});

test("one-shot interactive server serves one exact CSP-bound report then closes", async () => {
  const payload = interactiveFixture();
  const server = await startOneShotInteractiveWorkbenchServer(payload);
  const response = await httpCall(server.url, {
    headers: {
      "Sec-Fetch-Dest": "document",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Site": "none",
      "Sec-Fetch-User": "?1",
    },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, payload.html);
  const csp = response.headers["content-security-policy"];
  assert.match(csp, /script-src 'sha256-[A-Za-z0-9+/]{43}='/u);
  assert.match(csp, /style-src 'sha256-[A-Za-z0-9+/]{43}='/u);
  assert.match(csp, /script-src-attr 'none'/u);
  assert.match(csp, /frame-ancestors 'none'/u);
  assert.equal((await server.closed).reason, "served-once");
  assert.equal(server.state, "closed");
});

test("one-shot interactive server admits at most one concurrent consumer", async () => {
  const server = await startOneShotInteractiveWorkbenchServer(interactiveFixture());
  const results = await Promise.allSettled([
    httpCall(server.url),
    httpCall(server.url),
  ]);
  const responses = results
    .filter((result) => result.status === "fulfilled")
    .map((result) => result.value);
  assert.equal(responses.filter((response) => response.status === 200).length, 1);
  assert.equal((await server.closed).reason, "served-once");
});

test("one-shot interactive server rejects altered HTML and open payloads", async () => {
  const payload = interactiveFixture();
  assert.throws(
    () => startOneShotInteractiveWorkbenchServer({
      ...payload,
      html: Buffer.from(`${payload.html.toString("utf8")}x`, "utf8"),
    }),
    (error) =>
      error instanceof WorkbenchServerError &&
      error.code === "SERVER_INTERACTIVE_DIGEST_MISMATCH",
  );
  assert.throws(
    () => startOneShotInteractiveWorkbenchServer({ ...payload, extra: true }),
    (error) =>
      error instanceof WorkbenchServerError &&
      error.code === "SERVER_INTERACTIVE_PAYLOAD_INVALID",
  );
});

test("one-shot interactive server closes when Chrome never requests the report", async () => {
  const server = await startOneShotInteractiveWorkbenchServerForTest(
    interactiveFixture(),
    { absoluteLifetimeMs: 500, idleMs: 60 },
  );
  assert.equal((await server.closed).reason, "idle");
  assert.equal(server.state, "closed");
});

test("server copies its input and rejects invalid or oversized buffers", async (t) => {
  const mutable = Buffer.from(HTML);
  const server = await startWorkbenchServer(mutable);
  t.after(() => server.close("test-cleanup"));
  mutable.fill(0);
  const response = await httpCall(server.url);
  assert.deepEqual(response.body, HTML);

  await assert.rejects(
    () => startWorkbenchServer("not-a-buffer"),
    (error) =>
      error instanceof WorkbenchServerError && error.code === "SERVER_HTML_INVALID",
  );
  await assert.rejects(
    () =>
      startWorkbenchServer(
        Buffer.alloc(WORKBENCH_SERVER_LIMITS.maxHtmlBytes + 1),
      ),
    (error) =>
      error instanceof WorkbenchServerError && error.code === "SERVER_HTML_INVALID",
  );
});

test("Host, Origin, Referer and Fetch Metadata fail closed", async (t) => {
  const server = await startWorkbenchServer(HTML);
  t.after(() => server.close("test-cleanup"));
  const url = new URL(server.url);
  const cases = [
    { headers: { Host: `localhost:${url.port}` } },
    { headers: { Host: `127.0.0.1:${Number(url.port) + 1}` } },
    { headers: { Origin: "https://evil.invalid" } },
    { headers: { Origin: "null" } },
    { headers: { Referer: "https://evil.invalid/" } },
    { headers: { "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document" } },
    { headers: { "Sec-Fetch-Site": "same-site", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document" } },
    { headers: { "Sec-Fetch-Site": "none" } },
    { headers: { Purpose: "prefetch" } },
  ];
  for (const options of cases) {
    const response = await httpCall(server.url, options);
    assert.equal(response.status, 404, JSON.stringify(options));
    assert.equal(response.body.toString("utf8"), "Not available.\n");
    assertSecurityHeaders(response.headers);
  }

  const origin = `${url.protocol}//${url.host}`;
  const allowed = await httpCall(server.url, {
    headers: {
      Origin: origin,
      Referer: server.url,
      "Sec-Fetch-Dest": "document",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Site": "same-origin",
    },
  });
  assert.equal(allowed.status, 200);
});

test("methods, bodies, traversal, encoding, query and cross-instance tokens are rejected", async (t) => {
  const first = await startWorkbenchServer(HTML);
  const second = await startWorkbenchServer(HTML);
  t.after(async () => {
    await Promise.all([first.close("test-cleanup"), second.close("test-cleanup")]);
  });
  const firstUrl = new URL(first.url);
  const secondUrl = new URL(second.url);
  const origin = `${firstUrl.protocol}//${firstUrl.host}`;
  const paths = [
    "/",
    "/favicon.ico",
    "/w/../",
    "/w/%2e%2e/",
    "/w/%252e%252e/",
    "/w/%2f/",
    "/w/%5c/",
    `${firstUrl.pathname}?refresh=1`,
    `${firstUrl.pathname}/`,
    firstUrl.pathname.replace("/w/", "//w/"),
    secondUrl.pathname,
  ];
  for (const target of paths) {
    const response = await httpCall(`${origin}${target}`);
    assert.equal(response.status, 404, target);
    assert.equal(response.body.includes(Buffer.from(firstUrl.pathname)), false);
    assertSecurityHeaders(response.headers);
  }
  for (const method of ["HEAD", "OPTIONS", "POST", "PUT", "DELETE", "TRACE"]) {
    const response = await httpCall(first.url, { method });
    assert.equal(response.status, 404, method);
  }
  const withBody = await httpCall(first.url, {
    body: "x",
    headers: { "Content-Length": "1" },
    method: "GET",
  });
  assert.equal(withBody.status, 404);
});

test("duplicate Host, CONNECT, upgrade and oversized headers receive bounded closed responses", async (t) => {
  const server = await startWorkbenchServer(HTML);
  t.after(() => server.close("test-cleanup"));
  const path = new URL(server.url).pathname;
  const host = `127.0.0.1:${server.address.port}`;

  const duplicate = await rawCall(
    server.address.port,
    `GET ${path} HTTP/1.1\r\nHost: ${host}\r\nHost: evil.invalid\r\nConnection: close\r\n\r\n`,
  );
  assert.match(duplicate, /^HTTP\/1\.1 (?:400|404)/u);
  assert.match(duplicate, /Content-Security-Policy:/u);
  assert.equal(duplicate.includes(path), false);

  const missingHost = await rawCall(
    server.address.port,
    `GET ${path} HTTP/1.1\r\nConnection: close\r\n\r\n`,
  );
  assert.match(missingHost, /^HTTP\/1\.1 (?:400|404)/u);

  const duplicateOrigin = await rawCall(
    server.address.port,
    `GET ${path} HTTP/1.1\r\nHost: ${host}\r\nOrigin: http://${host}\r\nOrigin: https://evil.invalid\r\nConnection: close\r\n\r\n`,
  );
  assert.match(duplicateOrigin, /^HTTP\/1\.1 404/u);

  const absoluteForm = await rawCall(
    server.address.port,
    `GET http://${host}${path} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`,
  );
  assert.match(absoluteForm, /^HTTP\/1\.1 404/u);

  const connectResponse = await rawCall(
    server.address.port,
    `CONNECT ${host} HTTP/1.1\r\nHost: ${host}\r\n\r\n`,
  );
  assert.match(connectResponse, /^HTTP\/1\.1 404/u);
  assert.match(connectResponse, /X-Frame-Options: DENY/u);

  const upgrade = await rawCall(
    server.address.port,
    `GET ${path} HTTP/1.1\r\nHost: ${host}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`,
  );
  assert.match(upgrade, /^HTTP\/1\.1 404/u);

  const oversized = await rawCall(
    server.address.port,
    `GET ${path} HTTP/1.1\r\nHost: ${host}\r\nX-Fill: ${"x".repeat(9000)}\r\n\r\n`,
  );
  assert.match(oversized, /^HTTP\/1\.1 400/u);
  assert.match(oversized, /Cache-Control: no-store/u);

  const smuggled = await rawCall(
    server.address.port,
    `GET ${path} HTTP/1.1\r\nHost: ${host}\r\nContent-Length: 1\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n`,
  );
  assert.match(smuggled, /^HTTP\/1\.1 400/u);

  const manyHeaders = Array.from(
    { length: 33 },
    (_value, index) => `X-${index}: value`,
  ).join("\r\n");
  const tooMany = await rawCall(
    server.address.port,
    `GET ${path} HTTP/1.1\r\nHost: ${host}\r\n${manyHeaders}\r\n\r\n`,
  );
  assert.match(tooMany, /^HTTP\/1\.1 (?:400|404)/u);

  const unicodeTarget = await rawCall(
    server.address.port,
    `GET /w/${"é".repeat(43)}/ HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`,
  );
  assert.match(unicodeTarget, /^HTTP\/1\.1 (?:400|404)/u);
  assert.equal((await httpCall(server.url)).status, 200);
});

test("slow partial requests and active sockets are forcibly bounded", async () => {
  const server = await startWorkbenchServerForTest(HTML, {
    connectionsCheckingIntervalMs: 20,
    headersTimeoutMs: 80,
    requestTimeoutMs: 80,
    shutdownGraceMs: 50,
    shutdownHardMs: 150,
    socketTimeoutMs: 80,
  });
  const socket = connect(server.address);
  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  const trickle = "GET / HTTP/1.1\r\nHost: 127.0.0.1";
  let offset = 0;
  const interval = setInterval(() => {
    if (offset < trickle.length && socket.writable) {
      socket.write(trickle.at(offset));
      offset += 1;
    }
  }, 30);
  const socketClosed = new Promise((resolve) => socket.once("close", resolve));
  const started = Date.now();
  await socketClosed;
  clearInterval(interval);
  assert.ok(Date.now() - started < 500);
  assert.equal(server.state, "ready");

  const active = connect(server.address);
  await new Promise((resolve, reject) => {
    active.once("connect", resolve);
    active.once("error", reject);
  });
  active.write("GET /");
  const activeClosed = new Promise((resolve) => active.once("close", resolve));
  const closeStarted = Date.now();
  await server.close("test-forced");
  await activeClosed;
  assert.ok(Date.now() - closeStarted < 1000);
  assert.equal(server.state, "closed");
  assert.equal((await server.closed).reason, "test-forced");
});

test("idle and absolute lifetime use independent non-persistent shutdown paths", async () => {
  const idle = await startWorkbenchServerForTest(HTML, {
    absoluteLifetimeMs: 500,
    idleMs: 60,
  });
  assert.equal((await idle.closed).reason, "idle");
  assert.equal(idle.state, "closed");

  const absolute = await startWorkbenchServerForTest(HTML, {
    absoluteLifetimeMs: 60,
    idleMs: 500,
  });
  assert.equal((await absolute.closed).reason, "absolute-lifetime");
  assert.equal(absolute.state, "closed");
});

test("rejected traffic does not extend idle lifetime", async () => {
  const server = await startWorkbenchServerForTest(HTML, {
    absoluteLifetimeMs: 1000,
    idleMs: 200,
  });
  const started = Date.now();
  await new Promise((resolve) => setTimeout(resolve, 140));
  const url = new URL(server.url);
  const rejected = await httpCall(server.url, {
    headers: { Host: `localhost:${url.port}` },
  });
  assert.equal(rejected.status, 404);
  assert.equal((await server.closed).reason, "idle");
  assert.ok(Date.now() - started < 300);
});

test("twenty concurrent instances have unique ports and tokens and close independently", async () => {
  const servers = await Promise.all(
    Array.from({ length: 20 }, () => startWorkbenchServer(HTML)),
  );
  try {
    assert.equal(new Set(servers.map((server) => server.url)).size, 20);
    assert.equal(
      new Set(servers.map((server) => server.address.port)).size,
      20,
    );
    await servers.at(0).close("one-instance");
    assert.equal(servers.at(0).state, "closed");
    const response = await httpCall(servers.at(1).url);
    assert.equal(response.status, 200);
    assert.equal(servers.at(1).state, "ready");
  } finally {
    await Promise.all(servers.map((server) => server.close("test-cleanup")));
  }
});

test("the thirty-third concurrent connection is dropped without widening the cap", async () => {
  const server = await startWorkbenchServerForTest(HTML, {
    connectionsCheckingIntervalMs: 50,
    headersTimeoutMs: 1000,
    requestTimeoutMs: 1000,
    shutdownGraceMs: 50,
    shutdownHardMs: 150,
    socketTimeoutMs: 1000,
  });
  const sockets = await Promise.all(
    Array.from(
      { length: 32 },
      () =>
        new Promise((resolve, reject) => {
          const socket = connect(server.address);
          socket.once("connect", () => resolve(socket));
          socket.once("error", reject);
        }),
    ),
  );
  for (const socket of sockets) {
    socket.on("error", () => {});
  }
  const overflow = connect(server.address);
  const started = Date.now();
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      overflow.destroy();
      reject(new Error("CONNECTION_CAP_TIMEOUT"));
    }, 1000);
    const done = () => {
      clearTimeout(timeout);
      resolve();
    };
    overflow.once("close", done);
    overflow.once("error", done);
  });
  assert.ok(Date.now() - started < 500);
  await server.close("connection-cap-test");
  for (const socket of sockets) {
    socket.destroy();
  }
});

test("repeated start and close cycles release every listener", async () => {
  for (let cycle = 0; cycle < 50; cycle += 1) {
    const server = await startWorkbenchServer(HTML);
    await server.close("cycle-test");
    assert.equal(server.state, "closed");
  }
});

test("close is idempotent and invalidates the listener", async () => {
  const server = await startWorkbenchServer(HTML);
  const first = server.close("explicit-test");
  const second = server.close("ignored-second-reason");
  assert.deepEqual(await first, await second);
  assert.equal((await server.closed).reason, "explicit-test");
  assert.equal(server.state, "closed");
  await assert.rejects(() => httpCall(server.url));
});
