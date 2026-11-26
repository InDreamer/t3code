import { T, useGT, useMessages, Var } from "gt-react";
import {
  AlertTriangleIcon,
  ClockIcon,
  CpuIcon,
  Loader2Icon,
  PauseIcon,
  PlayIcon,
  PlusIcon,
  SaveIcon,
  Trash2Icon,
  UserRoundIcon,
  WrenchIcon,
} from "lucide-react";
import { useEffect, useState } from "react";

import { cn } from "../../lib/utils";
import { useStableCallback } from "~/hooks/useStableCallback";
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
import { paApi } from "./paApi";
import type { PaAvatarShape, PaBotDetail, PaCronJob, PaUpdateBotInput } from "./paTypes";

type SettingsTab = "profile" | "model" | "skills" | "cron";

function setsEqual(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const item of a) {
    if (!b.has(item)) return false;
  }
  return true;
}

function BotSettingsBody({
  botId,
  onClose,
  onSaved,
}: {
  readonly botId: string;
  readonly onClose: () => void;
  readonly onSaved: (detail: PaBotDetail) => void;
}) {
  const gt = useGT();
  const m = useMessages();
  const [tab, setTab] = useState<SettingsTab>("profile");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedNotice, setSavedNotice] = useState<string | null>(null);
  const [confirmMessage, setConfirmMessage] = useState<string | null>(null);
  const [detail, setDetail] = useState<PaBotDetail | null>(null);

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [soul, setSoul] = useState("");
  const [avatarColor, setAvatarColor] = useState<string>(PA_AVATAR_COLORS[0].value);
  const [avatarShape, setAvatarShape] = useState<PaAvatarShape>("blob");
  const [pinned, setPinned] = useState(false);
  const [provider, setProvider] = useState("");
  const [model, setModel] = useState("");
  const [disabledSkills, setDisabledSkills] = useState<Set<string>>(() => new Set());
  const [enabledToolsets, setEnabledToolsets] = useState<Set<string>>(() => new Set());
  const [skillFilter, setSkillFilter] = useState("");

  const [cronJobs, setCronJobs] = useState<ReadonlyArray<PaCronJob>>([]);
  const [cronBusy, setCronBusy] = useState(false);
  const [newCronName, setNewCronName] = useState("");
  const [newCronSchedule, setNewCronSchedule] = useState("every 1h");
  const [newCronPrompt, setNewCronPrompt] = useState("");

  const hydrateFromDetail = useStableCallback((loaded: PaBotDetail) => {
    setDetail(loaded);
    setName(loaded.name);
    setDescription(loaded.description);
    setSoul(loaded.soul);
    setAvatarColor(loaded.avatarColor);
    setAvatarShape(loaded.avatarShape);
    setPinned(loaded.pinned);
    setProvider(loaded.provider ?? loaded.modelOptions.find((p) => p.isCurrent)?.slug ?? "");
    setModel(loaded.model ?? "");
    setDisabledSkills(new Set(loaded.skills.filter((s) => !s.enabled).map((s) => s.name)));
    setEnabledToolsets(new Set(loaded.toolsets.filter((t) => t.enabled).map((t) => t.name)));
    setCronJobs(loaded.cronJobs);
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads the selected Bot's profile, model options, skills, toolsets, and cron jobs when opening the editor
  useEffect(() => {
    const controller = new AbortController();
    paApi
      .getBotDetail(botId, controller.signal)
      .then((loaded) => {
        if (!controller.signal.aborted) {
          hydrateFromDetail(loaded);
        }
      })
      .catch((err) => {
        if (!controller.signal.aborted) {
          setError(err instanceof Error ? err.message : gt("加载 Bot 配置失败"));
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, [botId, gt, hydrateFromDetail]);

  const activeProviderOption = detail
    ? (detail.modelOptions.find((p) => p.slug === provider) ??
      detail.modelOptions.find((p) => p.isCurrent) ??
      detail.modelOptions[0] ??
      null)
    : null;

  const q = skillFilter.trim().toLowerCase();
  const filteredSkills = !detail
    ? []
    : !q
      ? detail.skills
      : detail.skills.filter(
          (s) => s.name.toLowerCase().includes(q) || (s.category ?? "").toLowerCase().includes(q),
        );

  const enabledSkillsCount = detail ? Math.max(0, detail.skills.length - disabledSkills.size) : 0;

  const handleSave = async (confirmExpensiveModel = false) => {
    if (!detail) return;

    // Hermes pins a model only together with a provider, so "跟随默认" means the current provider.
    const currentProvider =
      detail.provider ?? detail.modelOptions.find((p) => p.isCurrent)?.slug ?? "";
    const initialProvider = currentProvider;
    const initialModel = detail.model ?? "";
    const initialDisabledSkills = new Set(
      detail.skills.filter((s) => !s.enabled).map((s) => s.name),
    );
    const initialEnabledToolsets = new Set(
      detail.toolsets.filter((t) => t.enabled).map((t) => t.name),
    );

    const nextName = name.trim() || detail.profile;
    const nextModel = model.trim();
    const nextProvider = provider.trim() || currentProvider;
    const modelChanged = nextModel !== initialModel || nextProvider !== initialProvider;
    const skillsChanged =
      detail.skills.length > 0 && !setsEqual(disabledSkills, initialDisabledSkills);
    const toolsetsChanged =
      detail.toolsets.length > 0 && !setsEqual(enabledToolsets, initialEnabledToolsets);

    const patch: PaUpdateBotInput = {
      ...(nextName !== detail.name ? { name: nextName } : {}),
      ...(description !== detail.description ? { description } : {}),
      ...(avatarColor !== detail.avatarColor ? { avatarColor } : {}),
      ...(avatarShape !== detail.avatarShape ? { avatarShape } : {}),
      ...(pinned !== detail.pinned ? { pinned } : {}),
      ...(soul !== detail.soul ? { soul } : {}),
      ...(modelChanged && nextModel ? { model: nextModel } : {}),
      ...(modelChanged && nextProvider ? { provider: nextProvider } : {}),
      ...(confirmExpensiveModel ? { confirmExpensiveModel: true } : {}),
      ...(skillsChanged ? { disabledSkills: Array.from(disabledSkills) } : {}),
      ...(toolsetsChanged ? { enabledToolsets: Array.from(enabledToolsets) } : {}),
    };

    if (Object.keys(patch).length === 0) {
      setSavedNotice(gt("没有需要保存的修改"));
      return;
    }
    if (modelChanged && !nextModel) {
      setError(gt("请先选择或输入模型名称"));
      return;
    }
    if (modelChanged && nextModel && !nextProvider) {
      setError(gt("请先选择模型服务商"));
      return;
    }
    // Hermes treats an empty toolset list as "clear the pin", silently re-enabling every default.
    if (toolsetsChanged && enabledToolsets.size === 0) {
      setError(gt("至少需要启用一个工具集"));
      return;
    }

    setSaving(true);
    setError(null);
    setSavedNotice(null);
    setConfirmMessage(null);
    try {
      const updated = await paApi.updateBot(botId, patch);
      if (updated.confirmRequired) {
        // Every other section already saved; keep the unconfirmed model pick for the resend.
        const pendingModel = model;
        const pendingProvider = provider;
        hydrateFromDetail(updated);
        setModel(pendingModel);
        setProvider(pendingProvider);
        onSaved(updated);
        setConfirmMessage(updated.confirmRequired.message);
        return;
      }
      hydrateFromDetail(updated);
      setSavedNotice(gt("已保存到 Hermes Profile"));
      onSaved(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : gt("保存失败"));
    } finally {
      setSaving(false);
    }
  };

  const handleCronAction = async (action: "pause" | "resume" | "remove", job: PaCronJob) => {
    setCronBusy(true);
    setError(null);
    try {
      const next = await paApi.manageCron(botId, {
        action,
        jobId: job.id,
        name: job.name,
      });
      setCronJobs(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : gt("定时任务操作失败"));
    } finally {
      setCronBusy(false);
    }
  };

  const handleAddCron = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newCronPrompt.trim() || !newCronSchedule.trim()) return;
    setCronBusy(true);
    setError(null);
    try {
      const next = await paApi.manageCron(botId, {
        action: "add",
        name: newCronName.trim() || undefined,
        schedule: newCronSchedule.trim(),
        prompt: newCronPrompt.trim(),
      });
      setCronJobs(next);
      setNewCronName("");
      setNewCronPrompt("");
    } catch (err) {
      setError(err instanceof Error ? err.message : gt("新增定时任务失败"));
    } finally {
      setCronBusy(false);
    }
  };

  const tabs: ReadonlyArray<{ id: SettingsTab; label: string; icon: React.ReactNode }> = [
    { id: "profile", label: gt("人设"), icon: <UserRoundIcon className="size-3.5" /> },
    { id: "model", label: gt("模型"), icon: <CpuIcon className="size-3.5" /> },
    { id: "skills", label: gt("技能"), icon: <WrenchIcon className="size-3.5" /> },
    { id: "cron", label: gt("定时"), icon: <ClockIcon className="size-3.5" /> },
  ];

  return (
    <>
      <div className="border-b border-border/60" style={{ paddingTop: "env(safe-area-inset-top)" }}>
        <SheetHeader>
          <div className="flex items-center gap-3 pr-8">
            <BotAvatar color={avatarColor} shape={avatarShape} size="sm" starred={pinned} />
            <div className="min-w-0">
              <SheetTitle>
                <span className="block truncate text-base">
                  {name || detail?.name || gt("Bot 设置")}
                </span>
              </SheetTitle>
              <SheetDescription>
                <span className="block truncate text-xs">
                  {detail
                    ? gt("{adapter} · profile: {profile}", {
                        adapter: detail.adapter,
                        profile: detail.profile,
                      })
                    : gt("正在读取配置...")}
                </span>
              </SheetDescription>
            </div>
          </div>

          <div className="mt-3 grid grid-cols-4 gap-1 rounded-lg bg-muted/60 p-1">
            {tabs.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setTab(item.id)}
                className={cn(
                  "flex items-center justify-center gap-1 rounded-md py-1.5 font-medium text-xs transition-colors",
                  tab === item.id
                    ? "bg-background text-foreground shadow-xs"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {item.icon}
                <span>{item.label}</span>
              </button>
            ))}
          </div>
        </SheetHeader>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-4 p-5">
          {loading ? (
            <div className="flex items-center justify-center py-12 text-muted-foreground text-sm">
              <Loader2Icon className="mr-2 size-4 animate-spin" />
              <T>正在同步 Hermes 配置...</T>
            </div>
          ) : null}

          {error ? (
            <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-destructive text-xs">
              {error}
            </div>
          ) : null}

          {confirmMessage ? (
            <div className="space-y-2 rounded-lg border border-warning/40 bg-warning-surface p-3 text-warning-foreground text-xs">
              <div className="flex items-start gap-2">
                <AlertTriangleIcon className="mt-0.5 size-4 shrink-0" />
                <p className="whitespace-pre-wrap">{confirmMessage}</p>
              </div>
              <div className="flex justify-end gap-2">
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  disabled={saving}
                  onClick={() => setConfirmMessage(null)}
                >
                  <T>取消</T>
                </Button>
                <Button
                  type="button"
                  size="xs"
                  disabled={saving}
                  onClick={() => void handleSave(true)}
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

          {!loading && detail && tab === "profile" ? (
            <div className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="pa-edit-name">
                  <T>名称</T>
                </Label>
                <Input id="pa-edit-name" value={name} onChange={(e) => setName(e.target.value)} />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="pa-edit-desc">
                  <T>简介</T>
                </Label>
                <Input
                  id="pa-edit-desc"
                  placeholder={gt("这个 Bot 负责什么？")}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                />
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

              <div className="space-y-1.5">
                <Label htmlFor="pa-edit-soul">
                  <T>人设指令（SOUL.md）</T>
                </Label>
                <Textarea
                  id="pa-edit-soul"
                  rows={8}
                  value={soul}
                  onChange={(e) => setSoul(e.target.value)}
                  placeholder={gt("输入该 Bot 的系统提示词和行为规范...")}
                />
              </div>
            </div>
          ) : null}

          {!loading && detail && tab === "model" ? (
            <div className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="pa-model-provider">
                  <T>模型服务商（Provider）</T>
                </Label>
                <select
                  id="pa-model-provider"
                  value={provider}
                  onChange={(e) => {
                    const nextSlug = e.target.value;
                    setProvider(nextSlug);
                    setConfirmMessage(null);
                    const found = detail.modelOptions.find((p) => p.slug === nextSlug);
                    if (found?.models[0]) {
                      setModel(found.models[0]);
                    }
                  }}
                  className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                >
                  <option value="">{gt("跟随默认")}</option>
                  {detail.modelOptions.map((opt) => (
                    <option key={opt.slug} value={opt.slug}>
                      {opt.name} ({opt.slug})
                    </option>
                  ))}
                </select>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="pa-model-name">
                  <T>默认模型</T>
                </Label>
                {activeProviderOption && activeProviderOption.models.length > 0 ? (
                  <select
                    id="pa-model-name"
                    value={model}
                    onChange={(e) => {
                      setModel(e.target.value);
                      setConfirmMessage(null);
                    }}
                    className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                  >
                    {!activeProviderOption.models.includes(model) && model ? (
                      <option value={model}>{gt("{model}（当前）", { model })}</option>
                    ) : null}
                    {activeProviderOption.models.map((item) => (
                      <option key={item} value={item}>
                        {item}
                      </option>
                    ))}
                  </select>
                ) : (
                  <Input
                    id="pa-model-name"
                    value={model}
                    onChange={(e) => {
                      setModel(e.target.value);
                      setConfirmMessage(null);
                    }}
                    placeholder={gt("例如：deepseek-flash")}
                  />
                )}
              </div>

              {detail.toolsets.length > 0 ? (
                <>
                  <Separator />
                  <div className="space-y-2">
                    <Label>
                      <T>工具集开关（Toolsets）</T>
                    </Label>
                    <div className="space-y-1.5">
                      {detail.toolsets.map((toolset) => {
                        const checked = enabledToolsets.has(toolset.name);
                        return (
                          <div
                            key={toolset.name}
                            className="flex items-center justify-between rounded-lg border border-border/50 px-3 py-2"
                          >
                            <div className="min-w-0 pr-3">
                              <div className="truncate font-medium text-xs">
                                {toolset.label || toolset.name}
                              </div>
                              {toolset.description ? (
                                <div className="truncate text-2xs text-muted-foreground">
                                  {toolset.description}
                                </div>
                              ) : null}
                            </div>
                            <Switch
                              size="sm"
                              checked={checked}
                              onCheckedChange={(next) => {
                                setEnabledToolsets((prev) => {
                                  const copy = new Set(prev);
                                  if (next) copy.add(toolset.name);
                                  else copy.delete(toolset.name);
                                  return copy;
                                });
                              }}
                            />
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </>
              ) : null}
            </div>
          ) : null}

          {!loading && detail && tab === "skills" ? (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <Label>
                  <T>
                    Skills 开关（共 <Var>{detail.skills.length}</Var> 个）
                  </T>
                </Label>
                <Badge variant="outline" size="sm">
                  <T>
                    已启用 <Var>{enabledSkillsCount}</Var>
                  </T>
                </Badge>
              </div>
              <Input
                placeholder={gt("搜索技能名称或分类...")}
                value={skillFilter}
                onChange={(e) => setSkillFilter(e.target.value)}
              />
              {filteredSkills.length === 0 ? (
                <div className="py-8 text-center text-muted-foreground text-xs">
                  <T>没有匹配的技能</T>
                </div>
              ) : (
                <div className="space-y-1.5">
                  {filteredSkills.map((skill) => {
                    const enabled = !disabledSkills.has(skill.name);
                    return (
                      <div
                        key={skill.name}
                        className="flex items-center justify-between rounded-lg border border-border/50 px-3 py-2"
                      >
                        <div className="min-w-0 pr-3">
                          <div className="truncate font-medium text-xs">{skill.name}</div>
                          {skill.category ? (
                            <div className="truncate text-2xs text-muted-foreground">
                              {skill.category}
                            </div>
                          ) : null}
                        </div>
                        <Switch
                          size="sm"
                          checked={enabled}
                          onCheckedChange={(next) => {
                            setDisabledSkills((prev) => {
                              const copy = new Set(prev);
                              if (next) copy.delete(skill.name);
                              else copy.add(skill.name);
                              return copy;
                            });
                          }}
                        />
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          ) : null}

          {!loading && detail && tab === "cron" ? (
            <div className="space-y-4">
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label>
                    <T>
                      已有定时任务（<Var>{cronJobs.length}</Var>）
                    </T>
                  </Label>
                </div>
                {cronJobs.length === 0 ? (
                  <div className="rounded-lg border border-dashed border-border/60 py-6 text-center text-muted-foreground text-xs">
                    <T>这个 Bot 暂时还没有定时任务</T>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {cronJobs.map((job) => (
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
                              disabled={cronBusy}
                              title={job.enabled ? gt("暂停") : gt("恢复")}
                              onClick={() =>
                                handleCronAction(job.enabled ? "pause" : "resume", job)
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
                              disabled={cronBusy}
                              title={gt("删除")}
                              onClick={() => handleCronAction("remove", job)}
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

              <form onSubmit={handleAddCron} className="space-y-2.5">
                <Label>
                  <T>新增定时任务</T>
                </Label>
                <Input
                  placeholder={gt("任务名称（例如：每日早报）")}
                  value={newCronName}
                  onChange={(e) => setNewCronName(e.target.value)}
                />
                <Input
                  placeholder={gt("调度表达式（如 every 1h / 0 9 * * *）")}
                  value={newCronSchedule}
                  onChange={(e) => setNewCronSchedule(e.target.value)}
                />
                <Textarea
                  rows={3}
                  placeholder={gt("到期时要让 Bot 执行的指令...")}
                  value={newCronPrompt}
                  onChange={(e) => setNewCronPrompt(e.target.value)}
                />
                <Button
                  type="submit"
                  size="sm"
                  variant="secondary"
                  disabled={cronBusy || !newCronPrompt.trim() || !newCronSchedule.trim()}
                  className="w-full"
                >
                  {cronBusy ? (
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

      {tab !== "cron" ? (
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
            disabled={saving || loading || !detail}
            onClick={() => void handleSave(false)}
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
  botId,
  open,
  onOpenChange,
  onSaved,
}: {
  readonly botId: string | null;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSaved: (detail: PaBotDetail) => void;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetPopup side="right" className="flex w-full max-w-md flex-col">
        {open && botId ? (
          <BotSettingsBody
            key={botId}
            botId={botId}
            onClose={() => onOpenChange(false)}
            onSaved={onSaved}
          />
        ) : null}
      </SheetPopup>
    </Sheet>
  );
}
