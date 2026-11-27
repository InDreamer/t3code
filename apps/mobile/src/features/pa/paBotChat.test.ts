import {
  PaError,
  type PaCapabilities,
  type PaMessage,
  type PaPendingRequest,
  type PaSendResult,
  type PaSessionSummary,
  type PaStreamEvent,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import type { PaClient } from "./paApi";
import { createPaBotChat, paBotChatView } from "./paBotChat";

vi.mock("./paApi", () => ({
  paErrorMessage: (error: unknown, fallback: string) =>
    error instanceof Error && error.message ? error.message : fallback,
}));
vi.mock("../../i18n/messages", () => ({ m: (message: unknown) => String(message) }));

const CAPABILITIES: PaCapabilities = {
  sessions: { create: true, rename: true, renameExisting: true },
  execution: {
    interrupt: true,
    approvals: true,
    clarify: true,
    secrets: true,
    queue: true,
    steer: true,
  },
  models: { supported: true, scope: "agent", allowCustom: false },
  commands: { supported: false },
  config: { supported: true },
  schedules: { supported: true },
  lifecycle: { create: true, delete: false },
};

const session = (sessionId: string, patch: Partial<PaSessionSummary> = {}): PaSessionSummary => ({
  sessionId,
  title: sessionId,
  source: "gui",
  model: null,
  messageCount: 0,
  running: false,
  startedAt: null,
  lastActivityAt: null,
  isPrimary: false,
  ...patch,
});

const stored = (
  id: string,
  role: PaMessage["role"],
  text: string,
  timestamp: number,
): PaMessage => ({
  id,
  role,
  text,
  timestamp,
  rowKind: "message",
});

function until(chat: ReturnType<typeof createPaBotChat>, ready: () => boolean) {
  if (ready()) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const unsubscribe = chat.subscribe(() => {
      if (ready()) {
        unsubscribe();
        resolve();
      }
    });
  });
}

const context = { capabilities: CAPABILITIES, canOperate: true, unread: false, connected: true };
function fakeClient(overrides: Partial<PaClient> = {}) {
  const feeds = new Map<string, Parameters<PaClient["followSession"]>[2]>();
  const client = {
    listSessions: vi.fn(async () => ({ primarySessionId: "s1", sessions: [session("s1")] })),
    ensurePrimarySession: vi.fn(async () => session("primary", { isPrimary: true })),
    createSession: vi.fn(async (_botId: string, requestId: string) => session(requestId)),
    getMessages: vi.fn(async () => ({ messages: [] as PaMessage[] })),
    listCommands: vi.fn(async () => []),
    markRead: vi.fn(async () => undefined),
    sendMessage: vi.fn(async (_botId: string, sessionId: string): Promise<PaSendResult> => ({
      kind: "turn",
      sessionId,
    })),
    steerSession: vi.fn(async () => ({ status: "delivered" as const })),
    interruptSession: vi.fn(async () => undefined),
    manageQueuedItem: vi.fn(async () => undefined),
    respondRequest: vi.fn(async () => undefined),
    followSession: vi.fn(
      (_botId: string, sessionId: string, handlers: Parameters<PaClient["followSession"]>[2]) => {
        feeds.set(sessionId, handlers);
        return () => feeds.delete(sessionId);
      },
    ),
    ...overrides,
  };
  return { api: client as unknown as PaClient, feeds };
}

const snapshot = (
  sessionId: string,
  patch: Partial<Extract<PaStreamEvent, { type: "snapshot" }>> = {},
) =>
  ({
    type: "snapshot",
    sessionId,
    resumeToken: "t1",
    running: false,
    openRequests: [],
    snapshotRequired: false,
    ...patch,
  }) satisfies PaStreamEvent;

async function startedChat(client: PaClient) {
  let clock = 1_000;
  const chat = createPaBotChat({ api: client, botId: "bot", now: () => (clock += 1) });
  chat.holdVisible();
  await chat.setContext(context);
  return chat;
}

describe("createPaBotChat", () => {
  it("creates the primary conversation once for a Bot that has none", async () => {
    const { api: client, feeds } = fakeClient({
      listSessions: vi.fn(async () => ({ primarySessionId: null, sessions: [] })),
    });
    const chat = await startedChat(client);

    expect(client.ensurePrimarySession).toHaveBeenCalledTimes(1);
    expect(chat.getState().activeSessionId).toBe("primary");
    expect(chat.getState().sessions.map((item) => item.sessionId)).toEqual(["primary"]);
    expect(feeds.has("primary")).toBe(true);
    // The transcript is read once the feed attaches, not before.
    expect(client.getMessages).not.toHaveBeenCalled();

    feeds.get("primary")!.onEvent(snapshot("primary"));
    await until(chat, () => !paBotChatView(chat.getState()).loadingMessages);
    expect(client.getMessages).toHaveBeenCalledWith("bot", "primary");
    expect(paBotChatView(chat.getState()).loadingMessages).toBe(false);
  });

  it("shares an in-flight first conversation with the sessions sheet", async () => {
    const primary = Promise.withResolvers<PaSessionSummary>();
    const requested = Promise.withResolvers<void>();
    const { api: client } = fakeClient({
      listSessions: vi.fn(async () => ({ primarySessionId: null, sessions: [] })),
      ensurePrimarySession: vi.fn(() => {
        requested.resolve();
        return primary.promise;
      }),
    });
    const chat = createPaBotChat({ api: client, botId: "bot" });
    chat.holdVisible();
    const initializing = chat.setContext(context);
    await requested.promise;
    const manual = chat.createSession();
    primary.resolve(session("s1", { isPrimary: true }));
    await Promise.all([initializing, manual]);
    expect(client.createSession).not.toHaveBeenCalled();
    expect(chat.getState().activeSessionId).toBe("s1");
  });

  it("shows a sent message at once and keeps one row once the engine stores it", async () => {
    const { api: client, feeds } = fakeClient();
    const chat = await startedChat(client);
    feeds.get("s1")!.onEvent(snapshot("s1"));
    await until(chat, () => !paBotChatView(chat.getState()).loadingMessages);

    chat.setDraft("hello");
    const sending = chat.send();
    expect(paBotChatView(chat.getState()).draft).toBe("");
    expect(paBotChatView(chat.getState()).timelineItems).toHaveLength(1);
    expect(await sending).toBe(true);
    expect(client.sendMessage).toHaveBeenCalledWith(
      "bot",
      "s1",
      "hello",
      expect.any(String),
      false,
      [],
    );
    expect(paBotChatView(chat.getState()).running).toBe(true);

    vi.mocked(client.getMessages).mockResolvedValueOnce({
      messages: [stored("m1", "user", "hello", 10), stored("m2", "assistant", "hi", 11)],
    });
    feeds
      .get("s1")!
      .onEvent({ type: "turn.completed", sessionId: "s1", resumeToken: "t2" } as PaStreamEvent);
    await until(chat, () => chat.getState().localBySession.s1?.length === 0);
    const view = paBotChatView(chat.getState());
    expect(view.transcript.messages.map((item) => item.id)).toEqual(["m1", "m2"]);
    expect(chat.getState().localBySession.s1).toEqual([]);
    expect(client.markRead).toHaveBeenCalledWith("bot");
  });

  it("keeps an idle recovery snapshot when the admission reply arrives after a rewritten prompt", async () => {
    const receipt = Promise.withResolvers<PaSendResult>();
    const { api: client, feeds } = fakeClient({ sendMessage: () => receipt.promise });
    const chat = await startedChat(client);
    const feed = feeds.get("s1")!;
    feed.onEvent(snapshot("s1"));
    await until(chat, () => !paBotChatView(chat.getState()).loadingMessages);
    const sending = chat.send("/plan");
    feed.onEvent({ type: "turn.started", sessionId: "s1", resumeToken: "2" });
    vi.mocked(client.getMessages).mockResolvedValue({
      messages: [stored("m", "user", "Write a plan", 17)],
    });
    feed.onEvent(snapshot("s1", { snapshotRequired: true }));
    await until(chat, () => chat.getState().messages.window.messages.length === 1);
    receipt.resolve({ kind: "turn", sessionId: "s1" });
    await sending;
    await until(chat, () => chat.getState().localBySession.s1?.length === 0);
    expect(paBotChatView(chat.getState()).running).toBe(false);
  });

  it("restores a failed draft to the session that sent it", async () => {
    const receipt = Promise.withResolvers<PaSendResult>();
    const { api: client } = fakeClient({ sendMessage: () => receipt.promise });
    const chat = await startedChat(client);
    chat.setDraft("from A");
    const sending = chat.send();
    chat.selectSession(session("s2"));
    chat.setDraft("from B");
    receipt.reject(new Error("offline"));
    expect(await sending).toBe(false);
    expect(chat.getState().drafts).toEqual({ s1: "from A", s2: "from B" });
  });

  it("retries startup and waits for visibility and permission before creating a session", async () => {
    const { api: client } = fakeClient({
      listSessions: vi
        .fn()
        .mockRejectedValueOnce(new Error("offline"))
        .mockResolvedValue({ sessions: [], primarySessionId: null }),
    });
    const chat = createPaBotChat({ api: client, botId: "bot" });
    await chat.setContext({ ...context, canOperate: false });
    expect(chat.getState().initializationError).toBe("offline");
    await chat.retryInitialization();
    expect(chat.getState().initializationError).toBeNull();
    expect(client.ensurePrimarySession).not.toHaveBeenCalled();
    chat.holdVisible();
    await chat.retryInitialization();
    chat.setContext(context);
    await until(chat, () => chat.getState().activeSessionId === "primary");
    expect(client.ensurePrimarySession).toHaveBeenCalledTimes(1);
  });

  it("retries a send with the original attachments and input id after a lost reply", async () => {
    const sendMessage = vi
      .fn<PaClient["sendMessage"]>()
      .mockRejectedValueOnce(new Error("reply lost"))
      .mockResolvedValue({ kind: "turn", sessionId: "s1" });
    const { api: client } = fakeClient({ sendMessage });
    const chat = await startedChat(client);
    const attachments = [
      { id: "asset", name: "log.txt", type: "file" as const, mimeType: "text/plain", sizeBytes: 4 },
    ];
    expect(await chat.send("read", { attachments })).toBe(false);
    expect(chat.failedAttachmentKey("s1", "read")).toBe(JSON.stringify(["asset"]));
    expect(chat.failedAttachmentKey("s1", "changed")).toBeUndefined();
    expect(await chat.send("read", { attachments })).toBe(true);
    expect(chat.failedAttachmentKey("s1", "read")).toBeUndefined();
    expect(sendMessage.mock.calls[0]).toEqual(sendMessage.mock.calls[1]);
  });

  it("puts a failed message back in the composer", async () => {
    const { api: client } = fakeClient({
      sendMessage: vi.fn(async () => {
        throw new Error("engine offline");
      }),
    });
    const chat = await startedChat(client);

    chat.setDraft("hello");
    expect(await chat.send()).toBe(false);
    const view = paBotChatView(chat.getState());
    expect(view.draft).toBe("hello");
    expect(view.timelineItems).toHaveLength(0);
    expect(view.liveTurn.error).toBe("engine offline");
  });

  it("sends behind the running turn without a local row", async () => {
    const { api: client } = fakeClient({
      sendMessage: vi.fn(async (_botId: string, sessionId: string) => ({
        kind: "turn" as const,
        sessionId,
        queued: true,
      })),
    });
    const chat = await startedChat(client);

    chat.setDraft("next");
    expect(await chat.send(undefined, { queued: true })).toBe(true);
    expect(vi.mocked(client.sendMessage).mock.calls[0]?.[4]).toBe(true);
    expect(paBotChatView(chat.getState()).timelineItems).toHaveLength(0);
  });

  it("sends a steer the turn ended too early to take as a normal message", async () => {
    const { api: client } = fakeClient({
      steerSession: vi.fn(async () => ({ status: "notDelivered" as const })),
    });
    const chat = await startedChat(client);

    chat.setDraft("faster");
    await chat.steer();
    expect(client.sendMessage).toHaveBeenCalledTimes(1);
    expect(vi.mocked(client.sendMessage).mock.calls[0]?.[2]).toBe("faster");
  });

  it("never re-sends a steer whose delivery is unknown", async () => {
    const { api: client } = fakeClient({
      steerSession: vi.fn(async () => {
        throw new Error("timed out");
      }),
    });
    const chat = await startedChat(client);

    chat.setDraft("faster");
    await chat.steer();
    expect(client.sendMessage).not.toHaveBeenCalled();
    expect(paBotChatView(chat.getState()).draft).toBe("faster");
  });

  it("moves off a conversation the engine no longer has", async () => {
    const { api: client, feeds } = fakeClient({
      listSessions: vi
        .fn()
        .mockResolvedValueOnce({ primarySessionId: "gone", sessions: [session("gone")] })
        .mockResolvedValueOnce({ primarySessionId: "s2", sessions: [session("s2")] }),
    });
    const chat = await startedChat(client);
    expect(chat.getState().activeSessionId).toBe("gone");

    feeds.get("gone")!.onFailure(new PaError({ reason: "NotFound", message: "missing" }), {
      retrying: false,
    });
    await until(chat, () => chat.getState().activeSessionId === "s2");
    expect(chat.getState().activeSessionId).toBe("s2");
    expect(feeds.has("gone")).toBe(false);
    expect(feeds.has("s2")).toBe(true);
  });

  it.each(["offline", "hidden"])(
    "retries missing-session recovery after it was %s",
    async (scenario) => {
      const { api: client, feeds } = fakeClient();
      const chat = createPaBotChat({ api: client, botId: "bot" });
      const hide = chat.holdVisible();
      await chat.setContext(context);
      if (scenario === "hidden") hide();
      const noSessions = { primarySessionId: null, sessions: [] };
      vi.mocked(client.listSessions).mockResolvedValue(noSessions);
      if (scenario === "offline")
        vi.mocked(client.listSessions).mockRejectedValueOnce(new Error("offline"));
      feeds
        .get("s1")!
        .onFailure(new PaError({ reason: "NotFound", message: "missing" }), { retrying: false });
      await until(chat, () => chat.getState().initializationError !== null);
      expect(feeds.has("s1")).toBe(false);
      if (scenario === "hidden") chat.holdVisible();
      else await chat.retryInitialization();
      await until(chat, () => chat.getState().activeSessionId === "primary");
      expect(feeds.has("primary")).toBe(true);
      expect(chat.getState().initializationError).toBeNull();
    },
  );

  it("keeps the model command in the draft when no permitted picker is available", async () => {
    const { api: client } = fakeClient({
      listCommands: async () => [
        {
          name: "/model",
          handling: "client:model-picker",
          group: "command",
          requiredScope: "operate",
          description: "",
        },
      ],
    });
    const chat = createPaBotChat({ api: client, botId: "bot" });
    chat.holdVisible();
    await chat.setContext({
      ...context,
      capabilities: { ...CAPABILITIES, commands: { supported: true } },
    });
    chat.setDraft("/model small");
    expect(await chat.send()).toBe(false);
    expect(paBotChatView(chat.getState()).draft).toBe("/model small");
    expect(client.sendMessage).not.toHaveBeenCalled();
    const open = vi.fn();
    chat.setOpenModelPicker(open);
    expect(await chat.send()).toBe(true);
    expect(open).toHaveBeenCalledWith("small");
  });

  it("answers a secret request without echoing a transport error", async () => {
    const request: PaPendingRequest = {
      requestId: "r1",
      kind: "secret",
      title: "API key",
      detail: "",
    };
    const { api: client, feeds } = fakeClient({
      respondRequest: vi
        .fn()
        .mockRejectedValueOnce(
          new PaError({ reason: "Upstream", message: "adapter rejected sk-123" }),
        )
        .mockResolvedValueOnce(undefined),
    });
    const chat = await startedChat(client);
    feeds.get("s1")!.onEvent(snapshot("s1", { running: true, openRequests: [request] }));
    await until(chat, () => !paBotChatView(chat.getState()).loadingMessages);

    const answer = { type: "submit" as const, values: { key: "sk-123" } };
    expect(await chat.respondSecret(request, answer)).toBe(false);
    const error = paBotChatView(chat.getState()).liveTurn.error;
    expect(error).toBe("Could not submit credentials");
    expect(error).not.toContain("sk-123");

    expect(await chat.respondSecret(request, answer)).toBe(true);
    expect(client.respondRequest).toHaveBeenLastCalledWith({
      botId: "bot",
      sessionId: "s1",
      requestId: "r1",
      values: { key: "sk-123" },
    });
    expect(paBotChatView(chat.getState()).liveTurn.openRequests).toEqual([]);
  });

  it("reuses the request id when a failed conversation create is retried", async () => {
    const createSession = vi
      .fn()
      .mockRejectedValueOnce(new Error("network"))
      .mockImplementation(async (_botId: string, requestId: string) => session(requestId));
    const { api: client } = fakeClient({ createSession });
    const chat = await startedChat(client);

    await chat.createSession();
    await chat.createSession();
    expect(createSession).toHaveBeenCalledTimes(2);
    expect(createSession.mock.calls[0]?.[1]).toBe(createSession.mock.calls[1]?.[1]);
    expect(chat.getState().activeSessionId).toBe(createSession.mock.calls[1]?.[1]);
  });
});
