import {
  EnvironmentId,
  PaBotId,
  PaGetMessagesResult,
  PaListBotsResult,
  PaSessionId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { Atom, AtomRegistry } from "effect/reactivity";

import { provideAtomRuntime } from "../state/runtime.ts";

const PA_CACHE_SCHEMA_VERSION = 1 as const;
export const PA_INITIAL_PAGE_LIMIT = 50;
export const PA_SESSION_CACHE_MAX_BYTES = 512 * 1024;

export class PaCacheStore extends Context.Reference<{
  readonly load: (
    environmentId: EnvironmentId,
    key: string,
  ) => Effect.Effect<Option.Option<string>>;
  readonly save: (
    environmentId: EnvironmentId,
    key: string,
    payload: string,
  ) => Effect.Effect<void>;
  readonly remove: (environmentId: EnvironmentId, key: string) => Effect.Effect<void>;
  readonly removePrefix: (environmentId: EnvironmentId, prefix: string) => Effect.Effect<void>;
} | null>("@t3tools/client-runtime/PaCacheStore", {
  defaultValue: () => null,
}) {}

export const StoredPaRoster = Schema.Struct({
  schemaVersion: Schema.Literal(PA_CACHE_SCHEMA_VERSION),
  environmentId: EnvironmentId,
  result: PaListBotsResult,
  lastSessionByBot: Schema.Record(Schema.String, Schema.String),
  lastBotId: Schema.optionalKey(Schema.NullOr(Schema.String)),
  savedAt: Schema.Number,
});
export type StoredPaRoster = typeof StoredPaRoster.Type;

export const StoredPaSession = Schema.Struct({
  schemaVersion: Schema.Literal(PA_CACHE_SCHEMA_VERSION),
  environmentId: EnvironmentId,
  botId: PaBotId,
  sessionId: PaSessionId,
  page: PaGetMessagesResult,
  pageTag: Schema.NullOr(Schema.String),
  savedAt: Schema.Number,
});
export type StoredPaSession = typeof StoredPaSession.Type;

const StoredPaRosterJson = Schema.fromJsonString(Schema.toCodecJson(StoredPaRoster));
const StoredPaSessionJson = Schema.fromJsonString(Schema.toCodecJson(StoredPaSession));
const decodeStoredPaRoster = Schema.decodeEffect(StoredPaRosterJson);
const encodeStoredPaRoster = Schema.encodeEffect(StoredPaRosterJson);
const decodeStoredPaSession = Schema.decodeEffect(StoredPaSessionJson);
const encodeStoredPaSession = Schema.encodeEffect(StoredPaSessionJson);

const textEncoder = new TextEncoder();

export function paRosterCacheKey(): string {
  return "roster";
}

function paBotSessionCachePrefix(botId: string): string {
  return `session:${encodeURIComponent(botId)}:`;
}

export function paSessionCacheKey(botId: string, sessionId: string): string {
  return `${paBotSessionCachePrefix(botId)}${encodeURIComponent(sessionId)}`;
}

export interface PaCachedSessionData {
  readonly page: PaGetMessagesResult;
  readonly pageTag: string | null;
  readonly savedAt: number;
}

export interface PaCachedRosterData {
  readonly result: PaListBotsResult;
  readonly lastSessionByBot: Readonly<Record<string, string>>;
  readonly lastBotId: string | null;
  readonly savedAt: number;
}

export interface PaEnvironmentCache {
  readonly loadRoster: (environmentId: EnvironmentId) => Promise<PaCachedRosterData | null>;
  readonly saveRoster: (
    environmentId: EnvironmentId,
    data: Omit<PaCachedRosterData, "savedAt">,
  ) => Promise<void>;
  readonly removeEnvironment: (environmentId: EnvironmentId) => Promise<void>;
  readonly loadSession: (
    environmentId: EnvironmentId,
    botId: string,
    sessionId: string,
  ) => Promise<PaCachedSessionData | null>;
  readonly saveSession: (
    environmentId: EnvironmentId,
    botId: string,
    sessionId: string,
    page: PaGetMessagesResult,
    pageTag: string | null,
  ) => Promise<void>;
  readonly removeSession: (
    environmentId: EnvironmentId,
    botId: string,
    sessionId: string,
  ) => Promise<void>;
  readonly removeBotSessions: (environmentId: EnvironmentId, botId: string) => Promise<void>;
  readonly bumpEnvironmentGeneration: (environmentId: EnvironmentId) => void;
}

export function createPaEnvironmentCache<R, E>(
  registry: AtomRegistry.AtomRegistry,
  runtime: Atom.AtomRuntime<R, E>,
): PaEnvironmentCache {
  const generations = new Map<string, number>();
  const generationOf = (environmentId: EnvironmentId) => generations.get(environmentId) ?? 0;

  const run = <A>(effect: Effect.Effect<A>, fallback: A): Promise<A> =>
    Effect.runPromise(effect.pipe(provideAtomRuntime(registry, runtime))).catch(() => fallback);

  return {
    bumpEnvironmentGeneration(environmentId) {
      generations.set(environmentId, generationOf(environmentId) + 1);
    },
    loadRoster(environmentId) {
      const gen = generationOf(environmentId);
      return run(
        Effect.gen(function* () {
          const store = yield* PaCacheStore;
          if (store === null) return null;
          const key = paRosterCacheKey();
          const raw = yield* store.load(environmentId, key);
          if (Option.isNone(raw) || generationOf(environmentId) !== gen) return null;
          return yield* decodeStoredPaRoster(raw.value).pipe(
            Effect.flatMap((stored) => {
              if (stored.environmentId !== environmentId || generationOf(environmentId) !== gen) {
                return store.remove(environmentId, key).pipe(Effect.as(null));
              }
              return Effect.succeed<PaCachedRosterData>({
                result: stored.result,
                lastSessionByBot: stored.lastSessionByBot,
                lastBotId: stored.lastBotId ?? null,
                savedAt: stored.savedAt,
              });
            }),
            Effect.catch(() => store.remove(environmentId, key).pipe(Effect.as(null))),
          );
        }),
        null,
      );
    },
    saveRoster(environmentId, data) {
      const gen = generationOf(environmentId);
      return run(
        Effect.gen(function* () {
          const store = yield* PaCacheStore;
          if (store === null) return;
          const savedAt = yield* Clock.currentTimeMillis;
          const payload = yield* encodeStoredPaRoster({
            schemaVersion: PA_CACHE_SCHEMA_VERSION,
            environmentId,
            result: data.result,
            lastSessionByBot: { ...data.lastSessionByBot },
            lastBotId: data.lastBotId,
            savedAt,
          });
          if (generationOf(environmentId) !== gen) return;
          yield* store.save(environmentId, paRosterCacheKey(), payload);
        }).pipe(Effect.ignore),
        undefined,
      );
    },
    removeEnvironment(environmentId) {
      return run(
        Effect.gen(function* () {
          const store = yield* PaCacheStore;
          if (store === null) return;
          yield* store.removePrefix(environmentId, "");
        }),
        undefined,
      );
    },
    loadSession(environmentId, botId, sessionId) {
      const gen = generationOf(environmentId);
      return run(
        Effect.gen(function* () {
          const store = yield* PaCacheStore;
          if (store === null) return null;
          const key = paSessionCacheKey(botId, sessionId);
          const raw = yield* store.load(environmentId, key);
          if (Option.isNone(raw) || generationOf(environmentId) !== gen) return null;
          return yield* decodeStoredPaSession(raw.value).pipe(
            Effect.flatMap((stored) => {
              if (
                stored.environmentId !== environmentId ||
                stored.botId !== botId ||
                stored.sessionId !== sessionId ||
                generationOf(environmentId) !== gen
              ) {
                return store.remove(environmentId, key).pipe(Effect.as(null));
              }
              return Effect.succeed<PaCachedSessionData>({
                page: stored.page,
                pageTag: stored.pageTag,
                savedAt: stored.savedAt,
              });
            }),
            Effect.catch(() => store.remove(environmentId, key).pipe(Effect.as(null))),
          );
        }),
        null,
      );
    },
    saveSession(environmentId, botId, sessionId, page, pageTag) {
      const gen = generationOf(environmentId);
      return run(
        Effect.gen(function* () {
          const store = yield* PaCacheStore;
          if (store === null) return;
          const key = paSessionCacheKey(botId, sessionId);
          const savedAt = yield* Clock.currentTimeMillis;
          const payload = yield* encodeStoredPaSession({
            schemaVersion: PA_CACHE_SCHEMA_VERSION,
            environmentId,
            botId,
            sessionId,
            page,
            pageTag,
            savedAt,
          });
          if (generationOf(environmentId) !== gen) return;
          // An oversized replacement removes the older copy so a stale page never paints on reopen.
          if (textEncoder.encode(payload).length > PA_SESSION_CACHE_MAX_BYTES) {
            yield* store.remove(environmentId, key);
            return;
          }
          yield* store.save(environmentId, key, payload);
        }).pipe(Effect.ignore),
        undefined,
      );
    },
    removeSession(environmentId, botId, sessionId) {
      return run(
        Effect.gen(function* () {
          const store = yield* PaCacheStore;
          if (store === null) return;
          yield* store.remove(environmentId, paSessionCacheKey(botId, sessionId));
        }),
        undefined,
      );
    },
    removeBotSessions(environmentId, botId) {
      return run(
        Effect.gen(function* () {
          const store = yield* PaCacheStore;
          if (store === null) return;
          yield* store.removePrefix(environmentId, paBotSessionCachePrefix(botId));
        }),
        undefined,
      );
    },
  };
}
