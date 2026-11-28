import { useAtomValue } from "@effect/atom-react";
import type {
  PaAvatarShape,
  PaBotConfig,
  PaBotSummary,
  PaCapabilities,
  PaConfigSection,
  PaConfigSectionValue,
  PaModelCatalog,
  PaSchedule,
} from "@t3tools/contracts";
import { T, useGT, useMessages, Var } from "gt-react";
import {
  AlertTriangleIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ClockIcon,
  CpuIcon,
  ExternalLinkIcon,
  Loader2Icon,
  PauseIcon,
  PlayIcon,
  PlusIcon,
  SaveIcon,
  SlidersHorizontalIcon,
  Trash2Icon,
  UserRoundIcon,
} from "lucide-react";
import { useEffect, useState } from "react";

import { usePrimaryEnvironmentId } from "../../state/environments";
import { useStableCallback } from "~/hooks/useStableCallback";
import {
  buildPaginationSlots,
  changedPaConfigSections,
  parseSafePaConsoleUrl,
  filterToggleItems,
  findPaMinEnabledViolation,
  modelConfirmationForDraft,
  paConfigDrafts,
  paginateItems,
  rebasePaConfigDrafts,
  TOGGLE_PAGE_SIZE,
  type ToggleFilterMode,
} from "@t3tools/client-runtime/pa/settings";
import { cn } from "../../lib/utils";
import { EffortGlyph, resolveEffortGlyph } from "../chat/EffortGlyph";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { ScrollArea } from "../ui/scroll-area";
import { Separator } from "../ui/separator";
import { Sheet, SheetDescription, SheetHeader, SheetPopup, SheetTitle } from "../ui/sheet";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { PaNativeSelect } from "./PaNativeSelect";
import { PA_AVATAR_COLORS, PA_AVATAR_SHAPES } from "@t3tools/client-runtime/pa/avatar";
import { BotAvatar } from "./BotAvatar";
import {
  paApi,
  paErrorMessage,
  paUpdateMetaPermissionAtom,
  paSelectModelPermissionAtom,
  paMutateSchedulePermissionAtom,
  paPatchConfigPermissionAtom,
} from "./paApi";
import {
  findPaModelOption,
  buildPaReasoningDescriptor,
  formatPaReasoningLabel,
  getSelectableReasoningLevels,
} from "@t3tools/client-runtime/pa/reasoning";

type SettingsTab = "profile" | "model" | "toggles" | "schedules";

const TOGGLE_FILTER_THRESHOLD = 8;

function ToggleListSection({
  section,
  value,
  defaultExpanded,
  onChange,
}: {
  readonly section: Extract<PaConfigSection, { kind: "toggleList" }>;
  readonly value: ReadonlyArray<string>;
  readonly defaultExpanded: boolean;
  readonly onChange: (enabled: ReadonlyArray<string>) => void;
}) {
  const gt = useGT();
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [filter, setFilter] = useState("");
  const [filterMode, setFilterMode] = useState<ToggleFilterMode>("all");
  const [page, setPage] = useState(1);

  const enabled = new Set(value);
  const disabledCount = section.items.length - enabled.size;
  const filteredItems = filterToggleItems(section.items, enabled, filter, filterMode);
  const pageSlice = paginateItems(filteredItems, page, TOGGLE_PAGE_SIZE);
  const paginationSlots = buildPaginationSlots(pageSlice.page, pageSlice.totalPages);
  const showFilterTabs = section.items.length > TOGGLE_PAGE_SIZE;

  const filterTabs: ReadonlyArray<{
    readonly id: ToggleFilterMode;
    readonly label: string;
  }> = [
    { id: "all", label: gt("All ({count})", { count: section.items.length }) },
    { id: "enabled", label: gt("Enabled ({count})", { count: enabled.size }) },
    { id: "disabled", label: gt("Disabled ({count})", { count: disabledCount }) },
  ];

  return (
    <div className="overflow-hidden rounded-xl border border-border/60 bg-card/40">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((prev) => !prev)}
        className="flex w-full items-center justify-between gap-2 px-3 py-2.5 text-left transition-colors hover:bg-muted/40"
      >
        <div className="flex min-w-0 items-center gap-2">
          {expanded ? (
            <ChevronDownIcon className="size-4 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground" />
          )}
          <div className="min-w-0">
            <div className="truncate font-medium text-sm text-foreground">{section.label}</div>
            {section.description ? (
              <div className="truncate text-2xs text-muted-foreground">{section.description}</div>
            ) : null}
          </div>
        </div>
        <Badge variant="outline" size="sm" className="shrink-0">
          <T>
            Enabled <Var>{enabled.size}</Var> / <Var>{section.items.length}</Var>
          </T>
        </Badge>
      </button>

      {expanded ? (
        <div className="space-y-2.5 border-t border-border/50 p-3">
          {section.items.length > TOGGLE_FILTER_THRESHOLD ? (
            <Input
              size="sm"
              type="search"
              placeholder={gt("Search names, categories or descriptions…")}
              value={filter}
              onChange={(e) => {
                setFilter(e.target.value);
                setPage(1);
              }}
            />
          ) : null}

          {showFilterTabs ? (
            <div className="flex flex-wrap items-center gap-1">
              {filterTabs.map((item) => {
                const active = filterMode === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    aria-pressed={active}
                    onClick={() => {
                      setFilterMode(item.id);
                      setPage(1);
                    }}
                    className={cn(
                      "rounded-md px-2 py-1 text-2xs font-medium transition-colors pointer-coarse:py-1.5",
                      active
                        ? "bg-accent text-accent-foreground"
                        : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                    )}
                  >
                    {item.label}
                  </button>
                );
              })}
            </div>
          ) : null}

          {pageSlice.items.length === 0 ? (
            <div className="py-6 text-center text-muted-foreground text-xs">
              <T>No matching items</T>
            </div>
          ) : (
            <div className="space-y-1.5">
              {pageSlice.items.map((item) => (
                <div
                  key={item.id}
                  className="flex items-center justify-between rounded-lg border border-border/50 bg-background/60 px-3 py-2"
                >
                  <div className="min-w-0 pr-3">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate font-medium text-xs">{item.label}</span>
                      {item.group && item.description ? (
                        <Badge variant="secondary" size="sm" className="shrink-0">
                          {item.group}
                        </Badge>
                      ) : null}
                    </div>
                    {item.description || item.group ? (
                      <div className="truncate text-2xs text-muted-foreground">
                        {item.description ?? item.group}
                      </div>
                    ) : null}
                  </div>
                  <Switch
                    size="sm"
                    checked={enabled.has(item.id)}
                    onCheckedChange={(next) => {
                      const copy = new Set(enabled);
                      if (next) copy.add(item.id);
                      else copy.delete(item.id);
                      onChange(Array.from(copy));
                    }}
                  />
                </div>
              ))}
            </div>
          )}

          {pageSlice.totalPages > 1 ? (
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/50 pt-2 text-2xs text-muted-foreground">
              <span>
                {gt("{start}–{end} of {total}", {
                  start: pageSlice.startIndex,
                  end: pageSlice.endIndex,
                  total: pageSlice.totalItems,
                })}
              </span>
              <div className="flex items-center gap-0.5">
                <Button
                  type="button"
                  size="icon-xs"
                  variant="ghost"
                  disabled={pageSlice.page <= 1}
                  aria-label={gt("Previous page")}
                  onClick={() => setPage(pageSlice.page - 1)}
                >
                  <ChevronLeftIcon className="size-3.5" />
                </Button>
                {paginationSlots.map((slot) =>
                  typeof slot === "number" ? (
                    <Button
                      key={slot}
                      type="button"
                      size="micro"
                      variant={slot === pageSlice.page ? "secondary" : "ghost"}
                      aria-current={slot === pageSlice.page ? "page" : undefined}
                      onClick={() => setPage(slot)}
                    >
                      {slot}
                    </Button>
                  ) : (
                    <span key={slot} className="px-1 text-muted-foreground">
                      …
                    </span>
                  ),
                )}
                <Button
                  type="button"
                  size="icon-xs"
                  variant="ghost"
                  disabled={pageSlice.page >= pageSlice.totalPages}
                  aria-label={gt("Next page")}
                  onClick={() => setPage(pageSlice.page + 1)}
                >
                  <ChevronRightIcon className="size-3.5" />
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function OptionsSection({
  section,
  value,
  onChange,
}: {
  readonly section: Extract<PaConfigSection, { kind: "options" }>;
  readonly value: Readonly<Record<string, string | boolean>>;
  readonly onChange: (values: Readonly<Record<string, string | boolean>>) => void;
}) {
  return (
    <div className="space-y-3">
      {section.fields.map((field) => {
        const id = `pa-config-${section.id}-${field.id}`;
        const current = value[field.id];
        const set = (next: string | boolean) => onChange({ ...value, [field.id]: next });
        switch (field.kind) {
          case "text":
            return (
              <div key={field.id} className="space-y-1.5">
                <Label htmlFor={id}>{field.label}</Label>
                <Input
                  id={id}
                  value={typeof current === "string" ? current : ""}
                  placeholder={field.placeholder}
                  onChange={(e) => set(e.target.value)}
                />
              </div>
            );
          case "toggle":
            return (
              <div
                key={field.id}
                className="flex items-center justify-between rounded-lg border border-border/60 px-3 py-2.5"
              >
                <Label htmlFor={id}>{field.label}</Label>
                <Switch id={id} checked={current === true} onCheckedChange={set} />
              </div>
            );
          case "select":
            return (
              <div key={field.id} className="space-y-1.5">
                <Label htmlFor={id}>{field.label}</Label>
                <PaNativeSelect
                  id={id}
                  value={typeof current === "string" ? current : ""}
                  onChange={(e) => set(e.target.value)}
                >
                  {field.choices.map((choice) => (
                    <option key={choice.id} value={choice.id}>
                      {choice.label}
                    </option>
                  ))}
                </PaNativeSelect>
              </div>
            );
        }
      })}
    </div>
  );
}

function BotSettingsBody({
  bot,
  capabilities,
  onClose,
  onSaved,
}: {
  readonly bot: PaBotSummary;
  readonly capabilities: PaCapabilities | null;
  readonly onClose: () => void;
  readonly onSaved: () => void;
}) {
  const gt = useGT();
  const m = useMessages();
  const environmentId = usePrimaryEnvironmentId();
  const canEditMeta = useAtomValue(paUpdateMetaPermissionAtom(environmentId));
  const canEditConfig = useAtomValue(paPatchConfigPermissionAtom(environmentId));
  const canSelectModel = useAtomValue(paSelectModelPermissionAtom(environmentId));
  const canMutateSchedule = useAtomValue(paMutateSchedulePermissionAtom(environmentId));
  const configSupported = canEditConfig && capabilities?.config.supported === true;
  const modelsSupported =
    canSelectModel &&
    capabilities?.models.supported === true &&
    capabilities.models.scope !== "session";
  const schedulesSupported = canMutateSchedule && capabilities?.schedules.supported === true;

  const [tab, setTab] = useState<SettingsTab>("profile");
  const [loading, setLoading] = useState(configSupported || modelsSupported || schedulesSupported);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedNotice, setSavedNotice] = useState<string | null>(null);
  /** The model pick the engine asked to confirm; confirming resends exactly that pick. */
  const [pendingConfirm, setPendingConfirm] = useState<{
    readonly message: string;
    readonly provider: string;
    readonly model: string;
  } | null>(null);

  const [name, setName] = useState(bot.name);
  const [avatarColor, setAvatarColor] = useState(bot.avatarColor);
  const [avatarShape, setAvatarShape] = useState<PaAvatarShape>(bot.avatarShape);
  const [pinned, setPinned] = useState(bot.pinned);
  const [savedMeta, setSavedMeta] = useState({
    name: bot.name,
    avatarColor: bot.avatarColor,
    avatarShape: bot.avatarShape,
    pinned: bot.pinned,
  });

  const [config, setConfig] = useState<PaBotConfig | null>(null);
  const nativeConsoleUrl = parseSafePaConsoleUrl(config?.nativeConsoleUrl);
  const [drafts, setDrafts] = useState<Record<string, PaConfigSectionValue>>({});
  const [catalog, setCatalog] = useState<PaModelCatalog | null>(null);
  const [provider, setProvider] = useState("");
  const [model, setModel] = useState("");
  const [reasoningEffort, setReasoningEffort] = useState("");
  const getModelDraft = useStableCallback(() => ({ provider, model }));

  const [schedules, setSchedules] = useState<ReadonlyArray<PaSchedule>>([]);
  const [scheduleBusy, setScheduleBusy] = useState(false);
  const [newScheduleName, setNewScheduleName] = useState("");
  const [newScheduleSpec, setNewScheduleSpec] = useState("every 1h");
  const [newSchedulePrompt, setNewSchedulePrompt] = useState("");
  const [newScheduleDeliver, setNewScheduleDeliver] = useState("");

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads the agent's config sections, model catalog and schedules when the editor opens
  useEffect(() => {
    let cancelled = false;
    const loads: Array<Promise<unknown>> = [];
    if (configSupported) {
      loads.push(
        paApi.getBotConfig(bot.botId).then((loaded) => {
          if (cancelled) return;
          setConfig(loaded);
          setDrafts(paConfigDrafts(loaded));
        }),
      );
    }
    if (modelsSupported && environmentId) {
      loads.push(
        paApi.getBotModels(environmentId, bot.botId).then((loaded) => {
          if (cancelled) return;
          setCatalog(loaded);
          setProvider(loaded.current?.provider ?? "");
          setModel(loaded.current?.model ?? "");
          setReasoningEffort(loaded.current?.reasoningEffort ?? "");
        }),
      );
    }
    if (schedulesSupported) {
      loads.push(
        paApi.listSchedules(bot.botId).then((loaded) => {
          if (!cancelled) setSchedules(loaded);
        }),
      );
    }
    Promise.all(loads)
      .catch((err) => {
        if (!cancelled) setError(paErrorMessage(err, gt("Could not load bot settings")));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [bot.botId, configSupported, modelsSupported, schedulesSupported, gt, environmentId]);

  const sections = configSupported ? (config?.sections ?? []) : [];
  const profileSections = sections.filter((s) => s.kind !== "toggleList");
  const toggleSections = sections.filter(
    (s): s is Extract<PaConfigSection, { kind: "toggleList" }> => s.kind === "toggleList",
  );
  const activeProvider =
    catalog?.providers.find((p) => p.id === provider) ??
    catalog?.providers.find((p) => p.isCurrent) ??
    null;
  const selectedProviderId = provider || activeProvider?.id || catalog?.current?.provider || null;
  const selectedModelOption = findPaModelOption(catalog, selectedProviderId, model || null);
  const reasoningLevels = getSelectableReasoningLevels(catalog, selectedProviderId, model || null);
  const reasoningDescriptor = buildPaReasoningDescriptor(
    catalog,
    selectedProviderId,
    model || null,
    null,
    m,
  );

  const handleSave = async (
    confirmed: { readonly provider: string; readonly model: string } | null = null,
  ) => {
    const nextName = name.trim() || bot.agentRef;
    const metaPatch = !canEditMeta
      ? {}
      : {
          ...(nextName !== savedMeta.name ? { name: nextName } : {}),
          ...(avatarColor !== savedMeta.avatarColor ? { avatarColor } : {}),
          ...(avatarShape !== savedMeta.avatarShape ? { avatarShape } : {}),
          ...(pinned !== savedMeta.pinned ? { pinned } : {}),
        };
    const changedSections = changedPaConfigSections(sections, drafts);
    const currentModel = catalog?.current ?? null;
    const providerField = provider;
    const modelField = model;
    const reasoningField = reasoningEffort;
    const submittedModel = confirmed?.model ?? model.trim();
    // "Follow default" still pins a concrete provider: the engine cannot pin a model without one.
    const submittedProvider =
      confirmed?.provider ?? (provider || activeProvider?.id || currentModel?.provider || "");
    const modelChanged =
      modelsSupported &&
      catalog !== null &&
      submittedModel.length > 0 &&
      (confirmed !== null ||
        submittedModel !== currentModel?.model ||
        (provider !== "" && provider !== currentModel?.provider));
    const validReasoning = reasoningLevels.some((level) => level.id === reasoningEffort)
      ? reasoningEffort
      : "";
    const reasoningChanged =
      modelsSupported &&
      catalog !== null &&
      validReasoning.length > 0 &&
      validReasoning !== (currentModel?.reasoningEffort ?? "");

    if (
      Object.keys(metaPatch).length === 0 &&
      changedSections.length === 0 &&
      !modelChanged &&
      !reasoningChanged
    ) {
      setSavedNotice(gt("No changes to save"));
      return;
    }
    if (modelChanged && !submittedProvider) {
      setError(gt("Select a model provider"));
      return;
    }
    const belowMinimum = findPaMinEnabledViolation(changedSections, drafts);
    if (belowMinimum) {
      setError(
        gt("Enable at least {count} items in {section}", {
          section: belowMinimum.label,
          count: belowMinimum.minEnabled ?? 0,
        }),
      );
      return;
    }

    setSaving(true);
    setError(null);
    setSavedNotice(null);
    setPendingConfirm(null);
    // Each block that lands becomes the new baseline at once, so a later failure cannot leave
    // saved edits looking unsaved; drafts typed during the save are kept, not overwritten.
    try {
      if (Object.keys(metaPatch).length > 0) {
        await paApi.updateBotMeta({ botId: bot.botId, ...metaPatch });
        setSavedMeta({ name: nextName, avatarColor, avatarShape, pinned });
        const submittedName = name;
        setName((current) => (current === submittedName ? nextName : current));
        onSaved();
      }
      let baseline = config;
      for (const section of changedSections) {
        const submitted = drafts[section.id]!;
        const nextConfig = await paApi.patchBotConfig(bot.botId, section.id, submitted);
        setConfig(nextConfig);
        const previous = baseline;
        baseline = nextConfig;
        setDrafts((prev) =>
          rebasePaConfigDrafts(prev, previous, nextConfig, section.id, submitted),
        );
        onSaved();
      }
      if (
        (modelChanged || reasoningChanged) &&
        catalog &&
        catalog.scope !== "session" &&
        environmentId
      ) {
        const result = await paApi.selectBotModel(environmentId, {
          botId: bot.botId,
          ...(modelChanged ? { provider: submittedProvider, model: submittedModel } : {}),
          ...(reasoningChanged ? { reasoningEffort: validReasoning } : {}),
          ...(confirmed ? { confirm: true } : {}),
        });
        if (result.status === "confirmRequired") {
          setPendingConfirm(
            modelConfirmationForDraft(
              getModelDraft(),
              { provider: providerField, model: modelField },
              { provider: submittedProvider, model: submittedModel, message: result.message },
            ),
          );
          setSaving(false);
          return;
        }
        const nextCurrent = {
          ...(catalog.current?.reasoningEffort !== undefined
            ? { reasoningEffort: catalog.current.reasoningEffort }
            : {}),
          ...result.current,
        };
        setCatalog((prev) => (prev ? { ...prev, current: nextCurrent } : prev));
        if (modelChanged) {
          // "Follow default" is no longer offered once a provider is pinned: show the saved pick,
          // unless the fields were changed while saving.
          setProvider((current) =>
            current === providerField ? (nextCurrent.provider ?? "") : current,
          );
          setModel((current) => (current === modelField ? nextCurrent.model : current));
        }
        if (reasoningChanged && nextCurrent.reasoningEffort !== undefined) {
          setReasoningEffort((current) =>
            current === reasoningField ? (nextCurrent.reasoningEffort ?? "") : current,
          );
        }
        onSaved();
      }
      setSavedNotice(gt("Saved"));
    } catch (err) {
      setError(paErrorMessage(err, gt("Could not save")));
    }
    setSaving(false);
  };

  const mutateSchedule = async (
    input: Omit<Parameters<typeof paApi.mutateSchedule>[0], "botId">,
    fallback: string,
  ) => {
    if (!schedulesSupported || scheduleBusy) return false;
    setScheduleBusy(true);
    setError(null);
    let ok = false;
    try {
      setSchedules(await paApi.mutateSchedule({ botId: bot.botId, ...input }));
      ok = true;
    } catch (err) {
      setError(paErrorMessage(err, fallback));
    }
    setScheduleBusy(false);
    return ok;
  };

  const handleAddSchedule = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newSchedulePrompt.trim() || !newScheduleSpec.trim()) return;
    const added = await mutateSchedule(
      {
        action: "add",
        ...(newScheduleName.trim() ? { name: newScheduleName.trim() } : {}),
        schedule: newScheduleSpec.trim(),
        prompt: newSchedulePrompt.trim(),
        ...(newScheduleDeliver.trim() ? { deliver: newScheduleDeliver.trim() } : {}),
      },
      gt("Could not add scheduled task"),
    );
    if (added) {
      setNewScheduleName("");
      setNewSchedulePrompt("");
      setNewScheduleDeliver("");
    }
  };

  const tabs: ReadonlyArray<{ id: SettingsTab; label: string; icon: React.ReactNode }> = [
    { id: "profile", label: gt("Profile"), icon: <UserRoundIcon className="size-3.5" /> },
    ...(modelsSupported
      ? [{ id: "model" as const, label: gt("Model"), icon: <CpuIcon className="size-3.5" /> }]
      : []),
    ...(toggleSections.length > 0
      ? [
          {
            id: "toggles" as const,
            label: gt("Capabilities"),
            icon: <SlidersHorizontalIcon className="size-3.5" />,
          },
        ]
      : []),
    ...(schedulesSupported
      ? [
          {
            id: "schedules" as const,
            label: gt("Schedule"),
            icon: <ClockIcon className="size-3.5" />,
          },
        ]
      : []),
  ];
  const activeTab = tabs.some((item) => item.id === tab) ? tab : "profile";

  return (
    <>
      <div className="border-b border-border/60 pt-safe">
        <SheetHeader>
          <div className="flex items-center gap-3 pr-8">
            <BotAvatar color={avatarColor} shape={avatarShape} size="sm" starred={pinned} />
            <div className="min-w-0 flex-1">
              <SheetTitle>
                <span className="block truncate text-base">{name || bot.name}</span>
              </SheetTitle>
              <SheetDescription>
                <span className="block truncate text-xs">
                  {gt("{engine} · {agent}", { engine: bot.engineLabel, agent: bot.agentRef })}
                </span>
              </SheetDescription>
            </div>
            {nativeConsoleUrl ? (
              <Button
                size="xs"
                variant="ghost"
                render={<a href={nativeConsoleUrl} target="_blank" rel="noreferrer" />}
              >
                <ExternalLinkIcon className="size-3.5" />
                <T>Advanced settings</T>
              </Button>
            ) : null}
          </div>

          {tabs.length > 1 ? (
            <div
              className="mt-3 grid gap-1 rounded-lg bg-muted/60 p-1"
              style={{ gridTemplateColumns: `repeat(${tabs.length}, minmax(0, 1fr))` }}
            >
              {tabs.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setTab(item.id)}
                  className={cn(
                    "flex items-center justify-center gap-1 rounded-md py-1.5 font-medium text-xs transition-colors pointer-coarse:py-2",
                    activeTab === item.id
                      ? "bg-background text-foreground shadow-xs"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {item.icon}
                  <span>{item.label}</span>
                </button>
              ))}
            </div>
          ) : null}
        </SheetHeader>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-4 p-5">
          {loading ? (
            <div className="flex items-center justify-center py-12 text-muted-foreground text-sm">
              <Loader2Icon className="mr-2 size-4 animate-spin" />
              <T>Loading settings…</T>
            </div>
          ) : null}

          {error ? (
            <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-destructive text-xs">
              {error}
            </div>
          ) : null}

          {modelsSupported && pendingConfirm ? (
            <div className="space-y-2 rounded-lg border border-warning/40 bg-warning-surface p-3 text-warning-foreground text-xs">
              <div className="flex items-start gap-2">
                <AlertTriangleIcon className="mt-0.5 size-4 shrink-0" />
                <p className="whitespace-pre-wrap">{pendingConfirm.message}</p>
              </div>
              <div className="flex justify-end gap-2">
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  disabled={saving}
                  onClick={() => setPendingConfirm(null)}
                >
                  <T>Cancel</T>
                </Button>
                <Button
                  type="button"
                  size="xs"
                  disabled={saving}
                  onClick={() =>
                    void handleSave({
                      provider: pendingConfirm.provider,
                      model: pendingConfirm.model,
                    })
                  }
                >
                  <T>Confirm switch</T>
                </Button>
              </div>
            </div>
          ) : null}

          {savedNotice ? (
            <div className="rounded-lg border border-success/40 bg-success/10 px-3 py-2 text-success text-xs">
              {savedNotice}
            </div>
          ) : null}

          {!loading && activeTab === "profile" ? (
            <div className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="pa-edit-name">
                  <T>Name</T>
                </Label>
                <Input
                  disabled={!canEditMeta}
                  id="pa-edit-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </div>

              <div className="flex items-center justify-between rounded-lg border border-border/60 px-3 py-2.5">
                <div>
                  <div className="font-medium text-sm">
                    <T>Pin to top</T>
                  </div>
                  <div className="text-muted-foreground text-xs">
                    <T>Show in the pinned bots section</T>
                  </div>
                </div>
                <Switch disabled={!canEditMeta} checked={pinned} onCheckedChange={setPinned} />
              </div>

              <div className="space-y-2">
                <Label>
                  <T>Avatar appearance</T>
                </Label>
                <div className="flex flex-wrap gap-1.5">
                  {PA_AVATAR_SHAPES.map((item) => (
                    <button
                      key={item.value}
                      type="button"
                      disabled={!canEditMeta}
                      onClick={() => setAvatarShape(item.value)}
                      className={cn(
                        "flex items-center gap-1 rounded-lg border px-2 py-1 text-xs",
                        avatarShape === item.value
                          ? "border-primary bg-primary/10 text-foreground"
                          : "border-border/60 text-muted-foreground hover:bg-muted/40",
                      )}
                    >
                      <BotAvatar
                        color={avatarColor}
                        shape={item.value}
                        size="sm"
                        className="size-4"
                      />
                      <span>{m(item.label)}</span>
                    </button>
                  ))}
                </div>
                <div className="flex flex-wrap gap-2 pt-1">
                  {PA_AVATAR_COLORS.map((swatch) => (
                    <button
                      key={swatch.value}
                      type="button"
                      aria-label={m(swatch.label)}
                      disabled={!canEditMeta}
                      onClick={() => setAvatarColor(swatch.value)}
                      className={cn(
                        "size-6 rounded-full pointer-coarse:size-8",
                        avatarColor === swatch.value &&
                          "ring-2 ring-foreground ring-offset-2 ring-offset-background",
                      )}
                      style={{ backgroundColor: swatch.value }}
                    />
                  ))}
                </div>
              </div>

              {profileSections.map((section) => {
                const draft = drafts[section.id];
                if (section.kind === "document" && draft?.kind === "document") {
                  const id = `pa-config-${section.id}`;
                  return (
                    <div key={section.id} className="space-y-1.5">
                      <Label htmlFor={id}>
                        {section.label}
                        {section.description ? (
                          <span className="font-normal text-muted-foreground">
                            {" "}
                            · {section.description}
                          </span>
                        ) : null}
                      </Label>
                      <Textarea
                        id={id}
                        rows={8}
                        value={draft.text}
                        placeholder={
                          section.placeholder ?? gt("Enter system instructions for this bot…")
                        }
                        onChange={(e) =>
                          setDrafts((prev) => ({
                            ...prev,
                            [section.id]: { kind: "document", text: e.target.value },
                          }))
                        }
                      />
                    </div>
                  );
                }
                if (section.kind === "options" && draft?.kind === "options") {
                  return (
                    <OptionsSection
                      key={section.id}
                      section={section}
                      value={draft.values}
                      onChange={(values) =>
                        setDrafts((prev) => ({
                          ...prev,
                          [section.id]: { kind: "options", values },
                        }))
                      }
                    />
                  );
                }
                return null;
              })}
            </div>
          ) : null}

          {!loading && activeTab === "model" && catalog ? (
            <div className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="pa-model-provider">
                  <T>Model provider</T>
                </Label>
                <PaNativeSelect
                  id="pa-model-provider"
                  value={provider}
                  onChange={(e) => {
                    const next = e.target.value;
                    setProvider(next);
                    setPendingConfirm(null);
                    const found = catalog.providers.find((p) => p.id === next);
                    if (found?.models[0]) setModel(found.models[0].id);
                  }}
                >
                  {catalog.current?.provider ? null : <option value="">{gt("Use default")}</option>}
                  {catalog.providers.map((opt) => (
                    <option key={opt.id} value={opt.id}>
                      {opt.label} ({opt.id})
                    </option>
                  ))}
                </PaNativeSelect>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="pa-model-name">
                  <T>Default model</T>
                </Label>
                {activeProvider && activeProvider.models.length > 0 ? (
                  <PaNativeSelect
                    id="pa-model-name"
                    value={model}
                    onChange={(e) => {
                      setModel(e.target.value);
                      setPendingConfirm(null);
                    }}
                  >
                    {model && !activeProvider.models.some((item) => item.id === model) ? (
                      <option value={model}>{gt("{model} (current)", { model })}</option>
                    ) : null}
                    {activeProvider.models.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.id}
                      </option>
                    ))}
                  </PaNativeSelect>
                ) : catalog.allowCustom ? (
                  <Input
                    id="pa-model-name"
                    value={model}
                    onChange={(e) => {
                      setModel(e.target.value);
                      setPendingConfirm(null);
                    }}
                    placeholder={gt("Enter a model name")}
                  />
                ) : (
                  <div className="text-muted-foreground text-xs">
                    <T>No models available</T>
                  </div>
                )}
              </div>

              {reasoningLevels.length > 0 ? (
                <div className="space-y-1.5">
                  <Label>
                    <T>Reasoning effort</T>
                  </Label>
                  <div
                    role="radiogroup"
                    aria-label={gt("Reasoning effort")}
                    className="grid grid-cols-4 gap-1.5"
                  >
                    {reasoningLevels.map((level) => {
                      const selected = level.id.toLowerCase() === reasoningEffort.toLowerCase();
                      const glyph = reasoningDescriptor
                        ? resolveEffortGlyph(reasoningDescriptor, level.id)
                        : null;
                      return (
                        <button
                          key={level.id}
                          type="button"
                          role="radio"
                          aria-checked={selected}
                          onClick={() => setReasoningEffort(level.id)}
                          className={cn(
                            "flex items-center justify-center gap-1.5 rounded-lg border px-2 py-1.5 text-xs transition-colors",
                            selected
                              ? "border-primary bg-primary/10 font-medium text-foreground"
                              : "border-border/60 text-muted-foreground hover:bg-muted/40 hover:text-foreground",
                          )}
                        >
                          {glyph ? (
                            <EffortGlyph count={glyph.count} filled={glyph.filled} size="xs" />
                          ) : null}
                          <span className="truncate">
                            {formatPaReasoningLabel(level.id, level.label, m)}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ) : selectedModelOption?.reasoning === false ? (
                <p className="text-2xs text-muted-foreground">
                  <T>This model does not support changing reasoning effort</T>
                </p>
              ) : null}
            </div>
          ) : null}

          {!loading && activeTab === "toggles" ? (
            <div className="space-y-3">
              {toggleSections.map((section, index) => {
                const draft = drafts[section.id];
                return (
                  <ToggleListSection
                    key={section.id}
                    section={section}
                    defaultExpanded={index === 0}
                    value={draft?.kind === "toggleList" ? draft.enabled : []}
                    onChange={(enabled) =>
                      setDrafts((prev) => ({
                        ...prev,
                        [section.id]: { kind: "toggleList", enabled },
                      }))
                    }
                  />
                );
              })}
            </div>
          ) : null}

          {!loading && activeTab === "schedules" ? (
            <div className="space-y-4">
              <div className="space-y-2">
                <Label>
                  <T>
                    Scheduled tasks (<Var>{schedules.length}</Var>)
                  </T>
                </Label>
                {schedules.length === 0 ? (
                  <div className="rounded-lg border border-dashed border-border/60 py-6 text-center text-muted-foreground text-xs">
                    <T>This bot has no scheduled tasks yet</T>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {schedules.map((job) => (
                      <div
                        key={job.id}
                        className={cn(
                          "space-y-1.5 rounded-lg border border-border/60 p-3",
                          !job.enabled && "opacity-70",
                        )}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <div className="min-w-0">
                            <div className="flex items-center gap-1.5">
                              <span className="truncate font-medium text-xs">{job.name}</span>
                              {!job.enabled ? (
                                <Badge variant="outline" size="sm">
                                  <T>Paused</T>
                                </Badge>
                              ) : null}
                            </div>
                            <div className="text-2xs text-muted-foreground">
                              {job.nextRunAt
                                ? gt("{schedule} · Next run {nextRunAt}", {
                                    schedule: job.schedule,
                                    nextRunAt: job.nextRunAt,
                                  })
                                : job.schedule}
                            </div>
                          </div>
                          <div className="flex shrink-0 items-center gap-1">
                            <Button
                              type="button"
                              size="icon"
                              variant="ghost"
                              className="size-7"
                              disabled={scheduleBusy}
                              title={job.enabled ? gt("Pause") : gt("Resume")}
                              onClick={() =>
                                void mutateSchedule(
                                  { action: job.enabled ? "pause" : "resume", scheduleId: job.id },
                                  gt("Schedule operation failed"),
                                )
                              }
                            >
                              {job.enabled ? (
                                <PauseIcon className="size-3.5" />
                              ) : (
                                <PlayIcon className="size-3.5" />
                              )}
                            </Button>
                            <Button
                              type="button"
                              size="icon"
                              variant="ghost-destructive"
                              className="size-7"
                              disabled={scheduleBusy}
                              title={gt("Delete")}
                              onClick={() =>
                                void mutateSchedule(
                                  { action: "remove", scheduleId: job.id },
                                  gt("Schedule operation failed"),
                                )
                              }
                            >
                              <Trash2Icon className="size-3.5" />
                            </Button>
                          </div>
                        </div>
                        {job.prompt ? (
                          <p className="line-clamp-2 text-2xs text-muted-foreground">
                            {job.prompt}
                          </p>
                        ) : null}
                        {job.deliver ? (
                          <div className="truncate text-2xs text-muted-foreground">
                            {gt("Deliver to {deliver}", { deliver: job.deliver })}
                          </div>
                        ) : null}
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <Separator />

              <form onSubmit={handleAddSchedule} className="space-y-2.5">
                <Label>
                  <T>New scheduled task</T>
                </Label>
                <Input
                  placeholder={gt("Task name (e.g. daily briefing)")}
                  value={newScheduleName}
                  onChange={(e) => setNewScheduleName(e.target.value)}
                />
                <Input
                  placeholder={gt("Schedule (e.g. every 1h or 0 9 * * *)")}
                  value={newScheduleSpec}
                  onChange={(e) => setNewScheduleSpec(e.target.value)}
                />
                <Textarea
                  rows={3}
                  placeholder={gt("Instructions for the bot when the task runs…")}
                  value={newSchedulePrompt}
                  onChange={(e) => setNewSchedulePrompt(e.target.value)}
                />
                <Input
                  placeholder={gt("Delivery target (optional, e.g. local, origin or {example})", {
                    example: "telegram:<id>",
                  })}
                  aria-label={gt("Delivery target")}
                  value={newScheduleDeliver}
                  maxLength={200}
                  onChange={(e) => setNewScheduleDeliver(e.target.value)}
                />
                <Button
                  type="submit"
                  size="sm"
                  variant="secondary"
                  disabled={scheduleBusy || !newSchedulePrompt.trim() || !newScheduleSpec.trim()}
                  className="w-full"
                >
                  {scheduleBusy ? (
                    <Loader2Icon className="mr-1.5 size-3.5 animate-spin" />
                  ) : (
                    <PlusIcon className="mr-1.5 size-3.5" />
                  )}
                  <T>Add scheduled task</T>
                </Button>
              </form>
            </div>
          ) : null}
        </div>
      </ScrollArea>

      {activeTab !== "schedules" ? (
        <div className="flex items-center justify-end gap-2 border-t border-border/60 px-5 py-3">
          <Button type="button" variant="outline" size="sm" onClick={onClose}>
            <T>Close</T>
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={saving || loading || !(canEditMeta || configSupported || modelsSupported)}
            onClick={() => void handleSave()}
          >
            {saving ? (
              <Loader2Icon className="mr-1.5 size-3.5 animate-spin" />
            ) : (
              <SaveIcon className="mr-1.5 size-3.5" />
            )}
            <T>Save changes</T>
          </Button>
        </div>
      ) : null}
    </>
  );
}

export function BotSettingsSheet({
  bot,
  capabilities,
  open,
  onOpenChange,
  onSaved,
}: {
  readonly bot: PaBotSummary | null;
  readonly capabilities: PaCapabilities | null;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSaved: () => void;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetPopup side="right" className="flex w-full max-w-md flex-col">
        {open && bot ? (
          // Clears the home indicator and a landscape notch on the sheet's docked edge.
          <div className="flex min-h-0 flex-1 flex-col pr-safe pb-safe">
            <BotSettingsBody
              key={bot.botId}
              bot={bot}
              capabilities={capabilities}
              onClose={() => onOpenChange(false)}
              onSaved={onSaved}
            />
          </div>
        ) : null}
      </SheetPopup>
    </Sheet>
  );
}
