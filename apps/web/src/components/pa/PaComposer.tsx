import { T, useGT } from "gt-react";
import {
  ArrowUpIcon,
  CircleAlertIcon,
  Loader2Icon,
  ShieldAlertIcon,
  SquareIcon,
  SquareSlashIcon,
  TerminalIcon,
  XIcon,
} from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";

import { cn } from "../../lib/utils";
import { ComposerSurface } from "../chat/ComposerSurface";
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
  PaBotSummary,
  PaCapabilities,
  PaClarifyAnswer,
  PaPendingRequest,
  PaSlashCommand,
} from "@t3tools/contracts";
import { PaModelPicker } from "./PaModelPicker";

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
          {req.title || (req.kind === "approval" ? gt("需要确认执行") : gt("Bot 需要你补充信息"))}
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
            <MessageCopyButton text={req.command} label={gt("复制命令")} variant="ghost" />
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
                    placeholder={gt("输入你的回复...")}
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
              <T>提交回答</T>
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function PaComposer({
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
  onSend,
  onInterrupt,
  error,
  onDismissError,
  modelPickerOpen,
  onModelPickerOpenChange,
  modelQuery,
  onModelQueryChange,
  onModelChanged,
}: {
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
  readonly onSend: () => void;
  readonly onInterrupt: () => void;
  readonly error: string | null;
  readonly onDismissError: () => void;
  readonly modelPickerOpen: boolean;
  readonly onModelPickerOpenChange: (open: boolean) => void;
  readonly modelQuery: string;
  readonly onModelQueryChange: (value: string) => void;
  readonly onModelChanged: () => void;
}) {
  const gt = useGT();
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [slashIndex, setSlashIndex] = useState(0);
  const [slashDismissed, setSlashDismissed] = useState(false);
  const [slashTab, setSlashTab] = useState<PaSlashTab>("common");

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
    !slashDismissed && draft.startsWith("/") && !/\s/.test(draft) ? draft.slice(1) : null;
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
  // Client commands (/stop, /new, /model) run while a turn streams; messages wait for it.
  const isClientCommand = parsePaClientSlashAction(draft, slashCommands) !== null;
  const canSend = (!running || isClientCommand) && !disabled && !sending && draft.trim().length > 0;
  const canInterrupt = capabilities?.execution.interrupt !== false;

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

    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      if (canSend) {
        setSlashDismissed(false);
        onSend();
      }
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
    { id: "common", label: gt("常用") },
    { id: "commands", label: gt("全部命令 ({count})", { count: tabCounts.commands }) },
    ...(tabCounts.skills > 0
      ? [{ id: "skills" as const, label: gt("技能 ({count})", { count: tabCounts.skills }) }]
      : []),
  ];

  return (
    <div className="pointer-events-auto relative mx-auto w-full min-w-0 max-w-(--chat-content-max-width)">
      {openRequests.length > 0 ? (
        <div className="mb-2 max-h-[min(22rem,50dvh)] min-w-0 overflow-y-auto overscroll-contain [&>*:last-child]:mb-0">
          {openRequests.map((req) => (
            <PaPendingRequestBanner
              key={req.requestId}
              req={req}
              responding={respondingIds.has(req.requestId)}
              clarifyAnswerMap={clarifyAnswers[req.requestId] ?? {}}
              onClarifyAnswerChange={(qId, val) => onClarifyAnswerChange(req.requestId, qId, val)}
              onRespond={(decision) => onRespondRequest(req, decision)}
            />
          ))}
        </div>
      ) : null}

      {error ? (
        <div
          role="alert"
          className="mb-2 flex min-w-0 items-start gap-2 rounded-xl border border-destructive/30 bg-card/95 px-3 py-2.5 text-xs text-destructive shadow-sm backdrop-blur-md"
        >
          <CircleAlertIcon className="mt-0.5 size-4 shrink-0" />
          <span className="min-w-0 flex-1 break-words leading-relaxed">{error}</span>
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            aria-label={gt("关闭错误提示")}
            onClick={onDismissError}
          >
            <XIcon className="size-3.5" />
          </Button>
        </div>
      ) : null}

      {showSlashMenu ? (
        <div className="mb-2 flex max-h-[min(18rem,45dvh)] min-w-0 flex-col rounded-2xl border border-border/80 bg-popover/95 p-1.5 shadow-lg backdrop-blur-md">
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
                        "shrink-0 rounded-md px-2 py-1 text-2xs font-medium transition-colors",
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
                <T>输入关键词筛选</T>
              </span>
            </div>
          ) : (
            <div className="flex shrink-0 items-center gap-1.5 px-2.5 py-1 text-2xs font-medium text-muted-foreground">
              <SquareSlashIcon className="size-3 shrink-0" />
              <span className="min-w-0 truncate">
                {gt("匹配 {count} 项 · Tab 补全，回车发送", {
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
                  "flex w-full min-w-0 items-center justify-between gap-3 rounded-lg px-2.5 py-1.5 text-left text-xs transition-colors",
                  idx === clampedSlashIndex
                    ? "bg-accent text-accent-foreground"
                    : "hover:bg-muted/60",
                )}
              >
                <span className="flex min-w-0 shrink-0 items-center gap-1.5">
                  <span className="font-mono font-medium">{cmd.name}</span>
                  {cmd.group === "skill" ? (
                    <Badge variant="secondary" size="sm" className="shrink-0">
                      <T>技能</T>
                    </Badge>
                  ) : cmd.group === "plugin" ? (
                    <Badge variant="outline" size="sm" className="shrink-0">
                      <T>插件</T>
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

      <ComposerSurface.Shell>
        <ComposerSurface.Host>
          <ComposerSurface.Main>
            <div className="px-3.5 pt-3 pb-1.5">
              <textarea
                ref={textareaRef}
                rows={1}
                value={draft}
                onChange={(e) => {
                  onDraftChange(e.target.value);
                  setSlashIndex(0);
                  setSlashDismissed(false);
                }}
                onKeyDown={handleKeyDown}
                enterKeyHint="send"
                placeholder={gt("发消息给 {name}，或输入 / 执行命令...", { name: bot.name })}
                className="block max-h-44 min-h-6 w-full min-w-0 resize-none bg-transparent text-sm leading-6 text-foreground outline-none placeholder:text-muted-foreground/80"
              />
            </div>

            <div className="flex min-w-0 items-center justify-between gap-2 px-2 pb-2">
              <div className="flex shrink-0 items-center gap-1">
                {slashCommands.length > 0 ? (
                  <Button
                    type="button"
                    size="icon-xs"
                    variant={showSlashMenu ? "secondary" : "ghost-muted"}
                    aria-label={gt("命令与技能")}
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
                    onModelChanged={onModelChanged}
                  />
                ) : null}

                <div className="shrink-0">
                  {running && !isClientCommand && canInterrupt ? (
                    <Button
                      type="button"
                      size="icon-sm-pill"
                      variant="destructive"
                      aria-label={gt("停止生成")}
                      onClick={onInterrupt}
                    >
                      <SquareIcon className="size-3 fill-current" />
                    </Button>
                  ) : (
                    <Button
                      type="button"
                      size="icon-sm-pill"
                      aria-label={gt("发送")}
                      disabled={!canSend}
                      // Keeps the mobile keyboard up between sends.
                      onPointerDown={(e) => e.preventDefault()}
                      onClick={() => {
                        setSlashDismissed(false);
                        onSend();
                      }}
                    >
                      {sending ? (
                        <Loader2Icon className="size-4 animate-spin" />
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
  );
}
