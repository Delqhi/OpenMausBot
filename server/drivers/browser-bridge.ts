// Real-Chrome bridge MCP server — spawned inside a bot's agent process (via
// the "browser" integration) when the harness runs with the real-chrome
// backend. It forwards every browser tool call to the OpenBot agent-computer
// HTTP API on loopback, which drives a real, headed Google Chrome with a
// persistent per-bot profile (the host-chrome migration in wow-my-zsh docs).
//
// Why this exists: codex's app-server exposes MCP servers as nameless
// namespace entries that non-OpenAI models cannot call ("unsupported call:
// browser"). The browser surface itself is fine — so this bridge offers the
// same tool surface against the real-chrome backend, behind plain, fully
// schematized function tools.
//
// Speaks raw JSON-RPC 2.0 over stdio (house style: browser-proxy).
// State comes from env, injected by the harness:
//   OMB_AC_BASE   agent-computer base, e.g. http://127.0.0.1:4100
//   OMB_AC_TOKEN  shared COMPUTER_TOKEN
//   OMB_AC_BOT    which bot's profile to drive
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";

const BASE = (process.env.OMB_AC_BASE ?? "").replace(/\/$/, "");
const TOKEN = process.env.OMB_AC_TOKEN ?? "";
const BOT = process.env.OMB_AC_BOT ?? "";

const REF_PROPERTY = { type: "string", description: "An element ref from the latest browser_snapshot, such as e12." } as const;

export const TOOLS = [
  {
    name: "browser_navigate",
    description:
      "Open a web address in this bot's real Chrome window (visible on this Mac, persistent profile). Returns the page's interactive elements with refs — do not follow it with browser_snapshot.",
    inputSchema: { type: "object", properties: { url: { type: "string", description: "http(s) address." } }, required: ["url"] },
  },
  {
    name: "browser_snapshot",
    description:
      "Read the current page's interactive elements (links, buttons, fields, headings) as refs. Refs expire whenever the page changes, so take a fresh one after anything you did not do yourself.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "browser_click",
    description: "Click one element ref. Returns the click result; take a fresh snapshot afterwards if you need new refs.",
    inputSchema: {
      type: "object",
      properties: { ref: REF_PROPERTY },
      required: ["ref"],
    },
  },
  {
    name: "browser_fill",
    description: "Replace the text of one field ref with new text. Set submit true to press Enter afterwards. Never enter passwords or payment details yourself.",
    inputSchema: {
      type: "object",
      properties: { ref: REF_PROPERTY, text: { type: "string", maxLength: 4000 }, submit: { type: "boolean" } },
      required: ["ref", "text"],
    },
  },
  {
    name: "browser_press",
    description: "Press one key: enter, tab, escape, backspace, delete, space, arrowup, arrowdown, arrowleft, arrowright, pageup, pagedown, home, end.",
    inputSchema: { type: "object", properties: { key: { type: "string" } }, required: ["key"] },
  },
  {
    name: "browser_scroll",
    description: "Scroll the page.",
    inputSchema: {
      type: "object",
      properties: {
        direction: { type: "string", enum: ["up", "down", "left", "right"] },
        amount: { type: "integer", minimum: 1, maximum: 5000, description: "Pixels, default 600." },
      },
      required: ["direction"],
    },
  },
  {
    name: "browser_wait_for",
    description:
      "Wait until the page's address contains a substring, then return a fresh snapshot. Bounded by timeout_ms (default 10000, max 30000).",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "A substring the address must contain." },
        timeout_ms: { type: "integer", minimum: 250, maximum: 30000 },
      },
      required: ["url"],
    },
  },
  {
    name: "browser_read",
    description:
      "Read the page's visible text as plain text — for understanding content, not for acting. Use browser_snapshot for things to click.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "browser_back",
    description: "Go back to the previous page.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "browser_state",
    description: "The current page's title and address, without elements. Cheap; use it to confirm where you are.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "browser_screenshot",
    description:
      "See the current page as an image. Use when the accessibility tree is not enough (layout, charts, visual state, video pages). The image is returned alongside a short text header.",
    inputSchema: { type: "object", properties: {} },
  },
] as const;

type ToolContent = { type: "text"; text: string };
type ToolResult = { content: ToolContent[]; isError?: boolean };

function textResult(text: string, isError = false): ToolResult {
  const result: ToolResult = { content: [{ type: "text", text }] };
  if (isError) result.isError = true;
  return result;
}

/** One round trip to the agent-computer API. Errors carry the backend's own
 * sentence — that text is exactly what the model should read. */
async function ac(
  operation: "navigate" | "snapshot" | "read" | "click" | "type" | "key" | "scroll" | "screenshot",
  body: object = {},
): Promise<unknown> {
  if (!BASE || !TOKEN || !BOT) throw new Error("the real-chrome backend is not connected for this bot (OMB_AC_* unset)");
  // Operations arrive WITH their leading slash — compare against the
  // slashed forms or every GET silently degrades to POST (404).
  const isShot = operation === "/screenshot";
  const isGet = isShot || operation === "/read";
  // The screenshot handler wraps capture in an 8 s server-side cap and a
  // cold renderer can exceed one cycle; retries inside the bridge are much
  // cheaper than a failed model turn.
  const attempt = async (): Promise<unknown> =>
    fetch(`${BASE}${operation}`, {
      method: isGet ? "GET" : "POST",
      headers: isGet
        ? { "x-openbot-computer-token": TOKEN, "x-openbot-bot-id": BOT }
        : { "x-openbot-computer-token": TOKEN, "x-openbot-bot-id": BOT, "content-type": "application/json" },
      ...(isGet ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(operation === "navigate" ? 45_000 : isShot ? 12_000 : 20_000),
    });
  const res = isShot
    ? await attempt().catch(() => attempt())
    : await attempt();
  const parsed: unknown = await res.json().catch(() => ({}));
  if (process.env.OMB_DEBUG === "1") console.error(`[bridge] ${operation} url=${new URL(`${BASE}${operation}`).href} res.url=${res.url} -> ${res.status}`);
  if (!res.ok) {
    const message = (parsed as { error?: string }).error ?? `agent-computer: HTTP ${res.status}`;
    throw new Error(message);
  }
  return parsed;
}

/** Same shape the built-in browser returns, built from agent-computer's snapshot. */
function formatObserved(page: { url?: string; title?: string; elements?: { ref: string; role: string; name: string; value?: string; disabled?: boolean; checked?: boolean }[] }): string {
  const url = page.url || "URL unavailable";
  const lines = (page.elements ?? []).map((element) => {
    const flags = [
      element.disabled ? "disabled" : "",
      element.checked === true ? "checked" : "",
      element.value !== undefined ? `value=${JSON.stringify(element.value)}` : "",
    ].filter(Boolean);
    return `${element.ref} ${element.role} ${JSON.stringify(element.name)}${flags.length ? ` (${flags.join(", ")})` : ""}`;
  });
  return [`Browser — ${page.title || "Untitled"}: ${url}`, lines.join("\n") || "No interactive elements found."].join("\n");
}

async function callTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  if (name === "browser_navigate") {
    const page = (await ac("/navigate", { url: String(args.url ?? "") })) as { url?: string; title?: string };
    const snap = (await ac("/snapshot")) as { elements?: unknown[] };
    return textResult(formatObserved({ ...page, elements: snap.elements as never[] }));
  }
  if (name === "browser_snapshot") {
    const snap = (await ac("/snapshot")) as { url?: string; title?: string; elements?: never[] };
    return textResult(formatObserved(snap));
  }
  if (name === "browser_click") {
    const snap = (await ac("/snapshot")) as { snapshotId?: number };
    await ac("/click", { ref: String(args.ref ?? ""), snapshotId: snap.snapshotId });
    const after = (await ac("/snapshot")) as { url?: string; title?: string; elements?: never[] };
    return textResult(formatObserved(after));
  }
  if (name === "browser_fill") {
    const snap = (await ac("/snapshot")) as { snapshotId?: number };
    await ac("/type", { ref: String(args.ref ?? ""), text: String(args.text ?? ""), submit: args.submit === true });
    const after = (await ac("/snapshot")) as { url?: string; title?: string; elements?: never[] };
    return textResult(formatObserved(after));
  }
  if (name === "browser_press") {
    await ac("/key", { key: String(args.key ?? "") });
    return textResult("Key pressed.");
  }
  if (name === "browser_scroll") {
    await ac("/scroll", { direction: String(args.direction ?? "down"), amount: Number(args.amount ?? 600) });
    const after = (await ac("/snapshot")) as { url?: string; title?: string; elements?: never[] };
    return textResult(formatObserved(after));
  }
  if (name === "browser_wait_for") {
    const needle = String(args.url ?? "");
    const timeout = Math.min(30_000, Math.max(250, Number(args.timeout_ms ?? 10_000)));
    const deadline = Date.now() + timeout;
    let last = "";
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 700));
      const page = (await ac("/read")) as { url?: string };
      last = page.url ?? "";
      if (needle && last.includes(needle)) break;
    }
    const snap = (await ac("/snapshot")) as { url?: string; title?: string; elements?: never[] };
    return textResult(formatObserved(snap));
  }
  if (name === "browser_read") {
    const page = (await ac("/read")) as { url?: string; title?: string; text?: string; truncated?: boolean };
    const body = page.text ?? "";
    if (!body.trim()) return textResult(`${page.title || "Untitled"}: ${page.url}\n(The page has no readable text.)`);
    return textResult(`${page.title || "Untitled"}: ${page.url}\n\n${body}${page.truncated ? "\n(truncated)" : ""}`);
  }
  if (name === "browser_back") {
    // agent-computer has no dedicated back endpoint; JavaScript history.back
    // would need an exec path, so the honest answer is a navigation hint.
    return textResult("Going back is not supported on this backend; navigate to the previous address directly with browser_navigate.", true);
  }
  if (name === "browser_state") {
    const page = (await ac("/read")) as { url?: string; title?: string };
    return textResult(`${page.title || "Untitled"}: ${page.url}`);
  }
  if (name === "browser_screenshot") {
    // Image result for vision models: the harness forwards image parts to
    // the model as image content; text-only models see the header instead.
    const shot = (await ac("/screenshot")) as { base64?: string; width?: number; height?: number; url?: string; title?: string };
    if (!shot.base64) return textResult("Screenshot failed: no image data.", true);
    return {
      content: [
        { type: "text", text: `${shot.title || "Untitled"}: ${shot.url} (${shot.width}x${shot.height} PNG)` },
        { type: "image", data: shot.base64, mimeType: "image/png" },
      ],
    };
  }
  return textResult(`Unknown tool: ${name}`, true);
}

const send = (message: object) => process.stdout.write(`${JSON.stringify(message)}\n`);
const ok = (id: unknown, result: unknown) => send({ jsonrpc: "2.0", id, result });
const rpcError = (id: unknown, code: number, message: string) => send({ jsonrpc: "2.0", id, error: { code, message } });

const rpcMessageSchema = zodRpc();
function zodRpc() {
  // Minimal structural check without pulling zod: enough for house JSON-RPC.
  return {
    safeParse(value: unknown) {
      if (typeof value !== "object" || value === null) return { success: false as const };
      const v = value as { id?: unknown; method?: unknown; params?: unknown };
      if (typeof v.method !== "string") return { success: false as const };
      return { success: true as const, data: v };
    },
  };
}

async function handle(line: string) {
  const parsed = rpcMessageSchema.safeParse(JSON.parse(line));
  if (!parsed.success) return;
  const { id, method, params } = parsed.data;
  if (method === "initialize") {
    return ok(id, {
      protocolVersion: (params as { protocolVersion?: string })?.protocolVersion ?? "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "openmausbot-real-chrome", version: "1" },
    });
  }
  if ((method as string).startsWith("notifications/")) return;
  if (method === "ping") return ok(id, {});
  if (method === "tools/list") return ok(id, { tools: TOOLS });
  if (method === "tools/call") {
    const name = String((params as { name?: string })?.name ?? "");
    if (!TOOLS.some((tool) => tool.name === name)) return rpcError(id, -32602, `Unknown tool: ${name}`);
    try {
      return ok(id, await callTool(name, ((params as { arguments?: object })?.arguments ?? {}) as Record<string, unknown>));
    } catch (error) {
      return ok(id, textResult(error instanceof Error ? error.message : String(error), true));
    }
  }
  if (id !== undefined) rpcError(id, -32601, `Method not found: ${String(method)}`);
}

if (process.argv[1] && existsSync(process.argv[1]) && /browser-bridge\.(?:ts|js|mts)$/.test(process.argv[1])) {
  const lines = createInterface({ input: process.stdin, terminal: false });
  lines.on("line", (line) => {
    if (!line.trim()) return;
    handle(line).catch((error) => {
      let id: unknown;
      try {
        id = rpcMessageSchema.safeParse(JSON.parse(line));
      } catch {
        return;
      }
      const pid = (id as { success: boolean; data?: { id?: unknown } }).success ? (id as { data?: { id?: unknown } }).data?.id : undefined;
      rpcError(pid, -32603, error instanceof Error ? error.message : String(error));
    });
  });
  lines.on("close", () => process.exit(0));
}
