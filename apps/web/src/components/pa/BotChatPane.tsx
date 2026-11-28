import { useAtomValue } from "@effect/atom-react";
import {
  paBotChatView,
  type PaClarifyAnswers,
  type PaSecretAnswer,
} from "@t3tools/client-runtime/pa/bot-chat";
import { paLiveTurnScrollSignature, selectPaQuickCommands } from "@t3tools/client-runtime/pa/chat";
import {
  formatPaSessionSource,
  summarizePaLiveActivity,
} from "@t3tools/client-runtime/pa/presentation";
import { parsePaClientSlashAction } from "@t3tools/client-runtime/pa/slash";
import {
  AuthOrchestrationReadScope,
  type PaBotSummary,
  type PaCapabilities,
  type PaSlashCommand,
} from "@t3tools/contracts";
import { T, useGT, useMessages } from "gt-react";
import { Loader2Icon, Settings2Icon } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";

import { isElectron } from "~/env";
import { useSoftwareKeyboardOpen } from "~/hooks/useSoftwareKeyboardOpen";
import { useStableCallback } from "~/hooks/useStableCallback";
import { observeResize } from "~/lib/observeResize";
import { getDocumentActivity, subscribeDocumentActivity } from "../../lib/documentActivity";
import { cn } from "../../lib/utils";
import {
  useConnectedEnvironmentIds,
  useEnvironment,
  usePrimaryEnvironmentId,
} from "../../state/environments";
import { useEnvironmentScopeDenied } from "../../state/session";
import { ScrollToEndButton } from "../chat/TimelineOverlays";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { useMobileSidebarSheetMounted } from "../ui/sidebar";
import { toastManager } from "../ui/toast";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { BotAvatar } from "./BotAvatar";
import {
  paSelectModelPermissionAtom,
  paSendPermissionAtom,
  paUpdateMetaPermissionAtom,
} from "./paApi";
import { PaComposer } from "./PaComposer";
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
import { usePaBotChat } from "./usePaBotChat";

const NO_SLASH_COMMANDS: ReadonlyArray<PaSlashCommand> = [];
const SCROLL_NEAR_BOTTOM_PX = 96;

export function BotChatPane({
  bot,
  capabilities,
  selectedSessionId,
  settingsVersion = 0,
  obscured = false,
  onSelectSession,
  onOpenSettings,
  onActivity,
}: {
  readonly bot: PaBotSummary;
  readonly capabilities: PaCapabilities | null;
  readonly selectedSessionId: string | null;
  readonly obscured?: boolean;
  readonly settingsVersion?: number;
  readonly onSelectSession: (sessionId: string) => void;
  readonly onOpenSettings: () => void;
  readonly onActivity: (patch?: { running?: true; awaiting?: true }) => void;
}) {
  const gt = useGT();
  const m = useMessages();
  const environmentId = usePrimaryEnvironmentId();
  const environment = useEnvironment(environmentId);
  const connectedEnvironmentIds = useConnectedEnvironmentIds();
  const connected =
    environmentId !== null &&
    (environment === null || connectedEnvironmentIds.includes(environmentId));
  const canSelectModel = useAtomValue(paSelectModelPermissionAtom(environmentId));
  const canMarkRead = useAtomValue(paUpdateMetaPermissionAtom(environmentId));
  const canOperate = useAtomValue(paSendPermissionAtom(environmentId));
  const readDenied = useEnvironmentScopeDenied(environmentId, AuthOrchestrationReadScope);
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const [modelPicker, setModelPicker] = useState({ open: false, query: "" });
  const [sessionReasoningOverride, setSessionReasoningOverride] = useState<{
    readonly sessionId: string;
    readonly effort: string;
    readonly settingsVersion: number;
  } | null>(null);

  const stableSelectSession = useStableCallback(onSelectSession);
  const stableOnActivity = useStableCallback(onActivity);
  const handleVoiceStopped = useStableCallback(() => {
    toastManager.add({ type: "info", title: gt("Voice chat stopped.") });
  });

  const { chat, state } = usePaBotChat(environmentId, bot.botId, {
    selectedSessionId,
    onActivity: stableOnActivity,
    onSessionSelected: stableSelectSession,
    onVoiceStopped: handleVoiceStopped,
  });

  const view = paBotChatView(state);
  const activeSessionId = view.sessionId;
  const transcript = view.transcript;
  const messages = transcript.messages;
  const olderForSession = view.older;
  const liveTurn = view.liveTurn;
  const running = view.running;
  const openRequests = liveTurn.openRequests;
  const streamError = liveTurn.error;
  const timelineItems = view.timelineItems;
  const hasLiveTurn = view.hasLiveTurn;
  const activeSession = view.activeSession;
  const draft = view.draft;
  const loadingChat =
    !view.readDenied &&
    ((activeSessionId === null && state.loadingSessions) || view.loadingMessages);

  const commandsSupported = capabilities?.commands.supported !== false;
  const canCreateSession = canOperate && capabilities?.sessions.create !== false;
  const canRenameSession = canOperate && capabilities?.sessions.renameExisting === true;
  const canSteer = capabilities?.execution.steer === true;
  const commands = commandsSupported ? state.slashCommands : NO_SLASH_COMMANDS;
  const slashCommands = commands.filter(
    (command) => canSelectModel || command.handling !== "client:model-picker",
  );
  const quickCommands = selectPaQuickCommands(slashCommands);

  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const composerOverlayRef = useRef<HTMLDivElement | null>(null);
  const [composerHeight, setComposerHeight] = useState(116);
  const keyboardOpen = useSoftwareKeyboardOpen();
  const isNearBottomRef = useRef<boolean>(true);
  const lastScrolledSessionRef = useRef<string | null>(null);
  const [scrolledUpForSession, setScrolledUpForSession] = useState<string | null>(null);
  const showScrollToBottom = activeSessionId !== null && scrolledUpForSession === activeSessionId;
  const bottomRef = useRef<HTMLDivElement | null>(null);

  /** Where the reader was before older rows went in above them, restored before paint. */
  const pendingPrependRef = useRef<{
    readonly sessionId: string;
    readonly anchorId: string;
    readonly timelineCount: number;
    readonly scrollHeight: number;
    readonly scrollTop: number;
  } | null>(null);

  const documentActivity = useSyncExternalStore(
    subscribeDocumentActivity,
    getDocumentActivity,
    getDocumentActivity,
  );
  const sidebarMounted = useMobileSidebarSheetMounted();
  const covered = obscured || sidebarMounted;
  const reading = documentActivity.visible && documentActivity.focused && !covered;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- only a visible, focused, uncovered chat acknowledges unread replies or creates a missing primary session
  useEffect(() => (reading ? chat.holdVisible() : undefined), [chat, reading]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- feeds latest Bot metadata, primary session hint, and permissions into the retained chat controller
  useEffect(() => {
    chat.setContext({
      capabilities,
      canOperate,
      canMarkRead,
      readDenied,
      unread: bot.unread,
      connected,
      primarySessionId: bot.primarySessionId,
    });
  }, [
    chat,
    capabilities,
    canOperate,
    canMarkRead,
    readDenied,
    bot.unread,
    connected,
    bot.primarySessionId,
  ]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- connects the controller's /model slash action to this pane's picker state
  useEffect(() => {
    if (!canSelectModel) {
      chat.setOpenModelPicker(null);
      return;
    }
    chat.setOpenModelPicker((query) => setModelPicker({ open: true, query }));
    return () => chat.setOpenModelPicker(null);
  }, [chat, canSelectModel]);

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

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- restores the DOM scroll offset before paint so rows inserted above the viewport do not move what the reader is looking at
  useLayoutEffect(() => {
    const pending = pendingPrependRef.current;
    const el = scrollContainerRef.current;
    if (!pending || !el) return;
    if (pending.sessionId !== activeSessionId) {
      pendingPrependRef.current = null;
      return;
    }
    if (messages[0]?.id === pending.anchorId) return;
    pendingPrependRef.current = null;
    if (!messages.some((message) => message.id === pending.anchorId)) return;
    if (timelineItems.length > pending.timelineCount) {
      // Rows going in above must not read as new rows to follow at the bottom.
      isNearBottomRef.current = false;
      el.scrollTop = pending.scrollTop + (el.scrollHeight - pending.scrollHeight);
    }
  }, [messages, timelineItems.length, activeSessionId]);

  const scrollTargetScore = timelineItems.length * 1000 + paLiveTurnScrollSignature(liveTurn);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- snaps to the end before first paint on initial load / session switch so the top of a long transcript never flashes
  useLayoutEffect(() => {
    const isInitialForSession = lastScrolledSessionRef.current !== activeSessionId;
    if (!isInitialForSession) return;
    isNearBottomRef.current = true;
    if (scrollTargetScore > 0) {
      lastScrolledSessionRef.current = activeSessionId;
      bottomRef.current?.scrollIntoView({ behavior: "auto", block: "end" });
    }
  }, [scrollTargetScore, activeSessionId]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- follows live appends smoothly once the session's initial bottom snap has settled
  useEffect(() => {
    if (
      lastScrolledSessionRef.current === activeSessionId &&
      scrollTargetScore > 0 &&
      isNearBottomRef.current
    ) {
      bottomRef.current?.scrollIntoView({
        behavior: running ? "auto" : "smooth",
        block: "end",
      });
    }
  }, [scrollTargetScore, running, activeSessionId]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the software keyboard shrinks the timeline viewport, so a reader following the end would lose the latest message under it
  useEffect(() => {
    const el = scrollContainerRef.current;
    if (keyboardOpen && el && isNearBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [keyboardOpen]);

  const formatSourceLabel = (source: string): string => formatPaSessionSource(source, m);

  const loadOlderMessages = async () => {
    const sessionId = activeSessionId;
    const anchorId = messages[0]?.id;
    if (!sessionId || !transcript.olderCursor || olderForSession?.loading) return;
    const el = scrollContainerRef.current;
    pendingPrependRef.current =
      el && anchorId !== undefined
        ? {
            sessionId,
            anchorId,
            timelineCount: timelineItems.length,
            scrollHeight: el.scrollHeight,
            scrollTop: el.scrollTop,
          }
        : null;
    await chat.loadOlderMessages();
    if (pendingPrependRef.current?.sessionId === sessionId) {
      // If the older page added nothing or was stale, release the guard so bottom-follow stays active.
      const latestFirstId = paBotChatView(chat.getState()).transcript.messages[0]?.id;
      if (latestFirstId === anchorId) pendingPrependRef.current = null;
    }
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

  // Dragging or tapping the open timeline closes the keyboard, as chat apps do.
  const dismissSoftwareKeyboard = () => {
    const active = document.activeElement;
    if (
      keyboardOpen &&
      active instanceof HTMLElement &&
      composerOverlayRef.current?.contains(active)
    ) {
      active.blur();
    }
  };

  const handleTimelineClick = (event: React.MouseEvent<HTMLDivElement>) => {
    const target = event.target;
    if (
      target === event.currentTarget ||
      target === event.currentTarget.firstElementChild ||
      target === bottomRef.current
    ) {
      dismissSoftwareKeyboard();
    }
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

  const handleSteer = () => {
    const text = draft.trim();
    if (!canSelectModel && parsePaClientSlashAction(text, commands)?.kind === "model-picker") {
      return;
    }
    void chat.steer();
  };

  const controllerReasoning = activeSessionId ? state.sessionReasoning[activeSessionId] : undefined;
  const liveReasoningEffort =
    sessionReasoningOverride?.sessionId === activeSessionId &&
    sessionReasoningOverride.settingsVersion === settingsVersion
      ? sessionReasoningOverride.effort
      : controllerReasoning?.settingsVersion === state.settingsVersion
        ? controllerReasoning.effort
        : null;

  const scrollToEndSummary = summarizePaLiveActivity(liveTurn, m);

  return (
    <div className="relative flex min-h-0 w-full min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
      <WorkspacePageHeader
        electron={isElectron}
        className="justify-between gap-2 border-b border-border/60"
      >
        <div className="flex min-w-0 items-center gap-2.5">
          <BotAvatar
            color={bot.avatarColor}
            shape={bot.avatarShape}
            size="sm"
            online={bot.online && connected}
            running={running}
            visible={!covered}
            awaiting={openRequests.length > 0}
            starred={bot.isDefault}
          />
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
                    ? "bg-warning"
                    : bot.online && connected
                      ? "bg-success"
                      : "bg-muted-foreground/40",
                )}
              />
              <span className="truncate">
                {openRequests.length
                  ? gt("Waiting for input")
                  : running
                    ? liveTurn.statusText || gt("Working…")
                    : bot.model || bot.agentRef}
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
            sessions={state.sessions}
            hasMoreSessions={state.sessionsCursor !== null}
            loadingMoreSessions={state.loadingMoreSessions}
            activeSessionId={activeSessionId}
            canCreateSession={canCreateSession}
            canRenameSession={canRenameSession}
            formatSourceLabel={formatSourceLabel}
            onSelectSession={(session) => {
              setSessionsOpen(false);
              chat.selectSession(session);
            }}
            onCreateSession={() => {
              setSessionsOpen(false);
              void chat.createSession();
            }}
            onLoadMoreSessions={() => void chat.loadMoreSessions()}
            onSessionRenamed={(sessionId, title) => chat.patchSession(sessionId, { title })}
            onError={(message) => chat.setError(message)}
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
            {loadingChat ? (
              <div className="flex items-center justify-center py-12 text-sm text-muted-foreground">
                <Loader2Icon className="mr-2 size-4 animate-spin" />
                <T>Loading conversation…</T>
              </div>
            ) : null}

            {view.readDenied ? (
              <div className="flex flex-col items-center justify-center py-12 text-center text-sm text-muted-foreground">
                {gt("Could not load messages")}
              </div>
            ) : null}

            {!view.readDenied && !loadingChat && timelineItems.length === 0 && !hasLiveTurn ? (
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
                  online={bot.online && connected}
                  running={running}
                  visible={!covered}
                  awaiting={openRequests.length > 0}
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
                      onClick={() => void chat.send(cmd)}
                      className="rounded-full border border-border/70 bg-muted/40 px-3 py-1 font-mono text-xs text-muted-foreground transition-colors enabled:hover:bg-muted enabled:hover:text-foreground disabled:opacity-50"
                    >
                      {cmd}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}

            {!view.loadingMessages &&
            (transcript.olderCursor !== null || olderForSession?.error) ? (
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
            sessionModel={activeSession?.model ?? null}
            draft={draft}
            hasPaneDraft={Object.values(state.drafts).some((text) => text.trim().length > 0)}
            onDraftChange={(value) => chat.setDraft(value)}
            running={running}
            sending={state.sending}
            disabled={!activeSessionId || !canOperate || !connected || view.readDenied}
            slashCommands={commands}
            openRequests={openRequests}
            respondingIds={state.respondingIds}
            canSelectModel={canSelectModel}
            onRespondRequest={(req, decision, answers?: PaClarifyAnswers) =>
              void chat.respondRequest(req, decision, answers)
            }
            onRespondSecret={(req, answer: PaSecretAnswer) => chat.respondSecret(req, answer)}
            onSend={({ textOverride, ...options }) => {
              isNearBottomRef.current = true;
              setScrolledUpForSession(null);
              return chat.send(undefined, { ...options, draftText: textOverride });
            }}
            onSteer={handleSteer}
            onInterrupt={() => void chat.interrupt()}
            statusSlot={
              <>
                <PaTodoProgressBar todos={liveTurn.todos} />
                <PaQueueBar
                  items={liveTurn.queuedItems}
                  canOperate={canOperate}
                  canSteer={running && canSteer && canOperate}
                  busyIds={state.queueBusyIds}
                  onSteer={(item) => void chat.manageQueuedItem(item, "steer")}
                  onCancel={(item) => void chat.manageQueuedItem(item, "cancel")}
                  onResolveUnknown={(item) => void chat.manageQueuedItem(item, "resolveUnknown")}
                />
              </>
            }
            error={streamError ?? state.initializationError}
            onDismissError={() => chat.dismissError()}
            modelPickerOpen={modelPicker.open}
            onModelPickerOpenChange={(open) =>
              setModelPicker((prev) => (open ? { ...prev, open } : { open: false, query: "" }))
            }
            modelQuery={modelPicker.query}
            onModelQueryChange={(query) => setModelPicker((prev) => ({ ...prev, query }))}
            liveReasoningEffort={liveReasoningEffort}
            modelRefreshVersion={settingsVersion}
            onReasoningChanged={(effort) => {
              if (!activeSessionId) return;
              setSessionReasoningOverride({ sessionId: activeSessionId, effort, settingsVersion });
              chat.setReasoning(activeSessionId, effort);
            }}
            onModelChanged={(model, targetSessionId) => {
              if (capabilities?.models.scope === "session" && targetSessionId) {
                chat.patchSession(targetSessionId, { model });
              }
              onActivity();
            }}
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
