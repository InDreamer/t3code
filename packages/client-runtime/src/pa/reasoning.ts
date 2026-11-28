import type {
  PaModelCatalog,
  PaModelOption,
  PaReasoningLevel,
  ProviderOptionDescriptor,
} from "@t3tools/contracts";
import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";

const OFF_LEVEL_IDS = new Set(["none", "off"]);

/** The Chat reasoning select shape, so PA reuses Chat's glyph and column rows as is. */
export type PaReasoningDescriptor = Extract<ProviderOptionDescriptor, { type: "select" }>;

/**
 * A named provider matches only its own models: two providers can serve the same id with
 * different capabilities. Without a provider, the current one wins, then any.
 */
export function findPaModelOption(
  catalog: PaModelCatalog | null,
  providerId: string | null,
  modelId: string | null,
): PaModelOption | null {
  if (!catalog || !modelId) return null;
  if (providerId) {
    const provider = catalog.providers.find((entry) => entry.id === providerId);
    return provider?.models.find((entry) => entry.id === modelId) ?? null;
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
  const option = findPaModelOption(catalog, providerId, modelId);
  if (option?.reasoning === false) return [];
  const levels = option?.reasoningLevels ?? catalog?.reasoningLevels;
  if (!levels || levels.length === 0) return [];
  if (option?.canDisableReasoning === false) {
    return levels.filter((level) => !OFF_LEVEL_IDS.has(level.id.toLowerCase()));
  }
  return levels;
}

export function buildPaReasoningDescriptor(
  catalog: PaModelCatalog | null,
  providerId: string | null,
  modelId: string | null,
  currentEffort: string | null,
  resolve: MFunctionType = mFallback,
): PaReasoningDescriptor | null {
  const levels = getSelectableReasoningLevels(catalog, providerId, modelId);
  if (levels.length === 0) return null;
  const current = currentEffort?.toLowerCase();
  const currentValue = levels.find((level) => level.id.toLowerCase() === current)?.id;
  return {
    id: "reasoningEffort",
    type: "select",
    role: "reasoning",
    label: resolve(msg("Reasoning effort")),
    options: levels.map((level) => ({
      id: level.id,
      label: formatPaReasoningLabel(level.id, level.label, resolve),
    })),
    ...(currentValue ? { currentValue } : {}),
  };
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
