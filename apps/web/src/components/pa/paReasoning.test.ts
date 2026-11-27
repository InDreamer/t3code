import type { PaModelCatalog } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  formatPaReasoningLabel,
  getSelectableReasoningLevels,
  resolvePaReasoningGlyph,
} from "./paReasoning";

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

  it("maps reasoning levels to rising bar counts", () => {
    expect(resolvePaReasoningGlyph("none", LEVELS)).toEqual({ count: 5, filled: 0 });
    expect(resolvePaReasoningGlyph("minimal", LEVELS)).toEqual({ count: 5, filled: 1 });
    expect(resolvePaReasoningGlyph("medium", LEVELS)).toEqual({ count: 5, filled: 3 });
    expect(resolvePaReasoningGlyph("xhigh", LEVELS)).toEqual({ count: 5, filled: 5 });
    expect(resolvePaReasoningGlyph("ultra", LEVELS)).toEqual({ count: 5, filled: 5 });
  });

  it("formats known levels cleanly and falls back for custom engine levels", () => {
    const id = (text: string) => text;
    expect(formatPaReasoningLabel(id, "none")).toBe("Off");
    expect(formatPaReasoningLabel(id, "high")).toBe("High");
    expect(formatPaReasoningLabel(id, "custom-tier", "Custom Tier")).toBe("Custom Tier");
  });
});
