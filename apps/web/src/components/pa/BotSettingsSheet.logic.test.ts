import type { PaToggleItem } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildPaginationSlots,
  filterToggleItems,
  modelConfirmationForDraft,
  paginateItems,
} from "./BotSettingsSheet.logic";

it("shows a confirmation for the submitted fields even when the engine pick was normalized", () => {
  const submitted = { provider: "", model: " A " };
  const confirmation = { provider: "default", model: "A", message: "confirm A" };
  expect(modelConfirmationForDraft(submitted, submitted, confirmation)).toEqual(confirmation);
  expect(
    modelConfirmationForDraft({ ...submitted, model: "B" }, submitted, confirmation),
  ).toBeNull();
  expect(
    modelConfirmationForDraft({ ...submitted, provider: "other" }, submitted, confirmation),
  ).toBeNull();
});

describe("toggle list filtering and pagination", () => {
  const items: ReadonlyArray<PaToggleItem> = Array.from({ length: 25 }, (_, index) => ({
    id: `skill-${index + 1}`,
    label: `Skill ${index + 1}`,
    group: index % 2 === 0 ? "coding" : "writing",
    ...(index === 0 ? { description: "Runs automated checks" } : {}),
    enabled: index < 10,
  }));
  const enabledIds = new Set(items.slice(0, 10).map((item) => item.id));

  it("filters by status mode and matches label, group, or description", () => {
    expect(filterToggleItems(items, enabledIds, "", "enabled")).toHaveLength(10);
    expect(filterToggleItems(items, enabledIds, "", "disabled")).toHaveLength(15);
    expect(filterToggleItems(items, enabledIds, "automated", "all").map((i) => i.id)).toEqual([
      "skill-1",
    ]);
    expect(filterToggleItems(items, enabledIds, "writing", "enabled")).toHaveLength(5);
  });

  it("paginates slices and clamps out-of-range page numbers", () => {
    const first = paginateItems(items, 1, 8);
    expect(first).toMatchObject({
      page: 1,
      totalPages: 4,
      totalItems: 25,
      startIndex: 1,
      endIndex: 8,
    });
    expect(first.items).toHaveLength(8);

    const last = paginateItems(items, 99, 8);
    expect(last).toMatchObject({
      page: 4,
      totalPages: 4,
      totalItems: 25,
      startIndex: 25,
      endIndex: 25,
    });
    expect(last.items.map((i) => i.id)).toEqual(["skill-25"]);

    const empty = paginateItems([], 3, 8);
    expect(empty).toMatchObject({
      page: 1,
      totalPages: 1,
      totalItems: 0,
      startIndex: 0,
      endIndex: 0,
      items: [],
    });
  });

  it("builds compact pagination slots with ellipses for large page counts", () => {
    expect(buildPaginationSlots(1, 4)).toEqual([1, 2, 3, 4]);
    expect(buildPaginationSlots(2, 12)).toEqual([1, 2, 3, "ellipsis-right", 12]);
    expect(buildPaginationSlots(6, 12)).toEqual([1, "ellipsis-left", 6, "ellipsis-right", 12]);
    expect(buildPaginationSlots(11, 12)).toEqual([1, "ellipsis-left", 10, 11, 12]);
  });
});
