import { T, useGT } from "gt-react";
import {
  ChevronDownIcon,
  HistoryIcon,
  Loader2Icon,
  MessageSquarePlusIcon,
  Settings2Icon,
} from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { isElectron } from "~/env";
import { useStableCallback } from "~/hooks/useStableCallback";
import { observeResize } from "~/lib/observeResize";
import { cn } from "../../lib/utils";
import { ScrollToEndButton } from "../chat/TimelineOverlays";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { paErrorReason } from "@t3tools/client-runtime/pa/environment";
import { parsePaClientSlashAction } from "@t3tools/client-runtime/pa/slash";
import {
  buildPaTimelineItems,
  clearSettledPaLiveTurn,
  createInitialPaLiveTurn,
  findActivePaToolAction,
  mergePaMessagesByTime,
  nextPaLocalTimestamp,
  paNoticeMessage,
  reducePaStreamEvent,
  type PaLiveTurnState,
} from "@t3tools/client-runtime/pa/timeline";
import type {
  PaBotSummary,
  PaCapabilities,
  PaClarifyAnswer,
  PaMessage,
  PaPendingRequest,
  PaSessionSummary,
  PaSlashCommand,
  PaStreamEvent,
} from "@t3tools/contracts";
import { sendPaChatMessage, trackAdmittedPaRow } from "./BotChatPane.logic";
import { BotAvatar } from "./BotAvatar";
import { paApi, paErrorMessage } from "./paApi";
import { PaComposer, type PaClarifyAnswers } from "./PaComposer";
import {
  formatPaToolVerb,
  PaAssistantMessageRow,
  PaCompactionRow,
  PaLiveTurnView,
  PaSystemOutputRow,
  PaUserMessageRow,
  PaWorkGroupRow,
} from "./PaTimelineRows";

const QUICK_COMMAND_COUNT = 3;
const NO_SLASH_COMMANDS: ReadonlyArray<PaSlashCommand> = [];
const SCROLL_NEAR_BOTTOM_PX = 96;

let localMessageSeq = 0;

function createLocalMessage(role: PaMessage["role"], text: string, timestamp: number): PaMessage {
  localMessageSeq += 1;
  return {
    id: `local-${role}-${localMessageSeq}`,
    role,
    text,
    timestamp,
    rowKind: "message",
  };
}

function makeInputId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    return `pa-${hex}`;
  }
  localMessageSeq += 1;
  return `pa-input-${Date.now()}-${localMessageSeq}`;
}

function liveTurnScrollSignature(turn: PaLiveTurnState): number {
  let score = turn.blocks.length * 10 + turn.openRequests.length * 100;
  for (const block of turn.blocks) {
    if (block.kind === "text") {
      score += block.text.length;
    } else {
      score += block.steps.length * 20;
      for (const step of block.steps) {
        score += step.text.length + (step.toolResult?.length ?? 0);
      }
    }
  }
  return score;
}

export function BotChatPane({
  bot,
  capabilities,
  selectedSessionId,
  onSelectSession,
  onOpenSettings,
  onActivity,
}: {
  readonly bot: PaBotSummary;
  readonly capabilities: PaCapabilities | null;
  readonly selectedSessionId: string | null;
  readonly onSelectSession: (sessionId: string) => void;
  readonly onOpenSettings: () => void;
  readonly onActivity: () => void;
}) {
  const gt = useGT();
  const [sessions, setSessions] = useState<ReadonlyArray<PaSessionSummary>>([]);
  const [fallbackSessionId, setFallbackSessionId] = useState<string | null>(null);
  const activeSessionId = selectedSessionId ?? fallbackSessionId;
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const [loadingSessions, setLoadingSessions] = useState(true);

  const [messagesState, setMessagesState] = useState<{
    readonly sessionId: string | null;
    readonly items: ReadonlyArray<PaMessage>;
  }>({ sessionId: null, items: [] });
  const [localBySession, setLocalBySession] = useState<Record<string, ReadonlyArray<PaMessage>>>(
    {},
  );
  const [loadingMessagesFor, setLoadingMessagesFor] = useState<string | null>(null);
  const [loadedSlashCommands, setSlashCommands] = useState<ReadonlyArray<PaSlashCommand>>([]);
  const [liveTurnState, setLiveTurnState] = useState<PaLiveTurnState>(() =>
    createInitialPaLiveTurn(null),
  );

  const activeSessionIdRef = useRef<string | null>(activeSessionId);

  const messages = messagesState.sessionId === activeSessionId ? messagesState.items : [];
  // A session's transcript is read once its feed attaches; until then nothing for it is shown.
  const loadingMessages =
    activeSessionId !== null &&
    (messagesState.sessionId !== activeSessionId || loadingMessagesFor === activeSessionId);
  const liveTurn =
    liveTurnState.sessionId === activeSessionId
      ? liveTurnState
      : createInitialPaLiveTurn(activeSessionId);
  const running = liveTurn.phase === "running";
  const openRequests = liveTurn.openRequests;
  const streamError = liveTurn.error;
  const localMessages = activeSessionId ? (localBySession[activeSessionId] ?? []) : [];
  const mergedMessages = mergePaMessagesByTime(messages, localMessages);

  const setSessionMessages = (
    sessionId: string,
    updater:
      | ReadonlyArray<PaMessage>
      | ((prev: ReadonlyArray<PaMessage>) => ReadonlyArray<PaMessage>),
  ) => {
    if (activeSessionIdRef.current !== sessionId) return;
    setMessagesState((prev) => {
      const current = prev.sessionId === sessionId ? prev.items : [];
      const nextItems = typeof updater === "function" ? updater(current) : updater;
      return { sessionId, items: nextItems };
    });
  };

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

  const settleTokensRef = useRef(new Map<string, number>());
  const transcriptRequestRef = useRef(0);
  const failedSendRef = useRef(new Map<string, { text: string; inputId: string }>());
  /** An admitted row can be reconciled by text, or by turn completion for rewritten prompts. */
  const pendingUserRowsRef = useRef(new Map<string, Map<string, boolean>>());
  const recoveredSessionsRef = useRef(new Set<string>());
  const mountedRef = useRef(false);
  const commandsSupported = capabilities?.commands.supported !== false;
  const canCreateSession = capabilities?.sessions.create !== false;
  const canInterrupt = capabilities?.execution.interrupt !== false;
  const slashCommands = commandsSupported ? loadedSlashCommands : NO_SLASH_COMMANDS;

  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [modelPicker, setModelPicker] = useState({ open: false, query: "" });
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const composerOverlayRef = useRef<HTMLDivElement | null>(null);
  const [composerHeight, setComposerHeight] = useState(116);
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
        .then((loaded) => {
          if (!current()) return;
          setSessionMessages(sessionId, loaded);
          if (candidates.size > 0) {
            const storedUserTexts = new Set(
              loaded.flatMap((item) => (item.role === "user" ? [item.text.trim()] : [])),
            );
            setLocalBySession((prev) => {
              const existing = prev[sessionId] ?? [];
              // Stored as typed, or (a command rewritten into a prompt) once its turn has ended.
              const reconciled = new Set(
                existing
                  .filter(
                    (item) =>
                      candidates.has(item.id) &&
                      (candidates.get(item.id) || storedUserTexts.has(item.text.trim())),
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
              prev.sessionId === sessionId ? prev : { sessionId, items: [] },
            );
            updateLiveTurn(sessionId, (prev) => ({
              ...prev,
              error: paErrorMessage(err, gt("加载消息失败")),
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

  const formatSourceLabel = (source: string): string => {
    switch (source.toLowerCase()) {
      case "gui":
        return gt("T3 Web");
      case "feishu":
        return gt("飞书");
      case "telegram":
        return gt("Telegram");
      case "cron":
        return gt("定时任务");
      case "cli":
      case "tui":
        return gt("终端");
      case "local":
        return gt("本地");
      default:
        return source;
    }
  };

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

        const initialProp = getSelectedSessionProp();
        let targetId =
          initialProp && sessionRes.sessions.some((s) => s.sessionId === initialProp)
            ? initialProp
            : sessionRes.primarySessionId;

        if (!targetId && canCreateSession) {
          const created = await paApi.ensurePrimarySession(bot.botId);
          if (controller.signal.aborted) return;
          targetId = created.sessionId;
          setSessions((prev) => [created, ...prev]);
        }
        targetId ??= sessionRes.sessions[0]?.sessionId ?? null;
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
            error: paErrorMessage(err, gt("连接 Bot 会话失败")),
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
      nextId ??= remaining[0]?.sessionId ?? null;
      setSessions(nextSessions);
      if (!nextId) {
        // Nowhere to move and no way to start a conversation: say so instead of going blank.
        updateLiveTurn(missingId, (prev) => ({
          ...prev,
          error: paErrorMessage(cause, gt("这个对话已不存在")),
        }));
        return;
      }
      activeSessionIdRef.current = nextId;
      setFallbackSessionId(nextId);
      stableSelectSession(nextId);
    } catch (err) {
      updateLiveTurn(missingId, (prev) => ({
        ...prev,
        error: paErrorMessage(err, gt("连接 Bot 会话失败")),
      }));
    }
  });

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

    const handleEvent = (event: PaStreamEvent) => {
      if (closed || activeSessionIdRef.current !== sessionId) return;
      switch (event.type) {
        case "snapshot":
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
          setSessions((prev) =>
            prev.map((item) =>
              item.sessionId === sessionId
                ? {
                    ...item,
                    ...(event.title ? { title: event.title } : {}),
                    ...(event.model ? { model: event.model } : {}),
                  }
                : item,
            ),
          );
          return;
        case "turn.completed":
        case "error": {
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
            retrying ? gt("会话连接中断，正在重连") : gt("连接 Bot 会话失败"),
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
    gt,
    loadTranscript,
    localTimestampNow,
    recoverMissingSession,
    updateLiveTurn,
    stableOnActivity,
  ]);

  const timelineItems = buildPaTimelineItems(mergedMessages);
  const hasLiveTurn = liveTurn.phase !== "idle" || liveTurn.blocks.length > 0;

  const scrollTargetScore = mergedMessages.length * 1000 + liveTurnScrollSignature(liveTurn);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- anchors the viewport to the latest message while the user is following at the bottom
  useEffect(() => {
    if (scrollTargetScore > 0 && isNearBottomRef.current) {
      bottomRef.current?.scrollIntoView({
        behavior: running ? "auto" : "smooth",
        block: "end",
      });
    }
  }, [scrollTargetScore, running]);

  const handleViewportScroll = () => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const nearBottom = distanceFromBottom < SCROLL_NEAR_BOTTOM_PX;
    isNearBottomRef.current = nearBottom;
    const nextScrolledUp = nearBottom ? null : activeSessionId;
    setScrolledUpForSession((prev) => (prev === nextScrolledUp ? prev : nextScrolledUp));
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
  // Everyday engine commands that answer at once, offered on an empty conversation.
  const quickCommands = slashCommands
    .filter(
      (cmd) =>
        cmd.featured === true &&
        cmd.group === "command" &&
        cmd.requiredScope === "operate" &&
        (cmd.handling === "engine" || cmd.handling === "client:model-picker"),
    )
    .slice(0, QUICK_COMMAND_COUNT)
    .map((cmd) => cmd.name);

  const switchSession = (nextSessionId: string) => {
    setSessionsOpen(false);
    if (nextSessionId === activeSessionId) return;
    activeSessionIdRef.current = nextSessionId;
    setFallbackSessionId(nextSessionId);
    onSelectSession(nextSessionId);
  };

  const handleCreateNewSession = async (title = "") => {
    setSessionsOpen(false);
    const fromSessionId = activeSessionId;
    let created: PaSessionSummary;
    try {
      created = await paApi.createSession(bot.botId, title || undefined);
    } catch (err) {
      updateLiveTurn(fromSessionId, (prev) => ({
        ...prev,
        error: paErrorMessage(err, gt("新建对话失败")),
      }));
      return;
    }
    // This pane belongs to one Bot: a create that lands after leaving it must not navigate back.
    if (!mountedRef.current) return;
    setSessions((prev) => [created, ...prev.map((s) => ({ ...s, isPrimary: false }))]);
    activeSessionIdRef.current = created.sessionId;
    setFallbackSessionId(created.sessionId);
    onSelectSession(created.sessionId);
  };

  const handleSend = async (rawOverride?: string) => {
    const text = (rawOverride ?? draft).trim();
    const sessionId = activeSessionId;
    if (!text || !sessionId || sending) return;

    // The engine's catalog marks the commands a client runs itself (new session, stop, model).
    const clientAction = parsePaClientSlashAction(text, slashCommands);
    if (clientAction) {
      if (rawOverride === undefined) setDraft("");
      updateLiveTurn(sessionId, (prev) => ({ ...prev, error: null }));
      switch (clientAction.kind) {
        case "new-session":
          if (!canCreateSession) {
            updateLiveTurn(sessionId, (prev) => ({
              ...prev,
              error: gt("这个 Bot 不支持新建对话"),
            }));
            return;
          }
          await handleCreateNewSession(clientAction.title);
          return;
        case "interrupt":
          if (!canInterrupt) {
            updateLiveTurn(sessionId, (prev) => ({
              ...prev,
              error: gt("这个 Bot 不支持停止回复"),
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
    if (rawOverride === undefined) setDraft("");
    isNearBottomRef.current = true;
    setScrolledUpForSession(null);

    // A local row until a reload shows it stored; only an admitted turn is ever stored.
    const optimisticMsg = createLocalMessage("user", text, localTimestampNow());
    appendLocalMessage(sessionId, optimisticMsg);
    const completedBeforeSend = settleTokensRef.current.get(sessionId);
    try {
      const { result: res, inputId } = await sendPaChatMessage(
        failedSendRef.current,
        sessionId,
        text,
        makeInputId,
        (id) => paApi.sendMessage(bot.botId, sessionId, text, id),
      );
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
            { message: res.output || res.notice || gt("命令已执行"), inputId },
            localTimestampNow(),
          ),
        );
        onActivity();
      } else if (turnEnded) {
        if (activeSessionIdRef.current === sessionId) {
          void loadTranscript(sessionId, false, settleToken);
        }
        if (res.settled) onActivity();
      } else {
        updateLiveTurn(sessionId, (prev) =>
          prev.phase === "running"
            ? prev
            : {
                ...createInitialPaLiveTurn(sessionId),
                phase: "running",
                startedAt: Date.now(),
                openRequests: prev.openRequests,
                settleToken: prev.settleToken,
              },
        );
      }
    } catch (err) {
      removeLocalMessage(sessionId, optimisticMsg.id);
      if (rawOverride === undefined && activeSessionIdRef.current === sessionId) {
        setDraft((current) => (current ? current : text));
      }
      updateLiveTurn(sessionId, (prev) => ({
        ...prev,
        error: paErrorMessage(err, gt("发送失败")),
      }));
    } finally {
      setSending(false);
    }
  };

  const handleInterrupt = async () => {
    if (!activeSessionId) return;
    const sessionId = activeSessionId;
    try {
      // The turn's own completion settles it: trailing frames may still be on their way.
      await paApi.interruptSession(bot.botId, sessionId);
      updateLiveTurn(sessionId, (prev) => ({ ...prev, statusText: null }));
    } catch (err) {
      updateLiveTurn(sessionId, (prev) => ({
        ...prev,
        error: paErrorMessage(err, gt("停止失败")),
      }));
    }
  };

  const handleRespondRequest = async (req: PaPendingRequest, decision?: string) => {
    if (!activeSessionId || respondingIds.has(req.requestId)) return;
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
        error: paErrorMessage(err, gt("响应请求失败")),
      }));
    } finally {
      setRespondingIds((prev) => {
        const next = new Set(prev);
        next.delete(req.requestId);
        return next;
      });
    }
  };

  let scrollToEndSummary: string | null = null;
  if (openRequests.length > 0) {
    scrollToEndSummary = gt("等待你的确认");
  } else if (running) {
    const lastBlock = liveTurn.blocks[liveTurn.blocks.length - 1];
    if (lastBlock?.kind === "text" && lastBlock.text.length > 0) {
      scrollToEndSummary = gt("正在输出");
    } else if (lastBlock?.kind === "work-group") {
      const activeTool = findActivePaToolAction(liveTurn);
      scrollToEndSummary = activeTool
        ? formatPaToolVerb(gt, activeTool)
        : liveTurn.statusText || gt("思考中");
    } else {
      scrollToEndSummary = liveTurn.statusText || gt("思考中");
    }
  }

  return (
    <div
      className="relative flex min-h-0 w-full min-w-0 flex-1 flex-col overflow-x-hidden bg-background"
      style={{
        paddingLeft: "env(safe-area-inset-left)",
        paddingRight: "env(safe-area-inset-right)",
      }}
    >
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
                {running ? liveTurn.statusText || gt("处理中...") : bot.model || bot.agentRef}
              </span>
            </div>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          <Popover open={sessionsOpen} onOpenChange={setSessionsOpen}>
            <PopoverTrigger
              render={
                <Button type="button" size="xs" variant="ghost-muted">
                  <HistoryIcon className="size-3.5" />
                  <span className="hidden max-w-28 truncate sm:inline">
                    {activeSession
                      ? activeSession.isPrimary
                        ? gt("主对话")
                        : formatSourceLabel(activeSession.source)
                      : gt("会话")}
                  </span>
                  <ChevronDownIcon className="size-3" />
                </Button>
              }
            />
            <PopoverPopup align="end" className="w-72">
              <div className="mb-1.5 flex items-center justify-between px-1 py-1">
                <span className="text-xs font-medium text-muted-foreground">
                  <T>切换对话记录</T>
                </span>
                {canCreateSession ? (
                  <Button
                    type="button"
                    size="xs"
                    variant="ghost"
                    onClick={() => void handleCreateNewSession()}
                  >
                    <MessageSquarePlusIcon className="size-3" />
                    <T>新对话</T>
                  </Button>
                ) : null}
              </div>
              <div className="max-h-72 space-y-1 overflow-y-auto">
                {sessions.map((item) => (
                  <button
                    key={item.sessionId}
                    type="button"
                    onClick={() => switchSession(item.sessionId)}
                    className={cn(
                      "flex w-full flex-col gap-0.5 rounded-lg px-2.5 py-2 text-left transition-colors",
                      item.sessionId === activeSessionId
                        ? "bg-primary/10 text-foreground"
                        : "text-foreground/85 hover:bg-muted/60",
                    )}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-xs font-medium">{item.title}</span>
                      <Badge variant="outline" size="sm" className="shrink-0">
                        {item.isPrimary ? gt("主对话") : formatSourceLabel(item.source)}
                      </Badge>
                    </div>
                    <div className="text-3xs text-muted-foreground">
                      {item.model
                        ? gt("{count} 条消息 · {model}", {
                            count: item.messageCount,
                            model: item.model,
                          })
                        : gt("{count} 条消息", { count: item.messageCount })}
                    </div>
                  </button>
                ))}
              </div>
            </PopoverPopup>
          </Popover>

          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="size-8"
            aria-label={gt("Bot 设置")}
            onClick={onOpenSettings}
          >
            <Settings2Icon className="size-4" />
          </Button>
        </div>
      </WorkspacePageHeader>

      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
        <div
          ref={scrollContainerRef}
          onScroll={handleViewportScroll}
          className="scrollbar-gutter-both min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-y-contain px-3 pt-4 sm:px-8"
        >
          <div className="chat-content-lane flex flex-col">
            {loadingSessions || loadingMessages ? (
              <div className="flex items-center justify-center py-12 text-sm text-muted-foreground">
                <Loader2Icon className="mr-2 size-4 animate-spin" />
                <T>正在加载对话...</T>
              </div>
            ) : null}

            {!loadingSessions && !loadingMessages && timelineItems.length === 0 && !hasLiveTurn ? (
              <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
                <BotAvatar
                  color={bot.avatarColor}
                  shape={bot.avatarShape}
                  size="lg"
                  starred={bot.isDefault}
                />
                <div className="space-y-1">
                  <div className="text-base font-semibold">{bot.name}</div>
                  <p className="max-w-xs text-xs text-muted-foreground">
                    {bot.description ||
                      (slashCommands.length > 0
                        ? gt("直接开始聊天，或输入 / 使用 {engine} 的命令。", {
                            engine: bot.engineLabel,
                          })
                        : gt("直接开始聊天。"))}
                  </p>
                </div>
                <div className="flex flex-wrap justify-center gap-1.5 pt-1">
                  {quickCommands.map((cmd) => (
                    <button
                      key={cmd}
                      type="button"
                      onClick={() => void handleSend(cmd)}
                      className="rounded-full border border-border/70 bg-muted/40 px-3 py-1 font-mono text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                    >
                      {cmd}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}

            {timelineItems.map((item) => {
              switch (item.kind) {
                case "user":
                  return <PaUserMessageRow key={item.id} message={item.message} />;
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
          className="pointer-events-none absolute inset-x-0 bottom-0 z-20 min-w-0 bg-gradient-to-t from-background via-background/85 to-transparent px-3 pt-4 sm:px-8"
          style={{ paddingBottom: "max(0.75rem, env(safe-area-inset-bottom))" }}
        >
          <PaComposer
            bot={bot}
            capabilities={capabilities}
            sessionId={activeSessionId}
            draft={draft}
            onDraftChange={setDraft}
            running={running}
            sending={sending}
            disabled={!activeSessionId}
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
            onSend={() => void handleSend()}
            onInterrupt={() => void handleInterrupt()}
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
            onModelChanged={onActivity}
          />
        </div>
      </div>
    </div>
  );
}
