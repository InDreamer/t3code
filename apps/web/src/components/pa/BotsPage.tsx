import { useNavigate, useSearch } from "@tanstack/react-router";
import { T, useGT, Var } from "gt-react";
import { BotIcon, Loader2Icon, PlusIcon } from "lucide-react";
import { useEffect } from "react";

import { isElectron } from "~/env";
import { Button } from "../ui/button";
import { SidebarInset } from "../ui/sidebar";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { BotChatPane } from "./BotChatPane";
import { BotSettingsSheet } from "./BotSettingsSheet";
import { CreateBotDialog } from "./CreateBotDialog";
import {
  loadPaBots,
  rememberLastPaBotId,
  setPaCreateDialogOpen,
  setPaSettingsBotId,
  usePaBotsStore,
} from "./paBotsStore";

export interface BotsSearch {
  readonly bot?: string;
  readonly session?: string;
}

export function BotsPage() {
  const gt = useGT();
  const search = useSearch({ from: "/_chat/bots" });
  const navigate = useNavigate();
  const { instances, bots, loading, error, lastBotId, createOpen, settingsBotId } =
    usePaBotsStore();

  const activeBot =
    (search.bot ? bots.find((b) => b.botId === search.bot) : undefined) ??
    (lastBotId ? bots.find((b) => b.botId === lastBotId) : undefined) ??
    bots.find((b) => b.isDefault) ??
    bots[0] ??
    null;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- remembers the active PA Bot in the module store so switching Code -> Bots restores it
  useEffect(() => {
    if (activeBot) {
      rememberLastPaBotId(activeBot.botId);
    }
  }, [activeBot]);

  const selectBot = (botId: string, sessionId?: string) => {
    rememberLastPaBotId(botId);
    void navigate({
      to: "/bots",
      search: {
        bot: botId,
        ...(sessionId ? { session: sessionId } : {}),
      },
    });
  };

  const offlineInstances = instances.filter((i) => !i.online);
  const capabilitiesFor = (instanceId: string | undefined) =>
    instances.find((i) => i.instanceId === instanceId)?.capabilities ?? null;
  const settingsBot = settingsBotId ? (bots.find((b) => b.botId === settingsBotId) ?? null) : null;

  return (
    <SidebarInset className="flex h-dvh min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      {activeBot ? (
        <BotChatPane
          key={activeBot.botId}
          bot={activeBot}
          capabilities={capabilitiesFor(activeBot.instanceId)}
          selectedSessionId={search.bot === activeBot.botId ? (search.session ?? null) : null}
          onSelectSession={(sessionId) => selectBot(activeBot.botId, sessionId)}
          onOpenSettings={() => setPaSettingsBotId(activeBot.botId)}
          onActivity={() => void loadPaBots(true)}
        />
      ) : (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
          <WorkspacePageHeader
            electron={isElectron}
            className="justify-between border-b border-border/60"
          >
            <div className="flex min-w-0 items-center gap-2">
              <BotIcon className="size-4 shrink-0 text-muted-foreground" />
              <span className="truncate text-sm font-semibold">
                <T>Bots</T>
              </span>
            </div>
            <Button
              type="button"
              size="xs"
              variant="outline"
              onClick={() => setPaCreateDialogOpen(true)}
            >
              <PlusIcon className="size-3.5" />
              <T>新建 Bot</T>
            </Button>
          </WorkspacePageHeader>

          <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center text-muted-foreground">
            {loading ? (
              <div className="flex items-center gap-2 text-sm">
                <Loader2Icon className="size-4 animate-spin" />
                <T>正在加载 Bots...</T>
              </div>
            ) : (
              <>
                {error ? (
                  <div className="max-w-sm rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
                    {error}
                  </div>
                ) : null}
                {offlineInstances.length > 0 ? (
                  <div className="max-w-sm space-y-2">
                    {offlineInstances.map((instance) => (
                      <div
                        key={instance.instanceId}
                        className="rounded-xl border border-warning/40 bg-warning-surface p-3 text-xs text-warning-foreground"
                      >
                        <T>
                          <Var>{instance.label}</Var> 当前未连接：
                          <Var>{instance.error || gt("请检查引擎服务状态")}</Var>
                        </T>
                      </div>
                    ))}
                  </div>
                ) : null}
                <div className="flex size-14 items-center justify-center rounded-2xl bg-muted/50">
                  <BotIcon className="size-6" />
                </div>
                <div className="space-y-1">
                  <div className="text-base font-medium text-foreground">
                    <T>还没有可用的 Bot</T>
                  </div>
                  <p className="max-w-sm text-xs">
                    <T>创建一个 Personal Agent Bot，或检查引擎连接状态。</T>
                  </p>
                </div>
                <Button type="button" size="sm" onClick={() => setPaCreateDialogOpen(true)}>
                  <PlusIcon className="size-4" />
                  <T>新建 Bot</T>
                </Button>
              </>
            )}
          </div>
        </div>
      )}

      <CreateBotDialog
        open={createOpen}
        onOpenChange={setPaCreateDialogOpen}
        instances={instances}
        onCreated={(created) => {
          void loadPaBots(true);
          selectBot(created.botId);
        }}
      />

      <BotSettingsSheet
        bot={settingsBot}
        capabilities={capabilitiesFor(settingsBot?.instanceId)}
        open={settingsBot !== null}
        onOpenChange={(open) => {
          if (!open) setPaSettingsBotId(null);
        }}
        onSaved={() => {
          void loadPaBots(true);
        }}
      />
    </SidebarInset>
  );
}
