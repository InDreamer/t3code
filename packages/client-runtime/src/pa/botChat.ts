import {
  EnvironmentAuthorizationError,
  latestPaAssistantReply,
  type PaAttachment,
  type PaCapabilities,
  type PaClarifyAnswer,
  type PaGetMessagesInput,
  type PaGetMessagesResult,
  type PaListSessionsInput,
  type PaListSessionsResult,
  type PaManageQueuedItemInput,
  type PaMessage,
  type PaPendingRequest,
  type PaQueuedItem,
  type PaRespondRequestInput,
  type PaSendResult,
  type PaSessionSummary,
  type PaSlashCommand,
  type PaSteerSessionResult,
  type PaStreamEvent,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";

import { PA_INITIAL_PAGE_LIMIT, type PaCachedSessionData } from "./cache.ts";
import {
  createPaLocalMessage,
  makePaRequestKey,
  sendPaChatMessage,
  trackAdmittedPaRow,
} from "./chat.ts";
import { isPermanentPaFailure, paErrorReason } from "./environment.ts";
import {
  appendPaSessionPage,
  mergePaLatestPage,
  paUserMessageContentKey,
  prependPaOlderPage,
  type PaTranscriptWindow,
} from "./history.ts";
import { parsePaClientSlashAction } from "./slash.ts";
import {
  buildPaTimelineItems,
  clearCompletedPaLiveTurn,
  createInitialPaLiveTurn,
  mergePaMessagesByTime,
  nextPaLocalTimestamp,
  paNoticeMessage,
  reducePaStreamEvent,
  startPaLiveTurnLocally,
  type PaLiveTurnState,
} from "./timeline.ts";

export type PaClarifyAnswers = Readonly<Record<string, PaClarifyAnswer>>;
export type PaSecretAnswer =
  | { readonly type: "submit"; readonly values: Readonly<Record<string, string>> }
  | { readonly type: "skip" };

export interface PaFollowSessionOptions {
  readonly initialResumeToken?: string | undefined;
  readonly latestPage?:
    | {
        readonly limit?: number | undefined;
        readonly getKnownPageTag?: (() => string | null | undefined) | undefined;
      }
    | undefined;
  readonly onEvent: (event: PaStreamEvent) => void;
  readonly onResumeToken?: ((token: string) => void) | undefined;
  readonly onFailure: (error: unknown, status: { readonly retrying: boolean }) => void;
}

/** Transport methods a PA Bot chat controller needs from its platform client. */
export interface PaBotChatClient {
  readonly listSessions: (
    botId: string,
    page?: Omit<PaListSessionsInput, "botId">,
  ) => Promise<PaListSessionsResult>;
  readonly createSession: (
    botId: string,
    requestId: string,
    title?: string,
  ) => Promise<PaSessionSummary>;
  readonly ensurePrimarySession: (botId: string) => Promise<PaSessionSummary>;
  readonly getMessages: (
    botId: string,
    sessionId: string,
    page?: Omit<PaGetMessagesInput, "botId" | "sessionId">,
  ) => Promise<PaGetMessagesResult>;
  readonly listCommands: (botId: string) => Promise<ReadonlyArray<PaSlashCommand>>;
  readonly markRead: (
    botId: string,
    seenReply?: { readonly sessionId: string; readonly id: string },
  ) => Promise<void>;
  readonly sendMessage: (
    botId: string,
    sessionId: string,
    text: string,
    inputId: string,
    queued: boolean,
    attachments: ReadonlyArray<PaAttachment>,
  ) => Promise<PaSendResult>;
  readonly steerSession: (
    botId: string,
    sessionId: string,
    text: string,
  ) => Promise<PaSteerSessionResult>;
  readonly interruptSession: (botId: string, sessionId: string) => Promise<void>;
  readonly manageQueuedItem: (
    botId: string,
    sessionId: string,
    itemId: string,
    action: PaManageQueuedItemInput["action"],
  ) => Promise<void>;
  readonly respondRequest: (input: PaRespondRequestInput) => Promise<void>;
  readonly followSession: (
    botId: string,
    sessionId: string,
    handlers: PaFollowSessionOptions,
  ) => () => void;
}

/** Optional durable cache hooks (IndexedDB on Web, SQLite on Mobile). */
export interface PaBotChatPersistence {
  readonly loadSession: (sessionId: string) => Promise<PaCachedSessionData | null>;
  readonly saveSession: (
    sessionId: string,
    page: PaGetMessagesResult,
    pageTag: string | null,
  ) => Promise<void>;
  readonly removeSession: (sessionId: string) => Promise<void>;
  readonly removeBotSessions?: (() => Promise<void>) | undefined;
  readonly rememberLastSession?: ((sessionId: string) => void) | undefined;
  readonly forgetLastSession?: ((sessionId: string) => void) | undefined;
  readonly getRememberedSession?: (() => string | null) | undefined;
}

/** What the page knows about the Bot; the controller reads the latest on every action. */
export interface PaBotChatContext {
  readonly capabilities: PaCapabilities | null;
  readonly canOperate: boolean;
  /** Separate read-receipt grant when a surface distinguishes it from `canOperate`. */
  readonly canMarkRead?: boolean | undefined;
  /**
   * True only when the server definitively denied read access (e.g. `sessionDeniesScope`).
   * Unknown / loading / offline auth stays false so authorized offline cache can still paint.
   */
  readonly readDenied?: boolean | undefined;
  readonly unread: boolean;
  readonly connected: boolean;
  /** Hint from the Bot roster so opening does not wait on `listSessions`. */
  readonly primarySessionId?: string | null | undefined;
}

export interface PaBotChatPrimeHint {
  readonly capabilities: PaCapabilities | null;
  readonly primarySessionId?: string | null | undefined;
  readonly connected: boolean;
  readonly readDenied?: boolean | undefined;
}

export interface PaCachedSessionWindow {
  readonly window: PaTranscriptWindow;
  readonly pageTag: string | null;
  /** True once backed by a live server response in this memory lifetime (not disk-only). */
  readonly liveConfirmed: boolean;
  /** True after loading an older page; expanded windows are not persisted to disk. */
  readonly expanded: boolean;
}

export interface PaBotChatState {
  readonly started: boolean;
  readonly readDenied: boolean;
  readonly sessions: ReadonlyArray<PaSessionSummary>;
  readonly sessionsCursor: string | null;
  readonly loadingSessions: boolean;
  readonly loadingMoreSessions: boolean;
  readonly creatingSession: boolean;
  readonly initializationError: string | null;
  readonly activeSessionId: string | null;
  readonly messages: { readonly sessionId: string | null; readonly window: PaTranscriptWindow };
  readonly sessionCache: Readonly<Record<string, PaCachedSessionWindow>>;
  readonly loadingMessagesFor: string | null;
  readonly older: {
    readonly sessionId: string;
    readonly loading: boolean;
    readonly error: string | null;
  } | null;
  readonly localBySession: Readonly<Record<string, ReadonlyArray<PaMessage>>>;
  readonly liveTurn: PaLiveTurnState;
  readonly liveTurnsBySession: Readonly<Record<string, PaLiveTurnState>>;
  readonly slashCommands: ReadonlyArray<PaSlashCommand>;
  readonly drafts: Readonly<Record<string, string>>;
  readonly sending: boolean;
  readonly respondingIds: ReadonlySet<string>;
  readonly queueBusyIds: ReadonlySet<string>;
  readonly clarifyAnswers: Readonly<Record<string, PaClarifyAnswers>>;
  readonly sessionReasoning: Readonly<
    Record<
      string,
      {
        readonly effort: string;
        readonly settingsVersion: number;
      }
    >
  >;
  /** Bumped when the Bot's settings or model change, so readers of them read again. */
  readonly settingsVersion: number;
}

const EMPTY_TRANSCRIPT: PaTranscriptWindow = { messages: [], olderCursor: null };
const MAX_RETAINED_SESSIONS = 6;
const PERSIST_COALESCE_MS = 500;
const isAuthorizationError = Schema.is(EnvironmentAuthorizationError);

function hasOwn(record: Readonly<Record<string, unknown>>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function getOwn<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  return hasOwn(record, key) ? record[key] : undefined;
}

function formatPaError(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function initialState(sessionId: string | null): PaBotChatState {
  return {
    started: false,
    readDenied: false,
    sessions: [],
    sessionsCursor: null,
    loadingSessions: true,
    loadingMoreSessions: false,
    creatingSession: false,
    initializationError: null,
    activeSessionId: sessionId,
    messages: { sessionId: null, window: EMPTY_TRANSCRIPT },
    sessionCache: {},
    loadingMessagesFor: null,
    older: null,
    localBySession: {},
    liveTurn: createInitialPaLiveTurn(sessionId),
    liveTurnsBySession: {},
    slashCommands: [],
    drafts: {},
    sending: false,
    respondingIds: new Set(),
    queueBusyIds: new Set(),
    clarifyAnswers: {},
    sessionReasoning: {},
    settingsVersion: 0,
  };
}

const withId = (set: ReadonlySet<string>, id: string) => new Set(set).add(id);
const withoutId = (set: ReadonlySet<string>, id: string) => {
  const next = new Set(set);
  next.delete(id);
  return next;
};

/**
 * One Bot's conversation: its sessions, retained per-session transcripts and live turns, and
 * every action on them. Shared by Web and Mobile. Live subscriptions run while held (`hold()`);
 * releasing stops the network feed immediately while keeping the memory cache and resume tokens
 * intact until the controller is disposed (typically after the 5-minute idle TTL).
 */
export function createPaBotChat(input: {
  readonly api: PaBotChatClient;
  readonly botId: string;
  readonly initialSessionId?: string | null;
  readonly persistence?: PaBotChatPersistence | undefined;
  readonly now?: () => number;
  readonly resolveMessage?: MFunctionType | undefined;
  readonly onActivity?: (patch?: { running?: true; awaiting?: true }) => void;
  readonly onSessionSelected?: ((sessionId: string) => void) | undefined;
  readonly onVoiceStopped?: (() => void) | undefined;
}) {
  const { api: client, botId, persistence } = input;
  const now = input.now ?? Date.now;
  const resolve = input.resolveMessage ?? mFallback;
  const seedSessionId = input.initialSessionId ?? persistence?.getRememberedSession?.() ?? null;
  let state = initialState(seedSessionId);
  let context: PaBotChatContext = {
    capabilities: null,
    canOperate: false,
    canMarkRead: undefined,
    readDenied: false,
    unread: false,
    connected: false,
    primarySessionId: null,
  };
  let disposed = false;
  let holdUsed = false;
  let holders = 0;
  let visibleHolders = 0;
  let initialized = false;
  let commandsLoaded = false;
  let initialization: Promise<void> | null = null;
  const markingRead = new Set<string>();
  const completedReplyIds = new Map<string, string>();
  let ensurePrimary: Promise<PaSessionSummary> | null = null;
  const draftEdits = new Map<string, number>();
  const createPrimary = () =>
    (ensurePrimary ??= client.ensurePrimarySession(botId).finally(() => {
      ensurePrimary = null;
    }));
  let stopFollow: (() => void) | null = null;
  let followedSessionId: string | null = null;
  let transcriptRequest = 0;
  let running = false;
  let openModelPicker: ((query: string) => void) | null = null;
  const settleTokens = new Map<string, number>();
  /** Tracks sessions whose completion/error still requires a history commit before trusting warm replay. */
  const pendingHistoryRepair = new Map<string, number>();
  const failedSends = new Map<string, { text: string; inputId: string; attachmentKey?: string }>();
  /** An admitted row can be reconciled by submissionId, 1:1 text, or turn completion for rewritten prompts. */
  const pendingUserRows = new Map<string, Map<string, boolean>>();
  const pendingSubmissionIds = new Map<string, string>();
  const recoveringSessions = new Set<string>();
  let missingSession: { id: string; cause: unknown } | null = null;
  let pendingSessionCreate: { readonly title: string; readonly id: string } | null = null;
  const listeners = new Set<() => void>();

  /** Memory-only per-session resume tokens for exact hub replay within lingerMs. */
  const resumeTokens = new Map<string, string>();
  /** LRU order of retained session windows (oldest first). */
  const sessionOrder: string[] = [];
  /** Incremented whenever live data or invalidation lands so late disk reads cannot win. */
  const liveRevisions = new Map<string, number>();
  /** Incremented on definitive read denial so any in-flight disk hydration is discarded. */
  let authRevision = 0;
  let runtimeReadDenied = false;
  const diskHydrating = new Set<string>();
  const pendingPersist = new Map<
    string,
    { readonly page: PaGetMessagesResult; readonly pageTag: string | null }
  >();
  let persistTimer: ReturnType<typeof setTimeout> | null = null;

  const set = (update: (previous: PaBotChatState) => PaBotChatState) => {
    if (disposed) return;
    const next = update(state);
    if (next === state) return;
    state = next;
    for (const listener of listeners) listener();
  };

  const activity = (patch?: { running?: true; awaiting?: true }) => input.onActivity?.(patch);
  const canMarkReadNow = () => context.canMarkRead ?? context.canOperate;
  const isReadDeniedNow = () => context.readDenied === true || runtimeReadDenied;
  const canReadNow = () => !isReadDeniedNow();
  const canFollowNow = () => context.connected && canReadNow() && (!holdUsed || holders > 0);

  const bumpLiveRevision = (sessionId: string) => {
    const next = (liveRevisions.get(sessionId) ?? 0) + 1;
    liveRevisions.set(sessionId, next);
    return next;
  };

  const discardPendingPersistence = () => {
    if (persistTimer !== null) {
      clearTimeout(persistTimer);
      persistTimer = null;
    }
    pendingPersist.clear();
  };

  const flushPersistence = () => {
    if (persistTimer !== null) {
      clearTimeout(persistTimer);
      persistTimer = null;
    }
    if (!persistence || pendingPersist.size === 0 || isReadDeniedNow()) {
      pendingPersist.clear();
      return;
    }
    const entries = Array.from(pendingPersist.entries());
    pendingPersist.clear();
    for (const [sessionId, entry] of entries) {
      void persistence.saveSession(sessionId, entry.page, entry.pageTag).catch(() => undefined);
    }
  };

  const schedulePersist = (
    sessionId: string,
    page: PaGetMessagesResult,
    pageTag: string | null,
  ) => {
    if (!persistence || disposed || !canReadNow()) return;
    const cached = getOwn(state.sessionCache, sessionId);
    const turn = getOwn(state.liveTurnsBySession, sessionId) ?? state.liveTurn;
    if (cached?.expanded || (turn.sessionId === sessionId && turn.phase === "running")) return;
    pendingPersist.set(sessionId, { page, pageTag });
    if (persistTimer === null) {
      // @effect-diagnostics-next-line globalTimers:off
      persistTimer = setTimeout(flushPersistence, PERSIST_COALESCE_MS);
    }
  };

  const touchSessionOrder = (sessionId: string): ReadonlyArray<string> => {
    const existingIndex = sessionOrder.indexOf(sessionId);
    if (existingIndex >= 0) sessionOrder.splice(existingIndex, 1);
    sessionOrder.push(sessionId);
    const evicted: string[] = [];
    while (sessionOrder.length > MAX_RETAINED_SESSIONS) {
      const oldest = sessionOrder[0];
      if (!oldest || oldest === state.activeSessionId) {
        if (sessionOrder.length <= 1) break;
        const second = sessionOrder.splice(1, 1)[0];
        if (second) evicted.push(second);
      } else {
        sessionOrder.shift();
        evicted.push(oldest);
      }
    }
    for (const id of evicted) {
      resumeTokens.delete(id);
      pendingHistoryRepair.delete(id);
      pendingPersist.delete(id);
    }
    return evicted;
  };

  const writeSessionCache = (sessionId: string, entry: PaCachedSessionWindow) => {
    const evicted = touchSessionOrder(sessionId);
    set((previous) => {
      const prevEntry = getOwn(previous.sessionCache, sessionId);
      if (
        evicted.length === 0 &&
        prevEntry &&
        prevEntry.window === entry.window &&
        prevEntry.pageTag === entry.pageTag &&
        prevEntry.liveConfirmed === entry.liveConfirmed &&
        prevEntry.expanded === entry.expanded &&
        (previous.activeSessionId !== sessionId ||
          (previous.messages.sessionId === sessionId && previous.messages.window === entry.window))
      ) {
        return previous;
      }
      const nextCache: Record<string, PaCachedSessionWindow> = {
        ...previous.sessionCache,
        [sessionId]: entry,
      };
      let nextLiveTurns = previous.liveTurnsBySession;
      if (evicted.length > 0) {
        const clonedTurns = { ...previous.liveTurnsBySession };
        for (const id of evicted) {
          delete nextCache[id];
          delete clonedTurns[id];
        }
        nextLiveTurns = clonedTurns;
      }
      return {
        ...previous,
        sessionCache: nextCache,
        liveTurnsBySession: nextLiveTurns,
        ...(previous.activeSessionId === sessionId
          ? { messages: { sessionId, window: entry.window } }
          : {}),
      };
    });
  };

  const dropSessionCache = (sessionId: string, removeFromDisk: boolean) => {
    bumpLiveRevision(sessionId);
    if (state.activeSessionId === sessionId) transcriptRequest += 1;
    resumeTokens.delete(sessionId);
    pendingHistoryRepair.delete(sessionId);
    pendingPersist.delete(sessionId);
    const idx = sessionOrder.indexOf(sessionId);
    if (idx >= 0) sessionOrder.splice(idx, 1);
    set((previous) => {
      if (
        !hasOwn(previous.sessionCache, sessionId) &&
        !hasOwn(previous.liveTurnsBySession, sessionId)
      ) {
        return previous;
      }
      const nextCache = { ...previous.sessionCache };
      delete nextCache[sessionId];
      const nextTurns = { ...previous.liveTurnsBySession };
      delete nextTurns[sessionId];
      return {
        ...previous,
        sessionCache: nextCache,
        liveTurnsBySession: nextTurns,
        ...(previous.messages.sessionId === sessionId
          ? { messages: { sessionId: null, window: EMPTY_TRANSCRIPT } }
          : {}),
      };
    });
    if (removeFromDisk) {
      persistence?.forgetLastSession?.(sessionId);
      void persistence?.removeSession(sessionId).catch(() => undefined);
    }
  };

  const clearAuthorizedState = (removeFromDisk = false) => {
    authRevision += 1;
    stopFollowing();
    resumeTokens.clear();
    pendingHistoryRepair.clear();
    pendingUserRows.clear();
    pendingSubmissionIds.clear();
    sessionOrder.length = 0;
    discardPendingPersistence();
    set((previous) => ({
      ...previous,
      readDenied: true,
      loadingSessions: false,
      loadingMessagesFor: null,
      sessionCache: {},
      messages: { sessionId: null, window: EMPTY_TRANSCRIPT },
      liveTurn: createInitialPaLiveTurn(previous.activeSessionId),
      liveTurnsBySession: {},
      localBySession: {},
    }));
    if (removeFromDisk) {
      void persistence?.removeBotSessions?.().catch(() => undefined);
    }
  };

  const hydrateFromDisk = (sessionId: string) => {
    if (
      !persistence ||
      disposed ||
      !canReadNow() ||
      hasOwn(state.sessionCache, sessionId) ||
      diskHydrating.has(sessionId)
    ) {
      return;
    }
    diskHydrating.add(sessionId);
    const revAtStart = liveRevisions.get(sessionId) ?? 0;
    const authAtStart = authRevision;
    void persistence
      .loadSession(sessionId)
      .then((cached) => {
        if (
          disposed ||
          !cached ||
          !canReadNow() ||
          authRevision !== authAtStart ||
          (liveRevisions.get(sessionId) ?? 0) !== revAtStart ||
          hasOwn(state.sessionCache, sessionId)
        ) {
          return;
        }
        writeSessionCache(sessionId, {
          window: {
            messages: cached.page.messages,
            olderCursor: cached.page.nextCursor ?? null,
          },
          pageTag: cached.pageTag,
          liveConfirmed: false,
          expanded: false,
        });
      })
      .catch(() => undefined)
      .finally(() => {
        diskHydrating.delete(sessionId);
      });
  };

  const markRead = (completionId?: string) => {
    const sessionId = state.activeSessionId;
    if (!sessionId || !visibleHolders || !canMarkReadNow() || !context.connected || disposed) {
      return;
    }
    const cached = getOwn(state.sessionCache, sessionId);
    // Never mark a disk-only cache read as acknowledged before live confirmation.
    const latestFromConfirmed =
      cached?.liveConfirmed === true
        ? latestPaAssistantReply(cached.window.messages)?.id
        : undefined;
    const ids = completionId
      ? [completionId]
      : [latestFromConfirmed, completedReplyIds.get(sessionId)];
    for (const id of ids) {
      if (!id) continue;
      const key = JSON.stringify([sessionId, id]);
      if (markingRead.has(key)) continue;
      markingRead.add(key);
      void client
        .markRead(botId, { sessionId, id })
        .then(
          () => activity(),
          () => undefined,
        )
        .finally(() => {
          markingRead.delete(key);
        });
    }
  };

  const updateLiveTurn = (
    sessionId: string | null,
    updater: (previous: PaLiveTurnState) => PaLiveTurnState,
  ) => {
    if (state.activeSessionId !== sessionId) return;
    set((previous) => {
      const existing =
        (sessionId ? getOwn(previous.liveTurnsBySession, sessionId) : undefined) ??
        (previous.liveTurn.sessionId === sessionId ? previous.liveTurn : undefined);
      const base = existing ?? createInitialPaLiveTurn(sessionId);
      const liveTurn = { ...updater(base), sessionId };
      let clarifyAnswers = previous.clarifyAnswers;
      if (base.openRequests !== liveTurn.openRequests) {
        for (const request of base.openRequests) {
          if (
            hasOwn(clarifyAnswers, request.requestId) &&
            !liveTurn.openRequests.some((r) => r.requestId === request.requestId)
          ) {
            const next = { ...clarifyAnswers };
            delete next[request.requestId];
            clarifyAnswers = next;
          }
        }
      }
      return {
        ...previous,
        liveTurn,
        ...(sessionId
          ? { liveTurnsBySession: { ...previous.liveTurnsBySession, [sessionId]: liveTurn } }
          : {}),
        clarifyAnswers,
      };
    });
  };

  const showError = (sessionId: string | null, error: string | null) =>
    updateLiveTurn(sessionId, (previous) => ({ ...previous, error }));

  const capabilities = () => context.capabilities;
  const canCreateSession = () =>
    context.connected && context.canOperate && capabilities()?.sessions.create === true;
  const commandsSupported = () => capabilities()?.commands.supported !== false;

  const setDraftFor = (sessionId: string, value: string | ((previous: string) => string)) =>
    set((previous) => ({
      ...previous,
      drafts: {
        ...previous.drafts,
        [sessionId]:
          typeof value === "function" ? value(getOwn(previous.drafts, sessionId) ?? "") : value,
      },
    }));
  const editDraft = (sessionId: string, value: string) => {
    if (disposed || (getOwn(state.drafts, sessionId) ?? "") === value) return;
    draftEdits.set(sessionId, (draftEdits.get(sessionId) ?? 0) + 1);
    setDraftFor(sessionId, value);
  };

  const mergedLocal = (sessionId: string) => getOwn(state.localBySession, sessionId) ?? [];

  const localTimestampNow = () => {
    const active = state.activeSessionId;
    const shown = active ? (getOwn(state.sessionCache, active)?.window.messages ?? []) : [];
    const local = active ? mergedLocal(active) : [];
    return nextPaLocalTimestamp([...shown, ...local], now());
  };

  const appendLocalMessage = (sessionId: string, message: PaMessage) =>
    set((previous) => {
      const existing = getOwn(previous.localBySession, sessionId) ?? [];
      // A command's output arrives both as its send result and on the feed: show it once.
      if (existing.some((item) => item.id === message.id)) return previous;
      const timestamp = nextPaLocalTimestamp(existing, message.timestamp ?? now());
      return {
        ...previous,
        localBySession: {
          ...previous.localBySession,
          [sessionId]: [...existing, { ...message, timestamp }],
        },
      };
    });

  const removeLocalMessage = (sessionId: string, messageId: string) => {
    pendingUserRows.get(sessionId)?.delete(messageId);
    pendingSubmissionIds.delete(messageId);
    set((previous) => {
      const existing = getOwn(previous.localBySession, sessionId);
      if (!existing?.some((item) => item.id === messageId)) return previous;
      return {
        ...previous,
        localBySession: {
          ...previous.localBySession,
          [sessionId]: existing.filter((item) => item.id !== messageId),
        },
      };
    });
  };

  const patchSession = (
    sessionId: string,
    patch: Partial<Pick<PaSessionSummary, "title" | "model">>,
  ) =>
    set((previous) => ({
      ...previous,
      sessions: previous.sessions.map((item) =>
        item.sessionId === sessionId ? { ...item, ...patch } : item,
      ),
    }));

  const setReasoning = (sessionId: string | null, effort: string) => {
    if (!sessionId) return;
    set((previous) => ({
      ...previous,
      sessionReasoning: {
        ...previous.sessionReasoning,
        [sessionId]: { effort, settingsVersion: previous.settingsVersion },
      },
    }));
  };

  const reconcilePendingUserRows = (
    sessionId: string,
    loadedMessages: ReadonlyArray<PaMessage>,
    candidates: ReadonlyMap<string, boolean>,
    options?: { readonly endedOnly?: boolean },
  ) => {
    if (candidates.size === 0) return;
    const endedOnly = options?.endedOnly === true;
    const storedUsers = loadedMessages.filter((item) => item.role === "user");
    const usedStoredIndices = new Set<number>();
    const storedBySubmission = new Map<string, number>();
    const storedByContent = new Map<string, number[]>();
    if (!endedOnly) {
      for (let i = 0; i < storedUsers.length; i += 1) {
        const row = storedUsers[i]!;
        if (row.submissionId) storedBySubmission.set(row.submissionId, i);
        const key = paUserMessageContentKey(row);
        const bucket = storedByContent.get(key) ?? [];
        bucket.push(i);
        storedByContent.set(key, bucket);
      }
    }
    set((previous) => {
      const existing = getOwn(previous.localBySession, sessionId) ?? [];
      const reconciled = new Set<string>();
      for (const item of existing) {
        if (!candidates.has(item.id)) continue;
        if (candidates.get(item.id) === true) {
          reconciled.add(item.id);
          continue;
        }
        if (endedOnly) continue;
        const submissionId = pendingSubmissionIds.get(item.id);
        if (submissionId) {
          const matchIdx = storedBySubmission.get(submissionId);
          if (matchIdx !== undefined && !usedStoredIndices.has(matchIdx)) {
            usedStoredIndices.add(matchIdx);
            reconciled.add(item.id);
            continue;
          }
        }
        const bucket = storedByContent.get(paUserMessageContentKey(item));
        if (bucket) {
          const available = bucket.find((idx) => !usedStoredIndices.has(idx));
          if (available !== undefined) {
            usedStoredIndices.add(available);
            reconciled.add(item.id);
          }
        }
      }
      if (reconciled.size === 0) return previous;
      const pending = pendingUserRows.get(sessionId);
      for (const id of reconciled) {
        pending?.delete(id);
        pendingSubmissionIds.delete(id);
      }
      return {
        ...previous,
        localBySession: {
          ...previous.localBySession,
          [sessionId]: existing.filter((item) => !reconciled.has(item.id)),
        },
      };
    });
  };

  const clearRepairIfSatisfied = (sessionId: string, settleToken?: number) => {
    const required = pendingHistoryRepair.get(sessionId);
    if (required === undefined) return;
    if (settleToken !== undefined ? settleToken >= required : !running) {
      pendingHistoryRepair.delete(sessionId);
    }
  };

  const commitLoadedPage = (
    sessionId: string,
    page: PaGetMessagesResult,
    pageTag: string | null,
    candidates: ReadonlyMap<string, boolean>,
    expectedSettleToken?: number,
  ) => {
    bumpLiveRevision(sessionId);
    // Invalidate any earlier standalone latest-page read so it cannot overwrite this newer page.
    if (state.activeSessionId === sessionId) transcriptRequest += 1;
    const prevEntry = getOwn(state.sessionCache, sessionId);
    const nextWindow = mergePaLatestPage(prevEntry?.window ?? null, page);
    const expanded =
      prevEntry?.expanded === true &&
      page.reset !== true &&
      nextWindow.messages.length > page.messages.length;
    const resolvedTag = pageTag ?? page.pageTag ?? null;
    writeSessionCache(sessionId, {
      window: nextWindow,
      pageTag: resolvedTag,
      liveConfirmed: true,
      expanded,
    });
    if (state.loadingMessagesFor === sessionId) {
      set((previous) =>
        previous.loadingMessagesFor === sessionId
          ? { ...previous, loadingMessagesFor: null }
          : previous,
      );
    }
    if (context.unread) markRead();
    reconcilePendingUserRows(sessionId, page.messages, candidates);
    clearRepairIfSatisfied(sessionId, expectedSettleToken);
    updateLiveTurn(sessionId, (previous) =>
      clearCompletedPaLiveTurn(previous, expectedSettleToken),
    );
    // Persist the raw server latest page (not an expanded window) once idle.
    schedulePersist(sessionId, page, resolvedTag);
  };

  const loadTranscript = (
    sessionId: string,
    showSpinner: boolean,
    expectedSettleToken?: number,
  ) => {
    const request = ++transcriptRequest;
    const current = () =>
      !disposed && transcriptRequest === request && state.activeSessionId === sessionId;
    if (showSpinner && !hasOwn(state.sessionCache, sessionId)) {
      set((previous) => ({ ...previous, loadingMessagesFor: sessionId }));
    }
    // Only rows admitted before this read started can be in what it returns.
    const candidates = new Map(pendingUserRows.get(sessionId));
    return client
      .getMessages(botId, sessionId, { limit: PA_INITIAL_PAGE_LIMIT })
      .then((page) => {
        if (!current()) return;
        commitLoadedPage(sessionId, page, page.pageTag ?? null, candidates, expectedSettleToken);
      })
      .catch((error: unknown) => {
        if (!current()) return;
        if (isAuthorizationError(error) || paErrorReason(error) === "Forbidden") {
          runtimeReadDenied = true;
          clearAuthorizedState(true);
          return;
        }
        // A first read that fails still ends the spinner; a failed reload keeps what is shown.
        if (!hasOwn(state.sessionCache, sessionId)) {
          set((previous) =>
            previous.messages.sessionId === sessionId
              ? previous
              : { ...previous, messages: { sessionId, window: EMPTY_TRANSCRIPT } },
          );
        }
        showError(sessionId, formatPaError(error, resolve(msg("Could not load messages"))));
      })
      .finally(() => {
        if (transcriptRequest === request || state.loadingMessagesFor === sessionId) {
          set((previous) =>
            previous.loadingMessagesFor === sessionId
              ? { ...previous, loadingMessagesFor: null }
              : previous,
          );
        }
      });
  };

  /** A session the engine no longer has (often a stale primary): move to one it does have. */
  const recoverMissingSession = async (missingId: string, cause: unknown) => {
    if (recoveringSessions.has(missingId) || !context.connected) return;
    recoveringSessions.add(missingId);
    dropSessionCache(missingId, true);
    set((previous) => ({ ...previous, initializationError: null }));
    try {
      const result = await client.listSessions(botId);
      if (disposed || state.activeSessionId !== missingId) return;
      const remaining = result.sessions.filter((item) => item.sessionId !== missingId);
      let nextId =
        result.primarySessionId && result.primarySessionId !== missingId
          ? result.primarySessionId
          : null;
      let nextSessions = remaining;
      if (!nextId && visibleHolders && !state.creatingSession && canCreateSession()) {
        const created = await createPrimary();
        if (disposed || state.activeSessionId !== missingId) return;
        nextId = created.sessionId;
        nextSessions = [created, ...remaining.map((item) => ({ ...item, isPrimary: false }))];
      }
      nextId ??= remaining[0]?.sessionId ?? null;
      set((previous) => ({
        ...previous,
        sessions: nextSessions,
        sessionsCursor: result.nextCursor ?? null,
      }));
      if (!nextId) {
        set((previous) => ({
          ...previous,
          initializationError: formatPaError(
            cause,
            resolve(msg("This conversation no longer exists")),
          ),
        }));
        return;
      }
      show(nextId, true);
    } catch (error) {
      if (state.activeSessionId === missingId) {
        set((previous) => ({
          ...previous,
          initializationError: formatPaError(
            error,
            resolve(msg("Could not connect to the bot session")),
          ),
        }));
      }
    } finally {
      recoveringSessions.delete(missingId);
    }
  };

  const stopFollowing = () => {
    stopFollow?.();
    stopFollow = null;
    followedSessionId = null;
    transcriptRequest += 1;
  };

  const follow = (sessionId: string | null) => {
    if (!sessionId || disposed) {
      stopFollowing();
      return;
    }
    hydrateFromDisk(sessionId);
    if (!canFollowNow()) return;
    if (followedSessionId === sessionId && stopFollow) return;
    stopFollowing();
    followedSessionId = sessionId;
    let closed = false;
    // Read the transcript only once the feed is attached, so nothing lands between the two. A
    // fallback read while the feed is down does not count: the first snapshot still reads again.
    let transcriptRead = false;
    let transcriptShown = hasOwn(state.sessionCache, sessionId);
    let attachedOnce = false;
    const existingTurn = getOwn(state.liveTurnsBySession, sessionId);
    const needsRepairOnAttach =
      pendingHistoryRepair.has(sessionId) || existingTurn?.phase === "settling";
    // Omit resumeToken when a prior completion's history repair never finished so the server
    // bundles the latest page in 1 RTT instead of treating the post-completion token as clean.
    const initialResumeToken = needsRepairOnAttach ? undefined : resumeTokens.get(sessionId);
    let followStartCandidates = new Map(pendingUserRows.get(sessionId));
    const readTranscript = (settleToken?: number) => {
      void loadTranscript(sessionId, !transcriptShown, settleToken);
      transcriptRead = true;
      transcriptShown = true;
    };
    running = existingTurn?.phase === "running";
    const endTurn = () => {
      const token = (settleTokens.get(sessionId) ?? 0) + 1;
      settleTokens.set(sessionId, token);
      const pending = pendingUserRows.get(sessionId);
      pending?.forEach((_ended, id) => pending.set(id, true));
      return token;
    };
    const handleEvent = (event: PaStreamEvent) => {
      if (closed || state.activeSessionId !== sessionId) return;
      if (event.resumeToken) resumeTokens.set(sessionId, event.resumeToken);
      switch (event.type) {
        case "snapshot": {
          const ended = running && !event.running;
          const endSettleToken = ended ? endTurn() : undefined;
          if (endSettleToken !== undefined) {
            pendingHistoryRepair.set(sessionId, endSettleToken);
          }
          if (event.running || event.openRequests.length || ended) {
            activity({
              ...(event.running ? { running: true } : {}),
              ...(event.openRequests.length ? { awaiting: true } : {}),
            });
          }
          running = event.running;
          updateLiveTurn(sessionId, (previous) => reducePaStreamEvent(previous, event, now()));
          const existing = getOwn(state.sessionCache, sessionId);
          const currentTurn = getOwn(state.liveTurnsBySession, sessionId);
          const effectiveSettleToken =
            endSettleToken ??
            pendingHistoryRepair.get(sessionId) ??
            (currentTurn?.phase === "settling" ? currentTurn.settleToken : undefined);
          const candidates = attachedOnce
            ? new Map(pendingUserRows.get(sessionId))
            : followStartCandidates;
          if (event.pageUnchanged === true && existing !== undefined) {
            bumpLiveRevision(sessionId);
            transcriptRequest += 1;
            writeSessionCache(sessionId, {
              ...existing,
              pageTag: event.pageTag ?? existing.pageTag,
              liveConfirmed: true,
            });
            if (state.loadingMessagesFor === sessionId) {
              set((previous) =>
                previous.loadingMessagesFor === sessionId
                  ? { ...previous, loadingMessagesFor: null }
                  : previous,
              );
            }
            reconcilePendingUserRows(sessionId, existing.window.messages, candidates, {
              endedOnly: true,
            });
            clearRepairIfSatisfied(sessionId, effectiveSettleToken);
            updateLiveTurn(sessionId, (previous) =>
              clearCompletedPaLiveTurn(previous, effectiveSettleToken),
            );
            if (context.unread) markRead();
            transcriptRead = true;
            transcriptShown = true;
          } else if (event.page !== undefined) {
            commitLoadedPage(
              sessionId,
              event.page,
              event.pageTag ?? event.page.pageTag ?? null,
              candidates,
              effectiveSettleToken,
            );
            transcriptRead = true;
            transcriptShown = true;
          } else {
            const exactWarmReplay =
              event.protocolVersion === 3 &&
              !event.snapshotRequired &&
              !ended &&
              !pendingHistoryRepair.has(sessionId) &&
              currentTurn?.phase !== "settling" &&
              (attachedOnce || initialResumeToken !== undefined) &&
              existing?.liveConfirmed === true;
            if (exactWarmReplay) {
              if (state.loadingMessagesFor === sessionId) {
                set((previous) =>
                  previous.loadingMessagesFor === sessionId
                    ? { ...previous, loadingMessagesFor: null }
                    : previous,
                );
              }
              if (context.unread) markRead();
              transcriptRead = true;
              transcriptShown = true;
            } else if (
              !transcriptRead ||
              event.snapshotRequired ||
              ended ||
              pendingHistoryRepair.has(sessionId) ||
              currentTurn?.phase === "settling"
            ) {
              readTranscript(effectiveSettleToken);
            }
          }
          attachedOnce = true;
          followStartCandidates = new Map(pendingUserRows.get(sessionId));
          return;
        }
        case "notice":
          if (event.persistent) {
            appendLocalMessage(sessionId, paNoticeMessage(event, localTimestampNow()));
            return;
          }
          break;
        case "session.updated":
          if (event.title || event.model) {
            patchSession(sessionId, {
              ...(event.title ? { title: event.title } : {}),
              ...(event.model ? { model: event.model } : {}),
            });
          }
          if (event.reasoningEffort) setReasoning(sessionId, event.reasoningEffort);
          return;
        case "turn.started":
          running = true;
          activity({ running: true });
          break;
        case "request.opened":
          activity({ awaiting: true });
          break;
        case "request.resolved":
          activity();
          break;
        case "turn.completed":
        case "error": {
          running = false;
          // An error ends the turn too: a send that resolves after it must not re-mark it running.
          const token = endTurn();
          pendingHistoryRepair.set(sessionId, token);
          updateLiveTurn(sessionId, (previous) => ({
            ...reducePaStreamEvent(previous, event, now()),
            settleToken: token,
          }));
          void loadTranscript(sessionId, false, token);
          if (event.type === "turn.completed" && event.replyId) {
            completedReplyIds.set(sessionId, event.replyId);
          }
          if (
            event.type === "turn.completed" &&
            event.replyId &&
            visibleHolders &&
            canMarkReadNow()
          ) {
            markRead(event.replyId);
          } else {
            activity();
          }
          return;
        }
        default:
          break;
      }
      updateLiveTurn(sessionId, (previous) => reducePaStreamEvent(previous, event, now()));
    };
    const stop = client.followSession(botId, sessionId, {
      initialResumeToken,
      latestPage: {
        limit: PA_INITIAL_PAGE_LIMIT,
        getKnownPageTag: () => getOwn(state.sessionCache, sessionId)?.pageTag ?? null,
      },
      onEvent: handleEvent,
      onResumeToken: (token) => {
        if (!closed) resumeTokens.set(sessionId, token);
      },
      onFailure: (error, { retrying }) => {
        if (closed) return;
        if (isAuthorizationError(error) || paErrorReason(error) === "Forbidden") {
          closed = true;
          runtimeReadDenied = true;
          clearAuthorizedState(true);
          return;
        }
        if (!retrying && paErrorReason(error) === "NotFound") {
          closed = true;
          stopFollow?.();
          stopFollow = null;
          followedSessionId = null;
          missingSession = { id: sessionId, cause: error };
          void recoverMissingSession(sessionId, error);
          return;
        }
        // The stored transcript is still worth showing while the live feed is down.
        if (!transcriptShown) {
          void loadTranscript(sessionId, true);
          transcriptShown = true;
        }
        showError(
          sessionId,
          formatPaError(
            error,
            retrying
              ? resolve(msg("Connection lost. Reconnecting…"))
              : resolve(msg("Could not connect to the bot session")),
          ),
        );
      },
    });
    if (closed) {
      stop();
      return;
    }
    stopFollow = () => {
      closed = true;
      stop();
    };
  };

  /** Shows a session, hydrates its cache immediately, and follows its feed when connected/held. */
  const show = (sessionId: string, notifySelection = false) => {
    missingSession = null;
    persistence?.rememberLastSession?.(sessionId);
    const cached = getOwn(state.sessionCache, sessionId);
    const cachedTurn = getOwn(state.liveTurnsBySession, sessionId);
    set((previous) =>
      previous.activeSessionId === sessionId
        ? previous
        : {
            ...previous,
            activeSessionId: sessionId,
            messages: cached
              ? { sessionId, window: cached.window }
              : { sessionId: null, window: EMPTY_TRANSCRIPT },
            liveTurn: cachedTurn ?? createInitialPaLiveTurn(sessionId),
            older: null,
            clarifyAnswers: {},
            initializationError: null,
          },
    );
    if (notifySelection) input.onSessionSelected?.(sessionId);
    follow(sessionId);
  };

  const loadSessions = async () => {
    const hadSession = state.activeSessionId !== null;
    if (!hadSession) {
      set((previous) => ({ ...previous, loadingSessions: true, initializationError: null }));
    }
    try {
      const result = await client.listSessions(botId);
      if (disposed) return;
      set((previous) => ({
        ...previous,
        sessions: result.sessions,
        sessionsCursor: result.nextCursor ?? null,
      }));
      let targetId = state.activeSessionId ?? result.primarySessionId;
      if (!targetId && visibleHolders && !state.creatingSession && canCreateSession()) {
        const created = await createPrimary();
        if (disposed) return;
        targetId = state.activeSessionId ?? created.sessionId;
        set((previous) => ({ ...previous, sessions: [created, ...previous.sessions] }));
      }
      targetId ??= result.sessions[0]?.sessionId ?? null;
      if (!targetId) return;
      const switched = state.activeSessionId !== targetId;
      show(targetId, switched);
      initialized = true;
      if (context.unread) markRead();
    } catch (error) {
      if (!state.activeSessionId) {
        set((previous) => ({
          ...previous,
          initializationError: formatPaError(
            error,
            resolve(msg("Could not connect to the bot session")),
          ),
        }));
      }
    } finally {
      set((previous) =>
        previous.loadingSessions ? { ...previous, loadingSessions: false } : previous,
      );
    }
  };

  const initialize = () => {
    if (initialization || disposed || !context.connected || !canReadNow()) {
      return initialization;
    }
    if (!context.capabilities && !state.activeSessionId) {
      return initialization;
    }
    // If we already know the target session (explicit, remembered, or roster primary), open it
    // immediately without waiting for `listSessions`.
    if (state.activeSessionId) {
      follow(state.activeSessionId);
    }
    initialization = loadSessions().finally(() => {
      initialization = null;
    });
    return initialization;
  };

  const createSession = async (title = "") => {
    const fromSessionId = state.activeSessionId;
    if (!canCreateSession() || state.creatingSession || disposed) return;
    set((previous) => ({ ...previous, creatingSession: true }));
    try {
      const primary = ensurePrimary;
      if (initialization && !state.activeSessionId) await initialization;
      else if (primary) await primary.catch(() => undefined);
      if (
        disposed ||
        !canCreateSession() ||
        (primary && !title && state.activeSessionId !== fromSessionId)
      ) {
        return;
      }
      const attempt =
        pendingSessionCreate?.title === title
          ? pendingSessionCreate
          : { title, id: makePaRequestKey("pa-session") };
      pendingSessionCreate = attempt;
      let created: PaSessionSummary;
      try {
        created = await client.createSession(botId, attempt.id, title || undefined);
        if (pendingSessionCreate !== attempt) return;
        pendingSessionCreate = null;
      } catch (error) {
        if (isPermanentPaFailure(error) && pendingSessionCreate === attempt) {
          pendingSessionCreate = null;
        }
        showError(
          fromSessionId,
          formatPaError(error, resolve(msg("Could not create the conversation"))),
        );
        return;
      }
      if (disposed) return;
      set((previous) => ({
        ...previous,
        sessions: [
          created,
          ...previous.sessions
            .filter((item) => item.sessionId !== created.sessionId)
            .map((item) => ({ ...item, isPrimary: false })),
        ],
      }));
      show(created.sessionId, true);
    } finally {
      set((previous) => ({ ...previous, creatingSession: false }));
    }
  };

  const interrupt = async () => {
    const sessionId = state.activeSessionId;
    if (!context.canOperate || !sessionId) return;
    try {
      // The turn's own completion settles it: trailing frames may still be on their way.
      await client.interruptSession(botId, sessionId);
      updateLiveTurn(sessionId, (previous) => ({ ...previous, statusText: null }));
    } catch (error) {
      showError(sessionId, formatPaError(error, resolve(msg("Could not stop the turn"))));
    }
  };

  const send = async (
    rawOverride?: string,
    options?: {
      /** Sent behind the running turn: it waits in the engine's queue. */
      readonly queued?: boolean;
      readonly attachments?: ReadonlyArray<PaAttachment>;
      /** A failed send puts the text back in the composer even though it came from elsewhere. */
      readonly restoreDraft?: boolean;
      /** Draft committed by voice dictation before this render's `draft` caught up. */
      readonly draftText?: string | undefined;
    },
  ): Promise<boolean> => {
    const sessionId = state.activeSessionId;
    const text = (
      rawOverride ??
      options?.draftText ??
      (sessionId ? (getOwn(state.drafts, sessionId) ?? "") : "")
    ).trim();
    const attachments = options?.attachments ?? [];
    if (
      (!text && !attachments.length) ||
      !sessionId ||
      state.sending ||
      disposed ||
      !context.canOperate
    ) {
      return false;
    }
    const queued = options?.queued === true;
    const draftRevision = draftEdits.get(sessionId);
    const restoreDraft = rawOverride === undefined || options?.restoreDraft === true;

    // The engine's catalog marks the commands a client runs itself (new session, stop, model).
    const clientAction = attachments.length
      ? null
      : parsePaClientSlashAction(text, commandsSupported() ? state.slashCommands : []);
    if (clientAction) {
      if (clientAction.kind === "model-picker" && !openModelPicker) return false;
      set((previous) => ({ ...previous, sending: true }));
      try {
        if (restoreDraft) {
          setDraftFor(sessionId, (current) => (current.trim() === text ? "" : current));
        }
        showError(sessionId, null);
        switch (clientAction.kind) {
          case "new-session":
            if (!canCreateSession()) {
              showError(sessionId, resolve(msg("This bot cannot create conversations")));
              return false;
            }
            await createSession(clientAction.title);
            return true;
          case "interrupt":
            if (capabilities()?.execution.interrupt === false) {
              showError(sessionId, resolve(msg("This bot cannot stop a reply")));
              return false;
            }
            await interrupt();
            return true;
          case "model-picker":
            openModelPicker?.(clientAction.query);
            return true;
        }
      } finally {
        set((previous) => ({ ...previous, sending: false }));
      }
    }
    set((previous) => ({ ...previous, sending: true }));
    showError(sessionId, null);
    if (restoreDraft && !attachments.length) {
      setDraftFor(sessionId, (current) => (current.trim() === text ? "" : current));
    }

    // A local row until a reload shows it stored; only an admitted turn is ever stored. A queued
    // send gets none: the queue strip shows it once the engine lists it.
    const optimistic = createPaLocalMessage("user", text, localTimestampNow());
    if (!queued && !attachments.length) appendLocalMessage(sessionId, optimistic);
    const completedBeforeSend = settleTokens.get(sessionId);
    const done = (ok: boolean) => {
      set((previous) => ({ ...previous, sending: false }));
      return ok;
    };
    try {
      const { result, inputId } = await sendPaChatMessage(
        failedSends,
        sessionId,
        text,
        () => makePaRequestKey("pa"),
        (id) => client.sendMessage(botId, sessionId, text, id, queued, attachments),
        attachments.map((item) => item.id),
      );
      if (attachments.length && result.kind === "turn") {
        setDraftFor(sessionId, (current) => (current.trim() === text ? "" : current));
      }
      if (result.unknown) {
        removeLocalMessage(sessionId, optimistic.id);
        activity();
        return done(true);
      }
      if (result.kind === "turn" && result.queued === true) return done(true);
      if (attachments.length ? result.kind === "turn" : queued) {
        appendLocalMessage(sessionId, {
          ...optimistic,
          ...(result.attachments ? { attachments: result.attachments } : {}),
        });
      }
      const settleToken = settleTokens.get(sessionId);
      const turnEnded = trackAdmittedPaRow(
        pendingUserRows,
        sessionId,
        optimistic.id,
        result,
        settleToken !== completedBeforeSend,
      );
      if (result.kind === "turn" && result.submissionId) {
        pendingSubmissionIds.set(optimistic.id, result.submissionId);
      }
      if (result.kind === "output") {
        // The engine stores neither a command nor its output: both stay local rows.
        appendLocalMessage(
          sessionId,
          paNoticeMessage(
            {
              message: result.output || result.notice || resolve(msg("Command executed")),
              inputId,
            },
            localTimestampNow(),
          ),
        );
        activity();
        // A consumed voice stop can return output without admitting the selected images.
        if (attachments.length) return done(false);
      } else if (turnEnded) {
        // A turn that ended before this answer arrived was read without this row: read again.
        if (settleToken !== undefined) pendingHistoryRepair.set(sessionId, settleToken);
        if (state.activeSessionId === sessionId) void loadTranscript(sessionId, false, settleToken);
        if (result.settled) activity();
      } else {
        if (state.activeSessionId === sessionId) running = true;
        updateLiveTurn(sessionId, (previous) => startPaLiveTurnLocally(previous, now()));
        activity({ running: true });
      }
    } catch (error) {
      removeLocalMessage(sessionId, optimistic.id);
      if (!attachments.length && restoreDraft && draftRevision === draftEdits.get(sessionId)) {
        setDraftFor(sessionId, (current) => (current ? current : text));
      }
      showError(sessionId, formatPaError(error, resolve(msg("Could not send message"))));
      return done(false);
    }
    return done(true);
  };

  // Seed disk cache immediately if a session id is already known at construction time.
  if (seedSessionId) hydrateFromDisk(seedSessionId);

  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getState: () => state,
    /** Keeps the live feed active while at least one view holds this Bot; releasing stops the feed only. */
    hold() {
      holdUsed = true;
      holders += 1;
      if (holders === 1 && state.activeSessionId && canFollowNow()) {
        follow(state.activeSessionId);
      }
      return () => {
        holders = Math.max(0, holders - 1);
        if (holders === 0) {
          stopFollowing();
          flushPersistence();
        }
      };
    },
    /** Non-destructive pre-open hint used during navigation; never lowers a mounted view's permissions. */
    prime(hint: PaBotChatPrimeHint) {
      if (disposed || hint.readDenied === true || isReadDeniedNow()) return;
      const hintSessionId = persistence?.getRememberedSession?.() ?? hint.primarySessionId ?? null;
      if (!state.activeSessionId && hintSessionId) {
        show(hintSessionId, false);
      } else if (state.activeSessionId && !hasOwn(state.sessionCache, state.activeSessionId)) {
        hydrateFromDisk(state.activeSessionId);
      }
      if (state.started) {
        if (hint.connected && state.activeSessionId && canFollowNow() && !stopFollow) {
          follow(state.activeSessionId);
        }
        return;
      }
      context = {
        ...context,
        capabilities: context.capabilities ?? hint.capabilities,
        primarySessionId: context.primarySessionId ?? hint.primarySessionId ?? null,
        connected: context.connected || hint.connected,
      };
      if (!context.connected || (!context.capabilities && !state.activeSessionId)) return;
      set((prev) => ({ ...prev, started: true }));
      return initialize();
    },
    /** The page's latest view of the Bot; hydrates cached history even offline, starts live sync once connected. */
    setContext(next: PaBotChatContext) {
      const previous = context;
      context = next;
      if (disposed) return;
      if (next.readDenied === true) {
        clearAuthorizedState(true);
        return;
      }
      if (runtimeReadDenied && !previous.connected && next.connected) {
        runtimeReadDenied = false;
        set((prev) => (prev.readDenied ? { ...prev, readDenied: false } : prev));
      } else if (state.readDenied && !runtimeReadDenied) {
        set((prev) => (prev.readDenied ? { ...prev, readDenied: false } : prev));
      }
      if (isReadDeniedNow()) return;
      const hintSessionId = persistence?.getRememberedSession?.() ?? next.primarySessionId ?? null;
      if (!state.activeSessionId && hintSessionId) {
        show(hintSessionId, false);
      } else if (state.activeSessionId && !hasOwn(state.sessionCache, state.activeSessionId)) {
        hydrateFromDisk(state.activeSessionId);
      }
      if (!next.connected) {
        stopFollowing();
        return;
      }
      if (!commandsLoaded && next.capabilities && commandsSupported()) {
        commandsLoaded = true;
        client.listCommands(botId).then(
          (commands) => set((prev) => ({ ...prev, slashCommands: commands })),
          () => {
            commandsLoaded = false;
          },
        );
      }
      if (state.started) {
        if (
          missingSession &&
          visibleHolders &&
          (!previous.connected || (!previous.canOperate && next.canOperate))
        ) {
          void recoverMissingSession(missingSession.id, missingSession.cause);
        } else if (
          !initialized &&
          (!previous.connected ||
            (!previous.canOperate && next.canOperate) ||
            (!previous.capabilities && next.capabilities !== null))
        ) {
          void initialize();
        } else if (state.activeSessionId && canFollowNow() && !stopFollow) {
          follow(state.activeSessionId);
        }
        if (next.unread && !previous.unread && state.activeSessionId) markRead();
        return;
      }
      if (!next.capabilities && !state.activeSessionId) return;
      set((prev) => ({ ...prev, started: true }));
      return initialize();
    },
    retryInitialization: () => {
      if (context.readDenied === true) return Promise.resolve();
      if (runtimeReadDenied) {
        runtimeReadDenied = false;
        set((prev) => (prev.readDenied ? { ...prev, readDenied: false } : prev));
      }
      return missingSession
        ? recoverMissingSession(missingSession.id, missingSession.cause)
        : initialize();
    },
    holdVisible() {
      visibleHolders += 1;
      if (state.activeSessionId && context.unread) markRead();
      if (missingSession) void recoverMissingSession(missingSession.id, missingSession.cause);
      else if (!initialized && state.started) void initialize();
      return () => {
        visibleHolders -= 1;
      };
    },
    isDisposed: () => disposed,
    showSession(sessionId: string) {
      if (state.activeSessionId !== sessionId || (!stopFollow && canFollowNow())) {
        pendingSessionCreate = null;
        show(sessionId, false);
      }
    },
    setOpenModelPicker(handler: ((query: string) => void) | null) {
      openModelPicker = handler;
    },
    setDraft(value: string) {
      if (state.activeSessionId) editDraft(state.activeSessionId, value);
    },
    getDraftFor: (sessionId: string) => getOwn(state.drafts, sessionId) ?? "",
    /** Edits one session's draft whichever session is shown, as a recording that outlived it does. */
    setDraftForSession: editDraft,
    selectSession(session: PaSessionSummary) {
      set((previous) => ({
        ...previous,
        sessions: appendPaSessionPage(previous.sessions, [session]),
      }));
      if (session.sessionId === state.activeSessionId) return;
      pendingSessionCreate = null;
      show(session.sessionId, true);
    },
    createSession,
    patchSession,
    async loadMoreSessions() {
      const cursor = state.sessionsCursor;
      if (!cursor || state.loadingMoreSessions) return;
      set((previous) => ({ ...previous, loadingMoreSessions: true }));
      try {
        const result = await client.listSessions(botId, { cursor });
        set((previous) => ({
          ...previous,
          sessions: appendPaSessionPage(previous.sessions, result.sessions),
          sessionsCursor: result.nextCursor ?? null,
        }));
      } catch (error) {
        showError(
          state.activeSessionId,
          formatPaError(error, resolve(msg("Could not load more conversations"))),
        );
      }
      set((previous) => ({ ...previous, loadingMoreSessions: false }));
    },
    async loadOlderMessages() {
      const sessionId = state.activeSessionId;
      const cached = sessionId ? getOwn(state.sessionCache, sessionId) : undefined;
      const cursor = cached?.window.olderCursor;
      if (!sessionId || !cached || !cursor) return;
      if (state.older?.sessionId === sessionId && state.older.loading) return;
      set((previous) => ({ ...previous, older: { sessionId, loading: true, error: null } }));
      try {
        const page = await client.getMessages(botId, sessionId, { cursor });
        const latest = getOwn(state.sessionCache, sessionId);
        set((previous) => ({
          ...previous,
          older: previous.older?.sessionId === sessionId ? null : previous.older,
        }));
        if (!latest || latest.window.olderCursor !== cursor) return;
        const nextWindow = prependPaOlderPage(latest.window, page);
        writeSessionCache(sessionId, {
          ...latest,
          window: nextWindow,
          expanded:
            page.reset !== true && nextWindow.messages.length > latest.window.messages.length,
        });
      } catch (error) {
        set((previous) =>
          previous.older?.sessionId === sessionId
            ? {
                ...previous,
                older: {
                  sessionId,
                  loading: false,
                  error: formatPaError(error, resolve(msg("Could not load earlier messages"))),
                },
              }
            : previous,
        );
      }
    },
    failedAttachmentKey(sessionId: string, text: string) {
      const attempt = failedSends.get(sessionId);
      return attempt?.text === text.trim() ? attempt.attachmentKey : undefined;
    },
    send,
    /** Hands the draft to the running turn; one the turn ended too early to take is sent normally. */
    async steer() {
      const sessionId = state.activeSessionId;
      const text = sessionId ? (getOwn(state.drafts, sessionId) ?? "").trim() : "";
      if (!text || !sessionId || state.sending || !context.canOperate) return;
      set((previous) => ({ ...previous, sending: true }));
      setDraftFor(sessionId, "");
      showError(sessionId, null);
      const settleToken = settleTokens.get(sessionId);
      let sendInstead = false;
      try {
        const result = await client.steerSession(botId, sessionId, text);
        if (!disposed && state.activeSessionId === sessionId) {
          if (result.status === "voiceStopped") {
            if (input.onVoiceStopped) input.onVoiceStopped();
            else showError(sessionId, resolve(msg("Voice chat stopped.")));
          } else if (result.status === "delivered" && settleTokens.get(sessionId) !== settleToken) {
            const latestToken = settleTokens.get(sessionId);
            if (latestToken !== undefined) pendingHistoryRepair.set(sessionId, latestToken);
            void loadTranscript(sessionId, false, latestToken);
          } else if (result.status === "delivered") {
            // Stored with the running turn: a local row until that turn's reload shows it.
            const row = createPaLocalMessage("user", text, localTimestampNow());
            appendLocalMessage(sessionId, row);
            const pending = pendingUserRows.get(sessionId) ?? new Map<string, boolean>();
            pending.set(row.id, false);
            pendingUserRows.set(sessionId, pending);
          } else {
            sendInstead = true;
          }
        } else if (result.status === "notDelivered") {
          setDraftFor(sessionId, (current) => (current ? `${text}\n${current}` : text));
        }
      } catch (error) {
        // Never re-sent: the engine may already have handed it to the agent.
        setDraftFor(sessionId, (current) => (current ? `${text}\n${current}` : text));
        showError(sessionId, formatPaError(error, resolve(msg("Could not steer the turn"))));
      }
      set((previous) => ({ ...previous, sending: false }));
      if (sendInstead && !disposed && state.activeSessionId === sessionId) {
        await send(text, { queued: running, restoreDraft: true });
      }
    },
    interrupt,
    async manageQueuedItem(item: PaQueuedItem, action: PaManageQueuedItemInput["action"]) {
      const sessionId = state.activeSessionId;
      if (!context.canOperate || !sessionId || state.queueBusyIds.has(item.id)) return;
      set((previous) => ({ ...previous, queueBusyIds: withId(previous.queueBusyIds, item.id) }));
      try {
        // The engine's next queue report moves or removes the item for every viewer.
        await client.manageQueuedItem(botId, sessionId, item.id, action);
      } catch (error) {
        showError(
          sessionId,
          formatPaError(
            error,
            action === "cancel"
              ? resolve(msg("Could not cancel the queued message"))
              : action === "steer"
                ? resolve(msg("Could not steer the turn"))
                : resolve(msg("Could not resume the queue")),
          ),
        );
      }
      set((previous) => ({
        ...previous,
        queueBusyIds: withoutId(previous.queueBusyIds, item.id),
      }));
    },
    setClarifyAnswer(requestId: string, questionId: string, value: PaClarifyAnswer) {
      set((previous) => ({
        ...previous,
        clarifyAnswers: {
          ...previous.clarifyAnswers,
          [requestId]: { ...previous.clarifyAnswers[requestId], [questionId]: value },
        },
      }));
    },
    async respondRequest(
      request: PaPendingRequest,
      decision?: string,
      answersOverride?: PaClarifyAnswers,
    ) {
      const sessionId = state.activeSessionId;
      if (!context.canOperate || !sessionId || state.respondingIds.has(request.requestId)) return;
      const answers = answersOverride ?? state.clarifyAnswers[request.requestId];
      set((previous) => ({
        ...previous,
        respondingIds: withId(previous.respondingIds, request.requestId),
      }));
      try {
        await client.respondRequest({
          botId,
          sessionId,
          requestId: request.requestId,
          ...(decision ? { decision } : {}),
          ...(request.kind === "clarify" && answers ? { answers } : {}),
        });
        updateLiveTurn(sessionId, (previous) => ({
          ...previous,
          openRequests: previous.openRequests.filter(
            (item) => item.requestId !== request.requestId,
          ),
        }));
      } catch (error) {
        showError(sessionId, formatPaError(error, resolve(msg("Could not answer the request"))));
      }
      set((previous) => ({
        ...previous,
        respondingIds: withoutId(previous.respondingIds, request.requestId),
      }));
    },
    /** The values go straight to the engine: nothing here keeps or reports them. */
    async respondSecret(request: PaPendingRequest, answer: PaSecretAnswer): Promise<boolean> {
      const sessionId = state.activeSessionId;
      if (!context.canOperate || !sessionId || state.respondingIds.has(request.requestId)) {
        return false;
      }
      set((previous) => ({
        ...previous,
        respondingIds: withId(previous.respondingIds, request.requestId),
      }));
      let ok = false;
      try {
        await client.respondRequest({
          botId,
          sessionId,
          requestId: request.requestId,
          ...(answer.type === "skip" ? { skip: true } : { values: answer.values }),
        });
        updateLiveTurn(sessionId, (previous) => ({
          ...previous,
          openRequests: previous.openRequests.filter(
            (item) => item.requestId !== request.requestId,
          ),
        }));
        ok = true;
      } catch (error) {
        showError(
          sessionId,
          isAuthorizationError(error) || paErrorReason(error) === "Forbidden"
            ? resolve(msg("You need permission to manage providers to answer this request."))
            : resolve(msg("Could not submit credentials")),
        );
      }
      set((previous) => ({
        ...previous,
        respondingIds: withoutId(previous.respondingIds, request.requestId),
      }));
      return ok;
    },
    dismissError() {
      showError(state.activeSessionId, null);
    },
    setError(message: string | null) {
      showError(state.activeSessionId, message);
    },
    setReasoning,
    /** The Bot's settings or model changed elsewhere: readers of them read again. */
    bumpSettings() {
      set((previous) => ({ ...previous, settingsVersion: previous.settingsVersion + 1 }));
      activity();
    },
    dispose(options?: { readonly discardPending?: boolean }) {
      if (options?.discardPending) {
        discardPendingPersistence();
      } else {
        flushPersistence();
      }
      disposed = true;
      stopFollowing();
      listeners.clear();
    },
  };
}

export type PaBotChat = ReturnType<typeof createPaBotChat>;

const timelineCache = new WeakMap<
  ReadonlyArray<PaMessage>,
  {
    local: ReadonlyArray<PaMessage>;
    items: ReturnType<typeof buildPaTimelineItems>;
  }
>();

function timelineFor(messages: ReadonlyArray<PaMessage>, local: ReadonlyArray<PaMessage>) {
  const cached = timelineCache.get(messages);
  if (cached?.local === local) return cached.items;
  const items = buildPaTimelineItems(mergePaMessagesByTime(messages, local));
  timelineCache.set(messages, { local, items });
  return items;
}

export function paBotChatView(state: PaBotChatState) {
  const sessionId = state.activeSessionId;
  const cached = sessionId ? getOwn(state.sessionCache, sessionId) : undefined;
  const transcript =
    cached?.window ??
    (state.messages.sessionId === sessionId ? state.messages.window : EMPTY_TRANSCRIPT);
  const liveTurn =
    (sessionId ? getOwn(state.liveTurnsBySession, sessionId) : undefined) ??
    (state.liveTurn.sessionId === sessionId ? state.liveTurn : createInitialPaLiveTurn(sessionId));
  const local = (sessionId && getOwn(state.localBySession, sessionId)) || EMPTY_TRANSCRIPT.messages;
  const hasTranscript = cached !== undefined || state.messages.sessionId === sessionId;
  return {
    sessionId,
    transcript,
    liveTurn,
    running: liveTurn.phase === "running",
    hasLiveTurn: liveTurn.phase !== "idle" || liveTurn.blocks.length > 0,
    timelineItems: timelineFor(transcript.messages, local),
    /** True only when read access is not denied and no renderable transcript window exists yet. */
    loadingMessages: !state.readDenied && sessionId !== null && !hasTranscript,
    readDenied: state.readDenied,
    isFromCache: cached !== undefined && !cached.liveConfirmed,
    older: state.older?.sessionId === sessionId ? state.older : null,
    draft: sessionId ? (getOwn(state.drafts, sessionId) ?? "") : "",
    activeSession: state.sessions.find((item) => item.sessionId === sessionId) ?? null,
  };
}
