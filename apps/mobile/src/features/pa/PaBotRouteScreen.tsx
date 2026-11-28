import { useAtomValue } from "@effect/atom-react";
import { useIsFocused, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { selectPaQuickCommands } from "@t3tools/client-runtime/pa/chat";
import { resolvePaModelSelection } from "@t3tools/client-runtime/pa/models";
import {
  summarizePaLiveActivity,
  formatPaSessionSource,
} from "@t3tools/client-runtime/pa/presentation";
import { AuthOrchestrationReadScope, EnvironmentId } from "@t3tools/contracts";
import { T, useGT, useMessages } from "gt-react-native";
import { use, useEffect, useRef, useState } from "react";
import { Platform, Pressable, View, type ScrollViewInstance } from "react-native";
import { useKeyboardState, KeyboardStickyView } from "react-native-keyboard-controller";
import { useSharedValue } from "react-native-reanimated";

import { useComposerBottomInset } from "../../components/ComposerSurface";
import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppBar } from "../../components/ui/AppBar";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/EmptyState";
import { Notice } from "../../components/ui/Notice";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { useBarOverlap } from "../../components/ui/useBarInset";
import { chatContentMaxWidth } from "../../lib/layout";
import { deriveBottomControlInsets, type NativeLayoutMetrics } from "../../lib/reserved-regions";
import { NativeLayoutObserver } from "../../native/NativeLayoutObserver";
import { NativeScrollView } from "../../native/NativeScrollViewMarker";
import { useNativeWorkspaceColumnsSupported } from "../../native/NativeWorkspaceColumns";
import { useDeviceType, useNativeColumnLayoutMetrics } from "../../native/native-layout-metrics";
import { useAdaptiveWorkspaceLayout } from "../layout/adaptive-workspace-context";
import { useAppActive } from "../../lib/appState";
import { NativeWorkspaceTabActivityContext } from "../../native/v5-workspace-context";
import { connectedEnvironmentIdsAtom } from "../../state/presentation";
import { useEnvironmentScopeDenied } from "../../state/session";
import { useAndroidWorkspaceBack } from "../layout/workspace/useAndroidWorkspaceNavigation";
import { ComposerPopoverHost } from "../threads/ComposerPopoverHost";
import { useMessageTimeFormatter } from "../threads/useMessageTimeFormatter";
import { BotAvatar } from "./BotAvatar";
import {
  paOperatePermissionAtom,
  paSelectModelPermissionAtom,
  paUpdateMetaPermissionAtom,
} from "./paApi";
import { paBotChatView } from "./paBotChat";
import type { PaBotParams } from "./paBotParams";
import { PaComposer } from "./PaComposer";
import { refreshPaRoster, usePaBot } from "./paRosterStore";
import {
  PaAssistantMessageRow,
  PaCompactionRow,
  PaLiveTurnView,
  PaMessageTimeContext,
  PaSystemOutputRow,
  PaUserMessageRow,
  PaWorkGroupRow,
} from "./PaTimelineRows";
import { usePaBotChat } from "./usePaBotChat";
import { paModelCatalogs, usePaModelCatalog } from "./usePaModelCatalog";

const NEAR_BOTTOM_PX = 96;

// Selecting another Bot reuses this route, so its chat and scroll position are keyed.
export function PaBotRouteScreen({ route }: StaticScreenProps<PaBotParams>) {
  const params = route.params;
  const { chat, state } = usePaBotChat(params.environmentId, params.botId, params.sessionId);
  return (
    <PaBotRoute
      key={JSON.stringify([params.environmentId, params.botId, state.activeSessionId])}
      params={params}
      chat={chat}
      state={state}
    />
  );
}

function PaBotRoute({
  params,
  chat,
  state,
}: { readonly params: PaBotParams } & ReturnType<typeof usePaBotChat>) {
  const gt = useGT();
  const messages = useMessages();
  const formatMessageTime = useMessageTimeFormatter();
  const navigation = useNavigation();
  const returnToList = useAndroidWorkspaceBack();
  const { layout } = useAdaptiveWorkspaceLayout();
  const environmentId = EnvironmentId.make(params.environmentId);
  const { bot, capabilities, entry } = usePaBot(params.environmentId, params.botId);
  const canOperate = useAtomValue(paOperatePermissionAtom(environmentId));
  const readDenied = useEnvironmentScopeDenied(environmentId, AuthOrchestrationReadScope);
  const canMarkRead = useAtomValue(paUpdateMetaPermissionAtom(environmentId));
  const canSelectModel = useAtomValue(paSelectModelPermissionAtom(environmentId));
  const connected = useAtomValue(connectedEnvironmentIdsAtom, (ids) => ids.includes(environmentId));
  const focused = useIsFocused();
  const foreground = useAppActive();
  const tabActivity = use(NativeWorkspaceTabActivityContext);
  const visible =
    focused && foreground && (tabActivity?.active ?? true) && !tabActivity?.headerOnly;
  const view = paBotChatView(state);
  const composerBottomInset = useComposerBottomInset();
  const barOverlap = useBarOverlap();
  const deviceType = useDeviceType();
  const usesNativeWorkspaceColumns = useNativeWorkspaceColumnsSupported();
  const [screenMetrics, setScreenMetrics] = useState<NativeLayoutMetrics | null>(null);
  const columnMetrics = useNativeColumnLayoutMetrics();
  const controlInsets = deriveBottomControlInsets(
    usesNativeWorkspaceColumns ? columnMetrics : screenMetrics,
  );
  const [composerHeight, setComposerHeight] = useState(96);
  const [composerFocused, setComposerFocused] = useState(false);
  // The Android portal measures its gesture area inside the sticky keyboard host.
  const slashPopoverHeight = useSharedValue(0);
  const scrollRef = useRef<ScrollViewInstance>(null);
  const [nearBottom, setNearBottom] = useState(true);
  const following = useRef(true);
  const beforePrepend = useRef<string | undefined>(undefined);
  // Anchoring is only for rows read in above; left on, a header row changing size moves the chat.
  const [prepending, setPrepending] = useState(false);
  const keyboardHeight = useKeyboardState((keyboard) => keyboard.height);
  const followEnd = (animated: boolean) => {
    following.current = true;
    beforePrepend.current = undefined;
    setPrepending(false);
    setNearBottom(true);
    scrollRef.current?.scrollToEnd({ animated });
  };
  const loadOlder = () => {
    if (!view.transcript.olderCursor || view.older?.loading) return;
    beforePrepend.current = view.transcript.messages[0]?.id;
    setPrepending(true);
    void chat.loadOlderMessages();
  };
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- only a foreground detail may create the primary session or clear the bot's unread badge
  useEffect(() => (visible ? chat.holdVisible() : undefined), [chat, visible]);
  const unread = bot?.unread ?? false;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- hands the shared chat the Bot's latest capabilities, primary session hint, and permissions
  useEffect(() => {
    chat.setContext({
      capabilities,
      canOperate,
      canMarkRead,
      readDenied,
      unread,
      connected,
      primarySessionId: bot?.primarySessionId ?? null,
    });
  }, [
    chat,
    capabilities,
    canOperate,
    canMarkRead,
    readDenied,
    unread,
    connected,
    bot?.primarySessionId,
  ]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the chat's /model command opens this page's model sheet
  useEffect(() => {
    if (!canSelectModel || !visible) return;
    chat.setOpenModelPicker((query) =>
      navigation.navigate("PaModel", {
        environmentId: params.environmentId,
        botId: params.botId,
        ...(query ? { query } : {}),
      }),
    );
    return () => chat.setOpenModelPicker(null);
  }, [chat, navigation, params.environmentId, params.botId, canSelectModel, visible]);

  const sheetParams = { environmentId: params.environmentId, botId: params.botId };
  const activeSession = view.activeSession;
  const sessionLabel = activeSession
    ? activeSession.isPrimary
      ? gt("Primary conversation")
      : activeSession.title || formatPaSessionSource(activeSession.source, messages)
    : null;
  const subtitle = !bot
    ? null
    : view.liveTurn.openRequests.length
      ? gt("Waiting for input")
      : view.running
        ? view.liveTurn.statusText || gt("Working…")
        : !bot.online || !connected
          ? gt("{engine} · Offline", { engine: bot.engineLabel })
          : (sessionLabel ?? bot.engineLabel);
  const showsModel = canSelectModel && capabilities?.models.supported === true;
  const catalogKey = showsModel
    ? {
        environmentId: params.environmentId,
        botId: params.botId,
        sessionId: state.activeSessionId,
      }
    : null;
  const modelCatalog = usePaModelCatalog(catalogKey);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the engine's catalog so the composer names the live model and effort before the sheet opens; the sheet reuses this read
  useEffect(() => {
    if (!showsModel) return;
    const target = {
      environmentId: params.environmentId,
      botId: params.botId,
      sessionId: state.activeSessionId,
    };
    const catalog = paModelCatalogs.read(target).catalog;
    const cached = catalog?.current;
    const drifted =
      capabilities?.models.scope !== "session" &&
      catalog?.scope !== "session" &&
      catalog !== null &&
      ((bot?.model != null && cached?.model !== bot.model) ||
        (bot?.provider != null && cached?.provider !== bot.provider));
    void paModelCatalogs.load(target, { revision: state.settingsVersion, force: drifted });
  }, [
    showsModel,
    capabilities?.models.scope,
    bot?.model,
    bot?.provider,
    params.environmentId,
    params.botId,
    state.activeSessionId,
    state.settingsVersion,
  ]);
  const liveReasoning = state.activeSessionId
    ? state.sessionReasoning[state.activeSessionId]
    : undefined;
  const modelSelection = resolvePaModelSelection({
    catalog: modelCatalog.catalog,
    bot,
    scope: capabilities?.models.scope,
    sessionModel: activeSession?.model,
    liveReasoningEffort:
      liveReasoning?.settingsVersion === state.settingsVersion ? liveReasoning.effort : null,
    resolve: messages,
  });
  const quickCommands = selectPaQuickCommands(
    capabilities?.commands.supported === false
      ? []
      : state.slashCommands.filter(
          (command) => canSelectModel || command.handling !== "client:model-picker",
        ),
  );
  const contentMaxWidth = chatContentMaxWidth(Platform.OS, layout.usesSplitView);
  const showComposer = bot !== null && !view.readDenied;
  const loadingChat =
    !view.readDenied &&
    ((view.sessionId === null && state.loadingSessions) || view.loadingMessages);
  const empty =
    !view.readDenied && !loadingChat && view.timelineItems.length === 0 && !view.hasLiveTurn;

  const scrollToEnd = (animated: boolean) => scrollRef.current?.scrollToEnd({ animated });

  return (
    <View className="flex-1 bg-screen">
      <AppBar
        title={bot?.name ?? gt("Bot")}
        subtitle={subtitle}
        onBackToList={returnToList}
        actions={
          bot
            ? [
                {
                  accessibilityLabel: gt("Conversations"),
                  icon: "bubble.left.and.bubble.right",
                  onPress: () => navigation.navigate("PaSessions", sheetParams),
                },
                {
                  accessibilityLabel: gt("Bot settings"),
                  icon: "gearshape",
                  onPress: () => navigation.navigate("PaBotSettings", sheetParams),
                },
              ]
            : []
        }
      />
      <ScreenContent>
        {!usesNativeWorkspaceColumns ? <NativeLayoutObserver onChange={setScreenMetrics} /> : null}
        <PaMessageTimeContext value={formatMessageTime}>
          <NativeScrollView
            ref={scrollRef}
            className="flex-1"
            // The top padding clears the bar instead of an automatic inset: `scrollToEnd` clamps to
            // offset 0, which under an automatic inset puts a short chat behind the bar.
            contentInsetAdjustmentBehavior="never"
            scrollIndicatorInsets={Platform.OS === "ios" ? { top: barOverlap } : undefined}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="interactive"
            // Older rows go in above: the reader stays on what they were reading.
            maintainVisibleContentPosition={prepending ? { minIndexForVisible: 1 } : undefined}
            onScroll={(event) => {
              const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
              following.current =
                contentSize.height - contentOffset.y - layoutMeasurement.height < NEAR_BOTTOM_PX;
              setNearBottom(following.current);
            }}
            scrollEventThrottle={64}
            // Only the reader's own drag to the top reads further back, never a layout jump.
            onScrollEndDrag={(event) => {
              if (event.nativeEvent.contentOffset.y < 120) loadOlder();
            }}
            onContentSizeChange={() => {
              if (beforePrepend.current !== undefined) {
                if (view.older?.loading) return;
                const prepended = beforePrepend.current !== view.transcript.messages[0]?.id;
                beforePrepend.current = undefined;
                setPrepending(false);
                if (prepended) return;
              }
              if (following.current) scrollToEnd(false);
            }}
            contentContainerStyle={{
              width: "100%",
              maxWidth: contentMaxWidth,
              alignSelf: "center",
              paddingHorizontal: 16,
              paddingTop: barOverlap + 8,
              paddingBottom: showComposer
                ? composerHeight +
                  Math.max(0, keyboardHeight - composerBottomInset) +
                  controlInsets.bottom +
                  16
                : 24,
            }}
          >
            <View collapsable={false}>
              {!bot ? (
                entry.loading ? (
                  <AppActivityIndicator className="my-12" colorClassName="accent-icon" />
                ) : (
                  <EmptyState
                    title={gt("Bot not found")}
                    detail={entry.error ?? gt("This bot is no longer available.")}
                    variant="plain"
                    action={
                      <Button
                        label={gt("Try again")}
                        onPress={() => void refreshPaRoster(params.environmentId)}
                      />
                    }
                  />
                )
              ) : !bot.online || !connected ? (
                <View className="pb-3">
                  <Notice
                    icon="wifi.slash"
                    message={gt("{engine} is offline. Messages send once it reconnects.", {
                      engine: bot.engineLabel,
                    })}
                  />
                </View>
              ) : null}
              {bot && view.readDenied ? (
                <EmptyState
                  title={gt("Could not load messages")}
                  detail={gt("Could not connect to the bot session")}
                  variant="plain"
                />
              ) : null}
              {bot && view.transcript.olderCursor !== null && !view.loadingMessages ? (
                <View className="items-center gap-1 pb-3">
                  <Button
                    size="compact"
                    tone="text"
                    label={
                      view.older?.loading
                        ? gt("Loading earlier messages…")
                        : gt("Load earlier messages")
                    }
                    disabled={view.older?.loading === true}
                    onPress={loadOlder}
                  />
                  {view.older?.error ? (
                    <Text className="text-xs text-foreground-muted">{view.older.error}</Text>
                  ) : null}
                </View>
              ) : null}
              {bot && loadingChat ? (
                <View className="flex-row items-center justify-center gap-2 py-12">
                  <AppActivityIndicator colorClassName="accent-icon" />
                  <Text className="text-sm text-foreground-muted">
                    <T>Loading conversation…</T>
                  </Text>
                </View>
              ) : null}
              {bot && state.initializationError ? (
                <EmptyState
                  title={gt("Could not connect to the bot session")}
                  detail={state.initializationError}
                  variant="plain"
                  action={
                    <Button label={gt("Retry")} onPress={() => void chat.retryInitialization()} />
                  }
                />
              ) : null}
              {bot && empty && !state.initializationError ? (
                <View className="items-center gap-3 py-12">
                  <BotAvatar
                    color={bot.avatarColor}
                    shape={bot.avatarShape}
                    size="lg"
                    online={bot.online && connected}
                    running={view.running}
                    visible={visible}
                    awaiting={view.liveTurn.openRequests.length > 0}
                    starred={bot.isDefault}
                  />
                  <Text className="text-base font-t3-bold text-foreground">{bot.name}</Text>
                  <Text className="max-w-[280px] text-center text-sm text-foreground-muted">
                    {bot.description ||
                      (quickCommands.length > 0
                        ? gt("Start chatting or type / to use {engine} commands.", {
                            engine: bot.engineLabel,
                          })
                        : gt("Start chatting."))}
                  </Text>
                  {quickCommands.length > 0 ? (
                    <View className="flex-row flex-wrap justify-center gap-2 pt-1">
                      {quickCommands.map((command) => (
                        <Pressable
                          key={command}
                          accessibilityRole="button"
                          disabled={!canOperate}
                          onPress={() => {
                            followEnd(false);
                            void chat.send(command);
                          }}
                          className="rounded-full border border-border-subtle bg-subtle px-3 py-1.5 active:opacity-70"
                        >
                          <Text className="font-mono text-xs text-foreground-muted">{command}</Text>
                        </Pressable>
                      ))}
                    </View>
                  ) : null}
                </View>
              ) : null}
            </View>
            {view.timelineItems.map((item) => {
              switch (item.kind) {
                case "user":
                  return (
                    <PaUserMessageRow
                      key={item.id}
                      message={item.message}
                      environmentId={environmentId}
                    />
                  );
                case "work-group":
                  return <PaWorkGroupRow key={item.id} steps={item.steps} />;
                case "assistant":
                  return (
                    <PaAssistantMessageRow
                      key={item.id}
                      text={item.message.text}
                      timestamp={item.message.timestamp}
                      showMeta={!item.isCommentary}
                      commentary={item.isCommentary}
                      truncated={item.message.truncated === true}
                    />
                  );
                case "compaction":
                  return <PaCompactionRow key={item.id} message={item.message} />;
                case "system-output":
                  return <PaSystemOutputRow key={item.id} message={item.message} />;
              }
            })}
            {view.hasLiveTurn ? <PaLiveTurnView liveTurn={view.liveTurn} /> : null}
          </NativeScrollView>
        </PaMessageTimeContext>
        {bot && showComposer ? (
          <KeyboardStickyView
            enabled={deviceType !== "duo-unfolded" || composerFocused}
            pointerEvents="box-none"
            style={{ position: "absolute", bottom: 0, left: 0, right: 0, top: 0 }}
            offset={{ closed: 0, opened: composerBottomInset }}
          >
            <ComposerPopoverHost hidden={!visible} popoverHeight={slashPopoverHeight}>
              <View
                pointerEvents="box-none"
                style={{
                  position: "absolute",
                  bottom: controlInsets.bottom,
                  left: controlInsets.left,
                  right: controlInsets.right,
                }}
              >
                {!nearBottom && (
                  <View className="items-center">
                    <Button
                      size="compact"
                      tone="secondary"
                      icon="arrow.down"
                      label={
                        summarizePaLiveActivity(view.liveTurn, messages) ?? gt("Scroll to bottom")
                      }
                      onPress={() => followEnd(true)}
                    />
                  </View>
                )}
                <PaComposer
                  environmentId={params.environmentId}
                  bot={bot}
                  capabilities={capabilities}
                  chat={chat}
                  sending={state.sending}
                  slashCommands={state.slashCommands}
                  respondingIds={state.respondingIds}
                  clarifyAnswers={state.clarifyAnswers}
                  queueBusyIds={state.queueBusyIds}
                  view={{
                    sessionId: view.sessionId,
                    liveTurn: view.liveTurn,
                    running: view.running,
                    draft: view.draft,
                  }}
                  canSelectModel={canSelectModel}
                  onSend={() => followEnd(false)}
                  canOperate={canOperate}
                  modelLabel={modelSelection.displayLabel}
                  modelProvider={modelSelection.provider}
                  modelId={modelSelection.model}
                  reasoningLabel={modelSelection.reasoningLabel}
                  bottomInset={composerBottomInset}
                  contentMaxWidth={contentMaxWidth}
                  onOpenModel={() => navigation.navigate("PaModel", sheetParams)}
                  onHeightChange={setComposerHeight}
                  hidden={!visible}
                  onFocusChange={(focused) => {
                    setComposerFocused(focused);
                    if (focused && following.current) scrollToEnd(true);
                  }}
                />
              </View>
            </ComposerPopoverHost>
          </KeyboardStickyView>
        ) : null}
      </ScreenContent>
    </View>
  );
}
