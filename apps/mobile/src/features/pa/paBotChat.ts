import {
  createPaLocalMessage,
  makePaRequestKey,
  sendPaChatMessage,
  trackAdmittedPaRow,
} from "@t3tools/client-runtime/pa/chat";
import { isPermanentPaFailure, paErrorReason } from "@t3tools/client-runtime/pa/environment";
import {
  appendPaSessionPage,
  mergePaLatestPage,
  paUserMessageContentKey,
  prependPaOlderPage,
  type PaTranscriptWindow,
} from "@t3tools/client-runtime/pa/history";
import { parsePaClientSlashAction } from "@t3tools/client-runtime/pa/slash";
import {
  buildPaTimelineItems,
  clearSettledPaLiveTurn,
  mergePaMessagesByTime,
  createInitialPaLiveTurn,
  nextPaLocalTimestamp,
  paNoticeMessage,
  reducePaStreamEvent,
  startPaLiveTurnLocally,
  type PaLiveTurnState,
} from "@t3tools/client-runtime/pa/timeline";
import {
  EnvironmentAuthorizationError,
  type PaAttachment,
  type PaCapabilities,
  type PaClarifyAnswer,
  type PaManageQueuedItemInput,
  type PaMessage,
  type PaPendingRequest,
  type PaQueuedItem,
  type PaSessionSummary,
  type PaSlashCommand,
  type PaStreamEvent,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { msg } from "gt-react-native";

import { m } from "../../i18n/messages";
import { paErrorMessage, type PaClient } from "./paApi";

export type PaClarifyAnswers = Readonly<Record<string, PaClarifyAnswer>>;
export type PaSecretAnswer =
  | { readonly type: "submit"; readonly values: Readonly<Record<string, string>> }
  | { readonly type: "skip" };

/** What the page knows about the Bot; the controller reads the latest on every action. */
export interface PaBotChatContext {
  readonly capabilities: PaCapabilities | null;
  readonly canOperate: boolean;
  readonly unread: boolean;
  readonly connected: boolean;
}

export interface PaBotChatState {
  readonly started: boolean;
  readonly sessions: ReadonlyArray<PaSessionSummary>;
  readonly sessionsCursor: string | null;
  readonly loadingSessions: boolean;
  readonly loadingMoreSessions: boolean;
  readonly creatingSession: boolean;
  readonly initializationError: string | null;
  readonly activeSessionId: string | null;
  readonly messages: { readonly sessionId: string | null; readonly window: PaTranscriptWindow };
  readonly loadingMessagesFor: string | null;
  readonly older: {
    readonly sessionId: string;
    readonly loading: boolean;
    readonly error: string | null;
  } | null;
  readonly localBySession: Readonly<Record<string, ReadonlyArray<PaMessage>>>;
  readonly liveTurn: PaLiveTurnState;
  readonly slashCommands: ReadonlyArray<PaSlashCommand>;
  readonly drafts: Readonly<Record<string, string>>;
  readonly sending: boolean;
  readonly respondingIds: ReadonlySet<string>;
  readonly queueBusyIds: ReadonlySet<string>;
  readonly clarifyAnswers: Readonly<Record<string, PaClarifyAnswers>>;
  readonly sessionReasoning: {
    readonly sessionId: string;
    readonly effort: string;
    readonly settingsVersion: number;
  } | null;
  /** Bumped when the Bot's settings or model change, so readers of them read again. */
  readonly settingsVersion: number;
}

const EMPTY_TRANSCRIPT: PaTranscriptWindow = { messages: [], olderCursor: null };
const isAuthorizationError = Schema.is(EnvironmentAuthorizationError);

function initialState(sessionId: string | null): PaBotChatState {
  return {
    started: false,
    sessions: [],
    sessionsCursor: null,
    loadingSessions: true,
    loadingMoreSessions: false,
    creatingSession: false,
    initializationError: null,
    activeSessionId: sessionId,
    messages: { sessionId: null, window: EMPTY_TRANSCRIPT },
    loadingMessagesFor: null,
    older: null,
    localBySession: {},
    liveTurn: createInitialPaLiveTurn(sessionId),
    slashCommands: [],
    drafts: {},
    sending: false,
    respondingIds: new Set(),
    queueBusyIds: new Set(),
    clarifyAnswers: {},
    sessionReasoning: null,
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
 * One Bot's conversation: its sessions, the shown session's transcript and live turn, and every
 * action on them. The Bot page and its sheets share it, so a sheet's switch or create shows on
 * the page behind it. It follows the shown session's feed while anything holds it.
 */
export function createPaBotChat(input: {
  readonly api: PaClient;
  readonly botId: string;
  readonly initialSessionId?: string | null;
  readonly now?: () => number;
  readonly onActivity?: () => void;
}) {
  const { api: client, botId } = input;
  const now = input.now ?? Date.now;
  let state = initialState(input.initialSessionId ?? null);
  let context: PaBotChatContext = {
    capabilities: null,
    canOperate: false,
    unread: false,
    connected: false,
  };
  let disposed = false;
  let visibleHolders = 0;
  let initialized = false;
  let initialization: Promise<void> | null = null;
  let markingRead = false;
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
  const failedSends = new Map<string, { text: string; inputId: string; attachmentKey?: string }>();
  /** An admitted row can be reconciled by text, or by turn completion for rewritten prompts. */
  const pendingUserRows = new Map<string, Map<string, boolean>>();
  const recoveredSessions = new Set<string>();
  let pendingSessionCreate: { readonly title: string; readonly id: string } | null = null;
  const listeners = new Set<() => void>();

  const set = (update: (previous: PaBotChatState) => PaBotChatState) => {
    if (disposed) return;
    const next = update(state);
    if (next === state) return;
    state = next;
    for (const listener of listeners) listener();
  };

  const activity = () => input.onActivity?.();

  const markRead = () => {
    if (!visibleHolders || !context.canOperate || !context.connected || markingRead || disposed)
      return;
    markingRead = true;
    void client
      .markRead(botId)
      .then(activity, () => undefined)
      .finally(() => {
        markingRead = false;
      });
  };

  const updateLiveTurn = (
    sessionId: string | null,
    updater: (previous: PaLiveTurnState) => PaLiveTurnState,
  ) => {
    if (state.activeSessionId !== sessionId) return;
    set((previous) => {
      const base =
        previous.liveTurn.sessionId === sessionId
          ? previous.liveTurn
          : createInitialPaLiveTurn(sessionId);
      const liveTurn = { ...updater(base), sessionId };
      let clarifyAnswers = previous.clarifyAnswers;
      if (base.openRequests !== liveTurn.openRequests) {
        for (const request of base.openRequests) {
          if (
            request.requestId in clarifyAnswers &&
            !liveTurn.openRequests.some((r) => r.requestId === request.requestId)
          ) {
            const next = { ...clarifyAnswers };
            delete next[request.requestId];
            clarifyAnswers = next;
          }
        }
      }
      return { ...previous, liveTurn, clarifyAnswers };
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
        [sessionId]: typeof value === "function" ? value(previous.drafts[sessionId] ?? "") : value,
      },
    }));

  const mergedLocal = (sessionId: string) => state.localBySession[sessionId] ?? [];

  const localTimestampNow = () => {
    const shown =
      state.messages.sessionId === state.activeSessionId ? state.messages.window.messages : [];
    const local = state.activeSessionId ? mergedLocal(state.activeSessionId) : [];
    return nextPaLocalTimestamp([...shown, ...local], now());
  };

  const appendLocalMessage = (sessionId: string, message: PaMessage) =>
    set((previous) => {
      const existing = previous.localBySession[sessionId] ?? [];
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
    set((previous) => {
      const existing = previous.localBySession[sessionId];
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

  const loadTranscript = (
    sessionId: string,
    showSpinner: boolean,
    expectedSettleToken?: number,
  ) => {
    const request = ++transcriptRequest;
    const current = () =>
      !disposed && transcriptRequest === request && state.activeSessionId === sessionId;
    if (showSpinner) set((previous) => ({ ...previous, loadingMessagesFor: sessionId }));
    // Only rows admitted before this read started can be in what it returns.
    const candidates = new Map(pendingUserRows.get(sessionId));
    return client
      .getMessages(botId, sessionId)
      .then((page) => {
        if (!current()) return;
        set((previous) => ({
          ...previous,
          messages: {
            sessionId,
            window: mergePaLatestPage(
              previous.messages.sessionId === sessionId ? previous.messages.window : null,
              page,
            ),
          },
        }));
        if (candidates.size > 0) {
          const storedUsers = new Set(
            page.messages.flatMap((item) =>
              item.role === "user" ? [paUserMessageContentKey(item)] : [],
            ),
          );
          set((previous) => {
            const existing = previous.localBySession[sessionId] ?? [];
            // Stored as typed, or (a command rewritten into a prompt) once its turn has ended.
            const reconciled = new Set(
              existing
                .filter(
                  (item) =>
                    candidates.has(item.id) &&
                    (candidates.get(item.id) || storedUsers.has(paUserMessageContentKey(item))),
                )
                .map((item) => item.id),
            );
            if (reconciled.size === 0) return previous;
            const pending = pendingUserRows.get(sessionId);
            for (const id of reconciled) pending?.delete(id);
            return {
              ...previous,
              localBySession: {
                ...previous.localBySession,
                [sessionId]: existing.filter((item) => !reconciled.has(item.id)),
              },
            };
          });
        }
        if (expectedSettleToken !== undefined) {
          updateLiveTurn(sessionId, (previous) =>
            clearSettledPaLiveTurn(previous, expectedSettleToken),
          );
        }
      })
      .catch((error: unknown) => {
        if (!current()) return;
        // A first read that fails still ends the spinner; a failed reload keeps what is shown.
        set((previous) =>
          previous.messages.sessionId === sessionId
            ? previous
            : { ...previous, messages: { sessionId, window: EMPTY_TRANSCRIPT } },
        );
        showError(sessionId, paErrorMessage(error, m(msg("Could not load messages"))));
      })
      .finally(() => {
        if (transcriptRequest === request) {
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
    if (recoveredSessions.has(missingId)) return;
    recoveredSessions.add(missingId);
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
        showError(missingId, paErrorMessage(cause, m(msg("This conversation no longer exists"))));
        return;
      }
      show(nextId);
    } catch (error) {
      showError(missingId, paErrorMessage(error, m(msg("Could not connect to the bot session"))));
    }
  };

  const follow = (sessionId: string | null) => {
    if (followedSessionId === sessionId && stopFollow) return;
    stopFollow?.();
    stopFollow = null;
    transcriptRequest += 1;
    followedSessionId = sessionId;
    if (!sessionId || disposed) return;
    let closed = false;
    // Read the transcript only once the feed is attached, so nothing lands between the two. A
    // fallback read while the feed is down does not count: the first snapshot still reads again.
    let transcriptRead = false;
    let transcriptShown = false;
    const readTranscript = () => {
      void loadTranscript(sessionId, !transcriptShown);
      transcriptRead = true;
      transcriptShown = true;
    };
    running = false;
    const endTurn = () => {
      const token = (settleTokens.get(sessionId) ?? 0) + 1;
      settleTokens.set(sessionId, token);
      const pending = pendingUserRows.get(sessionId);
      pending?.forEach((_ended, id) => pending.set(id, true));
      return token;
    };
    const handleEvent = (event: PaStreamEvent) => {
      if (closed || state.activeSessionId !== sessionId) return;
      switch (event.type) {
        case "snapshot":
          const ended = running && !event.running;
          if (ended) endTurn();
          running = event.running;
          updateLiveTurn(sessionId, (previous) => reducePaStreamEvent(previous, event, now()));
          if (!transcriptRead || event.snapshotRequired || ended) readTranscript();
          return;
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
          if (event.reasoningEffort) {
            const effort = event.reasoningEffort;
            set((previous) => ({
              ...previous,
              sessionReasoning: { sessionId, effort, settingsVersion: previous.settingsVersion },
            }));
          }
          return;
        case "turn.started":
          running = true;
          break;
        case "turn.completed":
        case "error": {
          running = false;
          // An error ends the turn too: a send that resolves after it must not re-mark it running.
          const token = endTurn();
          updateLiveTurn(sessionId, (previous) => ({
            ...reducePaStreamEvent(previous, event, now()),
            settleToken: token,
          }));
          void loadTranscript(sessionId, false, token);
          if (event.type === "turn.completed") {
            if (visibleHolders) markRead();
            else activity();
          }
          return;
        }
        default:
          break;
      }
      updateLiveTurn(sessionId, (previous) => reducePaStreamEvent(previous, event, now()));
    };
    const stop = client.followSession(botId, sessionId, {
      onEvent: handleEvent,
      onFailure: (error, { retrying }) => {
        if (closed) return;
        // The stored transcript is still worth showing while the live feed is down.
        if (!transcriptShown) {
          void loadTranscript(sessionId, true);
          transcriptShown = true;
        }
        if (!retrying && paErrorReason(error) === "NotFound") {
          void recoverMissingSession(sessionId, error);
          return;
        }
        showError(
          sessionId,
          paErrorMessage(
            error,
            retrying
              ? m(msg("Connection lost. Reconnecting…"))
              : m(msg("Could not connect to the bot session")),
          ),
        );
      },
    });
    stopFollow = () => {
      closed = true;
      stop();
    };
  };

  /** Shows a session and follows its feed. */
  const show = (sessionId: string) => {
    set((previous) =>
      previous.activeSessionId === sessionId
        ? previous
        : { ...previous, activeSessionId: sessionId, older: null, clarifyAnswers: {} },
    );
    follow(sessionId);
  };

  const loadSessions = async () => {
    set((previous) => ({ ...previous, loadingSessions: true, initializationError: null }));
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
      show(targetId);
      initialized = true;
      if (context.unread) markRead();
    } catch (error) {
      set((previous) => ({
        ...previous,
        initializationError: paErrorMessage(error, m(msg("Could not connect to the bot session"))),
      }));
    } finally {
      set((previous) => ({ ...previous, loadingSessions: false }));
    }
  };

  const initialize = () => {
    if (initialization || disposed || !context.capabilities || !context.connected)
      return initialization;
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
      if (initialization) await initialization;
      else if (primary) await primary.catch(() => undefined);
      if (
        disposed ||
        !canCreateSession() ||
        (primary && !title && state.activeSessionId !== fromSessionId)
      )
        return;
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
          paErrorMessage(error, m(msg("Could not create the conversation"))),
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
      show(created.sessionId);
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
      showError(sessionId, paErrorMessage(error, m(msg("Could not stop the turn"))));
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
    },
  ): Promise<boolean> => {
    const sessionId = state.activeSessionId;
    const text = (rawOverride ?? (sessionId ? (state.drafts[sessionId] ?? "") : "")).trim();
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
      set((previous) => ({ ...previous, sending: true }));
      try {
        if (restoreDraft)
          setDraftFor(sessionId, (current) => (current.trim() === text ? "" : current));
        showError(sessionId, null);
        switch (clientAction.kind) {
          case "new-session":
            if (!canCreateSession()) {
              showError(sessionId, m(msg("This bot cannot create conversations")));
              return false;
            }
            await createSession(clientAction.title);
            return true;
          case "interrupt":
            if (capabilities()?.execution.interrupt === false) {
              showError(sessionId, m(msg("This bot cannot stop a reply")));
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
    if (restoreDraft && !attachments.length)
      setDraftFor(sessionId, (current) => (current.trim() === text ? "" : current));

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
      // Waiting behind the running turn, which keeps streaming untouched.
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
      if (result.kind === "output") {
        // The engine stores neither a command nor its output: both stay local rows.
        appendLocalMessage(
          sessionId,
          paNoticeMessage(
            { message: result.output || result.notice || m(msg("Command executed")), inputId },
            localTimestampNow(),
          ),
        );
        activity();
        // A consumed voice stop can return output without admitting the selected images.
        if (attachments.length) return done(false);
      } else if (turnEnded) {
        // A turn that ended before this answer arrived was read without this row: read again.
        if (state.activeSessionId === sessionId) void loadTranscript(sessionId, false, settleToken);
        if (result.settled) activity();
      } else {
        if (state.activeSessionId === sessionId) running = true;
        updateLiveTurn(sessionId, (previous) => startPaLiveTurnLocally(previous, now()));
      }
    } catch (error) {
      removeLocalMessage(sessionId, optimistic.id);
      if (!attachments.length && restoreDraft && draftRevision === draftEdits.get(sessionId)) {
        setDraftFor(sessionId, (current) => (current ? current : text));
      }
      showError(sessionId, paErrorMessage(error, m(msg("Could not send message"))));
      return done(false);
    }
    return done(true);
  };

  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getState: () => state,
    /** The page's latest view of the Bot; the first one with capabilities starts the chat. */
    setContext(next: PaBotChatContext) {
      const previous = context;
      context = next;
      if (disposed || !next.capabilities || !next.connected) return;
      if (state.started) {
        if (!initialized && (!previous.connected || (!previous.canOperate && next.canOperate)))
          void initialize();
        if (next.unread && !previous.unread && state.activeSessionId) markRead();
        return;
      }
      set((previous) => ({ ...previous, started: true }));
      if (commandsSupported()) {
        client.listCommands(botId).then(
          (commands) => set((previous) => ({ ...previous, slashCommands: commands })),
          () => undefined,
        );
      }
      return initialize();
    },
    retryInitialization: initialize,
    holdVisible() {
      visibleHolders += 1;
      if (state.activeSessionId && context.unread) markRead();
      if (!initialized && state.started) void initialize();
      return () => {
        visibleHolders -= 1;
      };
    },
    isDisposed: () => disposed,
    showSession(sessionId: string) {
      if (state.activeSessionId !== sessionId || !stopFollow) {
        pendingSessionCreate = null;
        show(sessionId);
      }
    },
    setOpenModelPicker(handler: ((query: string) => void) | null) {
      openModelPicker = handler;
    },
    setDraft(value: string) {
      const sessionId = state.activeSessionId;
      if (!sessionId || (state.drafts[sessionId] ?? "") === value) return;
      draftEdits.set(sessionId, (draftEdits.get(sessionId) ?? 0) + 1);
      setDraftFor(sessionId, value);
    },
    selectSession(session: PaSessionSummary) {
      set((previous) => ({
        ...previous,
        sessions: appendPaSessionPage(previous.sessions, [session]),
      }));
      if (session.sessionId === state.activeSessionId) return;
      pendingSessionCreate = null;
      show(session.sessionId);
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
          paErrorMessage(error, m(msg("Could not load more conversations"))),
        );
      }
      set((previous) => ({ ...previous, loadingMoreSessions: false }));
    },
    async loadOlderMessages() {
      const sessionId = state.activeSessionId;
      const latest = state.messages;
      const cursor = latest.window.olderCursor;
      if (!sessionId || latest.sessionId !== sessionId || !cursor) return;
      if (state.older?.sessionId === sessionId && state.older.loading) return;
      set((previous) => ({ ...previous, older: { sessionId, loading: true, error: null } }));
      try {
        const page = await client.getMessages(botId, sessionId, { cursor });
        set((previous) => ({
          ...previous,
          older: previous.older?.sessionId === sessionId ? null : previous.older,
          // A reload that replaced the window meanwhile owns a different cursor.
          messages:
            previous.messages.sessionId !== sessionId ||
            previous.messages.window.olderCursor !== cursor
              ? previous.messages
              : { sessionId, window: prependPaOlderPage(previous.messages.window, page) },
        }));
      } catch (error) {
        set((previous) =>
          previous.older?.sessionId === sessionId
            ? {
                ...previous,
                older: {
                  sessionId,
                  loading: false,
                  error: paErrorMessage(error, m(msg("Could not load earlier messages"))),
                },
              }
            : previous,
        );
      }
    },
    send,
    /** Hands the draft to the running turn; one the turn ended too early to take is sent normally. */
    async steer() {
      const sessionId = state.activeSessionId;
      const text = sessionId ? (state.drafts[sessionId] ?? "").trim() : "";
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
            showError(sessionId, m(msg("Voice chat stopped.")));
          } else if (result.status === "delivered" && settleTokens.get(sessionId) !== settleToken) {
            void loadTranscript(sessionId, false, settleTokens.get(sessionId));
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
        showError(sessionId, paErrorMessage(error, m(msg("Could not steer the turn"))));
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
          paErrorMessage(
            error,
            action === "cancel"
              ? m(msg("Could not cancel the queued message"))
              : action === "steer"
                ? m(msg("Could not steer the turn"))
                : m(msg("Could not resume the queue")),
          ),
        );
      }
      set((previous) => ({ ...previous, queueBusyIds: withoutId(previous.queueBusyIds, item.id) }));
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
    async respondRequest(request: PaPendingRequest, decision?: string) {
      const sessionId = state.activeSessionId;
      if (!context.canOperate || !sessionId || state.respondingIds.has(request.requestId)) return;
      const answers = state.clarifyAnswers[request.requestId];
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
        showError(sessionId, paErrorMessage(error, m(msg("Could not answer the request"))));
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
            ? m(msg("You need permission to manage providers to answer this request."))
            : m(msg("Could not submit credentials")),
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
    setReasoning(effort: string) {
      const sessionId = state.activeSessionId;
      if (!sessionId) return;
      set((previous) => ({
        ...previous,
        sessionReasoning: { sessionId, effort, settingsVersion: previous.settingsVersion },
      }));
    },
    /** The Bot's settings or model changed elsewhere: readers of them read again. */
    bumpSettings() {
      set((previous) => ({ ...previous, settingsVersion: previous.settingsVersion + 1 }));
      activity();
    },
    dispose() {
      disposed = true;
      stopFollow?.();
      stopFollow = null;
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
  const transcript =
    state.messages.sessionId === sessionId ? state.messages.window : EMPTY_TRANSCRIPT;
  const liveTurn =
    state.liveTurn.sessionId === sessionId ? state.liveTurn : createInitialPaLiveTurn(sessionId);
  const local = (sessionId && state.localBySession[sessionId]) || EMPTY_TRANSCRIPT.messages;
  return {
    sessionId,
    transcript,
    liveTurn,
    running: liveTurn.phase === "running",
    hasLiveTurn: liveTurn.phase !== "idle" || liveTurn.blocks.length > 0,
    timelineItems: timelineFor(transcript.messages, local),
    // A session's transcript is read once its feed attaches; until then nothing for it is shown.
    loadingMessages:
      sessionId !== null &&
      (state.messages.sessionId !== sessionId || state.loadingMessagesFor === sessionId),
    older: state.older?.sessionId === sessionId ? state.older : null,
    draft: sessionId ? (state.drafts[sessionId] ?? "") : "",
    activeSession: state.sessions.find((item) => item.sessionId === sessionId) ?? null,
  };
}
