import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { recordEvents } from "../testing/events.ts";
import { BUILT_IN_DRIVERS } from "./builtIn.ts";
import { DshDriver } from "./dsh.ts";
import { instanceConfigs } from "../config.ts";

function ok(rpcId: string, value: unknown): Response {
  return new Response(JSON.stringify({ type: "server-response", rpcId, result: { ok: true, value } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function event(seq: number, type: string, data: unknown) {
  return { event: { type, seq, time: 1_787_000_000_000 + seq, data } };
}

describe("DshDriver", () => {

  it("retires the custom real-Chrome bridge from the active server", () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
    const source = require("node:fs").readFileSync(join(root, "server/index.ts"), "utf8");
    expect(source).not.toContain("OPENMAUSBOT_REAL_CHROME");
    expect(source).not.toContain("OMB_AC_BASE");
    expect(source).not.toContain("OMB_AC_TOKEN");
    expect(source).not.toContain("OMB_AC_BOT");
    expect(source).not.toContain("browser-bridge");
    expect(source).not.toContain("chromeWindowChoreography");
    expect(require("node:fs").existsSync(join(root, "server/drivers/browser-bridge.ts"))).toBe(false);
    expect(require("node:fs").existsSync(join(root, "server/real-chrome-window.ts"))).toBe(false);
  });
  it("loads under the production Node strip-types runtime", () => {
    const cwd = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
    expect(() =>
      execFileSync(process.execPath, [
        "--experimental-strip-types",
        "--input-type=module",
        "--eval",
        "import('./server/drivers/dsh.ts')",
      ], { cwd, stdio: "pipe" }),
    ).not.toThrow();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("ships DSH in the default product fleet without replacing existing providers", () => {
    const instances = instanceConfigs({});
    expect(instances.dsh).toMatchObject({ driver: "dsh" });
    expect(instances.opencodeGo).toBeDefined();
    expect(instances.antigravity).toBeDefined();
  });

  it("is a built-in loopback-only DSH provider", () => {
    expect(DshDriver.driverKind).toBe("dsh");
    expect(BUILT_IN_DRIVERS).toContain(DshDriver);
    expect(DshDriver.defaultConfig()).toEqual({ url: "http://127.0.0.1:3080" });
    expect(() => DshDriver.decodeConfig({ url: "https://example.com" })).toThrow(/loopback/i);
    expect(DshDriver.decodeConfig({ url: "http://localhost:3081/" })).toEqual({ url: "http://localhost:3081" });
    vi.stubEnv("OPENMAUSBOT_DSH_BROWSER", "9c4eeb57");
    expect(DshDriver.defaultConfig()).toEqual({ url: "http://127.0.0.1:3080", browser: "9c4eeb57" });
  });

  it("keeps one DSH session per OpenMausBot thread and returns the final assistant message", async () => {
    const calls: Array<{ method: string; payload: any }> = [];
    let historyReads = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const body = JSON.parse(String(init?.body ?? "{}"));
      calls.push({ method: body.method, payload: body.payload });
      if (url.pathname.endsWith("session.create")) return ok(body.rpcId, { sessionId: "session-1" });
      if (url.pathname.endsWith("session.prompt")) return ok(body.rpcId, { accepted: true });
      if (url.pathname.endsWith("session.history")) {
        historyReads += 1;
        if (historyReads === 1) return ok(body.rpcId, { events: [], hasMore: false });
        return ok(body.rpcId, {
          events: [
            event(1, "turn/start", { turn: 1 }),
            event(2, "assistant/message", {
              turn: 1,
              step: 1,
              message: { role: "assistant", content: [{ type: "reasoning", text: "hidden" }, { type: "text", text: "Browser task done" }] },
              usage: { inputTokens: 42, outputTokens: 7 },
            }),
            event(3, "turn/end", { turn: 1, reason: { kind: "completed" } }),
          ],
          hasMore: false,
        });
      }
      if (url.pathname.endsWith("session.list")) return ok(body.rpcId, { items: [] });
      throw new Error(`unexpected DSH call ${url.pathname}`);
    }));

    const inst = await DshDriver.create({
      instanceId: "dsh-test",
      displayName: "DSH",
      environment: {},
      enabled: true,
      config: { url: "http://127.0.0.1:3080" },
    });
    const recorder = recordEvents(inst.adapter);

    await inst.adapter.sendTurn({ threadId: "thread-a", text: "use the browser", system: "You are Maus." });
    const completed = await recorder.until((e) => e.type === "turn.completed");

    expect(recorder.events.find((e) => e.type === "session.started")).toMatchObject({ sessionId: "session-1" });
    expect(recorder.events.find((e) => e.type === "item.completed")).toMatchObject({
      itemType: "assistant_text",
      text: "Browser task done",
    });
    expect(completed).toMatchObject({ ok: true, usage: { input: 42, output: 7 } });
    expect(inst.adapter.hasSession("thread-a")).toBe(true);
    expect(inst.adapter.capabilities.browserMcp).not.toBe(true);
    expect(calls.find((c) => c.method === "session.create")?.payload).toEqual({});
    expect(calls.find((c) => c.method === "session.prompt")?.payload).toMatchObject({
      sessionId: "session-1",
      mode: "queue",
      content: [{ type: "text", text: "You are Maus.\n\nuse the browser" }],
    });

    historyReads = 0;
    calls.length = 0;
    await inst.adapter.sendTurn({ threadId: "thread-a", text: "continue" });
    await recorder.until((e) => e.type === "turn.completed" && recorder.events.filter((x) => x.type === "turn.completed").length === 2);
    expect(calls.some((c) => c.method === "session.create")).toBe(false);
    expect(calls.find((c) => c.method === "session.prompt")?.payload.sessionId).toBe("session-1");

    recorder.stop();
    await inst.dispose();
  });

  it("injects the configured BrowserSkill browser target into every DSH turn", async () => {
    const calls: Array<{ method: string; payload: any }> = [];
    let historyReads = 0;
    vi.stubGlobal("fetch", vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      calls.push({ method: body.method, payload: body.payload });
      if (body.method === "session.create") return ok(body.rpcId, { sessionId: "session-browser" });
      if (body.method === "session.prompt") return ok(body.rpcId, { accepted: true });
      if (body.method === "session.history") {
        historyReads += 1;
        return ok(body.rpcId, historyReads === 1
          ? { events: [], hasMore: false }
          : { events: [event(1, "turn/end", { turn: 1, reason: { kind: "completed" } })], hasMore: false });
      }
      throw new Error(`unexpected ${body.method}`);
    }));

    const inst = await DshDriver.create({
      instanceId: "dsh-test",
      displayName: "DSH",
      environment: {},
      enabled: true,
      config: { url: "http://127.0.0.1:3080", browser: "9c4eeb57" } as any,
    });
    const recorder = recordEvents(inst.adapter);
    await inst.adapter.sendTurn({ threadId: "thread-browser", text: "use the browser" });
    await recorder.until((e) => e.type === "turn.completed");

    const prompt = calls.find((call) => call.method === "session.prompt")?.payload?.content?.[0]?.text ?? "";
    expect(prompt).toContain('browser_session action "start"');
    expect(prompt).toContain('browser: "9c4eeb57"');
    expect(prompt).toContain("Do not guess another browser id or label");
    expect(prompt).toContain("use the browser");
    recorder.stop();
    await inst.dispose();
  });

  it("uses DSH steer and cancel instead of OpenMausBot browser/computer wrappers", async () => {
    const calls: Array<{ method: string; payload: any }> = [];
    let historyReads = 0;
    vi.stubGlobal("fetch", vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      calls.push({ method: body.method, payload: body.payload });
      if (body.method === "session.create") return ok(body.rpcId, { sessionId: "session-2" });
      if (body.method === "session.prompt") return ok(body.rpcId, { accepted: true });
      if (body.method === "session.cancel") return ok(body.rpcId, { accepted: true });
      if (body.method === "session.history") {
        historyReads += 1;
        return ok(body.rpcId, historyReads === 1
          ? { events: [], hasMore: false }
          : { events: [event(1, "turn/end", { turn: 1, reason: { kind: "completed" } })], hasMore: false });
      }
      throw new Error(`unexpected ${body.method}`);
    }));

    const inst = await DshDriver.create({ instanceId: "dsh-test", displayName: "DSH", environment: {}, enabled: true, config: { url: "http://127.0.0.1:3080" } });
    const recorder = recordEvents(inst.adapter);
    await inst.adapter.sendTurn({ threadId: "thread-b", text: "start" });
    await recorder.until((e) => e.type === "turn.completed");
    expect(inst.adapter.capabilities.queueing).toBe(true);
    await expect(inst.adapter.steer?.("thread-b", "new direction")).resolves.toBe(true);
    await inst.adapter.interruptTurn("thread-b");
    expect(calls).toContainEqual({ method: "session.prompt", payload: { sessionId: "session-2", mode: "steer", content: [{ type: "text", text: "new direction" }] } });
    expect(calls).toContainEqual({ method: "session.cancel", payload: { sessionId: "session-2" } });
    recorder.stop();
    await inst.dispose();
  });
});
