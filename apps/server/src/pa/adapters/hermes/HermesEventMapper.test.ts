import { describe, expect, it } from "vite-plus/test";

import type { PaAdapterEvent } from "../../types.ts";
import { acceptHermesSeq, HermesEventMapper } from "./HermesEventMapper.ts";
import type { HermesTrackedRequest } from "./HermesNormalizers.ts";

function makeMapper() {
  const opened: HermesTrackedRequest[] = [];
  const resolved: string[] = [];
  let turnBoundaries = 0;
  let generation = 3;
  const mapper = new HermesEventMapper("s-1", {
    currentGeneration: () => generation,
    onGeneration: (next) => {
      generation = next;
    },
    onRequestOpened: (tracked) => opened.push(tracked),
    onRequestResolved: (id) => resolved.push(id),
    onTurnBoundary: () => {
      turnBoundaries += 1;
    },
  });
  const map = (event: string, payload: Record<string, unknown> = {}, extra = {}) =>
    mapper.map({ event, session_id: "s-1", payload, ...extra });
  return {
    map,
    opened,
    resolved,
    generation: () => generation,
    turnBoundaries: () => turnBoundaries,
  };
}

const texts = (events: ReadonlyArray<PaAdapterEvent>) =>
  events.flatMap((e) => (e.type === "text.delta" ? [[e.role, e.text, e.segmentId]] : []));

describe("acceptHermesSeq", () => {
  it("drops repeats within an epoch and restarts numbering on a new one", () => {
    const cursor = { epoch: undefined as string | undefined, lastSeq: 0 };
    expect(acceptHermesSeq(cursor, 5, "ep-A")).toBe(true);
    expect(acceptHermesSeq(cursor, 6, "ep-A")).toBe(true);
    expect(acceptHermesSeq(cursor, 6, "ep-A")).toBe(false);
    expect(acceptHermesSeq(cursor, 1, "ep-B")).toBe(true);
    expect(acceptHermesSeq(cursor, 1, "ep-B")).toBe(false);
    expect(acceptHermesSeq(cursor, undefined, undefined)).toBe(true);
  });
});

describe("HermesEventMapper", () => {
  it("dedupes overlapping delta ranges into one answer segment", () => {
    const { map } = makeMapper();
    const events = [
      ...map("message.start", { turn_id: "t1" }),
      ...map("message.delta", { text: "Hel", offset: 0 }),
      ...map("message.delta", { text: "Hello", offset: 0 }),
      ...map("message.delta", { text: "lo", offset: 3 }),
      ...map("message.delta", { text: " world", offset: 5 }),
    ];
    expect(events[0]).toEqual({ type: "turn.started", sessionId: "s-1", turnId: "t1" });
    expect(texts(events)).toEqual([
      ["answer", "Hel", "t1:0"],
      ["answer", "lo", "t1:0"],
      ["answer", " world", "t1:0"],
    ]);
  });

  it("reclassifies streamed text as commentary and opens a new bubble after it", () => {
    const { map } = makeMapper();
    const events = [
      ...map("message.start", { turn_id: "t1" }),
      ...map("message.delta", { text: "Let me look.", offset: 0 }),
      ...map("message.interim", { text: "Let me look.", already_streamed: true }),
      ...map("message.delta", { text: " Done.", offset: 12 }),
      ...map("message.interim", { text: "Checking tests" }),
    ];
    expect(texts(events)).toEqual([
      ["answer", "Let me look.", "t1:0"],
      ["commentary", "", "t1:0"],
      ["answer", " Done.", "t1:0~1"],
      ["commentary", "Checking tests", "interim-1-1"],
    ]);
  });

  it("keeps reasoning, transient status and tool progress distinct", () => {
    const { map } = makeMapper();
    expect([
      ...map("reasoning.delta", { text: "step 1" }),
      ...map("reasoning.available", { text: "step 1 summary" }),
      ...map("thinking.delta", { text: "waiting on API" }),
      ...map("thinking.delta", { text: "" }),
      ...map("tool.complete", {
        tool_call_id: "c2",
        tool_name: "terminal",
        context: "git status",
        args: { command: "git status" },
        result: "clean",
        duration_s: 0.42,
      }),
    ]).toEqual([
      { type: "reasoning.delta", sessionId: "s-1", text: "step 1" },
      { type: "status.updated", sessionId: "s-1", text: "waiting on API" },
      { type: "status.updated", sessionId: "s-1", text: null },
      {
        type: "tool.updated",
        sessionId: "s-1",
        toolId: "c2",
        toolName: "terminal",
        toolCategory: "terminal",
        status: "completed",
        preview: "git status",
        args: { command: "git status" },
        result: "clean",
        durationMs: 420,
      },
    ]);
    // Only used when nothing streamed for the turn.
    const fresh = makeMapper();
    expect(fresh.map("reasoning.available", { text: "full trace" })).toEqual([
      { type: "reasoning.delta", sessionId: "s-1", text: "full trace" },
    ]);
  });

  it("tracks canonical prompts, their resolution and the execution generation", () => {
    const { map, opened, resolved, generation } = makeMapper();
    map("message.start", {}, { execution_generation: 7 });
    expect(generation()).toBe(7);
    const events = [
      ...map("clarify.request", {
        prompt_id: "clr-1",
        question: "Deploy where?",
        choices: ["staging", "prod"],
        multi_select: true,
      }),
      ...map("approval.settled", { request_ids: ["clr-1", "apr-2"] }),
    ];
    expect(opened[0]).toMatchObject({ channel: "canonical", executionGeneration: 7 });
    expect(events.map((e) => e.type)).toEqual([
      "request.opened",
      "request.resolved",
      "request.resolved",
    ]);
    expect(resolved).toEqual(["clr-1", "apr-2"]);
  });

  it("ends a turn and starts the next segment numbering fresh", () => {
    const { map } = makeMapper();
    map("message.delta", { text: "One", offset: 0 });
    expect(map("message.complete", { text: "One", status: "interrupted" })).toEqual([
      { type: "turn.completed", sessionId: "s-1", status: "interrupted", text: "One" },
    ]);
    expect(texts(map("message.delta", { text: "Two", offset: 0 }))).toEqual([
      ["answer", "Two", "turn-1:0"],
    ]);
    expect(map("notice", { message: "Saved" })).toEqual([
      { type: "notice", sessionId: "s-1", message: "Saved", persistent: true },
    ]);
  });
});

describe("HermesEventMapper turn boundaries", () => {
  it("forgets streamed reasoning and commentary when a turn completes", () => {
    const { map } = makeMapper();
    map("message.start", { turn_id: "t1" });
    map("reasoning.delta", { text: "thinking" });
    map("message.delta", { text: "Looking", offset: 0, turn_id: "t1" });
    map("message.interim", { text: "Looking", already_streamed: true });
    map("message.complete", { text: "Done" });

    // The next turn starts without `message.start`: its own trace must still show.
    expect(map("reasoning.available", { text: "next trace" })).toEqual([
      { type: "reasoning.delta", sessionId: "s-1", text: "next trace" },
    ]);
    const answer = texts(map("message.delta", { text: "Answer", offset: 0, turn_id: "t2" }));
    expect(answer).toEqual([["answer", "Answer", "t2:0"]]);
  });

  it("resets offset, segment, reasoning and commentary after an error frame", () => {
    const { map, turnBoundaries } = makeMapper();
    map("message.start", { turn_id: "t1" });
    map("reasoning.delta", { text: "thinking" });
    map("message.delta", { text: "Partial answer", offset: 0, turn_id: "t1" });
    map("message.interim", { text: "Partial answer", already_streamed: true });
    expect(map("error", { message: "boom" })).toEqual([
      { type: "error", sessionId: "s-1", message: "boom" },
    ]);
    expect(turnBoundaries()).toBe(2);

    // Without `message.start`, the next turn's offset-0 text is new, in a fresh answer segment.
    expect(map("reasoning.available", { text: "next trace" })).toEqual([
      { type: "reasoning.delta", sessionId: "s-1", text: "next trace" },
    ]);
    expect(texts(map("message.delta", { text: "Fresh", offset: 0 }))).toEqual([
      ["answer", "Fresh", "turn-2:0"],
    ]);
  });
});
