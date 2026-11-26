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
});
