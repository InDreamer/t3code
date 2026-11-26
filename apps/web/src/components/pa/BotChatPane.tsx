import { T, useGT, Var } from "gt-react";
import {
  ArrowLeftIcon,
  ChevronDownIcon,
  HistoryIcon,
  Loader2Icon,
  MessageSquarePlusIcon,
  SendHorizontalIcon,
  Settings2Icon,
  ShieldAlertIcon,
  SlashIcon,
  SquareIcon,
  TerminalIcon,
  WrenchIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { cn } from "../../lib/utils";
import { useStableCallback } from "~/hooks/useStableCallback";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { BotAvatar } from "./BotAvatar";
import { isTerminalPaError, paApi } from "./paApi";
import {
  acceptPaSeq,
  type PaBotSummary,
  type PaMessage,
  type PaPendingRequest,
  type PaSeqCursor,
  type PaSessionSummary,
  type PaSlashCommand,
  type PaStreamEvent,
} from "./paTypes";

function formatMessageTime(ts: number | null): string {
  if (!ts) return "";
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

interface MarkdownBlock {
  readonly key: string;
  readonly type: "code" | "text";
  readonly content: string;
}

function splitMarkdownBlocks(text: string): ReadonlyArray<MarkdownBlock> {
  const parts: MarkdownBlock[] = [];
  const fence = /```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = fence.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push({
        key: `t-${lastIndex}`,
        type: "text",
        content: text.slice(lastIndex, match.index),
      });
    }
    parts.push({
      key: `c-${match.index}`,
      type: "code",
      content: match[2] ?? "",
    });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) {
    const tail = text.slice(lastIndex);
    // Support unclosed trailing code fences cleanly while streaming tokens.
    const openFence = /```([a-zA-Z0-9_-]*)\n([\s\S]*)$/.exec(tail);
    if (openFence) {
      if (openFence.index > 0) {
        parts.push({
          key: `t-${lastIndex}`,
          type: "text",
          content: tail.slice(0, openFence.index),
        });
      }
      parts.push({
        key: `c-${lastIndex + openFence.index}`,
        type: "code",
        content: openFence[2] ?? "",
      });
    } else {
      parts.push({
        key: `t-${lastIndex}`,
        type: "text",
        content: tail,
      });
    }
  }
  return parts;
}

const TRAILING_URL_PUNCTUATION = ".,;:!?)。，；：！？、》】";
// One level of balanced parentheses inside a link target, e.g. wiki/Function_(mathematics).
const LINK_TARGET = String.raw`https?:\/\/(?:[^\s()]|\([^\s()]*\))+`;
const INLINE_TOKEN_RE = new RegExp(
  String.raw`(\`[^\`]+\`|\*\*[^*]+\*\*|\[[^\]\n]+\]\(${LINK_TARGET}\)|https?:\/\/[^\s<]+)`,
  "g",
);
const MARKDOWN_LINK_RE = new RegExp(String.raw`^\[([^\]\n]+)\]\((${LINK_TARGET})\)$`);

/** Splits sentence punctuation off a bare URL, keeping a ")" that closes a "(" in the URL. */
function splitTrailingPunctuation(url: string): readonly [string, string] {
  let end = url.length;
  while (end > 0 && TRAILING_URL_PUNCTUATION.includes(url[end - 1]!)) {
    if (url[end - 1] === ")") {
      const body = url.slice(0, end);
      const opens = body.split("(").length - 1;
      const closes = body.split(")").length - 1;
      if (opens >= closes) break;
    }
    end -= 1;
  }
  return [url.slice(0, end), url.slice(end)];
}

function PaMarkdownText({ text }: { readonly text: string }) {
  const blocks = splitMarkdownBlocks(text);

  const renderInline = (line: string, lineKey: string) => {
    const tokens = line.split(INLINE_TOKEN_RE);
    let offset = 0;
    return tokens.map((token) => {
      const key = `${lineKey}-${offset}`;
      offset += token.length + 1;
      if (!token) return null;
      if (token.startsWith("`") && token.endsWith("`") && token.length > 2) {
        return (
          <code
            key={key}
            className="rounded bg-muted px-1 py-0.5 font-mono text-xs text-foreground"
          >
            {token.slice(1, -1)}
          </code>
        );
      }
      if (token.startsWith("**") && token.endsWith("**") && token.length > 4) {
        return (
          <strong key={key} className="font-semibold">
            {token.slice(2, -2)}
          </strong>
        );
      }
      const mdLink = MARKDOWN_LINK_RE.exec(token);
      if (mdLink) {
        return (
          <a
            key={key}
            href={mdLink[2]}
            target="_blank"
            rel="noreferrer"
            className="text-primary underline underline-offset-2"
          >
            {mdLink[1]}
          </a>
        );
      }
      if (/^https?:\/\//.test(token)) {
        const [cleanUrl, trailing] = splitTrailingPunctuation(token);
        return (
          <span key={key}>
            <a
              href={cleanUrl}
              target="_blank"
              rel="noreferrer"
              className="text-primary underline underline-offset-2"
            >
              {cleanUrl}
            </a>
            {trailing}
          </span>
        );
      }
      return <span key={key}>{token}</span>;
    });
  };

  return (
    <div className="space-y-2 break-words text-sm leading-relaxed">
      {blocks.map((block) =>
        block.type === "code" ? (
          <pre
            key={block.key}
            className="overflow-x-auto rounded-lg border border-border/60 bg-background/80 p-3 font-mono text-xs leading-relaxed"
          >
            <code>{block.content.replace(/\n$/, "")}</code>
          </pre>
        ) : (
          <div key={block.key} className="space-y-1 whitespace-pre-wrap">
            {block.content.split("\n").map((line, lineOffset, arr) => {
              const lineKey = `${block.key}-l${lineOffset}-${arr.length}`;
              return <div key={lineKey}>{line ? renderInline(line, lineKey) : "\u00A0"}</div>;
            })}
          </div>
        ),
      )}
    </div>
  );
}

const QUICK_COMMANDS = ["/status", "/skills", "/model"] as const;
const RECONNECT_BASE_MS = 1_500;
const RECONNECT_MAX_MS = 30_000;

/** Server rows can lack timestamps; they inherit the previous row's so local bubbles interleave stably. */
function mergeByTime(
  serverMessages: ReadonlyArray<PaMessage>,
  localMessages: ReadonlyArray<PaMessage>,
): ReadonlyArray<PaMessage> {
  if (localMessages.length === 0) return serverMessages;
  let carried = 0;
  const keyed = serverMessages.map((message) => {
    carried = message.timestamp ?? carried;
    return { message, key: carried };
  });
  for (const message of localMessages) {
    keyed.push({ message, key: message.timestamp ?? Number.MAX_SAFE_INTEGER });
  }
  return keyed.sort((a, b) => a.key - b.key).map((entry) => entry.message);
}

function clarifySelection(raw: string | undefined): ReadonlyArray<string> {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}
let localMessageSeq = 0;

function createLocalMessage(role: PaMessage["role"], text: string): PaMessage {
  localMessageSeq += 1;
  return {
    id: `local-${role}-${localMessageSeq}`,
    role,
    text,
    timestamp: Date.now(),
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

function normalizeApprovalDecision(id: string): "once" | "session" | "always" | "deny" {
  const lower = id.toLowerCase();
  if (lower === "deny" || lower === "reject" || lower === "cancel") return "deny";
  if (lower === "always") return "always";
  if (lower === "session") return "session";
  return "once";
}

interface StreamTool {
  readonly key: string;
  readonly name: string;
  readonly status: string;
}

interface DeltaCursor {
  turnId: string | null;
  segment: number;
  offset: number;
}

export function BotChatPane({
  bot,
  selectedSessionId,
  onSelectSession,
  onBackMobile,
  onOpenSettings,
  onActivity,
}: {
  readonly bot: PaBotSummary;
  readonly selectedSessionId: string | null;
  readonly onSelectSession: (sessionId: string) => void;
  readonly onBackMobile?: () => void;
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
  const [slashCommands, setSlashCommands] = useState<ReadonlyArray<PaSlashCommand>>([]);

  const [streamState, setStreamState] = useState<{
    readonly sessionId: string | null;
    readonly running: boolean;
    readonly text: string;
    readonly reasoning: string;
    readonly tools: ReadonlyArray<StreamTool>;
    readonly openRequests: ReadonlyArray<PaPendingRequest>;
    readonly error: string | null;
  }>({
    sessionId: null,
    running: false,
    text: "",
    reasoning: "",
    tools: [],
    openRequests: [],
    error: null,
  });

  const activeSessionIdRef = useRef<string | null>(activeSessionId);

  const messages = messagesState.sessionId === activeSessionId ? messagesState.items : [];
  const loadingMessages = activeSessionId !== null && loadingMessagesFor === activeSessionId;
  const isCurrentStream = streamState.sessionId === activeSessionId;
  const running = isCurrentStream ? streamState.running : false;
  const streamText = isCurrentStream ? streamState.text : "";
  const streamReasoning = isCurrentStream ? streamState.reasoning : "";
  const activeTools = isCurrentStream ? streamState.tools : [];
  const openRequests = isCurrentStream ? streamState.openRequests : [];
  const streamError = isCurrentStream ? streamState.error : null;

  // Async work for a session the user already left must never overwrite the visible one.
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

  const patchStream = useStableCallback(
    (
      sessionId: string | null,
      updater: (prev: {
        readonly running: boolean;
        readonly text: string;
        readonly reasoning: string;
        readonly tools: ReadonlyArray<StreamTool>;
        readonly openRequests: ReadonlyArray<PaPendingRequest>;
        readonly error: string | null;
      }) => Partial<{
        readonly running: boolean;
        readonly text: string;
        readonly reasoning: string;
        readonly tools: ReadonlyArray<StreamTool>;
        readonly openRequests: ReadonlyArray<PaPendingRequest>;
        readonly error: string | null;
      }>,
    ) => {
      if (activeSessionIdRef.current !== sessionId) return;
      setStreamState((prev) => {
        const base =
          prev.sessionId === sessionId
            ? prev
            : {
                sessionId,
                running: false,
                text: "",
                reasoning: "",
                tools: [] as ReadonlyArray<StreamTool>,
                openRequests: [] as ReadonlyArray<PaPendingRequest>,
                error: null as string | null,
              };
        return {
          ...base,
          ...updater(base),
          sessionId,
        };
      });
    },
  );

  const [clarifyInputs, setClarifyInputs] = useState<Record<string, string>>({});
  const [clarifyAnswers, setClarifyAnswers] = useState<Record<string, Record<string, string>>>({});
  const [respondingIds, setRespondingIds] = useState<ReadonlySet<string>>(() => new Set());

  const seqCursorRef = useRef<PaSeqCursor>({ epoch: undefined, lastSeq: 0 });
  // Bumped on every message.complete so a late send ack cannot flip a finished turn back to running.
  const completedTurnsRef = useRef(0);
  const deltaCursorRef = useRef<DeltaCursor>({ turnId: null, segment: 0, offset: 0 });
  const transcriptRequestRef = useRef<{ id: number; controller: AbortController | null }>({
    id: 0,
    controller: null,
  });
  const failedSendRef = useRef<{ text: string; inputId: string } | null>(null);

  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [slashIndex, setSlashIndex] = useState(0);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const isNearBottomRef = useRef<boolean>(true);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const getSelectedSessionProp = useStableCallback(() => selectedSessionId);
  const stableSelectSession = useStableCallback(onSelectSession);
  const stableOnActivity = useStableCallback(onActivity);
  const stableBotUnread = useStableCallback(() => bot.unread);

  const loadTranscript = useStableCallback((sessionId: string, showSpinner: boolean) => {
    transcriptRequestRef.current.controller?.abort();
    const controller = new AbortController();
    const reqId = transcriptRequestRef.current.id + 1;
    transcriptRequestRef.current = { id: reqId, controller };

    if (showSpinner) {
      setLoadingMessagesFor(sessionId);
    }

    return paApi
      .getMessages(bot.id, sessionId, controller.signal)
      .then((loaded) => {
        if (
          controller.signal.aborted ||
          transcriptRequestRef.current.id !== reqId ||
          activeSessionIdRef.current !== sessionId
        ) {
          return;
        }
        setSessionMessages(sessionId, loaded);
      })
      .catch((err) => {
        if (
          !controller.signal.aborted &&
          transcriptRequestRef.current.id === reqId &&
          activeSessionIdRef.current === sessionId
        ) {
          patchStream(sessionId, () => ({
            error: err instanceof Error ? err.message : gt("加载消息失败"),
          }));
        }
      })
      .finally(() => {
        if (transcriptRequestRef.current.id === reqId) {
          setLoadingMessagesFor((cur) => (cur === sessionId ? null : cur));
        }
      });
  });

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

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads this Bot's sessions and native slash catalog once per Bot mount, and marks unread bots read
  useEffect(() => {
    const controller = new AbortController();
    Promise.all([
      paApi.listSessions(bot.id, controller.signal),
      paApi.listSlashCommands(bot.id, controller.signal).catch(() => [] as PaSlashCommand[]),
    ])
      .then(async ([sessionRes, cmds]) => {
        if (controller.signal.aborted) return;
        setSlashCommands(cmds);
        setSessions(sessionRes.sessions);

        const initialProp = getSelectedSessionProp();
        let targetId =
          initialProp && sessionRes.sessions.some((s) => s.sessionId === initialProp)
            ? initialProp
            : sessionRes.primarySessionId;

        if (!targetId) {
          const created = await paApi.ensurePrimarySession(bot.id);
          if (controller.signal.aborted) return;
          targetId = created.sessionId;
          setSessions((prev) => [created, ...prev]);
        }

        activeSessionIdRef.current = targetId;
        setFallbackSessionId(targetId);
        if (targetId !== initialProp) {
          stableSelectSession(targetId);
        }
        if (stableBotUnread()) {
          void paApi
            .markRead(bot.id)
            .then(() => stableOnActivity())
            .catch(() => undefined);
        }
      })
      .catch((err) => {
        if (!controller.signal.aborted) {
          patchStream(activeSessionIdRef.current, () => ({
            error: err instanceof Error ? err.message : gt("连接 Bot 会话失败"),
          }));
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoadingSessions(false);
      });

    return () => controller.abort();
  }, [
    bot.id,
    gt,
    getSelectedSessionProp,
    patchStream,
    stableSelectSession,
    stableBotUnread,
    stableOnActivity,
  ]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- fetches stored transcript and resets per-session replay refs whenever the active PA session changes
  useEffect(() => {
    activeSessionIdRef.current = activeSessionId;
    if (!activeSessionId) return;

    seqCursorRef.current = { epoch: undefined, lastSeq: 0 };
    deltaCursorRef.current = { turnId: null, segment: 0, offset: 0 };
    isNearBottomRef.current = true;

    void loadTranscript(activeSessionId, true);

    return () => {
      transcriptRequestRef.current.controller?.abort();
    };
  }, [activeSessionId, loadTranscript]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to the SSE live stream and auto-recovers after browser background/offline transitions
  useEffect(() => {
    if (!activeSessionId) return;
    const sessionId = activeSessionId;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let wakeDebounceTimer: ReturnType<typeof setTimeout> | null = null;
    let unsubscribeCurrent: (() => void) | null = null;
    let closed = false;
    let reconnectAttempts = 0;

    const appendLocalMessage = (msg: PaMessage) => {
      setLocalBySession((prev) => ({
        ...prev,
        [sessionId]: [...(prev[sessionId] ?? []), msg],
      }));
    };

    const handleEvent = (event: PaStreamEvent) => {
      if (closed || activeSessionIdRef.current !== sessionId) return;

      if (event.type === "snapshot") {
        reconnectAttempts = 0;
        // The server reports the baseline its replay starts from (our own cursor on a replay), so
        // adopt it as-is: advancing past it would drop every replayed frame.
        seqCursorRef.current = { epoch: event.replayEpoch, lastSeq: event.lastSeq };
        if (event.snapshotRequired) {
          deltaCursorRef.current = { turnId: null, segment: 0, offset: 0 };
          patchStream(sessionId, () => ({
            running: event.running,
            text: "",
            reasoning: "",
            tools: [],
            openRequests: event.openRequests,
            error: null,
          }));
          void loadTranscript(sessionId, false);
        } else {
          patchStream(sessionId, () => ({
            running: event.running,
            openRequests: event.openRequests,
            error: null,
          }));
        }
        return;
      }

      if ("seq" in event && !acceptPaSeq(seqCursorRef.current, event.seq, event.replayEpoch)) {
        return;
      }

      switch (event.type) {
        case "message.start":
          deltaCursorRef.current = {
            turnId: event.turnId ?? null,
            segment: 0,
            offset: 0,
          };
          patchStream(sessionId, () => ({
            running: true,
            text: "",
            reasoning: "",
            tools: [],
            error: null,
          }));
          break;
        case "message.delta": {
          const cursor = deltaCursorRef.current;
          const nextTurnId = event.turnId ?? cursor.turnId;
          const isNewTurn =
            event.turnId !== undefined && cursor.turnId !== null && event.turnId !== cursor.turnId;
          if (isNewTurn) {
            deltaCursorRef.current = {
              turnId: event.turnId,
              segment: event.segment ?? 0,
              offset:
                event.offset !== undefined ? event.offset + event.text.length : event.text.length,
            };
            patchStream(sessionId, () => ({ running: true, text: event.text }));
            break;
          }

          if (event.offset !== undefined) {
            const segment = event.segment ?? 0;
            if (segment !== cursor.segment) {
              deltaCursorRef.current = {
                turnId: nextTurnId,
                segment,
                offset: event.offset + event.text.length,
              };
              patchStream(sessionId, (prev) => ({ running: true, text: prev.text + event.text }));
              break;
            }
            const endOffset = event.offset + event.text.length;
            if (endOffset <= cursor.offset) {
              break;
            }
            const sliceFrom = event.offset < cursor.offset ? cursor.offset - event.offset : 0;
            const nonOverlapping = sliceFrom > 0 ? event.text.slice(sliceFrom) : event.text;
            deltaCursorRef.current = {
              turnId: nextTurnId,
              segment,
              offset: endOffset,
            };
            if (nonOverlapping) {
              patchStream(sessionId, (prev) => ({
                running: true,
                text: prev.text + nonOverlapping,
              }));
            }
          } else {
            deltaCursorRef.current = {
              turnId: nextTurnId,
              segment: cursor.segment,
              offset: cursor.offset + event.text.length,
            };
            patchStream(sessionId, (prev) => ({ running: true, text: prev.text + event.text }));
          }
          break;
        }
        case "message.interim":
          if (!event.alreadyStreamed && event.text) {
            patchStream(sessionId, (prev) => ({
              text: prev.text ? `${prev.text}\n\n${event.text}` : event.text,
            }));
          }
          break;
        case "reasoning.delta":
          patchStream(sessionId, (prev) => ({ reasoning: prev.reasoning + event.text }));
          break;
        case "tool.progress": {
          // Concurrent calls of one tool share a name; only the call id tells them apart.
          const key = event.toolId ?? event.toolName;
          patchStream(sessionId, (prev) => ({
            tools: [
              ...prev.tools.filter((item) => item.key !== key),
              { key, name: event.toolName, status: event.status },
            ],
          }));
          break;
        }
        case "message.complete":
          completedTurnsRef.current += 1;
          deltaCursorRef.current = { turnId: null, segment: 0, offset: 0 };
          patchStream(sessionId, (prev) => ({
            running: false,
            text: "",
            reasoning: "",
            tools: [],
            error: event.status === "error" && event.error ? event.error : prev.error,
          }));
          void loadTranscript(sessionId, false);
          void paApi
            .markRead(bot.id)
            .catch(() => undefined)
            .finally(() => stableOnActivity());
          break;
        case "request.open":
          patchStream(sessionId, (prev) => ({
            openRequests: [
              ...prev.openRequests.filter((r) => r.requestId !== event.request.requestId),
              event.request,
            ],
          }));
          break;
        case "request.cancel":
          patchStream(sessionId, (prev) => ({
            openRequests: prev.openRequests.filter((r) => r.requestId !== event.requestId),
          }));
          break;
        case "notice":
          if (event.message) {
            appendLocalMessage(createLocalMessage("system", event.message));
          }
          break;
        case "error":
          patchStream(sessionId, () => ({ error: event.message, running: false }));
          break;
      }
    };

    const connect = () => {
      if (closed) return;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      unsubscribeCurrent?.();
      const cursor = seqCursorRef.current;
      unsubscribeCurrent = paApi.subscribeSessionEvents(bot.id, sessionId, {
        sinceSeq: cursor.lastSeq > 0 ? cursor.lastSeq : undefined,
        replayEpoch: cursor.epoch,
        onEvent: handleEvent,
        onDisconnect: (error) => {
          if (closed) return;
          if (reconnectTimer) clearTimeout(reconnectTimer);
          if (isTerminalPaError(error)) {
            patchStream(sessionId, () => ({ running: false, error: error?.message ?? null }));
            return;
          }
          // A hidden tab reconnects from the visibility handler instead of polling in the background.
          if (document.visibilityState === "hidden") return;
          const delay = Math.min(RECONNECT_BASE_MS * 2 ** reconnectAttempts, RECONNECT_MAX_MS);
          reconnectAttempts += 1;
          reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            connect();
          }, delay);
        },
      });
    };

    connect();

    const handleVisibilityOrOnline = () => {
      if (document.visibilityState !== "visible") return;
      if (wakeDebounceTimer) clearTimeout(wakeDebounceTimer);
      wakeDebounceTimer = setTimeout(() => {
        wakeDebounceTimer = null;
        if (closed || activeSessionIdRef.current !== sessionId) return;
        reconnectAttempts = 0;
        void loadTranscript(sessionId, false);
        connect();
      }, 250);
    };
    document.addEventListener("visibilitychange", handleVisibilityOrOnline);
    window.addEventListener("online", handleVisibilityOrOnline);

    return () => {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (wakeDebounceTimer) clearTimeout(wakeDebounceTimer);
      unsubscribeCurrent?.();
      document.removeEventListener("visibilitychange", handleVisibilityOrOnline);
      window.removeEventListener("online", handleVisibilityOrOnline);
    };
  }, [bot.id, activeSessionId, loadTranscript, patchStream, stableOnActivity]);

  const localMessages = activeSessionId ? (localBySession[activeSessionId] ?? []) : [];
  const mergedMessages = mergeByTime(messages, localMessages);

  const scrollTargetCount = mergedMessages.length + streamText.length + openRequests.length;
  const isStreaming = running || streamText.length > 0;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keeps the message viewport anchored to bottom when user has not scrolled up
  useEffect(() => {
    if (scrollTargetCount > 0 && isNearBottomRef.current) {
      bottomRef.current?.scrollIntoView({
        behavior: isStreaming ? "auto" : "smooth",
        block: "end",
      });
    }
  }, [scrollTargetCount, isStreaming]);

  const handleViewportScroll = () => {
    const el = scrollContainerRef.current;
    if (!el) return;
    isNearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  };

  const slashQuery =
    draft.startsWith("/") && !draft.includes(" ") && !draft.includes("\n")
      ? draft.toLowerCase()
      : null;

  const matchingCommands =
    slashQuery === null
      ? []
      : slashCommands
          .filter(
            (cmd) =>
              cmd.name.toLowerCase().includes(slashQuery.slice(1)) ||
              cmd.description.toLowerCase().includes(slashQuery.slice(1)),
          )
          .slice(0, 10);

  const clampedSlashIndex =
    matchingCommands.length === 0 ? 0 : Math.min(slashIndex, matchingCommands.length - 1);

  const activeSession = sessions.find((s) => s.sessionId === activeSessionId) ?? null;

  const switchSession = (nextSessionId: string) => {
    setSessionsOpen(false);
    if (nextSessionId === activeSessionId) return;
    activeSessionIdRef.current = nextSessionId;
    setFallbackSessionId(nextSessionId);
    onSelectSession(nextSessionId);
  };

  const handleCreateNewSession = async () => {
    setSessionsOpen(false);
    try {
      const created = await paApi.createSession(bot.id, true);
      setSessions((prev) => [created, ...prev.map((s) => ({ ...s, isPrimaryWeb: false }))]);
      activeSessionIdRef.current = created.sessionId;
      setFallbackSessionId(created.sessionId);
      onSelectSession(created.sessionId);
    } catch (err) {
      patchStream(activeSessionId, () => ({
        error: err instanceof Error ? err.message : gt("新建对话失败"),
      }));
    }
  };

  const handleSend = async (rawOverride?: string) => {
    const text = (rawOverride ?? draft).trim();
    const sessionId = activeSessionId;
    if (!text || !sessionId || sending) return;
    setSending(true);
    patchStream(sessionId, () => ({ error: null }));
    if (rawOverride === undefined) setDraft("");
    isNearBottomRef.current = true;

    const inputId =
      failedSendRef.current && failedSendRef.current.text === text
        ? failedSendRef.current.inputId
        : makeInputId();

    const optimisticMsg = createLocalMessage("user", text);
    setSessionMessages(sessionId, (prev) => [...prev, optimisticMsg]);
    const completedBeforeSend = completedTurnsRef.current;

    try {
      const res = await paApi.sendMessage(bot.id, sessionId, text, inputId);
      failedSendRef.current = null;
      if (res.kind === "slash") {
        // Move the slash command + its local output into per-session local messages so background transcript refreshes don't wipe them.
        setSessionMessages(sessionId, (prev) => prev.filter((m) => m.id !== optimisticMsg.id));
        const outputMsg = createLocalMessage(
          "system",
          res.output || res.notice || gt("命令已执行"),
        );
        setLocalBySession((prev) => ({
          ...prev,
          [sessionId]: [...(prev[sessionId] ?? []), optimisticMsg, outputMsg],
        }));
        onActivity();
      } else if (completedTurnsRef.current === completedBeforeSend) {
        patchStream(sessionId, () => ({ running: true }));
      }
    } catch (err) {
      // Roll back the failed optimistic bubble and preserve inputId for idempotent retry.
      failedSendRef.current = { text, inputId };
      setSessionMessages(sessionId, (prev) => prev.filter((m) => m.id !== optimisticMsg.id));
      if (rawOverride === undefined && activeSessionIdRef.current === sessionId) {
        setDraft((current) => (current ? current : text));
      }
      patchStream(sessionId, () => ({
        error: err instanceof Error ? err.message : gt("发送失败"),
      }));
    } finally {
      setSending(false);
    }
  };

  const handleInterrupt = async () => {
    if (!activeSessionId) return;
    const sessionId = activeSessionId;
    try {
      await paApi.interruptSession(bot.id, sessionId);
      patchStream(sessionId, () => ({ running: false }));
    } catch (err) {
      patchStream(sessionId, () => ({
        error: err instanceof Error ? err.message : gt("停止失败"),
      }));
    }
  };

  const handleRespondRequest = async (
    req: PaPendingRequest,
    decision?: "once" | "session" | "always" | "deny",
  ) => {
    if (!activeSessionId || respondingIds.has(req.requestId)) return;
    const sessionId = activeSessionId;
    const perQuestion = clarifyAnswers[req.requestId];
    const hasQuestions = (req.questions?.length ?? 0) > 0;
    const firstQuestionId = req.questions?.[0]?.id;
    const primaryAnswer = hasQuestions
      ? firstQuestionId
        ? (perQuestion?.[firstQuestionId] ?? "")
        : ""
      : (clarifyInputs[req.requestId] ?? "");
    setRespondingIds((prev) => new Set(prev).add(req.requestId));
    try {
      await paApi.respondRequest(bot.id, sessionId, {
        requestId: req.requestId,
        kind: req.kind,
        channel: req.channel,
        ...(req.executionGeneration !== undefined
          ? { executionGeneration: req.executionGeneration }
          : {}),
        ...(decision ? { decision } : {}),
        ...(req.kind === "clarify" ? { answer: primaryAnswer } : {}),
        ...(req.kind === "clarify" && hasQuestions && perQuestion ? { answers: perQuestion } : {}),
      });
      patchStream(sessionId, (prev) => ({
        openRequests: prev.openRequests.filter((item) => item.requestId !== req.requestId),
      }));
    } catch (err) {
      patchStream(sessionId, () => ({
        error: err instanceof Error ? err.message : gt("响应请求失败"),
      }));
    } finally {
      setRespondingIds((prev) => {
        const next = new Set(prev);
        next.delete(req.requestId);
        return next;
      });
    }
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (matchingCommands.length > 0) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setSlashIndex((i) => (i + 1) % matchingCommands.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setSlashIndex((i) => (i - 1 + matchingCommands.length) % matchingCommands.length);
        return;
      }
      if (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey)) {
        const picked = matchingCommands[clampedSlashIndex];
        if (picked && draft !== picked.name) {
          event.preventDefault();
          setDraft(`${picked.name} `);
          return;
        }
      }
    }

    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      // The Stop button replaces Send while a turn runs; Enter must not queue a second turn.
      if (!running) void handleSend();
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      <header
        className="flex min-h-14 shrink-0 items-center justify-between gap-2 border-b border-border/60 px-3 sm:px-4"
        style={{
          paddingTop: "env(safe-area-inset-top)",
          minHeight: "calc(3.5rem + env(safe-area-inset-top))",
        }}
      >
        <div className="flex min-w-0 items-center gap-2.5">
          {onBackMobile ? (
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="size-8 shrink-0 lg:hidden"
              aria-label={gt("返回 Bot 列表")}
              onClick={onBackMobile}
            >
              <ArrowLeftIcon className="size-4" />
            </Button>
          ) : null}

          <BotAvatar color={bot.avatarColor} shape={bot.avatarShape} size="sm" running={running} />
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="truncate font-semibold text-sm">{bot.name}</span>
              <Badge variant="secondary" size="sm" className="hidden sm:inline-flex">
                {bot.adapter}
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
                {running
                  ? gt("思考中...")
                  : bot.model || gt("profile: {profile}", { profile: bot.profile })}
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
                      ? activeSession.isPrimaryWeb
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
                <span className="font-medium text-xs text-muted-foreground">
                  <T>切换对话记录（含飞书/TG/定时）</T>
                </span>
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  onClick={() => void handleCreateNewSession()}
                >
                  <MessageSquarePlusIcon className="size-3" />
                  <T>新对话</T>
                </Button>
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
                      <span className="truncate font-medium text-xs">{item.title}</span>
                      <Badge variant="outline" size="sm" className="shrink-0">
                        {item.isPrimaryWeb ? gt("主对话") : formatSourceLabel(item.source)}
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
      </header>

      <div
        ref={scrollContainerRef}
        onScroll={handleViewportScroll}
        className="scrollbar-gutter-both min-h-0 flex-1 overflow-y-auto px-3 py-4 sm:px-6"
      >
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
          {loadingSessions || loadingMessages ? (
            <div className="flex items-center justify-center py-12 text-muted-foreground text-sm">
              <Loader2Icon className="mr-2 size-4 animate-spin" />
              <T>正在加载对话...</T>
            </div>
          ) : null}

          {!loadingSessions && !loadingMessages && mergedMessages.length === 0 && !streamText ? (
            <div className="flex flex-col items-center justify-center gap-3 py-14 text-center">
              <BotAvatar
                color={bot.avatarColor}
                shape={bot.avatarShape}
                size="lg"
                starred={bot.isDefault}
              />
              <div className="space-y-1">
                <div className="font-semibold text-base">{bot.name}</div>
                <p className="max-w-xs text-muted-foreground text-xs">
                  {bot.description || gt("直接开始聊天，或输入 / 调用 Hermes 原生斜杠命令。")}
                </p>
              </div>
              <div className="flex flex-wrap justify-center gap-1.5 pt-1">
                {QUICK_COMMANDS.map((cmd) => (
                  <button
                    key={cmd}
                    type="button"
                    // `/model` needs an interactive picker; the settings sheet is that picker here.
                    onClick={() => (cmd === "/model" ? onOpenSettings() : void handleSend(cmd))}
                    className="rounded-full border border-border/70 bg-muted/40 px-3 py-1 font-mono text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  >
                    {cmd}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          {mergedMessages.map((msg) => {
            if (msg.role === "user") {
              return (
                <div key={msg.id} className="flex justify-end">
                  <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-primary px-3.5 py-2.5 text-primary-foreground shadow-xs">
                    <div className="whitespace-pre-wrap break-words text-sm leading-relaxed">
                      {msg.text}
                    </div>
                  </div>
                </div>
              );
            }

            if (msg.role === "system") {
              return (
                <div
                  key={msg.id}
                  className="rounded-xl border border-border/60 bg-muted/40 px-3.5 py-2.5"
                >
                  <div className="mb-1 flex items-center gap-1.5 font-medium text-2xs text-muted-foreground">
                    <TerminalIcon className="size-3" />
                    <span>
                      {msg.rowKind === "compaction" ? gt("上下文摘要") : gt("Hermes 命令输出")}
                    </span>
                  </div>
                  <PaMarkdownText text={msg.text} />
                </div>
              );
            }

            if (msg.role === "tool") {
              return (
                <div
                  key={msg.id}
                  className="flex items-center gap-2 rounded-lg border border-border/40 bg-muted/25 px-3 py-1.5 text-xs text-muted-foreground"
                >
                  <WrenchIcon className="size-3.5 shrink-0" />
                  <span className="truncate font-mono">{msg.toolName || "tool"}</span>
                  {msg.text ? (
                    <span className="truncate opacity-75">{msg.text.slice(0, 80)}</span>
                  ) : null}
                </div>
              );
            }

            return (
              <div key={msg.id} className="flex items-start gap-2.5">
                <BotAvatar
                  color={bot.avatarColor}
                  shape={bot.avatarShape}
                  size="sm"
                  className="mt-0.5 size-7"
                />
                <div className="min-w-0 flex-1 space-y-1.5">
                  {msg.reasoning ? (
                    <details className="rounded-lg border border-border/50 bg-muted/30 px-3 py-1.5 text-xs text-muted-foreground">
                      <summary className="cursor-pointer select-none font-medium">
                        <T>思考过程</T>
                      </summary>
                      <div className="mt-1.5 whitespace-pre-wrap text-2xs leading-relaxed">
                        {msg.reasoning}
                      </div>
                    </details>
                  ) : null}
                  {msg.text ? (
                    <div className="rounded-2xl rounded-tl-sm border border-border/60 bg-card px-3.5 py-2.5">
                      <PaMarkdownText text={msg.text} />
                    </div>
                  ) : null}
                  {msg.timestamp ? (
                    <div className="px-1 text-3xs text-muted-foreground">
                      {formatMessageTime(msg.timestamp)}
                    </div>
                  ) : null}
                </div>
              </div>
            );
          })}

          {running || streamText || streamReasoning || activeTools.length > 0 ? (
            <div className="flex items-start gap-2.5">
              <BotAvatar
                color={bot.avatarColor}
                shape={bot.avatarShape}
                size="sm"
                running={running}
                className="mt-0.5 size-7"
              />
              <div className="min-w-0 flex-1 space-y-2">
                {streamReasoning ? (
                  <div className="rounded-lg border border-border/50 bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                    <div className="mb-1 font-medium">
                      <T>思考中...</T>
                    </div>
                    <div className="whitespace-pre-wrap text-2xs leading-relaxed">
                      {streamReasoning}
                    </div>
                  </div>
                ) : null}
                {activeTools.length > 0 ? (
                  <div className="flex flex-wrap gap-1.5">
                    {activeTools.map((tool) => (
                      <Badge key={tool.key} variant="secondary" size="sm">
                        <WrenchIcon className="size-3" />
                        <span>
                          {tool.name} ({tool.status})
                        </span>
                      </Badge>
                    ))}
                  </div>
                ) : null}
                <div className="rounded-2xl rounded-tl-sm border border-border/60 bg-card px-3.5 py-2.5">
                  {streamText ? (
                    <PaMarkdownText text={streamText} />
                  ) : (
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <Loader2Icon className="size-3.5 animate-spin" />
                      <span>
                        <T>
                          <Var>{bot.name}</Var> 正在处理...
                        </T>
                      </span>
                    </div>
                  )}
                </div>
              </div>
            </div>
          ) : null}

          {openRequests.map((req) => {
            const responding = respondingIds.has(req.requestId);
            return (
              <div
                key={req.requestId}
                className="space-y-2.5 rounded-xl border border-warning/40 bg-warning-surface p-3.5"
              >
                <div className="flex items-center gap-2 font-medium text-sm text-warning-foreground">
                  <ShieldAlertIcon className="size-4" />
                  <span>
                    {req.title ||
                      (req.kind === "approval" ? gt("需要确认执行") : gt("Bot 需要你补充信息"))}
                  </span>
                </div>
                {req.detail ? (
                  <p className="whitespace-pre-wrap text-xs text-foreground">{req.detail}</p>
                ) : null}
                {req.command ? (
                  <pre className="overflow-x-auto rounded-md bg-background/80 p-2 font-mono text-xs">
                    {req.command}
                  </pre>
                ) : null}
                {req.kind === "approval" ? (
                  <div className="flex flex-wrap gap-2">
                    {req.options && req.options.length > 0 ? (
                      req.options.map((opt, idx) => {
                        const decision = normalizeApprovalDecision(opt.id);
                        return (
                          <Button
                            key={opt.id}
                            type="button"
                            size="sm"
                            variant={
                              decision === "deny" ? "outline" : idx === 0 ? "default" : "secondary"
                            }
                            disabled={responding}
                            onClick={() => void handleRespondRequest(req, decision)}
                          >
                            {opt.label}
                          </Button>
                        );
                      })
                    ) : (
                      <>
                        <Button
                          type="button"
                          size="sm"
                          disabled={responding}
                          onClick={() => void handleRespondRequest(req, "once")}
                        >
                          <T>允许一次</T>
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="secondary"
                          disabled={responding}
                          onClick={() => void handleRespondRequest(req, "session")}
                        >
                          <T>本次会话允许</T>
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={responding}
                          onClick={() => void handleRespondRequest(req, "deny")}
                        >
                          <T>拒绝</T>
                        </Button>
                      </>
                    )}
                  </div>
                ) : req.questions && req.questions.length > 0 ? (
                  <div className="space-y-3">
                    {req.questions.map((question) => {
                      const currentVal = clarifyAnswers[req.requestId]?.[question.id] ?? "";
                      // Multi-select answers travel as a JSON array of labels (Hermes's own encoding).
                      const selected = question.multiSelect ? clarifySelection(currentVal) : [];
                      const isPicked = (opt: string) =>
                        question.multiSelect ? selected.includes(opt) : currentVal === opt;
                      const pick = (opt: string) =>
                        question.multiSelect
                          ? JSON.stringify(
                              selected.includes(opt)
                                ? selected.filter((item) => item !== opt)
                                : [...selected, opt],
                            )
                          : opt;
                      return (
                        <div key={question.id} className="space-y-1.5">
                          <div className="font-medium text-xs text-foreground">
                            {question.prompt}
                          </div>
                          {question.options && question.options.length > 0 ? (
                            <div className="flex flex-wrap gap-1.5">
                              {question.options.map((opt) => (
                                <button
                                  key={opt}
                                  type="button"
                                  aria-pressed={isPicked(opt)}
                                  onClick={() =>
                                    setClarifyAnswers((prev) => ({
                                      ...prev,
                                      [req.requestId]: {
                                        ...prev[req.requestId],
                                        [question.id]: pick(opt),
                                      },
                                    }))
                                  }
                                  className={cn(
                                    "rounded-full border px-2.5 py-1 text-xs transition-colors",
                                    isPicked(opt)
                                      ? "border-primary bg-primary/15 text-foreground"
                                      : "border-border/70 bg-background/70 text-muted-foreground hover:text-foreground",
                                  )}
                                >
                                  {opt}
                                </button>
                              ))}
                            </div>
                          ) : null}
                          {question.multiSelect ? null : (
                            <Input
                              placeholder={gt("输入你的回复...")}
                              value={currentVal}
                              onChange={(e) =>
                                setClarifyAnswers((prev) => ({
                                  ...prev,
                                  [req.requestId]: {
                                    ...prev[req.requestId],
                                    [question.id]: e.target.value,
                                  },
                                }))
                              }
                            />
                          )}
                        </div>
                      );
                    })}
                    <div className="flex justify-end">
                      <Button
                        type="button"
                        size="sm"
                        disabled={responding}
                        onClick={() => void handleRespondRequest(req)}
                      >
                        <T>提交</T>
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="flex gap-2">
                    <Input
                      placeholder={gt("输入你的回复...")}
                      value={clarifyInputs[req.requestId] ?? ""}
                      onChange={(e) =>
                        setClarifyInputs((prev) => ({ ...prev, [req.requestId]: e.target.value }))
                      }
                    />
                    <Button
                      type="button"
                      size="sm"
                      disabled={responding}
                      onClick={() => void handleRespondRequest(req)}
                    >
                      <T>提交</T>
                    </Button>
                  </div>
                )}
              </div>
            );
          })}

          {streamError ? (
            <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-destructive text-xs">
              {streamError}
            </div>
          ) : null}

          <div ref={bottomRef} />
        </div>
      </div>

      <div
        className="relative shrink-0 border-t border-border/60 bg-background/95 px-3 pt-2.5 sm:px-6"
        style={{ paddingBottom: "max(0.75rem, env(safe-area-inset-bottom))" }}
      >
        <div className="relative mx-auto w-full max-w-2xl">
          {matchingCommands.length > 0 ? (
            <div className="absolute right-0 bottom-full left-0 z-20 mb-2 max-h-60 overflow-y-auto rounded-xl border border-border bg-popover p-1.5 shadow-lg">
              <div className="flex items-center gap-1.5 px-2 py-1 font-medium text-2xs text-muted-foreground">
                <SlashIcon className="size-3" />
                <span>
                  <T>Hermes 原生命令与技能（点击或按 Tab 补全）</T>
                </span>
              </div>
              {matchingCommands.map((cmd, idx) => (
                <button
                  key={cmd.name}
                  type="button"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    setDraft(`${cmd.name} `);
                    textareaRef.current?.focus();
                  }}
                  className={cn(
                    "flex w-full items-center justify-between gap-3 rounded-lg px-2.5 py-1.5 text-left text-xs transition-colors",
                    idx === clampedSlashIndex
                      ? "bg-accent text-accent-foreground"
                      : "hover:bg-muted/60",
                  )}
                >
                  <span className="shrink-0 font-mono font-medium">{cmd.name}</span>
                  <span className="truncate text-2xs text-muted-foreground">{cmd.description}</span>
                </button>
              ))}
            </div>
          ) : null}

          <div className="flex items-end gap-2 rounded-2xl border border-border/70 bg-muted/35 px-3 py-2 focus-within:border-primary/60">
            <textarea
              ref={textareaRef}
              rows={1}
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value);
                setSlashIndex(0);
              }}
              onKeyDown={handleKeyDown}
              placeholder={gt("发消息给 {name}，或输入 / 执行命令...", { name: bot.name })}
              className="max-h-36 min-h-6 flex-1 resize-none bg-transparent text-sm leading-6 outline-none placeholder:text-muted-foreground"
            />
            {running ? (
              <Button
                type="button"
                size="icon"
                variant="destructive"
                className="size-8 shrink-0"
                aria-label={gt("停止生成")}
                onClick={() => void handleInterrupt()}
              >
                <SquareIcon className="size-3.5 fill-current" />
              </Button>
            ) : (
              <Button
                type="button"
                size="icon"
                className="size-8 shrink-0"
                aria-label={gt("发送")}
                disabled={!draft.trim() || sending || !activeSessionId}
                onClick={() => void handleSend()}
              >
                {sending ? (
                  <Loader2Icon className="size-4 animate-spin" />
                ) : (
                  <SendHorizontalIcon className="size-4" />
                )}
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
