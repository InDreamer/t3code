import type { PaModelCatalog } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildPaReasoningDescriptor,
  findPaModelOption,
  formatPaReasoningLabel,
  getSelectableReasoningLevels,
} from "./reasoning.ts";

const LEVELS = [
  { id: "none", label: "Off" },
  { id: "minimal", label: "Minimal" },
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
  { id: "xhigh", label: "Extra High" },
  { id: "max", label: "Max" },
  { id: "ultra", label: "Ultra" },
] as const;

const CATALOG: PaModelCatalog = {
  scope: "agent",
  allowCustom: true,
  current: { provider: "openai", model: "gpt-5.4", reasoningEffort: "medium" },
  reasoningLevels: [...LEVELS],
  providers: [
    {
      id: "openai",
      label: "OpenAI",
      tier: "primary",
      isCurrent: true,
      models: [
        { id: "gpt-5.4", reasoning: true, canDisableReasoning: true },
        { id: "gpt-4o-mini", reasoning: false },
        { id: "gpt-6-astra", reasoning: true, canDisableReasoning: false },
      ],
    },
    {
      id: "openrouter",
      label: "OpenRouter",
      tier: "primary",
      isCurrent: false,
      models: [
        {
          id: "gpt-5.4",
          reasoning: true,
          reasoningLevels: [
            { id: "low", label: "Low" },
            { id: "high", label: "High" },
          ],
        },
        { id: "only-here", reasoning: false },
        { id: "no-levels", reasoning: true, reasoningLevels: [] },
      ],
    },
  ],
};

describe("paReasoning", () => {
  it("respects per-model reasoning and canDisableReasoning capabilities", () => {
    expect(getSelectableReasoningLevels(CATALOG, "openai", "gpt-5.4").map((l) => l.id)).toEqual([
      "none",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultra",
    ]);
    expect(getSelectableReasoningLevels(CATALOG, "openai", "gpt-4o-mini")).toEqual([]);
    expect(getSelectableReasoningLevels(CATALOG, "openai", "gpt-6-astra").map((l) => l.id)).toEqual(
      ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"],
    );
  });

  it("prefers a model's own levels over the catalog's", () => {
    expect(buildPaReasoningDescriptor(CATALOG, "openrouter", "no-levels", "low")).toBeNull();
    expect(getSelectableReasoningLevels(CATALOG, "openrouter", "gpt-5.4").map((l) => l.id)).toEqual(
      ["low", "high"],
    );
  });

  it("never borrows a same-named model from another provider", () => {
    expect(findPaModelOption(CATALOG, "openai", "only-here")).toBeNull();
    expect(findPaModelOption(CATALOG, "openrouter", "gpt-5.4")?.reasoningLevels).toHaveLength(2);
    // Without a provider, the current provider's model answers first.
    expect(findPaModelOption(CATALOG, null, "gpt-5.4")?.canDisableReasoning).toBe(true);
    expect(findPaModelOption(CATALOG, null, "only-here")?.reasoning).toBe(false);
  });

  it("builds a Chat reasoning select with the current level", () => {
    const descriptor = buildPaReasoningDescriptor(CATALOG, "openai", "gpt-5.4", "HIGH");
    expect(descriptor).toMatchObject({
      id: "reasoningEffort",
      type: "select",
      role: "reasoning",
      label: "Reasoning effort",
      currentValue: "high",
    });
    expect(descriptor?.options.map((option) => option.label)).toEqual([
      "Off",
      "Minimal",
      "Low",
      "Medium",
      "High",
      "Extra high",
      "Maximum",
      "Ultra",
    ]);
    expect(
      buildPaReasoningDescriptor(CATALOG, "openai", "gpt-6-astra", "none")?.currentValue,
    ).toBeUndefined();
    expect(buildPaReasoningDescriptor(CATALOG, "openai", "gpt-4o-mini", "high")).toBeNull();
  });

  it("formats known levels cleanly and falls back for custom engine levels", () => {
    expect(formatPaReasoningLabel("none")).toBe("Off");
    expect(formatPaReasoningLabel("high")).toBe("High");
    expect(formatPaReasoningLabel("custom-tier", "Custom Tier")).toBe("Custom Tier");
  });
});
