// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeOS from "node:os";
// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

import { PaError, type PaCapabilities } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Stream from "effect/Stream";
import { afterEach, describe, expect, it } from "@effect/vitest";

import { makePaService } from "./PaService.ts";
import { PaStore } from "./PaStore.ts";
import type { PaAgentRow, PaEngineInstance, PaSessionSubscriber } from "./types.ts";

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) NodeFS.rmSync(dir, { recursive: true, force: true });
});

const CORE_ONLY: PaCapabilities = {
  sessions: { create: true, rename: false },
  execution: { interrupt: false, approvals: false, clarify: false },
  models: { supported: false, scope: "agent", allowCustom: false },
  commands: { supported: false },
  config: { supported: false },
  schedules: { supported: false },
  lifecycle: { create: false, delete: false },
};

const row = (agentRef: string, patch: Partial<PaAgentRow> = {}): PaAgentRow => ({
  agentRef,
  name: null,
  description: "",
  isDefault: false,
  model: null,
  provider: null,
  running: false,
  lastActivityAt: null,
  lastMessagePreview: null,
  ...patch,
});

function makeEngine(overrides: Partial<PaEngineInstance> = {}) {
  const feeds: PaSessionSubscriber[] = [];
  const sent: string[] = [];
  const engine: PaEngineInstance = {
    instanceId: "fake",
    driver: "fake",
    label: "Fake",
    capabilities: CORE_ONLY,
    isValidAgentRef: (ref) => /^[a-z]+$/.test(ref),
    listAgents: async () => [
      row("main", { isDefault: true, lastActivityAt: 10 }),
      row("helper", { name: "Helper", lastActivityAt: 50 }),
    ],
    listSessions: async () => [],
    createSession: async () => ({
      sessionId: "s-new",
      title: "New conversation",
      source: "gui",
      model: null,
      messageCount: 0,
      running: false,
      startedAt: 1,
      lastActivityAt: 1,
    }),
    getMessages: async () => [],
    sendMessage: async (_ref, sessionId, text) => {
      sent.push(text);
      return text.startsWith("/")
        ? { kind: "output", sessionId, output: `ran ${text}` }
        : { kind: "turn", sessionId, submissionId: "sub-1" };
    },
    subscribeSession: async (_ref, sessionId, subscriber) => {
      feeds.push(subscriber);
      subscriber.onEvent({
        type: "snapshot",
        sessionId,
        running: false,
        openRequests: [],
        snapshotRequired: false,
      });
      return () => undefined;
    },
    ...overrides,
  };
  return { engine, feeds, sent };
}

function makeService(engines: ReadonlyArray<PaEngineInstance>) {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-pa-service-"));
  tempDirs.push(dir);
  const store = new PaStore(dir);
  return { store, service: makePaService({ store, instances: engines }) };
}

describe("PaService", () => {
  it.effect("lists every engine's agents with local metadata, pinned first then most recent", () =>
    Effect.gen(function* () {
      const { engine } = makeEngine();
      const { service, store } = makeService([engine]);
      store.updateBotMeta("fake:helper", { displayName: "Renamed", lastReadAt: 40 });

      const result = yield* service.listBots();
      expect(result.instances).toEqual([
        expect.objectContaining({ instanceId: "fake", online: true, botCount: 2, error: null }),
      ]);
      expect(result.bots.map((b) => [b.botId, b.name, b.pinned, b.unread])).toEqual([
        ["fake:main", "Fake", true, false],
        ["fake:helper", "Renamed", false, true],
      ]);
      expect(result.bots[0]).toMatchObject({
        engineLabel: "Fake",
        driver: "fake",
        agentRef: "main",
      });
    }),
  );

  it.effect("reports an engine that does not answer as offline without failing the roster", () =>
    Effect.gen(function* () {
      const { engine: healthy } = makeEngine();
      const { engine: broken } = makeEngine({
        instanceId: "down",
        listAgents: async () => {
          throw new PaError({ reason: "Unavailable", message: "engine not installed" });
        },
      });
      const { service } = makeService([healthy, broken]);
      const result = yield* service.listBots();
      expect(result.instances.map((i) => [i.instanceId, i.online, i.error])).toEqual([
        ["fake", true, null],
        ["down", false, "engine not installed"],
      ]);
      expect(result.bots.every((b) => b.instanceId === "fake")).toBe(true);
    }),
  );

  it.effect("rejects malformed ids, unknown engines and absent facets with neutral reasons", () =>
    Effect.gen(function* () {
      const { engine } = makeEngine();
      const { service } = makeService([engine]);
      expect(
        (yield* Effect.flip(service.getMessages({ botId: "nope", sessionId: "s" }))).reason,
      ).toBe("Invalid");
      expect((yield* Effect.flip(service.listSessions("other:main"))).reason).toBe("NotFound");
      expect((yield* Effect.flip(service.listSessions("fake:BAD"))).reason).toBe("Invalid");
      expect((yield* Effect.flip(service.getBotModels({ botId: "fake:main" }))).reason).toBe(
        "Unsupported",
      );
      expect(
        (yield* Effect.flip(service.interruptSession({ botId: "fake:main", sessionId: "s" })))
          .reason,
      ).toBe("Unsupported");
      expect(
        (yield* Effect.flip(service.createBot({ instanceId: "fake", agentRef: "new" }))).reason,
      ).toBe("Unsupported");
    }),
  );

  it.effect("keeps the primary session and read marker locally", () =>
    Effect.gen(function* () {
      const { engine } = makeEngine();
      const { service, store } = makeService([engine]);
      const created = yield* service.createSession({ botId: "fake:main" });
      expect(created).toMatchObject({ sessionId: "s-new", isPrimary: true });
      const listed = yield* service.listSessions("fake:main");
      expect(listed.primarySessionId).toBe("s-new");
      expect(listed.sessions).toEqual([
        expect.objectContaining({ sessionId: "s-new", isPrimary: true, messageCount: 0 }),
      ]);
      yield* service.updateBotMeta({ botId: "fake:main", markRead: true, pinned: false });
      expect(store.getBotMeta("fake:main")).toMatchObject({ pinned: false });
      expect(store.getBotMeta("fake:main").lastReadAt).toBeTypeOf("number");
    }),
  );

  it.effect("treats any command as manage when the engine declares no command policy", () =>
    Effect.gen(function* () {
      const { engine } = makeEngine();
      const { engine: withPolicy } = makeEngine({
        instanceId: "policy",
        commands: { list: async () => [], requiredScope: () => "operate" },
      });
      const { service } = makeService([engine, withPolicy]);
      expect(yield* service.requiredScopeForMessage("fake:main", "hello")).toBe("operate");
      expect(yield* service.requiredScopeForMessage("fake:main", "  /status")).toBe("manage");
      expect(yield* service.requiredScopeForMessage("policy:main", "/status")).toBe("operate");
    }),
  );

  it.effect("streams a session with resume tokens and fans command output out as a notice", () =>
    Effect.gen(function* () {
      const { engine, feeds } = makeEngine();
      const { service } = makeService([engine]);
      // The listener is registered by the time its snapshot is read, so driving the feed there is safe.
      const events = yield* service.subscribeSession({ botId: "fake:main", sessionId: "s-1" }).pipe(
        Stream.tap((event) =>
          event.type !== "snapshot"
            ? Effect.void
            : Effect.sync(() =>
                feeds[0]!.onEvent({
                  type: "text.delta",
                  sessionId: "s-1",
                  text: "Hi",
                  role: "answer",
                }),
              ).pipe(
                Effect.andThen(
                  service.sendMessage({
                    botId: "fake:main",
                    sessionId: "s-1",
                    text: "/status",
                    inputId: "i-1",
                  }),
                ),
                Effect.tap((result) =>
                  Effect.sync(() =>
                    expect(result).toEqual({
                      kind: "output",
                      sessionId: "s-1",
                      output: "ran /status",
                    }),
                  ),
                ),
              ),
        ),
        Stream.take(3),
        Stream.runCollect,
      );
      expect(Array.from(events)).toEqual([
        expect.objectContaining({ type: "snapshot", snapshotRequired: false }),
        expect.objectContaining({ type: "text.delta", text: "Hi" }),
        expect.objectContaining({
          type: "notice",
          message: "ran /status",
          persistent: true,
          inputId: "i-1",
        }),
      ]);
      expect(Array.from(events, (e) => Number(e.resumeToken.split(":")[1]))).toEqual([0, 1, 2]);
    }),
  );

  it.effect("cuts off a reader that falls behind instead of dropping events silently", () =>
    Effect.gen(function* () {
      const { engine, feeds } = makeEngine();
      const { service } = makeService([engine]);
      const result = yield* Effect.exit(
        service.subscribeSession({ botId: "fake:main", sessionId: "s-1" }).pipe(
          Stream.tap((event) =>
            Effect.sync(() => {
              if (event.type !== "snapshot") return;
              // The reader stalls on its first event while the engine keeps producing.
              for (let i = 0; i < 3_000; i += 1) {
                feeds[0]!.onEvent({ type: "reasoning.delta", sessionId: "s-1", text: "x" });
              }
            }),
          ),
          Stream.runDrain,
        ),
      );
      expect(Exit.isFailure(result)).toBe(true);
      expect(Exit.isFailure(result) && JSON.stringify(result.cause)).toContain("fell behind");
    }),
  );

  it.effect(
    "serves a legitimate catch-up longer than 1,024 events without cutting the reader",
    () =>
      Effect.gen(function* () {
        const { engine, feeds } = makeEngine();
        const { service } = makeService([engine]);
        const input = { botId: "fake:main", sessionId: "s-1" };
        const [snapshot] = Array.from(
          yield* service.subscribeSession(input).pipe(Stream.take(1), Stream.runCollect),
        );
        for (let i = 0; i < 1_200; i += 1) {
          feeds[0]!.onEvent({ type: "reasoning.delta", sessionId: "s-1", text: "x" });
        }
        const resumed = Array.from(
          yield* service
            .subscribeSession({ ...input, resumeToken: snapshot!.resumeToken })
            .pipe(Stream.take(1_201), Stream.runCollect),
        );
        service.dispose();
        expect(resumed[0]).toMatchObject({ type: "snapshot", snapshotRequired: false });
        expect(resumed).toHaveLength(1_201);
        expect(resumed.at(-1)).toMatchObject({ type: "reasoning.delta" });
      }),
  );

  it.effect("drops an answered request from the shared feed before the engine settles it", () =>
    Effect.gen(function* () {
      const answered: string[] = [];
      const { engine, feeds } = makeEngine({
        requests: {
          respond: async (_ref, _sessionId, answer) => {
            answered.push(answer.requestId);
          },
        },
      });
      const { service } = makeService([engine]);
      const input = { botId: "fake:main", sessionId: "s-1" };
      yield* service.subscribeSession(input).pipe(Stream.take(1), Stream.runDrain);
      feeds[0]!.onEvent({ type: "turn.started", sessionId: "s-1" });
      for (const requestId of ["r1", "r2"]) {
        feeds[0]!.onEvent({
          type: "request.opened",
          sessionId: "s-1",
          request: { requestId, kind: "approval", title: "Run?", detail: "" },
        });
      }

      yield* service.respondRequest({ ...input, requestId: "r1", decision: "once" });
      const [afterAnswer] = Array.from(
        yield* service.subscribeSession(input).pipe(Stream.take(1), Stream.runCollect),
      );
      expect(answered).toEqual(["r1"]);
      expect(afterAnswer).toMatchObject({
        type: "snapshot",
        openRequests: [expect.objectContaining({ requestId: "r2" })],
      });

      feeds[0]!.onEvent({ type: "turn.completed", sessionId: "s-1", status: "complete" });
      const [afterTurn] = Array.from(
        yield* service.subscribeSession(input).pipe(Stream.take(1), Stream.runCollect),
      );
      service.dispose();
      expect(afterTurn).toMatchObject({ type: "snapshot", running: false, openRequests: [] });
    }),
  );
});
