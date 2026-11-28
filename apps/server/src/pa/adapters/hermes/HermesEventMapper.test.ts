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
    mapper,
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
  it("keeps a transport replay cursor out of the reply identity", () => {
    const { map } = makeMapper();
    expect(map("message.complete", { text: "done" }, { replay_epoch: "ep", seq: 70 })).toEqual([
      { type: "turn.completed", sessionId: "s-1", status: "complete", text: "done" },
    ]);
  });

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
    expect(map("session.info", { model: "gpt-5.4", reasoning_effort: "xhigh" })).toEqual([
      {
        type: "session.updated",
        sessionId: "s-1",
        model: "gpt-5.4",
        reasoningEffort: "xhigh",
      },
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

describe("HermesEventMapper queue, usage and todos", () => {
  it("does not end the streaming turn when a queued admission is cancelled or steered", () => {
    const { map, turnBoundaries } = makeMapper();
    map("message.start", { turn_id: "t1" }, { admission_id: "adm-run" });
    map("message.delta", { text: "Working", offset: 0 }, { admission_id: "adm-run" });
    const boundaries = turnBoundaries();
    // `_settle_cancelled`: stamped with the cancelled row's own id, an `outcome` and no `status`.
    expect(
      map(
        "message.complete",
        { text: "", content: "", admission_id: "adm-queued", outcome: "cancelled" },
        { admission_id: "adm-queued" },
      ),
    ).toEqual([]);
    expect(turnBoundaries()).toBe(boundaries);
    expect(texts(map("message.delta", { text: " on", offset: 7 }))).toEqual([
      ["answer", " on", "t1:0"],
    ]);
    expect(
      map(
        "message.complete",
        { text: "Working on", status: "complete", admission_id: "adm-run" },
        { admission_id: "adm-run" },
      ),
    ).toEqual([
      {
        type: "turn.completed",
        sessionId: "s-1",
        status: "complete",
        text: "Working on",
        replyId: "admission:adm-run",
        replyAliases: ["turn:t1"],
      },
    ]);
  });

  it("settles an interruption without a known active admission, except for an identified queue item", () => {
    const { mapper, map } = makeMapper();
    mapper.adoptBaseline({ pending: [{ admission_id: "queued", status: "queued" }] });
    expect(map("message.complete", { outcome: "cancelled", admission_id: "queued" })).toEqual([]);
    for (const payload of [{ admission_id: "running" }, {}]) {
      map("message.start");
      expect(map("message.complete", { outcome: "cancelled", ...payload })).toMatchObject([
        { type: "turn.completed", status: "interrupted" },
      ]);
    }
  });

  it("knows the running admission from a resume baseline when it missed message.start", () => {
    const { mapper, map } = makeMapper();
    mapper.adoptBaseline({
      pending: [
        { admission_id: "adm-run", status: "started" },
        { admission_id: "adm-q", status: "queued", text: "later", controls: ["steer"] },
      ],
    });
    expect(map("message.complete", { status: "interrupted" }, { admission_id: "adm-q" })).toEqual(
      [],
    );
    // The baseline already reported this queue: an identical session.info adds nothing.
    expect(
      map("session.info", {
        pending: [
          { admission_id: "adm-run", status: "started" },
          { admission_id: "adm-q", status: "queued", text: "later", controls: ["steer"] },
        ],
      }),
    ).toEqual([]);
    expect(
      map("message.complete", { text: "Done", status: "complete" }, { admission_id: "adm-run" }),
    ).toMatchObject([{ type: "turn.completed", status: "complete" }]);
  });

  it("reports queue changes from session.info and keeps its execution generation", () => {
    const { map, generation } = makeMapper();
    const pending = [
      { admission_id: "adm-run", status: "started" },
      { admission_id: "adm-q", status: "queued", text: "later", controls: ["steer"] },
    ];
    expect(map("session.info", { pending, execution_generation: 9, running: true })).toEqual([
      {
        type: "queue.updated",
        sessionId: "s-1",
        items: [{ id: "adm-q", text: "later", status: "queued", canSteer: true }],
      },
    ]);
    expect(generation()).toBe(9);
    expect(map("session.info", { pending, running: true })).toEqual([]);
    expect(map("session.info", { pending: [pending[0]] })).toEqual([
      { type: "queue.updated", sessionId: "s-1", items: [] },
    ]);
  });

  it("maps usage ticks and the turn's final usage to context occupancy", () => {
    const { map } = makeMapper();
    expect(
      map("session.usage", {
        usage: { input: 1_000, total: 1_200, context_used: 800, context_max: 8_000 },
        total_tokens: 1_200,
      }),
    ).toEqual([
      {
        type: "usage.updated",
        sessionId: "s-1",
        usage: {
          contextUsed: 800,
          contextMax: 8_000,
          contextPercent: 10,
          inputTokens: 1_000,
          totalTokens: 1_200,
        },
      },
    ]);
    map("message.start", {}, { admission_id: "adm-run" });
    const done = map(
      "message.complete",
      {
        text: "ok",
        status: "complete",
        usage: { input: 2_000, total: 2_400, context_used: 1_600, context_max: 8_000 },
      },
      { admission_id: "adm-run" },
    );
    expect(done.map((event) => event.type)).toEqual(["usage.updated", "turn.completed"]);
    expect(done[0]).toMatchObject({ usage: { contextUsed: 1_600, contextPercent: 20 } });
  });

  it("replaces todos only with a revision at least as new", () => {
    const { mapper, map } = makeMapper();
    mapper.adoptBaseline({ todoRevision: 2 });
    expect(
      map("todo.updated", { revision: 1, todos: [{ id: "1", content: "old", status: "pending" }] }),
    ).toEqual([]);
    expect(
      map("todo.updated", {
        revision: 3,
        todos: [{ id: "1", content: "Plan", status: "in_progress" }],
      }),
    ).toEqual([
      {
        type: "todos.updated",
        sessionId: "s-1",
        todos: { revision: 3, items: [{ id: "1", text: "Plan", status: "in_progress" }] },
      },
    ]);
    expect(map("todo.updated", { revision: 4, todos: [] })).toEqual([
      { type: "todos.updated", sessionId: "s-1", todos: { revision: 4, items: [] } },
    ]);
  });
});

it("deduplicates usage and settles a known running admission even without a status", () => {
  const { map } = makeMapper();
  const usage = { context_used: 9, context_max: 10, total: 12 };
  expect(map("session.info", { usage })).toHaveLength(1);
  expect(map("session.usage", { usage })).toEqual([]);
  map("session.info", { pending: [{ admission_id: "old", status: "started" }] });
  map("session.info", { pending: [{ admission_id: "new", status: "started" }] });
  map("message.start");
  expect(map("message.complete", { outcome: "cancelled" }, { admission_id: "old" })).toEqual([]);
  expect(map("message.complete", { outcome: "cancelled", usage }, { admission_id: "new" })).toEqual(
    [expect.objectContaining({ type: "turn.completed" })],
  );
});
