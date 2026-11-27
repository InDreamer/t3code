import type { ContextWindowSnapshot } from "../state/contextWindow.ts";
import type { PaContextUsage } from "@t3tools/contracts";

/** Nothing worth a meter: no occupancy reported and no window to measure it against. */
export function hasPaContextUsage(usage: PaContextUsage | null): usage is PaContextUsage {
  return usage !== null && (usage.contextUsed > 0 || usage.contextMax !== null);
}

/** The thread context meter's input, from what the engine reports as current occupancy. */
export function paContextWindowSnapshot(usage: PaContextUsage): ContextWindowSnapshot {
  const max = usage.contextMax !== null && usage.contextMax > 0 ? usage.contextMax : null;
  const percent = max === null ? null : usage.contextPercent;
  return {
    usedTokens: usage.contextUsed,
    totalProcessedTokens: usage.totalTokens ?? null,
    maxTokens: max,
    inputTokens: usage.inputTokens ?? null,
    cachedInputTokens: usage.cacheReadTokens ?? null,
    outputTokens: usage.outputTokens ?? null,
    reasoningOutputTokens: null,
    lastUsedTokens: null,
    lastInputTokens: null,
    lastCachedInputTokens: null,
    lastOutputTokens: null,
    lastReasoningOutputTokens: null,
    toolUses: null,
    durationMs: null,
    compactsAutomatically: null,
    autoCompactThreshold: null,
    cost: null,
    remainingTokens: max === null ? null : Math.max(0, max - usage.contextUsed),
    usedPercentage: percent,
    remainingPercentage: percent === null ? null : Math.max(0, 100 - percent),
    updatedAt: "",
  };
}
