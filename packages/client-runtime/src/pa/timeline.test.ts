import type { PaMessage, PaStreamEvent } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildPaTimelineItems,
  clearSettledPaLiveTurn,
  createInitialPaLiveTurn,
  findActivePaToolAction,
  findPaLiveFinalTextIndex,
  formatPaDurationMs,
  mergePaMessagesByTime,
  paNoticeMessage,
  reducePaStreamEvent,
  summarizePaWorkGroup,
} from "./timeline.ts";

type EventInput = PaStreamEvent extends infer E
  ? E extends PaStreamEvent
    ? Omit<E, "sessionId" | "resumeToken">
    : never
  : never;

const msg = (partial: Partial<PaMessage> & Pick<PaMessage, "id" | "role">): PaMessage => ({
  text: "",
  timestamp: null,
  rowKind: "message",
  ...partial,
});

const ev = (event: EventInput, index = 0) =>
  ({ ...event, sessionId: "s1", resumeToken: `e:${index}` }) as PaStreamEvent;

function reduceAll(events: ReadonlyArray<EventInput>, from = createInitialPaLiveTurn("s1")) {
  return events.reduce(
    (state, event, index) => reducePaStreamEvent(state, ev(event, index), 1000 + index),
    from,
  );
}

describe("PA timeline items", () => {
  it("groups tool rows and reasoning into one work-group before the reply", () => {
    const items = buildPaTimelineItems([
      msg({ id: "m1", role: "user", text: "weather?", timestamp: 1000 }),
      msg({
        id: "m2",
        role: "tool",
        text: "Sunny 24C",
        toolName: "web_search",
        toolCategory: "web-search",
        toolContext: "Beijing weather",
        timestamp: 1100,
      }),
      msg({
        id: "m3",
        role: "assistant",
        text: "Sunny.",
        reasoning: "Look it up.",
        timestamp: 1200,
      }),
    ]);
    expect(items.map((item) => item.kind)).toEqual(["user", "work-group", "assistant"]);
    const group = items[1]!;
    expect(group.kind === "work-group" && summarizePaWorkGroup(group.steps)).toEqual({
      kind: "tool",
      afterReasoning: true,
      hasFailure: false,
      action: {
        category: "web-search",
        toolName: "web_search",
        phase: "done",
        target: "Beijing weather",
      },
    });
    expect(items[2]?.kind === "assistant" && items[2].isLatestAssistant).toBe(true);
  });

  it("marks text before a tool step, or flagged by the engine, as commentary", () => {
    const items = buildPaTimelineItems([
      msg({ id: "u1", role: "user", text: "check" }),
      msg({ id: "a1", role: "assistant", text: "Looking." }),
      msg({ id: "t1", role: "tool", text: "clean", toolName: "terminal" }),
      msg({ id: "a2", role: "assistant", text: "Clean." }),
      msg({ id: "u2", role: "user", text: "branch?" }),
      msg({ id: "a3", role: "assistant", text: "Narration", commentary: true }),
      msg({ id: "a4", role: "assistant", text: "main." }),
    ]);
    expect(
      items.flatMap((item) =>
        item.kind === "assistant" ? [[item.id, item.isCommentary, item.isLatestAssistant]] : [],
      ),
    ).toEqual([
      ["a1", true, false],
      ["a2", false, false],
      ["a3", true, false],
      ["a4", false, true],
    ]);
  });

  it("summarizes several tools by count and the last tool's category", () => {
    const items = buildPaTimelineItems([
      msg({ id: "t1", role: "tool", toolName: "read_file", toolCategory: "file-read" }),
      msg({
        id: "t2",
        role: "tool",
        toolName: "terminal",
        toolCategory: "terminal",
        toolFailed: true,
      }),
    ]);
    const group = items[0]!;
    expect(group.kind === "work-group" && summarizePaWorkGroup(group.steps)).toEqual({
      kind: "tools",
      count: 2,
      lastCategory: "terminal",
      afterReasoning: false,
      hasFailure: true,
    });
  });

  it("interleaves local rows by time and keys notices by their send", () => {
    const merged = mergePaMessagesByTime(
      [msg({ id: "a", role: "user", timestamp: 10 }), msg({ id: "b", role: "assistant" })],
      [paNoticeMessage({ message: "ok", inputId: "in-1" }, 5)],
    );
    expect(merged.map((m) => m.id)).toEqual(["notice-in-1", "a", "b"]);
    expect(formatPaDurationMs(350)).toBe("350ms");
    expect(formatPaDurationMs(2450)).toBe("2.5s");
  });
});

describe("PA live turn reducer", () => {
  it("interleaves reasoning, tools and the answer, then settles without wiping content", () => {
    let state = reduceAll([
      { type: "turn.started", turnId: "t1" },
      { type: "reasoning.delta", text: "Let me check." },
      { type: "status.updated", text: "Waiting for tool..." },
      {
        type: "tool.updated",
        toolId: "tc-1",
        toolName: "terminal",
        toolCategory: "terminal",
        status: "started",
        preview: "git status",
      },
    ]);
    expect(state.statusText).toBe("Waiting for tool...");
    expect(findActivePaToolAction(state)).toMatchObject({ phase: "active", target: "git status" });
    state = reduceAll(
      [
        {
          type: "tool.updated",
          toolId: "tc-1",
          toolName: "terminal",
          toolCategory: "terminal",
          status: "completed",
          result: "nothing to commit",
          durationMs: 420,
        },
        { type: "text.delta", text: "Clean.", role: "answer", segmentId: "t1:1" },
      ],
      state,
    );
    expect(state.phase).toBe("running");
    expect(state.statusText).toBeNull();
    expect(state.blocks.map((b) => b.kind)).toEqual(["work-group", "text"]);
    const group = state.blocks[0]!;
    expect(group.kind === "work-group" && group.steps.map((s) => [s.kind, s.text])).toEqual([
      ["reasoning", "Let me check."],
      ["tool", "nothing to commit"],
    ]);

    state = reduceAll([{ type: "turn.completed", status: "complete", text: "Clean." }], state);
    expect(state.phase).toBe("settling");
    expect(state.blocks).toHaveLength(2);
    expect(state.blocks[1]?.kind === "text" && state.blocks[1].streaming).toBe(false);
    expect(clearSettledPaLiveTurn(state, state.settleToken).blocks).toEqual([]);
    expect(clearSettledPaLiveTurn(state, state.settleToken + 1)).toBe(state);
  });

  it("reclassifies a streamed segment as commentary and starts the answer in a new bubble", () => {
    const streamed = reduceAll([
      { type: "turn.started", turnId: "t1" },
      { type: "text.delta", text: "I'll look.", role: "answer", segmentId: "t1:0" },
      { type: "text.delta", text: "", role: "commentary", segmentId: "t1:0" },
      {
        type: "tool.updated",
        toolId: "c1",
        toolName: "terminal",
        toolCategory: "terminal",
        status: "completed",
      },
    ]);
    expect(streamed.blocks[0]).toMatchObject({ kind: "text", commentary: true, streaming: false });
    expect(findPaLiveFinalTextIndex(streamed.blocks)).toBe(-1);

    const replied = reduceAll(
      [
        { type: "text.delta", text: "Done.", role: "answer", segmentId: "t1:0~1" },
        { type: "turn.completed", status: "complete", text: "Done." },
      ],
      streamed,
    );
    expect(replied.blocks.map((b) => b.kind)).toEqual(["text", "work-group", "text"]);
    expect(findPaLiveFinalTextIndex(replied.blocks)).toBe(2);
  });

  it("never merges answer text into narration, and adds an unstreamed final reply", () => {
    const state = reduceAll([
      { type: "turn.started" },
      { type: "text.delta", text: "Working on it.", role: "commentary", segmentId: "i-1" },
      { type: "text.delta", text: "All done.", role: "answer", segmentId: "t:0" },
    ]);
    expect(state.blocks.map((b) => b.kind === "text" && b.text)).toEqual([
      "Working on it.",
      "All done.",
    ]);
    expect(findPaLiveFinalTextIndex(state.blocks)).toBe(1);

    const toolOnly = reduceAll([
      { type: "turn.started" },
      { type: "text.delta", text: "Running.", role: "answer" },
      {
        type: "tool.updated",
        toolId: "c1",
        toolName: "terminal",
        toolCategory: "terminal",
        status: "completed",
      },
      { type: "turn.completed", status: "complete", text: "All tests pass." },
    ]);
    expect(toolOnly.blocks.map((b) => b.kind)).toEqual(["text", "work-group", "text"]);
    expect(findPaLiveFinalTextIndex(toolOnly.blocks)).toBe(2);
  });

  it("starts a new bubble when a segment reappears after a tool step", () => {
    const state = reduceAll([
      { type: "text.delta", text: "A", role: "answer", segmentId: "s" },
      {
        type: "tool.updated",
        toolId: "c1",
        toolName: "x",
        toolCategory: "other",
        status: "completed",
      },
      { type: "text.delta", text: "B", role: "answer", segmentId: "s" },
    ]);
    expect(state.blocks.map((b) => (b.kind === "text" ? b.text : b.kind))).toEqual([
      "A",
      "work-group",
      "B",
    ]);
  });

  it("tracks open requests and resets live blocks when the server asks for a reload", () => {
    const request = { requestId: "r1", kind: "approval" as const, title: "t", detail: "d" };
    let state = reduceAll([
      { type: "turn.started" },
      { type: "text.delta", text: "x", role: "answer" },
      { type: "request.opened", request },
    ]);
    expect(state.openRequests).toEqual([request]);
    state = reduceAll([{ type: "request.resolved", requestId: "r1" }], state);
    expect(state.openRequests).toEqual([]);
    state = reduceAll(
      [{ type: "snapshot", running: false, openRequests: [request], snapshotRequired: true }],
      state,
    );
    expect(state).toMatchObject({ phase: "idle", blocks: [], openRequests: [request] });
  });

  it("shows transient notices as status and leaves persistent ones to the timeline", () => {
    const state = reduceAll([{ type: "notice", message: "Compressing context" }]);
    expect(state.statusText).toBe("Compressing context");
    expect(reduceAll([{ type: "notice", message: "Saved", persistent: true }], state)).toBe(state);
    expect(reduceAll([{ type: "error", message: "boom" }]).error).toBe("boom");
  });
});
