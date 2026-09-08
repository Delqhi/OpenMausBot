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

const DRIVER_KIND = "dsh";
const DEFAULT_URL = "http://127.0.0.1:3080";
const TURN_TIMEOUT_MS = 10 * 60_000;
const POLL_MS = 100;

export interface DshConfig {
  url: string;
  agentPreset?: string;
}

const MODELS: ModelCatalog = {
  default: "dsh-default",
  options: [{ id: "dsh-default", label: "DSH configured model", custom: true }],
};

function decodeConfig(raw: unknown): DshConfig {
  const value = (raw ?? {}) as Record<string, unknown>;
  const rawUrl = typeof value.url === "string" && value.url.trim() ? value.url.trim() : DEFAULT_URL;
  const url = new URL(rawUrl);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname)) {
    throw new Error("DSH endpoint must be a loopback HTTP URL");
  }
  return {
    url: rawUrl.replace(/\/+$/, ""),
    ...(typeof value.agentPreset === "string" && value.agentPreset.trim()
      ? { agentPreset: value.agentPreset.trim() }
      : {}),
  };
}

type DshEvent = { event: { type: string; seq: number; data: any } };

class DshRpcClient {
  private readonly baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
  }

  async call<T>(method: string, payload: unknown, signal?: AbortSignal): Promise<T> {
    const rpcId = crypto.randomUUID();
    const timeout = AbortSignal.timeout(TURN_TIMEOUT_MS);
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const response = await fetch(`${this.baseUrl}/api/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "client-request", rpcId, method, payload }),
      signal: requestSignal,
    });
    if (!response.ok) throw new Error(`DSH ${method} transport failed: HTTP ${response.status}`);
    const message: any = await response.json();
    if (message?.type !== "server-response" || message?.rpcId !== rpcId) {
      throw new Error(`DSH ${method} returned an invalid RPC envelope`);
    }
    if (!message.result?.ok) {
      throw new Error(message.result?.error?.message ?? `DSH ${method} failed`);
    }
    return message.result.value as T;
  }
}

function latestSeq(events: DshEvent[]): number {
  return events.reduce((max, row) => Math.max(max, Number(row.event?.seq ?? -1)), -1);
}

function finalAssistant(events: DshEvent[], afterSeq: number): { text: string; usage?: { input: number; output: number } } {
  let text = "";
  let usage: { input: number; output: number } | undefined;
  for (const row of events) {
    const event = row.event;
    if (!event || event.seq <= afterSeq || event.type !== "assistant/message") continue;
    const content = Array.isArray(event.data?.message?.content) ? event.data.message.content : [];
    const answer = content
      .filter((part: any) => part?.type === "text" && typeof part.text === "string")
      .map((part: any) => part.text)
      .join("");
    if (answer) text = answer;
    const reported = event.data?.usage;
    if (reported && Number.isFinite(reported.inputTokens) && Number.isFinite(reported.outputTokens)) {
      usage = { input: reported.inputTokens, output: reported.outputTokens };
    }
  }
  return { text, ...(usage ? { usage } : {}) };
}

async function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

export const DshDriver: ProviderDriver<DshConfig> = {
  driverKind: DRIVER_KIND,
  metadata: { displayName: "DeepSeek Harness (BrowserSkill)", supportsMultipleInstances: true, access: "custom" },
  install: { docsUrl: "https://github.com/deepseek-ai/deepseek-harness" },
  models: MODELS,
  decodeConfig,
  defaultConfig: () => decodeConfig({}),

  async create(input: DriverCreateInput<DshConfig>): Promise<ProviderInstance> {
    const { instanceId, config } = input;
    const client = new DshRpcClient(config.url);
    const listeners = new Set<RuntimeEventListener>();
    const sessions = new Map<string, string>();
    const active = new Map<string, { turnId: string; abort: AbortController }>();

    const emit = (event: RuntimeEvent) => {
      for (const listener of [...listeners]) listener(event);
    };
    const base = (threadId: string, turnId: string) => ({
      eventId: newEventId(),
      provider: DRIVER_KIND,
      providerInstanceId: instanceId,
      threadId,
      turnId,
      createdAt: new Date().toISOString(),
    });
    const history = (sessionId: string, signal?: AbortSignal) =>
      client.call<{ events: DshEvent[]; hasMore: boolean }>("session.history", { sessionId, maxMessages: 500 }, signal);

    const ensureSession = async (turn: SendTurnInput): Promise<string> => {
      const existing = sessions.get(turn.threadId);
      if (existing) return existing;
      const payload = {
        ...(turn.cwd ? { cwd: turn.cwd } : {}),
        ...(config.agentPreset ? { agentPreset: config.agentPreset } : {}),
      };
      const created = await client.call<{ sessionId: string }>("session.create", payload);
      sessions.set(turn.threadId, created.sessionId);
      return created.sessionId;
    };

    const sendTurn = async (turn: SendTurnInput) => {
      if (active.has(turn.threadId)) throw new Error("a turn is already running on this thread");
      const sessionId = await ensureSession(turn);
      const before = await history(sessionId);
      const baselineSeq = latestSeq(before.events);
      const turnId = newId();
      const abort = new AbortController();
      active.set(turn.threadId, { turnId, abort });
      emit({ ...base(turn.threadId, turnId), type: "turn.started" });
      emit({ ...base(turn.threadId, turnId), type: "session.started", sessionId, model: null });

      void (async () => {
        try {
          const prompt = turn.system ? `${turn.system}\n\n${turn.text}` : turn.text;
          await client.call(
            "session.prompt",
            { sessionId, mode: "queue", content: [{ type: "text", text: prompt }] },
            abort.signal,
          );
          let completed: DshEvent[] | null = null;
          while (!completed) {
            const current = await history(sessionId, abort.signal);
            const done = current.events.some(
              (row) => row.event?.seq > baselineSeq && row.event?.type === "turn/end",
            );
            if (done) completed = current.events;
            else await sleep(POLL_MS, abort.signal);
          }
          const answer = finalAssistant(completed, baselineSeq);
          if (answer.text) {
            emit({ ...base(turn.threadId, turnId), type: "item.completed", itemType: "assistant_text", text: answer.text });
          }
          if (answer.usage) {
            emit({ ...base(turn.threadId, turnId), type: "thread.token-usage.updated", ...answer.usage });
          }
          emit({
            ...base(turn.threadId, turnId),
            type: "turn.completed",
            ok: true,
            stopReason: null,
            cost: null,
            ...(answer.usage ? { usage: answer.usage } : {}),
          });
        } catch (error) {
          const aborted = abort.signal.aborted;
          if (!aborted) {
            emit({ ...base(turn.threadId, turnId), type: "runtime.error", message: error instanceof Error ? error.message : String(error) });
          }
          emit({ ...base(turn.threadId, turnId), type: "turn.completed", ok: false, stopReason: aborted ? "interrupted" : "error", cost: null });
        } finally {
          active.delete(turn.threadId);
        }
      })();
      return { turnId };
    };

    const snapshot = async (): Promise<ProviderSnapshot> => {
      try {
        await client.call("session.list", {});
        return { state: "available", authenticated: true, version: null, billing: "subscription" };
      } catch (error) {
        return { state: "unavailable", reason: error instanceof Error ? error.message : String(error) };
      }
    };

    return {
      instanceId,
      driverKind: DRIVER_KIND,
      displayName: input.displayName,
      enabled: input.enabled,
      models: MODELS,
      snapshot,
      adapter: {
        provider: DRIVER_KIND,
        capabilities: { sessionModelSwitch: "unsupported", queueing: true },
        sendTurn,
        interruptTurn: async (threadId) => {
          active.get(threadId)?.abort.abort();
          const sessionId = sessions.get(threadId);
          if (sessionId) await client.call("session.cancel", { sessionId });
        },
        respondToRequest: async () => "unavailable" as const,
        steer: async (threadId, text) => {
          const sessionId = sessions.get(threadId);
          if (!sessionId) return false;
          await client.call("session.prompt", { sessionId, mode: "steer", content: [{ type: "text", text }] });
          return true;
        },
        hasSession: (threadId) => sessions.has(threadId),
        stopAll: async () => {
          const entries = [...active.entries()];
          for (const [, state] of entries) state.abort.abort();
          await Promise.allSettled(entries.map(([threadId]) => {
            const sessionId = sessions.get(threadId);
            return sessionId ? client.call("session.cancel", { sessionId }) : Promise.resolve();
          }));
        },
        onEvent: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
      dispose: async () => {
        for (const state of active.values()) state.abort.abort();
        listeners.clear();
      },
    };
  },
};
