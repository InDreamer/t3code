import { T, useGT, useMessages } from "gt-react";
import { Loader2Icon, Settings2Icon } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { isElectron } from "~/env";
import { useSoftwareKeyboardOpen } from "~/hooks/useSoftwareKeyboardOpen";
import { useStableCallback } from "~/hooks/useStableCallback";
import { observeResize } from "~/lib/observeResize";
import { cn } from "../../lib/utils";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useAtomValue } from "@effect/atom-react";
import * as Schema from "effect/Schema";
import { toastManager } from "../ui/toast";
import { EnvironmentAuthorizationError, type PaAttachment } from "@t3tools/contracts";
import { ScrollToEndButton } from "../chat/TimelineOverlays";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
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
  createInitialPaLiveTurn,
  mergePaMessagesByTime,
  nextPaLocalTimestamp,
  paNoticeMessage,
  reducePaStreamEvent,
  startPaLiveTurnLocally,
  type PaLiveTurnState,
} from "@t3tools/client-runtime/pa/timeline";
import type {
  PaBotSummary,
  PaCapabilities,
  PaClarifyAnswer,
  PaManageQueuedItemInput,
  PaMessage,
  PaPendingRequest,
  PaQueuedItem,
  PaSessionSummary,
  PaSlashCommand,
  PaStreamEvent,
} from "@t3tools/contracts";
import {
  createPaLocalMessage,
  makePaRequestKey,
  paLiveTurnScrollSignature,
  selectPaQuickCommands,
  sendPaChatMessage,
  trackAdmittedPaRow,
} from "@t3tools/client-runtime/pa/chat";
import {
  formatPaSessionSource,
  summarizePaLiveActivity,
} from "@t3tools/client-runtime/pa/presentation";
import { BotAvatar } from "./BotAvatar";
import { paApi, paErrorMessage, paSendPermissionAtom } from "./paApi";
import { PaComposer, type PaClarifyAnswers } from "./PaComposer";
import type { PaSecretAnswer } from "./PaSecretRequestForm";
import { PaSessionPicker } from "./PaSessionPicker";
import { PaContextUsageButton, PaQueueBar, PaTodoProgressBar } from "./PaSessionStatus";
import {
  PaAssistantMessageRow,
  PaCompactionRow,
  PaLiveTurnView,
  PaSystemOutputRow,
  PaUserMessageRow,
  PaWorkGroupRow,
} from "./PaTimelineRows";

const pendingSessionCreates = new Map<string, { title: string; id: string }>();

const isAuthorizationError = Schema.is(EnvironmentAuthorizationError);
const NO_SLASH_COMMANDS: ReadonlyArray<PaSlashCommand> = [];
const SCROLL_NEAR_BOTTOM_PX = 96;
const EMPTY_TRANSCRIPT: PaTranscriptWindow = { messages: [], olderCursor: null };

function makeInputId(): string {
  return makePaRequestKey("pa");
}

export function BotChatPane({
  bot,
  capabilities,
  selectedSessionId,
  settingsVersion = 0,
  onSelectSession,
  onOpenSettings,
  onActivity,
}: {
  readonly bot: PaBotSummary;
  readonly capabilities: PaCapabilities | null;
  readonly selectedSessionId: string | null;
  readonly settingsVersion?: number;
  readonly onSelectSession: (sessionId: string) => void;
  readonly onOpenSettings: () => void;
  readonly onActivity: () => void;
}) {
  const gt = useGT();
  const m = useMessages();
  const [sessions, setSessions] = useState<ReadonlyArray<PaSessionSummary>>([]);
  const [fallbackSessionId, setFallbackSessionId] = useState<string | null>(null);
  const activeSessionId = selectedSessionId ?? fallbackSessionId;
  const environmentId = usePrimaryEnvironmentId();
  const canOperate = useAtomValue(paSendPermissionAtom(environmentId));
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const [loadingSessions, setLoadingSessions] = useState(true);
  const [sessionsCursor, setSessionsCursor] = useState<string | null>(null);
  const [loadingMoreSessions, setLoadingMoreSessions] = useState(false);

  const [messagesState, setMessagesState] = useState<{
    readonly sessionId: string | null;
    readonly window: PaTranscriptWindow;
  }>({ sessionId: null, window: EMPTY_TRANSCRIPT });
  const [olderLoad, setOlderLoad] = useState<{
    readonly sessionId: string;
    readonly loading: boolean;
    readonly error: string | null;
  } | null>(null);
  /** Where the reader was before older rows went in above them, restored before paint. */
  const pendingPrependRef = useRef<{
    readonly sessionId: string;
    /** The first row shown before the older page went in above it. */
    readonly anchorId: string;
    readonly scrollHeight: number;
    readonly scrollTop: number;
  } | null>(null);
  const [localBySession, setLocalBySession] = useState<Record<string, ReadonlyArray<PaMessage>>>(
    {},
  );
  const [loadingMessagesFor, setLoadingMessagesFor] = useState<string | null>(null);
  const [loadedSlashCommands, setSlashCommands] = useState<ReadonlyArray<PaSlashCommand>>([]);
  const [liveTurnState, setLiveTurnState] = useState<PaLiveTurnState>(() =>
    createInitialPaLiveTurn(null),
  );

  const activeSessionIdRef = useRef<string | null>(activeSessionId);

  const transcript =
    messagesState.sessionId === activeSessionId ? messagesState.window : EMPTY_TRANSCRIPT;
  const messages = transcript.messages;
  const olderForSession = olderLoad?.sessionId === activeSessionId ? olderLoad : null;
  // A session's transcript is read once its feed attaches; until then nothing for it is shown.
  const loadingMessages =
    activeSessionId !== null &&
    (messagesState.sessionId !== activeSessionId || loadingMessagesFor === activeSessionId);
  const liveTurn =
    liveTurnState.sessionId === activeSessionId
      ? liveTurnState
      : createInitialPaLiveTurn(activeSessionId);
  const getTranscript = useStableCallback(() => messagesState);
  const runningRef = useRef(false);
  const running = liveTurn.phase === "running";
  const openRequests = liveTurn.openRequests;
  const streamError = liveTurn.error;
  const localMessages = activeSessionId ? (localBySession[activeSessionId] ?? []) : [];
  const mergedMessages = mergePaMessagesByTime(messages, localMessages);

  const updateLiveTurn = useStableCallback(
    (sessionId: string | null, updater: (prev: PaLiveTurnState) => PaLiveTurnState) => {
      if (activeSessionIdRef.current !== sessionId) return;
      setLiveTurnState((prev) => {
        const base = prev.sessionId === sessionId ? prev : createInitialPaLiveTurn(sessionId);
        return { ...updater(base), sessionId };
      });
    },
  );

  const [clarifyAnswers, setClarifyAnswers] = useState<Record<string, PaClarifyAnswers>>({});
  const [respondingIds, setRespondingIds] = useState<ReadonlySet<string>>(() => new Set());
  const [queueBusyIds, setQueueBusyIds] = useState<ReadonlySet<string>>(() => new Set());

  const settleTokensRef = useRef(new Map<string, number>());
  const transcriptRequestRef = useRef(0);
  const failedSendRef = useRef(
    new Map<string, { text: string; inputId: string; attachmentKey?: string }>(),
  );
  /** An admitted row can be reconciled by text, or by turn completion for rewritten prompts. */
  const pendingUserRowsRef = useRef(new Map<string, Map<string, boolean>>());
  const recoveredSessionsRef = useRef(new Set<string>());
  const mountedRef = useRef(false);
  const commandsSupported = capabilities?.commands.supported !== false;
  const canCreateSession = canOperate && capabilities?.sessions.create !== false;
  const canRenameSession = canOperate && capabilities?.sessions.renameExisting === true;
  const canInterrupt = capabilities?.execution.interrupt !== false;
  const canSteer = capabilities?.execution.steer === true;
  const slashCommands = commandsSupported ? loadedSlashCommands : NO_SLASH_COMMANDS;

  const [drafts, setDrafts] = useState<Readonly<Record<string, string>>>({});
  const draft = activeSessionId ? (drafts[activeSessionId] ?? "") : "";
  const setDraft = (value: string | ((previous: string) => string)) => {
    if (!activeSessionId) return;
    setDrafts((previous) => {
      const next = typeof value === "function" ? value(previous[activeSessionId] ?? "") : value;
      return { ...previous, [activeSessionId]: next };
    });
  };
  const [sending, setSending] = useState(false);
  const [modelPicker, setModelPicker] = useState({ open: false, query: "" });
  const [sessionReasoning, setSessionReasoning] = useState<{
    readonly sessionId: string;
    readonly effort: string;
    readonly settingsVersion: number;
  } | null>(null);
  const getSettingsVersion = useStableCallback(() => settingsVersion);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const composerOverlayRef = useRef<HTMLDivElement | null>(null);
  const [composerHeight, setComposerHeight] = useState(116);
  const keyboardOpen = useSoftwareKeyboardOpen();
  const isNearBottomRef = useRef<boolean>(true);
  const [scrolledUpForSession, setScrolledUpForSession] = useState<string | null>(null);
  const showScrollToBottom = activeSessionId !== null && scrolledUpForSession === activeSessionId;
  const bottomRef = useRef<HTMLDivElement | null>(null);

  const getSelectedSessionProp = useStableCallback(() => selectedSessionId);
  const stableSelectSession = useStableCallback(onSelectSession);
  const stableOnActivity = useStableCallback(onActivity);
  const stableBotUnread = useStableCallback(() => bot.unread);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- tracks the floating composer height so the timeline bottom clearance and scroll-to-end pill stay aligned
  useLayoutEffect(() => {
    const el = composerOverlayRef.current;
    if (!el) return;
    const measure = () => {
      const next = Math.ceil(el.getBoundingClientRect().height);
      if (next > 0) setComposerHeight((prev) => (prev === next ? prev : next));
    };
    measure();
    return observeResize(el, measure);
  }, []);

  const loadTranscript = useStableCallback(
    (sessionId: string, showSpinner: boolean, expectedSettleToken?: number) => {
      const reqId = transcriptRequestRef.current + 1;
      transcriptRequestRef.current = reqId;
      const current = () =>
        transcriptRequestRef.current === reqId && activeSessionIdRef.current === sessionId;

      if (showSpinner) {
        setLoadingMessagesFor(sessionId);
      }
      // Only rows admitted before this read started can be in what it returns.
      const candidates = new Map(pendingUserRowsRef.current.get(sessionId));

      return paApi
        .getMessages(bot.botId, sessionId)
        .then((page) => {
          if (!current()) return;
          const loaded = page.messages;
          // The newest page again: older pages the reader already scrolled up to stay.
          setMessagesState((prev) => ({
            sessionId,
            window: mergePaLatestPage(prev.sessionId === sessionId ? prev.window : null, page),
          }));
          if (candidates.size > 0) {
            const storedUsers = new Set(
              loaded.flatMap((item) =>
                item.role === "user" ? [paUserMessageContentKey(item)] : [],
              ),
            );
            setLocalBySession((prev) => {
              const existing = prev[sessionId] ?? [];
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
              if (reconciled.size === 0) return prev;
              const pending = pendingUserRowsRef.current.get(sessionId);
              for (const id of reconciled) pending?.delete(id);
              return { ...prev, [sessionId]: existing.filter((item) => !reconciled.has(item.id)) };
            });
          }
          if (expectedSettleToken !== undefined) {
            // Clear the settling live blocks atomically once persisted messages are committed (zero flicker).
            updateLiveTurn(sessionId, (prev) => clearSettledPaLiveTurn(prev, expectedSettleToken));
          }
        })
        .catch((err) => {
          if (current()) {
            // A first read that fails still ends the spinner; a failed reload keeps what is shown.
            setMessagesState((prev) =>
              prev.sessionId === sessionId ? prev : { sessionId, window: EMPTY_TRANSCRIPT },
            );
            updateLiveTurn(sessionId, (prev) => ({
              ...prev,
              error: paErrorMessage(err, gt("Could not load messages")),
            }));
          }
        })
        .finally(() => {
          if (transcriptRequestRef.current === reqId) {
            setLoadingMessagesFor((cur) => (cur === sessionId ? null : cur));
          }
        });
    },
  );

  const formatSourceLabel = (source: string): string => formatPaSessionSource(source, m);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- tracks mount so a late session create cannot navigate after this Bot's pane is gone
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads the engine's native slash catalog once per Bot
  useEffect(() => {
    if (!commandsSupported) return;
    let cancelled = false;
    paApi.listCommands(bot.botId).then(
      (cmds) => {
        if (!cancelled) setSlashCommands(cmds);
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [bot.botId, commandsSupported]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads this Bot's sessions once per Bot mount, and marks unread bots read
  useEffect(() => {
    const controller = new AbortController();
    paApi
      .listSessions(bot.botId)
      .then(async (sessionRes) => {
        if (controller.signal.aborted) return;
        setSessions(sessionRes.sessions);
        setSessionsCursor(sessionRes.nextCursor ?? null);

        const initialProp = getSelectedSessionProp();
        let targetId = initialProp ?? sessionRes.primarySessionId;

        if (!targetId && canCreateSession) {
          const created = await paApi.ensurePrimarySession(bot.botId);
          if (controller.signal.aborted) return;
          targetId = created.sessionId;
          setSessions((prev) => [created, ...prev]);
        }
        if (!targetId) {
          targetId = sessionRes.sessions[0]?.sessionId ?? null;
        }
        if (!targetId) return;

        activeSessionIdRef.current = targetId;
        setFallbackSessionId(targetId);
        if (targetId !== initialProp) {
          stableSelectSession(targetId);
        }
        if (stableBotUnread()) {
          void paApi
            .markRead(bot.botId)
            .then(() => stableOnActivity())
            .catch(() => undefined);
        }
      })
      .catch((err) => {
        if (!controller.signal.aborted) {
          updateLiveTurn(activeSessionIdRef.current, (prev) => ({
            ...prev,
            error: paErrorMessage(err, gt("Could not connect to the bot session")),
          }));
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoadingSessions(false);
      });

    return () => controller.abort();
  }, [
    bot.botId,
    canCreateSession,
    gt,
    getSelectedSessionProp,
    updateLiveTurn,
    stableSelectSession,
    stableBotUnread,
    stableOnActivity,
  ]);

  /** A session the engine no longer has (often a stale primary): move to one it does have. */
  const recoverMissingSession = useStableCallback(async (missingId: string, cause: unknown) => {
    if (recoveredSessionsRef.current.has(missingId)) return;
    recoveredSessionsRef.current.add(missingId);
    try {
      const res = await paApi.listSessions(bot.botId);
      if (!mountedRef.current || activeSessionIdRef.current !== missingId) return;
      const remaining = res.sessions.filter((item) => item.sessionId !== missingId);
      let nextId =
        res.primarySessionId && res.primarySessionId !== missingId ? res.primarySessionId : null;
      let nextSessions = remaining;
      if (!nextId && canCreateSession) {
        const created = await paApi.ensurePrimarySession(bot.botId);
        if (!mountedRef.current || activeSessionIdRef.current !== missingId) return;
        nextId = created.sessionId;
        nextSessions = [created, ...remaining.map((item) => ({ ...item, isPrimary: false }))];
      }
      if (!nextId) {
        nextId = remaining[0]?.sessionId ?? null;
      }
      setSessions(nextSessions);
      setSessionsCursor(res.nextCursor ?? null);
      if (!nextId) {
        // Nowhere to move and no way to start a conversation: say so instead of going blank.
        updateLiveTurn(missingId, (prev) => ({
          ...prev,
          error: paErrorMessage(cause, gt("This conversation no longer exists")),
        }));
        return;
      }
      activeSessionIdRef.current = nextId;
      setFallbackSessionId(nextId);
      stableSelectSession(nextId);
    } catch (err) {
      updateLiveTurn(missingId, (prev) => ({
        ...prev,
        error: paErrorMessage(err, gt("Could not connect to the bot session")),
      }));
    }
  });

  const patchSession = useStableCallback(
    (sessionId: string, patch: Partial<Pick<PaSessionSummary, "title" | "model">>) => {
      setSessions((prev) =>
        prev.map((item) => (item.sessionId === sessionId ? { ...item, ...patch } : item)),
      );
    },
  );

  const appendLocalMessage = useStableCallback((sessionId: string, message: PaMessage) => {
    setLocalBySession((prev) => {
      const existing = prev[sessionId] ?? [];
      // A command's output arrives both as its send result and on the feed: show it once.
      if (existing.some((item) => item.id === message.id)) return prev;
      // Strictly after every local row, so a command's output never lands above its input.
      const timestamp = nextPaLocalTimestamp(existing, message.timestamp ?? Date.now());
      return { ...prev, [sessionId]: [...existing, { ...message, timestamp }] };
    });
  });

  const removeLocalMessage = (sessionId: string, messageId: string) => {
    pendingUserRowsRef.current.get(sessionId)?.delete(messageId);
    setLocalBySession((prev) => {
      const existing = prev[sessionId];
      if (!existing?.some((item) => item.id === messageId)) return prev;
      return { ...prev, [sessionId]: existing.filter((item) => item.id !== messageId) };
    });
  };

  /** A timestamp no earlier than anything shown, whatever this device's clock says. */
  const localTimestampNow = useStableCallback(() =>
    nextPaLocalTimestamp(mergedMessages, Date.now()),
  );

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- follows the session's live feed and reads the transcript once attached; the connection runtime reconnects and the server resumes from the last event
  useEffect(() => {
    activeSessionIdRef.current = activeSessionId;
    if (!activeSessionId) return;
    const sessionId = activeSessionId;
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
    isNearBottomRef.current = true;

    runningRef.current = false;
    const handleEvent = (event: PaStreamEvent) => {
      if (closed || activeSessionIdRef.current !== sessionId) return;
      switch (event.type) {
        case "snapshot":
          runningRef.current = event.running;
          updateLiveTurn(sessionId, (prev) => reducePaStreamEvent(prev, event, Date.now()));
          if (!transcriptRead || event.snapshotRequired) readTranscript();
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
            setSessionReasoning({
              sessionId,
              effort: event.reasoningEffort,
              settingsVersion: getSettingsVersion(),
            });
          }
          return;
        case "turn.started":
          runningRef.current = true;
          break;
        case "turn.completed":
        case "error": {
          runningRef.current = false;
          // An error ends the turn too: a send that resolves after it must not re-mark it running.
          const token = (settleTokensRef.current.get(sessionId) ?? 0) + 1;
          settleTokensRef.current.set(sessionId, token);
          const pending = pendingUserRowsRef.current.get(sessionId);
          pending?.forEach((_ended, id) => pending.set(id, true));
          updateLiveTurn(sessionId, (prev) => ({
            ...reducePaStreamEvent(prev, event, Date.now()),
            settleToken: token,
          }));
          void loadTranscript(sessionId, false, token);
          if (event.type === "turn.completed") {
            void paApi
              .markRead(bot.botId)
              .catch(() => undefined)
              .finally(() => stableOnActivity());
          }
          return;
        }
        default:
          break;
      }
      updateLiveTurn(sessionId, (prev) => reducePaStreamEvent(prev, event, Date.now()));
    };

    const stop = paApi.followSession(bot.botId, sessionId, {
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
        updateLiveTurn(sessionId, (prev) => ({
          ...prev,
          error: paErrorMessage(
            error,
            retrying
              ? gt("Connection lost. Reconnecting…")
              : gt("Could not connect to the bot session"),
          ),
        }));
      },
    });

    return () => {
      closed = true;
      stop();
      transcriptRequestRef.current += 1;
    };
  }, [
    bot.botId,
    activeSessionId,
    appendLocalMessage,
    getSettingsVersion,
    gt,
    loadTranscript,
    localTimestampNow,
    patchSession,
    recoverMissingSession,
    updateLiveTurn,
    stableOnActivity,
  ]);

  const timelineItems = buildPaTimelineItems(mergedMessages);
  const hasLiveTurn = liveTurn.phase !== "idle" || liveTurn.blocks.length > 0;

  const scrollTargetScore = mergedMessages.length * 1000 + paLiveTurnScrollSignature(liveTurn);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- anchors the viewport to the latest message while the user is following at the bottom
  useEffect(() => {
    if (scrollTargetScore > 0 && isNearBottomRef.current) {
      bottomRef.current?.scrollIntoView({
        behavior: running ? "auto" : "smooth",
        block: "end",
      });
    }
  }, [scrollTargetScore, running]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- restores the DOM scroll offset before paint so rows inserted above the viewport do not move what the reader is looking at
  useLayoutEffect(() => {
    const pending = pendingPrependRef.current;
    const el = scrollContainerRef.current;
    if (!pending || !el) return;
    pendingPrependRef.current = null;
    if (messages[0]?.id === pending.anchorId) return;
    // Another session, or a reset that replaced the rows, has nothing to hold in place.
    if (
      pending.sessionId !== activeSessionId ||
      !messages.some((message) => message.id === pending.anchorId)
    ) {
      return;
    }
    el.scrollTop = pending.scrollTop + (el.scrollHeight - pending.scrollHeight);
  }, [messages, activeSessionId]);

  const loadOlderMessages = async () => {
    const sessionId = activeSessionId;
    const cursor = getTranscript().window.olderCursor;
    if (!sessionId || !cursor || olderForSession?.loading) return;
    setOlderLoad({ sessionId, loading: true, error: null });
    try {
      const page = await paApi.getMessages(bot.botId, sessionId, { cursor });
      const latest = getTranscript();
      pendingPrependRef.current = null;
      if (
        activeSessionIdRef.current !== sessionId ||
        latest.sessionId !== sessionId ||
        latest.window.olderCursor !== cursor
      ) {
        setOlderLoad((prev) => (prev?.sessionId === sessionId ? null : prev));
        return;
      }
      const el = scrollContainerRef.current;
      const anchorId = latest.window.messages[0]?.id;
      const next = prependPaOlderPage(latest.window, page);
      if (
        el &&
        anchorId !== undefined &&
        page.reset !== true &&
        next.messages.length > latest.window.messages.length &&
        buildPaTimelineItems(next.messages).length >
          buildPaTimelineItems(latest.window.messages).length
      ) {
        pendingPrependRef.current = {
          sessionId,
          anchorId,
          scrollHeight: el.scrollHeight,
          scrollTop: el.scrollTop,
        };
        // Rows going in above must not read as new rows to follow at the bottom.
        isNearBottomRef.current = false;
      }
      setMessagesState((prev) =>
        // A reload that replaced the window meanwhile owns a different cursor.
        prev.sessionId !== sessionId || prev.window.olderCursor !== cursor
          ? prev
          : {
              sessionId,
              window: prev.window === latest.window ? next : prependPaOlderPage(prev.window, page),
            },
      );
      setOlderLoad((prev) => (prev?.sessionId === sessionId ? null : prev));
    } catch (err) {
      setOlderLoad((prev) =>
        prev?.sessionId === sessionId
          ? {
              sessionId,
              loading: false,
              error: paErrorMessage(err, gt("Could not load earlier messages")),
            }
          : prev,
      );
    }
  };

  const loadMoreSessions = async () => {
    const cursor = sessionsCursor;
    if (!cursor || loadingMoreSessions) return;
    setLoadingMoreSessions(true);
    try {
      const res = await paApi.listSessions(bot.botId, { cursor });
      if (!mountedRef.current) {
        setLoadingMoreSessions(false);
        return;
      }
      setSessions((prev) => appendPaSessionPage(prev, res.sessions));
      setSessionsCursor(res.nextCursor ?? null);
    } catch (err) {
      updateLiveTurn(activeSessionIdRef.current, (prev) => ({
        ...prev,
        error: paErrorMessage(err, gt("Could not load more conversations")),
      }));
    }
    setLoadingMoreSessions(false);
  };

  const handleViewportScroll = () => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const nearBottom = distanceFromBottom < SCROLL_NEAR_BOTTOM_PX;
    isNearBottomRef.current = nearBottom;
    const nextScrolledUp = nearBottom ? null : activeSessionId;
    setScrolledUpForSession((prev) => (prev === nextScrolledUp ? prev : nextScrolledUp));
  };

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the software keyboard shrinks the timeline viewport, so a reader following the end would lose the latest message under it
  useEffect(() => {
    const el = scrollContainerRef.current;
    if (keyboardOpen && el && isNearBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [keyboardOpen]);

  // Dragging or tapping the open timeline closes the keyboard, as chat apps do.
  const dismissSoftwareKeyboard = () => {
    const active = document.activeElement;
    if (
      keyboardOpen &&
      active instanceof HTMLElement &&
      composerOverlayRef.current?.contains(active)
    )
      active.blur();
  };
  const handleTimelineClick = (event: React.MouseEvent<HTMLDivElement>) => {
    const target = event.target;
    if (
      target === event.currentTarget ||
      target === event.currentTarget.firstElementChild ||
      target === bottomRef.current
    )
      dismissSoftwareKeyboard();
  };

  const scrollToBottom = () => {
    isNearBottomRef.current = true;
    setScrolledUpForSession(null);
    const el = scrollContainerRef.current;
    if (el) {
      el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    } else {
      bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
    }
  };

  const activeSession = sessions.find((s) => s.sessionId === activeSessionId) ?? null;
  const quickCommands = selectPaQuickCommands(slashCommands);

  const switchSession = (nextSessionId: string) => {
    setSessionsOpen(false);
    if (nextSessionId === activeSessionId) return;
    pendingSessionCreates.delete(JSON.stringify([environmentId, bot.botId]));
    activeSessionIdRef.current = nextSessionId;
    setFallbackSessionId(nextSessionId);
    onSelectSession(nextSessionId);
  };

  const handleCreateNewSession = async (title = "") => {
    setSessionsOpen(false);
    const fromSessionId = activeSessionId;
    if (!canCreateSession || !environmentId) return;
    const key = JSON.stringify([environmentId, bot.botId]);
    const pending = pendingSessionCreates.get(key);
    const attempt =
      pending?.title === title ? pending : { title, id: makePaRequestKey("pa-session") };
    pendingSessionCreates.set(key, attempt);
    let created: PaSessionSummary;
    try {
      created = await paApi.createSession(bot.botId, attempt.id, title || undefined);
      if (pendingSessionCreates.get(key) !== attempt) return;
      pendingSessionCreates.delete(key);
    } catch (err) {
      if (isPermanentPaFailure(err) && pendingSessionCreates.get(key) === attempt)
        pendingSessionCreates.delete(key);
      updateLiveTurn(fromSessionId, (prev) => ({
        ...prev,
        error: paErrorMessage(err, gt("Could not create the conversation")),
      }));
      return;
    }
    // This pane belongs to one Bot: a create that lands after leaving it must not navigate back.
    if (!mountedRef.current) return;
    setSessions((prev) => [
      created,
      ...prev
        .filter((s) => s.sessionId !== created.sessionId)
        .map((s) => ({ ...s, isPrimary: false })),
    ]);
    activeSessionIdRef.current = created.sessionId;
    setFallbackSessionId(created.sessionId);
    onSelectSession(created.sessionId);
  };

  const handleSend = async (
    rawOverride?: string,
    options?: {
      /** Sent behind the running turn: it waits in the engine's queue. */
      readonly queued?: boolean;
      readonly attachments?: ReadonlyArray<PaAttachment>;
      /** A failed send puts the text back in the composer even though it came from elsewhere. */
      readonly restoreDraft?: boolean;
    },
  ) => {
    const text = (rawOverride ?? draft).trim();
    const sessionId = activeSessionId;
    const attachments = options?.attachments ?? [];
    if ((!text && !attachments.length) || !sessionId || sending || !canOperate) return false;
    const queued = options?.queued === true;
    const restoreDraft = rawOverride === undefined || options?.restoreDraft === true;

    // The engine's catalog marks the commands a client runs itself (new session, stop, model).
    const clientAction = attachments.length ? null : parsePaClientSlashAction(text, slashCommands);
    if (clientAction) {
      if (rawOverride === undefined) setDraft("");
      updateLiveTurn(sessionId, (prev) => ({ ...prev, error: null }));
      switch (clientAction.kind) {
        case "new-session":
          if (!canCreateSession) {
            updateLiveTurn(sessionId, (prev) => ({
              ...prev,
              error: gt("This bot cannot create conversations"),
            }));
            return;
          }
          await handleCreateNewSession(clientAction.title);
          return;
        case "interrupt":
          if (!canInterrupt) {
            updateLiveTurn(sessionId, (prev) => ({
              ...prev,
              error: gt("This bot cannot stop a reply"),
            }));
            return;
          }
          await handleInterrupt();
          return;
        case "model-picker":
          setModelPicker({ open: true, query: clientAction.query });
          return;
      }
    }
    setSending(true);
    updateLiveTurn(sessionId, (prev) => ({ ...prev, error: null }));
    if (rawOverride === undefined && !attachments.length) setDraft("");
    isNearBottomRef.current = true;
    setScrolledUpForSession(null);

    // A local row until a reload shows it stored; only an admitted turn is ever stored. A queued
    // send gets none: the queue bar shows it once the engine lists it.
    const optimisticMsg = createPaLocalMessage("user", text, localTimestampNow());
    if (!queued && !attachments.length) appendLocalMessage(sessionId, optimisticMsg);
    const completedBeforeSend = settleTokensRef.current.get(sessionId);
    try {
      const { result: res, inputId } = await sendPaChatMessage(
        failedSendRef.current,
        sessionId,
        text,
        makeInputId,
        (id) => paApi.sendMessage(bot.botId, sessionId, text, id, queued, attachments),
        attachments.map((item) => item.id),
      );
      if (attachments.length && res.kind === "turn" && activeSessionIdRef.current === sessionId) {
        setDraft((current) => (current.trim() === text ? "" : current));
      }
      if (res.kind === "turn" && res.queued === true) {
        // Waiting behind the running turn, which keeps streaming untouched.
        setSending(false);
        return true;
      }
      if (attachments.length ? res.kind === "turn" : queued)
        appendLocalMessage(sessionId, {
          ...optimisticMsg,
          ...(res.attachments ? { attachments: res.attachments } : {}),
        });
      const settleToken = settleTokensRef.current.get(sessionId);
      const turnEnded = trackAdmittedPaRow(
        pendingUserRowsRef.current,
        sessionId,
        optimisticMsg.id,
        res,
        settleToken !== completedBeforeSend,
      );
      // A turn that ended before this answer arrived was read without this row: read again.
      if (res.kind === "output") {
        // The engine stores neither a command nor its output: both stay local rows.
        appendLocalMessage(
          sessionId,
          paNoticeMessage(
            { message: res.output || res.notice || gt("Command executed"), inputId },
            localTimestampNow(),
          ),
        );
        onActivity();
        // A consumed voice stop can return output without admitting the selected images.
        if (attachments.length) {
          setSending(false);
          return false;
        }
      } else if (turnEnded) {
        if (activeSessionIdRef.current === sessionId) {
          void loadTranscript(sessionId, false, settleToken);
        }
        if (res.settled) onActivity();
      } else {
        if (activeSessionIdRef.current === sessionId) runningRef.current = true;
        updateLiveTurn(sessionId, (prev) => startPaLiveTurnLocally(prev, Date.now()));
      }
    } catch (err) {
      removeLocalMessage(sessionId, optimisticMsg.id);
      if (!attachments.length && restoreDraft && activeSessionIdRef.current === sessionId) {
        setDraft((current) => (current ? current : text));
      }
      updateLiveTurn(sessionId, (prev) => ({
        ...prev,
        error: paErrorMessage(err, gt("Could not send message")),
      }));
      setSending(false);
      return false;
    }
    setSending(false);
    return true;
  };

  /** Hands the draft to the running turn; one the turn ended too early to take is sent normally. */
  const handleSteer = async () => {
    const text = draft.trim();
    const sessionId = activeSessionId;
    if (!text || !sessionId || sending || !canOperate) return;
    setSending(true);
    setDraft("");
    updateLiveTurn(sessionId, (prev) => ({ ...prev, error: null }));
    const settleToken = settleTokensRef.current.get(sessionId);
    let sendInstead = false;
    try {
      const res = await paApi.steerSession(bot.botId, sessionId, text);
      if (mountedRef.current && activeSessionIdRef.current === sessionId) {
        if (res.status === "voiceStopped") {
          toastManager.add({ type: "info", title: gt("Voice chat stopped.") });
        } else if (
          res.status === "delivered" &&
          settleTokensRef.current.get(sessionId) !== settleToken
        ) {
          void loadTranscript(sessionId, false, settleTokensRef.current.get(sessionId));
        } else if (res.status === "delivered") {
          // Stored with the running turn: a local row until that turn's reload shows it.
          const row = createPaLocalMessage("user", text, localTimestampNow());
          appendLocalMessage(sessionId, row);
          const pending = pendingUserRowsRef.current.get(sessionId) ?? new Map<string, boolean>();
          pending.set(row.id, false);
          pendingUserRowsRef.current.set(sessionId, pending);
        } else {
          sendInstead = true;
        }
      } else if (res.status === "notDelivered") {
        setDraft((current) => (current ? text + "\n" + current : text));
      }
    } catch (err) {
      // Never re-sent: the engine may already have handed it to the agent.
      setDraft((current) => (current ? text + "\n" + current : text));
      updateLiveTurn(sessionId, (prev) => ({
        ...prev,
        error: paErrorMessage(err, gt("Could not steer the turn")),
      }));
    }
    setSending(false);
    if (sendInstead && mountedRef.current && activeSessionIdRef.current === sessionId)
      await handleSend(text, { queued: runningRef.current, restoreDraft: true });
  };

  const handleQueueAction = async (
    item: PaQueuedItem,
    action: PaManageQueuedItemInput["action"],
  ) => {
    if (!canOperate || !activeSessionId || queueBusyIds.has(item.id)) return;
    const sessionId = activeSessionId;
    setQueueBusyIds((prev) => new Set(prev).add(item.id));
    try {
      // The engine's next queue report moves or removes the item for every viewer.
      await paApi.manageQueuedItem(bot.botId, sessionId, item.id, action);
    } catch (err) {
      updateLiveTurn(sessionId, (prev) => ({
        ...prev,
        error: paErrorMessage(
          err,
          action === "cancel"
            ? gt("Could not cancel the queued message")
            : action === "steer"
              ? gt("Could not steer the turn")
              : gt("Could not resume the queue"),
        ),
      }));
    }
    setQueueBusyIds((prev) => {
      const next = new Set(prev);
      next.delete(item.id);
      return next;
    });
  };

  const handleInterrupt = async () => {
    if (!canOperate || !activeSessionId) return;
    const sessionId = activeSessionId;
    try {
      // The turn's own completion settles it: trailing frames may still be on their way.
      await paApi.interruptSession(bot.botId, sessionId);
      updateLiveTurn(sessionId, (prev) => ({ ...prev, statusText: null }));
    } catch (err) {
      updateLiveTurn(sessionId, (prev) => ({
        ...prev,
        error: paErrorMessage(err, gt("Could not stop the turn")),
      }));
    }
  };

  const handleRespondRequest = async (req: PaPendingRequest, decision?: string) => {
    if (!canOperate || !activeSessionId || respondingIds.has(req.requestId)) return;
    const sessionId = activeSessionId;
    const answers = clarifyAnswers[req.requestId];
    setRespondingIds((prev) => new Set(prev).add(req.requestId));
    try {
      await paApi.respondRequest({
        botId: bot.botId,
        sessionId,
        requestId: req.requestId,
        ...(decision ? { decision } : {}),
        ...(req.kind === "clarify" && answers ? { answers } : {}),
      });
      updateLiveTurn(sessionId, (prev) => ({
        ...prev,
        openRequests: prev.openRequests.filter((item) => item.requestId !== req.requestId),
      }));
    } catch (err) {
      updateLiveTurn(sessionId, (prev) => ({
        ...prev,
        error: paErrorMessage(err, gt("Could not answer the request")),
      }));
    }
    setRespondingIds((prev) => {
      const next = new Set(prev);
      next.delete(req.requestId);
      return next;
    });
  };

  /** The values go straight to the engine: nothing here keeps or reports them. */
  const handleRespondSecret = async (
    req: PaPendingRequest,
    answer: PaSecretAnswer,
  ): Promise<boolean> => {
    if (!canOperate || !activeSessionId || respondingIds.has(req.requestId)) return false;
    const sessionId = activeSessionId;
    setRespondingIds((prev) => new Set(prev).add(req.requestId));
    let ok = false;
    try {
      await paApi.respondRequest({
        botId: bot.botId,
        sessionId,
        requestId: req.requestId,
        ...(answer.type === "skip" ? { skip: true } : { values: answer.values }),
      });
      updateLiveTurn(sessionId, (prev) => ({
        ...prev,
        openRequests: prev.openRequests.filter((item) => item.requestId !== req.requestId),
      }));
      ok = true;
    } catch (err) {
      updateLiveTurn(sessionId, (prev) => ({
        ...prev,
        error:
          isAuthorizationError(err) || paErrorReason(err) === "Forbidden"
            ? gt("You need permission to manage providers to answer this request.")
            : gt("Could not submit credentials"),
      }));
    }
    setRespondingIds((prev) => {
      const next = new Set(prev);
      next.delete(req.requestId);
      return next;
    });
    return ok;
  };

  const scrollToEndSummary = summarizePaLiveActivity(liveTurn, m);

  return (
    <div className="relative flex min-h-0 w-full min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
      <WorkspacePageHeader
        electron={isElectron}
        className="justify-between gap-2 border-b border-border/60"
      >
        <div className="flex min-w-0 items-center gap-2.5">
          <BotAvatar color={bot.avatarColor} shape={bot.avatarShape} size="sm" running={running} />
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="truncate text-sm font-semibold">{bot.name}</span>
              <Badge variant="secondary" size="sm" className="hidden sm:inline-flex">
                {bot.engineLabel}
              </Badge>
            </div>
            <div className="flex items-center gap-1.5 truncate text-2xs text-muted-foreground">
              <span
                className={cn(
                  "inline-block size-1.5 rounded-full",
                  running
                    ? "bg-warning animate-pulse"
                    : bot.online
                      ? "bg-success"
                      : "bg-muted-foreground/40",
                )}
              />
              <span className="truncate">
                {running ? liveTurn.statusText || gt("Working…") : bot.model || bot.agentRef}
              </span>
            </div>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          <PaContextUsageButton usage={liveTurn.usage} />
          <PaSessionPicker
            botId={bot.botId}
            open={sessionsOpen}
            onOpenChange={setSessionsOpen}
            triggerLabel={
              activeSession
                ? activeSession.isPrimary
                  ? gt("Primary conversation")
                  : formatSourceLabel(activeSession.source)
                : gt("Session")
            }
            sessions={sessions}
            hasMoreSessions={sessionsCursor !== null}
            loadingMoreSessions={loadingMoreSessions}
            activeSessionId={activeSessionId}
            canCreateSession={canCreateSession}
            canRenameSession={canRenameSession}
            formatSourceLabel={formatSourceLabel}
            onSelectSession={(session) => {
              setSessions((prev) => appendPaSessionPage(prev, [session]));
              switchSession(session.sessionId);
            }}
            onCreateSession={() => void handleCreateNewSession()}
            onLoadMoreSessions={() => void loadMoreSessions()}
            onSessionRenamed={(sessionId, title) => patchSession(sessionId, { title })}
            onError={(message) =>
              updateLiveTurn(activeSessionIdRef.current, (prev) => ({ ...prev, error: message }))
            }
          />

          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="size-8"
            aria-label={gt("Bot settings")}
            onClick={onOpenSettings}
          >
            <Settings2Icon className="size-4" />
          </Button>
        </div>
      </WorkspacePageHeader>

      {/* The safe-area padding clears a landscape notch; the absolute composer lane adds its own. */}
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col pl-safe pr-safe">
        <div
          ref={scrollContainerRef}
          onScroll={handleViewportScroll}
          onTouchMove={dismissSoftwareKeyboard}
          onClick={handleTimelineClick}
          className="scrollbar-gutter-both min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-y-contain px-3 pt-4 sm:px-8"
        >
          <div className="chat-content-lane flex flex-col">
            {loadingSessions || loadingMessages ? (
              <div className="flex items-center justify-center py-12 text-sm text-muted-foreground">
                <Loader2Icon className="mr-2 size-4 animate-spin" />
                <T>Loading conversation…</T>
              </div>
            ) : null}

            {!loadingSessions && !loadingMessages && timelineItems.length === 0 && !hasLiveTurn ? (
              <div
                className={cn(
                  "flex flex-col items-center justify-center text-center",
                  // Keeps the Bot in view above an open keyboard.
                  keyboardOpen ? "gap-2 py-4" : "gap-3 py-16",
                )}
              >
                <BotAvatar
                  color={bot.avatarColor}
                  shape={bot.avatarShape}
                  size={keyboardOpen ? "md" : "lg"}
                  starred={bot.isDefault}
                />
                <div className="space-y-1">
                  <div className="text-base font-semibold">{bot.name}</div>
                  <p className="max-w-xs text-xs text-muted-foreground">
                    {bot.description ||
                      (slashCommands.length > 0
                        ? gt("Start chatting or type / to use {engine} commands.", {
                            engine: bot.engineLabel,
                          })
                        : gt("Start chatting."))}
                  </p>
                </div>
                <div className="flex flex-wrap justify-center gap-1.5 pt-1">
                  {quickCommands.map((cmd) => (
                    <button
                      key={cmd}
                      type="button"
                      disabled={!canOperate}
                      onClick={() => void handleSend(cmd)}
                      className="rounded-full border border-border/70 bg-muted/40 px-3 py-1 font-mono text-xs text-muted-foreground transition-colors enabled:hover:bg-muted enabled:hover:text-foreground disabled:opacity-50"
                    >
                      {cmd}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}

            {!loadingMessages && (transcript.olderCursor !== null || olderForSession?.error) ? (
              <div className="flex flex-col gap-1.5 pb-2">
                {transcript.olderCursor !== null ? (
                  <button
                    type="button"
                    disabled={olderForSession?.loading === true}
                    onClick={() => void loadOlderMessages()}
                    className="flex w-full cursor-pointer items-center gap-3 py-1.5 text-muted-foreground text-xs hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-default"
                  >
                    <span aria-hidden="true" className="h-px flex-1 bg-border/70" />
                    <span className="shrink-0">
                      {olderForSession?.loading
                        ? gt("Loading earlier messages…")
                        : gt("Load earlier messages")}
                    </span>
                    <span aria-hidden="true" className="h-px flex-1 bg-border/70" />
                  </button>
                ) : null}
                {olderForSession?.error ? (
                  <p role="status" className="text-center text-muted-foreground text-xs">
                    {olderForSession.error}
                  </p>
                ) : null}
              </div>
            ) : null}

            {timelineItems.map((item) => {
              switch (item.kind) {
                case "user":
                  return (
                    <PaUserMessageRow
                      key={item.id}
                      message={item.message}
                      environmentId={environmentId}
                    />
                  );
                case "work-group":
                  return (
                    <PaWorkGroupRow key={item.id} steps={item.steps} timestamp={item.timestamp} />
                  );
                case "assistant":
                  return (
                    <PaAssistantMessageRow
                      key={item.id}
                      text={item.message.text}
                      timestamp={item.message.timestamp}
                      alwaysShowMeta={item.isLatestAssistant && !hasLiveTurn}
                      commentary={item.isCommentary}
                    />
                  );
                case "compaction":
                  return <PaCompactionRow key={item.id} message={item.message} />;
                case "system-output":
                  return <PaSystemOutputRow key={item.id} message={item.message} />;
              }
            })}

            {hasLiveTurn ? <PaLiveTurnView liveTurn={liveTurn} /> : null}

            <div ref={bottomRef} aria-hidden style={{ height: composerHeight + 20 }} />
          </div>
        </div>

        {showScrollToBottom ? (
          <ScrollToEndButton
            bottom={composerHeight + 8}
            summary={scrollToEndSummary}
            onScrollToEnd={scrollToBottom}
          />
        ) : null}

        <div
          ref={composerOverlayRef}
          className="chat-composer-lane pointer-events-none absolute inset-x-0 bottom-0 z-20 min-w-0 bg-gradient-to-t from-background via-background/85 to-transparent pt-4"
        >
          <PaComposer
            key={JSON.stringify([environmentId, activeSessionId])}
            environmentId={environmentId}
            bot={bot}
            capabilities={capabilities}
            sessionId={activeSessionId}
            draft={draft}
            onDraftChange={setDraft}
            running={running}
            sending={sending}
            disabled={!activeSessionId || !canOperate}
            slashCommands={slashCommands}
            openRequests={openRequests}
            respondingIds={respondingIds}
            clarifyAnswers={clarifyAnswers}
            onClarifyAnswerChange={(reqId, qId, val: PaClarifyAnswer) =>
              setClarifyAnswers((prev) => ({
                ...prev,
                [reqId]: { ...prev[reqId], [qId]: val },
              }))
            }
            onRespondRequest={(req, decision) => void handleRespondRequest(req, decision)}
            onRespondSecret={handleRespondSecret}
            onSend={(options) => handleSend(undefined, options)}
            onSteer={() => void handleSteer()}
            onInterrupt={() => void handleInterrupt()}
            statusSlot={
              <>
                <PaTodoProgressBar todos={liveTurn.todos} />
                <PaQueueBar
                  items={liveTurn.queuedItems}
                  canOperate={canOperate}
                  canSteer={running && canSteer && canOperate}
                  busyIds={queueBusyIds}
                  onSteer={(item) => void handleQueueAction(item, "steer")}
                  onCancel={(item) => void handleQueueAction(item, "cancel")}
                  onResolveUnknown={(item) => void handleQueueAction(item, "resolveUnknown")}
                />
              </>
            }
            error={streamError}
            onDismissError={() =>
              updateLiveTurn(activeSessionId, (prev) => ({ ...prev, error: null }))
            }
            modelPickerOpen={modelPicker.open}
            onModelPickerOpenChange={(open) =>
              setModelPicker((prev) => (open ? { ...prev, open } : { open: false, query: "" }))
            }
            modelQuery={modelPicker.query}
            onModelQueryChange={(query) => setModelPicker((prev) => ({ ...prev, query }))}
            liveReasoningEffort={
              sessionReasoning?.sessionId === activeSessionId &&
              sessionReasoning.settingsVersion === settingsVersion
                ? sessionReasoning.effort
                : null
            }
            modelRefreshVersion={settingsVersion}
            onReasoningChanged={(effort) => {
              if (!activeSessionId) return;
              setSessionReasoning({ sessionId: activeSessionId, effort, settingsVersion });
            }}
            onModelChanged={onActivity}
          />
          <div
            aria-hidden
            // The open keyboard already covers the home indicator.
            className={keyboardOpen ? "h-2" : "h-[max(0.75rem,env(safe-area-inset-bottom))]"}
          />
        </div>
      </div>
    </div>
  );
}
