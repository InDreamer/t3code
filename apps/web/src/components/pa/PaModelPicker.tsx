import {
  filterPaModelProviders,
  formatPaModelLabel,
  resolvePaModelSelection,
  type PaModelCatalogEntry,
  type PaModelCatalogKey,
} from "@t3tools/client-runtime/pa/models";
import type {
  EnvironmentId,
  PaBotSummary,
  PaCapabilities,
  PaModelProvider,
  PaSelectBotModelInput,
} from "@t3tools/contracts";
import { T, useGT, useMessages } from "gt-react";
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  Loader2Icon,
  RefreshCwIcon,
  SearchIcon,
} from "lucide-react";
import {
  type KeyboardEvent,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { useMediaQuery } from "~/hooks/useMediaQuery";
import { useClientSettings } from "~/hooks/useSettings";
import { useStableCallback } from "~/hooks/useStableCallback";
import { ComposerControl } from "../chat/ComposerControl";
import {
  EffortColumnFrame,
  EffortColumnRow,
  EffortTriggerSuffix,
  NoEffortRow,
} from "../chat/ComposerModelEffort";
import { resolveEffortGlyph } from "../chat/EffortGlyph";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { paApi, paErrorMessage, paModelCatalogs } from "./paApi";
import { PaNativeSelect } from "./PaNativeSelect";

type ModelChange = Pick<PaSelectBotModelInput, "provider" | "model" | "reasoningEffort">;

interface PickerAction {
  /** The Bot and session the action started in; another one hides it. */
  readonly scope: string;
  readonly saving: string | null;
  readonly confirm: { readonly change: ModelChange; readonly message: string } | null;
  readonly error: string | null;
}

const MODEL_ROW =
  "flex h-8 w-full shrink-0 cursor-pointer items-center gap-2 rounded-sm px-2 text-left text-sm text-foreground outline-none hover:bg-foreground/[0.09] focus-visible:bg-foreground/[0.09] disabled:cursor-not-allowed disabled:opacity-64 pointer-coarse:h-10";
const GROUP_LABEL =
  "flex items-center justify-between gap-2 px-2 pt-1.5 pb-1 text-xs font-medium text-muted-foreground";

function changeKey(change: ModelChange): string {
  return change.reasoningEffort !== undefined
    ? `effort:${change.reasoningEffort}`
    : `model:${change.provider ?? ""}/${change.model ?? ""}`;
}

const NO_CATALOG: PaModelCatalogEntry = { catalog: null, loading: false, error: null };

function usePaModelCatalog(key: PaModelCatalogKey | null): PaModelCatalogEntry {
  return useSyncExternalStore(paModelCatalogs.subscribe, () =>
    key ? paModelCatalogs.read(key) : NO_CATALOG,
  );
}

function moveBetweenModelRows(event: KeyboardEvent<HTMLElement>, onLeaveTop: () => void) {
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
  const rows = Array.from(
    event.currentTarget.querySelectorAll<HTMLButtonElement>("[data-pa-model-row]:not(:disabled)"),
  );
  const index = rows.findIndex((row) => row === document.activeElement);
  if (index < 0) return;
  event.preventDefault();
  if (event.key === "ArrowUp" && index === 0) {
    onLeaveTop();
    return;
  }
  const next = rows[Math.min(rows.length - 1, index + (event.key === "ArrowDown" ? 1 : -1))];
  next?.focus();
  next?.scrollIntoView({ block: "nearest" });
}

/** The Bot's model and effort in one trigger, with the levels docked beside the model list. */
export function PaModelPicker({
  environmentId,
  bot,
  sessionId,
  sessionModel,
  modelScope,
  open,
  onOpenChange,
  query,
  onQueryChange,
  liveReasoningEffort,
  refreshVersion = 0,
  onReasoningChanged,
  onModelChanged,
}: {
  readonly environmentId: EnvironmentId | null;
  readonly bot: PaBotSummary;
  readonly sessionId: string | null;
  readonly sessionModel: string | null;
  readonly modelScope: PaCapabilities["models"]["scope"];
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly query: string;
  readonly onQueryChange: (value: string) => void;
  readonly liveReasoningEffort?: string | null | undefined;
  readonly refreshVersion?: number | undefined;
  readonly onReasoningChanged?: ((effort: string) => void) | undefined;
  readonly onModelChanged: (model: string, sessionId: string | null) => void;
}) {
  const gt = useGT();
  const messages = useMessages();
  const effortDisplay = useClientSettings((settings) => settings.effortDisplay);
  const isCoarsePointer = useMediaQuery({ pointer: "coarse" });
  const searchInputRef = useRef<HTMLInputElement>(null);
  const popupRef = useRef<HTMLDivElement | null>(null);
  const key = environmentId ? { environmentId, botId: bot.botId, sessionId } : null;
  const scope = JSON.stringify([environmentId, bot.botId, sessionId]);
  const entry = usePaModelCatalog(key);
  const catalog = entry.catalog;
  const [action, setAction] = useState<PickerAction>({
    scope,
    saving: null,
    confirm: null,
    error: null,
  });
  const visibleAction =
    action.scope === scope ? action : { scope, saving: null, confirm: null, error: null };
  const currentScope = useStableCallback(() => scope);
  const mountedRef = useRef(false);
  const inFlightRef = useRef(false);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a selection can finish after its composer unmounts
  useLayoutEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const [showDetected, setShowDetected] = useState(false);
  const [customProvider, setCustomProvider] = useState<string | null>(null);
  const [customModel, setCustomModel] = useState("");

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reconciles the cached catalog with the roster and settings revision
  useEffect(() => {
    if (!environmentId) return;
    const target = { environmentId, botId: bot.botId, sessionId };
    const entry = paModelCatalogs.read(target);
    const cached = entry.catalog?.current;
    const drifted =
      modelScope !== "session" &&
      entry.catalog?.scope !== "session" &&
      entry.catalog !== null &&
      ((bot.model !== null && cached?.model !== bot.model) ||
        (bot.provider !== null && cached?.provider !== bot.provider));
    void paModelCatalogs.load(target, {
      revision: refreshVersion,
      force: drifted,
    });
  }, [environmentId, bot.botId, bot.model, bot.provider, modelScope, sessionId, refreshVersion]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- opening revalidates changes made on another device without hiding cached options
  useEffect(() => {
    if (!open || !environmentId) return;
    const target = { environmentId, botId: bot.botId, sessionId };
    if (!paModelCatalogs.read(target).loading) void paModelCatalogs.refresh(target, refreshVersion);
  }, [open, environmentId, bot.botId, sessionId, refreshVersion]);

  const selection = resolvePaModelSelection({
    catalog,
    bot,
    scope: modelScope,
    sessionModel,
    liveReasoningEffort,
    resolve: messages,
  });
  const reasoning = selection.reasoning;
  const label = selection.displayLabel ?? bot.agentRef;
  const glyph = reasoning ? resolveEffortGlyph(reasoning, reasoning.currentValue ?? null) : null;
  const word = glyph
    ? (glyph.special ?? (effortDisplay === "label" ? glyph.label : null))
    : selection.reasoningLabel;

  const needle = query.trim();
  const groups = filterPaModelProviders(catalog?.providers ?? [], needle);
  const primary = groups.filter((group) => group.tier === "primary");
  const detected = groups.filter((group) => group.tier === "detected");
  const shownGroups = needle || showDetected ? groups : primary;
  const customProviderId = customProvider ?? selection.provider;
  const saving = visibleAction.saving;
  const canApply =
    key !== null &&
    catalog !== null &&
    (sessionId !== null || (modelScope !== "session" && catalog.scope !== "session"));

  const focusSearch = () => searchInputRef.current?.focus();
  const focusEffort = () => {
    const column = popupRef.current?.querySelector("[data-model-picker-effort]");
    const row =
      column?.querySelector<HTMLElement>(
        '[data-effort-level][aria-checked="true"]:not(:disabled)',
      ) ?? column?.querySelector<HTMLElement>("[data-effort-row]:not(:disabled)");
    row?.focus({ preventScroll: true });
    row?.scrollIntoView({ block: "nearest" });
  };

  const apply = async (change: ModelChange, confirmed = false) => {
    if (inFlightRef.current || !canApply || !key) return;
    inFlightRef.current = true;
    const started = scope;
    const target = key;
    setAction({ scope: started, saving: changeKey(change), confirm: null, error: null });
    const result = await paApi
      .selectBotModel(target.environmentId, {
        botId: target.botId,
        ...(target.sessionId ? { sessionId: target.sessionId } : {}),
        ...change,
        ...(confirmed ? { confirm: true } : {}),
      })
      .catch((cause: unknown) => {
        if (!mountedRef.current || currentScope() !== started) return null;
        const fallback =
          change.reasoningEffort !== undefined
            ? gt("Could not change reasoning effort")
            : gt("Could not switch model");
        setAction((prev) =>
          prev.scope === started
            ? { ...prev, saving: null, error: paErrorMessage(cause, fallback) }
            : prev,
        );
        return null;
      });
    inFlightRef.current = false;
    if (!result) return;
    if (result.status === "applied") {
      paModelCatalogs.applyCurrent(target, result.current);
      if (change.reasoningEffort === undefined) {
        if (result.current.provider !== catalog?.current?.provider) {
          void paModelCatalogs.refresh(target, refreshVersion);
        }
        onModelChanged(result.current.model, target.sessionId);
      }
    }
    if (!mountedRef.current || currentScope() !== started) return;
    if (result.status === "confirmRequired") {
      setAction((prev) =>
        prev.scope === started
          ? { ...prev, saving: null, confirm: { change, message: result.message } }
          : prev,
      );
      return;
    }
    setAction((prev) => (prev.scope === started ? { ...prev, saving: null } : prev));
    if (change.reasoningEffort !== undefined) {
      onReasoningChanged?.(result.current.reasoningEffort ?? change.reasoningEffort);
      return;
    }
    setCustomModel("");
    // The column renders the new model's levels on commit.
    window.requestAnimationFrame(focusEffort);
  };

  const renderGroup = (group: PaModelProvider) => (
    <div key={group.id} role="radiogroup" aria-label={group.label} className="pb-1">
      <div className={GROUP_LABEL}>
        <span className="min-w-0 truncate">{group.label}</span>
        {group.id === selection.provider ? (
          <span className="shrink-0 text-muted-foreground/70">
            <T>Current</T>
          </span>
        ) : group.badge === "custom" ? (
          <span className="shrink-0 text-muted-foreground/70">
            <T>Custom</T>
          </span>
        ) : group.badge === "detected" ? (
          <span className="shrink-0 text-muted-foreground/70">
            <T>Auto-detect</T>
          </span>
        ) : null}
      </div>
      {group.models.map((model) => {
        const rowKey = changeKey({ provider: group.id, model: model.id });
        const selected =
          model.id === selection.model &&
          (selection.provider === null || group.id === selection.provider);
        const name = model.label ?? formatPaModelLabel(model.id);
        return (
          <button
            key={rowKey}
            type="button"
            role="radio"
            aria-checked={selected}
            data-pa-model-row
            disabled={!canApply || saving !== null}
            onClick={() => {
              if (selected) focusEffort();
              else void apply({ provider: group.id, model: model.id });
            }}
            className={MODEL_ROW}
          >
            <span className="min-w-0 flex-1 truncate">{name}</span>
            {saving === rowKey ? (
              <Loader2Icon aria-hidden="true" className="size-3.5 shrink-0 animate-spin" />
            ) : selected ? (
              <CheckIcon aria-hidden="true" className="size-3.5 shrink-0" />
            ) : null}
          </button>
        );
      })}
    </div>
  );

  const loadError = entry.error ? paErrorMessage(entry.error, gt("Could not load models")) : null;
  const notice = visibleAction.confirm ? (
    <div className="mx-2 mt-2 space-y-2 rounded-lg border border-warning/40 bg-warning/8 p-2.5 text-xs">
      <p className="whitespace-pre-wrap break-words text-foreground">
        {visibleAction.confirm.message}
      </p>
      <div className="flex justify-end gap-1.5">
        <Button
          type="button"
          size="xs"
          variant="outline"
          onClick={() => setAction((prev) => ({ ...prev, confirm: null }))}
        >
          <T>Cancel</T>
        </Button>
        <Button
          type="button"
          size="xs"
          disabled={!canApply || saving !== null}
          onClick={() => {
            const pending = visibleAction.confirm;
            if (pending) void apply(pending.change, true);
          }}
        >
          <T>Confirm switch</T>
        </Button>
      </div>
    </div>
  ) : visibleAction.error || loadError ? (
    <div className="mx-2 mt-2 flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/8 px-2.5 py-2 text-xs break-words text-destructive">
      <span className="min-w-0 flex-1">{visibleAction.error ?? loadError}</span>
      {!visibleAction.error && key ? (
        <Button
          type="button"
          size="xs"
          variant="outline"
          onClick={() => void paModelCatalogs.refresh(key, refreshVersion)}
        >
          <T>Retry</T>
        </Button>
      ) : null}
    </div>
  ) : null;

  return (
    <Popover open={open} onOpenChange={(next) => onOpenChange(next)}>
      <PopoverTrigger
        render={
          <ComposerControl
            size="sm"
            aria-label={[gt("Switch model: {model}", { model: label }), selection.reasoningLabel]
              .filter(Boolean)
              .join(", ")}
            className="group/model-trigger min-w-0 max-w-48 shrink justify-between whitespace-nowrap data-popup-open:bg-accent data-popup-open:text-foreground sm:max-w-64"
          />
        }
      >
        <span className="flex min-w-0 flex-1 items-center gap-1.5">
          <span data-chat-provider-model-picker-label="true" className="min-w-0 flex-1 truncate">
            {label}
          </span>
          {reasoning ? <EffortTriggerSuffix word={word} glyph={glyph} size="sm" /> : null}
        </span>
      </PopoverTrigger>
      <PopoverPopup
        ref={popupRef}
        initialFocus={isCoarsePointer ? popupRef : searchInputRef}
        side="top"
        align="end"
        collisionAvoidance={{ side: "shift", align: "shift" }}
        padding="none"
        className="max-w-[calc(100vw-1.5rem)] before:hidden"
        touchBackdrop
      >
        <div className="flex max-h-(--available-height) flex-col">
          <div className="flex h-86.5 min-h-0 max-sm:h-auto max-sm:flex-col">
            <div className="flex min-h-0 min-w-0 flex-1 flex-col sm:w-72 max-sm:h-72">
              <div className="flex shrink-0 items-center gap-1 px-3 pt-2.5">
                <label className="relative min-w-0 flex-1 cursor-text border-b border-border/70 pb-1.5 transition-colors focus-within:border-ring">
                  <SearchIcon
                    aria-hidden="true"
                    className="pointer-events-none absolute top-1.5 left-0 size-4 text-muted-foreground/55"
                  />
                  <input
                    ref={searchInputRef}
                    type="search"
                    aria-label={gt("Search models or providers")}
                    placeholder={gt("Search models or providers")}
                    value={query}
                    onChange={(event) => onQueryChange(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.nativeEvent.isComposing || event.keyCode === 229) return;
                      if (event.key === "ArrowDown") {
                        event.preventDefault();
                        popupRef.current
                          ?.querySelector<HTMLElement>("[data-pa-model-row]:not(:disabled)")
                          ?.focus();
                        return;
                      }
                      if (
                        event.key === "ArrowRight" &&
                        !event.altKey &&
                        !event.ctrlKey &&
                        !event.metaKey &&
                        !event.shiftKey &&
                        event.currentTarget.selectionStart === query.length
                      ) {
                        event.preventDefault();
                        focusEffort();
                        return;
                      }
                      if (event.key === "Enter" && needle) {
                        event.preventDefault();
                        const matches = shownGroups.flatMap((group) =>
                          group.models.map((model) => ({ provider: group.id, model })),
                        );
                        const exact = matches.filter(({ model }) =>
                          [model.id, model.label ?? formatPaModelLabel(model.id)].some(
                            (name) => name.toLowerCase() === needle.toLowerCase(),
                          ),
                        );
                        const match =
                          exact.length === 1 ? exact[0] : matches.length === 1 ? matches[0] : null;
                        if (!match) return;
                        if (
                          match.model.id === selection.model &&
                          (!selection.provider || match.provider === selection.provider)
                        )
                          focusEffort();
                        else void apply({ provider: match.provider, model: match.model.id });
                      }
                    }}
                    className="h-6.5 w-full min-w-0 bg-transparent ps-5 text-sm leading-6.5 outline-none placeholder:text-placeholder [&::-webkit-search-cancel-button]:appearance-none pointer-coarse:text-(length:--font-size-input-touch)"
                  />
                </label>
                <Button
                  type="button"
                  size="icon-xs"
                  variant="ghost"
                  aria-label={gt("Refresh models")}
                  disabled={!key || entry.loading}
                  onClick={() => {
                    if (key) void paModelCatalogs.refresh(key, refreshVersion);
                  }}
                >
                  <RefreshCwIcon className="size-3.5" />
                </Button>
              </div>
              {notice}
              <div
                data-model-picker-content
                className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pt-1.5 pb-1.5"
                onKeyDown={(event) => {
                  if (event.key === "ArrowRight" && !event.altKey && !event.metaKey) {
                    event.preventDefault();
                    focusEffort();
                    return;
                  }
                  moveBetweenModelRows(event, focusSearch);
                }}
              >
                {!catalog && entry.loading ? (
                  <div className="flex items-center justify-center gap-2 py-6 text-xs text-muted-foreground">
                    <Loader2Icon className="size-3.5 animate-spin" />
                    <T>Loading models…</T>
                  </div>
                ) : null}
                {catalog && groups.length === 0 ? (
                  <div className="py-6 text-center text-xs text-muted-foreground">
                    {needle ? <T>No matching models</T> : <T>No models available</T>}
                  </div>
                ) : null}
                {shownGroups.map(renderGroup)}
                {!needle && detected.length > 0 ? (
                  <button
                    type="button"
                    aria-expanded={showDetected}
                    onClick={() => setShowDetected((prev) => !prev)}
                    className="mt-1 flex h-8 w-full min-w-0 items-center gap-1.5 rounded-sm border-t border-border/50 px-2 text-left text-xs text-muted-foreground outline-none hover:bg-foreground/[0.09] hover:text-foreground focus-visible:bg-foreground/[0.09]"
                  >
                    {showDetected ? (
                      <ChevronDownIcon aria-hidden="true" className="size-3 shrink-0" />
                    ) : (
                      <ChevronRightIcon aria-hidden="true" className="size-3 shrink-0" />
                    )}
                    <span className="min-w-0 flex-1 truncate">
                      {gt("Other detected providers ({names} · {count})", {
                        names: detected.map((group) => group.label).join(" / "),
                        count: detected.reduce((sum, group) => sum + group.models.length, 0),
                      })}
                    </span>
                  </button>
                ) : null}
              </div>
              {catalog?.allowCustom ? (
                <form
                  className="flex shrink-0 flex-col gap-1.5 border-t border-border/70 px-3 py-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    const model = customModel.trim();
                    if (!model || !customProviderId) return;
                    void apply({ provider: customProviderId, model });
                  }}
                >
                  <span className="text-xs text-muted-foreground">
                    <T>Custom model</T>
                  </span>
                  <PaNativeSelect
                    aria-label={gt("Provider")}
                    value={customProviderId ?? ""}
                    onChange={(event) => setCustomProvider(event.target.value || null)}
                  >
                    <option value="" disabled>
                      {gt("Choose a provider")}
                    </option>
                    {catalog.providers.map((provider) => (
                      <option key={provider.id} value={provider.id}>
                        {provider.label}
                      </option>
                    ))}
                  </PaNativeSelect>
                  <div className="flex items-center gap-1.5">
                    <input
                      aria-label={gt("Custom model")}
                      placeholder={gt("Enter a model name")}
                      value={customModel}
                      onChange={(event) => setCustomModel(event.target.value)}
                      autoCapitalize="none"
                      autoCorrect="off"
                      spellCheck={false}
                      className="h-8 min-w-0 flex-1 rounded-md border border-input bg-background px-2 font-mono text-xs outline-none focus-visible:border-ring pointer-coarse:text-(length:--font-size-input-touch)"
                    />
                    <Button
                      type="submit"
                      size="xs"
                      disabled={
                        !canApply || !customModel.trim() || !customProviderId || saving !== null
                      }
                    >
                      <T>Use</T>
                    </Button>
                  </div>
                </form>
              ) : null}
            </div>
            <div
              data-model-picker-effort
              className="flex min-h-0 w-48 flex-col border-l border-border/70 bg-muted/40 sm:shrink-0 max-sm:h-64 max-sm:w-full max-sm:border-t max-sm:border-l-0"
              onKeyDown={(event) => {
                if (event.key !== "ArrowLeft" || event.altKey || event.ctrlKey || event.metaKey)
                  return;
                event.preventDefault();
                event.stopPropagation();
                focusSearch();
              }}
            >
              <EffortColumnFrame
                heading={
                  reasoning?.label ??
                  gt("Effort", { $context: "heading for reasoning effort levels" })
                }
                modelLabel={label}
              >
                {reasoning ? (
                  <div
                    role="radiogroup"
                    aria-label={reasoning.label}
                    className="flex flex-col gap-0.5"
                  >
                    {reasoning.options.map((option, index) => {
                      const selected = option.id === reasoning.currentValue;
                      const rowKey = changeKey({ reasoningEffort: option.id });
                      return (
                        <EffortColumnRow
                          key={option.id}
                          label={option.label}
                          selected={selected}
                          tabStop={reasoning.currentValue ? selected : index === 0}
                          disabled={!canApply || saving !== null}
                          busy={saving === rowKey}
                          onPick={() => {
                            if (!selected) void apply({ reasoningEffort: option.id });
                          }}
                        />
                      );
                    })}
                  </div>
                ) : (
                  <NoEffortRow />
                )}
              </EffortColumnFrame>
            </div>
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
