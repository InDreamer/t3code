import {
  makePaBotId,
  PaError,
  parsePaBotId,
  type PaBotConfig,
  type PaBotSummary,
  type PaCreateBotInput,
  type PaCreateSessionInput,
  type PaGetBotModelsInput,
  type PaGetMessagesInput,
  type PaInstanceStatus,
  type PaListBotsResult,
  type PaListSessionsResult,
  type PaMessage,
  type PaModelCatalog,
  type PaMutateScheduleInput,
  type PaPatchBotConfigInput,
  type PaRespondRequestInput,
  type PaSchedule,
  type PaSelectBotModelInput,
  type PaSelectBotModelResult,
  type PaSendMessageInput,
  type PaSendResult,
  type PaSessionSummary,
  type PaSlashCommand,
  type PaStreamEvent,
  type PaSubscribeSessionInput,
  type PaUpdateBotMetaInput,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import { HermesPaAdapter } from "./adapters/hermes/HermesPaAdapter.ts";
import { DEFAULT_PA_HUB_OPTIONS, PaSessionHub, type PaHubOptions } from "./PaSessionHub.ts";
import { defaultVisualForBot, PaStore } from "./PaStore.ts";
import type { PaAgentRow, PaCommandScope, PaEngineInstance } from "./types.ts";

function nowMs(): number {
  // @effect-diagnostics globalDate:off
  return Date.now();
}

const DEFAULT_MESSAGE_LIMIT = 120;

const isPaError = Schema.is(PaError);

const toPaError = (cause: unknown): PaError =>
  isPaError(cause)
    ? cause
    : new PaError({
        reason: "Upstream",
        message: cause instanceof Error ? cause.message : String(cause),
      });

const unsupported = (instance: PaEngineInstance, what: string) =>
  new PaError({ reason: "Unsupported", message: `${instance.label} does not support ${what}` });

const fromPromise = <A>(thunk: () => Promise<A>) =>
  Effect.tryPromise({ try: thunk, catch: toPaError });

const fromSync = <A>(thunk: () => A) => Effect.try({ try: thunk, catch: toPaError });

export interface PaServiceShape {
  readonly listBots: () => Effect.Effect<PaListBotsResult>;
  readonly createBot: (input: PaCreateBotInput) => Effect.Effect<PaBotSummary, PaError>;
  readonly updateBotMeta: (input: PaUpdateBotMetaInput) => Effect.Effect<void, PaError>;
  readonly getBotModels: (input: PaGetBotModelsInput) => Effect.Effect<PaModelCatalog, PaError>;
  readonly selectBotModel: (
    input: PaSelectBotModelInput,
  ) => Effect.Effect<PaSelectBotModelResult, PaError>;
  readonly getBotConfig: (botId: string) => Effect.Effect<PaBotConfig, PaError>;
  readonly patchBotConfig: (input: PaPatchBotConfigInput) => Effect.Effect<PaBotConfig, PaError>;
  readonly listSchedules: (botId: string) => Effect.Effect<ReadonlyArray<PaSchedule>, PaError>;
  readonly mutateSchedule: (
    input: PaMutateScheduleInput,
  ) => Effect.Effect<ReadonlyArray<PaSchedule>, PaError>;
  readonly listCommands: (botId: string) => Effect.Effect<ReadonlyArray<PaSlashCommand>, PaError>;
  readonly listSessions: (botId: string) => Effect.Effect<PaListSessionsResult, PaError>;
  readonly createSession: (input: PaCreateSessionInput) => Effect.Effect<PaSessionSummary, PaError>;
  readonly getMessages: (
    input: PaGetMessagesInput,
  ) => Effect.Effect<ReadonlyArray<PaMessage>, PaError>;
  /** The grant a message needs; the engine adapter decides which of its commands need `manage`. */
  readonly requiredScopeForMessage: (
    botId: string,
    text: string,
  ) => Effect.Effect<PaCommandScope, PaError>;
  readonly sendMessage: (input: PaSendMessageInput) => Effect.Effect<PaSendResult, PaError>;
  readonly interruptSession: (input: {
    readonly botId: string;
    readonly sessionId: string;
  }) => Effect.Effect<void, PaError>;
  readonly respondRequest: (input: PaRespondRequestInput) => Effect.Effect<void, PaError>;
  readonly subscribeSession: (
    input: PaSubscribeSessionInput,
  ) => Stream.Stream<PaStreamEvent, PaError>;
}

export class PaService extends Context.Service<PaService, PaServiceShape>()("t3/pa/PaService") {}

export interface PaServiceInternals extends PaServiceShape {
  readonly dispose: () => void;
}

export function makePaService(options: {
  readonly store: PaStore;
  readonly instances: ReadonlyArray<PaEngineInstance>;
  readonly hub?: PaHubOptions;
}): PaServiceInternals {
  const { store } = options;
  const instances = new Map(options.instances.map((instance) => [instance.instanceId, instance]));
  const hubs = new Map<string, PaSessionHub>();
  const hubOptions = options.hub ?? DEFAULT_PA_HUB_OPTIONS;
  // Events a slow client may lag behind before its stream is cut and it resumes. It must hold a
  // whole hub replay, or a legitimate catch-up would cut the client it is catching up.
  const subscriberBuffer = Math.max(1_024, hubOptions.capacity + 64);

  const resolveBot = (botId: string) =>
    Effect.suspend(() => {
      const parsed = parsePaBotId(botId);
      if (!parsed) {
        return Effect.fail(
          new PaError({ reason: "Invalid", message: `Invalid bot id "${botId}"` }),
        );
      }
      const instance = instances.get(parsed.instanceId);
      if (!instance) {
        return Effect.fail(
          new PaError({
            reason: "NotFound",
            message: `Agent engine "${parsed.instanceId}" is not configured`,
          }),
        );
      }
      if (!instance.isValidAgentRef(parsed.agentRef)) {
        return Effect.fail(
          new PaError({ reason: "Invalid", message: `Invalid agent "${parsed.agentRef}"` }),
        );
      }
      return Effect.succeed({ instance, agentRef: parsed.agentRef, botId });
    });

  const summarize = (instance: PaEngineInstance, row: PaAgentRow): PaBotSummary => {
    const botId = makePaBotId(instance.instanceId, row.agentRef);
    const meta = store.getBotMeta(botId);
    const visual = defaultVisualForBot(botId, row.isDefault);
    return {
      botId,
      instanceId: instance.instanceId,
      driver: instance.driver,
      engineLabel: instance.label,
      agentRef: row.agentRef,
      name: meta.displayName?.trim() || row.name || (row.isDefault ? instance.label : row.agentRef),
      description: row.description,
      avatarColor: meta.avatarColor ?? visual.avatarColor,
      avatarShape: meta.avatarShape ?? visual.avatarShape,
      pinned: meta.pinned ?? row.isDefault,
      isDefault: row.isDefault,
      model: row.model,
      provider: row.provider,
      online: true,
      running: row.running,
      unread:
        row.lastActivityAt !== null &&
        meta.lastReadAt !== undefined &&
        row.lastActivityAt > meta.lastReadAt,
      lastMessagePreview: row.lastMessagePreview,
      lastActivityAt: row.lastActivityAt,
      primarySessionId: meta.primarySessionId ?? null,
    };
  };

  const byPinnedThenRecent = (a: PaBotSummary, b: PaBotSummary) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0);
  };

  const status = (
    instance: PaEngineInstance,
    result: { readonly botCount: number; readonly error: string | null },
  ): PaInstanceStatus => ({
    instanceId: instance.instanceId,
    driver: instance.driver,
    label: instance.label,
    online: result.error === null,
    version: instance.version?.() ?? null,
    error: result.error,
    botCount: result.botCount,
    capabilities: instance.capabilities,
  });

  const hubKey = (botId: string, sessionId: string) => `${botId}\u0000${sessionId}`;

  const listBots = Effect.fn("PaService.listBots")(function* () {
    // The roster read is the status probe: an instance is online exactly when its list answered.
    const results = yield* Effect.forEach(
      Array.from(instances.values()),
      (instance) =>
        fromPromise(() => instance.listAgents()).pipe(
          Effect.map((rows) => ({
            status: status(instance, { botCount: rows.length, error: null }),
            bots: rows.map((row) => summarize(instance, row)),
          })),
          Effect.catch((error) =>
            Effect.succeed({
              status: status(instance, { botCount: 0, error: error.message }),
              bots: [] as ReadonlyArray<PaBotSummary>,
            }),
          ),
        ),
      { concurrency: "unbounded" },
    );
    return {
      instances: results.map((entry) => entry.status),
      bots: results.flatMap((entry) => entry.bots).sort(byPinnedThenRecent),
    };
  });

  const createBot = Effect.fn("PaService.createBot")(function* (input: PaCreateBotInput) {
    const instance = instances.get(input.instanceId);
    if (!instance) {
      return yield* new PaError({
        reason: "NotFound",
        message: `Agent engine "${input.instanceId}" is not configured`,
      });
    }
    const lifecycle = instance.lifecycle;
    if (!lifecycle || !instance.capabilities.lifecycle.create) {
      return yield* unsupported(instance, "creating agents");
    }
    const { agentRef } = yield* fromPromise(() =>
      lifecycle.create({
        agentRef: input.agentRef,
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.instructions !== undefined ? { instructions: input.instructions } : {}),
      }),
    );
    const botId = makePaBotId(instance.instanceId, agentRef);
    yield* fromSync(() =>
      store.updateBotMeta(botId, {
        displayName: input.name?.trim() || agentRef,
        avatarColor: input.avatarColor,
        avatarShape: input.avatarShape,
        pinned: input.pinned ?? false,
        lastReadAt: nowMs(),
      }),
    );
    const rows = yield* fromPromise(() => instance.listAgents());
    const row = rows.find((entry) => entry.agentRef === agentRef);
    if (!row) {
      return yield* new PaError({
        reason: "Upstream",
        message: `"${agentRef}" was created but is not listed yet`,
      });
    }
    return summarize(instance, row);
  });

  const updateBotMeta = Effect.fn("PaService.updateBotMeta")(function* (
    input: PaUpdateBotMetaInput,
  ) {
    const { botId } = yield* resolveBot(input.botId);
    yield* fromSync(() =>
      store.updateBotMeta(botId, {
        ...(input.name !== undefined ? { displayName: input.name.trim() } : {}),
        ...(input.avatarColor !== undefined ? { avatarColor: input.avatarColor } : {}),
        ...(input.avatarShape !== undefined ? { avatarShape: input.avatarShape } : {}),
        ...(input.pinned !== undefined ? { pinned: input.pinned } : {}),
        ...(input.markRead === true ? { lastReadAt: nowMs() } : {}),
      }),
    );
  });

  const facet = <K extends "models" | "commands" | "requests" | "config" | "schedules">(
    instance: PaEngineInstance,
    key: K,
    what: string,
  ) => {
    const value = instance[key];
    return value === undefined
      ? Effect.fail(unsupported(instance, what))
      : Effect.succeed(value as NonNullable<PaEngineInstance[K]>);
  };

  const getBotModels = Effect.fn("PaService.getBotModels")(function* (input: PaGetBotModelsInput) {
    const { instance, agentRef } = yield* resolveBot(input.botId);
    const models = yield* facet(instance, "models", "model selection");
    return yield* fromPromise(() => models.getCatalog(agentRef, input.sessionId));
  });

  const selectBotModel = Effect.fn("PaService.selectBotModel")(function* (
    input: PaSelectBotModelInput,
  ) {
    const { instance, agentRef } = yield* resolveBot(input.botId);
    const models = yield* facet(instance, "models", "model selection");
    return yield* fromPromise(() =>
      models.select(agentRef, {
        sessionId: input.sessionId,
        provider: input.provider,
        model: input.model,
        confirm: input.confirm === true,
      }),
    );
  });

  const getBotConfig = Effect.fn("PaService.getBotConfig")(function* (botId: string) {
    const { instance, agentRef } = yield* resolveBot(botId);
    const config = yield* facet(instance, "config", "agent configuration");
    return yield* fromPromise(() => config.get(agentRef));
  });

  const patchBotConfig = Effect.fn("PaService.patchBotConfig")(function* (
    input: PaPatchBotConfigInput,
  ) {
    const { instance, agentRef } = yield* resolveBot(input.botId);
    const config = yield* facet(instance, "config", "agent configuration");
    return yield* fromPromise(() => config.patch(agentRef, input.sectionId, input.value));
  });

  const listSchedules = Effect.fn("PaService.listSchedules")(function* (botId: string) {
    const { instance, agentRef } = yield* resolveBot(botId);
    const schedules = yield* facet(instance, "schedules", "schedules");
    return yield* fromPromise(() => schedules.list(agentRef));
  });

  const mutateSchedule = Effect.fn("PaService.mutateSchedule")(function* (
    input: PaMutateScheduleInput,
  ) {
    const { instance, agentRef } = yield* resolveBot(input.botId);
    const schedules = yield* facet(instance, "schedules", "schedules");
    const { botId: _botId, ...mutation } = input;
    return yield* fromPromise(() => schedules.mutate(agentRef, mutation));
  });

  const listCommands = Effect.fn("PaService.listCommands")(function* (botId: string) {
    const { instance, agentRef } = yield* resolveBot(botId);
    const commands = yield* facet(instance, "commands", "slash commands");
    return yield* fromPromise(() => commands.list(agentRef));
  });

  const listSessions = Effect.fn("PaService.listSessions")(function* (botId: string) {
    const { instance, agentRef } = yield* resolveBot(botId);
    const rows = yield* fromPromise(() => instance.listSessions(agentRef));
    const primarySessionId = store.getBotMeta(botId).primarySessionId ?? null;
    const sessions: PaSessionSummary[] = rows.map((row) => ({
      ...row,
      isPrimary: row.sessionId === primarySessionId,
    }));
    // A just-created primary session is not listed until its first message is stored.
    if (primarySessionId && !sessions.some((s) => s.sessionId === primarySessionId)) {
      sessions.unshift({
        sessionId: primarySessionId,
        title: "New conversation",
        source: "gui",
        model: null,
        messageCount: 0,
        running: false,
        startedAt: null,
        lastActivityAt: null,
        isPrimary: true,
      });
    }
    return { primarySessionId, sessions };
  });

  const createSession = Effect.fn("PaService.createSession")(function* (
    input: PaCreateSessionInput,
  ) {
    const { instance, agentRef, botId } = yield* resolveBot(input.botId);
    if (!instance.capabilities.sessions.create) {
      return yield* unsupported(instance, "new sessions");
    }
    const title = instance.capabilities.sessions.rename ? input.title : undefined;
    const created = yield* fromPromise(() => instance.createSession(agentRef, { title }));
    const setPrimary = input.setPrimary !== false;
    if (setPrimary) {
      yield* fromSync(() =>
        store.updateBotMeta(botId, { primarySessionId: created.sessionId, lastReadAt: nowMs() }),
      );
    }
    return { ...created, isPrimary: setPrimary };
  });

  const getMessages = Effect.fn("PaService.getMessages")(function* (input: PaGetMessagesInput) {
    const { instance, agentRef } = yield* resolveBot(input.botId);
    return yield* fromPromise(() =>
      instance.getMessages(agentRef, input.sessionId, input.limit ?? DEFAULT_MESSAGE_LIMIT),
    );
  });

  const requiredScopeForMessage = Effect.fn("PaService.requiredScopeForMessage")(function* (
    botId: string,
    text: string,
  ) {
    const { instance } = yield* resolveBot(botId);
    if (instance.commands) return instance.commands.requiredScope(text);
    // An engine that declares no command policy gets the conservative reading of a command.
    return text.trimStart().startsWith("/") ? ("manage" as const) : ("operate" as const);
  });

  const sendMessage = Effect.fn("PaService.sendMessage")(function* (input: PaSendMessageInput) {
    const { instance, agentRef, botId } = yield* resolveBot(input.botId);
    const result = yield* fromPromise(() =>
      instance.sendMessage(agentRef, input.sessionId, input.text, { inputId: input.inputId }),
    );
    if (result.kind === "output" && result.output) {
      // The engine keeps no record of a command's output: other viewers see it from the feed.
      hubs.get(hubKey(botId, input.sessionId))?.publishNotice(result.output, input.inputId);
    }
    return result;
  });

  const interruptSession = Effect.fn("PaService.interruptSession")(function* (input: {
    readonly botId: string;
    readonly sessionId: string;
  }) {
    const { instance, agentRef } = yield* resolveBot(input.botId);
    const interrupt = instance.interruptSession;
    if (!interrupt || !instance.capabilities.execution.interrupt) {
      return yield* unsupported(instance, "stopping a turn");
    }
    yield* fromPromise(() => interrupt(agentRef, input.sessionId));
  });

  const respondRequest = Effect.fn("PaService.respondRequest")(function* (
    input: PaRespondRequestInput,
  ) {
    const { instance, agentRef, botId } = yield* resolveBot(input.botId);
    const requests = yield* facet(instance, "requests", "approvals");
    const { botId: _botId, sessionId, ...answer } = input;
    yield* fromPromise(() => requests.respond(agentRef, sessionId, answer));
    // The engine's own settle event may come late or never: the answered card leaves every viewer now.
    hubs.get(hubKey(botId, sessionId))?.resolveRequest(input.requestId);
  });

  const hubFor = (
    instance: PaEngineInstance,
    agentRef: string,
    botId: string,
    sessionId: string,
  ) => {
    const key = hubKey(botId, sessionId);
    const existing = hubs.get(key);
    if (existing) return existing;
    const hub: PaSessionHub = new PaSessionHub(
      sessionId,
      (subscriber, feedOptions) =>
        instance.subscribeSession(agentRef, sessionId, subscriber, feedOptions),
      hubOptions,
      () => {
        if (hubs.get(key) === hub) hubs.delete(key);
      },
    );
    hubs.set(key, hub);
    return hub;
  };

  const subscribeSession = (input: PaSubscribeSessionInput) =>
    Stream.unwrap(
      resolveBot(input.botId).pipe(
        Effect.map(({ instance, agentRef, botId }) =>
          Stream.callback<PaStreamEvent, PaError>(
            (queue) =>
              Effect.acquireRelease(
                fromPromise(() =>
                  hubFor(instance, agentRef, botId, input.sessionId).attach(
                    {
                      onEvent: (event) => {
                        if (!Queue.offerUnsafe(queue, event)) {
                          // A slow reader must not silently lose events: cut it off so it
                          // resumes from the last token it applied.
                          Queue.failCauseUnsafe(
                            queue,
                            Cause.fail(
                              new PaError({
                                reason: "Unavailable",
                                message: "The session stream fell behind; reconnecting.",
                              }),
                            ),
                          );
                        }
                      },
                      onFail: (error) => {
                        Queue.failCauseUnsafe(queue, Cause.fail(error));
                      },
                    },
                    input.resumeToken,
                  ),
                ),
                (detach) => Effect.sync(detach),
              ),
            { bufferSize: subscriberBuffer, strategy: "dropping" },
          ),
        ),
      ),
    ).pipe(Stream.withSpan("PaService.subscribeSession"));

  return {
    listBots,
    createBot,
    updateBotMeta,
    getBotModels,
    selectBotModel,
    getBotConfig,
    patchBotConfig,
    listSchedules,
    mutateSchedule,
    listCommands,
    listSessions,
    createSession,
    getMessages,
    requiredScopeForMessage,
    sendMessage,
    interruptSession,
    respondRequest,
    subscribeSession,
    dispose: () => {
      for (const hub of Array.from(hubs.values())) hub.dispose();
      for (const instance of instances.values()) instance.dispose?.();
    },
  };
}

export const layer = Layer.effect(
  PaService,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const service = makePaService({
      store: new PaStore(config.stateDir),
      instances: [new HermesPaAdapter()],
    });
    yield* Effect.addFinalizer(() => Effect.sync(service.dispose));
    return service;
  }),
);
