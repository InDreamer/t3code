import { T, useGT } from "gt-react";
import {
  ArrowUpIcon,
  CircleAlertIcon,
  CornerUpRightIcon,
  ListPlusIcon,
  Loader2Icon,
  ShieldAlertIcon,
  SquareIcon,
  TerminalIcon,
  XIcon,
} from "lucide-react";
import { useId, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";

import { useSoftwareKeyboardOpen } from "../../hooks/useSoftwareKeyboardOpen";
import { cn } from "../../lib/utils";
import { ComposerSurface } from "../chat/ComposerSurface";
import { DeferredComposerCommandMenuLayer } from "../chat/ComposerCommandMenuLayer";
import { composerSuggestionOptionId } from "../chat/ComposerCommandMenu";
import {
  ComposerAttachInput,
  ComposerAttachButton,
  ComposerAttachmentMediaRow,
  ComposerAttachmentFileList,
  ComposerFilePreviewDialog,
} from "../chat/ComposerAttachmentStrip";
import { ComposerSpeechButton, ComposerSpeechRecordingPill } from "../chat/ComposerSpeechButton";
import { ExpandedImageDialog } from "../chat/ExpandedImageDialog";
import type { ExpandedImagePreview } from "../chat/ExpandedImagePreview";
import { AuthProvidersManageScope } from "@t3tools/contracts";
import { useEnvironmentScope } from "../../state/session";
import {
  clipboardHtmlImageContent,
  shouldHandleComposerAttachmentPaste,
} from "../chat/composerAttachmentFiles";
import { useTheme } from "../../hooks/useTheme";
import { usePaAttachments } from "./usePaAttachments";
import { MessageCopyButton } from "../chat/MessageCopyButton";
import { Button } from "../ui/button";
import { CheckboxMark } from "../ui/checkbox";
import { Input } from "../ui/input";
import {
  isCompletePaSlashCommand,
  parsePaClientSlashAction,
  rankPaSlashCommands,
} from "@t3tools/client-runtime/pa/slash";
import type {
  EnvironmentId,
  PaAttachment,
  PaBotSummary,
  PaCapabilities,
  PaClarifyAnswer,
  PaPendingRequest,
  PaSlashCommand,
} from "@t3tools/contracts";
import { PROVIDER_SEND_TURN_MAX_FILE_BYTES } from "@t3tools/contracts";
import { resolvePaComposerSendMode } from "@t3tools/client-runtime/pa/composer";
import { PaModelPicker } from "./PaModelPicker";
import { PaSlashCommandMenu } from "./PaSlashCommandMenu";
import { PaSecretRequestForm, type PaSecretAnswer } from "./PaSecretRequestForm";
import { VoiceInputSetup } from "../chat/VoiceInputSetup";
import { useDictationSubmissionShortcut } from "../../speech/useDictationSubmissionShortcut";
import { SpeechTextField, type TextFieldSpeech } from "../../speech/useTextFieldSpeech";

export type PaClarifyAnswers = Readonly<Record<string, PaClarifyAnswer>>;

/** Safari ends an IME composition before its keydown; keyCode 229 still marks that Enter. */
function isImeKeyDown(event: React.KeyboardEvent): boolean {
  return event.nativeEvent.isComposing || event.keyCode === 229;
}

function PaPendingRequestBanner({
  req,
  responding,
  onRespond,
}: {
  readonly req: PaPendingRequest;
  readonly responding: boolean;
  readonly onRespond: (decision?: string, answers?: PaClarifyAnswers) => void;
}) {
  const gt = useGT();
  const [clarifyAnswerMap, setAnswers] = useState<PaClarifyAnswers>({});
  const onClarifyAnswerChange = (questionId: string, value: PaClarifyAnswer) =>
    setAnswers((previous) => ({ ...previous, [questionId]: value }));

  return (
    <div className="mb-2 space-y-2.5 rounded-2xl border border-border/80 bg-card/95 p-3.5 shadow-sm backdrop-blur-md">
      <div className="flex items-center gap-2 text-sm font-medium text-foreground">
        {req.kind === "approval" ? (
          <TerminalIcon className="size-4 shrink-0 text-warning" />
        ) : (
          <ShieldAlertIcon className="size-4 shrink-0 text-info" />
        )}
        <span>
          {req.title ||
            (req.kind === "approval"
              ? gt("Approval required")
              : gt("The bot needs more information"))}
        </span>
      </div>

      {req.detail ? (
        <p className="whitespace-pre-wrap break-words text-xs leading-relaxed text-muted-foreground">
          {req.detail}
        </p>
      ) : null}

      {req.command ? (
        <div className="relative rounded-lg border border-border/60 bg-muted/40 px-3 py-2">
          <div className="flex items-start justify-between gap-2">
            <pre className="max-h-36 flex-1 overflow-auto whitespace-pre-wrap break-words font-mono text-xs leading-5 text-foreground select-text">
              {req.command}
            </pre>
            <MessageCopyButton text={req.command} label={gt("Copy command")} variant="ghost" />
          </div>
        </div>
      ) : null}

      {req.kind === "approval" ? (
        <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
          {(req.options ?? []).map((opt, idx) => (
            <Button
              key={opt.id}
              type="button"
              size="xs"
              variant={opt.intent === "deny" ? "outline" : idx === 0 ? "default" : "secondary"}
              disabled={responding}
              onClick={() => onRespond(opt.id)}
            >
              {opt.label}
            </Button>
          ))}
        </div>
      ) : req.questions && req.questions.length > 0 ? (
        <div className="space-y-3">
          {req.questions.map((question) => {
            const answer = clarifyAnswerMap[question.id];
            const currentVal = typeof answer === "string" ? answer : "";
            const selected = Array.isArray(answer) ? answer : [];
            const isPicked = (opt: string) =>
              question.multiSelect ? selected.includes(opt) : currentVal === opt;
            const pick = (opt: string): PaClarifyAnswer =>
              question.multiSelect
                ? selected.includes(opt)
                  ? selected.filter((item) => item !== opt)
                  : [...selected, opt]
                : opt;

            return (
              <div key={question.id} className="space-y-1.5">
                <div className="text-xs font-medium text-foreground">{question.prompt}</div>
                {question.options && question.options.length > 0 ? (
                  <div className="grid gap-1.5 sm:grid-cols-2">
                    {question.options.map((opt, optIdx) => {
                      const picked = isPicked(opt);
                      return (
                        <button
                          key={opt}
                          type="button"
                          disabled={responding}
                          aria-pressed={picked}
                          onClick={() => onClarifyAnswerChange(question.id, pick(opt))}
                          className={cn(
                            "flex items-center gap-2 rounded-xl border px-3 py-2 text-left text-xs transition-colors",
                            picked
                              ? "border-primary bg-primary/10 text-foreground"
                              : "border-border/70 bg-background/60 text-foreground/85 hover:bg-muted/60",
                          )}
                        >
                          {question.multiSelect ? (
                            <CheckboxMark checked={picked} />
                          ) : (
                            <span
                              className={cn(
                                "flex size-4.5 shrink-0 items-center justify-center rounded-md border font-mono text-2xs",
                                picked
                                  ? "border-primary bg-primary text-primary-foreground"
                                  : "border-border/80 text-muted-foreground",
                              )}
                            >
                              {optIdx + 1}
                            </span>
                          )}
                          <span className="min-w-0 flex-1 break-words">{opt}</span>
                        </button>
                      );
                    })}
                  </div>
                ) : null}
                {question.multiSelect ? null : (
                  <Input
                    placeholder={gt("Enter your reply…")}
                    disabled={responding}
                    value={currentVal}
                    onChange={(e) => onClarifyAnswerChange(question.id, e.target.value)}
                    onKeyDown={(e) => {
                      // With several questions, Enter on one must not submit the others blank.
                      if (
                        e.key === "Enter" &&
                        !isImeKeyDown(e) &&
                        !responding &&
                        req.questions?.length === 1
                      ) {
                        e.preventDefault();
                        onRespond(undefined, clarifyAnswerMap);
                      }
                    }}
                  />
                )}
              </div>
            );
          })}
          <div className="flex justify-end">
            <Button
              type="button"
              size="xs"
              disabled={responding}
              onClick={() => onRespond(undefined, clarifyAnswerMap)}
            >
              <T>Submit answer</T>
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

type PaComposerProps = {
  readonly environmentId: EnvironmentId | null;
  readonly bot: PaBotSummary;
  readonly capabilities: PaCapabilities | null;
  readonly sessionId: string | null;
  readonly sessionModel: string | null;
  readonly draft: string;
  /** Any session in the pane holds unsent text that navigating away from Bots would discard. */
  readonly hasPaneDraft?: boolean | undefined;
  readonly onDraftChange: (value: string) => void;
  readonly running: boolean;
  readonly sending: boolean;
  readonly disabled: boolean;
  readonly slashCommands: ReadonlyArray<PaSlashCommand>;
  readonly openRequests: ReadonlyArray<PaPendingRequest>;
  readonly respondingIds: ReadonlySet<string>;
  readonly canSelectModel: boolean;
  readonly onRespondRequest: (
    req: PaPendingRequest,
    decision?: string,
    answers?: PaClarifyAnswers,
  ) => void;
  /** Resolves `true` once the engine took the answer; typed values never leave the form until then. */
  readonly onRespondSecret: (req: PaPendingRequest, answer: PaSecretAnswer) => Promise<boolean>;
  /** `queued`: the draft waits behind the running turn. */
  readonly onSend: (options: {
    readonly queued: boolean;
    readonly attachments: ReadonlyArray<PaAttachment>;
    /** The draft as dictation just finished it, newer than the `draft` this render saw. */
    readonly textOverride?: string | undefined;
  }) => Promise<boolean | undefined>;
  /** Hands the draft to the running turn. */
  readonly onSteer: () => void;
  readonly onInterrupt: () => void;
  /** Session status (todos, queue) shown above the composer, in its lane. */
  readonly statusSlot?: ReactNode;
  readonly error: string | null;
  readonly onDismissError: () => void;
  readonly modelPickerOpen: boolean;
  readonly onModelPickerOpenChange: (open: boolean) => void;
  readonly modelQuery: string;
  readonly onModelQueryChange: (value: string) => void;
  readonly liveReasoningEffort?: string | null | undefined;
  readonly modelRefreshVersion?: number | undefined;
  readonly onReasoningChanged?: ((effort: string) => void) | undefined;
  readonly onModelChanged: (model: string, sessionId: string | null) => void;
};

export function PaComposer(props: PaComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const { environmentId, sessionId } = props;
  const uploads = usePaAttachments(environmentId, props.capabilities?.attachments);
  const hasUnsentContent =
    props.hasPaneDraft === true || props.draft.trim().length > 0 || uploads.items.length > 0;
  // The pane keys this composer by environment and session, so this branch never flips in place.
  if (!environmentId || !sessionId) {
    return (
      <PaComposerView
        {...props}
        textareaRef={textareaRef}
        uploads={uploads}
        allowVoiceSettingsNavigation={!hasUnsentContent}
        speech={null}
      />
    );
  }
  return (
    <SpeechTextField
      environmentId={environmentId}
      ownerKey={JSON.stringify(["pa", environmentId, props.bot.botId, sessionId])}
      label={props.bot.name}
      text={props.draft}
      textareaRef={textareaRef}
      onTextChange={props.onDraftChange}
      disabled={props.disabled || props.sending}
      modelPickerOpen={props.modelPickerOpen}
      // Navigating to Voice settings unmounts the Bots route; only offer it when nothing would be lost.
      offerSetup={!hasUnsentContent}
    >
      {(speech) => (
        <PaComposerView
          {...props}
          textareaRef={textareaRef}
          uploads={uploads}
          allowVoiceSettingsNavigation={!hasUnsentContent}
          speech={speech}
        />
      )}
    </SpeechTextField>
  );
}

function PaComposerView({
  environmentId,
  bot,
  capabilities,
  sessionId,
  sessionModel,
  draft,
  onDraftChange,
  running,
  sending,
  disabled,
  slashCommands,
  openRequests,
  respondingIds,
  canSelectModel,
  onRespondRequest,
  onRespondSecret,
  onSend,
  onSteer,
  onInterrupt,
  statusSlot,
  error,
  onDismissError,
  modelPickerOpen,
  onModelPickerOpenChange,
  modelQuery,
  onModelQueryChange,
  liveReasoningEffort,
  modelRefreshVersion,
  onReasoningChanged,
  onModelChanged,
  textareaRef,
  uploads,
  allowVoiceSettingsNavigation,
  speech,
}: PaComposerProps & {
  readonly textareaRef: RefObject<HTMLTextAreaElement | null>;
  readonly uploads: ReturnType<typeof usePaAttachments>;
  readonly allowVoiceSettingsNavigation: boolean;
  /** Null until the composer has an environment and a session to dictate into. */
  readonly speech: TextFieldSpeech | null;
}) {
  const gt = useGT();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const picker = useRef<HTMLInputElement | null>(null);
  const canManageProviders = useEnvironmentScope(environmentId, AuthProvidersManageScope);
  const voiceInputActive = speech?.blocksSubmission === true;
  const voicePreparing = speech?.preparing === true;
  const freezesEditor = speech?.freezesEditor === true;
  // Phones give the dictation capsule the footer row beside the primary actions.
  const dictating = speech !== null && speech.state.phase !== "idle";
  const dictationDisabled = disabled || sending;
  const canAttach = uploads.enabled && !disabled && !sending && !freezesEditor;
  const hasAttachments = uploads.items.length > 0;
  const [expandedImage, setExpandedImage] = useState<ExpandedImagePreview | null>(null);
  const [previewFileId, setPreviewFileId] = useState<string | null>(null);
  const previewFile = uploads.files.find((item) => item.id === previewFileId);
  const { resolvedTheme } = useTheme();
  const maxFileBytes = capabilities?.attachments?.maxFileBytes ?? PROVIDER_SEND_TURN_MAX_FILE_BYTES;
  const [slashIndex, setSlashIndex] = useState(0);
  const [slashDismissed, setSlashDismissed] = useState(false);
  const [menuAnchor, setMenuAnchor] = useState<HTMLDivElement | null>(null);
  const slashListId = useId();
  const keyboardOpen = useSoftwareKeyboardOpen();

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- resizes the textarea DOM height to match multiline draft content
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    if (draft.length === 0) {
      el.style.height = "auto";
      return;
    }
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  }, [draft, textareaRef]);

  const slashQuery =
    !hasAttachments &&
    !freezesEditor &&
    !slashDismissed &&
    draft.startsWith("/") &&
    !/\s/.test(draft)
      ? draft.slice(1)
      : null;
  const availableCommands = canSelectModel
    ? slashCommands
    : slashCommands.filter((command) => command.handling !== "client:model-picker");
  const matchingCommands =
    slashQuery === null ? [] : rankPaSlashCommands(availableCommands, slashQuery);
  const showSlashMenu = matchingCommands.length > 0;
  const clampedSlashIndex =
    matchingCommands.length === 0 ? 0 : Math.min(slashIndex, matchingCommands.length - 1);
  const resolveSend = (text: string) => {
    // Client commands (/stop, /new, /model) run at once; plain text queues behind a running turn.
    const isClientCommand =
      !hasAttachments && parsePaClientSlashAction(text, slashCommands) !== null;
    const sendMode = resolvePaComposerSendMode({
      running,
      draft: text,
      isClientCommand,
      hasOpenRequests: openRequests.length > 0,
      canQueue: capabilities?.execution.queue === true,
      hasAttachments,
      attachmentsBlocked: uploads.blocked,
    });
    return { isClientCommand, sendMode, canSend: sendMode !== "blocked" && !disabled && !sending };
  };
  const { isClientCommand, sendMode, canSend: canSendDraft } = resolveSend(draft);
  const hasDraft = draft.trim().length > 0 || hasAttachments;
  // The transcript is not in the draft yet, so dictation defers the real check to its final text.
  const canSend = voiceInputActive
    ? !voicePreparing && !dictationDisabled && !uploads.blocked
    : canSendDraft;
  const canInterrupt = capabilities?.execution.interrupt !== false;
  const canSteer =
    !hasAttachments &&
    !voiceInputActive &&
    sendMode === "queue" &&
    capabilities?.execution.steer === true;
  // While a turn runs with nothing to send, the primary slot is the stop button.
  const showStopOnly =
    running &&
    !isClientCommand &&
    canInterrupt &&
    !voiceInputActive &&
    (!hasDraft || sendMode === "blocked");
  const sendText = (text: string, textOverride?: string) => {
    const resolved = resolveSend(text);
    if (!resolved.canSend) return;
    const finish = uploads.handoff();
    void onSend({
      queued: resolved.sendMode === "queue",
      attachments: uploads.ready,
      textOverride,
    }).then(
      (accepted) => finish(Boolean(accepted)),
      () => finish(false),
    );
  };
  const sendAfterDictationRef = useRef<(text: string) => void>(() => {});
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- publishes the committed send to the asynchronous dictation completion, and drops it on unmount
  useLayoutEffect(() => {
    sendAfterDictationRef.current = (text) => sendText(text, text);
    return () => {
      sendAfterDictationRef.current = () => {};
    };
  });
  const send = () => {
    setSlashDismissed(false);
    if (!canSend) return;
    if (voiceInputActive) {
      speech?.submitAfterDictation((finalText) => sendAfterDictationRef.current(finalText));
      return;
    }
    sendText(draft);
  };
  useDictationSubmissionShortcut({
    enabled: voiceInputActive && !voicePreparing,
    formRef: rootRef,
    onKeyDown: (event) => {
      if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
      if (keyboardOpen && !event.metaKey && !event.ctrlKey) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      send();
    },
  });

  const pickCommand = (command: PaSlashCommand) => {
    setSlashIndex(0);
    // Opening the picker has no side effect, so it runs on pick; every other command only completes.
    if (
      command.handling === "client:model-picker" &&
      canSelectModel &&
      capabilities?.models.supported
    ) {
      onDraftChange("");
      onModelQueryChange("");
      onModelPickerOpenChange(true);
      return;
    }
    onDraftChange(`${command.name} `);
    textareaRef.current?.focus();
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (isImeKeyDown(event)) return;
    if (matchingCommands.length > 0) {
      if (event.key === "Escape") {
        event.preventDefault();
        setSlashDismissed(true);
        return;
      }
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setSlashIndex((clampedSlashIndex + 1) % matchingCommands.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setSlashIndex((clampedSlashIndex - 1 + matchingCommands.length) % matchingCommands.length);
        return;
      }
      const picked = matchingCommands[clampedSlashIndex];
      if (event.key === "Tab" && picked) {
        event.preventDefault();
        pickCommand(picked);
        return;
      }
      // Enter on a typed full command runs it; on a partial token it completes the highlighted one.
      if (
        event.key === "Enter" &&
        !event.shiftKey &&
        picked &&
        !isCompletePaSlashCommand(draft, slashCommands)
      ) {
        event.preventDefault();
        pickCommand(picked);
        return;
      }
    }

    // A soft keyboard has no Shift+Enter, so there Return types a newline and the button sends.
    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      (!keyboardOpen || event.metaKey || event.ctrlKey)
    ) {
      event.preventDefault();
      if (canSend) send();
    }
  };

  return (
    <div
      ref={rootRef}
      className="pointer-events-auto relative mx-auto w-full min-w-0 max-w-(--chat-content-max-width)"
    >
      {statusSlot}
      {openRequests.length > 0 ? (
        <div
          className={cn(
            "mb-2 min-w-0 overflow-y-auto overscroll-contain [&>*:last-child]:mb-0",
            // iOS overlays the keyboard on the layout viewport, so viewport units ignore it.
            keyboardOpen ? "max-h-[min(14rem,28svh)]" : "max-h-[min(22rem,50dvh)]",
          )}
        >
          {openRequests.map((req) =>
            req.kind === "secret" ? (
              disabled || !canManageProviders ? (
                <p
                  key={req.requestId}
                  className="mb-2 rounded-xl bg-card p-3 text-sm"
                  role="status"
                >
                  <T>
                    You need permission to operate this chat and manage providers to answer this
                    credential request.
                  </T>
                </p>
              ) : (
                <PaSecretRequestForm
                  key={req.requestId}
                  req={req}
                  responding={disabled || respondingIds.has(req.requestId)}
                  onAnswer={(answer) => onRespondSecret(req, answer)}
                />
              )
            ) : (
              <PaPendingRequestBanner
                key={req.requestId}
                req={req}
                responding={disabled || respondingIds.has(req.requestId)}
                onRespond={(decision, answers) => onRespondRequest(req, decision, answers)}
              />
            ),
          )}
        </div>
      ) : null}

      {error || uploads.error ? (
        <div
          role="alert"
          className="mb-2 flex min-w-0 items-start gap-2 rounded-xl border border-destructive/30 bg-card/95 px-3 py-2.5 text-xs text-destructive shadow-sm backdrop-blur-md"
        >
          <CircleAlertIcon className="mt-0.5 size-4 shrink-0" />
          <span className="min-w-0 flex-1 break-words leading-relaxed">
            {error ?? uploads.error}
          </span>
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            aria-label={gt("Dismiss error")}
            onClick={() => {
              uploads.dismissError();
              onDismissError();
            }}
          >
            <XIcon className="size-3.5" />
          </Button>
        </div>
      ) : null}

      {expandedImage ? (
        <ExpandedImageDialog preview={expandedImage} onClose={() => setExpandedImage(null)} />
      ) : null}
      {previewFile ? (
        <ComposerFilePreviewDialog
          file={previewFile}
          onRemove={uploads.remove}
          onPreviewFileIdChange={setPreviewFileId}
        />
      ) : null}
      <div
        onDragOver={(event) => {
          if (event.dataTransfer.types.includes("Files")) event.preventDefault();
        }}
        onDrop={(event) => {
          if (!event.dataTransfer.files.length) return;
          event.preventDefault();
          if (canAttach) void uploads.add(Array.from(event.dataTransfer.files));
        }}
      >
        <ComposerSurface.Shell>
          <ComposerSurface.Host>
            <ComposerSurface.Main ref={setMenuAnchor}>
              <DeferredComposerCommandMenuLayer open={showSlashMenu} anchor={menuAnchor}>
                <PaSlashCommandMenu
                  listId={slashListId}
                  commands={matchingCommands}
                  activeName={matchingCommands[clampedSlashIndex]?.name ?? null}
                  onHighlight={(name) => {
                    const index = matchingCommands.findIndex((command) => command.name === name);
                    if (index >= 0) setSlashIndex(index);
                  }}
                  onSelect={pickCommand}
                />
              </DeferredComposerCommandMenuLayer>
              <div className="px-3.5 pt-3 pb-1.5">
                {environmentId && hasAttachments ? (
                  <div inert={sending}>
                    {uploads.images.length || uploads.preparing.length ? (
                      <ComposerAttachmentMediaRow
                        images={uploads.images}
                        expandedImages={uploads.images}
                        preparingImages={uploads.preparing}
                        videos={[]}
                        pendingSnapShotAnimations={[]}
                        pendingSnapShotIds={[]}
                        uncommittedSnapShotIds={[]}
                        nonPersistedImageIds={[]}
                        snapShotAnimations={false}
                        supportsAttachmentUploads
                        maxFileAttachmentBytes={maxFileBytes}
                        environmentId={environmentId}
                        canOperateThread={canAttach}
                        onExpandImage={setExpandedImage}
                        onCopySnapshot={async () => {}}
                        onFileOpen={() => {}}
                        onRemoveImage={uploads.remove}
                        onRemoveFile={uploads.remove}
                      />
                    ) : null}
                    {uploads.files.length ? (
                      <ComposerAttachmentFileList
                        files={uploads.files}
                        resolvedTheme={resolvedTheme}
                        supportsAttachmentUploads
                        maxFileAttachmentBytes={maxFileBytes}
                        fileStagingLimit={maxFileBytes}
                        environmentId={environmentId}
                        canOperateThread={canAttach}
                        onPreviewFile={setPreviewFileId}
                        onRemoveFile={uploads.remove}
                      />
                    ) : null}
                  </div>
                ) : null}
                <textarea
                  ref={textareaRef}
                  rows={1}
                  role={showSlashMenu ? "combobox" : undefined}
                  aria-controls={showSlashMenu ? slashListId : undefined}
                  aria-expanded={showSlashMenu ? true : undefined}
                  aria-activedescendant={
                    showSlashMenu
                      ? composerSuggestionOptionId(
                          slashListId,
                          matchingCommands[clampedSlashIndex]!.name,
                        )
                      : undefined
                  }
                  value={draft}
                  readOnly={(sending && hasAttachments) || freezesEditor}
                  onPaste={(event) => {
                    if (!canAttach) return;
                    const files = Array.from(event.clipboardData.files);
                    if (!files.length) return;
                    const plainText = event.clipboardData.getData("text/plain");
                    if (
                      !shouldHandleComposerAttachmentPaste({
                        files,
                        plainText,
                        htmlIsOnlyImage:
                          clipboardHtmlImageContent(event.clipboardData.getData("text/html")) ===
                          "only-image",
                      })
                    )
                      return;
                    event.preventDefault();
                    void uploads.add(files);
                  }}
                  onChange={(e) => {
                    onDraftChange(e.target.value);
                    setSlashIndex(0);
                    setSlashDismissed(false);
                  }}
                  onKeyDown={handleKeyDown}
                  placeholder={
                    availableCommands.length > 0
                      ? gt("Message {name}, or type / for commands…", { name: bot.name })
                      : gt("Message {name}", { name: bot.name })
                  }
                  // iOS zooms into any field under 16px on focus, and Appearance can shrink 1rem below it.
                  className="block max-h-44 min-h-6 w-full min-w-0 resize-none bg-transparent text-sm leading-6 text-foreground outline-none placeholder:text-muted-foreground/80 pointer-coarse:text-(length:--font-size-prompt-touch)"
                />
              </div>

              {speech?.preview ? (
                // column-reverse pins the scroll to the bottom; the single inner div keeps the text in normal order.
                <div
                  role="status"
                  aria-label={gt("Live transcription")}
                  className="mx-3 mb-3 flex max-h-32 flex-col-reverse overflow-y-auto rounded-lg border border-border/60 bg-muted/30 px-3 py-2 text-sm leading-relaxed break-words whitespace-pre-wrap sm:mx-4"
                >
                  <div>
                    <span>{speech.preview.committed}</span>
                    <span className="text-muted-foreground">{speech.preview.tentative}</span>
                  </div>
                </div>
              ) : null}

              <div className="flex min-w-0 items-center justify-between gap-2 px-2 pb-2">
                <div
                  className={cn("flex shrink-0 items-center gap-1", dictating && "max-sm:hidden")}
                >
                  {canAttach ? (
                    <>
                      <ComposerAttachInput
                        ref={picker}
                        addComposerAttachments={uploads.add}
                        focusComposer={() => textareaRef.current?.focus()}
                      />
                      <ComposerAttachButton onOpenPicker={() => picker.current?.click()} />
                    </>
                  ) : null}
                </div>

                <div className="flex min-w-0 flex-1 items-center justify-end gap-1.5 overflow-hidden">
                  {canSelectModel && capabilities?.models.supported ? (
                    <div className={cn("contents", dictating && "max-sm:hidden")}>
                      <PaModelPicker
                        environmentId={environmentId}
                        bot={bot}
                        sessionId={sessionId}
                        modelScope={capabilities.models.scope}
                        sessionModel={sessionModel}
                        open={modelPickerOpen}
                        onOpenChange={onModelPickerOpenChange}
                        query={modelQuery}
                        onQueryChange={onModelQueryChange}
                        liveReasoningEffort={liveReasoningEffort}
                        refreshVersion={modelRefreshVersion}
                        onReasoningChanged={onReasoningChanged}
                        onModelChanged={onModelChanged}
                      />
                    </div>
                  ) : null}

                  {speech ? (
                    <>
                      {speech.available ? (
                        <>
                          <ComposerSpeechRecordingPill
                            state={speech.state}
                            progress={null}
                            finishShortcutLabel={speech.shortcutLabel}
                            cancelShortcutLabel="Esc"
                            level={speech.level}
                            recordingStartedAt={speech.recordingStartedAt}
                            disabled={dictationDisabled}
                            onStart={() => void speech.start()}
                            onStop={() => void speech.stop()}
                            onCancel={speech.cancel}
                            onSkipPostProcessing={speech.skipPostProcessing}
                          />
                          <ComposerSpeechButton
                            state={speech.state}
                            shortcutLabel={speech.shortcutLabel}
                            disabled={dictationDisabled}
                            onStart={() => void speech.start()}
                          />
                        </>
                      ) : null}
                      <VoiceInputSetup
                        environmentId={speech.transcriptionEnvironmentId}
                        open={speech.setup.open}
                        step={speech.setup.step}
                        status={speech.status}
                        model={speech.setup.model}
                        language={speech.setup.language}
                        downloading={speech.setup.downloading}
                        error={speech.setup.error}
                        onOpenChange={speech.setup.setOpen}
                        onRetryCatalog={speech.setup.retryCatalog}
                        onDownload={() => void speech.setup.download()}
                        onCancelDownload={() => void speech.setup.cancelDownload()}
                        onStartRecording={() => void speech.setup.startRecording()}
                        allowSettingsNavigation={allowVoiceSettingsNavigation}
                      />
                    </>
                  ) : null}

                  <div className="flex shrink-0 items-center gap-1">
                    {running && !isClientCommand && canInterrupt ? (
                      <Button
                        type="button"
                        size="icon-sm-pill"
                        variant={showStopOnly ? "destructive" : "ghost-destructive"}
                        disabled={disabled}
                        aria-label={gt("Stop generating")}
                        onClick={onInterrupt}
                      >
                        <SquareIcon className="size-3 fill-current" />
                      </Button>
                    ) : null}
                    {canSteer && hasDraft ? (
                      <Button
                        type="button"
                        size="icon-sm-pill"
                        variant="secondary"
                        aria-label={gt("Steer the current turn")}
                        title={gt("Steer the current turn")}
                        disabled={!canSend}
                        onPointerDown={(e) => e.preventDefault()}
                        onClick={() => {
                          setSlashDismissed(false);
                          onSteer();
                        }}
                      >
                        <CornerUpRightIcon className="size-4" />
                      </Button>
                    ) : null}
                    {showStopOnly ? null : (
                      <Button
                        type="button"
                        size="icon-sm-pill"
                        aria-label={sendMode === "queue" ? gt("Queue message") : gt("Send")}
                        title={sendMode === "queue" ? gt("Send after the current turn") : undefined}
                        disabled={!canSend}
                        // Keeps the mobile keyboard up between sends.
                        onPointerDown={(e) => e.preventDefault()}
                        onClick={send}
                      >
                        {sending ? (
                          <Loader2Icon className="size-4 animate-spin" />
                        ) : sendMode === "queue" ? (
                          <ListPlusIcon className="size-4" />
                        ) : (
                          <ArrowUpIcon className="size-4 stroke-2" />
                        )}
                      </Button>
                    )}
                  </div>
                </div>
              </div>
            </ComposerSurface.Main>
          </ComposerSurface.Host>
        </ComposerSurface.Shell>
      </div>
    </div>
  );
}
