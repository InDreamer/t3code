import type { PaToggleItem } from "@t3tools/contracts";

type ModelDraft = { readonly provider: string; readonly model: string };

export const TOGGLE_PAGE_SIZE = 8;

export type ToggleFilterMode = "all" | "enabled" | "disabled";

export type PaginationSlot = number | "ellipsis-left" | "ellipsis-right";

export function modelConfirmationForDraft(
  current: ModelDraft,
  submitted: ModelDraft,
  confirmation: ModelDraft & { readonly message: string },
) {
  return current.provider === submitted.provider && current.model === submitted.model
    ? confirmation
    : null;
}

export function filterToggleItems(
  items: ReadonlyArray<PaToggleItem>,
  enabledIds: ReadonlySet<string>,
  query: string,
  mode: ToggleFilterMode,
): ReadonlyArray<PaToggleItem> {
  const needle = query.trim().toLowerCase();
  return items.filter((item) => {
    if (mode === "enabled" && !enabledIds.has(item.id)) return false;
    if (mode === "disabled" && enabledIds.has(item.id)) return false;
    if (!needle) return true;
    return (
      item.label.toLowerCase().includes(needle) ||
      (item.group ?? "").toLowerCase().includes(needle) ||
      (item.description ?? "").toLowerCase().includes(needle)
    );
  });
}

export function paginateItems<T>(
  items: ReadonlyArray<T>,
  requestedPage: number,
  pageSize: number = TOGGLE_PAGE_SIZE,
): {
  readonly items: ReadonlyArray<T>;
  readonly page: number;
  readonly totalPages: number;
  readonly totalItems: number;
  readonly startIndex: number;
  readonly endIndex: number;
} {
  const safeSize = Math.max(1, pageSize);
  const totalItems = items.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / safeSize));
  const page = Math.min(Math.max(1, Math.floor(requestedPage)), totalPages);
  const offset = (page - 1) * safeSize;
  const pageItems = items.slice(offset, offset + safeSize);
  return {
    items: pageItems,
    page,
    totalPages,
    totalItems,
    startIndex: totalItems === 0 ? 0 : offset + 1,
    endIndex: offset + pageItems.length,
  };
}

/** Keeps pagination to at most 5 slots so narrow side sheets never wrap or clip. */
export function buildPaginationSlots(
  currentPage: number,
  totalPages: number,
): ReadonlyArray<PaginationSlot> {
  if (totalPages <= 1) return [1];
  if (totalPages <= 5) {
    return Array.from({ length: totalPages }, (_, index) => index + 1);
  }
  const page = Math.min(Math.max(1, currentPage), totalPages);
  if (page <= 3) return [1, 2, 3, "ellipsis-right", totalPages];
  if (page >= totalPages - 2) {
    return [1, "ellipsis-left", totalPages - 2, totalPages - 1, totalPages];
  }
  return [1, "ellipsis-left", page, "ellipsis-right", totalPages];
}
