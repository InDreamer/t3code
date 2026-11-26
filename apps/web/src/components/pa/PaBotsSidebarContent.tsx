import { useNavigate, useSearch } from "@tanstack/react-router";
import { T, useGT, Var } from "gt-react";
import { BotIcon, PlusIcon, RefreshCwIcon, SearchIcon, Settings2Icon } from "lucide-react";
import { useState } from "react";

import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { SidebarContent, SidebarGroup, useSidebar } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { BotAvatar } from "./BotAvatar";
import {
  loadPaBots,
  rememberLastPaBotId,
  setPaCreateDialogOpen,
  setPaSettingsBotId,
  usePaBotsStore,
} from "./paBotsStore";

const SKELETON_KEYS = ["sk-1", "sk-2", "sk-3"] as const;

export function PaBotsSidebarContent() {
  const gt = useGT();
  const navigate = useNavigate();
  const rawSearch = useSearch({ strict: false }) as { readonly bot?: unknown };
  const routeBotId = typeof rawSearch.bot === "string" && rawSearch.bot ? rawSearch.bot : null;
  const { isMobile, setOpenMobile } = useSidebar();
  const { instances, bots, loading, refreshing, error, nowMs, lastBotId } = usePaBotsStore();
  const [query, setQuery] = useState("");

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
        gt("周日"),
        gt("周一"),
        gt("周二"),
        gt("周三"),
        gt("周四"),
        gt("周五"),
        gt("周六"),
      ];
      return weekdays[target.getDay()] ?? "";
    }
    return gt("{month}/{day}", { month: target.getMonth() + 1, day: target.getDate() });
  };

  const q = query.trim().toLowerCase();
  const filteredBots = !q
    ? bots
    : bots.filter(
        (b) =>
          b.name.toLowerCase().includes(q) ||
          b.agentRef.toLowerCase().includes(q) ||
          b.description.toLowerCase().includes(q) ||
          (b.lastMessagePreview ?? "").toLowerCase().includes(q),
      );

  const pinnedBots = filteredBots.filter((b) => b.pinned).slice(0, 6);
  const pinnedIds = new Set(pinnedBots.map((b) => b.botId));
  const unpinnedBots = filteredBots.filter((b) => !pinnedIds.has(b.botId));

  const activeBotId =
    (routeBotId && bots.some((b) => b.botId === routeBotId) ? routeBotId : null) ??
    (lastBotId && bots.some((b) => b.botId === lastBotId) ? lastBotId : null) ??
    bots.find((b) => b.isDefault)?.botId ??
    bots[0]?.botId ??
    null;

  const selectBot = (botId: string) => {
    rememberLastPaBotId(botId);
    if (isMobile) {
      setOpenMobile(false);
    }
    void navigate({
      to: "/bots",
      search: { bot: botId },
    });
  };

  const openSettings = (botId: string) => {
    if (isMobile) {
      setOpenMobile(false);
    }
    setPaSettingsBotId(botId);
  };

  const openCreate = () => {
    if (isMobile) {
      setOpenMobile(false);
    }
    setPaCreateDialogOpen(true);
  };

  const offlineInstances = instances.filter((i) => !i.online);

  return (
    <SidebarContent
      className="min-h-full"
      fixedHeader={
        <SidebarGroup className="z-[1]">
          <div className="flex items-center gap-1">
            <div className="flex min-w-0 flex-1 items-center gap-1.5 rounded-lg bg-muted/50 px-2.5 py-1.5 text-sm">
              <SearchIcon className="size-3.5 shrink-0 text-sidebar-muted-foreground" />
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={gt("搜索 Bot")}
                aria-label={gt("搜索 Bot")}
                className="min-w-0 flex-1 bg-transparent text-xs text-sidebar-foreground outline-none placeholder:text-sidebar-muted-foreground"
              />
            </div>

            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    size="icon-xs"
                    variant="ghost-muted"
                    aria-label={gt("刷新 Bot 列表")}
                    disabled={refreshing}
                    onClick={() => void loadPaBots(true)}
                  />
                }
              >
                <RefreshCwIcon className={cn("size-3.5", refreshing && "animate-spin")} />
              </TooltipTrigger>
              <TooltipPopup side="bottom">
                <T>刷新 Bot 列表</T>
              </TooltipPopup>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    size="icon-xs"
                    variant="ghost-muted"
                    aria-label={gt("新建 Bot")}
                    onClick={openCreate}
                  />
                }
              >
                <PlusIcon className="size-3.5" />
              </TooltipTrigger>
              <TooltipPopup side="bottom">
                <T>新建 Bot</T>
              </TooltipPopup>
            </Tooltip>
          </div>
        </SidebarGroup>
      }
    >
      <SidebarGroup className="flex-1">
        <div className="flex flex-col gap-2">
          {error ? (
            <div className="rounded-lg border border-destructive/35 bg-destructive/10 px-2.5 py-2 text-2xs text-destructive">
              {error}
            </div>
          ) : null}

          {!loading && offlineInstances.length > 0 ? (
            <div className="space-y-1.5">
              {offlineInstances.map((instance) => (
                <div
                  key={instance.instanceId}
                  className="rounded-lg border border-warning/35 bg-warning-surface px-2.5 py-2 text-2xs text-warning-foreground"
                >
                  <T>
                    <Var>{instance.label}</Var> 未连接：
                    <Var>{instance.error || gt("请检查服务状态")}</Var>
                  </T>
                </div>
              ))}
            </div>
          ) : null}

          {pinnedBots.length > 0 ? (
            <div className="grid grid-cols-3 gap-1.5 py-1">
              {pinnedBots.map((bot) => {
                const active = activeBotId === bot.botId;
                return (
                  <div
                    key={bot.botId}
                    className={cn(
                      "group relative flex min-w-0 flex-col items-center rounded-xl p-1.5 transition-colors",
                      active
                        ? "bg-sidebar-row-active text-sidebar-foreground"
                        : "hover:bg-sidebar-row-hover",
                    )}
                  >
                    <button
                      type="button"
                      onClick={() => selectBot(bot.botId)}
                      className="flex w-full min-w-0 flex-col items-center gap-1.5"
                    >
                      <BotAvatar
                        color={bot.avatarColor}
                        shape={bot.avatarShape}
                        size="md"
                        starred={bot.isDefault}
                        unread={bot.unread}
                        running={bot.running}
                        className="transition-transform group-hover:scale-105"
                      />
                      <div className="flex max-w-full items-center gap-1">
                        <span className="truncate text-xs font-medium">{bot.name}</span>
                        {bot.unread ? (
                          <span className="inline-block size-1.5 shrink-0 rounded-full bg-info" />
                        ) : null}
                      </div>
                    </button>
                    <button
                      type="button"
                      aria-label={gt("配置 {name}", { name: bot.name })}
                      onClick={() => openSettings(bot.botId)}
                      className="absolute top-1 right-1 flex size-5 items-center justify-center rounded-full bg-background/85 text-muted-foreground opacity-100 shadow-xs transition-opacity hover:text-foreground sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100"
                    >
                      <Settings2Icon className="size-2.5" />
                    </button>
                  </div>
                );
              })}
            </div>
          ) : null}

          {loading ? (
            <div className="space-y-2 pt-1">
              {SKELETON_KEYS.map((key) => (
                <div
                  key={key}
                  className="flex animate-pulse items-center gap-2.5 rounded-lg bg-muted/40 p-2"
                >
                  <div className="size-8 rounded-full bg-muted" />
                  <div className="flex-1 space-y-1.5">
                    <div className="h-3 w-20 rounded bg-muted" />
                    <div className="h-2.5 w-32 rounded bg-muted" />
                  </div>
                </div>
              ))}
            </div>
          ) : filteredBots.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 py-10 text-center">
              <div className="flex size-10 items-center justify-center rounded-xl bg-muted/60 text-sidebar-muted-foreground">
                <BotIcon className="size-5" />
              </div>
              <div className="space-y-0.5">
                <div className="text-xs font-medium text-sidebar-foreground">
                  <T>没有匹配的 Bot</T>
                </div>
                <p className="text-2xs text-sidebar-muted-foreground">
                  <T>点击上方 + 创建一个新的 Bot</T>
                </p>
              </div>
            </div>
          ) : unpinnedBots.length > 0 ? (
            <div className="space-y-0.5">
              {unpinnedBots.map((bot) => {
                const active = activeBotId === bot.botId;
                return (
                  <div
                    key={bot.botId}
                    className={cn(
                      "group flex items-center gap-2 rounded-lg px-2 py-2 transition-colors",
                      active
                        ? "bg-sidebar-row-active text-sidebar-foreground"
                        : "hover:bg-sidebar-row-hover",
                    )}
                  >
                    <button
                      type="button"
                      onClick={() => selectBot(bot.botId)}
                      className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
                    >
                      <BotAvatar
                        color={bot.avatarColor}
                        shape={bot.avatarShape}
                        size="sm"
                        starred={bot.isDefault}
                        running={bot.running}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between gap-1.5">
                          <span className="truncate text-xs font-medium text-sidebar-foreground">
                            {bot.name}
                          </span>
                          <span className="shrink-0 text-3xs text-sidebar-muted-foreground tabular-nums">
                            {formatRelativeTime(bot.lastActivityAt)}
                          </span>
                        </div>
                        <div className="mt-0.5 flex items-center justify-between gap-1.5">
                          <p className="truncate text-2xs text-sidebar-muted-foreground">
                            {bot.lastMessagePreview ||
                              bot.description ||
                              `${bot.engineLabel} · ${bot.model || bot.agentRef}`}
                          </p>
                          {bot.unread ? (
                            <span className="inline-block size-2 shrink-0 rounded-full bg-info" />
                          ) : null}
                        </div>
                      </div>
                    </button>

                    <div className="shrink-0 opacity-100 transition-opacity sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100">
                      <Button
                        type="button"
                        size="icon-xs"
                        variant="ghost-muted"
                        aria-label={gt("配置 {name}", { name: bot.name })}
                        onClick={() => openSettings(bot.botId)}
                      >
                        <Settings2Icon className="size-3" />
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : null}
        </div>
      </SidebarGroup>
    </SidebarContent>
  );
}
