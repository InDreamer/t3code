import { T, useGT } from "gt-react";
import {
  ArrowUpIcon,
  CircleAlertIcon,
  CornerUpRightIcon,
  ListPlusIcon,
  Loader2Icon,
  ShieldAlertIcon,
  SquareIcon,
  SquareSlashIcon,
  TerminalIcon,
  XIcon,
} from "lucide-react";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { useSoftwareKeyboardOpen } from "../../hooks/useSoftwareKeyboardOpen";
import { cn } from "../../lib/utils";
import { ComposerSurface } from "../chat/ComposerSurface";
import {
  ComposerAttachInput,
  ComposerAttachButton,
  ComposerAttachmentMediaRow,
  ComposerAttachmentFileList,
  ComposerFilePreviewDialog,
} from "../chat/ComposerAttachmentStrip";
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
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { CheckboxMark } from "../ui/checkbox";
import { Input } from "../ui/input";
import {
  countPaSlashTabs,
  isCompletePaSlashCommand,
  parsePaClientSlashAction,
  selectPaSlashCommands,
  type PaSlashTab,
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
import { resolvePaComposerSendMode } from "./PaComposer.logic";
import { PaModelPicker } from "./PaModelPicker";
import { PaSecretRequestForm, type PaSecretAnswer } from "./PaSecretRequestForm";

export type PaClarifyAnswers = Readonly<Record<string, PaClarifyAnswer>>;

/** Safari ends an IME composition before its keydown; keyCode 229 still marks that Enter. */
function isImeKeyDown(event: React.KeyboardEvent): boolean {
  return event.nativeEvent.isComposing || event.keyCode === 229;
}

function PaPendingRequestBanner({
  req,
  responding,
  clarifyAnswerMap,
  onClarifyAnswerChange,
  onRespond,
}: {
  readonly req: PaPendingRequest;
  readonly responding: boolean;
  readonly clarifyAnswerMap: PaClarifyAnswers;
  readonly onClarifyAnswerChange: (questionId: string, value: PaClarifyAnswer) => void;
  readonly onRespond: (decision?: string) => void;
}) {
  const gt = useGT();

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
                        onRespond();
                      }
                    }}
                  />
                )}
              </div>
            );
          })}
          <div className="flex justify-end">
            <Button type="button" size="xs" disabled={responding} onClick={() => onRespond()}>
              <T>Submit answer</T>
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function PaComposer({
  environmentId,
  bot,
  capabilities,
  sessionId,
  draft,
  onDraftChange,
  running,
  sending,
  disabled,
  slashCommands,
  openRequests,
  respondingIds,
  clarifyAnswers,
  onClarifyAnswerChange,
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
}: {
  readonly environmentId: EnvironmentId | null;
  readonly bot: PaBotSummary;
  readonly capabilities: PaCapabilities | null;
  readonly sessionId: string | null;
  readonly draft: string;
  readonly onDraftChange: (value: string) => void;
  readonly running: boolean;
  readonly sending: boolean;
  readonly disabled: boolean;
  readonly slashCommands: ReadonlyArray<PaSlashCommand>;
  readonly openRequests: ReadonlyArray<PaPendingRequest>;
  readonly respondingIds: ReadonlySet<string>;
  readonly clarifyAnswers: Readonly<Record<string, PaClarifyAnswers>>;
  readonly onClarifyAnswerChange: (
    requestId: string,
    questionId: string,
    value: PaClarifyAnswer,
  ) => void;
  readonly onRespondRequest: (req: PaPendingRequest, decision?: string) => void;
  /** Resolves `true` once the engine took the answer; typed values never leave the form until then. */
  readonly onRespondSecret: (req: PaPendingRequest, answer: PaSecretAnswer) => Promise<boolean>;
  /** `queued`: the draft waits behind the running turn. */
  readonly onSend: (options: {
    readonly queued: boolean;
    readonly attachments: ReadonlyArray<PaAttachment>;
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
  readonly onModelChanged: () => void;
}) {
  const gt = useGT();
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const picker = useRef<HTMLInputElement | null>(null);
  const uploads = usePaAttachments(environmentId, capabilities?.attachments);
  const canManageProviders = useEnvironmentScope(environmentId, AuthProvidersManageScope);
  const canAttach = uploads.enabled && !disabled && !sending;
  const hasAttachments = uploads.items.length > 0;
  const [expandedImage, setExpandedImage] = useState<ExpandedImagePreview | null>(null);
  const [previewFileId, setPreviewFileId] = useState<string | null>(null);
  const previewFile = uploads.files.find((item) => item.id === previewFileId);
  const { resolvedTheme } = useTheme();
  const maxFileBytes = capabilities?.attachments?.maxFileBytes ?? PROVIDER_SEND_TURN_MAX_FILE_BYTES;
  const [slashIndex, setSlashIndex] = useState(0);
  const [slashDismissed, setSlashDismissed] = useState(false);
  const [slashTab, setSlashTab] = useState<PaSlashTab>("common");
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
  }, [draft]);

  const slashQuery =
    !hasAttachments && !slashDismissed && draft.startsWith("/") && !/\s/.test(draft)
      ? draft.slice(1)
      : null;
  const tabCounts = countPaSlashTabs(slashCommands);
  const effectiveSlashTab: PaSlashTab =
    slashTab === "skills" && tabCounts.skills === 0 ? "common" : slashTab;
  const matchingCommands =
    slashQuery === null ? [] : selectPaSlashCommands(slashCommands, slashQuery, effectiveSlashTab);
  const showSlashMenu =
    slashQuery !== null &&
    (matchingCommands.length > 0 || (slashQuery === "" && slashCommands.length > 0));
  const clampedSlashIndex =
    matchingCommands.length === 0 ? 0 : Math.min(slashIndex, matchingCommands.length - 1);
  // Client commands (/stop, /new, /model) run at once; plain text queues behind a running turn.
  const isClientCommand =
    !hasAttachments && parsePaClientSlashAction(draft, slashCommands) !== null;
  const sendMode = resolvePaComposerSendMode({
    running,
    draft,
    isClientCommand,
    hasOpenRequests: openRequests.length > 0,
    canQueue: capabilities?.execution.queue === true,
    hasAttachments,
    attachmentsBlocked: uploads.blocked,
  });
  const hasDraft = draft.trim().length > 0 || hasAttachments;
  const canSend = sendMode !== "blocked" && !disabled && !sending && hasDraft;
  const canInterrupt = capabilities?.execution.interrupt !== false;
  const canSteer =
    !hasAttachments && sendMode === "queue" && capabilities?.execution.steer === true;
  // While a turn runs with nothing to send, the primary slot is the stop button.
  const showStopOnly =
    running && !isClientCommand && canInterrupt && (!hasDraft || sendMode === "blocked");
  const send = () => {
    setSlashDismissed(false);
    if (!canSend) return;
    const finish = uploads.handoff();
    void onSend({ queued: sendMode === "queue", attachments: uploads.ready }).then(
      (accepted) => finish(Boolean(accepted)),
      () => finish(false),
    );
  };

  const completeCommand = (command: PaSlashCommand) => {
    onDraftChange(`${command.name} `);
    setSlashIndex(0);
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
        completeCommand(picked);
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
        completeCommand(picked);
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

  const toggleSlashMenu = () => {
    if (showSlashMenu) {
      setSlashDismissed(true);
      if (draft === "/") onDraftChange("");
      return;
    }
    setSlashDismissed(false);
    setSlashIndex(0);
    setSlashTab("common");
    if (!draft.startsWith("/")) onDraftChange(draft ? `/${draft}` : "/");
    textareaRef.current?.focus();
  };

  const slashTabs: ReadonlyArray<{ readonly id: PaSlashTab; readonly label: string }> = [
    { id: "common", label: gt("Favorites") },
    { id: "commands", label: gt("All commands ({count})", { count: tabCounts.commands }) },
    ...(tabCounts.skills > 0
      ? [{ id: "skills" as const, label: gt("Skills ({count})", { count: tabCounts.skills }) }]
      : []),
  ];

  return (
    <div className="pointer-events-auto relative mx-auto w-full min-w-0 max-w-(--chat-content-max-width)">
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
                clarifyAnswerMap={clarifyAnswers[req.requestId] ?? {}}
                onClarifyAnswerChange={(qId, val) => onClarifyAnswerChange(req.requestId, qId, val)}
                onRespond={(decision) => onRespondRequest(req, decision)}
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

      {showSlashMenu ? (
        <div
          className={cn(
            "mb-2 flex min-w-0 flex-col rounded-2xl border border-border/80 bg-popover/95 p-1.5 shadow-lg backdrop-blur-md",
            keyboardOpen ? "max-h-[min(14rem,28svh)]" : "max-h-[min(18rem,45dvh)]",
          )}
        >
          {slashQuery === "" ? (
            <div className="mb-1 flex shrink-0 items-center justify-between gap-2 border-b border-border/50 px-1 pb-1.5">
              <div className="flex min-w-0 items-center gap-1 overflow-x-auto">
                {slashTabs.map((tab) => {
                  const active = effectiveSlashTab === tab.id;
                  return (
                    <button
                      key={tab.id}
                      type="button"
                      aria-pressed={active}
                      // Keep textarea focus (and mobile keyboard) while switching tabs.
                      onPointerDown={(e) => e.preventDefault()}
                      onClick={() => {
                        setSlashTab(tab.id);
                        setSlashIndex(0);
                      }}
                      className={cn(
                        "shrink-0 rounded-md px-2 py-1 text-2xs font-medium transition-colors pointer-coarse:py-1.5",
                        active
                          ? "bg-accent text-accent-foreground"
                          : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                      )}
                    >
                      {tab.label}
                    </button>
                  );
                })}
              </div>
              <span className="hidden shrink-0 pr-1 text-2xs text-muted-foreground sm:inline">
                <T>Filter by keyword</T>
              </span>
            </div>
          ) : (
            <div className="flex shrink-0 items-center gap-1.5 px-2.5 py-1 text-2xs font-medium text-muted-foreground">
              <SquareSlashIcon className="size-3 shrink-0" />
              <span className="min-w-0 truncate">
                {gt("{count} matches · Tab to complete, Enter to send", {
                  count: matchingCommands.length,
                })}
              </span>
            </div>
          )}
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
            {matchingCommands.map((cmd, idx) => (
              <button
                key={cmd.name}
                ref={
                  idx === clampedSlashIndex
                    ? (el) => el?.scrollIntoView({ block: "nearest" })
                    : undefined
                }
                type="button"
                // Keep textarea focus (and the mobile keyboard) while picking.
                onPointerDown={(e) => e.preventDefault()}
                onClick={() => completeCommand(cmd)}
                className={cn(
                  "flex w-full min-w-0 items-center justify-between gap-3 rounded-lg px-2.5 py-1.5 text-left text-xs transition-colors pointer-coarse:py-2.5",
                  idx === clampedSlashIndex
                    ? "bg-accent text-accent-foreground"
                    : "hover:bg-muted/60",
                )}
              >
                <span className="flex min-w-0 shrink-0 items-center gap-1.5">
                  <span className="font-mono font-medium">{cmd.name}</span>
                  {cmd.group === "skill" ? (
                    <Badge variant="secondary" size="sm" className="shrink-0">
                      <T>Skill</T>
                    </Badge>
                  ) : cmd.group === "plugin" ? (
                    <Badge variant="outline" size="sm" className="shrink-0">
                      <T>Plugin</T>
                    </Badge>
                  ) : null}
                </span>
                <span className="min-w-0 truncate text-2xs text-muted-foreground">
                  {cmd.description}
                </span>
              </button>
            ))}
          </div>
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
            <ComposerSurface.Main>
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
                  value={draft}
                  readOnly={sending && hasAttachments}
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
                  placeholder={gt("Message {name}, or type / for commands…", { name: bot.name })}
                  // iOS zooms into any field under 16px on focus, and Appearance can shrink 1rem below it.
                  className="block max-h-44 min-h-6 w-full min-w-0 resize-none bg-transparent text-sm leading-6 text-foreground outline-none placeholder:text-muted-foreground/80 pointer-coarse:text-(length:--font-size-prompt-touch)"
                />
              </div>

              <div className="flex min-w-0 items-center justify-between gap-2 px-2 pb-2">
                <div className="flex shrink-0 items-center gap-1">
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
                  {!hasAttachments && slashCommands.length > 0 ? (
                    <Button
                      type="button"
                      size="icon-xs"
                      variant={showSlashMenu ? "secondary" : "ghost-muted"}
                      aria-label={gt("Commands and skills")}
                      aria-expanded={showSlashMenu}
                      onPointerDown={(e) => e.preventDefault()}
                      onClick={toggleSlashMenu}
                    >
                      <SquareSlashIcon className="size-4" />
                    </Button>
                  ) : null}
                </div>

                <div className="flex min-w-0 flex-1 items-center justify-end gap-1.5 overflow-hidden">
                  {capabilities?.models.supported ? (
                    <PaModelPicker
                      bot={bot}
                      sessionId={sessionId}
                      open={modelPickerOpen}
                      onOpenChange={onModelPickerOpenChange}
                      query={modelQuery}
                      onQueryChange={onModelQueryChange}
                      liveReasoningEffort={liveReasoningEffort}
                      refreshVersion={modelRefreshVersion}
                      onReasoningChanged={onReasoningChanged}
                      onModelChanged={onModelChanged}
                    />
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
