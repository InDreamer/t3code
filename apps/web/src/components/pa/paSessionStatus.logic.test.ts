import { describe, expect, it } from "vite-plus/test";

import { hasPaContextUsage, paContextWindowSnapshot } from "./paSessionStatus.logic";

describe("PA context usage", () => {
  it("measures occupancy against the window and never against cumulative totals", () => {
    const snapshot = paContextWindowSnapshot({
      contextUsed: 30_000,
      contextMax: 120_000,
      contextPercent: 25,
      totalTokens: 900_000,
      cacheReadTokens: 2_000,
    });
    expect(snapshot).toMatchObject({
      usedTokens: 30_000,
      maxTokens: 120_000,
      usedPercentage: 25,
      remainingTokens: 90_000,
      remainingPercentage: 75,
      totalProcessedTokens: 900_000,
      cachedInputTokens: 2_000,
    });
    expect(
      paContextWindowSnapshot({ contextUsed: 5_000, contextMax: null, contextPercent: null }),
    ).toMatchObject({ usedTokens: 5_000, maxTokens: null, usedPercentage: null });
  });

  it("shows no meter until the engine reports occupancy or a window", () => {
    expect(hasPaContextUsage(null)).toBe(false);
    expect(hasPaContextUsage({ contextUsed: 0, contextMax: null, contextPercent: null })).toBe(
      false,
    );
    expect(hasPaContextUsage({ contextUsed: 0, contextMax: 8_000, contextPercent: 0 })).toBe(true);
  });
});
