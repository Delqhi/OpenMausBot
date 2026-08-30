import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SERVER_DIR, "..");
const HOST = "127.0.0.1";
const ANNOUNCEMENT_PREFIX = "__OMB_LISTEN__";

function listen(server: Server, port: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, HOST, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
}

function close(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

it("falls back from an occupied pair and privately reports the resolved listeners", async () => {
  const requestedPort = await freePortBlock([0, 1], 31_000, 3_000);
  const occupiedMain = createServer();
  const occupiedWebhook = createServer();
  const home = mkdtempSync(join(tmpdir(), "omb-port-fallback-"));
  const staticDir = join(home, "static");
  let child: ChildProcess | undefined;
  let output = "";

  try {
    await Promise.all([
      listen(occupiedMain, requestedPort),
      listen(occupiedWebhook, requestedPort + 1),
    ]);
    mkdirSync(staticDir, { recursive: true });
    writeFileSync(join(staticDir, "index.html"), "<!doctype html><title>Port fallback</title>");

    const parentPrelude = `data:text/javascript,${encodeURIComponent(`
      Object.defineProperty(process, "parentPort", {
        value: {
          on() {},
          postMessage(message) {
            if (message?.type === "openmausbot:listen") {
              process.stdout.write(${JSON.stringify(ANNOUNCEMENT_PREFIX)} + JSON.stringify(message) + "\\n");
            }
          },
        },
      });
    `)}`;
    child = spawn(process.execPath, ["--import", parentPrelude, join(SERVER_DIR, "index.ts")], {
      cwd: ROOT,
      env: {
        ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
        ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
        HOME: home,
        USERPROFILE: home,
        OMB_PORT: String(requestedPort),
        OMB_PORT_FALLBACK: "1",
        OMB_STATIC_DIR: staticDir,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout!.on("data", (chunk) => {
      output += String(chunk);
    });
    child.stderr!.on("data", (chunk) => {
      output += String(chunk);
    });

    const deadline = Date.now() + 30_000;
    let announcement: {
      requestedPort: number;
      port: number;
      webhookPort: number | null;
      pid: number;
    } | null = null;
    while (Date.now() < deadline) {
      const line = output.split("\n").find((candidate) => candidate.startsWith(ANNOUNCEMENT_PREFIX));
      if (line) {
        announcement = JSON.parse(line.slice(ANNOUNCEMENT_PREFIX.length));
        break;
      }
      if (child.exitCode !== null || child.signalCode !== null) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(announcement, output).not.toBeNull();
    expect(announcement).toMatchObject({
      requestedPort,
      pid: child.pid,
    });
    expect(announcement!.port).not.toBe(requestedPort);
    expect(announcement!.webhookPort).toBe(announcement!.port + 1);

    const health = await fetch(`http://${HOST}:${announcement!.port}/api/health`);
    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toMatchObject({
      app: "openmausbot",
      pid: child.pid,
      static: true,
    });
    const webhooks = await fetch(`http://${HOST}:${announcement!.port}/api/webhooks`);
    expect(webhooks.status).toBe(200);
    await expect(webhooks.json()).resolves.toMatchObject({
      ingress: {
        available: true,
        baseUrl: `http://${HOST}:${announcement!.webhookPort}`,
      },
    });
  } finally {
    await waitForExit(child, { signal: "SIGTERM" });
    await Promise.all([close(occupiedMain), close(occupiedWebhook)]);
    await removeTempDir(home);
  }
}, 40_000);
