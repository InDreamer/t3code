import { PaCacheStore } from "@t3tools/client-runtime/pa/cache";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { MobileDatabase } from "../persistence/mobile-database";

export const layer = Layer.effect(
  PaCacheStore,
  Effect.gen(function* () {
    const database = yield* MobileDatabase;
    return {
      load: (environmentId, key) =>
        database
          .loadCache(environmentId, "pa", `v1:${key}`)
          .pipe(Effect.catch(() => Effect.succeedNone)),
      save: (environmentId, key, payload) =>
        database
          .saveCache(environmentId, "pa", `v1:${key}`, 1, payload)
          .pipe(Effect.catch(() => Effect.logWarning("Offline PA cache database save failed"))),
      remove: (environmentId, key) =>
        database.removeCache(environmentId, "pa", `v1:${key}`).pipe(Effect.ignore),
      removePrefix: (environmentId, prefix) =>
        database.removeCachePrefix(environmentId, "pa", `v1:${prefix}`).pipe(Effect.ignore),
    } satisfies NonNullable<typeof PaCacheStore.Service>;
  }),
);
