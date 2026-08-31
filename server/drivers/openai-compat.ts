// OpenAI-compatible driver — any endpoint that speaks the OpenAI
// chat-completions shape (OpenRouter, Groq, Together, a local llama.cpp,
// …). This is the "free models" entry point: point it at OpenRouter's
// free tier or Groq's open-model endpoints and a bot runs without a
// paid Claude/Codex/Grok subscription.
//
// Transcript-replay like grok.ts: the harness folds thread history and
// hands it back each turn (SendTurnInput.transcript); we emit true
// token-level content.delta events and supply generateText.
import type {
  DriverCreateInput,
  ModelCatalog,
  ProviderDriver,
  ProviderInstance,
  ProviderSnapshot,
  RuntimeEvent,
  RuntimeEventListener,
  SendTurnInput,
} from "../contracts.ts";
import { newEventId, newId } from "../contracts.ts";
import { appendNative } from "./native.ts";

const DRIVER_KIND = "openai-compat";

// Default catalog — overwritten by /models when the endpoint answers.
// Free-tier-friendly defaults so the picker is never empty.
// Every option here is `custom`: this engine advertises `access: "custom"`,
// and the picker renders only custom-flagged options for such engines. An
// unflagged option lands in the official list the picker never shows, which
// reads as "no models found" on a perfectly configured endpoint.
const DEFAULT_MODELS: ModelCatalog = {
  default: "meta-llama/llama-3.3-70b-instruct",
  options: [
    { id: "meta-llama/llama-3.3-70b-instruct", label: "Llama 3.3 70B (OpenRouter)", custom: true },
    { id: "llama-3.3-70b-versatile", label: "Llama 3.3 70B (Groq)", custom: true },
  ],
};

export interface OpenAICompatConfig {
  /** Base URL, no trailing /v1 assumed — we append /chat/completions. */
  url: string;
  /** Env var (instance environment or process.env) carrying the API key. */
  apiKeyEnv: string;
  /** Direct API key if configured */
  key?: string;
  /** Default model when a turn doesn't specify one (seeds the picker). */
  model?: string;
  /** OpenRouter upstream provider slug to pin (e.g. "fireworks"). Sent as
   * `provider: { order: [provider], allow_fallbacks: false }` — but only to
   * OpenRouter endpoints: strict OpenAI-compatible servers (Groq et al.)
   * reject unknown top-level fields. */
  provider?: string;
}

/** True when the configured base URL points at OpenRouter (openrouter.ai or
 * a subdomain). Parses the hostname rather than substring-matching the whole
 * URL, so lookalike domains and path segments don't count. */
function isOpenRouterUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "openrouter.ai" || host.endsWith(".openrouter.ai");
  } catch {
    return false;
  }
}

function decodeConfig(raw: unknown): OpenAICompatConfig {
  const o = (raw ?? {}) as Record<string, unknown>;
  const envUrl = process.env.OPENAI_COMPAT_URL;
  const envModel = process.env.OPENAI_COMPAT_MODEL;
  const envProvider = process.env.OPENAI_COMPAT_PROVIDER;
  return {
    url:
      typeof o.url === "string" && o.url
        ? o.url.replace(/\/+$/, "")
        : envUrl
          ? envUrl.replace(/\/+$/, "")
          : "https://openrouter.ai/api/v1",
    apiKeyEnv: typeof o.apiKeyEnv === "string" && o.apiKeyEnv ? o.apiKeyEnv : "OPENAI_COMPAT_API_KEY",
    key: typeof o.key === "string" && o.key ? o.key : undefined,
    model: typeof o.model === "string" && o.model ? o.model : envModel || undefined,
    provider: typeof o.provider === "string" && o.provider ? o.provider : envProvider || undefined,
  };
}

/** Parse a model-provided tool-call arguments string. An empty string is the
 * common "no arguments" case, not an error; malformed JSON degrades to an
 * empty object the tool can reject with its own message. */
function safeToolArguments(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "string" || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Minimal stdio JSON-RPC 2.0 client for one MCP server (house style:
 * browser-proxy/agents-proxy speak the same wire format). Lifetime is one
 * turn: started before the first tools/list, stopped when the turn ends.
 */
class StdioMcpClient {
  private readonly spec: { command: string; args: string[]; env: Record<string, string> };
  private child: ReturnType<typeof import("node:child_process").spawn> | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private buffer = "";

  constructor(spec: { command: string; args: string[]; env: Record<string, string> }) {
    this.spec = spec;
  }

  async start(): Promise<void> {
    const { spawn } = await import("node:child_process");
    this.child = spawn(this.spec.command, this.spec.args, {
      env: { ...process.env, ...this.spec.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout!.setEncoding("utf8");
    this.child.stdout!.on("data", (chunk: string) => {
      this.buffer += chunk;
      let nl;
      while ((nl = this.buffer.indexOf("\n")) !== -1) {
        const line = this.buffer.slice(0, nl).trim();
        this.buffer = this.buffer.slice(nl + 1);
        if (!line) continue;
        try {
          const message = JSON.parse(line);
          const pending = this.pending.get(message.id);
          if (!pending) continue;
          this.pending.delete(message.id);
          if (message.error) pending.reject(new Error(message.error.message ?? "MCP error"));
          else pending.resolve(message.result);
        } catch {
          // a malformed line is noise, not a failed request
        }
      }
    });
    this.child.stderr!.on("data", () => {});
    await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "openmausbot-openai-compat", version: "1" },
    });
    this.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  }

  private send(message: object): void {
    this.child?.stdin?.write(`${JSON.stringify(message)}\n`);
  }

  request(method: string, params: object, timeoutMs = 45_000): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`MCP ${method} timed out`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  async stop(): Promise<void> {
    for (const pending of this.pending.values()) pending.reject(new Error("client stopped"));
    this.pending.clear();
    this.child?.stdin?.end();
    this.child?.kill();
    this.child = null;
  }
}

export const OpenAICompatDriver: ProviderDriver<OpenAICompatConfig> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "OpenAI-compatible (OpenRouter / Groq)",
    supportsMultipleInstances: true,
    access: "custom",
  },
  models: DEFAULT_MODELS,
  // No CLI to install — the "install" is getting a free API key.
  install: {
    docsUrl: "https://openrouter.ai/keys",
    signInCommand:
      "add {\"openaiCompat\":{\"key\":\"sk-or-v1-…\"}} to ~/.openmausbot/config.json (or set OPENAI_COMPAT_API_KEY)",
    command: {
      darwin:
        "Get a free key at https://openrouter.ai/keys (or https://console.groq.com) then add it to ~/.openmausbot/config.json under openaiCompat.key",
      linux:
        "Get a free key at https://openrouter.ai/keys (or https://console.groq.com) then add it to ~/.openmausbot/config.json under openaiCompat.key",
      win32:
        "Get a free key at https://openrouter.ai/keys (or https://console.groq.com) then add it to %USERPROFILE%\\.openmausbot\\config.json under openaiCompat.key",
    },
  },
  decodeConfig,
  defaultConfig: () => decodeConfig({}),

  async create(input: DriverCreateInput<OpenAICompatConfig>): Promise<ProviderInstance> {
    const { instanceId, config } = input;
    const apiKey =
      config.key ??
      input.environment[config.apiKeyEnv] ??
      input.environment["OPENAI_COMPAT_API_KEY"] ??
      process.env[config.apiKeyEnv] ??
      process.env["OPENAI_COMPAT_API_KEY"] ??
      "";
    const listeners = new Set<RuntimeEventListener>();
    const active = new Map<string, { abort: AbortController; turnId: string }>();
    // A configured default model seeds the picker so the intended model is
    // pre-selected before /models refreshes the catalog from the endpoint.
    let catalog: ModelCatalog = config.model
      ? {
          default: config.model,
          options: DEFAULT_MODELS.options.some((o) => o.id === config.model)
            ? DEFAULT_MODELS.options
            : [{ id: config.model, label: config.model, custom: true }, ...DEFAULT_MODELS.options],
        }
      : DEFAULT_MODELS;

    const emit = (event: RuntimeEvent) => {
      for (const l of [...listeners]) l(event);
    };
    const base = (threadId: string, turnId: string) => ({
      eventId: newEventId(),
      provider: DRIVER_KIND,
      threadId,
      turnId,
      createdAt: new Date().toISOString(),
    });

    const complete = async (
      messages: Array<Record<string, unknown>>,
      model: string,
      opts: {
        stream: boolean;
        signal?: AbortSignal;
        tools?: Array<{ type: string; function: { name: string; description?: string; parameters: object } }>;
        onDelta?: (d: string, streamKind?: "assistant_text" | "reasoning_text") => void;
      },
    ): Promise<{
      text: string;
      reasoning: string;
      usage: { input: number; output: number } | null;
      toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown>; raw: object }>;
    }> => {
      const res = await fetch(`${config.url}/chat/completions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model,
          messages,
          ...(opts.tools?.length ? { tools: opts.tools, tool_choice: "auto" } : {}),
          stream: opts.stream,
          // OpenRouter routing: pin the upstream provider when configured —
          // only on OpenRouter itself; strict endpoints reject the field.
          ...(config.provider && isOpenRouterUrl(config.url)
            ? { provider: { order: [config.provider], allow_fallbacks: false } }
            : {}),
        }),
        signal: opts.signal ?? AbortSignal.timeout(120_000),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(
          `upstream HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}`,
        );
      }
      if (!opts.stream) {
        const json: any = await res.json();
        const msg = json.choices?.[0]?.message;
        const mainContent = typeof msg?.content === "string" ? msg.content : "";
        const reasoningContent = typeof msg?.reasoning_content === "string" ? msg.reasoning_content : "";
        const toolCalls = Array.isArray(msg?.tool_calls)
          ? msg.tool_calls
              .filter((call: any) => call?.function?.name)
              .map((call: any, index: number) => ({
                id: call.id ?? `call_${index}`,
                name: call.function.name,
                arguments: safeToolArguments(call.function.arguments),
                raw: call,
              }))
          : [];
        return {
          text: mainContent,
          reasoning: reasoningContent,
          usage: json.usage
            ? {
                input: json.usage.prompt_tokens ?? 0,
                output: json.usage.completion_tokens ?? 0,
              }
            : null,
          toolCalls,
        };
      }
      let text = "";
      let reasoning = "";
      let usage: { input: number; output: number } | null = null;
      const streamToolCalls: Array<{ id: string; name: string; arguments: string; raw: object | null }> = [];
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (data === "[DONE]") continue;
          let chunk: any;
          try {
            chunk = JSON.parse(data);
          } catch {
            continue;
          }
          const delta = chunk.choices?.[0]?.delta;
          const contentDelta = typeof delta?.content === "string" ? delta.content : undefined;
          const reasoningDelta = typeof delta?.reasoning_content === "string" ? delta.reasoning_content : undefined;
          if (reasoningDelta) {
            reasoning += reasoningDelta;
            opts.onDelta?.(reasoningDelta, "reasoning_text");
          }
          if (contentDelta) {
            text += contentDelta;
            opts.onDelta?.(contentDelta, "assistant_text");
          }
          if (chunk.usage) {
            usage = {
              input: chunk.usage.prompt_tokens ?? 0,
              output: chunk.usage.completion_tokens ?? 0,
            };
          }
          // Streaming tool calls arrive as indexed deltas on delta.tool_calls.
          const toolDeltas = Array.isArray(delta?.tool_calls) ? delta.tool_calls : [];
          for (const toolDelta of toolDeltas) {
            const index = typeof toolDelta.index === "number" ? toolDelta.index : streamToolCalls.length;
            while (streamToolCalls.length <= index) {
              streamToolCalls.push({ id: "", name: "", arguments: "", raw: null });
            }
            const pending = streamToolCalls[index];
            if (toolDelta.id) pending.id = toolDelta.id;
            if (toolDelta.function?.name) pending.name += toolDelta.function.name;
            if (typeof toolDelta.function?.arguments === "string") pending.arguments += toolDelta.function.arguments;
          }
        }
      }
      const toolCalls = streamToolCalls
        .filter((call) => call.name)
        .map((call) => ({
          id: call.id || `call_${streamToolCalls.indexOf(call)}`,
          name: call.name,
          arguments: safeToolArguments(call.arguments),
          raw: {
            id: call.id || `call_${streamToolCalls.indexOf(call)}`,
            type: "function",
            function: { name: call.name, arguments: call.arguments },
          },
        }));
      return { text, reasoning, usage, toolCalls };
    };

    const fetchModels = async (): Promise<void> => {
      if (!apiKey) return;
      try {
        const res = await fetch(`${config.url}/models`, {
          headers: { authorization: `Bearer ${apiKey}` },
          signal: AbortSignal.timeout(8_000),
        });
        if (!res.ok) return;
        const json: any = await res.json();
        const rows: Array<{ id?: unknown; name?: unknown }> = Array.isArray(json)
          ? json
          : Array.isArray(json?.data)
            ? json.data
            : [];
        const seen = new Set<string>();
        const options: ModelCatalog["options"] = [];
        for (const row of rows) {
          const id = typeof row.id === "string" ? row.id : "";
          if (!id || seen.has(id)) continue;
          seen.add(id);
          const label =
            typeof row.name === "string" && row.name.trim()
              ? row.name
              : id;
          options.push({ id, label, custom: true });
        }
        if (options.length) {
          // Keep a configured default selected; surface it even if the
          // endpoint's catalog omits it.
          const preferred =
            config.model && (options.some((o) => o.id === config.model) ? config.model : null);
          if (config.model && !preferred) options.unshift({ id: config.model, label: config.model, custom: true });
          catalog = { default: config.model ?? options[0].id, options };
        }
      } catch {
        // keep DEFAULT_MODELS — never fail the instance on a catalog miss
      }
    };
    if (apiKey) void fetchModels();

    const sendTurn = async (turn: SendTurnInput) => {
      const { threadId } = turn;
      if (!apiKey) {
        throw new Error(
          `no API key — set ${config.apiKeyEnv} or add it to the instance config`,
        );
      }
      if (active.has(threadId)) {
        throw new Error("a turn is already running on this thread");
      }
      const turnId = newId();
      const abort = new AbortController();
      active.set(threadId, { abort, turnId });

      const messages: Array<Record<string, unknown>> = [
        ...(turn.system ? [{ role: "system", content: turn.system }] : []),
        ...(turn.transcript ?? []).map((m) => ({
          role: m.role === "assistant" ? "assistant" : "user",
          content: m.text,
        })),
        { role: "user", content: turn.text },
      ];
      appendNative(threadId, {
        dir: "out",
        source: "openai-compat.chat.completions",
        // Native logs are diagnostic artifacts users commonly attach to
        // issues. Keep routing metadata, not prompts or transcript content.
        msg: { model: turn.model ?? catalog.default, messageCount: messages.length },
      });

      emit({ ...base(threadId, turnId), type: "turn.started" });
      emit({
        ...base(threadId, turnId),
        type: "session.started",
        sessionId: null,
        model: turn.model ?? catalog.default,
      });

      (async () => {
        try {
          /*
           * Tool loop with native chat-completions tool calling. The browser
           * (and agents) integration arrives as a generic stdio MCP server;
           * its tools are listed once per turn and executed on loop until the
           * model answers without tool calls. This bypasses the codex
           * namespace representation entirely — glm sees real, fully
           * schematized function tools.
           */
          const mcpServers = [
            ...(turn.integrations?.browser ? [["browser", turn.integrations.browser] as const] : []),
            ...(turn.integrations?.agents ? [["agents", turn.integrations.agents] as const] : []),
            // Host desktop / Local VM / cloud computer arrive as MCP servers
            // with the same stdio shape — the model addresses them by
            // namespace (computer__…).
            ...(turn.integrations?.localComputer
              ? [["computer", turn.integrations.localComputer] as const]
              : []),
          ];
          const mcpClients = mcpServers.map(([name, spec]) => ({
            name,
            client: new StdioMcpClient(spec),
          }));
          await Promise.all(mcpClients.map((c) => c.client.start()));
          const toolsPayload = (
            await Promise.all(
              mcpClients.map(async (c) => {
                try {
                  const tools = (await c.client.request("tools/list", {})) as {
                    tools?: Array<{ name: string; description?: string; inputSchema?: object }>;
                  };
                  return (tools.tools ?? []).map((tool) => ({
                    type: "function",
                    function: {
                      // Namespaced, collision-free, and unambiguous for the model.
                      name: `${c.name}__${tool.name}`,
                      description: tool.description ?? "",
                      parameters: tool.inputSchema ?? { type: "object", properties: {} },
                    },
                  }));
                } catch {
                  return [];
                }
              }),
            )
          ).flat();

          type ChatMessage = Record<string, unknown>;
          const chat: ChatMessage[] = [...messages];
          let totalUsage: { input: number; output: number } | null = null;
          let finalText = "";
          let finalReasoning = "";

          for (let hop = 0; hop < 12; hop += 1) {
            const { text, reasoning, usage, toolCalls } = await complete(
              chat,
              turn.model || catalog.default,
              {
                stream: true,
                signal: abort.signal,
                tools: toolsPayload.length ? toolsPayload : undefined,
                onDelta: (delta, streamKind = "assistant_text") =>
                  emit({
                    ...base(threadId, turnId),
                    type: "content.delta",
                    streamKind,
                    delta,
                  }),
              },
            );
            if (usage) {
              totalUsage = totalUsage
                ? {
                    input: totalUsage.input + usage.input,
                    output: totalUsage.output + usage.output,
                  }
                : usage;
            }
            if (!toolCalls.length) {
              finalText = text;
              finalReasoning = reasoning;
              break;
            }
            // The assistant's tool-call turn becomes part of the transcript,
            // then each result is appended as a tool message.
            chat.push({
              role: "assistant",
              content: text || null,
              ...(toolCalls.length ? { tool_calls: toolCalls.map((call) => call.raw) } : {}),
            });
            for (const call of toolCalls) {
              const client = mcpClients.find((c) => call.name.startsWith(`${c.name}__`));
              if (!client) {
                chat.push({ role: "tool", tool_call_id: call.id, content: `Unknown tool namespace: ${call.name}` });
                continue;
              }
              try {
                // One cold-start retry: the first MCP round trip of a fresh
                // client pair can time out while the CLI process spins up
                // (observed with the real-chrome bridge on a cold turn). The
                // second attempt lands on a warm process, which is why the
                // retry lives here and not at the transport layer.
                let result: { content?: Array<{ type: string; text?: string }> };
                try {
                  result = (await client.client.request("tools/call", {
                    name: call.name.slice(client.name.length + 2),
                    arguments: call.arguments,
                  })) as { content?: Array<{ type: string; text?: string }> };
                } catch (firstError) {
                  const message = firstError instanceof Error ? firstError.message : String(firstError);
                  if (!/timed out/i.test(message)) throw firstError;
                  result = (await client.client.request("tools/call", {
                    name: call.name.slice(client.name.length + 2),
                    arguments: call.arguments,
                  })) as { content?: Array<{ type: string; text?: string }> };
                }
                const payload = (result.content ?? [])
                  .map((part) => (part.type === "text" ? part.text : `[${part.type}]`))
                  .join("\n");
                chat.push({ role: "tool", tool_call_id: call.id, content: payload || "(no content)" });
              } catch (error) {
                chat.push({
                  role: "tool",
                  tool_call_id: call.id,
                  content: error instanceof Error ? error.message : String(error),
                });
              }
            }
          }

          appendNative(threadId, {
            dir: "in",
            source: "openai-compat.chat.completions",
            msg: { textLength: finalText.length, reasoningLength: finalReasoning.length, usage: totalUsage },
          });
          const replyText = finalText.trim()
            ? finalText
            : finalReasoning.trim()
              ? finalReasoning
              : "(no content)";
          if (replyText.trim()) {
            emit({
              ...base(threadId, turnId),
              type: "item.completed",
              itemType: "assistant_text",
              text: replyText,
            });
          }
          if (totalUsage) {
            emit({
              ...base(threadId, turnId),
              type: "thread.token-usage.updated",
              ...totalUsage,
            });
          }
          await Promise.allSettled(mcpClients.map((c) => c.client.stop()));
          active.delete(threadId);
          emit({
            ...base(threadId, turnId),
            type: "turn.completed",
            ok: true,
            stopReason: null,
            cost: null,
            ...(totalUsage ? { usage: totalUsage } : {}),
          });
        } catch (e) {
          active.delete(threadId);
          const aborted = (e as Error).name === "AbortError";
          if (!aborted) {
            emit({
              ...base(threadId, turnId),
              type: "runtime.error",
              message: (e as Error).message,
            });
          }
          emit({
            ...base(threadId, turnId),
            type: "turn.completed",
            ok: false,
            stopReason: aborted ? "interrupted" : "error",
            cost: null,
          });
        }
      })();

      return { turnId };
    };

    const snapshot = async (): Promise<ProviderSnapshot> => {
      if (!apiKey) {
        return {
          state: "unavailable",
          reason: `no API key — set ${config.apiKeyEnv} or add it to the instance config`,
        };
      }
      return { state: "available", authenticated: true, version: null, billing: "metered" };
    };

    return {
      instanceId,
      driverKind: DRIVER_KIND,
      displayName: input.displayName,
      enabled: input.enabled,
      get models() {
        return catalog;
      },
      refreshModels: fetchModels,
      snapshot,
      adapter: {
        provider: DRIVER_KIND,
        capabilities: {
          sessionModelSwitch: "in-session",
          // The driver implements browser (and agents) tools natively over
          // chat-completions function calling — the reason this driver
          // exists: non-OpenAI models get real function tools without the
          // codex namespace representation. computer/localComputer ride the
          // same MCP stdio mounting (cua-driver / Local VM proxies).
          browserMcp: true,
          agentsMcp: true,
          computerMcp: true,
          localComputerMcp: true,
        },
        sendTurn,
        interruptTurn: async (threadId) => active.get(threadId)?.abort.abort(),
        respondToRequest: async () => "unavailable" as const,
        hasSession: (threadId) => active.has(threadId),
        stopAll: async () => {
          for (const { abort } of active.values()) abort.abort();
        },
        onEvent: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
      generateText: async (prompt: string) => {
        const { text, reasoning } = await complete(
          [{ role: "user", content: prompt }],
          catalog.default,
          { stream: false },
        );
        return text.trim() ? text : reasoning;
      },
      dispose: async () => {
        for (const { abort } of active.values()) abort.abort();
        listeners.clear();
      },
    };
  },
};
