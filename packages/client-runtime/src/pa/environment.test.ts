import {
  EnvironmentId,
  PaError,
  type PaStreamEvent,
  type PaSubscribeSessionInput,
  WS_METHODS,
} from "@t3tools/contracts";
import { makeMethods } from "@effect/vitest";
import { describe, expect, test } from "vite-plus/test";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";

import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type * as RpcSession from "../rpc/session.ts";
import { isPermanentPaFailure, paSessionEvents } from "./environment.ts";

const it = makeMethods(test);

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Test environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});

const snapshot = (resumeToken: string, snapshotRequired = false): PaStreamEvent => ({
  type: "snapshot",
  sessionId: "s-1",
  resumeToken,
  running: false,
  openRequests: [],
  snapshotRequired,
});

/** A supervisor whose one session answers each subscribe attempt with the next scripted stream. */
const makeHarness = Effect.fn("TestPaEnvironment.makeHarness")(function* (
  attempts: ReadonlyArray<Stream.Stream<PaStreamEvent, PaError>>,
) {
  const inputs = yield* Ref.make<ReadonlyArray<PaSubscribeSessionInput>>([]);
  const client = {
    [WS_METHODS.paSubscribeSession]: (input: PaSubscribeSessionInput) =>
      Stream.unwrap(
        Ref.modify(inputs, (seen) => [seen.length, [...seen, input]] as const).pipe(
          Effect.map((index) => attempts[index] ?? Stream.never),
        ),
      ),
  } as unknown as WsRpcProtocolClient;
  const session: RpcSession.RpcSession = {
    client,
    initialConfig: Effect.never,
    subscribeServerConfig: (input = {}) => client.subscribeServerConfig(input),
    ready: Effect.void,
    probe: Effect.void,
    inboundFrames: Effect.succeed(0),
    closed: Effect.never,
  };
  const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
    target: TARGET,
    state: yield* SubscriptionRef.make<SupervisorConnectionState>(AVAILABLE_CONNECTION_STATE),
    session: yield* SubscriptionRef.make(Option.some(session)),
    prepared: yield* SubscriptionRef.make<Option.Option<PreparedConnection>>(Option.none()),
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
  return { inputs, supervisor };
});

describe("paSessionEvents", () => {
  it.effect("reconnects from the last applied token and passes a reload request through", () =>
    Effect.gen(function* () {
      const failures: Array<{ readonly reason: unknown; readonly retrying: boolean }> = [];
      const failed = yield* Deferred.make<void>();
      const { inputs, supervisor } = yield* makeHarness([
        Stream.make(snapshot("ep:0"), {
          type: "turn.started",
          sessionId: "s-1",
          resumeToken: "ep:1",
        } satisfies PaStreamEvent).pipe(
          Stream.concat(
            Stream.fail(new PaError({ reason: "Unavailable", message: "fell behind" })),
          ),
        ),
        Stream.make(snapshot("ep:1", true)),
      ]);
      const feed = paSessionEvents({
        botId: "hermes:default",
        sessionId: "s-1",
        onEvent: () => undefined,
        onFailure: (error, { retrying }) => {
          failures.push({ reason: (error as PaError).reason, retrying });
          Deferred.doneUnsafe(failed, Effect.void);
        },
      });
      const fiber = yield* feed.events.pipe(
        Stream.tap(feed.deliver),
        Stream.take(3),
        Stream.runCollect,
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.forkChild,
      );
      // The retry waits on the clock once the first attempt has failed.
      yield* Deferred.await(failed);
      yield* Effect.yieldNow;
      yield* TestClock.adjust("1 second");
      const events = Array.from(yield* Fiber.join(fiber));

      expect(yield* Ref.get(inputs)).toEqual([
        { protocolVersion: 2, botId: "hermes:default", sessionId: "s-1" },
        { protocolVersion: 2, botId: "hermes:default", sessionId: "s-1", resumeToken: "ep:1" },
      ]);
      expect(events.map((e) => [e.type, e.resumeToken])).toEqual([
        ["snapshot", "ep:0"],
        ["turn.started", "ep:1"],
        ["snapshot", "ep:1"],
      ]);
      expect(events[2]).toMatchObject({ snapshotRequired: true });
      expect(failures).toEqual([{ reason: "Unavailable", retrying: true }]);
    }),
  );

  it.effect.each(["NotFound", "Invalid", "Forbidden", "Unsupported"] as const)(
    "ends at once without retrying when the engine answers %s",
    (reason) =>
      Effect.gen(function* () {
        const failures: Array<{ readonly reason: unknown; readonly retrying: boolean }> = [];
        const { inputs, supervisor } = yield* makeHarness([
          Stream.fail(new PaError({ reason, message: "refused" })),
        ]);
        const feed = paSessionEvents({
          botId: "hermes:default",
          sessionId: "s-gone",
          onEvent: () => undefined,
          onFailure: (error, { retrying }) =>
            failures.push({ reason: (error as PaError).reason, retrying }),
        });
        const fiber = yield* feed.events.pipe(
          Stream.runCollect,
          Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
          Effect.forkChild,
        );
        const events = Array.from(yield* Fiber.join(fiber));
        yield* TestClock.adjust("1 minute");

        expect(events).toEqual([]);
        expect(yield* Ref.get(inputs)).toHaveLength(1);
        expect(failures).toEqual([{ reason, retrying: false }]);
      }),
  );

  it.effect("keeps the resume token when the environment entry is rebuilt", () =>
    Effect.gen(function* () {
      const { inputs, supervisor } = yield* makeHarness([
        Stream.make(snapshot("ep:0"), {
          type: "turn.started",
          sessionId: "s-1",
          resumeToken: "ep:1",
        } satisfies PaStreamEvent).pipe(Stream.concat(Stream.never)),
        Stream.make(snapshot("ep:1")).pipe(Stream.concat(Stream.never)),
      ]);
      const feed = paSessionEvents({
        botId: "hermes:default",
        sessionId: "s-1",
        onEvent: () => undefined,
        onFailure: () => undefined,
      });
      // `followStream`'s switchMap reruns the same stream on a new connection entry.
      const run = (count: number) =>
        feed.events.pipe(
          Stream.tap(feed.deliver),
          Stream.take(count),
          Stream.runCollect,
          Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        );
      yield* run(2);
      const rerun = Array.from(yield* run(1));

      expect(yield* Ref.get(inputs)).toEqual([
        { protocolVersion: 2, botId: "hermes:default", sessionId: "s-1" },
        { protocolVersion: 2, botId: "hermes:default", sessionId: "s-1", resumeToken: "ep:1" },
      ]);
      expect(rerun.map((e) => e.resumeToken)).toEqual(["ep:1"]);
    }),
  );

  it.effect("replays an event interrupted between the inner stream and the follower", () =>
    Effect.gen(function* () {
      const awaitingDelivery = yield* Deferred.make<void>();
      const entries = yield* SubscriptionRef.make(1);
      const received: string[] = [];
      const { inputs, supervisor } = yield* makeHarness([
        Stream.make(snapshot("ep:0"), snapshot("ep:1")),
        Stream.make(snapshot("ep:1")),
      ]);
      const feed = paSessionEvents({
        botId: "hermes:default",
        sessionId: "s-1",
        onFailure: () => undefined,
        onEvent: (event) => received.push(event.resumeToken),
      });
      const fiber = yield* SubscriptionRef.changes(entries).pipe(
        Stream.switchMap((entry) =>
          feed.events.pipe(
            Stream.tap((event) =>
              entry === 1 && event.resumeToken === "ep:1"
                ? Deferred.succeed(awaitingDelivery, undefined).pipe(Effect.andThen(Effect.never))
                : Effect.void,
            ),
          ),
        ),
        Stream.take(2),
        Stream.runForEach(feed.deliver),
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.forkChild,
      );
      yield* Deferred.await(awaitingDelivery);
      yield* SubscriptionRef.set(entries, 2);
      yield* Fiber.join(fiber);
      expect((yield* Ref.get(inputs)).map((input) => input.resumeToken)).toEqual([
        undefined,
        "ep:0",
      ]);
      expect(received).toEqual(["ep:0", "ep:1"]);
    }),
  );

  it.effect("does not resubscribe a refused session when the environment entry is rebuilt", () =>
    Effect.gen(function* () {
      const failures: Array<boolean> = [];
      const { inputs, supervisor } = yield* makeHarness([
        Stream.fail(new PaError({ reason: "NotFound", message: "gone" })),
        Stream.make(snapshot("ep:0")),
      ]);
      const feed = paSessionEvents({
        botId: "hermes:default",
        sessionId: "s-gone",
        onEvent: () => undefined,
        onFailure: (_error, { retrying }) => failures.push(retrying),
      });
      const run = feed.events.pipe(
        Stream.runCollect,
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
      );
      expect(Array.from(yield* run)).toEqual([]);
      expect(Array.from(yield* run)).toEqual([]);
      yield* TestClock.adjust("1 minute");

      expect(yield* Ref.get(inputs)).toHaveLength(1);
      expect(failures).toEqual([false]);
    }),
  );

  it.effect(
    "uses protocolVersion 3 with initialResumeToken, dynamic latestPage tags, and onResumeToken",
    () =>
      Effect.gen(function* () {
        let currentTag: string | undefined = "tag-1";
        const observedTokens: string[] = [];
        const failed = yield* Deferred.make<void>();
        const { inputs, supervisor } = yield* makeHarness([
          Stream.concat(
            Stream.make(snapshot("ep:5")),
            Stream.fail(new PaError({ reason: "Unavailable", message: "socket closed" })),
          ),
          Stream.make(snapshot("ep:6")),
        ]);
        const feed = paSessionEvents({
          botId: "hermes:default",
          sessionId: "s-1",
          initialResumeToken: "ep:4",
          latestPage: {
            limit: 50,
            getKnownPageTag: () => currentTag,
          },
          onEvent: (event) => {
            if (event.resumeToken === "ep:5") {
              currentTag = "tag-2";
            }
          },
          onResumeToken: (token) => observedTokens.push(token),
          onFailure: () => {
            Deferred.doneUnsafe(failed, Effect.void);
          },
        });

        const fiber = yield* feed.events.pipe(
          Stream.tap(feed.deliver),
          Stream.take(2),
          Stream.runCollect,
          Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
          Effect.forkChild,
        );
        yield* Deferred.await(failed);
        yield* Effect.yieldNow;
        yield* TestClock.adjust("1 second");
        yield* Fiber.join(fiber);

        expect(yield* Ref.get(inputs)).toEqual([
          {
            botId: "hermes:default",
            sessionId: "s-1",
            protocolVersion: 3,
            resumeToken: "ep:4",
            latestPage: { limit: 50, knownPageTag: "tag-1" },
          },
          {
            botId: "hermes:default",
            sessionId: "s-1",
            protocolVersion: 3,
            resumeToken: "ep:5",
            latestPage: { limit: 50, knownPageTag: "tag-2" },
          },
        ]);
        expect(observedTokens).toEqual(["ep:5", "ep:6"]);
      }),
  );

  it("treats only refusals that a reconnect cannot fix as permanent", () => {
    expect(isPermanentPaFailure(new PaError({ reason: "Conflict", message: "" }))).toBe(true);
    expect(isPermanentPaFailure(new PaError({ reason: "Unavailable", message: "" }))).toBe(false);
    expect(isPermanentPaFailure(new PaError({ reason: "Upstream", message: "" }))).toBe(false);
    expect(isPermanentPaFailure(new Error("socket closed"))).toBe(false);
  });
});
