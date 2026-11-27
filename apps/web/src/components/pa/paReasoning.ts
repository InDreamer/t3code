import type { PaModelCatalog, PaModelOption, PaReasoningLevel } from "@t3tools/contracts";

type Translate = (text: string) => string;

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
  gt: Translate,
  levelId: string,
  fallbackLabel?: string,
): string {
  switch (levelId.toLowerCase()) {
    case "none":
    case "off":
      return gt("Off");
    case "minimal":
      return gt("Minimal");
    case "low":
      return gt("Low");
    case "medium":
      return gt("Medium");
    case "high":
      return gt("High");
    case "xhigh":
      return gt("Extra high");
    case "max":
      return gt("Maximum");
    case "ultra":
      return gt("Ultra");
    default:
      return fallbackLabel || levelId;
  }
}
