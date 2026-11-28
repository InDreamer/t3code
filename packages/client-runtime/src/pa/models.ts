import type {
  PaBotSummary,
  PaCapabilities,
  PaModelCatalog,
  PaModelOption,
  PaModelProvider,
} from "@t3tools/contracts";
import { mFallback } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";

import { rankModelPickerSearch } from "../modelSearch.ts";
import {
  buildPaReasoningDescriptor,
  findPaModelOption,
  formatPaReasoningLabel,
  type PaReasoningDescriptor,
} from "./reasoning.ts";

/** The engine's display name, else the id without its `provider/` routing prefix. */
export function formatPaModelLabel(
  modelId: string,
  catalog?: PaModelCatalog | null,
  providerId?: string | null,
): string {
  const label = findPaModelOption(catalog ?? null, providerId ?? null, modelId)?.label;
  if (label) return label;
  return modelId.split("/").at(-1) || modelId;
}

// Checked in order; OpenRouter comes first since its model ids name the upstream vendor.
const PA_PROVIDER_ICON_KEYS: ReadonlyArray<readonly [RegExp, string]> = [
  [/openrouter/, "openrouter"],
  [/anthropic|claude/, "claudeAgent"],
  [/\bx-?ai\b|grok/, "grok"],
  [/antigravity/, "antigravity"],
  [/cursor/, "cursor"],
  [/opencode/, "opencode"],
  [/kiro/, "kiro"],
  [/openai|codex|\bgpt|^o[134]\b/, "codex"],
];

/**
 * The T3 provider whose icon stands for a PA model: matched on the engine's provider id, else on
 * the model id. Null when neither names a provider T3 draws.
 */
export function paProviderIconKey(
  provider: string | null | undefined,
  model?: string | null,
): string | null {
  for (const id of [provider, model]) {
    const value = id?.trim().toLowerCase();
    if (!value) continue;
    const match = PA_PROVIDER_ICON_KEYS.find(([pattern]) => pattern.test(value));
    if (match) return match[1];
  }
  return null;
}

/** Providers whose models match `query`, best match first; providers without models drop out. */
export function filterPaModelProviders(
  providers: ReadonlyArray<PaModelProvider>,
  query: string,
): ReadonlyArray<PaModelProvider> {
  const withModels = providers.filter((provider) => provider.models.length > 0);
  if (!query.trim()) return withModels;
  return withModels
    .map((provider) => ({
      ...provider,
      models: rankModelPickerSearch(provider.models, query, (model: PaModelOption) => ({
        driverKind: provider.id,
        providerDisplayName: provider.label,
        name: model.label ?? model.id,
        slug: model.id,
        shortName: formatPaModelLabel(model.id),
      })),
    }))
    .filter((provider) => provider.models.length > 0);
}

interface PaModelSelectionInput {
  readonly catalog: PaModelCatalog | null;
  readonly bot: Pick<PaBotSummary, "model" | "provider"> | null;
  /** The active session's own model, used only when the engine scopes models to sessions. */
  readonly sessionModel?: string | null | undefined;
  readonly scope?: PaCapabilities["models"]["scope"] | null | undefined;
  /** The effort the running session reported, fresher than the catalog's read. */
  readonly liveReasoningEffort?: string | null | undefined;
  readonly resolve?: MFunctionType | undefined;
}

interface PaModelSelectionView {
  readonly provider: string | null;
  readonly model: string | null;
  readonly reasoningEffort: string | null;
  readonly displayLabel: string | null;
  readonly reasoningLabel: string | null;
  /** Null when the model takes no effort setting. */
  readonly reasoning: PaReasoningDescriptor | null;
}

/** The one model and effort every PA trigger and picker shows for a Bot. */
export function resolvePaModelSelection(input: PaModelSelectionInput): PaModelSelectionView {
  const resolve = input.resolve ?? mFallback;
  const current = input.catalog?.current ?? null;
  const sessionModel = input.scope === "session" ? (input.sessionModel ?? null) : null;
  const model = sessionModel ?? current?.model ?? input.bot?.model ?? null;
  // A provider belongs to the model it was read with; a session's own model carries none.
  const provider =
    sessionModel !== null
      ? sessionModel === current?.model
        ? current.provider
        : null
      : current
        ? current.provider
        : (input.bot?.provider ?? null);
  const reasoningEffort = input.liveReasoningEffort ?? current?.reasoningEffort ?? null;
  const reasoning = buildPaReasoningDescriptor(
    input.catalog,
    provider,
    model,
    reasoningEffort,
    resolve,
  );
  const reasoningLabel = !reasoning
    ? null
    : (reasoning.options.find((option) => option.id === reasoning.currentValue)?.label ??
      (reasoningEffort ? formatPaReasoningLabel(reasoningEffort, undefined, resolve) : null));
  return {
    provider,
    model,
    reasoningEffort,
    displayLabel: model ? formatPaModelLabel(model, input.catalog, provider) : null,
    reasoningLabel,
    reasoning,
  };
}

export interface PaModelCatalogKey {
  readonly environmentId: string;
  readonly botId: string;
  readonly sessionId: string | null;
}

export interface PaModelCatalogEntry {
  readonly catalog: PaModelCatalog | null;
  readonly loading: boolean;
  readonly error: unknown;
}

const EMPTY_ENTRY: PaModelCatalogEntry = { catalog: null, loading: false, error: null };
const MAX_CATALOGS = 64;

interface StoredEntry extends PaModelCatalogEntry {
  readonly key: PaModelCatalogKey;
  /** The caller's settings revision the catalog was read at; another one makes it stale. */
  readonly revision: number | null;
  readonly stale: boolean;
  readonly pending: { readonly revision: number | null; readonly promise: Promise<void> } | null;
}

function mergeCatalogCurrent(
  previous: PaModelCatalog["current"],
  current: NonNullable<PaModelCatalog["current"]>,
): PaModelCatalog["current"] {
  if (current.model) return { ...previous, ...current };
  if (!previous) return null;
  return {
    ...previous,
    ...(current.reasoningEffort !== undefined ? { reasoningEffort: current.reasoningEffort } : {}),
  };
}

/**
 * One catalog per (environment, Bot, session), so a toolbar preload and an opened picker share
 * one read. Only the pending promise for a key can settle its entry.
 */
export function createPaModelCatalogCache(
  fetchCatalog: (key: PaModelCatalogKey) => Promise<PaModelCatalog>,
) {
  const entries = new Map<string, StoredEntry>();
  const listeners = new Set<() => void>();
  const keyOf = (key: PaModelCatalogKey) =>
    JSON.stringify([key.environmentId, key.botId, key.sessionId]);
  const notify = () => {
    for (const listener of listeners) listener();
  };
  const touch = (id: string, entry: StoredEntry) => {
    entries.delete(id);
    entries.set(id, entry);
  };
  const write = (id: string, entry: StoredEntry) => {
    touch(id, entry);
    if (entries.size > MAX_CATALOGS) entries.delete(entries.keys().next().value!);
    notify();
  };

  const load = (
    key: PaModelCatalogKey,
    options?: { readonly revision?: number; readonly force?: boolean },
  ): Promise<void> => {
    const id = keyOf(key);
    const existing = entries.get(id);
    const revision = options?.revision ?? existing?.revision ?? null;
    if (!options?.force && existing) {
      touch(id, existing);
      if (existing.pending?.revision === revision) return existing.pending.promise;
      if (
        !existing.pending &&
        !existing.stale &&
        existing.catalog &&
        existing.error === null &&
        existing.revision === revision
      ) {
        return Promise.resolve();
      }
    }
    const settle = (next: Pick<StoredEntry, "catalog" | "error" | "revision">) => {
      if (entries.get(id)?.pending?.promise !== promise) return;
      write(id, { ...next, key, stale: false, loading: false, pending: null });
    };
    const promise = fetchCatalog(key).then(
      (catalog) => settle({ catalog, error: null, revision }),
      (error: unknown) => {
        const previous = entries.get(id);
        settle({
          catalog: previous?.catalog ?? null,
          error,
          revision: previous?.revision ?? null,
        });
      },
    );
    write(id, {
      key,
      catalog: existing?.catalog ?? null,
      loading: true,
      error: null,
      revision: existing?.revision ?? null,
      stale: false,
      pending: { revision, promise },
    });
    return promise;
  };

  return {
    read(key: PaModelCatalogKey): PaModelCatalogEntry {
      const id = keyOf(key);
      const entry = entries.get(id);
      if (entry) touch(id, entry);
      return entry ?? EMPTY_ENTRY;
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    /** Reads the catalog unless one for `revision` is cached or already on its way. */
    load,
    refresh: (key: PaModelCatalogKey, revision?: number) =>
      load(key, { force: true, ...(revision !== undefined ? { revision } : {}) }),
    /** Writes a confirmed change; a read already in flight may predate it, so it is dropped. */
    applyCurrent(key: PaModelCatalogKey, current: NonNullable<PaModelCatalog["current"]>) {
      const id = keyOf(key);
      const existing = entries.get(id);
      if (!existing?.catalog) return;
      const pendingSiblings: Array<{
        readonly key: PaModelCatalogKey;
        readonly revision: number | null;
      }> = [];
      if (existing.catalog.scope !== "session") {
        for (const [otherId, other] of entries) {
          if (
            otherId !== id &&
            other.key.environmentId === key.environmentId &&
            other.key.botId === key.botId
          ) {
            if (other.pending !== null) {
              pendingSiblings.push({ key: other.key, revision: other.pending.revision });
            } else if (other.catalog !== null) {
              entries.set(otherId, {
                ...other,
                stale: true,
                catalog: {
                  ...other.catalog,
                  current: mergeCatalogCurrent(other.catalog.current, current),
                },
              });
            } else {
              entries.delete(otherId);
            }
          }
        }
      }
      write(id, {
        ...existing,
        loading: false,
        error: null,
        stale: false,
        pending: null,
        catalog: {
          ...existing.catalog,
          current: mergeCatalogCurrent(existing.catalog.current, current),
        },
      });
      for (const sibling of pendingSiblings) {
        void load(sibling.key, {
          ...(sibling.revision !== null ? { revision: sibling.revision } : {}),
          force: true,
        });
      }
    },
    clearEnvironment(environmentId: string) {
      for (const [id, entry] of entries) {
        if (entry.key.environmentId === environmentId) entries.delete(id);
      }
      notify();
    },
    clear() {
      entries.clear();
      notify();
    },
  };
}
