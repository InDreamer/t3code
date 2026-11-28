import { EnvironmentId, type PaGetMessagesResult, type PaListBotsResult } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import {
  createPaEnvironmentCache,
  PA_SESSION_CACHE_MAX_BYTES,
  PaCacheStore,
  paRosterCacheKey,
  paSessionCacheKey,
} from "./cache.ts";

function makeMemoryCacheHarness() {
  const entries = new Map<string, string>();
  const keyOf = (environmentId: EnvironmentId, key: string) => `${environmentId}\u0000${key}`;
  const store: NonNullable<typeof PaCacheStore.Service> = {
    load: (environmentId, key) =>
      Effect.sync(() => Option.fromUndefinedOr(entries.get(keyOf(environmentId, key)))),
    save: (environmentId, key, payload) =>
      Effect.sync(() => {
        entries.set(keyOf(environmentId, key), payload);
      }),
    remove: (environmentId, key) =>
      Effect.sync(() => {
        entries.delete(keyOf(environmentId, key));
      }),
    removePrefix: (environmentId, prefix) =>
      Effect.sync(() => {
        const fullPrefix = keyOf(environmentId, prefix);
        for (const key of Array.from(entries.keys())) {
          if (key.startsWith(fullPrefix)) entries.delete(key);
        }
      }),
  };
  const registry = AtomRegistry.make();
  const runtime = Atom.runtime(Layer.succeed(PaCacheStore, store));
  const cache = createPaEnvironmentCache(registry, runtime);
  return { cache, entries, keyOf, registry };
}

const ENV_1 = EnvironmentId.make("env-1");
const ENV_2 = EnvironmentId.make("env-2");

const SAMPLE_ROSTER: PaListBotsResult = {
  instances: [],
  bots: [
    {
      botId: "hermes:main",
      instanceId: "hermes",
      driver: "hermes",
      engineLabel: "Hermes",
      agentRef: "main",
      name: "Main",
      description: "",
      avatarColor: "#f97316",
      avatarShape: "pumpkin",
      pinned: true,
      isDefault: true,
      model: "gpt-6",
      provider: "openai",
      online: true,
      running: false,
      unread: false,
      lastMessagePreview: "Hello",
      lastActivityAt: 1000,
      primarySessionId: "s-1",
    },
  ],
};

const SAMPLE_PAGE: PaGetMessagesResult = {
  messages: [
    {
      id: "row-1",
      role: "assistant",
      text: "Hello from cache",
      timestamp: 1000,
      rowKind: "message",
      rowId: 1,
    },
  ],
  nextCursor: "c-older",
};

describe("PaCacheStore & createPaEnvironmentCache", () => {
  it("persists and restores roster and session pages with page tags", async () => {
    const { cache } = makeMemoryCacheHarness();
    await cache.saveRoster(ENV_1, {
      result: SAMPLE_ROSTER,
      lastSessionByBot: { "hermes:main": "s-1" },
      lastBotId: "hermes:main",
    });
    await cache.saveSession(ENV_1, "hermes:main", "s-1", SAMPLE_PAGE, "tag-abc");

    const roster = await cache.loadRoster(ENV_1);
    expect(roster?.result).toEqual(SAMPLE_ROSTER);
    expect(roster?.lastSessionByBot).toEqual({ "hermes:main": "s-1" });
    expect(roster?.lastBotId).toBe("hermes:main");

    const session = await cache.loadSession(ENV_1, "hermes:main", "s-1");
    expect(session?.page).toEqual(SAMPLE_PAGE);
    expect(session?.pageTag).toBe("tag-abc");
  });

  it("discards and removes corrupt or identity-mismatched records", async () => {
    const { cache, entries, keyOf } = makeMemoryCacheHarness();
    entries.set(keyOf(ENV_1, paRosterCacheKey()), "{not-json");
    expect(await cache.loadRoster(ENV_1)).toBeNull();
    expect(entries.has(keyOf(ENV_1, paRosterCacheKey()))).toBe(false);

    // Record saved for ENV_2 placed under ENV_1's slot is rejected and purged.
    await cache.saveSession(ENV_2, "hermes:main", "s-1", SAMPLE_PAGE, "tag-2");
    const env2Raw = entries.get(keyOf(ENV_2, paSessionCacheKey("hermes:main", "s-1")))!;
    entries.set(keyOf(ENV_1, paSessionCacheKey("hermes:main", "s-1")), env2Raw);
    expect(await cache.loadSession(ENV_1, "hermes:main", "s-1")).toBeNull();
    expect(entries.has(keyOf(ENV_1, paSessionCacheKey("hermes:main", "s-1")))).toBe(false);
  });

  it("removes the stale copy when a replacement session page exceeds the byte cap", async () => {
    const { cache } = makeMemoryCacheHarness();
    await cache.saveSession(ENV_1, "hermes:main", "s-1", SAMPLE_PAGE, "small");
    expect(await cache.loadSession(ENV_1, "hermes:main", "s-1")).not.toBeNull();

    const oversized: PaGetMessagesResult = {
      messages: [
        {
          id: "row-huge",
          role: "assistant",
          text: "x".repeat(PA_SESSION_CACHE_MAX_BYTES + 1024),
          timestamp: 2000,
          rowKind: "message",
        },
      ],
      nextCursor: null,
    };
    await cache.saveSession(ENV_1, "hermes:main", "s-1", oversized, "huge");
    expect(await cache.loadSession(ENV_1, "hermes:main", "s-1")).toBeNull();
  });

  it("removes only a deleted bot's sessions via prefix removal", async () => {
    const { cache } = makeMemoryCacheHarness();
    await cache.saveSession(ENV_1, "hermes:main", "s-1", SAMPLE_PAGE, "t1");
    await cache.saveSession(ENV_1, "hermes:main", "s-2", SAMPLE_PAGE, "t2");
    await cache.saveSession(ENV_1, "hermes:other", "s-1", SAMPLE_PAGE, "t3");

    await cache.removeBotSessions(ENV_1, "hermes:main");
    expect(await cache.loadSession(ENV_1, "hermes:main", "s-1")).toBeNull();
    expect(await cache.loadSession(ENV_1, "hermes:main", "s-2")).toBeNull();
    expect(await cache.loadSession(ENV_1, "hermes:other", "s-1")).not.toBeNull();
  });

  it("drops a slow load if the environment generation was bumped meanwhile", async () => {
    const gate = Promise.withResolvers<Option.Option<string>>();
    const store: NonNullable<typeof PaCacheStore.Service> = {
      load: () => Effect.promise(() => gate.promise),
      save: () => Effect.void,
      remove: () => Effect.void,
      removePrefix: () => Effect.void,
    };
    const registry = AtomRegistry.make();
    const runtime = Atom.runtime(Layer.succeed(PaCacheStore, store));
    const cache = createPaEnvironmentCache(registry, runtime);

    const pending = cache.loadRoster(ENV_1);
    cache.bumpEnvironmentGeneration(ENV_1);
    gate.resolve(
      Option.some(
        JSON.stringify({
          schemaVersion: 1,
          environmentId: ENV_1,
          result: SAMPLE_ROSTER,
          lastSessionByBot: {},
          lastBotId: null,
          savedAt: 100,
        }),
      ),
    );
    expect(await pending).toBeNull();
  });
});
