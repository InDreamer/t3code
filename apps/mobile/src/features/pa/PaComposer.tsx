import { useAtomValue } from "@effect/atom-react";
import { resolvePaComposerSendMode } from "@t3tools/client-runtime/pa/composer";
import { voiceInputBlocksSubmission } from "@t3tools/client-runtime/voice-input";
import {
  isCompletePaSlashCommand,
  parsePaClientSlashAction,
  rankPaSlashCommands,
} from "@t3tools/client-runtime/pa/slash";
import {
  AuthProvidersManageScope,
  EnvironmentId,
  type PaBotSummary,
  type PaCapabilities,
  type PaSlashCommand,
} from "@t3tools/contracts";
import { useGT } from "gt-react-native";
import { useLayoutEffect, useRef, useState } from "react";
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
import {
  ComposerActionButton,
  ComposerInlineControl,
  ComposerToolbarRow,
} from "../../components/ComposerToolbar";
import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { FilePreviewModal, type FilePreviewSource } from "../../components/ui/FilePreviewModal";
import { useMountedRef } from "../../lib/useMountedRef";
import { useEnvironmentScope } from "../../state/session";
import { useComposerTextRole } from "../settings/appearance/useScaledTextRole";
import { ComposerAttachmentButton } from "../threads/ComposerAttachmentButton";
import { ComposerPopoverAnchor } from "../threads/ComposerPopoverAnchor";
import {
  ComposerDictationCancelAction,
  ComposerDictationDraftContent,
  ComposerDictationError,
  ComposerDictationPrimaryAction,
  ComposerDictationStartAction,
  ComposerDictationStatus,
  ComposerDictationToolbar,
} from "../voice-input/ComposerDictationControl";
import { useVoiceInputController } from "../voice-input/useVoiceInputController";
import { voiceInputAtom } from "../voice-input/VoiceInputProvider";
import { resolveVoiceComposerPresentation } from "../voice-input/voiceInputPresentation";
import { paBotChatView, type PaBotChat, type PaBotChatState } from "./paBotChat";
import { PaPendingRequestCard, PaSecretRequestCard, PaSecretRequestDenied } from "./PaRequestCards";
import { PaContextUsageStrip, PaQueueStrip, PaTodoProgress } from "./PaSessionStatus";
import { PaSlashCommandPopover } from "./PaSlashCommandPopover";
import { usePaAttachments } from "./usePaAttachments";

const EDITOR_LEADING_INSET = 14;

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
  readonly reasoningLabel: string | null;
  readonly bottomInset: number;
  readonly contentMaxWidth?: number;
  readonly onOpenModel: () => void;
  readonly onHeightChange: (height: number) => void;
  readonly onFocusChange: (focused: boolean) => void;
  /** True while the page stays mounted out of sight, so it does not claim the microphone. */
  readonly hidden: boolean;
}) {
  const gt = useGT();
  const { chat, view, capabilities } = props;
  const editorRef = useRef<ComposerEditorHandle>(null);
  const inFlight = useRef(false);
  const mounted = useMountedRef();
  const [preview, setPreview] = useState<FilePreviewSource | null>(null);
  const [selection, setSelection] = useState<ComposerEditorSelection>({ start: 0, end: 0 });
  const [focused, setFocused] = useState(false);
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
  // A recording belongs to the session it started in, even after the page shows another one.
  const voiceSessionId = view.sessionId;
  const ownerKey = voiceSessionId
    ? JSON.stringify(["pa", props.environmentId, props.bot.botId, voiceSessionId])
    : null;
  const { session: recording } = useAtomValue(voiceInputAtom);
  const startableOwner = disabled || busy || props.hidden ? null : ownerKey;
  const startableOwnerRef = useRef(startableOwner);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- native input may finish flushing after the owner or its permission changes
  useLayoutEffect(() => {
    startableOwnerRef.current = startableOwner;
  }, [startableOwner]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the global recorder outlives a hidden or unmounted Bot chat that owns its draft
  useLayoutEffect(() => {
    if (props.hidden && voiceInputBlocksSubmission(recording.controller.currentState)) {
      recording.cancel(ownerKey);
    }
    return () => {
      if (voiceInputBlocksSubmission(recording.controller.currentState)) recording.cancel(ownerKey);
    };
  }, [recording, ownerKey, props.hidden]);
  const voiceInput = useVoiceInputController({
    ownerKey,
    label: props.bot.name,
    readDraftMessage: () =>
      voiceSessionId === null || chat.isDisposed() ? null : chat.getDraftFor(voiceSessionId),
    selection,
    disabled: disabled || busy || props.hidden,
    hidden: props.hidden,
    onChangeDraftMessage: (text) => {
      if (voiceSessionId !== null) chat.setDraftForSession(voiceSessionId, text);
    },
    onChangeSelection: setSelection,
  });
  const startDictation = async () => {
    await editorRef.current?.flushPendingInput();
    if (
      !mounted.current ||
      ownerKey !== startableOwnerRef.current ||
      !voiceSessionId ||
      chat.isDisposed() ||
      chat.getState().activeSessionId !== voiceSessionId
    )
      return;
    voiceInput.start();
  };
  const voicePresentation = resolveVoiceComposerPresentation(
    voiceInput.state,
    voiceInput.elapsedSeconds,
  );
  const isVoiceInputPresented = voicePresentation.statusKind === "active";
  const locked = voiceInput.blocksSubmission || voiceInput.freezesEditor;
  const hasAttachments = uploads.items.length > 0;
  const commands = capabilities?.commands.supported === false ? [] : props.slashCommands;
  const slashCommands = commands.filter(
    (command) => props.canSelectModel || command.handling !== "client:model-picker",
  );
  const slashQuery =
    focused && !hasAttachments && !locked && draft.startsWith("/") && !/\s/.test(draft)
      ? draft.slice(1)
      : null;
  const matchingCommands =
    slashQuery === null ? [] : rankPaSlashCommands(slashCommands, slashQuery);
  const clientAction = hasAttachments ? null : parsePaClientSlashAction(draft, commands);
  const isClientCommand = clientAction !== null;
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
  const canSend =
    sendMode !== "blocked" &&
    !disabled &&
    !busy &&
    !locked &&
    hasDraft &&
    (props.canSelectModel || clientAction?.kind !== "model-picker");
  const canInterrupt = capabilities?.execution.interrupt !== false;
  const canSteer =
    !hasAttachments && sendMode === "queue" && capabilities?.execution.steer === true;
  // While a turn runs with nothing to send, the primary slot is the stop button.
  const showStopOnly =
    view.running && !isClientCommand && canInterrupt && (!hasDraft || sendMode === "blocked");

  const sendToSession = async (sessionId: string, steer: boolean) => {
    const current = () =>
      mounted.current && !chat.isDisposed() && chat.getState().activeSessionId === sessionId;
    await editorRef.current?.flushPendingInput();
    if (!current()) return;
    const text = chat.getState().drafts[sessionId] ?? "";
    const action = parsePaClientSlashAction(text, commands);
    if (!hasAttachments && action?.kind === "model-picker" && !props.canSelectModel) return;
    if (steer) {
      props.onSend();
      await chat.steer();
      return;
    }
    const attachments = await uploads.upload(chat.failedAttachmentKey(sessionId, text));
    if (!current() || attachments === null) return;
    const live = paBotChatView(chat.getState());
    const mode = resolvePaComposerSendMode({
      running: live.running,
      draft: text,
      isClientCommand: !attachments.length && action !== null,
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
  const send = (steer = false) => {
    if (!view.sessionId || !canSend || inFlight.current) return;
    inFlight.current = true;
    return sendToSession(view.sessionId, steer).finally(() => {
      inFlight.current = false;
    });
  };
  const pickCommand = (command: PaSlashCommand) => {
    // Opening the picker has no side effect, so it runs on pick; every other command only completes.
    if (
      command.handling === "client:model-picker" &&
      props.canSelectModel &&
      capabilities?.models.supported
    ) {
      chat.setDraft("");
      props.onOpenModel();
      return;
    }
    const completion = `${command.name} `;
    chat.setDraft(completion);
    setSelection({ start: completion.length, end: completion.length });
    editorRef.current?.focus();
  };

  const error = liveTurn.error ?? uploads.error;
  const stopButton = (
    <ComposerActionButton
      size={chrome.controlSize}
      accessibilityLabel={gt("Stop generating")}
      icon="stop.fill"
      variant={showStopOnly ? "danger" : undefined}
      disabled={disabled}
      onPress={() => void chat.interrupt()}
    />
  );

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
        <View>
          {matchingCommands.length > 0 ? (
            <ComposerPopoverAnchor>
              <PaSlashCommandPopover commands={matchingCommands} onSelect={pickCommand} />
            </ComposerPopoverAnchor>
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
            <ComposerDictationError
              error={voiceInput.state.phase === "error" ? voiceInput.state.error : null}
              onDismiss={voiceInput.cancel}
            />
            {hasAttachments ? (
              <View className="px-2 pt-2">
                <ComposerAttachmentStrip
                  environmentId={EnvironmentId.make(props.environmentId)}
                  attachments={uploads.items}
                  removalDisabled={busy || locked}
                  onRemove={(id) => {
                    if (!inFlight.current && !locked) uploads.remove(id);
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
            <View onLayout={compactEditor.onRowLayout}>
              <ComposerDictationDraftContent
                className="flex-row items-end"
                compact
                hidden={isVoiceInputPresented}
              >
                {uploads.enabled ? (
                  <ComposerAttachmentButton
                    size={chrome.controlSize}
                    disabled={disabled || busy || locked}
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
                {/* TalkBack orders siblings by position; outside this row the editor reads after Send. */}
                <Animated.View
                  style={[
                    compactEditor.editorStyle,
                    // iOS destroys a view under display: none; the editor would lose its focus and caret.
                    Platform.OS === "android" && isVoiceInputPresented
                      ? { display: "none" }
                      : undefined,
                  ]}
                >
                  <ComposerEditor
                    ref={editorRef}
                    multiline
                    value={draft}
                    readOnly={disabled || (busy && hasAttachments) || locked}
                    selection={selection}
                    onChangeText={(text) => {
                      if (!locked && voiceSessionId !== null) {
                        chat.setDraftForSession(voiceSessionId, text);
                      }
                    }}
                    onSelectionChange={setSelection}
                    placeholder={
                      slashCommands.length > 0
                        ? gt("Message {name}, or type / for commands…", { name: props.bot.name })
                        : gt("Message {name}", { name: props.bot.name })
                    }
                    onFocus={() => {
                      setFocused(true);
                      props.onFocusChange(true);
                    }}
                    onBlur={() => {
                      setFocused(false);
                      props.onFocusChange(false);
                    }}
                    onSubmit={() => {
                      const first = matchingCommands[0];
                      if (first && !isCompletePaSlashCommand(draft, slashCommands))
                        pickCommand(first);
                      else void send();
                    }}
                    submitTitle={sendMode === "queue" ? gt("Queue") : gt("Send")}
                    {...compactEditor.editorProps}
                    textStyle={textStyle}
                  />
                </Animated.View>
                <View
                  className="min-w-0 shrink flex-row items-center"
                  style={
                    compactEditor.isExpanded ? { flex: 1, justifyContent: "flex-end" } : undefined
                  }
                >
                  {props.canSelectModel && capabilities?.models.supported ? (
                    <ComposerInlineControl
                      accessibilityLabel={[
                        gt("Model and reasoning"),
                        props.modelLabel,
                        props.reasoningLabel,
                      ]
                        .filter(Boolean)
                        .join(", ")}
                      icon="brain"
                      label={props.modelLabel ?? gt("Choose model")}
                      iconOnly={!compactEditor.isExpanded}
                      suffix={
                        props.reasoningLabel ? (
                          <Text className="text-xs text-foreground-muted" numberOfLines={1}>
                            {`· ${props.reasoningLabel}`}
                          </Text>
                        ) : undefined
                      }
                      maxWidth={200}
                      onPress={props.onOpenModel}
                    />
                  ) : null}
                  <ComposerDictationStartAction
                    size={chrome.controlSize}
                    state={voiceInput.state}
                    isAvailable={voiceInput.isAvailable}
                    disabled={disabled || busy || locked}
                    onStart={() => void startDictation()}
                    onCancel={voiceInput.cancel}
                  />
                  {view.running && !isClientCommand && canInterrupt ? stopButton : null}
                  {canSteer && hasDraft ? (
                    <ComposerActionButton
                      size={chrome.controlSize}
                      accessibilityLabel={gt("Steer the current turn")}
                      icon="arrow.turn.left.up"
                      disabled={!canSend}
                      onPress={() => void send(true)}
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
              </ComposerDictationDraftContent>
            </View>
            <Animated.View
              accessibilityElementsHidden={!isVoiceInputPresented}
              collapsable={false}
              importantForAccessibility={isVoiceInputPresented ? "auto" : "no-hide-descendants"}
              pointerEvents={isVoiceInputPresented ? "auto" : "none"}
              style={{ position: "absolute", bottom: chrome.paddingVertical, left: 0, right: 0 }}
            >
              <ComposerDictationToolbar
                showsDictation={isVoiceInputPresented}
                visible={isVoiceInputPresented}
              >
                <ComposerToolbarRow
                  paddingBottom={0}
                  paddingHorizontal={0}
                  paddingTop={0}
                  style={{ gap: 0 }}
                >
                  <ComposerDictationCancelAction
                    size={chrome.controlSize}
                    presentation={voicePresentation}
                    onCancel={voiceInput.cancel}
                  />
                  <ComposerDictationStatus
                    audioLevels={voiceInput.audioLevels}
                    elapsedSeconds={voiceInput.elapsedSeconds}
                    phase={voiceInput.state.phase}
                    presentation={voicePresentation}
                  />
                  <View className="shrink-0 flex-row items-center">
                    <ComposerDictationPrimaryAction
                      size={chrome.controlSize}
                      state={voiceInput.state}
                      presentation={voicePresentation}
                      isAvailable={voiceInput.isAvailable}
                      disabled={disabled || busy}
                      onStart={() => void startDictation()}
                      onConfirm={voiceInput.stop}
                      onCancel={voiceInput.cancel}
                    />
                    {view.running && !isClientCommand && canInterrupt ? stopButton : null}
                  </View>
                </ComposerToolbarRow>
              </ComposerDictationToolbar>
            </Animated.View>
          </ComposerSurface>
        </View>
      </View>
    </Animated.View>
  );
}
