import { useAtomValue } from "@effect/atom-react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import {
  filterPaBots,
  formatPaRosterTime,
  groupPaBots,
  paBotPreview,
  paBotStatusLabels,
  paOfflineInstances,
  resolveActivePaBot,
} from "@t3tools/client-runtime/pa/roster";
import { T, useGT, useMessages, Var } from "gt-react";
import { PlusIcon, RefreshCwIcon, SearchIcon, Settings2Icon } from "lucide-react";
import { useState } from "react";

import { usePrimaryEnvironmentId } from "../../state/environments";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { SidebarContent, SidebarGroup, useSidebar } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { BotAvatar, BotAvatarTrio } from "./BotAvatar";
import { paCreateBotPermissionAtom } from "./paApi";
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
  const mayCreate = useAtomValue(paCreateBotPermissionAtom(usePrimaryEnvironmentId()));
  const navigate = useNavigate();
  const rawSearch = useSearch({ strict: false }) as { readonly bot?: unknown };
  const routeBotId = typeof rawSearch.bot === "string" && rawSearch.bot ? rawSearch.bot : null;
  const { isMobile, openMobile, open, setOpenMobile } = useSidebar();
  const { instances, bots, loading, refreshing, error, lastBotId } = usePaBotsStore(
    isMobile ? openMobile : open,
  );
  const [query, setQuery] = useState("");

  const m = useMessages();

  const filteredBots = filterPaBots(bots, query);
  const { pinned: pinnedBots, others: unpinnedBots } = groupPaBots(filteredBots);
  const activeBotId = resolveActivePaBot(bots, routeBotId, lastBotId)?.botId ?? null;

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

  const offlineInstances = paOfflineInstances(instances);

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
                placeholder={gt("Search bots")}
                aria-label={gt("Search bots")}
                className="min-w-0 flex-1 bg-transparent text-xs text-sidebar-foreground outline-none placeholder:text-sidebar-muted-foreground pointer-coarse:text-(length:--font-size-input-touch)"
              />
            </div>

            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    size="icon-xs"
                    variant="ghost-muted"
                    aria-label={gt("Refresh bots")}
                    disabled={refreshing}
                    onClick={() => void loadPaBots(true)}
                  />
                }
              >
                <RefreshCwIcon className={cn("size-3.5", refreshing && "animate-spin")} />
              </TooltipTrigger>
              <TooltipPopup side="bottom">
                <T>Refresh bots</T>
              </TooltipPopup>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    size="icon-xs"
                    variant="ghost-muted"
                    disabled={!mayCreate}
                    aria-label={gt("Create bot")}
                    onClick={openCreate}
                  />
                }
              >
                <PlusIcon className="size-3.5" />
              </TooltipTrigger>
              <TooltipPopup side="bottom">
                <T>Create bot</T>
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
                    <Var>{instance.label}</Var> disconnected.
                    <Var>{instance.error || gt("Check service status")}</Var>
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
                      <span className="sr-only">{paBotStatusLabels(bot, m).join(", ")}</span>
                      <BotAvatar
                        color={bot.avatarColor}
                        shape={bot.avatarShape}
                        size="md"
                        online={bot.online}
                        running={bot.running}
                        visible={isMobile ? openMobile : open}
                        awaiting={bot.awaiting ?? false}
                        unread={bot.unread}
                        starred={bot.isDefault}
                        className="transition-transform group-hover:scale-105"
                      />
                      <span className="max-w-full truncate text-xs font-medium">{bot.name}</span>
                    </button>
                    <button
                      type="button"
                      aria-label={gt("Configure {name}", { name: bot.name })}
                      onClick={() => openSettings(bot.botId)}
                      className="absolute top-1 right-1 flex size-5 items-center justify-center rounded-full bg-background/85 text-muted-foreground opacity-100 shadow-xs transition-opacity hover:text-foreground pointer-coarse:after:absolute pointer-coarse:after:-inset-2.5 sm:pointer-fine:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100"
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
                <div key={key} className="flex items-center gap-2.5 rounded-lg bg-muted/40 p-2">
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
              <BotAvatarTrio size="sm" />
              <div className="space-y-0.5">
                <div className="text-xs font-medium text-sidebar-foreground">
                  <T>No matching bots</T>
                </div>
                {mayCreate && (
                  <p className="text-2xs text-sidebar-muted-foreground">
                    <T>Select + above to create a bot</T>
                  </p>
                )}
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
                      <span className="sr-only">{paBotStatusLabels(bot, m).join(", ")}</span>
                      <BotAvatar
                        color={bot.avatarColor}
                        shape={bot.avatarShape}
                        size="sm"
                        online={bot.online}
                        running={bot.running}
                        visible={isMobile ? openMobile : open}
                        awaiting={bot.awaiting ?? false}
                        unread={bot.unread}
                        starred={bot.isDefault}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between gap-1.5">
                          <span className="truncate text-xs font-medium text-sidebar-foreground">
                            {bot.name}
                          </span>
                          <span className="shrink-0 text-3xs text-sidebar-muted-foreground tabular-nums">
                            {formatPaRosterTime(bot.lastActivityAt)}
                          </span>
                        </div>
                        <p className="mt-0.5 truncate text-2xs text-sidebar-muted-foreground">
                          {paBotPreview(bot)}
                        </p>
                      </div>
                    </button>

                    <div className="shrink-0 opacity-100 transition-opacity sm:pointer-fine:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100">
                      <Button
                        type="button"
                        size="icon-xs"
                        variant="ghost-muted"
                        aria-label={gt("Configure {name}", { name: bot.name })}
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
