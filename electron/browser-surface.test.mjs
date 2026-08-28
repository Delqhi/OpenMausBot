import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { createBrowserSurfaceManager } = require("./browser-surface.cjs");

const AX_NODES = [
  { role: { value: "link" }, name: { value: "Docs" }, backendDOMNodeId: 11 },
  { role: { value: "textbox" }, name: { value: "Search" }, backendDOMNodeId: 12 },
];

/** A WebContents + WebContentsView double that records what the manager
 * asked of it. CDP calls answer from a small table so the click/fill
 * sequences can be asserted verbatim. */
function fakeView() {
  const calls = [];
  const listeners = new Map();
  let url = "about:blank";
  let title = "";
  const webContents = {
    session: {
      getUserAgent: () => "Mozilla/5.0 Chrome/1 Electron/43 OpenMausBot/1",
      setUserAgent: (ua) => calls.push(["setUserAgent", ua]),
      setPermissionCheckHandler: () => {},
      setPermissionRequestHandler: () => {},
      on: () => {},
    },
    setWindowOpenHandler: (handler) => {
      webContents.windowOpenHandler = handler;
    },
    on: (name, handler) => {
      listeners.set(name, handler);
    },
    once: (name, handler) => {
      listeners.set(name, handler);
    },
    isDestroyed: () => false,
    isLoading: () => false,
    getURL: () => url,
    getTitle: () => title,
    navigationHistory: { canGoBack: () => url !== "about:blank", goBack: () => calls.push(["goBack"]) },
    loadURL: async (next) => {
      calls.push(["loadURL", next]);
      url = next;
      title = next === "about:blank" ? "" : "Loaded";
    },
    close: () => calls.push(["close"]),
    capturePage: async () => ({
      getSize: () => ({ width: 2048, height: 1200 }),
      resize: ({ width }) => ({ getSize: () => ({ width, height: Math.round((1200 * width) / 2048) }), toJPEG: () => Buffer.from("jpeg") }),
      toJPEG: () => Buffer.from("jpeg"),
    }),
    debugger: {
      attached: false,
      attach: (version) => {
        calls.push(["attach", version]);
        webContents.debugger.attached = true;
      },
      detach: () => calls.push(["detach"]),
      on: () => {},
      sendCommand: async (method, params) => {
        calls.push([method, params]);
        if (method === "Accessibility.getFullAXTree") return { nodes: AX_NODES };
        if (method === "DOM.getBoxModel") {
          if (params.backendNodeId === 99) throw new Error("No node with given id found");
          return { model: { border: [10, 20, 110, 20, 110, 60, 10, 60] } };
        }
        return {};
      },
    },
  };
  const view = {
    webContents,
    bounds: null,
    visible: null,
    setBounds: (bounds) => {
      view.bounds = bounds;
    },
    setVisible: (visible) => {
      view.visible = visible;
    },
    getBounds: () => view.bounds ?? { x: 0, y: 0, width: 800, height: 600 },
    calls,
    listeners,
  };
  return view;
}

function harness() {
  const views = [];
  const owner = {
    isDestroyed: () => false,
    getContentSize: () => [1200, 800],
    contentView: {
      children: [],
      addChildView: (view) => owner.contentView.children.push(view),
      removeChildView: (view) => {
        owner.contentView.children = owner.contentView.children.filter((candidate) => candidate !== view);
      },
    },
  };
  const states = [];
  const partitions = [];
  const manager = createBrowserSurfaceManager({
    owner,
    createView: (options) => {
      partitions.push(options.webPreferences.partition);
      const view = fakeView();
      views.push(view);
      return view;
    },
    notify: (state) => states.push(state),
    platform: "darwin",
    settleMs: 0,
  });
  return { manager, owner, views, states, partitions };
}

const cdpCalls = (view) => view.calls.filter(([name]) => /^[A-Z]/.test(name) && name.includes("."));

describe("browser surface manager", () => {
  it("creates one sandboxed, partitioned view per bot only when something needs it", () => {
    const { manager, owner, views, partitions } = harness();
    expect(manager.layout("bot-a", null)).toMatchObject({ botId: "bot-a", open: false });
    expect(views).toHaveLength(0);

    const state = manager.layout("bot-a", { x: 20.4, y: 30.6, width: 5000, height: 300 });
    expect(views).toHaveLength(1);
    expect(partitions).toEqual(["persist:openmausbot-browser-bot-a"]);
    expect(views[0].bounds).toEqual({ x: 20, y: 31, width: 1180, height: 300 });
    expect(views[0].visible).toBe(true);
    expect(owner.contentView.children).toEqual([views[0]]);
    expect(state).toMatchObject({ botId: "bot-a", open: true, visible: true, url: "about:blank" });
    expect(views[0].calls).toContainEqual(["setUserAgent", "Mozilla/5.0 Chrome/1"]);

    manager.layout("bot-a", null);
    expect(views[0].visible).toBe(false);
    expect(() => manager.layout("../bad", { x: 0, y: 0, width: 10, height: 10 })).toThrow(/bot id/);
  });

  it("navigates only to web pages and answers with the page's elements", async () => {
    const { manager, views } = harness();
    await expect(manager.navigate("bot-a", "file:///etc/passwd")).rejects.toThrow(/http and https/);
    const page = await manager.navigate("bot-a", "example.com");
    expect(views[0].calls).toContainEqual(["loadURL", "https://example.com/"]);
    expect(page.url).toBe("https://example.com/");
    expect(page.elements).toEqual([
      { ref: "b11", role: "link", name: "Docs" },
      { ref: "b12", role: "textbox", name: "Search" },
    ]);
    expect(page.text).toContain('b11 link "Docs"');
    expect(views[0].calls).toContainEqual(["attach", "1.3"]);
  });

  it("clicks at the centre of a known ref and refuses stale or unknown ones", async () => {
    const { manager, views } = harness();
    await manager.navigate("bot-a", "https://example.com");
    await expect(manager.click("bot-a", "b99")).rejects.toThrow(/stale or unknown/);
    await expect(manager.click("bot-a", "nope")).rejects.toThrow(/invalid or stale/);
    await manager.click("bot-a", "b11");
    const mouse = cdpCalls(views[0]).filter(([name]) => name === "Input.dispatchMouseEvent").map(([, params]) => params);
    expect(mouse).toEqual([
      { type: "mouseMoved", x: 60, y: 40 },
      { type: "mousePressed", x: 60, y: 40, button: "left", clickCount: 1 },
      { type: "mouseReleased", x: 60, y: 40, button: "left", clickCount: 1 },
    ]);
  });

  it("fills a field by focusing it, selecting everything, and inserting text", async () => {
    const { manager, views } = harness();
    await manager.navigate("bot-a", "https://example.com");
    await manager.fill("bot-a", "b12", "running shoes");
    const all = cdpCalls(views[0]);
    const start = all.findIndex(([name]) => name === "DOM.focus");
    const sequence = all.slice(start, start + 6).map(([name, params]) => [name, params.type ?? params.text ?? params.backendNodeId]);
    expect(sequence).toEqual([
      ["DOM.focus", 12],
      ["Input.dispatchKeyEvent", "keyDown"],
      ["Input.dispatchKeyEvent", "keyUp"],
      ["Input.dispatchKeyEvent", "keyDown"],
      ["Input.dispatchKeyEvent", "keyUp"],
      ["Input.insertText", "running shoes"],
    ]);
    // macOS select-all is ⌘A (modifier 4), not ^A
    expect(cdpCalls(views[0]).find(([name, params]) => name === "Input.dispatchKeyEvent" && params.key === "a")[1].modifiers).toBe(4);
  });

  it("presses named keys, scrolls, and screenshots at a bounded width", async () => {
    const { manager, views } = harness();
    await manager.navigate("bot-a", "https://example.com");
    await expect(manager.press("bot-a", "F13")).rejects.toThrow(/unsupported key/);
    await manager.press("bot-a", "Enter");
    const enter = cdpCalls(views[0]).find(([name, params]) => name === "Input.dispatchKeyEvent" && params.key === "Enter" && params.type === "keyDown");
    expect(enter?.[1]).toMatchObject({ type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
    await manager.scroll("bot-a", "down");
    expect(cdpCalls(views[0]).find(([name, params]) => name === "Input.dispatchMouseEvent" && params.type === "mouseWheel")[1]).toMatchObject({ deltaX: 0, deltaY: 600 });
    await expect(manager.scroll("bot-a", "sideways")).rejects.toThrow(/direction/);
    const shot = await manager.screenshot("bot-a");
    expect(shot).toMatchObject({ format: "jpeg", width: 1024, png: Buffer.from("jpeg").toString("base64") });
  });

  it("tears every view down on closeAll and hides them all on hideAll", async () => {
    const { manager, owner, views, states } = harness();
    manager.layout("bot-a", { x: 0, y: 0, width: 100, height: 100 });
    manager.layout("bot-b", { x: 0, y: 0, width: 100, height: 100 });
    expect(manager.size()).toBe(2);
    manager.hideAll();
    expect(views.map((view) => view.visible)).toEqual([false, false]);
    manager.closeAll();
    expect(manager.size()).toBe(0);
    expect(owner.contentView.children).toEqual([]);
    expect(states.at(-1)).toMatchObject({ botId: "bot-b", open: false });
  });
});
