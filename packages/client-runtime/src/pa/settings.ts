import type {
  PaBotConfig,
  PaConfigSection,
  PaConfigSectionValue,
  PaToggleItem,
} from "@t3tools/contracts";

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

/** A section's value as the engine stores it: the draft an editor starts from. */
function initialPaSectionValue(section: PaConfigSection): PaConfigSectionValue {
  switch (section.kind) {
    case "document":
      return { kind: "document", text: section.text };
    case "toggleList":
      return {
        kind: "toggleList",
        enabled: section.items.filter((item) => item.enabled).map((item) => item.id),
      };
    case "options":
      return {
        kind: "options",
        values: Object.fromEntries(section.fields.map((field) => [field.id, field.value])),
      };
  }
}

function samePaSectionValue(a: PaConfigSectionValue, b: PaConfigSectionValue): boolean {
  if (a.kind === "toggleList" && b.kind === "toggleList") {
    const left = [...a.enabled].sort();
    const right = [...b.enabled].sort();
    return left.length === right.length && left.every((id, i) => id === right[i]);
  }
  return JSON.stringify(a) === JSON.stringify(b);
}

export function paConfigDrafts(config: PaBotConfig): Record<string, PaConfigSectionValue> {
  return Object.fromEntries(config.sections.map((s) => [s.id, initialPaSectionValue(s)]));
}

/** The sections whose draft differs from what the engine stores. */
export function changedPaConfigSections(
  sections: ReadonlyArray<PaConfigSection>,
  drafts: Readonly<Record<string, PaConfigSectionValue>>,
): ReadonlyArray<PaConfigSection> {
  return sections.filter((section) => {
    const draft = drafts[section.id];
    return draft !== undefined && !samePaSectionValue(draft, initialPaSectionValue(section));
  });
}

/** The first changed toggle list left with fewer enabled items than it requires. */
export function findPaMinEnabledViolation(
  sections: ReadonlyArray<PaConfigSection>,
  drafts: Readonly<Record<string, PaConfigSectionValue>>,
): Extract<PaConfigSection, { kind: "toggleList" }> | null {
  for (const section of sections) {
    const draft = drafts[section.id];
    if (
      section.kind === "toggleList" &&
      section.minEnabled !== undefined &&
      draft?.kind === "toggleList" &&
      draft.enabled.length < section.minEnabled
    ) {
      return section;
    }
  }
  return null;
}

/**
 * Moves drafts onto the config a section save returned. The saved section takes its stored value
 * unless it was edited again meanwhile; any other section the user has not edited here follows
 * the new config too, so a stale copy cannot overwrite another device's change on the next save.
 */
export function rebasePaConfigDrafts(
  drafts: Readonly<Record<string, PaConfigSectionValue>>,
  previous: PaBotConfig | null,
  next: PaBotConfig,
  savedId: string,
  submitted: PaConfigSectionValue,
): Record<string, PaConfigSectionValue> {
  const rebased = { ...drafts };
  for (const section of next.sections) {
    const draft = drafts[section.id];
    const before = previous?.sections.find((entry) => entry.id === section.id);
    const untouched =
      section.id === savedId
        ? draft === undefined || samePaSectionValue(draft, submitted)
        : draft === undefined ||
          before === undefined ||
          samePaSectionValue(draft, initialPaSectionValue(before));
    if (untouched) rebased[section.id] = initialPaSectionValue(section);
  }
  return rebased;
}

export function parseSafePaConsoleUrl(value: string | null | undefined): string | null {
  if (!value || !/^https?:\/\//i.test(value)) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}
