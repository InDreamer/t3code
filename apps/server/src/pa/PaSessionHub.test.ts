import { PaError, type PaStreamEvent } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { PaSessionHub, type PaHubOptions } from "./PaSessionHub.ts";
import type { PaAdapterEvent, PaSessionSubscriber } from "./types.ts";

function manualTimers() {
  const pending = new Map<number, { run: () => void; ms: number }>();
  let next = 0;
  return {
    timers: {
      set: (run: () => void, ms: number) => {
        next += 1;
        pending.set(next, { run, ms });
        return next;
      },
      clear: (handle: unknown) => {
        pending.delete(handle as number);
      },
    },
    pendingDelays: () => Array.from(pending.values(), (t) => t.ms),
    fireAll: () => {
      const due = Array.from(pending.values());
      pending.clear();
      for (const timer of due) timer.run();
    },
  };
}

function makeHub(overrides?: Partial<PaHubOptions>) {
  const clock = manualTimers();
  const feeds: Array<{ subscriber: PaSessionSubscriber; resume: boolean; released: boolean }> = [];
  let failNext = 0;
  let disposed = false;
  const hub = new PaSessionHub(
    "s-1",
    async (subscriber, { resume }) => {
      if (failNext > 0) {
        failNext -= 1;
        throw new PaError({ reason: "Unavailable", message: "engine down" });
      }
      const feed = { subscriber, resume, released: false };
      feeds.push(feed);
      subscriber.onEvent({
        type: "snapshot",
        sessionId: "s-1",
        running: false,
        openRequests: [],
        snapshotRequired: false,
      });
      return () => {
        feed.released = true;
      };
    },
    {
      capacity: 3,
      lingerMs: 1_000,
      reconnectDelaysMs: [10, 20],
      timers: clock.timers,
      ...overrides,
    },
    () => {
      disposed = true;
    },
  );
  const emit = (event: PaAdapterEvent) => feeds.at(-1)!.subscriber.onEvent(event);
  const delta = (text: string): PaAdapterEvent => ({
    type: "text.delta",
    sessionId: "s-1",
    text,
    role: "answer",
  });
  return {
    hub,
    clock,
    feeds,
    emit,
    delta,
    failNextOpens: (count: number) => {
      failNext = count;
    },
    isDisposed: () => disposed,
  };
}

function listen() {
  const events: PaStreamEvent[] = [];
  const failures: PaError[] = [];
  return {
    events,
    failures,
    listener: {
      onEvent: (e: PaStreamEvent) => events.push(e),
      onFail: (e: PaError) => failures.push(e),
    },
  };
}

const flush = () => Promise.resolve().then(() => undefined);

describe("PaSessionHub", () => {
  it("shares one engine feed and stamps monotonic resume tokens", async () => {
    const { hub, feeds, emit, delta } = makeHub();
    const a = listen();
    const b = listen();
    await hub.attach(a.listener);
    await hub.attach(b.listener);
    expect(feeds).toHaveLength(1);
    emit({ type: "turn.started", sessionId: "s-1" });
    emit(delta("Hi"));
    expect(a.events.map((e) => e.type)).toEqual(["snapshot", "turn.started", "text.delta"]);
    expect(b.events.map((e) => e.resumeToken)).toEqual(a.events.map((e) => e.resumeToken));
    const [epoch, seq] = a.events[2]!.resumeToken.split(":");
    expect(a.events[1]!.resumeToken).toBe(`${epoch}:${Number(seq) - 1}`);
    expect(a.events[0]).toMatchObject({ type: "snapshot", snapshotRequired: false });
  });

  it("replays exactly what a reconnecting client missed, and asks for a reload outside the window", async () => {
    const { hub, emit, delta } = makeHub();
    const first = listen();
    const detach = await hub.attach(first.listener);
    emit(delta("a"));
    const cursor = first.events.at(-1)!.resumeToken;
    detach();
    emit(delta("b"));
    emit({ type: "turn.started", sessionId: "s-1" });

    const resumed = listen();
    await hub.attach(resumed.listener, cursor);
    expect(resumed.events[0]).toMatchObject({
      type: "snapshot",
      resumeToken: cursor,
      running: true,
      snapshotRequired: false,
    });
    expect(resumed.events.slice(1).map((e) => e.type)).toEqual(["text.delta", "turn.started"]);

    // Capacity 3: the oldest events fall out and an old token can no longer be served.
    emit(delta("c"));
    emit(delta("d"));
    emit(delta("e"));
    const stale = listen();
    await hub.attach(stale.listener, cursor);
    expect(stale.events).toEqual([
      expect.objectContaining({ type: "snapshot", snapshotRequired: true }),
    ]);
    const foreign = listen();
    await hub.attach(foreign.listener, "other-epoch:1");
    expect(foreign.events[0]).toMatchObject({ snapshotRequired: true });
    expect(foreign.events[0]!.resumeToken).toBe(resumed.events.at(-1)!.resumeToken);
  });

  it("delivers replay events before the authoritative snapshot when replayBeforeSnapshot is enabled", async () => {
    const { hub, emit, delta } = makeHub({ capacity: 8 });
    const first = listen();
    const detach = await hub.attach(first.listener);
    emit({ type: "turn.started", sessionId: "s-1" });
    const cursor = first.events.at(-1)!.resumeToken;
    detach();

    // While detached, turn 1 finished and turn 2 started streaming.
    emit({ type: "turn.completed", sessionId: "s-1", status: "complete", replyId: "r1" });
    emit({ type: "turn.started", sessionId: "s-1" });
    emit(delta("turn 2"));

    const resumed = listen();
    await hub.attach(resumed.listener, cursor, { replayBeforeSnapshot: true });
    expect(resumed.events.map((e) => e.type)).toEqual([
      "turn.completed",
      "turn.started",
      "text.delta",
      "snapshot",
    ]);
    expect(resumed.events.at(-1)).toMatchObject({
      type: "snapshot",
      running: true,
      snapshotRequired: false,
      resumeToken: resumed.events[2]!.resumeToken,
    });
  });

  it("keeps unknown admissions actionable during the idle linger", async () => {
    const { hub, emit, clock, isDisposed } = makeHub();
    const detach = await hub.attach(listen().listener);
    const unknown = { id: "lost", status: "unknown" as const, text: "retry?", canSteer: false };
    emit({
      type: "queue.updated",
      sessionId: "s-1",
      items: [unknown, { ...unknown, id: "next", status: "queued" }],
    });
    detach();
    hub.reconcileDetached("idle", true);
    expect(clock.pendingDelays()).toEqual([1000]);
    const viewer = listen();
    const leave = await hub.attach(viewer.listener);
    expect(viewer.events[0]).toMatchObject({ queuedItems: [unknown] });
    emit({ type: "queue.updated", sessionId: "s-1", items: [] });
    leave();
    clock.fireAll();
    expect(isDisposed()).toBe(true);
  });

  it("tracks running state and open requests for late joiners", async () => {
    const { hub, emit } = makeHub();
    await hub.attach(listen().listener);
    emit({ type: "turn.started", sessionId: "s-1" });
    emit({
      type: "request.opened",
      sessionId: "s-1",
      request: { requestId: "r1", kind: "approval", title: "t", detail: "d" },
    });
    const late = listen();
    await hub.attach(late.listener);
    expect(late.events[0]).toMatchObject({
      running: true,
      openRequests: [expect.objectContaining({ requestId: "r1" })],
    });
    emit({ type: "request.resolved", sessionId: "s-1", requestId: "r1" });
    emit({ type: "turn.completed", sessionId: "s-1", status: "complete" });
    const later = listen();
    await hub.attach(later.listener);
    expect(later.events[0]).toMatchObject({ running: false, openRequests: [] });
  });

  it("shows an admitted turn in the roster without replaying a start or reviving a completed turn", async () => {
    const { hub, emit } = makeHub();
    const viewer = listen();
    await hub.attach(viewer.listener);
    const before = hub.currentTurnRevision;
    hub.admittedTurn(before);
    expect(hub.isRunning).toBe(true);
    emit({ type: "turn.started", sessionId: "s-1" });
    emit({ type: "turn.completed", sessionId: "s-1", status: "complete" });
    hub.admittedTurn(before);
    expect(hub.isRunning).toBe(false);
    expect(viewer.events.map((event) => event.type)).toEqual([
      "snapshot",
      "turn.started",
      "turn.completed",
    ]);
  });

  it("publishes persistent notices for output the engine does not keep", async () => {
    const { hub } = makeHub();
    const a = listen();
    await hub.attach(a.listener);
    hub.publishNotice("Status: ok", "in-1");
    expect(a.events.at(-1)).toMatchObject({
      type: "notice",
      message: "Status: ok",
      persistent: true,
      inputId: "in-1",
    });
  });

  it("lingers after the last listener leaves, then releases the feed", async () => {
    const { hub, clock, feeds, isDisposed } = makeHub();
    const detach = await hub.attach(listen().listener);
    detach();
    expect(clock.pendingDelays()).toEqual([1_000]);
    await hub.attach(listen().listener);
    expect(clock.pendingDelays()).toEqual([]);
    expect(isDisposed()).toBe(false);

    const hub2 = makeHub();
    (await hub2.hub.attach(listen().listener))();
    hub2.clock.fireAll();
    expect(hub2.isDisposed()).toBe(true);
    expect(hub2.feeds[0]!.released).toBe(true);
    expect(feeds[0]!.released).toBe(false);
  });

  it("keeps a working feed after the last viewer leaves, then releases it after completion", async () => {
    const { hub, clock, emit, isDisposed } = makeHub();
    const detach = await hub.attach(listen().listener);
    emit({ type: "turn.started", sessionId: "s-1" });
    detach();
    clock.fireAll();
    expect(isDisposed()).toBe(false);
    emit({ type: "turn.completed", sessionId: "s-1", status: "complete" });
    expect(clock.pendingDelays()).toEqual([1000]);
    clock.fireAll();
    expect(isDisposed()).toBe(true);
  });

  it("reopens a dropped feed with resume, and fails listeners once retries run out", async () => {
    const { hub, clock, feeds, failNextOpens, isDisposed } = makeHub();
    const a = listen();
    await hub.attach(a.listener);
    feeds[0]!.subscriber.onClose("socket closed");
    expect(clock.pendingDelays()).toEqual([10]);
    clock.fireAll();
    await flush();
    await flush();
    expect(feeds).toHaveLength(2);
    expect(feeds[1]!.resume).toBe(true);
    // A resumed feed's snapshot reaches listeners: it may say a reload is needed.
    expect(a.events.at(-1)).toMatchObject({ type: "snapshot" });

    failNextOpens(2);
    feeds[1]!.subscriber.onClose("socket closed again");
    clock.fireAll();
    await flush();
    await flush();
    expect(clock.pendingDelays()).toEqual([20]);
    clock.fireAll();
    await flush();
    await flush();
    await flush();
    expect(a.failures).toEqual([
      expect.objectContaining({ reason: "Unavailable", message: "socket closed again" }),
    ]);
    expect(isDisposed()).toBe(true);
    await expect(hub.attach(listen().listener)).rejects.toMatchObject({ reason: "Unavailable" });
  });

  it("disposes itself when the first feed cannot open", async () => {
    const clock = manualTimers();
    let disposed = false;
    const hub = new PaSessionHub(
      "s-1",
      async () => {
        throw new PaError({ reason: "NotFound", message: "no session" });
      },
      { capacity: 3, lingerMs: 1, reconnectDelaysMs: [], timers: clock.timers },
      () => {
        disposed = true;
      },
    );
    await expect(hub.attach(listen().listener)).rejects.toMatchObject({ reason: "NotFound" });
    expect(disposed).toBe(true);
  });

  it("retries a feed that drops mid-handshake from one loop, leaking no upstream subscription", async () => {
    const clock = manualTimers();
    const opened: Array<{ resume: boolean; released: number; subscriber: PaSessionSubscriber }> =
      [];
    let dropDuringHandshake = false;
    const hub = new PaSessionHub(
      "s-1",
      async (subscriber, { resume }) => {
        const feed = { resume, released: 0, subscriber };
        opened.push(feed);
        subscriber.onEvent({
          type: "snapshot",
          sessionId: "s-1",
          running: false,
          openRequests: [],
          snapshotRequired: false,
        });
        if (dropDuringHandshake) {
          dropDuringHandshake = false;
          // The socket closes before the adapter has handed back its release.
          subscriber.onClose("closed while bootstrapping");
          subscriber.onClose("closed again");
        }
        return () => {
          feed.released += 1;
        };
      },
      { capacity: 10, lingerMs: 1_000, reconnectDelaysMs: [10, 20, 30], timers: clock.timers },
      () => undefined,
    );
    const a = listen();
    await hub.attach(a.listener);

    dropDuringHandshake = true;
    opened[0]!.subscriber.onClose("socket closed");
    opened[0]!.subscriber.onClose("socket closed");
    expect(clock.pendingDelays()).toEqual([10]);
    clock.fireAll();
    for (let i = 0; i < 4; i += 1) await flush();
    // The handshake feed was released and only the one loop waits for its next attempt.
    expect(opened).toHaveLength(2);
    expect(opened[1]!.released).toBe(1);
    expect(clock.pendingDelays()).toEqual([20]);

    clock.fireAll();
    for (let i = 0; i < 4; i += 1) await flush();
    expect(opened).toHaveLength(3);
    expect(clock.pendingDelays()).toEqual([]);
    expect(opened.map((feed) => feed.released)).toEqual([0, 1, 0]);

    const before = a.events.length;
    opened[2]!.subscriber.onEvent({ type: "turn.started", sessionId: "s-1" });
    // A dead feed's late frame is ignored, and the live one reaches the listener exactly once.
    opened[1]!.subscriber.onEvent({ type: "turn.started", sessionId: "s-1" });
    expect(a.events.slice(before).map((e) => e.type)).toEqual(["turn.started"]);

    hub.dispose();
    expect(opened[2]!.released).toBe(1);
  });

  it("stops reconnecting at once on a permanent failure and reports the original error", async () => {
    const clock = manualTimers();
    let opens = 0;
    const subscribers: PaSessionSubscriber[] = [];
    const hub = new PaSessionHub(
      "s-1",
      async (subscriber) => {
        opens += 1;
        if (opens > 1) throw new PaError({ reason: "NotFound", message: "session deleted" });
        subscribers.push(subscriber);
        subscriber.onEvent({
          type: "snapshot",
          sessionId: "s-1",
          running: false,
          openRequests: [],
          snapshotRequired: false,
        });
        return () => undefined;
      },
      { capacity: 3, lingerMs: 1_000, reconnectDelaysMs: [10, 20, 30], timers: clock.timers },
      () => undefined,
    );
    const a = listen();
    await hub.attach(a.listener);
    subscribers[0]!.onClose("socket closed");
    clock.fireAll();
    for (let i = 0; i < 4; i += 1) await flush();
    expect(opens).toBe(2);
    expect(clock.pendingDelays()).toEqual([]);
    expect(a.failures).toEqual([
      expect.objectContaining({ reason: "NotFound", message: "session deleted" }),
    ]);
  });

  it("keeps reconnecting when a reopened feed drops right as the reconnect loop finishes", async () => {
    for (let lag = 0; lag < 6; lag += 1) {
      const clock = manualTimers();
      const subscribers: PaSessionSubscriber[] = [];
      const hub = new PaSessionHub(
        "s-1",
        async (subscriber, { resume }) => {
          subscribers.push(subscriber);
          subscriber.onEvent({
            type: "snapshot",
            sessionId: "s-1",
            running: false,
            openRequests: [],
            snapshotRequired: false,
          });
          if (resume) {
            let drop = Promise.resolve();
            for (let i = 0; i < lag; i += 1) drop = drop.then(() => undefined);
            void drop.then(() => subscriber.onClose("dropped again"));
          }
          return () => undefined;
        },
        { capacity: 3, lingerMs: 1_000, reconnectDelaysMs: [10, 20, 30], timers: clock.timers },
        () => undefined,
      );
      const a = listen();
      await hub.attach(a.listener);
      subscribers[0]!.onClose("socket closed");
      clock.fireAll();
      for (let i = 0; i < 12; i += 1) await flush();
      // Never wedged: another attempt is scheduled whichever microtask the drop landed on.
      expect({ lag, pending: clock.pendingDelays().length }).toEqual({ lag, pending: 1 });
      expect(a.failures).toEqual([]);
      hub.dispose();
    }
  });

  it("clears its reconnect backoff timer when disposed", async () => {
    const { hub, clock, feeds } = makeHub();
    await hub.attach(listen().listener);
    feeds[0]!.subscriber.onClose("socket closed");
    expect(clock.pendingDelays()).toEqual([10]);
    hub.dispose();
    expect(clock.pendingDelays()).toEqual([]);
  });

  it("drops a turn's open requests when it ends, and resolves an answered one once", async () => {
    const { hub, emit } = makeHub({ capacity: 10 });
    const a = listen();
    await hub.attach(a.listener);
    const request = (requestId: string) => ({
      type: "request.opened" as const,
      sessionId: "s-1",
      request: { requestId, kind: "approval" as const, title: "t", detail: "d" },
    });
    emit({ type: "turn.started", sessionId: "s-1" });
    emit(request("r1"));
    emit(request("r2"));

    hub.resolveRequest("r1");
    hub.resolveRequest("r1");
    expect(a.events.filter((e) => e.type === "request.resolved")).toEqual([
      expect.objectContaining({ requestId: "r1" }),
    ]);
    const joiner = listen();
    await hub.attach(joiner.listener);
    expect(joiner.events[0]).toMatchObject({
      openRequests: [expect.objectContaining({ requestId: "r2" })],
    });

    emit({ type: "turn.completed", sessionId: "s-1", status: "interrupted" });
    const late = listen();
    await hub.attach(late.listener);
    expect(late.events[0]).toMatchObject({ running: false, openRequests: [] });
  });
  it.each([
    { type: "turn.started" },
    { type: "turn.completed", status: "complete" },
    { type: "error", message: "failed" },
  ] as const)(
    "retains only session requests in a late viewer's snapshot after $type",
    async (event) => {
      const { hub, emit } = makeHub();
      await hub.attach(listen().listener);
      const request = { kind: "clarify" as const, title: "t", detail: "d" };
      const choice = { ...request, requestId: "choice", scope: "session" as const };
      emit({ type: "request.opened", sessionId: "s-1", request: choice });
      emit({
        type: "request.opened",
        sessionId: "s-1",
        request: { ...request, requestId: "canonical" },
      });
      emit({ ...event, sessionId: "s-1" });
      const late = listen();
      await hub.attach(late.listener);
      expect(late.events[0]).toMatchObject({ openRequests: [choice] });
      emit({ type: "request.resolved", sessionId: "s-1", requestId: "choice" });
      const afterCancel = listen();
      await hub.attach(afterCancel.listener);
      expect(afterCancel.events[0]).toMatchObject({ openRequests: [] });
    },
  );
});

describe("PaSessionHub session state", () => {
  it("fills an attachment-only queue row when the send receipt follows its event", async () => {
    const { hub, emit } = makeHub();
    const first = listen();
    await hub.attach(first.listener);
    emit({
      type: "queue.updated",
      sessionId: "s-1",
      items: [{ id: "queued", text: "", status: "queued", canSteer: true }],
    });
    hub.describeQueuedAttachments("queued", "", 2);
    const second = listen();
    await hub.attach(second.listener);
    expect(second.events[0]).toMatchObject({
      queuedItems: [{ id: "queued", attachmentCount: 2, canSteer: false }],
    });
  });
  it("hands a newly attached viewer the latest queue, usage and todo plan", async () => {
    const { hub, emit } = makeHub();
    const first = listen();
    await hub.attach(first.listener);
    expect(first.events[0]).toMatchObject({ queuedItems: [], usage: null, todos: null });

    const item = { id: "adm-q", text: "next", status: "queued", canSteer: true } as const;
    const usage = { contextUsed: 10, contextMax: 100, contextPercent: 10 };
    emit({ type: "queue.updated", sessionId: "s-1", items: [item] });
    emit({ type: "usage.updated", sessionId: "s-1", usage });
    emit({ type: "usage.updated", sessionId: "s-1", usage: { ...usage, contextUsed: 20 } });
    emit({
      type: "todos.updated",
      sessionId: "s-1",
      todos: { revision: 3, items: [{ id: "1", text: "Plan", status: "in_progress" }] },
    });
    emit({ type: "todos.updated", sessionId: "s-1", todos: { revision: 2, items: [] } });

    const second = listen();
    await hub.attach(second.listener);
    expect(second.events[0]).toMatchObject({
      type: "snapshot",
      queuedItems: [item],
      usage: { contextUsed: 20 },
      todos: { revision: 3, items: [{ id: "1" }] },
    });

    // A mid-feed snapshot that omits them (a replay gap) keeps what the hub knows.
    emit({
      type: "snapshot",
      sessionId: "s-1",
      running: true,
      openRequests: [],
      snapshotRequired: true,
    });
    emit({ type: "queue.updated", sessionId: "s-1", items: [] });
    const third = listen();
    await hub.attach(third.listener);
    expect(third.events[0]).toMatchObject({
      queuedItems: [],
      usage: { contextUsed: 20 },
      todos: { revision: 3 },
    });
  });
});
