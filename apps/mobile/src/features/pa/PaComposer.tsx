import { resolvePaComposerSendMode } from "@t3tools/client-runtime/pa/composer";
import {
  countPaSlashTabs,
  isCompletePaSlashCommand,
  parsePaClientSlashAction,
  selectPaSlashCommands,
  type PaSlashTab,
} from "@t3tools/client-runtime/pa/slash";
import {
  AuthProvidersManageScope,
  EnvironmentId,
  type PaBotSummary,
  type PaCapabilities,
  type PaSlashCommand,
} from "@t3tools/contracts";
import { useGT } from "gt-react-native";
import { useRef, useState } from "react";
import { Platform, Pressable, ScrollView, View } from "react-native";
import Animated from "react-native-reanimated";

import { ComposerAttachmentStrip } from "../../components/ComposerAttachmentStrip";
import {
  ComposerEditor,
  type ComposerEditorHandle,
  type ComposerEditorSelection,
} from "../../components/ComposerEditor";
import {
  COMPOSER_BOTTOM_GUTTER,
  ComposerSurface,
  INLINE_EDITOR_MIN_WIDTH,
  useCompactComposerEditor,
  useComposerChrome,
  useComposerTextStyle,
} from "../../components/ComposerSurface";
import { ComposerActionButton } from "../../components/ComposerToolbar";
import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { FilePreviewModal, type FilePreviewSource } from "../../components/ui/FilePreviewModal";
import { cn } from "../../lib/cn";
import { useMountedRef } from "../../lib/useMountedRef";
import { useEnvironmentScope } from "../../state/session";
import { useComposerTextRole } from "../settings/appearance/useScaledTextRole";
import { ComposerAttachmentButton } from "../threads/ComposerAttachmentButton";
import { paBotChatView, type PaBotChat, type PaBotChatState } from "./paBotChat";
import { PaPendingRequestCard, PaSecretRequestCard, PaSecretRequestDenied } from "./PaRequestCards";
import { PaContextUsageStrip, PaQueueStrip, PaTodoProgress } from "./PaSessionStatus";
import { usePaAttachments } from "./usePaAttachments";

const EDITOR_LEADING_INSET = 14;

function SlashMenu(props: {
  readonly commands: ReadonlyArray<PaSlashCommand>;
  readonly query: string;
  readonly onPick: (command: PaSlashCommand) => void;
}) {
  const gt = useGT();
  const [tab, setTab] = useState<PaSlashTab>("common");
  const counts = countPaSlashTabs(props.commands);
  const effectiveTab: PaSlashTab = tab === "skills" && counts.skills === 0 ? "common" : tab;
  const matching = selectPaSlashCommands(props.commands, props.query, effectiveTab);
  if (matching.length === 0 && props.query !== "") return null;
  const tabs: ReadonlyArray<{ readonly id: PaSlashTab; readonly label: string }> = [
    { id: "common", label: gt("Favorites") },
    { id: "commands", label: gt("All commands ({count})", { count: counts.commands }) },
    ...(counts.skills > 0
      ? [{ id: "skills" as const, label: gt("Skills ({count})", { count: counts.skills }) }]
      : []),
  ];
  return (
    <View className="overflow-hidden rounded-2xl border border-border-subtle bg-card">
      {props.query === "" ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          keyboardShouldPersistTaps="always"
          className="border-b border-border-subtle"
          contentContainerStyle={{ gap: 4, padding: 6 }}
        >
          {tabs.map((item) => (
            <Pressable
              key={item.id}
              accessibilityRole="tab"
              accessibilityState={{ selected: effectiveTab === item.id }}
              onPress={() => setTab(item.id)}
              className={cn(
                "rounded-lg px-2.5 py-1.5",
                effectiveTab === item.id ? "bg-subtle-strong" : "active:bg-subtle",
              )}
            >
              <Text
                className={cn(
                  "text-xs font-t3-medium",
                  effectiveTab === item.id ? "text-foreground" : "text-foreground-muted",
                )}
              >
                {item.label}
              </Text>
            </Pressable>
          ))}
        </ScrollView>
      ) : null}
      <ScrollView style={{ maxHeight: 220 }} keyboardShouldPersistTaps="always">
        {matching.map((command) => (
          <Pressable
            key={command.name}
            accessibilityRole="button"
            accessibilityLabel={`${command.name}, ${command.description}`}
            onPress={() => props.onPick(command)}
            className="flex-row items-center gap-3 px-3 py-2.5 active:bg-subtle"
          >
            <Text className="shrink-0 font-mono text-sm text-foreground">{command.name}</Text>
            {command.group === "skill" || command.group === "plugin" ? (
              <Text className="shrink-0 rounded bg-subtle-strong px-1.5 text-2xs text-foreground-muted">
                {command.group === "skill" ? gt("Skill") : gt("Plugin")}
              </Text>
            ) : null}
            <Text className="min-w-0 flex-1 text-xs text-foreground-muted" numberOfLines={1}>
              {command.description}
            </Text>
          </Pressable>
        ))}
      </ScrollView>
    </View>
  );
}

/**
 * The Bot page's foot: the session's status, open requests and errors above a composer that
 * sends, queues behind a running turn, steers it, or stops it.
 */
export function PaComposer(props: {
  readonly environmentId: string;
  readonly bot: PaBotSummary;
  readonly capabilities: PaCapabilities | null;
  readonly chat: PaBotChat;
  readonly sending: boolean;
  readonly slashCommands: PaBotChatState["slashCommands"];
  readonly respondingIds: PaBotChatState["respondingIds"];
  readonly queueBusyIds: PaBotChatState["queueBusyIds"];
  readonly clarifyAnswers: PaBotChatState["clarifyAnswers"];
  readonly view: Pick<
    ReturnType<typeof paBotChatView>,
    "draft" | "sessionId" | "liveTurn" | "running"
  >;
  readonly canSelectModel: boolean;
  readonly onSend: () => void;
  readonly canOperate: boolean;
  readonly modelLabel: string | null;
  readonly bottomInset: number;
  readonly contentMaxWidth?: number;
  readonly onOpenModel: () => void;
  readonly onHeightChange: (height: number) => void;
  readonly onFocusChange: (focused: boolean) => void;
}) {
  const gt = useGT();
  const { chat, view, capabilities } = props;
  const editorRef = useRef<ComposerEditorHandle>(null);
  const inFlight = useRef(false);
  const mounted = useMountedRef();
  const [preview, setPreview] = useState<FilePreviewSource | null>(null);
  const [selection, setSelection] = useState<ComposerEditorSelection>({ start: 0, end: 0 });
  const [focused, setFocused] = useState(false);
  const [slashDismissed, setSlashDismissed] = useState(false);
  const bodyText = useComposerTextRole();
  const textStyle = useComposerTextStyle(bodyText);
  const chrome = useComposerChrome();
  const draft = view.draft;
  const compactEditor = useCompactComposerEditor(bodyText, draft, Platform.OS === "ios" && focused);
  const uploads = usePaAttachments(props.environmentId, capabilities?.attachments);
  const canManageProviders = useEnvironmentScope(
    EnvironmentId.make(props.environmentId),
    AuthProvidersManageScope,
  );
  const disabled = view.sessionId === null || !props.canOperate;
  const busy = props.sending || uploads.uploading;
  const hasAttachments = uploads.items.length > 0;
  const slashCommands = capabilities?.commands.supported === false ? [] : props.slashCommands;
  const slashQuery =
    !hasAttachments && !slashDismissed && draft.startsWith("/") && !/\s/.test(draft)
      ? draft.slice(1)
      : null;
  const isClientCommand =
    !hasAttachments && parsePaClientSlashAction(draft, slashCommands) !== null;
  const liveTurn = view.liveTurn;
  const sendMode = resolvePaComposerSendMode({
    running: view.running,
    draft,
    isClientCommand,
    hasOpenRequests: liveTurn.openRequests.length > 0,
    canQueue: capabilities?.execution.queue === true,
    hasAttachments,
    attachmentsBlocked: hasAttachments && !uploads.enabled,
  });
  const hasDraft = draft.trim().length > 0 || hasAttachments;
  const canSend = sendMode !== "blocked" && !disabled && !busy && hasDraft;
  const canInterrupt = capabilities?.execution.interrupt !== false;
  const canSteer =
    !hasAttachments && sendMode === "queue" && capabilities?.execution.steer === true;
  // While a turn runs with nothing to send, the primary slot is the stop button.
  const showStopOnly =
    view.running && !isClientCommand && canInterrupt && (!hasDraft || sendMode === "blocked");

  const sendToSession = async (sessionId: string) => {
    const current = () =>
      mounted.current && !chat.isDisposed() && chat.getState().activeSessionId === sessionId;
    await editorRef.current?.flushPendingInput();
    if (!current()) return;
    const text = chat.getState().drafts[sessionId] ?? "";
    const attachments = await uploads.upload();
    if (!current() || attachments === null) return;
    const live = paBotChatView(chat.getState());
    const mode = resolvePaComposerSendMode({
      running: live.running,
      draft: text,
      isClientCommand:
        !attachments.length && parsePaClientSlashAction(text, slashCommands) !== null,
      hasOpenRequests: live.liveTurn.openRequests.length > 0,
      canQueue: capabilities?.execution.queue === true,
      hasAttachments: attachments.length > 0,
      attachmentsBlocked: !uploads.enabled && attachments.length > 0,
    });
    if (mode === "blocked") return;
    props.onSend();
    const accepted = await chat.send(text, {
      restoreDraft: true,
      queued: mode === "queue",
      attachments,
    });
    if (accepted && attachments.length) uploads.clear(attachments);
  };
  const send = () => {
    if (!view.sessionId || !canSend || inFlight.current) return;
    setSlashDismissed(false);
    inFlight.current = true;
    return sendToSession(view.sessionId).finally(() => {
      inFlight.current = false;
    });
  };
  const completeCommand = (command: PaSlashCommand) => {
    chat.setDraft(`${command.name} `);
    editorRef.current?.focus();
  };
  const toggleSlash = () => {
    if (slashQuery !== null) {
      setSlashDismissed(true);
      if (draft === "/") chat.setDraft("");
      return;
    }
    setSlashDismissed(false);
    if (!draft.startsWith("/")) chat.setDraft(draft ? `/${draft}` : "/");
    editorRef.current?.focus();
  };

  const error = liveTurn.error ?? uploads.error;

  return (
    <Animated.View
      onLayout={(event) => props.onHeightChange(event.nativeEvent.layout.height)}
      className="px-[12px] android:bg-screen"
      style={{ paddingTop: 6, paddingBottom: props.bottomInset + COMPOSER_BOTTOM_GUTTER }}
    >
      <View
        className="absolute inset-0 bg-linear-to-b from-screen/0 via-screen/60 to-screen/90 android:hidden"
        pointerEvents="none"
      />
      <FilePreviewModal source={preview} onRequestClose={() => setPreview(null)} />
      <View className="w-full gap-2 self-center" style={{ maxWidth: props.contentMaxWidth }}>
        <PaTodoProgress todos={liveTurn.todos} />
        <PaQueueStrip
          items={liveTurn.queuedItems}
          canOperate={props.canOperate}
          canSteer={view.running && capabilities?.execution.steer === true && props.canOperate}
          busyIds={props.queueBusyIds}
          onSteer={(item) => void chat.manageQueuedItem(item, "steer")}
          onCancel={(item) => void chat.manageQueuedItem(item, "cancel")}
          onResolveUnknown={(item) => void chat.manageQueuedItem(item, "resolveUnknown")}
        />
        <PaContextUsageStrip usage={liveTurn.usage} />
        {liveTurn.openRequests.length > 0 ? (
          <ScrollView style={{ maxHeight: 320 }} keyboardShouldPersistTaps="handled">
            <View className="gap-2">
              {liveTurn.openRequests.map((request) =>
                request.kind === "secret" ? (
                  disabled || !canManageProviders ? (
                    <PaSecretRequestDenied key={request.requestId} />
                  ) : (
                    <PaSecretRequestCard
                      key={request.requestId}
                      request={request}
                      responding={props.respondingIds.has(request.requestId)}
                      onAnswer={(answer) => chat.respondSecret(request, answer)}
                    />
                  )
                ) : (
                  <PaPendingRequestCard
                    key={request.requestId}
                    request={request}
                    responding={disabled || props.respondingIds.has(request.requestId)}
                    answers={props.clarifyAnswers[request.requestId] ?? {}}
                    onAnswerChange={(questionId, value) =>
                      chat.setClarifyAnswer(request.requestId, questionId, value)
                    }
                    onRespond={(decision) => void chat.respondRequest(request, decision)}
                  />
                ),
              )}
            </View>
          </ScrollView>
        ) : null}
        {error ? (
          <View
            accessibilityRole="alert"
            className="flex-row items-start gap-2 rounded-xl border border-danger-border bg-card px-3 py-2.5"
          >
            <SymbolView
              name="exclamationmark.circle"
              size={14}
              tintColorClassName="accent-danger"
            />
            <Text selectable className="min-w-0 flex-1 text-xs text-danger">
              {error}
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={gt("Dismiss error")}
              hitSlop={8}
              onPress={() => {
                uploads.dismissError();
                chat.dismissError();
              }}
            >
              <SymbolView name="xmark" size={11} tintColorClassName="accent-icon-muted" />
            </Pressable>
          </View>
        ) : null}
        {slashQuery !== null && slashCommands.length > 0 ? (
          <SlashMenu commands={slashCommands} query={slashQuery} onPick={completeCommand} />
        ) : null}
        <ComposerSurface
          animateLayout={false}
          style={{
            borderRadius: chrome.borderRadius,
            borderCurve: "circular",
            overflow: "hidden",
            paddingVertical: chrome.paddingVertical,
          }}
        >
          {hasAttachments ? (
            <View className="px-2 pt-2">
              <ComposerAttachmentStrip
                environmentId={EnvironmentId.make(props.environmentId)}
                attachments={uploads.items}
                removalDisabled={busy}
                onRemove={(id) => {
                  if (!inFlight.current) uploads.remove(id);
                }}
                onPressPreview={setPreview}
                onPressDocument={(attachment) =>
                  setPreview({
                    kind: attachment.mimeType === "application/pdf" ? "pdf" : "document",
                    attachment,
                    name: attachment.name,
                    mimeType: attachment.mimeType,
                  })
                }
                imageSize={56}
              />
            </View>
          ) : null}
          <View onLayout={compactEditor.onRowLayout} className="flex-row items-end">
            {uploads.enabled ? (
              <ComposerAttachmentButton
                size={chrome.controlSize}
                disabled={disabled || busy}
                supportsImages={
                  capabilities?.attachments?.images === true &&
                  uploads.imageCount < (capabilities.attachments.maxImages ?? Infinity)
                }
                supportsFiles={capabilities?.attachments?.files === true}
                onPickMedia={() => uploads.pick("media")}
                onPickFiles={() => uploads.pick("files")}
              />
            ) : (
              <View style={{ width: EDITOR_LEADING_INSET - 8 }} />
            )}
            <Animated.View
              className="min-w-0 flex-1"
              onLayout={compactEditor.onEditorLayout}
              style={[
                { minWidth: compactEditor.isExpanded ? 0 : INLINE_EDITOR_MIN_WIDTH },
                compactEditor.containerStyle,
                compactEditor.isExpanded ? { flex: 0, width: 0 } : undefined,
              ]}
            />
            <Animated.View style={compactEditor.editorStyle}>
              <ComposerEditor
                ref={editorRef}
                multiline
                value={draft}
                readOnly={disabled || (busy && hasAttachments)}
                selection={selection}
                onChangeText={(text) => {
                  chat.setDraft(text);
                  setSlashDismissed(false);
                }}
                onSelectionChange={setSelection}
                placeholder={gt("Message {name}", { name: props.bot.name })}
                onFocus={() => {
                  setFocused(true);
                  props.onFocusChange(true);
                }}
                onBlur={() => {
                  setFocused(false);
                  props.onFocusChange(false);
                }}
                onSubmit={() => {
                  const first =
                    slashQuery !== null
                      ? selectPaSlashCommands(slashCommands, slashQuery, "common")[0]
                      : undefined;
                  if (first && !isCompletePaSlashCommand(draft, slashCommands))
                    completeCommand(first);
                  else void send();
                }}
                submitTitle={sendMode === "queue" ? gt("Queue") : gt("Send")}
                {...compactEditor.editorProps}
                textStyle={textStyle}
              />
            </Animated.View>
            <View
              className="min-w-0 shrink flex-row items-center"
              style={compactEditor.isExpanded ? { flex: 1, justifyContent: "flex-end" } : undefined}
            >
              {!hasAttachments && slashCommands.length > 0 ? (
                <ComposerActionButton
                  size={chrome.controlSize}
                  accessibilityLabel={gt("Commands and skills")}
                  icon="slash.circle"
                  disabled={disabled}
                  onPress={toggleSlash}
                />
              ) : null}
              {props.canSelectModel && capabilities?.models.supported ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={gt("Model and reasoning")}
                  onPress={props.onOpenModel}
                  className="h-[44px] max-w-[120px] flex-row items-center gap-1 px-1.5 active:opacity-70"
                >
                  <SymbolView name="brain" size={14} tintColorClassName="accent-icon-muted" />
                  {props.modelLabel ? (
                    <Text
                      className="min-w-0 shrink text-xs text-foreground-muted"
                      numberOfLines={1}
                    >
                      {props.modelLabel}
                    </Text>
                  ) : null}
                </Pressable>
              ) : null}
              {view.running && !isClientCommand && canInterrupt ? (
                <ComposerActionButton
                  size={chrome.controlSize}
                  accessibilityLabel={gt("Stop generating")}
                  icon="stop.fill"
                  variant={showStopOnly ? "danger" : undefined}
                  disabled={disabled}
                  onPress={() => void chat.interrupt()}
                />
              ) : null}
              {canSteer && hasDraft ? (
                <ComposerActionButton
                  size={chrome.controlSize}
                  accessibilityLabel={gt("Steer the current turn")}
                  icon="arrow.turn.left.up"
                  disabled={!canSend}
                  onPress={() => {
                    setSlashDismissed(false);
                    void chat.steer();
                  }}
                />
              ) : null}
              {showStopOnly ? null : (
                <ComposerActionButton
                  size={chrome.controlSize}
                  accessibilityLabel={sendMode === "queue" ? gt("Queue message") : gt("Send")}
                  icon={sendMode === "queue" ? "tray.and.arrow.down" : "arrow.up"}
                  variant="primary"
                  disabled={!canSend}
                  onPress={() => void send()}
                />
              )}
            </View>
          </View>
        </ComposerSurface>
      </View>
    </Animated.View>
  );
}
