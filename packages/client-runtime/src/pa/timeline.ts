import type {
  PaMessage,
  PaPendingRequest,
  PaStreamEvent,
  PaToolCategory,
} from "@t3tools/contracts";

export type PaToolStatus = "started" | "progress" | "completed" | "failed";

export interface PaWorkStep {
  readonly id: string;
  readonly kind: "reasoning" | "tool";
  readonly text: string;
  readonly toolName?: string | undefined;
  readonly toolCategory?: PaToolCategory | undefined;
  readonly toolStatus?: PaToolStatus | undefined;
  readonly toolPreview?: string | undefined;
  readonly toolArgs?: Record<string, unknown> | undefined;
  readonly toolResult?: string | undefined;
  readonly durationMs?: number | undefined;
  readonly timestamp?: number | null | undefined;
  readonly streaming?: boolean | undefined;
}

export type PaTimelineItem =
  | { readonly kind: "user"; readonly id: string; readonly message: PaMessage }
  | {
      readonly kind: "work-group";
      readonly id: string;
      readonly steps: ReadonlyArray<PaWorkStep>;
      readonly timestamp: number | null;
      readonly hasFailure: boolean;
    }
  | {
      readonly kind: "assistant";
      readonly id: string;
      readonly message: PaMessage;
      readonly isLatestAssistant: boolean;
      /** Text published before a tool step or a later reply in the same turn: no copy/meta chrome. */
      readonly isCommentary: boolean;
    }
  | { readonly kind: "compaction"; readonly id: string; readonly message: PaMessage }
  | { readonly kind: "system-output"; readonly id: string; readonly message: PaMessage };

export type PaLiveBlock =
  | { readonly kind: "work-group"; readonly id: string; readonly steps: ReadonlyArray<PaWorkStep> }
  | {
      readonly kind: "text";
      readonly id: string;
      /** The engine's id for this run of text; a later delta with it extends or reclassifies it. */
      readonly segmentId?: string | undefined;
      readonly text: string;
      readonly streaming: boolean;
      /** Narration rather than the answer; later answer text never merges into it. */
      readonly commentary?: boolean | undefined;
    };

export interface PaLiveTurnState {
  readonly sessionId: string | null;
  readonly phase: "idle" | "running" | "settling";
  readonly startedAt: number | null;
  readonly settleToken: number;
  readonly statusText: string | null;
  readonly blocks: ReadonlyArray<PaLiveBlock>;
  readonly openRequests: ReadonlyArray<PaPendingRequest>;
  readonly error: string | null;
  readonly nextBlockSeq: number;
}

export function createInitialPaLiveTurn(sessionId: string | null = null): PaLiveTurnState {
  return {
    sessionId,
    phase: "idle",
    startedAt: null,
    settleToken: 0,
    statusText: null,
    blocks: [],
    openRequests: [],
    error: null,
    nextBlockSeq: 0,
  };
}

/** Drops a settled turn's live blocks once the stored transcript that replaces them is shown. */
export function clearSettledPaLiveTurn(
  state: PaLiveTurnState,
  settleToken: number,
): PaLiveTurnState {
  if (state.phase !== "settling" || state.settleToken !== settleToken) return state;
  return {
    ...createInitialPaLiveTurn(state.sessionId),
    openRequests: state.openRequests,
    error: state.error,
    settleToken: state.settleToken,
  };
}

const TOOL_ARG_PREVIEW_KEYS = [
  "command",
  "cmd",
  "query",
  "pattern",
  "url",
  "path",
  "file_path",
  "filepath",
  "target",
  "goal",
  "task",
  "prompt",
  "name",
  "action",
  "question",
] as const;

function extractPaToolTarget(
  toolName: string,
  preview: string | undefined,
  args: Record<string, unknown> | undefined,
): string {
  const cleanedPreview = preview?.replace(/\s+/g, " ").trim();
  if (cleanedPreview) {
    // Engines often prefix the preview with the tool name already.
    const prefix = `${toolName.toLowerCase()}:`;
    if (cleanedPreview.toLowerCase().startsWith(prefix)) {
      const stripped = cleanedPreview.slice(prefix.length).trim();
      if (stripped) return stripped;
    }
    return cleanedPreview;
  }
  for (const key of TOOL_ARG_PREVIEW_KEYS) {
    const value = args?.[key];
    if (typeof value === "string" && value.trim().length > 0) {
      const oneLine = value.replace(/\s+/g, " ").trim();
      return oneLine.length > 100 ? `${oneLine.slice(0, 99)}…` : oneLine;
    }
  }
  return "";
}

/** What a tool step did, for a client to phrase in its own language. */
export interface PaToolAction {
  readonly category: PaToolCategory;
  readonly toolName: string;
  readonly phase: "active" | "done" | "failed";
  readonly target: string;
}

export function describePaToolAction(step: PaWorkStep): PaToolAction {
  const toolName = step.toolName ?? "tool";
  return {
    category: step.toolCategory ?? "other",
    toolName,
    phase:
      step.toolStatus === "failed"
        ? "failed"
        : step.toolStatus === "started" || step.toolStatus === "progress"
          ? "active"
          : "done",
    target: extractPaToolTarget(toolName, step.toolPreview, step.toolArgs),
  };
}

export type PaWorkGroupSummary =
  | { readonly kind: "reasoning"; readonly hasFailure: boolean }
  | {
      readonly kind: "tool";
      readonly action: PaToolAction;
      readonly afterReasoning: boolean;
      readonly hasFailure: boolean;
    }
  | {
      readonly kind: "tools";
      readonly count: number;
      readonly lastCategory: PaToolCategory;
      readonly afterReasoning: boolean;
      readonly hasFailure: boolean;
    };

export function summarizePaWorkGroup(steps: ReadonlyArray<PaWorkStep>): PaWorkGroupSummary {
  const tools = steps.filter((step) => step.kind === "tool");
  const afterReasoning = tools.length < steps.length;
  const hasFailure = tools.some((step) => step.toolStatus === "failed");
  const last = tools.at(-1);
  if (!last) return { kind: "reasoning", hasFailure };
  if (tools.length === 1) {
    return { kind: "tool", action: describePaToolAction(last), afterReasoning, hasFailure };
  }
  return {
    kind: "tools",
    count: tools.length,
    lastCategory: last.toolCategory ?? "other",
    afterReasoning,
    hasFailure,
  };
}

/** The tool a running turn is busy with, if its latest step is one. */
export function findActivePaToolAction(state: PaLiveTurnState): PaToolAction | null {
  const last = state.blocks.at(-1);
  if (last?.kind !== "work-group") return null;
  const active = last.steps.findLast(
    (step) =>
      step.kind === "tool" && (step.toolStatus === "started" || step.toolStatus === "progress"),
  );
  return active ? describePaToolAction(active) : null;
}

export function formatPaDurationMs(ms: number | undefined): string | null {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return null;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  const mins = Math.floor(seconds / 60);
  const rem = Math.round(seconds % 60);
  return `${mins}m ${rem}s`;
}

export function formatPaElapsedSeconds(startedAt: number, nowMs: number): string {
  const elapsedSec = Math.max(0, Math.floor((nowMs - startedAt) / 1000));
  const mins = Math.floor(elapsedSec / 60);
  const secs = elapsedSec % 60;
  if (mins === 0) return `${secs}s`;
  return `${mins}m ${secs.toString().padStart(2, "0")}s`;
}

export function formatPaToolInspectorContent(step: PaWorkStep): {
  readonly command: string | null;
  readonly argsJson: string | null;
  readonly output: string | null;
} {
  const args = step.toolArgs;
  let command: string | null = null;
  let argsJson: string | null = null;
  if (args && Object.keys(args).length > 0) {
    const rawCmd =
      typeof args.command === "string"
        ? args.command
        : typeof args.cmd === "string"
          ? args.cmd
          : null;
    if (rawCmd) command = rawCmd;
    if (!rawCmd || Object.keys(args).length > 1) {
      try {
        argsJson = JSON.stringify(args, null, 2);
      } catch {
        argsJson = null;
      }
    }
  }
  const rawOutput = (step.toolResult ?? step.text).trim();
  return { command, argsJson, output: rawOutput.length > 0 ? rawOutput : null };
}

/** Server rows can lack timestamps; they inherit the previous row's so local rows interleave stably. */
export function mergePaMessagesByTime(
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

/**
 * Projects stored messages into timeline items: consecutive tool rows and reasoning traces
 * coalesce into one collapsible work-group right above the reply they produced.
 */
export function buildPaTimelineItems(
  messages: ReadonlyArray<PaMessage>,
): ReadonlyArray<PaTimelineItem> {
  const items: PaTimelineItem[] = [];
  let pendingSteps: PaWorkStep[] = [];
  let pendingTs: number | null = null;

  const flushWorkGroup = () => {
    if (pendingSteps.length === 0) return;
    items.push({
      kind: "work-group",
      id: `work-${pendingSteps[0]!.id}`,
      steps: pendingSteps,
      timestamp: pendingTs,
      hasFailure: pendingSteps.some((step) => step.toolStatus === "failed"),
    });
    pendingSteps = [];
    pendingTs = null;
  };

  for (const message of messages) {
    if (message.role === "user") {
      flushWorkGroup();
      items.push({ kind: "user", id: message.id, message });
      continue;
    }
    if (message.role === "system") {
      flushWorkGroup();
      items.push({
        kind: message.rowKind === "compaction" ? "compaction" : "system-output",
        id: message.id,
        message,
      });
      continue;
    }
    if (message.role === "tool") {
      pendingSteps.push({
        id: message.toolCallId ? `${message.id}-${message.toolCallId}` : message.id,
        kind: "tool",
        text: message.text,
        toolName: message.toolName || "tool",
        toolCategory: message.toolCategory ?? "other",
        toolStatus: message.toolFailed ? "failed" : "completed",
        toolPreview: message.toolContext,
        toolArgs: message.toolArgs,
        toolResult: message.text || undefined,
        timestamp: message.timestamp,
      });
      if (message.timestamp !== null) pendingTs = message.timestamp;
      continue;
    }
    if (message.reasoning && message.reasoning.trim().length > 0) {
      pendingSteps.push({
        id: `${message.id}-reasoning`,
        kind: "reasoning",
        text: message.reasoning,
        timestamp: message.timestamp,
      });
      if (message.timestamp !== null) pendingTs = message.timestamp;
    }
    if (message.text.trim().length > 0) {
      flushWorkGroup();
      items.push({
        kind: "assistant",
        id: message.id,
        message,
        isLatestAssistant: false,
        isCommentary: false,
      });
    }
  }
  flushWorkGroup();

  // Only a turn's terminal reply gets copy/meta: walk each turn backwards; assistant text
  // followed by a tool step or by a later reply is commentary.
  let laterToolStep = false;
  let laterReply = false;
  let latestTurn = true;
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i]!;
    if (item.kind === "user") {
      laterToolStep = false;
      laterReply = false;
      latestTurn = false;
      continue;
    }
    if (item.kind === "work-group") {
      if (item.steps.some((step) => step.kind === "tool")) laterToolStep = true;
      continue;
    }
    if (item.kind !== "assistant") continue;
    const isCommentary = item.message.commentary === true || laterToolStep || laterReply;
    items[i] = { ...item, isCommentary, isLatestAssistant: latestTurn && !isCommentary };
    if (!isCommentary) laterReply = true;
  }
  return items;
}

/**
 * Index of the live turn's final reply text block, or -1 while the trailing text is still
 * commentary (narration, or text a tool step followed).
 */
export function findPaLiveFinalTextIndex(blocks: ReadonlyArray<PaLiveBlock>): number {
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    const block = blocks[i]!;
    if (block.kind === "work-group") {
      if (block.steps.some((step) => step.kind === "tool")) return -1;
      continue;
    }
    if (block.commentary) return -1;
    if (block.text.trim().length > 0) return i;
  }
  return -1;
}

function finalizeLiveBlocks(blocks: ReadonlyArray<PaLiveBlock>): ReadonlyArray<PaLiveBlock> {
  return blocks.map((block) => {
    if (block.kind === "text") return block.streaming ? { ...block, streaming: false } : block;
    return {
      ...block,
      steps: block.steps.map((step) => {
        if (step.kind === "reasoning") return step.streaming ? { ...step, streaming: false } : step;
        return step.toolStatus === "started" || step.toolStatus === "progress"
          ? { ...step, toolStatus: "completed" }
          : step;
      }),
    };
  });
}

function closeReasoning(steps: ReadonlyArray<PaWorkStep>): ReadonlyArray<PaWorkStep> {
  return steps.map((step) =>
    step.kind === "reasoning" && step.streaming ? { ...step, streaming: false } : step,
  );
}

function updateLiveWorkGroup(
  state: PaLiveTurnState,
  updater: (steps: ReadonlyArray<PaWorkStep>, nextId: () => string) => ReadonlyArray<PaWorkStep>,
): Pick<PaLiveTurnState, "blocks" | "nextBlockSeq"> {
  let seq = state.nextBlockSeq;
  const nextId = () => {
    seq += 1;
    return `live-${seq}`;
  };
  const blocks = [...state.blocks];
  const last = blocks.at(-1);
  if (last?.kind === "work-group") {
    blocks[blocks.length - 1] = { ...last, steps: updater(last.steps, nextId) };
    return { blocks, nextBlockSeq: seq };
  }
  if (last?.kind === "text" && last.streaming) {
    blocks[blocks.length - 1] = { ...last, streaming: false };
  }
  const groupId = nextId();
  const steps = updater([], nextId);
  if (steps.length > 0) blocks.push({ kind: "work-group", id: groupId, steps });
  return { blocks, nextBlockSeq: seq };
}

function applyTextDelta(
  state: PaLiveTurnState,
  event: Extract<PaStreamEvent, { type: "text.delta" }>,
): Pick<PaLiveTurnState, "blocks" | "nextBlockSeq"> {
  const commentary = event.role === "commentary";
  const blocks = state.blocks.map((block) =>
    block.kind === "work-group" ? { ...block, steps: closeReasoning(block.steps) } : block,
  );
  const lastIndex = blocks.length - 1;
  const segmentIndex =
    event.segmentId === undefined
      ? -1
      : blocks.findLastIndex(
          (block) => block.kind === "text" && block.segmentId === event.segmentId,
        );
  const segment = segmentIndex >= 0 ? blocks[segmentIndex] : undefined;
  if (segment?.kind === "text" && (commentary || segmentIndex === lastIndex)) {
    // A commentary delta may reclassify a segment that is no longer the last block.
    blocks[segmentIndex] = {
      ...segment,
      text: segment.text + event.text,
      streaming: !commentary && !segment.commentary,
      ...(commentary || segment.commentary ? { commentary: true } : {}),
    };
    return { blocks, nextBlockSeq: state.nextBlockSeq };
  }
  if (!event.text) return { blocks, nextBlockSeq: state.nextBlockSeq };
  const last = blocks[lastIndex];
  if (
    event.segmentId === undefined &&
    !commentary &&
    last?.kind === "text" &&
    last.segmentId === undefined &&
    !last.commentary
  ) {
    blocks[lastIndex] = { ...last, text: last.text + event.text, streaming: true };
    return { blocks, nextBlockSeq: state.nextBlockSeq };
  }
  if (last?.kind === "text" && last.streaming) blocks[lastIndex] = { ...last, streaming: false };
  const nextBlockSeq = state.nextBlockSeq + 1;
  blocks.push({
    kind: "text",
    id: `live-text-${nextBlockSeq}`,
    ...(event.segmentId !== undefined ? { segmentId: event.segmentId } : {}),
    text: event.text,
    streaming: !commentary,
    ...(commentary ? { commentary: true } : {}),
  });
  return { blocks, nextBlockSeq };
}

const running = (state: PaLiveTurnState, nowMs: number) => ({
  phase: "running" as const,
  startedAt: state.startedAt ?? nowMs,
});

export function reducePaStreamEvent(
  state: PaLiveTurnState,
  event: PaStreamEvent,
  nowMs: number,
): PaLiveTurnState {
  switch (event.type) {
    case "snapshot":
      if (event.snapshotRequired) {
        return {
          ...createInitialPaLiveTurn(state.sessionId),
          phase: event.running ? "running" : "idle",
          startedAt: event.running ? (state.startedAt ?? nowMs) : null,
          openRequests: event.openRequests,
        };
      }
      return {
        ...state,
        phase: event.running ? "running" : state.phase === "settling" ? "settling" : "idle",
        startedAt: event.running ? (state.startedAt ?? nowMs) : state.startedAt,
        openRequests: event.openRequests,
        error: null,
      };

    case "turn.started":
      return {
        ...state,
        phase: "running",
        startedAt: nowMs,
        statusText: null,
        blocks: [],
        error: null,
      };

    case "text.delta":
      return {
        ...state,
        ...running(state, nowMs),
        ...(event.role === "answer" && event.text ? { statusText: null } : {}),
        ...applyTextDelta(state, event),
      };

    case "reasoning.delta":
      return {
        ...state,
        ...running(state, nowMs),
        ...updateLiveWorkGroup(state, (steps, nextId) => {
          const last = steps.at(-1);
          if (last?.kind === "reasoning") {
            return [
              ...steps.slice(0, -1),
              { ...last, text: last.text + event.text, streaming: true },
            ];
          }
          return [
            ...steps,
            {
              id: nextId(),
              kind: "reasoning",
              text: event.text,
              streaming: true,
              timestamp: nowMs,
            },
          ];
        }),
      };

    case "status.updated":
      return {
        ...state,
        ...(state.phase === "idle" ? running(state, nowMs) : {}),
        statusText: event.text?.trim() || null,
      };

    case "tool.updated":
      return {
        ...state,
        ...running(state, nowMs),
        ...updateLiveWorkGroup(state, (steps) => {
          const normalized = closeReasoning(steps);
          const id = `tool:${event.toolId}`;
          const index = normalized.findIndex((step) => step.kind === "tool" && step.id === id);
          const existing = index >= 0 ? normalized[index] : undefined;
          const next: PaWorkStep = {
            id,
            kind: "tool",
            text: event.result ?? existing?.text ?? "",
            toolName: event.toolName,
            toolCategory: event.toolCategory,
            toolStatus: event.status,
            toolPreview: event.preview ?? existing?.toolPreview,
            toolArgs: event.args ?? existing?.toolArgs,
            toolResult: event.result ?? existing?.toolResult,
            durationMs: event.durationMs ?? existing?.durationMs,
            timestamp: existing?.timestamp ?? nowMs,
          };
          if (index < 0) return [...normalized, next];
          return normalized.map((step, i) => (i === index ? next : step));
        }),
      };

    case "turn.completed": {
      let blocks = finalizeLiveBlocks(state.blocks);
      let nextBlockSeq = state.nextBlockSeq;
      const finalText = event.text?.trim() ?? "";
      const alreadyShown = blocks.some(
        (block) => block.kind === "text" && block.text.trim() === finalText,
      );
      if (findPaLiveFinalTextIndex(blocks) < 0 && finalText.length > 0 && !alreadyShown) {
        nextBlockSeq += 1;
        blocks = [
          ...blocks,
          { kind: "text", id: `live-text-${nextBlockSeq}`, text: finalText, streaming: false },
        ];
      }
      return {
        ...state,
        phase: blocks.length > 0 ? "settling" : "idle",
        settleToken: state.settleToken + 1,
        statusText: null,
        blocks,
        nextBlockSeq,
        error: event.status === "error" && event.error ? event.error : state.error,
      };
    }

    case "request.opened":
      return {
        ...state,
        openRequests: [
          ...state.openRequests.filter((r) => r.requestId !== event.request.requestId),
          event.request,
        ],
      };

    case "request.resolved":
      return {
        ...state,
        openRequests: state.openRequests.filter((r) => r.requestId !== event.requestId),
      };

    case "error":
      return {
        ...state,
        phase: state.blocks.length > 0 ? "settling" : "idle",
        statusText: null,
        blocks: finalizeLiveBlocks(state.blocks),
        error: event.message,
      };

    case "notice":
      // A persistent notice is a timeline row (`paNoticeMessage`); a transient one is status.
      return event.persistent ? state : { ...state, statusText: event.message.trim() || null };

    case "session.updated":
      return state;
  }
}

/** The timeline row for output the engine does not store, keyed so its sender adds it once. */
export function paNoticeMessage(
  notice: { readonly message: string; readonly inputId?: string | undefined },
  nowMs: number,
): PaMessage {
  return {
    id: notice.inputId ? `notice-${notice.inputId}` : `notice-${nowMs}`,
    role: "system",
    text: notice.message,
    timestamp: nowMs,
    rowKind: "message",
  };
}
