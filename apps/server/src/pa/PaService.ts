import {
  makePaBotId,
  PaError,
  parsePaBotId,
  paProfileDescription,
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
import * as Fiber from "effect/Fiber";
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
import { isPaInputRefusal, latestTranscriptReply } from "./types.ts";
import type { PaAgentRow, PaCommandScope, PaEngineInstance } from "./types.ts";

function nowMs(): number {
  // @effect-diagnostics globalDate:off
  return Date.now();
}

const DEFAULT_MESSAGE_LIMIT = 120;
const INITIAL_SUBSCRIBE_MESSAGE_LIMIT = 50;
const DEFAULT_SESSION_LIMIT = 30;
const PRODUCTION_ROSTER_CACHE_TTL_MS = 2_000;

function computePaPageTag(page: PaGetMessagesResult): string {
  return NodeCrypto.createHash("sha256")
    .update(JSON.stringify([page.nextCursor ?? null, page.messages]))
    .digest("base64url")
    .slice(0, 32);
}

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
  /** Short TTL for reusing recent roster rows across rapid polls/surfaces; 0 disables. */
  readonly rosterCacheTtlMs?: number;
}): PaServiceInternals {
  const { store } = options;
  const instances = new Map(options.instances.map((instance) => [instance.instanceId, instance]));
  const hubs = new Map<string, PaSessionHub>();
  const botHubs = new Map<string, Set<PaSessionHub>>();
  const instanceReads = new Map<string, Promise<ReadonlyArray<PaAgentRow>>>();
  const lastRosters = new Map<string, ReadonlyArray<PaAgentRow>>();
  const lastRosterAt = new Map<string, number>();
  const rosterCacheTtlMs = Math.max(0, options.rosterCacheTtlMs ?? 0);
  const hubOwners = new Map<string, string>();
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
    const sessions = Array.from(botHubs.get(botId) ?? []);
    const running = row.running || sessions.some((hub) => hub.isRunning);
    const awaiting =
      Array.from(row.activeSessions?.values() ?? []).includes("waiting") ||
      sessions.some((hub) => hub.awaiting);
    const completedAt = Math.max(meta.lastCompletedAt ?? 0, row.lastReplyAt ?? 0);
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
      running,
      awaiting,
      unread:
        (!running || awaiting) &&
        (completedAt > (meta.lastReadAt ?? 0) ||
          meta.replies?.some((reply) => !reply.read) === true ||
          meta.progress?.some((entry) => entry.unread !== undefined) === true),
      lastMessagePreview: row.lastMessagePreview,
      // A Bot with no activity yet is dated by when it was made, or else first opened here.
      lastActivityAt:
        Math.max(row.lastActivityAt ?? 0, completedAt) || meta.createdAt || meta.lastReadAt || null,
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

  const ownerFor = (botId: string, sessionId: string) =>
    hubOwners.get(hubKey(botId, sessionId)) ?? sessionId;

  const readRoster = (instance: PaEngineInstance) => {
    const id = instance.instanceId;
    const held = instanceReads.get(id);
    if (held) return held;
    const revisions = new Map(Array.from(hubs.values(), (hub) => [hub, hub.activityRevision]));
    const read = instance
      .listAgents()
      .then(async (rows) => {
        if (instanceReads.get(id) !== read) return rows;
        const cached = new Map(lastRosters.get(id)?.map((row) => [row.agentRef, row]));
        const confirmed: PaAgentRow[] = [];
        const present = new Set<string>();
        for (const row of rows) {
          const botId = makePaBotId(id, row.agentRef);
          present.add(botId);
          store.rememberReplies(
            botId,
            (row.replies ?? []).map((reply) => ({
              ...reply,
              sessionId: ownerFor(botId, reply.sessionId),
            })),
            "history",
          );
          const prior = cached.get(row.agentRef);
          const activity =
            row.activeSessions === null ? (prior?.activeSessions ?? null) : row.activeSessions;
          let states = activity;
          if (row.activeSessions) {
            for (const hub of botHubs.get(botId) ?? []) {
              const stillDetached = () =>
                !hub.listenerCount &&
                revisions.get(hub) === hub.activityRevision &&
                instanceReads.get(id) === read;
              if (!stillDetached()) continue;
              const state = row.activeSessions.get(ownerFor(botId, hub.sessionId));
              if (
                hub.holdsActivity &&
                instance.refreshSessionActivity &&
                (state === undefined || (hub.awaiting && state !== "waiting"))
              ) {
                const snapshot = await instance
                  .refreshSessionActivity(row.agentRef, hub.sessionId, stillDetached)
                  .catch(() => undefined);
                if (snapshot && stillDetached()) {
                  const verified = snapshot.running ? "working" : "idle";
                  hub.reconcileDetached(verified, true, snapshot.openRequests);
                  if (state !== verified) {
                    states = new Map(states).set(ownerFor(botId, hub.sessionId), verified);
                  }
                }
              } else if (state || row.completeActivity)
                hub.reconcileDetached(state ?? "idle", row.completeActivity === true);
            }
          }
          if (row.activeSessions === null && prior) {
            confirmed.push({
              ...row,
              running: row.running || prior.running,
              activeSessions: states ?? null,
            });
          } else if (states && states !== row.activeSessions) {
            confirmed.push({
              ...row,
              running: [...states.values()].some((state) => state !== "idle"),
              activeSessions: states,
            });
          } else confirmed.push(row);
        }
        for (const [botId, sessions] of botHubs) {
          if (parsePaBotId(botId)?.instanceId === id && !present.has(botId))
            for (const hub of sessions) hub.removeBot();
        }
        if (instanceReads.get(id) === read) {
          lastRosters.set(id, confirmed);
          lastRosterAt.set(id, nowMs());
        }
        return confirmed;
      })
      .finally(() => {
        if (instanceReads.get(id) === read) instanceReads.delete(id);
      });
    instanceReads.set(id, read);
    return read;
  };

  const finishPriorRosterRead = (instance: PaEngineInstance) =>
    Effect.promise(async () => {
      await instanceReads.get(instance.instanceId)?.catch(() => undefined);
    });

  const listBots = Effect.fn("PaService.listBots")(function* () {
    const now = nowMs();
    const results = yield* Effect.forEach(
      Array.from(instances.values()),
      (instance) => {
        const cached = lastRosters.get(instance.instanceId);
        const cachedAt = lastRosterAt.get(instance.instanceId);
        if (
          rosterCacheTtlMs > 0 &&
          cached !== undefined &&
          cachedAt !== undefined &&
          now - cachedAt < rosterCacheTtlMs &&
          !instanceReads.has(instance.instanceId)
        ) {
          return Effect.succeed({
            status: status(instance, { botCount: cached.length, error: null }),
            bots: cached.map((row) => summarize(instance, row)),
          });
        }
        return fromPromise(() => readRoster(instance)).pipe(
          Effect.map((rows) => ({
            status: status(instance, { botCount: rows.length, error: null }),
            bots: rows.map((row) => summarize(instance, row)),
          })),
          Effect.catch((error) => {
            lastRosterAt.delete(instance.instanceId);
            const rows = lastRosters.get(instance.instanceId) ?? [];
            return Effect.succeed({
              status: status(instance, { botCount: rows.length, error: error.message }),
              bots: rows.map((row) => ({ ...summarize(instance, row), online: false })),
            });
          }),
        );
      },
      { concurrency: 3 },
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
    const createdAt = nowMs();
    yield* fromSync(() =>
      store.updateBotMeta(botId, {
        displayName: input.name?.trim() || agentRef,
        avatarColor: input.avatarColor,
        avatarShape: input.avatarShape,
        pinned: input.pinned ?? false,
        lastReadAt: createdAt,
        createdAt,
      }),
    );
    yield* finishPriorRosterRead(instance);
    lastRosterAt.delete(instance.instanceId);
    const rows = yield* fromPromise(() => readRoster(instance));
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
        ...(input.markRead === true
          ? store.readPatch(
              botId,
              nowMs(),
              input.seenReply && {
                ...input.seenReply,
                sessionId: ownerFor(botId, input.seenReply.sessionId),
              },
            )
          : {}),
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

  const patchCachedAgent = (
    instance: PaEngineInstance,
    agentRef: string,
    patch: Partial<PaAgentRow>,
  ) => {
    const rows = lastRosters.get(instance.instanceId);
    if (rows)
      lastRosters.set(
        instance.instanceId,
        rows.map((row) => (row.agentRef === agentRef ? { ...row, ...patch } : row)),
      );
  };

  const selectBotModel = Effect.fn("PaService.selectBotModel")(function* (
    input: PaSelectBotModelInput,
  ) {
    const { instance, agentRef } = yield* resolveBot(input.botId);
    const models = yield* facet(instance, "models", "model selection");
    const result = yield* fromPromise(() =>
      models.select(agentRef, {
        sessionId: input.sessionId,
        provider: input.provider,
        model: input.model,
        reasoningEffort: input.reasoningEffort,
        confirm: input.confirm === true,
      }),
    );
    if (result.status === "applied") {
      yield* finishPriorRosterRead(instance);
      if (instance.capabilities.models.scope === "agent" && input.model !== undefined) {
        const { model, provider } = result.current;
        patchCachedAgent(instance, agentRef, { model, provider });
      }
    }
    return result;
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
    const result = yield* fromPromise(() => config.patch(agentRef, input.sectionId, input.value));
    yield* finishPriorRosterRead(instance);
    const description = paProfileDescription(result);
    if (description !== undefined) patchCachedAgent(instance, agentRef, { description });
    return result;
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
        store.updateBotMeta(botId, {
          primarySessionId: created.sessionId,
        }),
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
    options.attachmentStore?.markOwnerKnown(botId, sessionId, ownerId);
    return ownerId;
  };

  const readMessagesPage = Effect.fn("PaService.readMessagesPage")(function* (
    instance: PaEngineInstance,
    agentRef: string,
    botId: string,
    sessionId: string,
    pageOptions: { readonly limit: number; readonly cursor?: string | undefined },
  ) {
    const page = yield* fromPromise(() => instance.getMessages(agentRef, sessionId, pageOptions));
    const knownOwner = ownerFor(botId, sessionId);
    const reply = !pageOptions.cursor && latestTranscriptReply(knownOwner, page.messages);
    if (reply) yield* fromSync(() => store.rememberReplies(botId, [reply], "history"));
    const messages = yield* fromPromise(async () => {
      const storage = options.attachmentStore;
      if (!storage) return page.messages;
      if (!page.messages.some((row) => row.role === "user")) return page.messages;
      const ownerId =
        knownOwner !== sessionId
          ? knownOwner
          : storage.needsOwnerLookup(botId, sessionId)
            ? await attachmentSession(instance, agentRef, botId, sessionId, true).catch(
                () => sessionId,
              )
            : sessionId;
      return storage.hydrate(botId, ownerId, page.messages);
    }).pipe(
      Effect.catch(() =>
        Effect.logWarning("PA attachment history could not be hydrated").pipe(
          Effect.as(page.messages),
        ),
      ),
    );
    const result: PaGetMessagesResult = {
      messages,
      nextCursor: page.nextCursor,
      ...(page.reset ? { reset: true } : {}),
    };
    return pageOptions.cursor === undefined
      ? { ...result, pageTag: computePaPageTag(result) }
      : result;
  });

  const getMessages = Effect.fn("PaService.getMessages")(function* (input: PaGetMessagesInput) {
    const { instance, agentRef } = yield* resolveBot(input.botId);
    return yield* readMessagesPage(instance, agentRef, input.botId, input.sessionId, {
      limit: input.limit ?? DEFAULT_MESSAGE_LIMIT,
      cursor: input.cursor,
    });
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
    const feed = hubs.get(hubKey(botId, input.sessionId));
    const priorRevision = feed?.currentTurnRevision;
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
    if (
      result.kind === "turn" &&
      !result.settled &&
      !result.unknown &&
      !result.queued &&
      priorRevision !== undefined
    )
      feed?.admittedTurn(priorRevision);
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

  const settleRequests = (
    botId: string,
    owner: string,
    requestId: string,
    except?: PaSessionHub,
  ) => {
    for (const hub of botHubs.get(botId) ?? []) {
      if (hub !== except && ownerFor(botId, hub.sessionId) === owner) hub.resolveRequest(requestId);
    }
  };

  const respondRequest = Effect.fn("PaService.respondRequest")(function* (
    input: PaRespondRequestInput,
  ) {
    const { instance, agentRef, botId } = yield* resolveBot(input.botId);
    const requests = yield* facet(instance, "requests", "approvals");
    const { botId: _botId, sessionId, ...answer } = input;
    const owner = ownerFor(botId, sessionId);
    yield* fromPromise(() => requests.respond(agentRef, sessionId, answer)).pipe(
      Effect.tapError((error) =>
        Effect.sync(() => {
          if (
            error.reason === "Conflict" &&
            requests.kindOf?.(agentRef, sessionId, input.requestId) === null
          )
            settleRequests(botId, owner, input.requestId);
        }),
      ),
    );
    settleRequests(botId, owner, input.requestId);
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
    let checkingHistory = false;
    let checkAgain = false;
    const checkHistory = async () => {
      if (checkingHistory) {
        checkAgain = true;
        return;
      }
      checkingHistory = true;
      try {
        do {
          checkAgain = false;
          const page = await instance.getMessages(agentRef, sessionId, { limit: 32 });
          const reply = latestTranscriptReply(ownerId, page.messages);
          if (reply && hubs.get(key) === hub) store.rememberReplies(botId, [reply], "history");
        } while (checkAgain && hubs.get(key) === hub);
      } catch {
        // The next roster or transcript read retries against durable history.
      } finally {
        checkingHistory = false;
      }
    };
    const hub: PaSessionHub = new PaSessionHub(
      sessionId,
      (subscriber, feedOptions) =>
        instance.subscribeSession(
          agentRef,
          sessionId,
          {
            ...subscriber,
            onCanonicalSession: (id) => {
              hubOwners.set(key, id);
              ownerId = id;
              try {
                store.bindReplySession(botId, sessionId, id);
                options.attachmentStore?.markOwnerKnown(botId, sessionId, id);
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
              if (
                event.type === "turn.completed" &&
                event.replyId &&
                (event.status !== "interrupted" || event.text?.trim())
              ) {
                const { replyAliases = [], ...completion } = event;
                enriched = completion;
                try {
                  const identified = store.rememberReplies(
                    botId,
                    [
                      {
                        sessionId: ownerId,
                        ids: [event.replyId, ...replyAliases],
                        timestamp: nowMs(),
                      },
                    ],
                    "feed",
                  );
                  if (!identified) void checkHistory();
                } catch {
                  process.emitWarning("PA turn completion could not be recorded");
                }
              }
              if (
                event.type === "turn.completed" &&
                !event.replyId &&
                (event.status !== "interrupted" || event.text?.trim())
              )
                void checkHistory();
              subscriber.onEvent(enriched);
              if (
                event.type === "turn.completed" ||
                event.type === "error" ||
                event.type === "request.opened" ||
                event.type === "request.resolved"
              ) {
                lastRosterAt.delete(instance.instanceId);
              }
              if (event.type === "request.resolved")
                settleRequests(botId, ownerId, event.requestId, hubs.get(key));
            },
          },
          feedOptions,
        ),
      hubOptions,
      () => {
        if (hubs.get(key) === hub) hubs.delete(key);
        const sessions = botHubs.get(botId);
        sessions?.delete(hub);
        if (sessions?.size === 0) botHubs.delete(botId);
      },
    );
    hubs.set(key, hub);
    const sessions = botHubs.get(botId) ?? new Set<PaSessionHub>();
    sessions.add(hub);
    botHubs.set(botId, sessions);
    return hub;
  };

  const subscribeSession = (input: PaSubscribeSessionInput) =>
    Stream.unwrap(
      resolveBot(input.botId).pipe(
        Effect.map(({ instance, agentRef, botId }) =>
          Stream.callback<PaStreamEvent, PaError>(
            (queue) =>
              Effect.gen(function* () {
                const runFork = Effect.runForkWith(yield* Effect.context<never>());
                const protocolVersion = input.protocolVersion ?? 1;
                const latestPage = input.latestPage;
                let detached = false;
                let bootstrapping = latestPage !== undefined;
                let attachSnapshotSeen = false;
                let maxHeldAfter = subscriberBuffer;
                let pageFiber: Fiber.Fiber<void, never> | null = null;
                const heldBeforeSnapshot: PaStreamEvent[] = [];
                const heldAfterSnapshot: PaStreamEvent[] = [];

                const failLagging = () => {
                  detached = true;
                  if (pageFiber) {
                    const active = pageFiber;
                    pageFiber = null;
                    runFork(Fiber.interrupt(active));
                  }
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
                };

                const emit = (event: PaStreamEvent): boolean => {
                  if (detached) return false;
                  const compatible = protocolVersion >= 2 ? event : legacyEvent(event);
                  if (!compatible) return true;
                  if (!Queue.offerUnsafe(queue, compatible)) {
                    failLagging();
                    return false;
                  }
                  return true;
                };

                const tagSnapshot = (
                  snapshot: Extract<PaStreamEvent, { type: "snapshot" }>,
                ): Extract<PaStreamEvent, { type: "snapshot" }> =>
                  protocolVersion >= 3 ? { ...snapshot, protocolVersion: 3 } : snapshot;

                const flushBootstrap = (
                  pre: ReadonlyArray<PaStreamEvent>,
                  snapshot: Extract<PaStreamEvent, { type: "snapshot" }>,
                  post: ReadonlyArray<PaStreamEvent>,
                ) => {
                  bootstrapping = false;
                  for (const event of pre) if (!emit(event)) return;
                  if (!emit(snapshot)) return;
                  for (const event of post) if (!emit(event)) return;
                };

                const handleAttachSnapshot = (
                  event: Extract<PaStreamEvent, { type: "snapshot" }>,
                ) => {
                  if (detached) return;
                  const stamped = tagSnapshot(event);
                  if (!bootstrapping) {
                    emit(stamped);
                    return;
                  }
                  attachSnapshotSeen = true;
                  const lastTerminalIndex = heldBeforeSnapshot.findLastIndex(
                    (entry) => entry.type === "turn.completed" || entry.type === "error",
                  );
                  const sawReplayTerminal = lastTerminalIndex >= 0;
                  const needsPage =
                    input.resumeToken === undefined ||
                    stamped.snapshotRequired ||
                    sawReplayTerminal;
                  if (!needsPage) {
                    flushBootstrap(heldBeforeSnapshot, stamped, []);
                    return;
                  }
                  const limit = latestPage?.limit ?? INITIAL_SUBSCRIBE_MESSAGE_LIMIT;
                  const knownPageTag = latestPage?.knownPageTag;
                  // Keep non-turn-scoped events (command notices, title/model updates) even when
                  // earlier turns are superseded by the bundled latest page.
                  const pre = sawReplayTerminal
                    ? heldBeforeSnapshot.filter(
                        (entry, idx) =>
                          idx > lastTerminalIndex ||
                          entry.type === "notice" ||
                          entry.type === "session.updated",
                      )
                    : heldBeforeSnapshot;
                  maxHeldAfter = Math.max(0, subscriberBuffer - heldBeforeSnapshot.length - 1);
                  pageFiber = runFork(
                    readMessagesPage(instance, agentRef, botId, input.sessionId, { limit }).pipe(
                      Effect.match({
                        onSuccess: (page) => {
                          pageFiber = null;
                          if (detached) return;
                          const pageTag = page.pageTag ?? computePaPageTag(page);
                          const enrichedSnapshot: Extract<PaStreamEvent, { type: "snapshot" }> =
                            knownPageTag !== undefined && knownPageTag === pageTag
                              ? { ...stamped, pageTag, pageUnchanged: true }
                              : { ...stamped, page, pageTag };
                          flushBootstrap(pre, enrichedSnapshot, heldAfterSnapshot);
                        },
                        onFailure: () => {
                          pageFiber = null;
                          if (detached) return;
                          // On a history read failure, still deliver the live snapshot so the client falls back.
                          flushBootstrap(heldBeforeSnapshot, stamped, heldAfterSnapshot);
                        },
                      }),
                    ),
                  );
                };

                yield* Effect.acquireRelease(
                  fromPromise(() =>
                    hubFor(instance, agentRef, botId, input.sessionId).attach(
                      {
                        onEvent: (event) => {
                          if (detached) return;
                          if (!bootstrapping) {
                            emit(event);
                            return;
                          }
                          if (!attachSnapshotSeen) {
                            heldBeforeSnapshot.push(event);
                            return;
                          }
                          if (heldAfterSnapshot.length >= maxHeldAfter) {
                            failLagging();
                            return;
                          }
                          heldAfterSnapshot.push(event);
                        },
                        onAttachSnapshot: handleAttachSnapshot,
                        onFail: (error) => {
                          detached = true;
                          if (pageFiber) {
                            const active = pageFiber;
                            pageFiber = null;
                            runFork(Fiber.interrupt(active));
                          }
                          Queue.failCauseUnsafe(queue, Cause.fail(error));
                        },
                      },
                      input.resumeToken,
                      { replayBeforeSnapshot: protocolVersion >= 3 },
                    ),
                  ),
                  (detach) =>
                    Effect.sync(() => {
                      detached = true;
                      detach();
                      if (pageFiber) {
                        const active = pageFiber;
                        pageFiber = null;
                        runFork(Fiber.interrupt(active));
                      }
                    }),
                );
              }),
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
      instanceReads.clear();
      lastRosters.clear();
      lastRosterAt.clear();
      hubOwners.clear();
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
      rosterCacheTtlMs: PRODUCTION_ROSTER_CACHE_TTL_MS,
    });
    yield* Effect.addFinalizer(() => Effect.sync(service.dispose));
    return service;
  }),
);
