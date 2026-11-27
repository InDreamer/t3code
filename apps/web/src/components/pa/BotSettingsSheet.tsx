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

import { useStableCallback } from "~/hooks/useStableCallback";
import { modelConfirmationForDraft } from "./BotSettingsSheet.logic";
import { cn } from "../../lib/utils";
import { EffortGlyph } from "../chat/EffortGlyph";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { ScrollArea } from "../ui/scroll-area";
import { Separator } from "../ui/separator";
import { Sheet, SheetDescription, SheetHeader, SheetPopup, SheetTitle } from "../ui/sheet";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { BotAvatar, PA_AVATAR_COLORS, PA_AVATAR_SHAPES } from "./BotAvatar";
import { paApi, paErrorMessage } from "./paApi";
import {
  findPaModelOption,
  formatPaReasoningLabel,
  getSelectableReasoningLevels,
  resolvePaReasoningGlyph,
} from "./paReasoning";

type SettingsTab = "profile" | "model" | "toggles" | "schedules";

const TOGGLE_FILTER_THRESHOLD = 8;

function initialSectionValue(section: PaConfigSection): PaConfigSectionValue {
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

function sameSectionValue(a: PaConfigSectionValue, b: PaConfigSectionValue): boolean {
  if (a.kind === "toggleList" && b.kind === "toggleList") {
    const left = [...a.enabled].sort();
    const right = [...b.enabled].sort();
    return left.length === right.length && left.every((id, i) => id === right[i]);
  }
  return JSON.stringify(a) === JSON.stringify(b);
}

function draftsFor(config: PaBotConfig): Record<string, PaConfigSectionValue> {
  return Object.fromEntries(config.sections.map((s) => [s.id, initialSectionValue(s)]));
}

/**
 * Moves drafts onto the config a section save returned. The saved section takes its stored value
 * unless it was edited again meanwhile; any other section the user has not edited here follows
 * the new config too, so a stale copy cannot overwrite another device's change on the next save.
 */
function rebaseDrafts(
  drafts: Record<string, PaConfigSectionValue>,
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
        ? draft === undefined || sameSectionValue(draft, submitted)
        : draft === undefined ||
          before === undefined ||
          sameSectionValue(draft, initialSectionValue(before));
    if (untouched) rebased[section.id] = initialSectionValue(section);
  }
  return rebased;
}

function ToggleListSection({
  section,
  value,
  onChange,
}: {
  readonly section: Extract<PaConfigSection, { kind: "toggleList" }>;
  readonly value: ReadonlyArray<string>;
  readonly onChange: (enabled: ReadonlyArray<string>) => void;
}) {
  const gt = useGT();
  const [filter, setFilter] = useState("");
  const enabled = new Set(value);
  const needle = filter.trim().toLowerCase();
  const items = needle
    ? section.items.filter(
        (item) =>
          item.label.toLowerCase().includes(needle) ||
          (item.group ?? "").toLowerCase().includes(needle),
      )
    : section.items;
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <Label>{section.label}</Label>
        <Badge variant="outline" size="sm">
          <T>
            已启用 <Var>{enabled.size}</Var> / <Var>{section.items.length}</Var>
          </T>
        </Badge>
      </div>
      {section.description ? (
        <p className="text-2xs text-muted-foreground">{section.description}</p>
      ) : null}
      {section.items.length > TOGGLE_FILTER_THRESHOLD ? (
        <Input
          placeholder={gt("搜索名称或分类...")}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      ) : null}
      {items.length === 0 ? (
        <div className="py-6 text-center text-muted-foreground text-xs">
          <T>没有匹配的项目</T>
        </div>
      ) : (
        <div className="space-y-1.5">
          {items.map((item) => (
            <div
              key={item.id}
              className="flex items-center justify-between rounded-lg border border-border/50 px-3 py-2"
            >
              <div className="min-w-0 pr-3">
                <div className="truncate font-medium text-xs">{item.label}</div>
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
                <select
                  id={id}
                  value={typeof current === "string" ? current : ""}
                  onChange={(e) => set(e.target.value)}
                  className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                >
                  {field.choices.map((choice) => (
                    <option key={choice.id} value={choice.id}>
                      {choice.label}
                    </option>
                  ))}
                </select>
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
  const configSupported = capabilities?.config.supported === true;
  const modelsSupported = capabilities?.models.supported === true;
  const schedulesSupported = capabilities?.schedules.supported === true;

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

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads the agent's config sections, model catalog and schedules when the editor opens
  useEffect(() => {
    let cancelled = false;
    const loads: Array<Promise<unknown>> = [];
    if (configSupported) {
      loads.push(
        paApi.getBotConfig(bot.botId).then((loaded) => {
          if (cancelled) return;
          setConfig(loaded);
          setDrafts(draftsFor(loaded));
        }),
      );
    }
    if (modelsSupported) {
      loads.push(
        paApi.getBotModels(bot.botId).then((loaded) => {
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
        if (!cancelled) setError(paErrorMessage(err, gt("加载 Bot 配置失败")));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [bot.botId, configSupported, modelsSupported, schedulesSupported, gt]);

  const sections = config?.sections ?? [];
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

  const handleSave = async (
    confirmed: { readonly provider: string; readonly model: string } | null = null,
  ) => {
    const nextName = name.trim() || bot.agentRef;
    const metaPatch = {
      ...(nextName !== savedMeta.name ? { name: nextName } : {}),
      ...(avatarColor !== savedMeta.avatarColor ? { avatarColor } : {}),
      ...(avatarShape !== savedMeta.avatarShape ? { avatarShape } : {}),
      ...(pinned !== savedMeta.pinned ? { pinned } : {}),
    };
    const changedSections = sections.filter((section) => {
      const draft = drafts[section.id];
      return draft !== undefined && !sameSectionValue(draft, initialSectionValue(section));
    });
    const currentModel = catalog?.current ?? null;
    const providerField = provider;
    const modelField = model;
    const reasoningField = reasoningEffort;
    const submittedModel = confirmed?.model ?? model.trim();
    // "Follow default" still pins a concrete provider: the engine cannot pin a model without one.
    const submittedProvider =
      confirmed?.provider ?? (provider || activeProvider?.id || currentModel?.provider || "");
    const modelChanged =
      catalog !== null &&
      submittedModel.length > 0 &&
      (confirmed !== null ||
        submittedModel !== currentModel?.model ||
        (provider !== "" && provider !== currentModel?.provider));
    const validReasoning = reasoningLevels.some((level) => level.id === reasoningEffort)
      ? reasoningEffort
      : "";
    const reasoningChanged =
      catalog !== null &&
      validReasoning.length > 0 &&
      validReasoning !== (currentModel?.reasoningEffort ?? "");

    if (
      Object.keys(metaPatch).length === 0 &&
      changedSections.length === 0 &&
      !modelChanged &&
      !reasoningChanged
    ) {
      setSavedNotice(gt("没有需要保存的修改"));
      return;
    }
    if (modelChanged && !submittedProvider) {
      setError(gt("请选择模型提供方"));
      return;
    }
    for (const section of changedSections) {
      const draft = drafts[section.id];
      if (
        section.kind === "toggleList" &&
        section.minEnabled !== undefined &&
        draft?.kind === "toggleList" &&
        draft.enabled.length < section.minEnabled
      ) {
        setError(
          gt("「{section}」至少需要启用 {count} 项", {
            section: section.label,
            count: section.minEnabled,
          }),
        );
        return;
      }
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
        setDrafts((prev) => rebaseDrafts(prev, previous, nextConfig, section.id, submitted));
        onSaved();
      }
      if ((modelChanged || reasoningChanged) && catalog) {
        const result = await paApi.selectBotModel({
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
      setSavedNotice(gt("已保存"));
    } catch (err) {
      setError(paErrorMessage(err, gt("保存失败")));
    }
    setSaving(false);
  };

  const mutateSchedule = async (
    input: Omit<Parameters<typeof paApi.mutateSchedule>[0], "botId">,
    fallback: string,
  ) => {
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
      },
      gt("新增定时任务失败"),
    );
    if (added) {
      setNewScheduleName("");
      setNewSchedulePrompt("");
    }
  };

  const tabs: ReadonlyArray<{ id: SettingsTab; label: string; icon: React.ReactNode }> = [
    { id: "profile", label: gt("资料"), icon: <UserRoundIcon className="size-3.5" /> },
    ...(modelsSupported
      ? [{ id: "model" as const, label: gt("模型"), icon: <CpuIcon className="size-3.5" /> }]
      : []),
    ...(toggleSections.length > 0
      ? [
          {
            id: "toggles" as const,
            label: gt("能力"),
            icon: <SlidersHorizontalIcon className="size-3.5" />,
          },
        ]
      : []),
    ...(schedulesSupported
      ? [{ id: "schedules" as const, label: gt("定时"), icon: <ClockIcon className="size-3.5" /> }]
      : []),
  ];
  const activeTab = tabs.some((item) => item.id === tab) ? tab : "profile";

  return (
    <>
      <div className="border-b border-border/60" style={{ paddingTop: "env(safe-area-inset-top)" }}>
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
            {config?.nativeConsoleUrl ? (
              <Button
                size="xs"
                variant="ghost"
                render={<a href={config.nativeConsoleUrl} target="_blank" rel="noreferrer" />}
              >
                <ExternalLinkIcon className="size-3.5" />
                <T>高级设置</T>
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
                    "flex items-center justify-center gap-1 rounded-md py-1.5 font-medium text-xs transition-colors",
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
              <T>正在读取配置...</T>
            </div>
          ) : null}

          {error ? (
            <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-destructive text-xs">
              {error}
            </div>
          ) : null}

          {pendingConfirm ? (
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
                  <T>取消</T>
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
                  <T>确认切换</T>
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
                  <T>名称</T>
                </Label>
                <Input id="pa-edit-name" value={name} onChange={(e) => setName(e.target.value)} />
              </div>

              <div className="flex items-center justify-between rounded-lg border border-border/60 px-3 py-2.5">
                <div>
                  <div className="font-medium text-sm">
                    <T>置顶到顶部</T>
                  </div>
                  <div className="text-muted-foreground text-xs">
                    <T>显示在 Bot 页大头像置顶区</T>
                  </div>
                </div>
                <Switch checked={pinned} onCheckedChange={setPinned} />
              </div>

              <div className="space-y-2">
                <Label>
                  <T>头像外观</T>
                </Label>
                <div className="flex flex-wrap gap-1.5">
                  {PA_AVATAR_SHAPES.map((item) => (
                    <button
                      key={item.value}
                      type="button"
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
                      onClick={() => setAvatarColor(swatch.value)}
                      className={cn(
                        "size-6 rounded-full",
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
                          section.placeholder ?? gt("输入该 Bot 的系统提示词和行为规范...")
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
                  <T>模型服务商</T>
                </Label>
                <select
                  id="pa-model-provider"
                  value={provider}
                  onChange={(e) => {
                    const next = e.target.value;
                    setProvider(next);
                    setPendingConfirm(null);
                    const found = catalog.providers.find((p) => p.id === next);
                    if (found?.models[0]) setModel(found.models[0].id);
                  }}
                  className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                >
                  {catalog.current?.provider ? null : <option value="">{gt("跟随默认")}</option>}
                  {catalog.providers.map((opt) => (
                    <option key={opt.id} value={opt.id}>
                      {opt.label} ({opt.id})
                    </option>
                  ))}
                </select>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="pa-model-name">
                  <T>默认模型</T>
                </Label>
                {activeProvider && activeProvider.models.length > 0 ? (
                  <select
                    id="pa-model-name"
                    value={model}
                    onChange={(e) => {
                      setModel(e.target.value);
                      setPendingConfirm(null);
                    }}
                    className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                  >
                    {model && !activeProvider.models.some((item) => item.id === model) ? (
                      <option value={model}>{gt("{model}（当前）", { model })}</option>
                    ) : null}
                    {activeProvider.models.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.id}
                      </option>
                    ))}
                  </select>
                ) : catalog.allowCustom ? (
                  <Input
                    id="pa-model-name"
                    value={model}
                    onChange={(e) => {
                      setModel(e.target.value);
                      setPendingConfirm(null);
                    }}
                    placeholder={gt("输入模型名称")}
                  />
                ) : (
                  <div className="text-muted-foreground text-xs">
                    <T>没有可选的模型</T>
                  </div>
                )}
              </div>

              {reasoningLevels.length > 0 ? (
                <div className="space-y-1.5">
                  <Label>
                    <T>推理等级</T>
                  </Label>
                  <div
                    role="radiogroup"
                    aria-label={gt("推理等级")}
                    className="grid grid-cols-4 gap-1.5"
                  >
                    {reasoningLevels.map((level) => {
                      const selected = level.id.toLowerCase() === reasoningEffort.toLowerCase();
                      const glyph = resolvePaReasoningGlyph(level.id, reasoningLevels);
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
                          <EffortGlyph count={glyph.count} filled={glyph.filled} size="xs" />
                          <span className="truncate">
                            {formatPaReasoningLabel(gt, level.id, level.label)}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ) : selectedModelOption?.reasoning === false ? (
                <p className="text-2xs text-muted-foreground">
                  <T>当前模型不支持调节推理等级</T>
                </p>
              ) : null}
            </div>
          ) : null}

          {!loading && activeTab === "toggles" ? (
            <div className="space-y-5">
              {toggleSections.map((section, index) => {
                const draft = drafts[section.id];
                return (
                  <div key={section.id} className="space-y-5">
                    {index > 0 ? <Separator /> : null}
                    <ToggleListSection
                      section={section}
                      value={draft?.kind === "toggleList" ? draft.enabled : []}
                      onChange={(enabled) =>
                        setDrafts((prev) => ({
                          ...prev,
                          [section.id]: { kind: "toggleList", enabled },
                        }))
                      }
                    />
                  </div>
                );
              })}
            </div>
          ) : null}

          {!loading && activeTab === "schedules" ? (
            <div className="space-y-4">
              <div className="space-y-2">
                <Label>
                  <T>
                    已有定时任务（<Var>{schedules.length}</Var>）
                  </T>
                </Label>
                {schedules.length === 0 ? (
                  <div className="rounded-lg border border-dashed border-border/60 py-6 text-center text-muted-foreground text-xs">
                    <T>这个 Bot 暂时还没有定时任务</T>
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
                                  <T>已暂停</T>
                                </Badge>
                              ) : null}
                            </div>
                            <div className="text-2xs text-muted-foreground">
                              {job.nextRunAt
                                ? gt("{schedule} · 下次 {nextRunAt}", {
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
                              title={job.enabled ? gt("暂停") : gt("恢复")}
                              onClick={() =>
                                void mutateSchedule(
                                  { action: job.enabled ? "pause" : "resume", scheduleId: job.id },
                                  gt("定时任务操作失败"),
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
                              title={gt("删除")}
                              onClick={() =>
                                void mutateSchedule(
                                  { action: "remove", scheduleId: job.id },
                                  gt("定时任务操作失败"),
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
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <Separator />

              <form onSubmit={handleAddSchedule} className="space-y-2.5">
                <Label>
                  <T>新增定时任务</T>
                </Label>
                <Input
                  placeholder={gt("任务名称（例如：每日早报）")}
                  value={newScheduleName}
                  onChange={(e) => setNewScheduleName(e.target.value)}
                />
                <Input
                  placeholder={gt("调度表达式（如 every 1h / 0 9 * * *）")}
                  value={newScheduleSpec}
                  onChange={(e) => setNewScheduleSpec(e.target.value)}
                />
                <Textarea
                  rows={3}
                  placeholder={gt("到期时要让 Bot 执行的指令...")}
                  value={newSchedulePrompt}
                  onChange={(e) => setNewSchedulePrompt(e.target.value)}
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
                  <T>添加定时任务</T>
                </Button>
              </form>
            </div>
          ) : null}
        </div>
      </ScrollArea>

      {activeTab !== "schedules" ? (
        <div
          className="flex items-center justify-end gap-2 border-t border-border/60 px-5 py-3"
          style={{ paddingBottom: "max(0.75rem, env(safe-area-inset-bottom))" }}
        >
          <Button type="button" variant="outline" size="sm" onClick={onClose}>
            <T>关闭</T>
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={saving || loading}
            onClick={() => void handleSave()}
          >
            {saving ? (
              <Loader2Icon className="mr-1.5 size-3.5 animate-spin" />
            ) : (
              <SaveIcon className="mr-1.5 size-3.5" />
            )}
            <T>保存修改</T>
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
          <BotSettingsBody
            key={bot.botId}
            bot={bot}
            capabilities={capabilities}
            onClose={() => onOpenChange(false)}
            onSaved={onSaved}
          />
        ) : null}
      </SheetPopup>
    </Sheet>
  );
}
