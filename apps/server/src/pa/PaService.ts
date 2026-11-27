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
  type PaGetMessagesResult,
  type PaInstanceStatus,
  type PaListBotsResult,
  type PaListSessionsInput,
  type PaListSessionsResult,
  type PaManageQueuedItemInput,
  type PaModelCatalog,
  type PaMutateScheduleInput,
  type PaMutateSessionInput,
  type PaMutateSessionResult,
  type PaPatchBotConfigInput,
  type PaRespondRequestInput,
  type PaSchedule,
  type PaSelectBotModelInput,
  type PaSelectBotModelResult,
  type PaSendMessageInput,
  type PaSendResult,
  type PaSessionSummary,
  type PaSlashCommand,
  type PaSteerSessionInput,
  type PaSteerSessionResult,
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
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import * as ServerConfig from "../config.ts";
import { HermesPaAdapter } from "./adapters/hermes/HermesPaAdapter.ts";
import { DEFAULT_PA_HUB_OPTIONS, PaSessionHub, type PaHubOptions } from "./PaSessionHub.ts";
import { defaultVisualForBot, PaStore } from "./PaStore.ts";
import { PaAttachmentStore } from "./PaAttachmentStore.ts";
import { isPaInputRefusal } from "./types.ts";
import type { PaAgentRow, PaCommandScope, PaEngineInstance } from "./types.ts";

function nowMs(): number {
  // @effect-diagnostics globalDate:off
  return Date.now();
}

const DEFAULT_MESSAGE_LIMIT = 120;
const DEFAULT_SESSION_LIMIT = 30;

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

function legacyEvent(event: PaStreamEvent): PaStreamEvent | null {
  switch (event.type) {
    case "queue.updated":
    case "usage.updated":
    case "todos.updated":
      return null;
    case "request.opened":
      return event.request.kind === "secret" ? null : event;
    case "snapshot":
      return {
        type: "snapshot",
        sessionId: event.sessionId,
        resumeToken: event.resumeToken,
        running: event.running,
        snapshotRequired: event.snapshotRequired,
        openRequests: event.openRequests.filter((request) => request.kind !== "secret"),
      };
    default:
      return event;
  }
}

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
  readonly listSessions: (
    input: PaListSessionsInput,
  ) => Effect.Effect<PaListSessionsResult, PaError>;
  readonly createSession: (input: PaCreateSessionInput) => Effect.Effect<PaSessionSummary, PaError>;
  readonly mutateSession: (
    input: PaMutateSessionInput,
  ) => Effect.Effect<PaMutateSessionResult, PaError>;
  readonly getMessages: (input: PaGetMessagesInput) => Effect.Effect<PaGetMessagesResult, PaError>;
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
  readonly steerSession: (
    input: PaSteerSessionInput,
  ) => Effect.Effect<PaSteerSessionResult, PaError>;
  readonly manageQueuedItem: (input: PaManageQueuedItemInput) => Effect.Effect<void, PaError>;
  /** The grant answering a request needs, from the kind the engine opened it as. */
  readonly requiredScopeForRequest: (input: {
    readonly botId: string;
    readonly sessionId: string;
    readonly requestId: string;
  }) => Effect.Effect<PaCommandScope, PaError>;
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
  readonly attachmentStore?: PaAttachmentStore;
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
    capabilities: {
      ...instance.capabilities,
      sessions: {
        ...instance.capabilities.sessions,
        renameExisting: instance.capabilities.sessions.rename && !!instance.renameSession,
      },
    },
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
        reasoningEffort: input.reasoningEffort,
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

  const listSessions = Effect.fn("PaService.listSessions")(function* (input: PaListSessionsInput) {
    const { instance, agentRef, botId } = yield* resolveBot(input.botId);
    const query = input.query?.trim() || undefined;
    const page = yield* fromPromise(() =>
      instance.listSessions(agentRef, {
        query,
        cursor: input.cursor,
        limit: input.limit ?? DEFAULT_SESSION_LIMIT,
      }),
    );
    const primarySessionId = store.getBotMeta(botId).primarySessionId ?? null;
    const sessions: PaSessionSummary[] = page.sessions.map((row) => ({
      ...row,
      isPrimary: row.sessionId === primarySessionId,
    }));
    // A just-created primary session is not listed until its first message is stored.
    if (
      primarySessionId &&
      input.cursor === undefined &&
      query === undefined &&
      !sessions.some((s) => s.sessionId === primarySessionId)
    ) {
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
    return { primarySessionId, sessions, nextCursor: page.nextCursor };
  });

  const createSession = Effect.fn("PaService.createSession")(function* (
    input: PaCreateSessionInput,
  ) {
    const { instance, agentRef, botId } = yield* resolveBot(input.botId);
    if (!instance.capabilities.sessions.create) {
      return yield* unsupported(instance, "new sessions");
    }
    const title = instance.capabilities.sessions.rename ? input.title : undefined;
    const created = yield* fromPromise(() =>
      instance.createSession(agentRef, { title, requestId: input.requestId }),
    );
    const setPrimary = input.setPrimary !== false;
    if (setPrimary) {
      yield* fromSync(() =>
        store.updateBotMeta(botId, { primarySessionId: created.sessionId, lastReadAt: nowMs() }),
      );
    }
    return { ...created, isPrimary: setPrimary };
  });

  const mutateSession = Effect.fn("PaService.mutateSession")(function* (
    input: PaMutateSessionInput,
  ) {
    const { instance, agentRef, botId } = yield* resolveBot(input.botId);
    const rename = instance.renameSession;
    if (!rename || !instance.capabilities.sessions.rename) {
      return yield* unsupported(instance, "renaming sessions");
    }
    const title = input.title.trim();
    if (!title) {
      return yield* new PaError({ reason: "Invalid", message: "A title cannot be empty" });
    }
    const renamed = yield* fromPromise(() =>
      rename(agentRef, input.sessionId, { title, requestId: input.requestId }),
    );
    // Other viewers of the session see the new title without reloading.
    hubs.get(hubKey(botId, input.sessionId))?.publishSessionUpdated({ title: renamed.title });
    return { sessionId: input.sessionId, title: renamed.title };
  });

  const attachmentSession = async (
    instance: PaEngineInstance,
    agentRef: string,
    botId: string,
    sessionId: string,
    readOnly = false,
  ) => {
    const ownerId =
      (await instance.attachmentSessionId?.(agentRef, sessionId, readOnly)) ?? sessionId;
    if (ownerId !== sessionId) options.attachmentStore?.bindSession(botId, sessionId, ownerId);
    return ownerId;
  };

  const getMessages = Effect.fn("PaService.getMessages")(function* (input: PaGetMessagesInput) {
    const { instance, agentRef } = yield* resolveBot(input.botId);
    const page = yield* fromPromise(() =>
      instance.getMessages(agentRef, input.sessionId, {
        limit: input.limit ?? DEFAULT_MESSAGE_LIMIT,
        cursor: input.cursor,
      }),
    );
    return {
      messages: yield* fromPromise(async () => {
        const storage = options.attachmentStore;
        if (!storage) return page.messages;
        if (!page.messages.some((row) => row.role === "user")) return page.messages;
        const ownerId = storage.needsOwnerLookup(input.botId, input.sessionId)
          ? await attachmentSession(instance, agentRef, input.botId, input.sessionId, true).catch(
              () => input.sessionId,
            )
          : input.sessionId;
        return storage.hydrate(input.botId, ownerId, page.messages);
      }).pipe(
        Effect.catch(() =>
          Effect.logWarning("PA attachment history could not be hydrated").pipe(
            Effect.as(page.messages),
          ),
        ),
      ),
      nextCursor: page.nextCursor,
      ...(page.reset ? { reset: true } : {}),
    };
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
    const uploads = input.attachments ?? [];
    if (!input.text.trim() && !uploads.length)
      return yield* new PaError({ reason: "Invalid", message: "Message cannot be empty" });
    const caps = instance.capabilities.attachments;
    const storage = options.attachmentStore;
    const inputId = input.inputId?.trim() || (uploads.length ? NodeCrypto.randomUUID() : undefined);
    if (uploads.length && (!caps || !storage)) return yield* unsupported(instance, "attachments");
    const sessionKey = uploads.length
      ? yield* fromPromise(() => attachmentSession(instance, agentRef, botId, input.sessionId))
      : input.sessionId;
    const priorClaim =
      storage && uploads.length && inputId
        ? yield* fromSync(() => storage.find(botId, sessionKey, inputId))
        : undefined;
    const local =
      inputId && uploads.length && caps && storage
        ? yield* fromPromise(() =>
            storage.claim(botId, sessionKey, inputId, input.text.trim(), uploads, caps),
          )
        : [];
    const result = yield* fromPromise(() =>
      instance.sendMessage(agentRef, input.sessionId, input.text, {
        inputId,
        queued: input.queued,
        ...(local.length && storage && inputId
          ? {
              attachments: local,
              staged: storage.find(botId, sessionKey, inputId)?.staged ?? [],
              onStaged: (staged) =>
                storage.record(botId, sessionKey, inputId, {
                  staged,
                  referenceKeys: staged.map((part) => part.key),
                }),
            }
          : {}),
      }),
    ).pipe(
      Effect.tapError((err) => {
        if (
          !local.length ||
          !inputId ||
          !storage ||
          !isPaInputRefusal(err, priorClaim === undefined)
        )
          return Effect.void;
        return fromSync(() => storage.unclaim(botId, sessionKey, inputId));
      }),
    );
    if (result.kind === "output" && local.length && storage && inputId)
      yield* fromSync(() => storage.unclaim(botId, sessionKey, inputId));
    if (result.kind === "turn" && local.length && storage && inputId) {
      const submissionId = result.submissionId;
      if (submissionId) {
        yield* fromSync(() =>
          storage.record(botId, sessionKey, inputId, {
            submissionId,
            ...(result.admissionId ? { admissionId: result.admissionId } : {}),
          }),
        ).pipe(
          Effect.catch(() => Effect.logWarning("PA attachment admission could not be recorded")),
        );
        hubs
          .get(hubKey(botId, input.sessionId))
          ?.describeQueuedAttachments(
            result.admissionId ?? submissionId,
            input.text.trim().slice(0, 1024),
            local.length,
          );
      }
      return { ...result, attachments: local.map((item) => item.metadata) };
    }
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

  const steerSession = Effect.fn("PaService.steerSession")(function* (input: PaSteerSessionInput) {
    const { instance, agentRef } = yield* resolveBot(input.botId);
    const steer = instance.steerSession;
    if (!steer || instance.capabilities.execution.steer !== true) {
      return yield* unsupported(instance, "steering a running turn");
    }
    return yield* fromPromise(() => steer(agentRef, input.sessionId, input.text));
  });

  const manageQueuedItem = Effect.fn("PaService.manageQueuedItem")(function* (
    input: PaManageQueuedItemInput,
  ) {
    const { instance, agentRef } = yield* resolveBot(input.botId);
    const manage = instance.manageQueuedItem;
    const { execution } = instance.capabilities;
    if (!manage || execution.queue !== true) {
      return yield* unsupported(instance, "queued messages");
    }
    if (input.action === "steer" && execution.steer !== true) {
      return yield* unsupported(instance, "steering a running turn");
    }
    const sessionKey = options.attachmentStore
      ? yield* fromPromise(() =>
          attachmentSession(instance, agentRef, input.botId, input.sessionId),
        )
      : input.sessionId;
    const checkSteerInput = (id: string) => {
      if (options.attachmentStore?.find(input.botId, sessionKey, id)?.attachments.length)
        throw new PaError({
          reason: "Unsupported",
          message: "Queued attachments cannot be steered",
        });
    };
    if (input.action === "steer") yield* fromSync(() => checkSteerInput(input.itemId));
    const journalInputId =
      input.action === "cancel" && options.attachmentStore
        ? yield* fromSync(
            () => options.attachmentStore?.find(input.botId, sessionKey, input.itemId)?.inputId,
          ).pipe(
            Effect.catch(() =>
              Effect.logWarning("PA attachment queue metadata is unavailable").pipe(
                Effect.as(undefined),
              ),
            ),
          )
        : undefined;
    const result = yield* fromPromise(() =>
      manage(
        agentRef,
        input.sessionId,
        { itemId: input.itemId, action: input.action },
        checkSteerInput,
        journalInputId,
      ),
    );
    if (result && input.action === "cancel") {
      yield* fromSync(() => {
        const storage = options.attachmentStore;
        const record =
          storage?.find(input.botId, sessionKey, input.itemId) ??
          storage?.find(input.botId, sessionKey, result.cancelledInputId);
        if (record) storage?.unclaim(input.botId, sessionKey, record.inputId, true);
      }).pipe(
        Effect.catch(() => Effect.logWarning("Cancelled PA attachments could not be removed")),
      );
    }
  });

  const requiredScopeForRequest = Effect.fn("PaService.requiredScopeForRequest")(function* (input: {
    readonly botId: string;
    readonly sessionId: string;
    readonly requestId: string;
  }) {
    const { instance, agentRef, botId } = yield* resolveBot(input.botId);
    const kind =
      instance.requests?.kindOf?.(agentRef, input.sessionId, input.requestId) ??
      hubs.get(hubKey(botId, input.sessionId))?.openRequestKind(input.requestId) ??
      null;
    // Credentials land in the agent's config or unlock its vault: the bar of editing that config.
    return kind === "secret" ? ("manage" as const) : ("operate" as const);
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
    let ownerId = sessionId;
    const hub: PaSessionHub = new PaSessionHub(
      sessionId,
      (subscriber, feedOptions) =>
        instance.subscribeSession(
          agentRef,
          sessionId,
          {
            ...subscriber,
            onAttachmentSession: (id) => {
              ownerId = id;
              try {
                options.attachmentStore?.bindSession(botId, sessionId, id);
              } catch {
                process.emitWarning("PA attachment session alias could not be recorded");
              }
            },
            onUserRowPersisted: (inputId, rowId) => {
              try {
                options.attachmentStore?.record(botId, ownerId, inputId, { rowId });
              } catch {
                process.emitWarning("PA attachment receipt could not be recorded");
              }
            },
            onEvent: (event) => {
              const storage = options.attachmentStore;
              let enriched = event;
              try {
                if (storage && event.type === "queue.updated" && event.items.length) {
                  enriched = { ...event, items: storage.queue(botId, ownerId, event.items) };
                } else if (storage && event.type === "snapshot" && event.queuedItems?.length) {
                  enriched = {
                    ...event,
                    queuedItems: storage.queue(botId, ownerId, event.queuedItems),
                  };
                }
              } catch {
                process.emitWarning("PA attachment queue metadata is unavailable");
              }
              subscriber.onEvent(enriched);
            },
          },
          feedOptions,
        ),
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
                        const compatible =
                          (input.protocolVersion ?? 1) >= 2 ? event : legacyEvent(event);
                        if (!compatible) return;
                        if (!Queue.offerUnsafe(queue, compatible)) {
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
    mutateSession,
    getMessages,
    requiredScopeForMessage,
    sendMessage,
    interruptSession,
    steerSession,
    manageQueuedItem,
    requiredScopeForRequest,
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
    const store = new PaStore(config.stateDir);
    const service = makePaService({
      store,
      attachmentStore: new PaAttachmentStore(config.stateDir, config.attachmentsDir),
      instances: [new HermesPaAdapter({ store })],
    });
    yield* Effect.addFinalizer(() => Effect.sync(service.dispose));
    return service;
  }),
);
