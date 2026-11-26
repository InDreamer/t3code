import { useNavigate, useSearch } from "@tanstack/react-router";
import { T, useGT, Var } from "gt-react";
import { BotIcon, PlusIcon, RefreshCwIcon, SearchIcon, Settings2Icon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { cn } from "../../lib/utils";
import { useStableCallback } from "~/hooks/useStableCallback";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { SidebarInset, SidebarTrigger } from "../ui/sidebar";
import { BotAvatar } from "./BotAvatar";
import { BotChatPane } from "./BotChatPane";
import { BotSettingsSheet } from "./BotSettingsSheet";
import { CreateBotDialog } from "./CreateBotDialog";
import { paApi } from "./paApi";
import type { PaAdapterStatus, PaBotSummary } from "./paTypes";

export interface BotsSearch {
  readonly bot?: string;
  readonly session?: string;
}

const SKELETON_KEYS = ["sk-1", "sk-2", "sk-3"] as const;

export function BotsPage() {
  const gt = useGT();
  const search = useSearch({ from: "/_chat/bots" });
  const navigate = useNavigate();

  const [adapters, setAdapters] = useState<ReadonlyArray<PaAdapterStatus>>([]);
  const [bots, setBots] = useState<ReadonlyArray<PaBotSummary>>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [settingsBotId, setSettingsBotId] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const loadInFlightRef = useRef(false);

  const loadBots = async (quiet: boolean) => {
    if (loadInFlightRef.current) return;
    loadInFlightRef.current = true;
    if (!quiet) setLoading(true);
    else setRefreshing(true);
    setError(null);
    try {
      const data = await paApi.listBots();
      setAdapters(data.adapters);
      setBots(data.bots);
      setNowMs(Date.now());
    } catch (err) {
      setError(err instanceof Error ? err.message : gt("无法获取 PA Bot 列表"));
    } finally {
      loadInFlightRef.current = false;
      setLoading(false);
      setRefreshing(false);
    }
  };

  const stableLoadBots = useStableCallback(loadBots);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- fetches the initial PA Bot roster and refreshes when the browser tab becomes visible again
  useEffect(() => {
    void stableLoadBots(false);
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        void stableLoadBots(true);
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [stableLoadBots]);

  const formatRelativeTime = (ts: number | null): string => {
    if (!ts) return "";
    const now = new Date(nowMs);
    const target = new Date(ts);
    const oneDay = 24 * 60 * 60 * 1000;
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const startOfTarget = new Date(
      target.getFullYear(),
      target.getMonth(),
      target.getDate(),
    ).getTime();
    const dayDiff = Math.round((startOfToday - startOfTarget) / oneDay);

    if (dayDiff === 0) {
      return target.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    }
    if (dayDiff === 1) {
      return gt("昨天");
    }
    if (dayDiff > 1 && dayDiff < 7) {
      const weekdays = [
        gt("星期日"),
        gt("星期一"),
        gt("星期二"),
        gt("星期三"),
        gt("星期四"),
        gt("星期五"),
        gt("星期六"),
      ];
      return weekdays[target.getDay()] ?? "";
    }
    return gt("{month}月{day}日", { month: target.getMonth() + 1, day: target.getDate() });
  };

  const q = query.trim().toLowerCase();
  const filteredBots = !q
    ? bots
    : bots.filter(
        (b) =>
          b.name.toLowerCase().includes(q) ||
          b.profile.toLowerCase().includes(q) ||
          b.description.toLowerCase().includes(q) ||
          (b.lastMessagePreview ?? "").toLowerCase().includes(q),
      );

  const pinnedBots = filteredBots.filter((b) => b.pinned).slice(0, 6);
  const pinnedIds = new Set(pinnedBots.map((b) => b.id));
  const unpinnedBots = filteredBots.filter((b) => !pinnedIds.has(b.id));

  const selectedBot = bots.find((b) => b.id === search.bot) ?? null;

  const selectBot = (botId: string, sessionId?: string) => {
    void navigate({
      to: "/bots",
      search: {
        bot: botId,
        ...(sessionId ? { session: sessionId } : {}),
      },
    });
  };

  const clearBot = () => {
    void navigate({ to: "/bots", search: {} });
  };

  const offlineAdapters = adapters.filter((a) => !a.online);

  return (
    <SidebarInset className="flex h-dvh min-h-0 flex-1 flex-row overflow-hidden">
      <section
        className={cn(
          "flex min-h-0 flex-col border-border/60 bg-background lg:w-90 lg:shrink-0 lg:border-r",
          selectedBot ? "hidden lg:flex" : "flex w-full flex-1 lg:flex-none",
        )}
      >
        <header
          className="flex min-h-14 shrink-0 items-center justify-between gap-2 px-4"
          style={{
            paddingTop: "env(safe-area-inset-top)",
            minHeight: "calc(3.5rem + env(safe-area-inset-top))",
          }}
        >
          <div className="flex items-center gap-2">
            <SidebarTrigger className="size-9" />
            <div className="flex items-center gap-1.5">
              <span className="font-semibold text-base tracking-tight">
                <T>Bots</T>
              </span>
              {adapters.map((adapter) => (
                <Badge
                  key={adapter.kind}
                  variant={adapter.online ? "success" : "destructive"}
                  size="sm"
                >
                  {adapter.label}
                </Badge>
              ))}
            </div>
          </div>

          <div className="flex items-center gap-1.5">
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="size-9"
              aria-label={gt("刷新 Bot 列表")}
              disabled={refreshing}
              onClick={() => void loadBots(true)}
            >
              <RefreshCwIcon className={cn("size-4", refreshing && "animate-spin")} />
            </Button>
            <Button
              type="button"
              size="icon"
              variant="outline"
              className="size-9"
              aria-label={gt("新建 Bot")}
              onClick={() => setCreateOpen(true)}
            >
              <PlusIcon className="size-4" />
            </Button>
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-24">
          {error ? (
            <div className="mb-4 rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-destructive text-xs">
              {error}
            </div>
          ) : null}

          {!loading && offlineAdapters.length > 0 ? (
            <div className="mb-4 space-y-2">
              {offlineAdapters.map((adapter) => (
                <div
                  key={adapter.kind}
                  className="rounded-xl border border-warning/40 bg-warning-surface p-3 text-warning-foreground text-xs"
                >
                  <T>
                    <Var>{adapter.label}</Var> Gateway 当前未连接：
                    <Var>{adapter.error || gt("请检查网关服务状态")}</Var>
                  </T>
                </div>
              ))}
            </div>
          ) : null}

          {pinnedBots.length > 0 ? (
            <div className="flex flex-wrap items-start justify-center gap-6 py-4">
              {pinnedBots.map((bot) => {
                const active = selectedBot?.id === bot.id;
                return (
                  <div
                    key={bot.id}
                    className={cn(
                      "group relative flex w-24 flex-col items-center rounded-2xl p-2 transition-colors",
                      active ? "bg-muted/70" : "hover:bg-muted/40",
                    )}
                  >
                    <button
                      type="button"
                      onClick={() => selectBot(bot.id)}
                      className="flex w-full flex-col items-center gap-2"
                    >
                      <BotAvatar
                        color={bot.avatarColor}
                        shape={bot.avatarShape}
                        size="lg"
                        starred={bot.isDefault}
                        unread={bot.unread}
                        running={bot.running}
                        className="transition-transform group-hover:scale-105"
                      />
                      <div className="flex max-w-full items-center gap-1">
                        <span className="truncate font-medium text-sm">{bot.name}</span>
                        {bot.unread ? (
                          <span className="inline-block size-2 shrink-0 rounded-full bg-info" />
                        ) : null}
                      </div>
                    </button>
                    <button
                      type="button"
                      aria-label={gt("配置 {name}", { name: bot.name })}
                      onClick={() => setSettingsBotId(bot.id)}
                      className="absolute top-1 right-1 flex size-6 items-center justify-center rounded-full bg-background/85 text-muted-foreground opacity-100 shadow-xs transition-opacity hover:text-foreground lg:opacity-0 lg:group-hover:opacity-100 lg:group-focus-within:opacity-100"
                    >
                      <Settings2Icon className="size-3" />
                    </button>
                  </div>
                );
              })}
            </div>
          ) : null}

          {loading ? (
            <div className="space-y-3 pt-4">
              {SKELETON_KEYS.map((key) => (
                <div
                  key={key}
                  className="flex animate-pulse items-center gap-3 rounded-2xl bg-muted/30 p-3"
                >
                  <div className="size-11 rounded-full bg-muted" />
                  <div className="flex-1 space-y-2">
                    <div className="h-3.5 w-24 rounded bg-muted" />
                    <div className="h-3 w-48 rounded bg-muted" />
                  </div>
                </div>
              ))}
            </div>
          ) : filteredBots.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
              <div className="flex size-12 items-center justify-center rounded-2xl bg-muted/60 text-muted-foreground">
                <BotIcon className="size-6" />
              </div>
              <div className="space-y-1">
                <div className="font-medium text-sm">
                  <T>没有找到匹配的 Bot</T>
                </div>
                <p className="text-muted-foreground text-xs">
                  <T>点右上角 + 创建一个新的 Bot</T>
                </p>
              </div>
            </div>
          ) : unpinnedBots.length > 0 ? (
            <div className="space-y-1">
              {unpinnedBots.map((bot) => {
                const active = selectedBot?.id === bot.id;
                return (
                  <div
                    key={bot.id}
                    className={cn(
                      "group flex items-center gap-3 rounded-2xl px-2.5 py-2.5 transition-colors",
                      active ? "bg-muted/80" : "hover:bg-muted/45",
                    )}
                  >
                    <button
                      type="button"
                      onClick={() => selectBot(bot.id)}
                      className="flex min-w-0 flex-1 items-center gap-3 text-left"
                    >
                      <BotAvatar
                        color={bot.avatarColor}
                        shape={bot.avatarShape}
                        size="md"
                        starred={bot.isDefault}
                        running={bot.running}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between gap-2">
                          <span className="truncate font-semibold text-sm">{bot.name}</span>
                          <span className="shrink-0 text-xs text-muted-foreground">
                            {formatRelativeTime(bot.lastActivityAt)}
                          </span>
                        </div>
                        <div className="mt-0.5 flex items-center justify-between gap-2">
                          <p className="truncate text-xs text-muted-foreground">
                            {bot.lastMessagePreview ||
                              bot.description ||
                              `${bot.adapter} · ${bot.model || bot.profile}`}
                          </p>
                          {bot.unread ? (
                            <span className="inline-block size-2.5 shrink-0 rounded-full bg-info" />
                          ) : null}
                        </div>
                      </div>
                    </button>

                    <div className="shrink-0 opacity-100 transition-opacity lg:opacity-0 lg:group-hover:opacity-100 lg:group-focus-within:opacity-100">
                      <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        className="size-8"
                        aria-label={gt("配置 {name}", { name: bot.name })}
                        onClick={() => setSettingsBotId(bot.id)}
                      >
                        <Settings2Icon className="size-3.5" />
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : null}
        </div>

        <div
          className="pointer-events-none sticky right-0 bottom-0 left-0 px-4"
          style={{ paddingBottom: "max(1rem, env(safe-area-inset-bottom))" }}
        >
          <div className="pointer-events-auto flex items-center gap-2 rounded-full border border-border/70 bg-background/90 px-4 py-2.5 shadow-lg backdrop-blur-md">
            <SearchIcon className="size-4 shrink-0 text-muted-foreground" />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={gt("搜索 Bot 或摘要")}
              className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            />
          </div>
        </div>
      </section>

      <section
        className={cn("flex min-h-0 flex-1 flex-col", selectedBot ? "flex" : "hidden lg:flex")}
      >
        {selectedBot ? (
          <BotChatPane
            key={selectedBot.id}
            bot={selectedBot}
            selectedSessionId={search.session ?? null}
            onSelectSession={(sessionId) => selectBot(selectedBot.id, sessionId)}
            onBackMobile={clearBot}
            onOpenSettings={() => setSettingsBotId(selectedBot.id)}
            onActivity={() => void loadBots(true)}
          />
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center text-muted-foreground">
            <div className="flex size-14 items-center justify-center rounded-2xl bg-muted/50">
              <BotIcon className="size-6" />
            </div>
            <div className="space-y-1">
              <div className="font-medium text-base text-foreground">
                <T>选择一个 Bot 开始对话</T>
              </div>
              <p className="max-w-sm text-xs">
                <T>
                  这里独立于写代码的 Projects 和 Threads，直连你的常驻 Personal Agent（当前已接入
                  Hermes，后续支持 OpenClaw）。
                </T>
              </p>
            </div>
          </div>
        )}
      </section>

      <CreateBotDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        adapters={adapters}
        onCreated={(created) => {
          void loadBots(true);
          selectBot(created.id);
        }}
      />

      <BotSettingsSheet
        botId={settingsBotId}
        open={settingsBotId !== null}
        onOpenChange={(open) => {
          if (!open) setSettingsBotId(null);
        }}
        onSaved={() => {
          void loadBots(true);
        }}
      />
    </SidebarInset>
  );
}
