// The built-in browser surface: one WebContentsView per bot, driven over the
// Chrome DevTools Protocol that Electron already ships (webContents.debugger),
// and shown inside the app window as the Browser tab of the computer panel.
//
// Why a native view and not a screenshot stream: the view IS the panel. The
// person sees the real page, and taking over is just clicking into it — no
// JPEG plumbing, no VNC, no second Chrome. The renderer only reports where
// the tab's rectangle is; this module owns lifecycle, isolation and input.
//
// Isolation, per bot: a `persist:` partition (logins survive restarts, bots
// never share a cookie jar), sandbox on, no preload, every permission prompt
// denied, downloads refused, popups routed back into the same view, and only
// http(s) navigations honoured. A bot's browser can never reach file://,
// chrome:// or the app's own origin.
"use strict";

const { normalizeDesktopWorkspaceBounds } = require("./desktop-workspace.cjs");
const {
  backendNodeIdFromRef,
  browserNavigationAllowed,
  browserNavigationUrl,
  browserPartition,
  browserUserAgent,
  formatSnapshot,
  snapshotFromAxNodes,
} = require("./browser-snapshot.cjs");

const BOT_ID = /^[A-Za-z0-9_-]{1,120}$/;
const MAX_VIEWS = 8;
const SETTLE_MS = 350;
const LOAD_WAIT_MS = 8_000;
const SCREENSHOT_WIDTH = 1024;
const SCREENSHOT_QUALITY = 70;
const MAX_TEXT = 4_000;
const AX_TREE_DEPTH = 24;

/** Keys a bot may press by name → CDP key event fields. `text` is what makes
 * Enter/Tab actually fire in inputs; the virtual key code is what makes
 * shortcuts and arrow navigation work in apps that listen at keydown. */
const KEYS = {
  enter: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" },
  tab: { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, text: "\t" },
  escape: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
  backspace: { key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 },
  delete: { key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 },
  space: { key: " ", code: "Space", windowsVirtualKeyCode: 32, text: " " },
  arrowup: { key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38 },
  arrowdown: { key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 },
  arrowleft: { key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37 },
  arrowright: { key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 },
  pageup: { key: "PageUp", code: "PageUp", windowsVirtualKeyCode: 33 },
  pagedown: { key: "PageDown", code: "PageDown", windowsVirtualKeyCode: 34 },
  home: { key: "Home", code: "Home", windowsVirtualKeyCode: 36 },
  end: { key: "End", code: "End", windowsVirtualKeyCode: 35 },
};

const SCROLL_DIRECTIONS = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };

function botIdOf(value) {
  const id = String(value ?? "");
  if (!BOT_ID.test(id)) throw new Error("A bot id is required");
  return id;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {object} options
 * @param {import("electron").BrowserWindow} options.owner the app window that hosts the views
 * @param {(options: object) => import("electron").WebContentsView} options.createView
 * @param {(state: object) => void} [options.notify] renderer-facing state changes
 * @param {NodeJS.Platform} [options.platform]
 * @param {(botId: string) => string} [options.partitionFor] test seam for the persist: partition
 */
function createBrowserSurfaceManager({
  owner,
  createView,
  notify,
  platform = process.platform,
  partitionFor = browserPartition,
  settleMs = SETTLE_MS,
}) {
  if (!owner || owner.isDestroyed?.()) throw new Error("The OpenMausBot window is unavailable");
  if (createView?.constructor !== Function) throw new Error("The browser surface viewer is unavailable");
  const emit = notify?.constructor === Function ? notify : () => {};
  const entries = new Map();

  const stateFor = (entry) => {
    const contents = entry.view.webContents;
    const destroyed = contents.isDestroyed?.() === true;
    return {
      botId: entry.botId,
      open: true,
      url: destroyed ? "" : contents.getURL?.() ?? "",
      title: destroyed ? "" : contents.getTitle?.() ?? "",
      loading: destroyed ? false : contents.isLoading?.() === true,
      canGoBack: destroyed ? false : contents.navigationHistory?.canGoBack?.() ?? contents.canGoBack?.() ?? false,
      visible: entry.visible,
    };
  };

  const secure = (entry) => {
    const contents = entry.view.webContents;
    const ses = contents.session;
    try {
      ses.setUserAgent(browserUserAgent(ses.getUserAgent()));
    } catch {}
    ses.setPermissionCheckHandler(() => false);
    ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    // A download would land on the user's disk under a bot's control; refuse
    // until there is a reviewed place for it to go.
    ses.on("will-download", (event) => event.preventDefault());
    contents.setWindowOpenHandler(({ url }) => {
      // target=_blank links stay in this bot's one tab: a second window would
      // escape the panel, the partition guarantees and the person's view.
      if (browserNavigationAllowed(url) && !contents.isDestroyed()) void contents.loadURL(browserNavigationUrl(url));
      return { action: "deny" };
    });
    const guard = (event, target) => {
      if (!browserNavigationAllowed(target)) event.preventDefault();
    };
    contents.on("will-navigate", guard);
    contents.on("will-redirect", guard);
    for (const signal of ["did-navigate", "did-navigate-in-page", "did-stop-loading", "page-title-updated"]) {
      contents.on(signal, () => {
        if (entries.get(entry.botId) === entry) emit(stateFor(entry));
      });
    }
    contents.on("render-process-gone", () => {
      if (entries.get(entry.botId) === entry) remove(entry, "renderer-gone");
    });
    contents.debugger.on("detach", () => {
      entry.attached = false;
    });
  };

  const remove = (entry, code) => {
    if (entries.get(entry.botId) !== entry) return;
    entries.delete(entry.botId);
    try {
      entry.view.setVisible(false);
    } catch {}
    try {
      owner.contentView.removeChildView(entry.view);
    } catch {}
    try {
      if (entry.attached) entry.view.webContents.debugger.detach();
    } catch {}
    try {
      if (!entry.view.webContents.isDestroyed()) entry.view.webContents.close({ waitForBeforeUnload: false });
    } catch {}
    emit({ botId: entry.botId, open: false, url: "", title: "", loading: false, canGoBack: false, visible: false, ...(code ? { code } : {}) });
  };

  const ensure = (rawBotId) => {
    const botId = botIdOf(rawBotId);
    const existing = entries.get(botId);
    if (existing) return existing;
    if (entries.size >= MAX_VIEWS) throw new Error(`Only ${MAX_VIEWS} bot browsers can be open at once`);
    if (owner.isDestroyed?.()) throw new Error("The OpenMausBot window is unavailable");
    const view = createView({
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        partition: partitionFor(botId),
      },
    });
    const entry = { botId, view, attached: false, visible: false, bounds: null };
    entries.set(botId, entry);
    secure(entry);
    view.setVisible(false);
    owner.contentView.addChildView(view);
    void view.webContents.loadURL("about:blank").catch(() => {});
    emit(stateFor(entry));
    return entry;
  };

  const cdp = async (entry, method, params = {}) => {
    const dbg = entry.view.webContents.debugger;
    if (!entry.attached) {
      dbg.attach("1.3");
      entry.attached = true;
    }
    return dbg.sendCommand(method, params);
  };

  /** Wait for the page to be idle enough to observe: a short settle, and if a
   * navigation is in flight, its end (bounded — a page that never stops
   * loading must not hang the bot). */
  const settle = async (entry, ms = settleMs) => {
    await sleep(ms);
    const contents = entry.view.webContents;
    if (!contents.isLoading?.()) return;
    await Promise.race([
      new Promise((resolve) => contents.once("did-stop-loading", resolve)),
      sleep(LOAD_WAIT_MS),
    ]);
  };

  const observe = async (entry) => {
    await settle(entry);
    return snapshot(entry);
  };

  const snapshot = async (entry) => {
    await cdp(entry, "Accessibility.enable");
    const { nodes = [] } = await cdp(entry, "Accessibility.getFullAXTree", { depth: AX_TREE_DEPTH });
    const elements = snapshotFromAxNodes(nodes);
    entry.refs = new Set(elements.map((element) => element.ref));
    const state = stateFor(entry);
    return { url: state.url, title: state.title, elements, text: formatSnapshot({ title: state.title, url: state.url, elements }) };
  };

  const centerOf = async (entry, ref) => {
    const backendNodeId = backendNodeIdFromRef(ref);
    if (entry.refs && !entry.refs.has(String(ref).trim())) {
      throw new Error("that browser ref is stale or unknown — take a new browser_snapshot");
    }
    try {
      await cdp(entry, "DOM.scrollIntoViewIfNeeded", { backendNodeId });
    } catch {
      // not every node is scrollable-into-view (e.g. already visible); the
      // box model below is the real check
    }
    let model;
    try {
      ({ model } = await cdp(entry, "DOM.getBoxModel", { backendNodeId }));
    } catch {
      throw new Error("that element is gone; take a new browser_snapshot");
    }
    const quad = model?.border ?? model?.content;
    if (!Array.isArray(quad) || quad.length < 8) throw new Error("that element is not visible; take a new browser_snapshot");
    return {
      backendNodeId,
      x: (quad[0] + quad[2] + quad[4] + quad[6]) / 4,
      y: (quad[1] + quad[3] + quad[5] + quad[7]) / 4,
    };
  };

  const viewportCenter = (entry) => {
    const bounds = entry.view.getBounds?.() ?? entry.bounds ?? { width: 800, height: 600 };
    return { x: Math.max(1, Math.floor(bounds.width / 2)), y: Math.max(1, Math.floor(bounds.height / 2)) };
  };

  const selectAllModifiers = platform === "darwin" ? 4 : 2;

  const api = {
    /** Create the bot's view (hidden) if it does not exist yet. */
    ensure(botId) {
      return stateFor(ensure(botId));
    },

    state(botId) {
      const entry = entries.get(botIdOf(botId));
      return entry ? stateFor(entry) : { botId: botIdOf(botId), open: false, url: "", title: "", loading: false, canGoBack: false, visible: false };
    },

    /** Position the view over the renderer's rectangle, or hide it (null). */
    layout(botId, bounds) {
      if (bounds === null || bounds === undefined) {
        const entry = entries.get(botIdOf(botId));
        if (!entry) return api.state(botId);
        entry.visible = false;
        entry.view.setVisible(false);
        return stateFor(entry);
      }
      const entry = ensure(botId);
      const normalized = normalizeDesktopWorkspaceBounds(bounds, owner.getContentSize());
      entry.bounds = normalized;
      entry.view.setBounds(normalized);
      entry.visible = true;
      entry.view.setVisible(true);
      return stateFor(entry);
    },

    async navigate(botId, rawUrl) {
      const entry = ensure(botId);
      const url = browserNavigationUrl(rawUrl);
      try {
        await entry.view.webContents.loadURL(url);
      } catch (error) {
        // ERR_ABORTED (-3) is a redirect or an in-page replacement, not a failure
        if (error?.errno !== -3 && error?.code !== "ERR_ABORTED") {
          throw new Error(`could not open ${url}: ${error?.message ?? error}`);
        }
      }
      return observe(entry);
    },

    async back(botId) {
      const entry = ensure(botId);
      const contents = entry.view.webContents;
      const canGoBack = contents.navigationHistory?.canGoBack?.() ?? contents.canGoBack?.();
      if (!canGoBack) throw new Error("there is no previous page");
      if (contents.navigationHistory?.goBack) contents.navigationHistory.goBack();
      else contents.goBack();
      return observe(entry);
    },

    async snapshot(botId) {
      const entry = ensure(botId);
      await settle(entry, 0);
      return snapshot(entry);
    },

    async click(botId, ref, { button = "left", clickCount = 1 } = {}) {
      const entry = ensure(botId);
      const { x, y } = await centerOf(entry, ref);
      const which = button === "right" ? "right" : button === "middle" ? "middle" : "left";
      await cdp(entry, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
      await cdp(entry, "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: which, clickCount });
      await cdp(entry, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: which, clickCount });
      return observe(entry);
    },

    async fill(botId, ref, text) {
      const entry = ensure(botId);
      const value = String(text ?? "");
      if (value.length > MAX_TEXT) throw new Error(`text is limited to ${MAX_TEXT} characters`);
      const { backendNodeId } = await centerOf(entry, ref);
      await cdp(entry, "DOM.focus", { backendNodeId });
      await cdp(entry, "Input.dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: selectAllModifiers });
      await cdp(entry, "Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: selectAllModifiers });
      await cdp(entry, "Input.dispatchKeyEvent", { type: "keyDown", ...KEYS.backspace });
      await cdp(entry, "Input.dispatchKeyEvent", { type: "keyUp", ...KEYS.backspace });
      if (value) await cdp(entry, "Input.insertText", { text: value });
      return observe(entry);
    },

    async type(botId, text) {
      const entry = ensure(botId);
      const value = String(text ?? "");
      if (!value) throw new Error("text is required");
      if (value.length > MAX_TEXT) throw new Error(`text is limited to ${MAX_TEXT} characters`);
      await cdp(entry, "Input.insertText", { text: value });
      return observe(entry);
    },

    async press(botId, rawKey) {
      const entry = ensure(botId);
      const key = KEYS[String(rawKey ?? "").toLowerCase().replace(/[\s_-]/g, "")];
      if (!key) throw new Error(`unsupported key; use one of ${Object.keys(KEYS).join(", ")}`);
      await cdp(entry, "Input.dispatchKeyEvent", { type: key.text ? "keyDown" : "rawKeyDown", ...key });
      await cdp(entry, "Input.dispatchKeyEvent", { type: "keyUp", key: key.key, code: key.code, windowsVirtualKeyCode: key.windowsVirtualKeyCode });
      return observe(entry);
    },

    async scroll(botId, rawDirection, amount) {
      const entry = ensure(botId);
      const direction = SCROLL_DIRECTIONS[String(rawDirection ?? "down").toLowerCase()];
      if (!direction) throw new Error("direction must be up, down, left, or right");
      const pixels = Number.isFinite(Number(amount)) && Number(amount) > 0 ? Math.min(Number(amount), 5_000) : 600;
      const { x, y } = viewportCenter(entry);
      await cdp(entry, "Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: direction[0] * pixels, deltaY: direction[1] * pixels });
      return observe(entry);
    },

    /** JPEG of the page, downscaled for the model; the panel shows the real view. */
    async screenshot(botId) {
      const entry = ensure(botId);
      const image = await entry.view.webContents.capturePage();
      const size = image.getSize();
      const scaled = size.width > SCREENSHOT_WIDTH ? image.resize({ width: SCREENSHOT_WIDTH }) : image;
      return { png: scaled.toJPEG(SCREENSHOT_QUALITY).toString("base64"), format: "jpeg", width: scaled.getSize().width, height: scaled.getSize().height };
    },

    close(botId) {
      const entry = entries.get(botIdOf(botId));
      if (entry) remove(entry);
      return true;
    },

    closeAll() {
      for (const entry of [...entries.values()]) remove(entry);
    },

    hideAll() {
      for (const entry of entries.values()) {
        entry.visible = false;
        try {
          entry.view.setVisible(false);
        } catch {}
      }
    },

    size() {
      return entries.size;
    },
  };
  return api;
}

module.exports = { KEYS, MAX_VIEWS, createBrowserSurfaceManager };
