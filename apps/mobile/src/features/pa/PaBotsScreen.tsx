import { LegendList, type LegendListRef } from "@legendapp/list/react-native";
import {
  filterPaBots,
  formatPaRosterTime,
  groupPaBots,
  paBotPreview,
  paOfflineInstances,
} from "@t3tools/client-runtime/pa/roster";
import { useNavigation } from "@react-navigation/native";
import { useGT, useMessages } from "gt-react-native";
import { use, useRef, useState, type ReactNode } from "react";
import { Keyboard, Platform, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { EmptyState } from "../../components/ui/EmptyState";
import { usePaneRole } from "../../components/ui/Pane";
import { RefreshControl } from "../../components/ui/RefreshControl";
import { useContentTopInset } from "../../components/ui/useBarInset";
import { NativeScrollView } from "../../native/NativeScrollViewMarker";
import { useNativeColumnLayoutMetrics } from "../../native/native-layout-metrics";
import { NativePrimaryColumnContext } from "../../native/v5-workspace-context";
import { useWorkspaceEnvironments } from "../../state/workspace";
import { useSearchScrollRestoration } from "../layout/workspace/useSearchScrollRestoration";
import { useSelectWorkspaceDetail } from "../layout/workspace/useSelectWorkspaceDetail";
import { useWorkspaceTabs } from "../layout/workspace/WorkspaceTabsContext";
import { useMessageTimeFormatter } from "../threads/useMessageTimeFormatter";
import { paClient, paErrorMessage } from "./paApi";
import { paBotKey } from "./paBotParams";
import { PaBotRow, type PaBotRowAction, type PaRosterBot } from "./PaBotRow";
import {
  patchPaBot,
  refreshPaRoster,
  refreshPaRosters,
  usePaRosterEntries,
  usePaRosterRefresh,
  usePaCreatableEngines,
} from "./paRosterStore";

type Row =
  | { readonly kind: "header"; readonly key: string; readonly title: string }
  | {
      readonly kind: "notice";
      readonly key: string;
      readonly text: string;
      readonly retryEnvironmentId?: string;
      readonly tone: "warning" | "danger";
    }
  | { readonly kind: "bot"; readonly key: string; readonly bot: PaRosterBot };

export function PaBotsScreen(
  props: {
    readonly sidebar?: boolean;
    readonly showCreateAction?: boolean;
    readonly selectedBotKey?: string | null;
    /** Places the list under a header of the caller's (the Android toolbar). */
    readonly renderFrame?: (list: ReactNode) => ReactNode;
  } = {},
) {
  const gt = useGT();
  const messages = useMessages();
  const formatMessageTime = useMessageTimeFormatter();
  const canCreate = usePaCreatableEngines().length > 0;
  const navigation = useNavigation();
  const primaryColumn = use(NativePrimaryColumnContext);
  const workspace = useWorkspaceTabs()!;
  const environments = useWorkspaceEnvironments();
  const insets = useSafeAreaInsets();
  const contentTopInset = useContentTopInset();
  const columnSafeBottom = useNativeColumnLayoutMetrics()?.safeArea.bottom;
  const bottomSafeArea =
    Platform.OS === "ios" ? (columnSafeBottom ?? insets.bottom) : insets.bottom;
  const listRef = useRef<LegendListRef>(null);
  const tab = workspace.state.tabs.bots;
  const [initialScrollOffset] = useState(() => workspace.getScrollOffset("bots"));
  useSearchScrollRestoration(tab.searchMode, () => {
    void listRef.current?.scrollToOffset({
      offset: tab.scrollOffset - contentTopInset,
      animated: false,
    });
  });
  const query = tab.searchMode === "resting" ? "" : tab.query;

  const connected = environments.filter(
    (environment) => environment.isEnabled && environment.connectionState === "connected",
  );
  const environmentIds = connected.map((environment) => String(environment.environmentId)).sort();
  usePaRosterRefresh(environmentIds);
  const rosters = usePaRosterEntries();
  const loaded = connected.flatMap((environment) => {
    const entry = rosters.get(String(environment.environmentId));
    return entry ? [{ environment, entry }] : [];
  });
  const withEngines = loaded.filter(({ entry }) => entry.instances.length > 0);
  const showEnvironment = withEngines.length > 1;
  const allBots: ReadonlyArray<PaRosterBot> = withEngines.flatMap(({ environment, entry }) =>
    entry.bots.map((bot) => ({
      ...bot,
      environmentId: String(environment.environmentId),
      environmentLabel: showEnvironment ? environment.environmentLabel : null,
      key: paBotKey(String(environment.environmentId), bot.botId),
    })),
  );
  const filtered = filterPaBots(allBots, query);
  const { pinned, others } = groupPaBots(filtered);
  const loading = loaded.length < connected.length || loaded.some(({ entry }) => entry.loading);
  const refreshing = loaded.some(({ entry }) => entry.refreshing);
  const failures = loaded.filter(({ entry }) => entry.error !== null && entry.loadedAt === null);
  const everyFailed = loaded.length > 0 && failures.length === loaded.length;

  const notices: Row[] = loaded.flatMap(({ environment, entry }) => [
    ...(entry.error
      ? [
          {
            kind: "notice" as const,
            key: `error:${environment.environmentId}`,
            retryEnvironmentId: environment.environmentId,
            text:
              connected.length > 1
                ? `${environment.environmentLabel}: ${entry.error}`
                : entry.error,
            tone: "danger" as const,
          },
        ]
      : []),
    ...paOfflineInstances(entry.instances).map((instance) => ({
      kind: "notice" as const,
      key: `offline:${environment.environmentId}:${instance.instanceId}`,
      text: gt("{engine} disconnected. {detail}", {
        engine: instance.label,
        detail: instance.error || gt("Check service status"),
      }),
      tone: "warning" as const,
    })),
  ]);
  const rows: Row[] = [
    ...notices,
    ...(pinned.length > 0
      ? [
          { kind: "header" as const, key: "header:pinned", title: gt("Pinned") },
          ...pinned.map((bot) => ({ kind: "bot" as const, key: bot.key, bot })),
          ...(others.length > 0
            ? [{ kind: "header" as const, key: "header:others", title: gt("Bots") }]
            : []),
        ]
      : []),
    ...others.map((bot) => ({ kind: "bot" as const, key: bot.key, bot })),
  ];

  const paneRole = usePaneRole();
  const sidebar = props.sidebar === true || (primaryColumn !== null && paneRole === "sidebar");
  const selectedKey = props.selectedBotKey ?? primaryColumn?.selectedBotKey ?? null;
  const createButton =
    canCreate && !query ? (
      <Button label={gt("Create bot")} onPress={() => navigation.navigate("PaCreateBot", {})} />
    ) : null;
  const selectDetail = useSelectWorkspaceDetail();
  const selectBot = (bot: PaRosterBot) => {
    Keyboard.dismiss();
    selectDetail({
      name: "PaBot",
      params: { environmentId: bot.environmentId, botId: bot.botId },
    });
  };
  const runAction = async (bot: PaRosterBot, action: PaBotRowAction) => {
    if (action === "settings") {
      navigation.navigate("PaBotSettings", {
        environmentId: bot.environmentId,
        botId: bot.botId,
      });
      return;
    }
    const client = paClient(bot.environmentId);
    try {
      if (action === "markRead") {
        await client.markRead(bot.botId);
        patchPaBot(bot.environmentId, bot.botId, { unread: false });
      } else {
        const pinnedNext = action === "pin";
        await client.updateBotMeta({ botId: bot.botId, pinned: pinnedNext });
        patchPaBot(bot.environmentId, bot.botId, { pinned: pinnedNext });
      }
    } catch (error) {
      Dialog.alert(gt("Could not update the bot"), paErrorMessage(error, gt("Try again.")));
    }
    void refreshPaRoster(bot.environmentId);
  };
  const formatTime = (timestamp: number | null, nowMs: number) =>
    formatPaRosterTime(
      timestamp,
      nowMs,
      (date) => formatMessageTime(date.toISOString(), date.getTime()),
      messages,
    );
  const nowMsFor = (environmentId: string) => rosters.get(environmentId)?.loadedAt ?? 0;

  const content = (
    <View className={sidebar ? "flex-1 bg-drawer" : "flex-1 bg-screen"}>
      <LegendList
        ref={listRef}
        data={rows}
        extraData={selectedKey}
        keyExtractor={(row) => row.key}
        getItemType={(row) => row.kind}
        estimatedItemSize={76}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => void refreshPaRosters(environmentIds)}
            progressViewOffset={Platform.OS === "ios" ? 60 : undefined}
          />
        }
        alwaysBounceVertical
        showsVerticalScrollIndicator={Platform.OS !== "android"}
        recycleItems
        renderScrollComponent={Platform.OS === "ios" ? NativeScrollView : undefined}
        contentInsetAdjustmentBehavior="never"
        contentInset={Platform.OS === "ios" ? { top: contentTopInset } : undefined}
        initialScrollOffset={
          initialScrollOffset > 0 ? initialScrollOffset - contentTopInset : undefined
        }
        contentContainerStyle={{
          paddingBottom: Math.max(bottomSafeArea, workspace.bottomClearance),
        }}
        onScroll={(event) => {
          workspace.recordScrollOffset(
            "bots",
            Math.max(0, event.nativeEvent.contentOffset.y + contentTopInset),
          );
        }}
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
        ListHeaderComponent={props.showCreateAction && allBots.length > 0 ? createButton : null}
        renderItem={({ item }) => {
          switch (item.kind) {
            case "header":
              return (
                <Text
                  accessibilityRole="header"
                  className={
                    sidebar
                      ? "px-3 pb-1 pt-4 text-xs font-t3-medium uppercase text-drawer-foreground-muted"
                      : "px-4 pb-1 pt-4 text-xs font-t3-medium uppercase text-foreground-muted"
                  }
                >
                  {item.title}
                </Text>
              );
            case "notice":
              return (
                <View>
                  <Text
                    selectable
                    className={
                      item.tone === "danger"
                        ? "px-4 py-1.5 text-sm text-danger"
                        : "px-4 py-1.5 text-sm text-warning-foreground"
                    }
                  >
                    {item.text}
                  </Text>
                  {item.retryEnvironmentId && (
                    <Button
                      size="compact"
                      tone="text"
                      label={gt("Retry")}
                      onPress={() => void refreshPaRoster(item.retryEnvironmentId!)}
                    />
                  )}
                </View>
              );
            case "bot":
              return (
                <PaBotRow
                  bot={item.bot}
                  preview={paBotPreview(item.bot)}
                  time={formatTime(item.bot.lastActivityAt, nowMsFor(item.bot.environmentId))}
                  selected={selectedKey === item.bot.key}
                  sidebar={sidebar}
                  onSelect={selectBot}
                  onAction={(bot, action) => void runAction(bot, action)}
                />
              );
          }
        }}
        ListFooterComponent={
          filtered.length > 0 ? null : loading ? (
            <View className="items-center py-12">
              <AppActivityIndicator
                colorClassName="accent-icon"
                accessibilityLabel={gt("Loading bots")}
              />
            </View>
          ) : (
            <View className="px-8 py-12">
              <EmptyState
                title={
                  connected.length === 0
                    ? environments.length > 0
                      ? gt("Environment offline")
                      : gt("Connect an environment")
                    : everyFailed
                      ? gt("Couldn't load bots")
                      : withEngines.length === 0
                        ? gt("No bot engines")
                        : query
                          ? gt("No matching bots")
                          : gt("No bots yet")
                }
                detail={
                  connected.length === 0
                    ? environments.length > 0
                      ? gt("Reconnect to load your bots.")
                      : gt("Add an environment in Settings to chat with its bots.")
                    : everyFailed
                      ? (failures[0]?.entry.error ?? gt("Try again."))
                      : withEngines.length === 0
                        ? gt("Bots appear here once an environment runs a personal agent engine.")
                        : query
                          ? gt("Try a different search.")
                          : canCreate
                            ? gt("Create a bot to start chatting.")
                            : gt(
                                "Bots appear here once an environment runs a personal agent engine.",
                              )
                }
                variant="plain"
                action={
                  createButton ??
                  (everyFailed ? (
                    <Button
                      label={gt("Try again")}
                      onPress={() => void refreshPaRosters(environmentIds)}
                    />
                  ) : undefined)
                }
              />
            </View>
          )
        }
      />
    </View>
  );
  return props.renderFrame ? props.renderFrame(content) : content;
}
