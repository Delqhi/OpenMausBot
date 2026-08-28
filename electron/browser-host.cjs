// The loopback door into the browser surface for the bot's own process.
//
// A bot's tools run inside its agent CLI, which the harness spawned — two
// processes away from the Electron main process that owns the views. The
// harness already talks to Electron-owned things through a descriptor file
// (cua-connection.json): Electron writes where to connect and a per-boot
// secret, the server reads it and hands the two values to the proxy. This
// host is that door for the browser: bound to 127.0.0.1 on an ephemeral
// port, bearer-token gated, JSON in / JSON out, one route per verb.
//
// It exposes only the surface's verbs — never the app window, never the
// renderer, never a debugging port on OpenMausBot itself.
"use strict";

const http = require("node:http");
const { randomBytes } = require("node:crypto");

const MAX_BODY_BYTES = 64 * 1024;
const OPERATIONS = new Set(["state", "navigate", "back", "snapshot", "click", "fill", "type", "press", "scroll", "screenshot"]);
const BOT_ROUTE = /^\/v1\/bots\/([A-Za-z0-9_-]{1,120})\/([a-z]+)$/;

function isLoopback(address) {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      raw += chunk;
    });
    req.on("end", () => {
      if (!raw.trim()) return resolve({});
      try {
        const parsed = JSON.parse(raw);
        resolve(parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {});
      } catch {
        reject(new Error("invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
  res.end(payload);
}

/** Map a verb + body onto the manager; the body's field names are the tool
 * argument names the proxy uses, kept in one place here. */
async function perform(manager, botId, operation, body) {
  switch (operation) {
    case "state":
      return manager.state(botId);
    case "navigate":
      return manager.navigate(botId, body.url);
    case "back":
      return manager.back(botId);
    case "snapshot":
      return manager.snapshot(botId);
    case "click":
      return manager.click(botId, body.ref, { button: body.button, clickCount: body.double === true ? 2 : 1 });
    case "fill":
      return manager.fill(botId, body.ref, body.text);
    case "type":
      return manager.type(botId, body.text);
    case "press":
      return manager.press(botId, body.key);
    case "scroll":
      return manager.scroll(botId, body.direction, body.amount);
    case "screenshot":
      return manager.screenshot(botId);
    default:
      throw new Error(`unknown browser operation: ${operation}`);
  }
}

/**
 * @param {object} options
 * @param {ReturnType<import("./browser-surface.cjs").createBrowserSurfaceManager>} options.manager
 * @param {string} [options.token] 64 hex chars; generated per boot when absent
 */
function createBrowserHost({ manager, token = randomBytes(32).toString("hex") }) {
  if (!manager) throw new Error("The browser surface manager is required");
  if (!/^[0-9a-f]{64}$/.test(token)) throw new Error("The browser host token must be 64 hex characters");
  let server = null;
  let url = null;

  const handle = async (req, res) => {
    if (!isLoopback(req.socket.remoteAddress)) return json(res, 403, { error: "loopback only" });
    const authorization = String(req.headers.authorization ?? "");
    if (authorization !== `Bearer ${token}`) return json(res, 401, { error: "unauthorized" });
    const path = String(req.url ?? "").split("?")[0];
    if (req.method === "GET" && path === "/v1/health") return json(res, 200, { ok: true, views: manager.size() });
    const match = BOT_ROUTE.exec(path);
    if (!match || req.method !== "POST") return json(res, 404, { error: "not found" });
    const [, botId, operation] = match;
    if (!OPERATIONS.has(operation)) return json(res, 404, { error: "unknown browser operation" });
    let body;
    try {
      body = await readJson(req);
    } catch (error) {
      return json(res, 400, { error: error?.message ?? "invalid request" });
    }
    try {
      const result = await perform(manager, botId, operation, body);
      return json(res, 200, result ?? {});
    } catch (error) {
      const message = error?.message ?? String(error);
      // Stale refs and refused navigations are the bot's mistakes to correct;
      // everything else is the surface's.
      const status = /stale|unknown|not visible|gone|required|invalid|limited|unsupported|Only |no previous|must be/i.test(message) ? 400 : 500;
      return json(res, status, { error: message });
    }
  };

  return {
    get token() {
      return token;
    },
    get url() {
      return url;
    },
    start() {
      if (url) return Promise.resolve(url);
      server = http.createServer((req, res) => {
        handle(req, res).catch((error) => {
          try {
            json(res, 500, { error: error?.message ?? "browser host failure" });
          } catch {}
        });
      });
      server.on("connection", (socket) => {
        if (!isLoopback(socket.remoteAddress)) socket.destroy();
      });
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
          const address = server.address();
          url = `http://127.0.0.1:${address.port}`;
          resolve(url);
        });
      });
    },
    stop() {
      return new Promise((resolve) => {
        if (!server) return resolve();
        server.close(() => resolve());
        server = null;
        url = null;
      });
    },
    /** What the harness needs to reach this host: written to the descriptor file. */
    descriptor() {
      if (!url) throw new Error("The browser host is not listening");
      return { version: 1, url, token, pid: process.pid };
    },
  };
}

module.exports = { OPERATIONS, createBrowserHost };
