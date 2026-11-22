/**
 * Discord Unblocked — Cloudflare Worker
 *
 * Two jobs:
 *   1. Serve the proxy shell (./public) as static assets.
 *   2. Act as a TompHTTP Bare v3 server at /bare/v3/.
 *
 * The browser runs Ultraviolet in a service worker. Every request a proxied
 * page makes is handed to the Bare transport (bare-as-module3), which POSTs it
 * here with `x-bare-url` / `x-bare-headers`. We replay it upstream with fetch()
 * and stream the result back. WebSockets (Discord's gateway) are tunnelled the
 * same way using the Bare WebSocket handshake, so no raw TCP is needed.
 */

const BARE_PREFIX = "/bare";
const MAX_HEADER_VALUE = 3072;
const HANDSHAKE_TIMEOUT_MS = 15_000;

/** Hop-by-hop / handshake headers we must not replay upstream. */
const DROPPED_HEADERS = new Set([
  "host",
  "connection",
  "upgrade",
  "keep-alive",
  "proxy-connection",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "content-length",
  "accept-encoding",
  "sec-websocket-key",
  "sec-websocket-version",
  "sec-websocket-extensions",
  "sec-websocket-accept",
  "x-bare-url",
  "x-bare-headers",
  "x-bare-forward-headers",
  "x-bare-pass-headers",
  "x-bare-pass-status",
]);

const STATUS_TEXT = {
  200: "OK",
  201: "Created",
  202: "Accepted",
  204: "No Content",
  206: "Partial Content",
  301: "Moved Permanently",
  302: "Found",
  303: "See Other",
  304: "Not Modified",
  307: "Temporary Redirect",
  308: "Permanent Redirect",
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  408: "Request Timeout",
  409: "Conflict",
  410: "Gone",
  413: "Payload Too Large",
  415: "Unsupported Media Type",
  422: "Unprocessable Entity",
  425: "Too Early",
  429: "Too Many Requests",
  500: "Internal Server Error",
  501: "Not Implemented",
  502: "Bad Gateway",
  503: "Service Unavailable",
  504: "Gateway Timeout",
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === BARE_PREFIX || url.pathname.startsWith(BARE_PREFIX + "/")) {
      const upgrade = request.headers.get("Upgrade");
      if (upgrade && upgrade.toLowerCase() === "websocket") {
        return bareWebSocket(request);
      }
      return bareHttp(request);
    }

    return env.ASSETS.fetch(request);
  },
};

/* -------------------------------------------------------------------------- */
/* Bare v3: plain HTTP requests                                               */
/* -------------------------------------------------------------------------- */

async function bareHttp(request) {
  let headers;
  try {
    headers = joinBareHeaders(new Headers(request.headers));
  } catch (error) {
    return bareError(400, "INVALID_BARE_HEADER", String(error?.message ?? error));
  }

  const target = headers.get("x-bare-url");
  if (!target) return bareError(400, "MISSING_BARE_HEADER", "x-bare-url is required");

  let remote;
  try {
    remote = new URL(target);
  } catch {
    return bareError(400, "INVALID_BARE_HEADER", "x-bare-url is not a valid URL");
  }
  if (remote.protocol !== "http:" && remote.protocol !== "https:") {
    return bareError(400, "INVALID_BARE_HEADER", "x-bare-url must be http(s)");
  }

  let clientHeaders;
  try {
    clientHeaders = JSON.parse(headers.get("x-bare-headers") ?? "{}");
  } catch {
    return bareError(400, "INVALID_BARE_HEADER", "x-bare-headers is not valid JSON");
  }

  // Headers the page asked for. Key capitalisation is preserved on purpose:
  // some sites (Discord included) sniff for browser-style capitalisation.
  const outgoing = new Headers();
  for (const [name, value] of Object.entries(clientHeaders ?? {})) {
    if (DROPPED_HEADERS.has(name.toLowerCase())) continue;
    for (const single of Array.isArray(value) ? value : [value]) {
      try {
        outgoing.append(name, String(single));
      } catch {
        // ignore headers the runtime refuses to encode
      }
    }
  }

  // Optional: headers the browser cannot read itself (Accept-Language, ...).
  for (const name of splitList(headers.get("x-bare-forward-headers"))) {
    const lower = name.toLowerCase();
    if (DROPPED_HEADERS.has(lower)) continue;
    const value = request.headers.get(name);
    if (value !== null) {
      try {
        outgoing.set(name, value);
      } catch {}
    }
  }

  const method = request.method.toUpperCase();
  const init = { method, headers: outgoing, redirect: "manual" };
  if (method !== "GET" && method !== "HEAD" && request.body) {
    init.body = request.body;
    init.duplex = "half";
  }

  let upstream;
  try {
    upstream = await fetch(remote.href, init);
  } catch (error) {
    return bareError(502, "FETCH_FAILED", String(error?.message ?? error));
  }

  const passStatus = splitList(headers.get("x-bare-pass-status")).map(Number);
  const responseHeaders = new Headers();
  responseHeaders.set("x-bare-status", String(upstream.status));
  responseHeaders.set(
    "x-bare-status-text",
    STATUS_TEXT[upstream.status] ?? sanitizeHeaderValue(upstream.statusText),
  );
  responseHeaders.set("x-bare-headers", safeJson(serializeHeaders(upstream.headers)));
  splitBareHeaders(responseHeaders);
  responseHeaders.set("content-type", "application/octet-stream");
  responseHeaders.set("cache-control", "no-store");
  responseHeaders.set("access-control-allow-origin", "*");

  // The Bare client only accepts 2xx wrapper responses and reads the real
  // status from x-bare-status. x-bare-pass-status lets the client see it.
  const status = passStatus.includes(upstream.status) ? upstream.status : 200;

  return new Response(upstream.body, { status, headers: responseHeaders });
}

function serializeHeaders(headers) {
  const output = {};
  for (const [name, value] of headers) {
    if (name.toLowerCase() === "set-cookie") continue;
    output[name] = value;
  }
  const cookies = typeof headers.getSetCookie === "function" ? headers.getSetCookie() : [];
  if (cookies.length > 0) output["set-cookie"] = cookies;
  return output;
}

/* -------------------------------------------------------------------------- */
/* Bare v3: WebSocket tunnel (Discord gateway)                                */
/* -------------------------------------------------------------------------- */

function bareWebSocket() {
  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair);
  server.accept();

  let upstream = null;
  let connected = false;
  let closed = false;

  const shutdown = (code = 1000, reason = "") => {
    if (closed) return;
    closed = true;
    clearTimeout(handshakeTimer);
    try {
      server.close(code, reason);
    } catch {}
    try {
      upstream?.close(code, reason);
    } catch {}
  };

  const handshakeTimer = setTimeout(() => {
    if (!connected) shutdown(1011, "bare handshake timeout");
  }, HANDSHAKE_TIMEOUT_MS);

  server.addEventListener("close", () => shutdown(1000, "client closed"));
  server.addEventListener("error", () => shutdown(1011, "client error"));

  server.addEventListener("message", async (event) => {
    // After the handshake, every frame is raw tunnel traffic.
    if (connected) {
      try {
        upstream?.send(event.data);
      } catch {
        shutdown(1011, "upstream write failed");
      }
      return;
    }

    connected = true;
    clearTimeout(handshakeTimer);

    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return shutdown(1011, "invalid handshake");
    }
    if (!message || message.type !== "connect") {
      return shutdown(1011, "invalid handshake");
    }

    let remote;
    try {
      remote = new URL(message.remote);
    } catch {
      return shutdown(1011, "invalid remote");
    }
    if (remote.protocol !== "ws:" && remote.protocol !== "wss:") {
      return shutdown(1011, "invalid remote");
    }
    // fetch() speaks http(s); Workers upgrades these when Upgrade is present.
    remote.protocol = remote.protocol === "wss:" ? "https:" : "http:";

    const outgoing = new Headers({ Upgrade: "websocket" });
    for (const [name, value] of Object.entries(message.headers ?? {})) {
      if (DROPPED_HEADERS.has(name.toLowerCase())) continue;
      for (const single of Array.isArray(value) ? value : [value]) {
        try {
          outgoing.set(name, String(single));
        } catch {}
      }
    }
    const protocols = Array.isArray(message.protocols)
      ? message.protocols.filter((p) => typeof p === "string" && p.length > 0)
      : [];
    if (protocols.length > 0) outgoing.set("Sec-WebSocket-Protocol", protocols.join(", "));

    let response;
    try {
      response = await fetch(remote.href, { headers: outgoing });
    } catch {
      return shutdown(1011, "connect failed");
    }

    const socket = response.webSocket;
    if (!socket) return shutdown(1011, "upstream refused the websocket");

    upstream = socket;
    try {
      socket.accept();
    } catch {
      return shutdown(1011, "accept failed");
    }

    socket.addEventListener("message", (event) => {
      try {
        server.send(event.data);
      } catch {}
    });
    socket.addEventListener("close", () => shutdown(1000, "upstream closed"));
    socket.addEventListener("error", () => shutdown(1011, "upstream error"));

    try {
      server.send(JSON.stringify({ type: "open", protocol: "", setCookies: [] }));
    } catch {
      shutdown(1011, "handshake write failed");
    }
  });

  return new Response(null, { status: 101, webSocket: client });
}

/* -------------------------------------------------------------------------- */
/* Bare header helpers                                                        */
/* -------------------------------------------------------------------------- */

/** Large header payloads are split into `x-bare-headers-<n>: ;<chunk>` parts. */
function splitBareHeaders(headers) {
  const value = headers.get("x-bare-headers");
  if (!value || value.length <= MAX_HEADER_VALUE) return;
  headers.delete("x-bare-headers");
  let index = 0;
  for (let offset = 0; offset < value.length; offset += MAX_HEADER_VALUE) {
    headers.set(`x-bare-headers-${index++}`, ";" + value.slice(offset, offset + MAX_HEADER_VALUE));
  }
}

function joinBareHeaders(headers) {
  const prefix = "x-bare-headers";
  if (!headers.has(`${prefix}-0`)) return headers;

  const parts = [];
  for (const [name, value] of [...headers]) {
    if (!name.startsWith(`${prefix}-`)) continue;
    const index = Number(name.slice(prefix.length + 1));
    if (!Number.isInteger(index)) continue;
    parts[index] = value.startsWith(";") ? value.slice(1) : value;
    headers.delete(name);
  }
  headers.set(prefix, parts.join(""));
  return headers;
}

function splitList(value) {
  if (!value) return [];
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

/** JSON with non-ASCII escaped, so it always survives a header value. */
function safeJson(value) {
  return JSON.stringify(value).replace(
    /[\u007f-\uffff]/g,
    (char) => "\\u" + char.charCodeAt(0).toString(16).padStart(4, "0"),
  );
}

function sanitizeHeaderValue(value = "") {
  return String(value).replace(/[^\t\x20-\x7e]/g, "");
}

function bareError(status, code, message) {
  return new Response(safeJson({ code, id: `error.${code.toLowerCase()}`, message }), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
    },
  });
}
