// Built-in browser MCP server — spawned inside a bot's agent process (via
// the "browser" integration). The browser itself is a WebContentsView in the
// Electron main process; this proxy forwards each tool call to the loopback
// host in front of it (electron/browser-host.cjs) and turns the reply into
// the text a model reads.
//
// Semantic, not visual: every action hands back a fresh accessibility
// snapshot — element refs (`b<id>`), roles and names — so the bot rarely
// needs a screenshot and never guesses coordinates. Refs are only valid until
// the page changes, which is why each action's result includes the next set.
//
// Speaks raw JSON-RPC 2.0 over stdio (house style: agents-proxy/phone-proxy).
// State comes from env, injected by the harness:
//   OMB_BROWSER_URL    loopback host, e.g. http://127.0.0.1:52144
//   OMB_BROWSER_TOKEN  per-boot bearer secret from browser-connection.json
//   OMB_BOT_ID         which bot's tab to drive (one view per bot)
//   OMB_BROWSER_PROFILE named shared session the bot is pointed at ("" = own)
//   OMB_CONTROL_URL / OMB_CONTROL_TOKEN  who-is-driving endpoint: while the
//                      person holds the wheel in the panel, actions refuse
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { z } from "zod";

import { safeBrowserUrl } from "../computer-observation.ts";
import { CONTROL_REFUSAL, createControlClient } from "../control-client.ts";

const HOST = (process.env.OMB_BROWSER_URL ?? "").replace(/\/$/, "");
const TOKEN = process.env.OMB_BROWSER_TOKEN ?? "";
const BOT_ID = process.env.OMB_BOT_ID ?? "";
const PROFILE = process.env.OMB_BROWSER_PROFILE ?? "";
const control = createControlClient();

// ── what the host answers ────────────────────────────────────────────────
const elementSchema = z.object({
  ref: z.string().min(1),
  role: z.string().min(1),
  name: z.string().default("unnamed"),
  disabled: z.boolean().optional(),
  checked: z.union([z.boolean(), z.literal("mixed")]).optional(),
  value: z.string().optional(),
});
const pageSchema = z.object({
  url: z.string().default(""),
  title: z.string().default(""),
  elements: z.array(elementSchema).default([]),
});
const stateSchema = z.object({ url: z.string().default(""), title: z.string().default(""), loading: z.boolean().optional() });
const screenshotSchema = z.object({ png: z.string().min(1), format: z.string().optional() });
const hostErrorSchema = z.object({ error: z.string().min(1) });

export type ObservedElement = z.infer<typeof elementSchema>;
export type ObservedPage = z.infer<typeof pageSchema>;

// ── what the model sends ─────────────────────────────────────────────────
const refSchema = z.string().trim().min(1, "a ref from browser_snapshot is required");
const navigateArgs = z.object({ url: z.string().trim().min(1, "a url is required") });
const clickArgs = z.object({ ref: refSchema, double: z.boolean().optional() });
const fillArgs = z.object({ ref: refSchema, text: z.string().max(4_000).default("") });
const typeArgs = z.object({ text: z.string().min(1, "text is required").max(4_000) });
const pressArgs = z.object({ key: z.string().trim().min(1, "a key is required") });
const scrollArgs = z.object({
  direction: z.enum(["up", "down", "left", "right"]).default("down"),
  amount: z.number().int().min(1).max(5_000).optional(),
});
const rpcMessageSchema = z.object({
  id: z.unknown().optional(),
  method: z.string().optional(),
  params: z.object({ name: z.string().optional(), arguments: z.unknown().optional(), protocolVersion: z.string().optional() }).optional(),
});

/** The page as the model reads it. URLs are scrubbed of query and fragment
 * before they reach a transcript (session tokens ride in both); the host
 * keeps the real one. */
export function formatObserved(page: ObservedPage): string {
  const url = safeBrowserUrl(page.url) ?? (page.url === "about:blank" ? "about:blank" : "URL unavailable");
  const lines = page.elements.map((element) => {
    const flags = [
      element.disabled ? "disabled" : "",
      element.checked === true ? "checked" : element.checked === "mixed" ? "mixed" : "",
      element.value !== undefined ? `value=${JSON.stringify(element.value)}` : "",
    ].filter(Boolean);
    return `${element.ref} ${element.role} ${JSON.stringify(element.name)}${flags.length ? ` (${flags.join(", ")})` : ""}`;
  });
  return `Browser — ${page.title || "Untitled"}: ${url}\n${lines.join("\n") || "No interactive elements found."}`;
}

export type HostRequest = (operation: string, body?: object) => Promise<unknown>;

/** One round trip to the browser host. A non-2xx reply carries the host's
 * own sentence (stale ref, refused address, no previous page) — that text
 * is exactly what the model should read, so it is thrown as-is. */
export async function hostRequest(operation: string, body: object = {}, fetchImpl: typeof fetch = fetch): Promise<unknown> {
  if (!HOST || !TOKEN || !BOT_ID) throw new Error("the built-in browser is not connected for this bot");
  const res = await fetchImpl(`${HOST}/v1/bots/${encodeURIComponent(BOT_ID)}/${operation}`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ ...body, profile: PROFILE }),
    signal: AbortSignal.timeout(operation === "navigate" ? 30_000 : 20_000),
  });
  const parsed: unknown = await res.json().catch(() => ({}));
  if (!res.ok) {
    const failure = hostErrorSchema.safeParse(parsed);
    throw new Error(failure.success ? failure.data.error : `browser host: HTTP ${res.status}`);
  }
  return parsed;
}

const REF_PROPERTY = { type: "string", description: "An element ref from the latest browser_snapshot, such as b123." } as const;

export const TOOLS = [
  {
    name: "browser_navigate",
    description:
      "Open a web address in this bot's built-in browser tab (the user can watch it in the Browser panel). Returns the page's interactive elements with refs — do not follow it with browser_snapshot.",
    inputSchema: { type: "object", properties: { url: { type: "string", description: "http(s) address; the scheme may be omitted." } }, required: ["url"] },
  },
  {
    name: "browser_snapshot",
    description:
      "Read the current page's interactive elements (links, buttons, fields, headings) as refs. Prefer this over screenshots; refs expire whenever the page changes, so take a fresh one after anything you did not do yourself.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "browser_click",
    description: "Click one element ref. Returns the resulting page's elements.",
    inputSchema: {
      type: "object",
      properties: { ref: REF_PROPERTY, double: { type: "boolean", description: "Double-click instead of a single click." } },
      required: ["ref"],
    },
  },
  {
    name: "browser_fill",
    description: "Replace the text of one field ref with new text, then return the page. Never enter passwords, payment details, or one-time codes — ask the user to do that in the Browser panel.",
    inputSchema: { type: "object", properties: { ref: REF_PROPERTY, text: { type: "string", maxLength: 4000 } }, required: ["ref", "text"] },
  },
  {
    name: "browser_type",
    description: "Type text into whatever currently has focus (after a browser_click on a field). Use browser_fill to replace a field's contents.",
    inputSchema: { type: "object", properties: { text: { type: "string", maxLength: 4000 } }, required: ["text"] },
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
    description: "See the page as an image. Only when the element list is not enough (layout, charts, visual state).",
    inputSchema: { type: "object", properties: {} },
  },
] as const;

type ToolContent = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
type ToolResult = { content: ToolContent[]; isError?: boolean };

function textResult(text: string, isError = false): ToolResult {
  const result: ToolResult = { content: [{ type: "text", text }] };
  if (isError) result.isError = true;
  return result;
}

/** The first problem a schema found, as one sentence the model can act on. */
function argumentError(tool: string, error: z.ZodError): ToolResult {
  const issue = error.issues[0];
  const where = issue?.path.length ? ` (${issue.path.join(".")})` : "";
  return textResult(`${tool}: ${issue?.message ?? "invalid arguments"}${where}`, true);
}

const ACTS = new Set(["browser_navigate", "browser_click", "browser_fill", "browser_type", "browser_press", "browser_scroll", "browser_back"]);

async function observed(request: HostRequest, operation: string, body?: object): Promise<ToolResult> {
  return textResult(formatObserved(pageSchema.parse(await request(operation, body))));
}

export async function callTool(name: string, args: unknown, request: HostRequest = hostRequest): Promise<ToolResult> {
  // The person driving in the panel wins: actions refuse instead of typing
  // over their hands. Reads stay allowed — the bot may still look.
  if (ACTS.has(name) && (await control.state()).held) return textResult(CONTROL_REFUSAL, true);
  if (name === "browser_navigate") {
    const parsed = navigateArgs.safeParse(args);
    if (!parsed.success) return argumentError(name, parsed.error);
    return observed(request, "navigate", { url: parsed.data.url });
  }
  if (name === "browser_snapshot") return observed(request, "snapshot");
  if (name === "browser_click") {
    const parsed = clickArgs.safeParse(args);
    if (!parsed.success) return argumentError(name, parsed.error);
    return observed(request, "click", { ref: parsed.data.ref, double: parsed.data.double === true });
  }
  if (name === "browser_fill") {
    const parsed = fillArgs.safeParse(args);
    if (!parsed.success) return argumentError(name, parsed.error);
    return observed(request, "fill", { ref: parsed.data.ref, text: parsed.data.text });
  }
  if (name === "browser_type") {
    const parsed = typeArgs.safeParse(args);
    if (!parsed.success) return argumentError(name, parsed.error);
    return observed(request, "type", { text: parsed.data.text });
  }
  if (name === "browser_press") {
    const parsed = pressArgs.safeParse(args);
    if (!parsed.success) return argumentError(name, parsed.error);
    return observed(request, "press", { key: parsed.data.key });
  }
  if (name === "browser_scroll") {
    const parsed = scrollArgs.safeParse(args ?? {});
    if (!parsed.success) return argumentError(name, parsed.error);
    return observed(request, "scroll", parsed.data);
  }
  if (name === "browser_back") return observed(request, "back");
  if (name === "browser_state") {
    const state = stateSchema.parse(await request("state"));
    if (!state.url || state.url === "about:blank") return textResult("The browser tab is empty. Use browser_navigate to open a page.");
    return textResult(`${state.title || "Untitled"}: ${safeBrowserUrl(state.url) ?? "URL unavailable"}${state.loading === true ? " (still loading)" : ""}`);
  }
  if (name === "browser_screenshot") {
    const shot = screenshotSchema.parse(await request("screenshot"));
    const mime = shot.format === "png" ? "image/png" : "image/jpeg";
    return { content: [{ type: "text", text: "Current browser page" }, { type: "image", data: shot.png, mimeType: mime }] };
  }
  return textResult(`Unknown tool: ${name}`, true);
}

const send = (message: object) => process.stdout.write(`${JSON.stringify(message)}\n`);
const ok = (id: unknown, result: unknown) => send({ jsonrpc: "2.0", id, result });
const rpcError = (id: unknown, code: number, message: string) => send({ jsonrpc: "2.0", id, error: { code, message } });

async function handle(line: string) {
  const parsed = rpcMessageSchema.safeParse(JSON.parse(line));
  if (!parsed.success) return;
  const { id, method, params } = parsed.data;
  if (method === "initialize") {
    return ok(id, {
      protocolVersion: params?.protocolVersion ?? "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "openmausbot-browser", version: "1" },
    });
  }
  if (method === "notifications/initialized" || method === "notifications/cancelled") return;
  if (method === "ping") return ok(id, {});
  if (method === "tools/list") return ok(id, { tools: TOOLS });
  if (method === "tools/call") {
    const name = params?.name ?? "";
    if (!TOOLS.some((tool) => tool.name === name)) return rpcError(id, -32602, `Unknown tool: ${name}`);
    try {
      return ok(id, await callTool(name, params?.arguments ?? {}));
    } catch (error) {
      return ok(id, textResult(error instanceof Error ? error.message : String(error), true));
    }
  }
  if (id !== undefined) rpcError(id, -32601, `Method not found: ${String(method)}`);
}

if (process.argv[1] && existsSync(process.argv[1]) && /browser-proxy\.(?:ts|js)$/.test(process.argv[1])) {
  const lines = createInterface({ input: process.stdin, terminal: false });
  lines.on("line", (line) => {
    if (!line.trim()) return;
    handle(line).catch((error) => {
      let id: unknown;
      try {
        id = rpcMessageSchema.parse(JSON.parse(line)).id;
      } catch {
        return;
      }
      rpcError(id, -32603, error instanceof Error ? error.message : String(error));
    });
  });
  lines.on("close", () => process.exit(0));
}
