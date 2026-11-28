import {
  PaError,
  type PaCapabilities,
  type PaGetMessagesResult,
  type PaMessage,
  type PaSendResult,
  type PaSessionSummary,
  type PaStreamEvent,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  createPaBotChat,
  paBotChatView,
  type PaBotChatClient,
  type PaBotChatPersistence,
  type PaFollowSessionOptions,
} from "./botChat.ts";
import type { PaCachedSessionData } from "./cache.ts";

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

const msgRow = (
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

const snapshot = (
  sessionId: string,
  patch: Partial<Extract<PaStreamEvent, { type: "snapshot" }>> = {},
): Extract<PaStreamEvent, { type: "snapshot" }> => ({
  type: "snapshot",
  sessionId,
  resumeToken: "ep:1",
  running: false,
  openRequests: [],
  snapshotRequired: false,
  protocolVersion: 3,
  ...patch,
});

function makeFakeClient(overrides: Partial<PaBotChatClient> = {}) {
  const feeds = new Map<string, PaFollowSessionOptions>();
  const stopped: string[] = [];
  const client: PaBotChatClient = {
    listSessions: vi.fn(async () => ({ primarySessionId: "s1", sessions: [session("s1")] })),
    ensurePrimarySession: vi.fn(async () => session("primary", { isPrimary: true })),
    createSession: vi.fn(async (_botId: string, requestId: string) => session(requestId)),
    getMessages: vi.fn(async (): Promise<PaGetMessagesResult> => ({
      messages: [],
      nextCursor: null,
    })),
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
    followSession: vi.fn((_botId: string, sessionId: string, handlers: PaFollowSessionOptions) => {
      feeds.set(sessionId, handlers);
      return () => {
        stopped.push(sessionId);
        if (feeds.get(sessionId) === handlers) feeds.delete(sessionId);
      };
    }),
    ...overrides,
  };
  return { api: client, feeds, stopped };
}

function makeMemoryPersistence(initial: Record<string, PaCachedSessionData> = {}) {
  const sessions = new Map<string, PaCachedSessionData>(Object.entries(initial));
  let remembered: string | null = null;
  const persistence: PaBotChatPersistence = {
    loadSession: vi.fn(async (sessionId) => sessions.get(sessionId) ?? null),
    saveSession: vi.fn(async (sessionId, page, pageTag) => {
      sessions.set(sessionId, { page, pageTag, savedAt: 1_000 });
    }),
    removeSession: vi.fn(async (sessionId) => {
      sessions.delete(sessionId);
    }),
    removeBotSessions: vi.fn(async () => {
      sessions.clear();
    }),
    rememberLastSession: vi.fn((sessionId) => {
      remembered = sessionId;
    }),
    forgetLastSession: vi.fn((sessionId) => {
      if (remembered === sessionId) remembered = null;
    }),
    getRememberedSession: vi.fn(() => remembered),
  };
  return { persistence, sessions };
}

const flush = async () => {
  for (let i = 0; i < 6; i++) await Promise.resolve();
};

describe("createPaBotChat caching and 1-RTT open", () => {
  it("opens the primarySessionId immediately without waiting on listSessions and applies snapshot.page in 1 RTT", async () => {
    const listGate = Promise.withResolvers<{
      primarySessionId: string | null;
      sessions: ReadonlyArray<PaSessionSummary>;
    }>();
    const { api, feeds } = makeFakeClient({
      listSessions: vi.fn(() => listGate.promise),
    });
    const { persistence, sessions } = makeMemoryPersistence();
    const chat = createPaBotChat({ api, botId: "hermes:main", persistence });
    const releaseHold = chat.hold();

    void chat.setContext({
      capabilities: CAPABILITIES,
      canOperate: true,
      unread: false,
      connected: true,
      primarySessionId: "s-primary",
    });

    // Follows immediately while listSessions is still unresolved.
    expect(feeds.has("s-primary")).toBe(true);
    expect(api.getMessages).not.toHaveBeenCalled();

    const page: PaGetMessagesResult = {
      messages: [msgRow("row-1", "assistant", "Instant 1-RTT reply", 100)],
      nextCursor: "older-cursor",
    };
    feeds.get("s-primary")!.onEvent(snapshot("s-primary", { page, pageTag: "tag-1" }));

    const view = paBotChatView(chat.getState());
    expect(view.loadingMessages).toBe(false);
    expect(view.transcript.messages).toEqual(page.messages);
    expect(view.transcript.olderCursor).toBe("older-cursor");
    // Bundled page avoids a separate getMessages round trip.
    expect(api.getMessages).not.toHaveBeenCalled();

    // Releasing hold disconnects the live feed and flushes the confirmed page to disk immediately.
    releaseHold();
    expect(feeds.has("s-primary")).toBe(false);
    expect(sessions.get("s-primary")?.page).toEqual(page);
    expect(sessions.get("s-primary")?.pageTag).toBe("tag-1");

    listGate.resolve({ primarySessionId: "s-primary", sessions: [session("s-primary")] });
    await flush();
    chat.dispose();
  });

  it("paints from disk cache offline, skips markRead until live confirmation, and handles pageUnchanged", async () => {
    const cachedPage: PaGetMessagesResult = {
      messages: [msgRow("row-1", "assistant", "From disk cache", 100)],
      nextCursor: null,
    };
    const { persistence } = makeMemoryPersistence({
      "s-1": { page: cachedPage, pageTag: "tag-disk", savedAt: 50 },
    });
    const { api, feeds } = makeFakeClient();
    const chat = createPaBotChat({
      api,
      botId: "hermes:main",
      initialSessionId: "s-1",
      persistence,
    });
    const releaseHold = chat.hold();
    const releaseVisible = chat.holdVisible();

    // Still disconnected: disk cache still hydrates and paints immediately.
    chat.setContext({
      capabilities: null,
      canOperate: true,
      unread: true,
      connected: false,
      primarySessionId: "s-1",
    });
    await flush();

    const cachedView = paBotChatView(chat.getState());
    expect(cachedView.loadingMessages).toBe(false);
    expect(cachedView.isFromCache).toBe(true);
    expect(cachedView.transcript.messages).toEqual(cachedPage.messages);
    expect(api.markRead).not.toHaveBeenCalled();

    // Now connect: client sends knownPageTag and receives pageUnchanged with zero getMessages calls.
    chat.setContext({
      capabilities: CAPABILITIES,
      canOperate: true,
      unread: true,
      connected: true,
      primarySessionId: "s-1",
    });
    const feed = feeds.get("s-1")!;
    expect(feed.latestPage?.getKnownPageTag?.()).toBe("tag-disk");

    feed.onEvent(
      snapshot("s-1", { pageUnchanged: true, pageTag: "tag-disk", resumeToken: "ep:9" }),
    );
    const liveView = paBotChatView(chat.getState());
    expect(liveView.isFromCache).toBe(false);
    expect(liveView.transcript).toBe(cachedView.transcript);
    expect(api.getMessages).not.toHaveBeenCalled();
    expect(api.markRead).toHaveBeenCalledWith("hermes:main", { sessionId: "s-1", id: "row-1" });

    releaseVisible();
    releaseHold();
    chat.dispose();
  });

  it("retains memory cache and resumeToken across hold release/re-acquire and skips getMessages on exact replay", async () => {
    const { api, feeds } = makeFakeClient();
    const chat = createPaBotChat({ api, botId: "hermes:main", initialSessionId: "s-1" });
    let release = chat.hold();
    chat.setContext({
      capabilities: CAPABILITIES,
      canOperate: true,
      unread: false,
      connected: true,
      primarySessionId: "s-1",
    });

    const page: PaGetMessagesResult = {
      messages: [msgRow("row-1", "assistant", "Warm message", 100)],
      nextCursor: null,
    };
    const firstFeed = feeds.get("s-1")!;
    firstFeed.onEvent(snapshot("s-1", { page, pageTag: "tag-warm", resumeToken: "ep:42" }));
    firstFeed.onResumeToken?.("ep:42");

    // Leave chat (e.g. switch to another bot): feed stops, memory stays warm.
    release();
    expect(feeds.has("s-1")).toBe(false);
    expect(paBotChatView(chat.getState()).loadingMessages).toBe(false);
    expect(paBotChatView(chat.getState()).transcript.messages).toEqual(page.messages);

    // Return within 5-minute TTL: immediately sends retained resumeToken, exact replay skips getMessages.
    release = chat.hold();
    const secondFeed = feeds.get("s-1")!;
    expect(secondFeed.initialResumeToken).toBe("ep:42");
    secondFeed.onEvent(snapshot("s-1", { resumeToken: "ep:42", snapshotRequired: false }));
    expect(api.getMessages).not.toHaveBeenCalled();
    expect(paBotChatView(chat.getState()).transcript.messages).toEqual(page.messages);

    release();
    chat.dispose();
  });

  it("discards a late disk load when live data already arrived, and clears cache on NotFound or canRead=false", async () => {
    const diskGate = Promise.withResolvers<PaCachedSessionData | null>();
    const { persistence } = makeMemoryPersistence();
    vi.mocked(persistence.loadSession).mockReturnValueOnce(diskGate.promise);

    const { api, feeds } = makeFakeClient();
    const chat = createPaBotChat({
      api,
      botId: "hermes:main",
      initialSessionId: "s-1",
      persistence,
    });
    const release = chat.hold();
    chat.setContext({
      capabilities: CAPABILITIES,
      canOperate: true,
      unread: false,
      connected: true,
      primarySessionId: "s-1",
    });

    const livePage: PaGetMessagesResult = {
      messages: [msgRow("row-2", "assistant", "Fresh live", 200)],
      nextCursor: null,
    };
    feeds.get("s-1")!.onEvent(snapshot("s-1", { page: livePage, pageTag: "tag-live" }));
    expect(paBotChatView(chat.getState()).transcript.messages[0]?.text).toBe("Fresh live");

    // Stale disk response resolves later and must not overwrite live state.
    diskGate.resolve({
      page: { messages: [msgRow("row-1", "assistant", "Old disk", 100)], nextCursor: null },
      pageTag: "tag-old",
      savedAt: 50,
    });
    await flush();
    expect(paBotChatView(chat.getState()).transcript.messages[0]?.text).toBe("Fresh live");

    // Revoking read permission clears memory + disk immediately and stops spinner.
    chat.setContext({
      capabilities: CAPABILITIES,
      canOperate: false,
      readDenied: true,
      unread: false,
      connected: true,
      primarySessionId: "s-1",
    });
    expect(paBotChatView(chat.getState()).transcript.messages).toEqual([]);
    expect(paBotChatView(chat.getState()).readDenied).toBe(true);
    expect(paBotChatView(chat.getState()).loadingMessages).toBe(false);
    expect(feeds.has("s-1")).toBe(false);
    expect(persistence.removeBotSessions).toHaveBeenCalledTimes(1);

    // Re-enabling and hitting NotFound removes the disk cache entry without fallback getMessages.
    chat.setContext({
      capabilities: CAPABILITIES,
      canOperate: true,
      readDenied: false,
      unread: false,
      connected: true,
      primarySessionId: "s-1",
    });
    feeds.get("s-1")!.onFailure(new PaError({ reason: "NotFound", message: "gone" }), {
      retrying: false,
    });
    await flush();
    expect(api.getMessages).not.toHaveBeenCalled();
    expect(persistence.removeSession).toHaveBeenCalledWith("s-1");
    expect(persistence.forgetLastSession).toHaveBeenCalledWith("s-1");

    release();
    chat.dispose();
  });

  it("repairs history and clears settling blocks when leaving right after turn.completed before reload resolves", async () => {
    const delayedReload = Promise.withResolvers<PaGetMessagesResult>();
    const { api, feeds } = makeFakeClient({
      getMessages: vi.fn(() => delayedReload.promise),
    });
    const chat = createPaBotChat({ api, botId: "hermes:main", initialSessionId: "s-1" });
    let release = chat.hold();
    chat.setContext({
      capabilities: CAPABILITIES,
      canOperate: true,
      unread: false,
      connected: true,
      primarySessionId: "s-1",
    });

    const firstFeed = feeds.get("s-1")!;
    firstFeed.onEvent(
      snapshot("s-1", {
        page: { messages: [msgRow("row-1", "assistant", "Earlier", 10)], nextCursor: null },
        pageTag: "tag-1",
        resumeToken: "ep:1",
      }),
    );
    firstFeed.onEvent({
      type: "text.delta",
      sessionId: "s-1",
      role: "answer",
      text: "Final reply",
      resumeToken: "ep:2",
    });
    firstFeed.onEvent({
      type: "turn.completed",
      sessionId: "s-1",
      status: "complete",
      replyId: "row-2",
      resumeToken: "ep:3",
    });
    expect(paBotChatView(chat.getState()).liveTurn.phase).toBe("settling");

    // Leave immediately before delayedReload resolves.
    release();

    // Reopen: must NOT pass the post-completion resumeToken so server bundles the fresh page.
    release = chat.hold();
    const secondFeed = feeds.get("s-1")!;
    expect(secondFeed.initialResumeToken).toBeUndefined();
    secondFeed.onEvent(
      snapshot("s-1", {
        page: {
          messages: [
            msgRow("row-1", "assistant", "Earlier", 10),
            msgRow("row-2", "assistant", "Final reply", 20),
          ],
          nextCursor: null,
        },
        pageTag: "tag-2",
        resumeToken: "ep:3",
      }),
    );

    const view = paBotChatView(chat.getState());
    expect(view.transcript.messages.map((m) => m.text)).toEqual(["Earlier", "Final reply"]);
    expect(view.liveTurn.phase).toBe("idle");
    expect(view.hasLiveTurn).toBe(false);

    release();
    chat.dispose();
  });

  it("clears stale partial live blocks on detached completion, drops late fallback reads, and clears stale pageTag on untagged reload", async () => {
    const fallbackGate = Promise.withResolvers<PaGetMessagesResult>();
    const { api, feeds } = makeFakeClient({
      getMessages: vi.fn(() => fallbackGate.promise),
    });
    const chat = createPaBotChat({ api, botId: "hermes:main", initialSessionId: "s-1" });
    let release = chat.hold();
    chat.setContext({
      capabilities: CAPABILITIES,
      canOperate: true,
      unread: false,
      connected: true,
      primarySessionId: "s-1",
    });

    // Feed fails transiently -> fallback getMessages starts.
    feeds.get("s-1")!.onFailure(new PaError({ reason: "Unavailable", message: "drop" }), {
      retrying: true,
    });
    expect(api.getMessages).toHaveBeenCalledTimes(1);

    // Reconnect delivers bundled newer page before fallback resolves.
    feeds.get("s-1")!.onEvent(
      snapshot("s-1", {
        page: { messages: [msgRow("row-2", "assistant", "Fresh bundled", 200)], nextCursor: null },
        pageTag: "tag-fresh",
        resumeToken: "ep:5",
      }),
    );
    // Late fallback resolves with older data -> must be ignored.
    fallbackGate.resolve({
      messages: [msgRow("row-1", "assistant", "Stale fallback", 100)],
      nextCursor: null,
    });
    await flush();
    expect(paBotChatView(chat.getState()).transcript.messages[0]?.text).toBe("Fresh bundled");

    // Viewer leaves mid-answer with partial streaming blocks.
    feeds.get("s-1")!.onEvent({
      type: "text.delta",
      sessionId: "s-1",
      role: "answer",
      text: "Partial streaming",
      resumeToken: "ep:6",
    });
    release();

    // Viewer returns after completion: server delivers idle snapshot + bundled final page.
    release = chat.hold();
    feeds.get("s-1")!.onEvent(
      snapshot("s-1", {
        running: false,
        page: {
          messages: [
            msgRow("row-2", "assistant", "Fresh bundled", 200),
            msgRow("row-3", "assistant", "Completed answer", 300),
          ],
          nextCursor: null,
        },
        pageTag: "tag-completed",
        resumeToken: "ep:8",
      }),
    );
    const afterReturn = paBotChatView(chat.getState());
    expect(afterReturn.hasLiveTurn).toBe(false);
    expect(afterReturn.transcript.messages.map((m) => m.text)).toEqual([
      "Fresh bundled",
      "Completed answer",
    ]);

    // Untagged getMessages reload clears stale pageTag instead of reusing tag-completed.
    vi.mocked(api.getMessages).mockResolvedValueOnce({
      messages: [msgRow("row-4", "assistant", "Untagged reload", 400)],
      nextCursor: null,
    });
    feeds.get("s-1")!.onEvent({
      type: "turn.completed",
      sessionId: "s-1",
      status: "complete",
      resumeToken: "ep:9",
    });
    await flush();
    expect(feeds.get("s-1")!.latestPage?.getKnownPageTag?.()).toBeNull();

    release();
    chat.dispose();
  });

  it("fences in-flight disk load on Forbidden, preserves permissions under prime(), skips flush on discardPending, and handles opaque session IDs", async () => {
    const diskGate = Promise.withResolvers<PaCachedSessionData | null>();
    const { persistence } = makeMemoryPersistence();
    vi.mocked(persistence.loadSession).mockReturnValueOnce(diskGate.promise);

    const { api, feeds } = makeFakeClient();
    const chat = createPaBotChat({
      api,
      botId: "hermes:main",
      initialSessionId: "constructor",
      persistence,
    });
    const release = chat.hold();
    chat.setContext({
      capabilities: CAPABILITIES,
      canOperate: true,
      unread: false,
      connected: true,
      primarySessionId: "constructor",
    });

    // prime() on an already-started chat must not lower canOperate.
    chat.prime({ capabilities: null, primarySessionId: "constructor", connected: true });
    chat.setDraft("hello");
    await chat.send();
    expect(api.sendMessage).toHaveBeenCalledTimes(1);

    // Feed Forbidden clears state, deletes disk, and fences the pending disk load.
    feeds.get("constructor")!.onFailure(new PaError({ reason: "Forbidden", message: "denied" }), {
      retrying: false,
    });
    diskGate.resolve({
      page: { messages: [msgRow("row-secret", "assistant", "Private", 10)], nextCursor: null },
      pageTag: "tag-secret",
      savedAt: 10,
    });
    await flush();
    const deniedView = paBotChatView(chat.getState());
    expect(deniedView.readDenied).toBe(true);
    expect(deniedView.loadingMessages).toBe(false);
    expect(deniedView.transcript.messages).toEqual([]);
    expect(persistence.removeBotSessions).toHaveBeenCalledTimes(1);

    // discardPending dispose must not flush any pending save.
    const { persistence: p2, sessions: s2 } = makeMemoryPersistence();
    const { api: api2, feeds: feeds2 } = makeFakeClient();
    const chat2 = createPaBotChat({
      api: api2,
      botId: "hermes:main",
      initialSessionId: "s-clean",
      persistence: p2,
    });
    chat2.hold();
    chat2.setContext({
      capabilities: CAPABILITIES,
      canOperate: true,
      unread: false,
      connected: true,
      primarySessionId: "s-clean",
    });
    feeds2.get("s-clean")!.onEvent(
      snapshot("s-clean", {
        page: { messages: [msgRow("r1", "assistant", "Temp", 1)], nextCursor: null },
        pageTag: "t1",
      }),
    );
    chat2.dispose({ discardPending: true });
    expect(s2.size).toBe(0);

    release();
    chat.dispose({ discardPending: true });
  });
});
