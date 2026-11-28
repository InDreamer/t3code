import type { PaModelCatalog } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  createPaModelCatalogCache,
  filterPaModelProviders,
  formatPaModelLabel,
  resolvePaModelSelection,
} from "./models.ts";

const LEVELS = [
  { id: "none", label: "Off" },
  { id: "low", label: "Low" },
  { id: "high", label: "High" },
];

const CATALOG: PaModelCatalog = {
  scope: "agent",
  allowCustom: true,
  current: { provider: "anthropic", model: "claude-opus", reasoningEffort: "low" },
  reasoningLevels: LEVELS,
  providers: [
    {
      id: "anthropic",
      label: "Anthropic",
      tier: "primary",
      isCurrent: true,
      models: [
        { id: "claude-opus", label: "Claude Opus", reasoning: true },
        { id: "claude-haiku" },
      ],
    },
    {
      id: "openrouter",
      label: "OpenRouter",
      tier: "detected",
      isCurrent: false,
      models: [{ id: "anthropic/claude-opus", reasoning: false }],
    },
    { id: "empty", label: "Empty", tier: "detected", isCurrent: false, models: [] },
  ],
};

function deferred<A>() {
  let resolve!: (value: A) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<A>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

describe("formatPaModelLabel", () => {
  it("prefers the engine's label and otherwise drops the routing prefix", () => {
    expect(formatPaModelLabel("claude-opus", CATALOG, "anthropic")).toBe("Claude Opus");
    expect(formatPaModelLabel("anthropic/claude-opus", CATALOG, "openrouter")).toBe("claude-opus");
    expect(formatPaModelLabel("claude-opus", CATALOG, "openrouter")).toBe("claude-opus");
  });
});

describe("filterPaModelProviders", () => {
  it("drops empty providers and ranks matches within each provider", () => {
    expect(filterPaModelProviders(CATALOG.providers, "").map((p) => p.id)).toEqual([
      "anthropic",
      "openrouter",
    ]);
    const haiku = filterPaModelProviders(CATALOG.providers, "haiku");
    expect(haiku.map((p) => [p.id, p.models.map((m) => m.id)])).toEqual([
      ["anthropic", ["claude-haiku"]],
    ]);
    expect(filterPaModelProviders(CATALOG.providers, "openrouter").map((p) => p.id)).toEqual([
      "openrouter",
    ]);
  });
});

describe("resolvePaModelSelection", () => {
  it("reads the catalog's model with the live effort taking precedence", () => {
    const view = resolvePaModelSelection({
      catalog: CATALOG,
      bot: { model: "stale", provider: "anthropic" },
      scope: "agent",
      liveReasoningEffort: "high",
    });
    expect(view).toMatchObject({
      provider: "anthropic",
      model: "claude-opus",
      reasoningEffort: "high",
      displayLabel: "Claude Opus",
      reasoningLabel: "High",
    });
    expect(view.reasoning?.currentValue).toBe("high");
  });

  it("falls back to the Bot before the catalog loads and to the session for session scope", () => {
    expect(
      resolvePaModelSelection({
        catalog: null,
        bot: { model: "openai/gpt-5.4", provider: "openai" },
      }),
    ).toMatchObject({
      provider: "openai",
      model: "openai/gpt-5.4",
      displayLabel: "gpt-5.4",
      reasoning: null,
      reasoningLabel: null,
    });
    expect(
      resolvePaModelSelection({
        catalog: CATALOG,
        bot: { model: "claude-opus", provider: "anthropic" },
        scope: "session",
        sessionModel: "claude-haiku",
      }),
    ).toMatchObject({ model: "claude-haiku", provider: null });
  });

  it("keeps two providers' same-named models apart", () => {
    const view = resolvePaModelSelection({
      catalog: {
        ...CATALOG,
        current: { provider: "openrouter", model: "anthropic/claude-opus" },
      },
      bot: null,
    });
    expect(view.reasoning).toBeNull();
    expect(view.displayLabel).toBe("claude-opus");
  });
});

describe("createPaModelCatalogCache", () => {
  const KEY = { environmentId: "env", botId: "bot", sessionId: "s1" };

  it("shares one read between a preload and an opened picker", async () => {
    let calls = 0;
    const cache = createPaModelCatalogCache(async () => {
      calls += 1;
      return CATALOG;
    });
    await Promise.all([cache.load(KEY, { revision: 0 }), cache.load(KEY, { revision: 0 })]);
    await cache.load(KEY, { revision: 0 });
    expect(calls).toBe(1);
    expect(cache.read(KEY).catalog).toBe(CATALOG);

    await cache.load(KEY, { revision: 1 });
    await cache.refresh(KEY);
    expect(calls).toBe(3);
  });

  it("drops a read that predates a refresh or a confirmed change", async () => {
    const reads = [deferred<PaModelCatalog>(), deferred<PaModelCatalog>()];
    let index = 0;
    const cache = createPaModelCatalogCache(() => reads[index++]!.promise);

    const first = cache.load(KEY, { revision: 1 });
    const second = cache.load(KEY, { revision: 2 });
    reads[1]!.resolve(CATALOG);
    await second;
    reads[0]!.resolve({ ...CATALOG, current: null });
    await first;
    expect(cache.read(KEY).catalog?.current?.model).toBe("claude-opus");

    const third = deferred<PaModelCatalog>();
    reads.push(third);
    const stale = cache.refresh(KEY);
    cache.applyCurrent(KEY, { provider: "anthropic", model: "claude-haiku" });
    third.resolve(CATALOG);
    await stale;
    expect(cache.read(KEY).catalog?.current).toEqual({
      provider: "anthropic",
      model: "claude-haiku",
      reasoningEffort: "low",
    });
  });

  it("keeps the last catalog on a failed refresh but retries the same revision", async () => {
    const failure = new Error("gateway down");
    let reads = 0;
    const cache = createPaModelCatalogCache(async () => {
      if (++reads === 2) throw failure;
      return CATALOG;
    });
    await cache.load(KEY, { revision: 1 });
    await cache.refresh(KEY, 1);
    expect(cache.read(KEY)).toMatchObject({ catalog: CATALOG, error: failure });
    await cache.load(KEY, { revision: 1 });
    expect(reads).toBe(3);
    expect(cache.read(KEY).error).toBeNull();
  });

  it.each(["agent", "session"] as const)(
    "invalidates only siblings of an %s-scoped write",
    async (scope) => {
      const sibling = { ...KEY, sessionId: "s2" };
      const other = { ...sibling, environmentId: "other" };
      let model = "before";
      const cache = createPaModelCatalogCache(async () => ({
        ...CATALOG,
        scope,
        current: { model, provider: "p" },
      }));
      await Promise.all([KEY, sibling, other].map((key) => cache.load(key)));
      model = "after";
      cache.applyCurrent(KEY, { model, provider: "p" });
      await Promise.all([sibling, other].map((key) => cache.load(key)));
      expect(cache.read(sibling).catalog?.current?.model).toBe(
        scope === "agent" ? "after" : "before",
      );
      expect(cache.read(other).catalog?.current?.model).toBe("before");
    },
  );

  it.each(["clear", "environment", "evict"])(
    "does not restore a pending read after %s",
    async (operation) => {
      const first = deferred<PaModelCatalog>();
      let reads = 0;
      const cache = createPaModelCatalogCache(async () =>
        ++reads === 2 ? first.promise : CATALOG,
      );
      const other = { ...KEY, environmentId: "other" };
      await cache.load(other);
      const pending = cache.load(KEY);
      if (operation === "clear") {
        cache.clear();
        expect(cache.read(other).catalog).toBeNull();
      } else if (operation === "environment") {
        cache.clearEnvironment(KEY.environmentId);
        expect(cache.read(other).catalog).toBe(CATALOG);
      } else {
        for (let i = 0; i < 64; i++) {
          await cache.load(other);
          await cache.load({ ...KEY, sessionId: String(i) });
        }
        expect(cache.read(other).catalog).toBe(CATALOG);
      }
      expect(cache.read(KEY).loading).toBe(false);
      expect(cache.read(KEY).catalog).toBeNull();
      await cache.load(KEY);
      first.resolve({ ...CATALOG, current: null });
      await pending;
      expect(cache.read(KEY).catalog).toBe(CATALOG);
    },
  );

  it("keeps each session's catalog apart", async () => {
    const cache = createPaModelCatalogCache(async (key) => {
      if (key.sessionId === "broken") throw new Error("gateway down");
      return { ...CATALOG, current: { provider: "anthropic", model: key.sessionId ?? "none" } };
    });
    await cache.load(KEY);
    await cache.load({ ...KEY, sessionId: "s2" });
    expect(cache.read(KEY).catalog?.current?.model).toBe("s1");
    expect(cache.read({ ...KEY, sessionId: "s2" }).catalog?.current?.model).toBe("s2");

    await cache.load({ ...KEY, sessionId: "broken" });
    expect(cache.read({ ...KEY, sessionId: "broken" })).toMatchObject({
      catalog: null,
      loading: false,
    });
    expect(cache.read({ ...KEY, sessionId: "broken" }).error).toBeInstanceOf(Error);
  });

  it("preserves the known provider and model when a reasoning-only apply omits model metadata", async () => {
    const cache = createPaModelCatalogCache(async () => CATALOG);
    await cache.load(KEY);
    cache.applyCurrent(KEY, { provider: "other-provider", model: "", reasoningEffort: "high" });
    expect(cache.read(KEY).catalog?.current).toEqual({
      provider: "anthropic",
      model: "claude-opus",
      reasoningEffort: "high",
    });
  });

  it("restarts an in-flight sibling preload when an agent-scoped write lands", async () => {
    const sibling = { ...KEY, sessionId: "s2" };
    const staleRead = deferred<PaModelCatalog>();
    const freshRead = deferred<PaModelCatalog>();
    let siblingReads = 0;
    const cache = createPaModelCatalogCache((key) => {
      if (key.sessionId === "s1") return Promise.resolve(CATALOG);
      siblingReads += 1;
      return siblingReads === 1 ? staleRead.promise : freshRead.promise;
    });
    await cache.load(KEY);
    const firstSibling = cache.load(sibling, { revision: 1 });
    cache.applyCurrent(KEY, {
      provider: "anthropic",
      model: "claude-opus",
      reasoningEffort: "high",
    });
    expect(siblingReads).toBe(2);
    expect(cache.read(sibling).loading).toBe(true);
    staleRead.resolve(CATALOG);
    await firstSibling;
    expect(cache.read(sibling).loading).toBe(true);
    const updatedCatalog: PaModelCatalog = {
      ...CATALOG,
      current: { provider: "anthropic", model: "claude-opus", reasoningEffort: "high" },
    };
    freshRead.resolve(updatedCatalog);
    await freshRead.promise;
    await Promise.resolve();
    expect(cache.read(sibling)).toMatchObject({
      loading: false,
      error: null,
      catalog: updatedCatalog,
    });
  });

  it("joins an in-flight read when a revalidation checks loading before forcing", async () => {
    const first = deferred<PaModelCatalog>();
    let reads = 0;
    const cache = createPaModelCatalogCache(() => {
      reads += 1;
      return first.promise;
    });
    const preload = cache.load(KEY, { revision: 1 });
    const onOpen = cache.load(KEY, { revision: 1, force: !cache.read(KEY).loading });
    expect(reads).toBe(1);
    first.resolve(CATALOG);
    await Promise.all([preload, onOpen]);
    expect(cache.read(KEY).catalog).toBe(CATALOG);
  });
});
