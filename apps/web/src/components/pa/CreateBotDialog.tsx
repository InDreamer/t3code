import { T, useGT, useMessages } from "gt-react";
import { Loader2Icon, PlusIcon } from "lucide-react";
import { useState } from "react";

import { cn } from "../../lib/utils";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { BotAvatar, PA_AVATAR_COLORS, PA_AVATAR_SHAPES } from "./BotAvatar";
import { paApi } from "./paApi";
import type { PaAdapterKind, PaAdapterStatus, PaAvatarShape, PaBotSummary } from "./paTypes";

export function CreateBotDialog({
  open,
  onOpenChange,
  adapters,
  onCreated,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly adapters: ReadonlyArray<PaAdapterStatus>;
  readonly onCreated: (bot: PaBotSummary) => void;
}) {
  const gt = useGT();
  const m = useMessages();
  const creatableAdapters = adapters.filter((a) => a.capabilities.create);
  const [selectedAdapter, setSelectedAdapter] = useState<PaAdapterKind>("hermes");
  const [name, setName] = useState("");
  const [profile, setProfile] = useState("");
  const [description, setDescription] = useState("");
  const [soul, setSoul] = useState("");
  const [avatarColor, setAvatarColor] = useState<string>(PA_AVATAR_COLORS[1].value);
  const [avatarShape, setAvatarShape] = useState<PaAvatarShape>("blob");
  const [pinned, setPinned] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const activeAdapter =
    creatableAdapters.find((a) => a.kind === selectedAdapter) ??
    creatableAdapters.find((a) => a.online) ??
    creatableAdapters[0] ??
    null;
  const canCreate = activeAdapter !== null && activeAdapter.online;
  const hasOpenClaw = adapters.some((a) => a.kind === "openclaw");

  const derivedSlug = (profile || name)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[^a-z0-9]+|-+$/g, "")
    .slice(0, 64);

  const resetForm = () => {
    setName("");
    setProfile("");
    setDescription("");
    setSoul("");
    setAvatarColor(PA_AVATAR_COLORS[1].value);
    setAvatarShape("blob");
    setPinned(false);
    setError(null);
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!activeAdapter || !activeAdapter.online) {
      setError(gt("当前没有可用的在线 PA 引擎"));
      return;
    }
    if (!derivedSlug) {
      setError(gt("请填写以英文或数字开头的 Profile 标识（例如 news-bot）"));
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const bot = await paApi.createBot({
        adapter: activeAdapter.kind,
        profile: derivedSlug,
        name: name.trim() || derivedSlug,
        description: description.trim(),
        soul: soul.trim() || undefined,
        avatarColor,
        avatarShape,
        pinned,
      });
      resetForm();
      onOpenChange(false);
      onCreated(bot);
    } catch (err) {
      setError(err instanceof Error ? err.message : gt("创建 Bot 失败"));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setError(null);
        onOpenChange(next);
      }}
    >
      <DialogPopup className="max-w-lg">
        <form onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col">
          <DialogHeader>
            <DialogTitle>
              <T>新建 Bot</T>
            </DialogTitle>
            <DialogDescription>
              <T>每个 Bot 对应一个独立的 PA Profile（独立记忆、人设、模型和定时任务）。</T>
            </DialogDescription>
          </DialogHeader>

          <DialogPanel>
            <div className="flex items-center gap-4 rounded-xl border border-border/60 bg-muted/30 p-3">
              <BotAvatar color={avatarColor} shape={avatarShape} size="md" starred={pinned} />
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium text-sm">
                  {name.trim() || derivedSlug || gt("新 Bot")}
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-1.5">
                  {adapters.map((adapter) => (
                    <Badge
                      key={adapter.kind}
                      variant={adapter.online ? "success" : "warning"}
                      size="sm"
                    >
                      {adapter.online
                        ? gt("{label} 在线", { label: adapter.label })
                        : gt("{label} 离线", { label: adapter.label })}
                    </Badge>
                  ))}
                  {!hasOpenClaw ? (
                    <Badge variant="secondary" size="sm">
                      <T>OpenClaw 即将支持</T>
                    </Badge>
                  ) : null}
                </div>
              </div>
            </div>

            {creatableAdapters.length > 1 ? (
              <div className="space-y-1.5">
                <Label htmlFor="pa-create-adapter">
                  <T>PA 引擎</T>
                </Label>
                <select
                  id="pa-create-adapter"
                  value={activeAdapter?.kind ?? "hermes"}
                  onChange={(e) => setSelectedAdapter(e.target.value as PaAdapterKind)}
                  className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                >
                  {creatableAdapters.map((adapter) => (
                    <option key={adapter.kind} value={adapter.kind} disabled={!adapter.online}>
                      {adapter.label}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="pa-create-name">
                  <T>显示名称</T>
                </Label>
                <Input
                  id="pa-create-name"
                  placeholder={gt("例如：调研哥 / 币哥")}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  autoFocus
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="pa-create-profile">
                  <T>Profile ID（英文/数字）</T>
                </Label>
                <Input
                  id="pa-create-profile"
                  placeholder={gt("例如：research-bot")}
                  value={profile}
                  onChange={(e) => setProfile(e.target.value)}
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="pa-create-desc">
                <T>一句话简介（可选）</T>
              </Label>
              <Input
                id="pa-create-desc"
                placeholder={gt("例如：每天整理 X 摘要和 AI 圈动态")}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </div>

            <div className="space-y-2">
              <Label>
                <T>头像造型与配色</T>
              </Label>
              <div className="flex flex-wrap gap-2">
                {PA_AVATAR_SHAPES.map((item) => (
                  <button
                    key={item.value}
                    type="button"
                    onClick={() => setAvatarShape(item.value)}
                    className={cn(
                      "flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs transition-colors",
                      avatarShape === item.value
                        ? "border-primary bg-primary/10 text-foreground"
                        : "border-border/60 bg-background text-muted-foreground hover:bg-muted/50",
                    )}
                  >
                    <BotAvatar
                      color={avatarColor}
                      shape={item.value}
                      size="sm"
                      className="size-5"
                    />
                    <span>{m(item.label)}</span>
                  </button>
                ))}
              </div>
              <div className="flex flex-wrap items-center gap-2 pt-1">
                {PA_AVATAR_COLORS.map((swatch) => (
                  <button
                    key={swatch.value}
                    type="button"
                    aria-label={m(swatch.label)}
                    onClick={() => setAvatarColor(swatch.value)}
                    className={cn(
                      "size-6 rounded-full transition-transform",
                      avatarColor === swatch.value &&
                        "scale-110 ring-2 ring-foreground ring-offset-2 ring-offset-background",
                    )}
                    style={{ backgroundColor: swatch.value }}
                  />
                ))}
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="pa-create-soul">
                <T>人设 / 指令（SOUL.md，可选）</T>
              </Label>
              <Textarea
                id="pa-create-soul"
                rows={4}
                placeholder={gt("描述这个 Bot 的职责、回复风格和规则...")}
                value={soul}
                onChange={(e) => setSoul(e.target.value)}
              />
            </div>

            <div className="flex items-center justify-between rounded-lg border border-border/60 px-3 py-2.5">
              <div>
                <div className="font-medium text-sm">
                  <T>置顶到 Bot 页顶部</T>
                </div>
                <div className="text-muted-foreground text-xs">
                  <T>以大头像常驻在顶部快捷区</T>
                </div>
              </div>
              <Switch checked={pinned} onCheckedChange={setPinned} />
            </div>

            {error ? (
              <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-destructive text-xs">
                {error}
              </div>
            ) : null}
          </DialogPanel>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              <T>取消</T>
            </Button>
            <Button type="submit" disabled={submitting || !canCreate}>
              {submitting ? (
                <Loader2Icon className="mr-1.5 size-4 animate-spin" />
              ) : (
                <PlusIcon className="mr-1.5 size-4" />
              )}
              <T>创建并进入对话</T>
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
