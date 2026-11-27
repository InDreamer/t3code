import type { PaModelCatalog, PaModelOption, PaReasoningLevel } from "@t3tools/contracts";
import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";

const MAX_GLYPH_BARS = 5;
const OFF_LEVEL_IDS = new Set(["none", "off"]);

export function findPaModelOption(
  catalog: PaModelCatalog | null,
  providerId: string | null,
  modelId: string | null,
): PaModelOption | null {
  if (!catalog || !modelId) return null;
  if (providerId) {
    const provider = catalog.providers.find((entry) => entry.id === providerId);
    const match = provider?.models.find((entry) => entry.id === modelId);
    if (match) return match;
  }
  const currentProvider = catalog.providers.find((entry) => entry.isCurrent);
  const currentMatch = currentProvider?.models.find((entry) => entry.id === modelId);
  if (currentMatch) return currentMatch;
  for (const provider of catalog.providers) {
    const match = provider.models.find((entry) => entry.id === modelId);
    if (match) return match;
  }
  return null;
}

export function getSelectableReasoningLevels(
  catalog: PaModelCatalog | null,
  providerId: string | null,
  modelId: string | null,
): ReadonlyArray<PaReasoningLevel> {
  const levels = catalog?.reasoningLevels;
  if (!levels || levels.length === 0) return [];
  const option = findPaModelOption(catalog, providerId, modelId);
  if (option?.reasoning === false) return [];
  if (option?.canDisableReasoning === false) {
    return levels.filter((level) => !OFF_LEVEL_IDS.has(level.id.toLowerCase()));
  }
  return levels;
}

export function resolvePaReasoningGlyph(
  levelId: string | null,
  levels: ReadonlyArray<PaReasoningLevel>,
): { readonly count: number; readonly filled: number } {
  const active = levels.filter((level) => !OFF_LEVEL_IDS.has(level.id.toLowerCase()));
  const count = Math.max(1, Math.min(active.length, MAX_GLYPH_BARS));
  if (!levelId) return { count, filled: 0 };
  const normalized = levelId.toLowerCase();
  if (OFF_LEVEL_IDS.has(normalized)) return { count, filled: 0 };
  const index = active.findIndex((level) => level.id.toLowerCase() === normalized);
  if (index < 0) return { count, filled: 0 };
  return { count, filled: Math.min(count, index + 1) };
}

export function formatPaReasoningLabel(
  levelId: string,
  fallbackLabel?: string,
  resolve: MFunctionType = mFallback,
): string {
  switch (levelId.toLowerCase()) {
    case "none":
    case "off":
      return resolve(msg("Off", { $context: "reasoning effort level" }));
    case "minimal":
      return resolve(msg("Minimal", { $context: "reasoning effort level" }));
    case "low":
      return resolve(msg("Low", { $context: "reasoning effort level" }));
    case "medium":
      return resolve(msg("Medium", { $context: "reasoning effort level" }));
    case "high":
      return resolve(msg("High", { $context: "reasoning effort level" }));
    case "xhigh":
      return resolve(msg("Extra high", { $context: "reasoning effort level" }));
    case "max":
      return resolve(msg("Maximum", { $context: "reasoning effort level" }));
    case "ultra":
      return resolve(msg("Ultra", { $context: "reasoning effort level" }));
    default:
      return fallbackLabel || levelId;
  }
}
