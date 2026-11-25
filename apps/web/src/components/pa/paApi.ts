import { readDesktopPrimaryBearerToken } from "../../environments/primary/desktopAuth";
import { resolvePrimaryEnvironmentHttpUrl } from "../../environments/primary/target";
import type {
  PaAdapterStatus,
  PaBotDetail,
  PaBotSummary,
  PaCreateBotInput,
  PaCronJob,
  PaCronMutationInput,
  PaMessage,
  PaRespondRequestInput,
  PaSendResult,
  PaSessionSummary,
  PaSlashCommand,
  PaStreamEvent,
  PaUpdateBotInput,
} from "./paTypes";

function isSameOriginBrowser(): boolean {
  if (
    typeof window === "undefined" ||
    window.desktopBridge !== undefined ||
    !window.location.origin.startsWith("http")
  ) {
    return false;
  }
  return new URL(resolvePrimaryEnvironmentHttpUrl("/")).origin === window.location.origin;
}

async function buildAuthInit(extraHeaders?: Record<string, string>): Promise<{
  readonly headers: Record<string, string>;
  readonly credentials: RequestCredentials;
}> {
  const headers: Record<string, string> = { ...extraHeaders };
  if (isSameOriginBrowser()) {
    return { headers, credentials: "include" };
  }
  const bearer = await readDesktopPrimaryBearerToken().catch(() => null);
  if (bearer) {
    headers.authorization = `Bearer ${bearer}`;
  }
  return { headers, credentials: "omit" };
}

async function requestJson<T>(
  path: string,
  options?: {
    readonly method?: "GET" | "POST" | undefined;
    readonly searchParams?: Record<string, string> | undefined;
    readonly body?: unknown;
    readonly signal?: AbortSignal | undefined;
  },
): Promise<T> {
  const url = resolvePrimaryEnvironmentHttpUrl(`/api/pa${path}`, options?.searchParams);
  const method = options?.method ?? "GET";
  const auth = await buildAuthInit(
    options?.body !== undefined ? { "content-type": "application/json" } : undefined,
  );
  const response = await fetch(url, {
    method,
    cache: "no-store",
    credentials: auth.credentials,
    headers: auth.headers,
    ...(options?.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    ...(options?.signal ? { signal: options.signal } : {}),
  });
  const payload = (await response.json().catch(() => ({}))) as { error?: string } & T;
  if (!response.ok) {
    throw new Error(payload.error || `Request failed (${response.status})`);
  }
  return payload;
}

const enc = (value: string) => encodeURIComponent(value);

export const paApi = {
  listBots(signal?: AbortSignal) {
    return requestJson<{
      readonly adapters: ReadonlyArray<PaAdapterStatus>;
      readonly bots: ReadonlyArray<PaBotSummary>;
    }>("/bots", { signal });
  },

  createBot(input: PaCreateBotInput) {
    return requestJson<{ readonly bot: PaBotSummary }>("/bots", {
      method: "POST",
      body: input,
    }).then((res) => res.bot);
  },

  getBotDetail(botId: string, signal?: AbortSignal) {
    return requestJson<{ readonly bot: PaBotDetail }>(`/bots/${enc(botId)}`, { signal }).then(
      (res) => res.bot,
    );
  },

  updateBot(botId: string, patch: PaUpdateBotInput) {
    return requestJson<{ readonly bot: PaBotDetail }>(`/bots/${enc(botId)}/update`, {
      method: "POST",
      body: patch,
    }).then((res) => res.bot);
  },

  manageCron(botId: string, input: PaCronMutationInput) {
    return requestJson<{ readonly cronJobs: ReadonlyArray<PaCronJob> }>(
      `/bots/${enc(botId)}/cron`,
      {
        method: "POST",
        body: input,
      },
    ).then((res) => res.cronJobs);
  },

  listSlashCommands(botId: string, signal?: AbortSignal) {
    return requestJson<{ readonly commands: ReadonlyArray<PaSlashCommand> }>(
      `/bots/${enc(botId)}/commands`,
      { signal },
    ).then((res) => res.commands);
  },

  listSessions(botId: string, signal?: AbortSignal) {
    return requestJson<{
      readonly primarySessionId: string | null;
      readonly sessions: ReadonlyArray<PaSessionSummary>;
    }>(`/bots/${enc(botId)}/sessions`, { signal });
  },

  createSession(botId: string, setPrimary = true) {
    return requestJson<{ readonly session: PaSessionSummary }>(`/bots/${enc(botId)}/sessions`, {
      method: "POST",
      body: { setPrimary },
    }).then((res) => res.session);
  },

  getMessages(botId: string, sessionId: string, signal?: AbortSignal, limit?: number) {
    const searchParams = limit !== undefined ? { limit: String(limit) } : undefined;
    return requestJson<{ readonly messages: ReadonlyArray<PaMessage> }>(
      `/bots/${enc(botId)}/sessions/${enc(sessionId)}/messages`,
      { signal, searchParams },
    ).then((res) => res.messages);
  },

  sendMessage(botId: string, sessionId: string, text: string, inputId?: string) {
    return requestJson<PaSendResult>(`/bots/${enc(botId)}/sessions/${enc(sessionId)}/send`, {
      method: "POST",
      body: { text, ...(inputId ? { inputId } : {}) },
    });
  },

  interruptSession(botId: string, sessionId: string) {
    return requestJson<{ readonly ok: boolean }>(
      `/bots/${enc(botId)}/sessions/${enc(sessionId)}/interrupt`,
      { method: "POST" },
    );
  },

  respondRequest(botId: string, sessionId: string, input: PaRespondRequestInput) {
    return requestJson<{ readonly ok: boolean }>(
      `/bots/${enc(botId)}/sessions/${enc(sessionId)}/respond`,
      {
        method: "POST",
        body: input,
      },
    );
  },

  /**
   * Subscribe to the SSE event stream for a PA session. Uses fetch streaming (not EventSource)
   * so both cookie auth (iPhone Safari / browser) and bearer auth (Desktop Electron) work identically.
   */
  subscribeSessionEvents(
    botId: string,
    sessionId: string,
    options: {
      readonly sinceSeq?: number | undefined;
      readonly replayEpoch?: string | undefined;
      readonly onEvent: (event: PaStreamEvent) => void;
      readonly onDisconnect?: (error?: Error) => void;
    },
  ): () => void {
    const controller = new AbortController();

    void (async () => {
      try {
        const searchParams: Record<string, string> = {};
        if (options.sinceSeq !== undefined && options.sinceSeq > 0) {
          searchParams.sinceSeq = String(options.sinceSeq);
        }
        if (options.replayEpoch) {
          searchParams.replayEpoch = options.replayEpoch;
        }
        const url = resolvePrimaryEnvironmentHttpUrl(
          `/api/pa/bots/${enc(botId)}/sessions/${enc(sessionId)}/events`,
          Object.keys(searchParams).length > 0 ? searchParams : undefined,
        );
        const auth = await buildAuthInit({ accept: "text/event-stream" });
        const response = await fetch(url, {
          method: "GET",
          cache: "no-store",
          credentials: auth.credentials,
          headers: auth.headers,
          signal: controller.signal,
        });
        if (!response.ok || !response.body) {
          throw new Error(`Event stream failed (${response.status})`);
        }
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let sepIndex = buffer.indexOf("\n\n");
          while (sepIndex !== -1) {
            const rawChunk = buffer.slice(0, sepIndex);
            buffer = buffer.slice(sepIndex + 2);
            sepIndex = buffer.indexOf("\n\n");

            const dataLines = rawChunk
              .split("\n")
              .filter((line) => line.startsWith("data:"))
              .map((line) => line.slice(5).trim());
            if (dataLines.length === 0) continue;
            try {
              const parsed = JSON.parse(dataLines.join("\n")) as PaStreamEvent;
              options.onEvent(parsed);
            } catch {
              // Skip malformed event frames safely.
            }
          }
        }
        if (!controller.signal.aborted) {
          options.onDisconnect?.();
        }
      } catch (err) {
        if (!controller.signal.aborted) {
          options.onDisconnect?.(err instanceof Error ? err : new Error(String(err)));
        }
      }
    })();

    return () => {
      controller.abort();
    };
  },
};
