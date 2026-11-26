import { liveThoughtLine } from "@t3tools/client-runtime/work-log/presentation";
import { shouldPreserveAssistantLineBreaks } from "@t3tools/shared/assistantInsights";
import { T, useGT, useMessages } from "gt-react";
import {
  BotIcon,
  BrainIcon,
  CalendarClockIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  Code2Icon,
  EyeIcon,
  GlobeIcon,
  ImageIcon,
  ListTodoIcon,
  MessageCircleIcon,
  Minimize2Icon,
  SearchIcon,
  SquarePenIcon,
  TerminalIcon,
  WrenchIcon,
  XIcon,
} from "lucide-react";
import { memo, useEffect, useState } from "react";

import { useClientSettings } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { observeVisibleAnimation } from "../../lib/visibleAnimation";
import type { MarkdownExtensions } from "../../markdown/wordsHast";
import { formatChatTimestampTooltip, formatDayAwareTimestamp } from "../../timestampFormat";
import ChatMarkdown from "../ChatMarkdown";
import { MessageCopyButton } from "../chat/MessageCopyButton";
import { ActivityShimmerOverlay, MESSAGE_HEADING_LEVEL } from "../chat/TimelineRowParts";
import { TimelineSystemDivider } from "../chat/TimelineSystemDivider";
import { failedToolIconClassName } from "../chat/TimelineToolActivityIcon";
import {
  THOUGHT_PREVIEW_SOURCE_MAX_LENGTH,
  thoughtPreviewMarkdown,
} from "../chat/TimelineWorkEntryRow.logic";
import { useTallEnoughToFold } from "../chat/useTallEnoughToFold";
import {
  WorkLogBlock,
  WorkLogButton,
  WorkLogDetails,
  WorkLogList,
  WorkLogRow,
} from "../chat/WorkLog";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  describePaToolAction,
  findPaLiveFinalTextIndex,
  formatPaDurationMs,
  formatPaElapsedSeconds,
  formatPaToolInspectorContent,
  summarizePaWorkGroup,
  type PaLiveTurnState,
  type PaToolAction,
  type PaWorkGroupSummary,
  type PaWorkStep,
} from "@t3tools/client-runtime/pa/timeline";
import type { PaMessage, PaToolCategory } from "@t3tools/contracts";

const USER_MESSAGE_MARKDOWN: MarkdownExtensions = { userMessage: true, leadingWhitespace: true };
const COLLAPSED_USER_MESSAGE_FADE_MASK =
  "linear-gradient(to bottom, black calc(100% - 1.75rem), transparent)";

const ACTIONS_REVEAL_CLASS_NAME =
  "flex items-center gap-2 text-xs tabular-nums opacity-0 transition-opacity duration-200 pointer-coarse:opacity-100 focus-within:opacity-100";

function PaTimestamp({
  timestamp,
  className,
}: {
  readonly timestamp: number | null;
  readonly className?: string;
}) {
  const m = useMessages();
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  if (!timestamp) return null;
  const iso = new Date(timestamp).toISOString();
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            className={cn(
              "whitespace-nowrap text-xs text-muted-foreground tabular-nums",
              className,
            )}
          />
        }
      >
        {formatDayAwareTimestamp(iso, timestampFormat, undefined, undefined, m)}
      </TooltipTrigger>
      <TooltipPopup>{formatChatTimestampTooltip(iso, timestampFormat, m)}</TooltipPopup>
    </Tooltip>
  );
}

type Translate = ReturnType<typeof useGT>;

/** The verb for what a tool step did, in the reader's language. */
export function formatPaToolVerb(gt: Translate, action: PaToolAction): string {
  const pick = (failed: string, active: string, done: string) =>
    action.phase === "failed" ? failed : action.phase === "active" ? active : done;
  switch (action.category) {
    case "terminal":
      return pick(gt("命令失败"), gt("正在运行"), gt("已运行"));
    case "file-read":
      return pick(gt("读取失败"), gt("正在读取"), gt("已读取"));
    case "file-edit":
      return pick(gt("编辑失败"), gt("正在编辑"), gt("已编辑"));
    case "web-search":
      return pick(gt("搜索失败"), gt("正在搜索"), gt("已搜索"));
    case "web-fetch":
      return pick(gt("抓取失败"), gt("正在读取网页"), gt("已读取网页"));
    case "search":
      return pick(gt("查找失败"), gt("正在查找"), gt("已查找"));
    case "memory":
      return pick(gt("检索失败"), gt("正在检索记忆"), gt("已检索记忆"));
    case "agent":
      return pick(gt("委派失败"), gt("正在委派子任务"), gt("已委派子任务"));
    case "todo":
      return pick(gt("更新任务失败"), gt("正在更新任务"), gt("已更新任务"));
    case "schedule":
      return pick(gt("定时任务操作失败"), gt("正在操作定时任务"), gt("已更新定时任务"));
    case "skill":
      return pick(gt("技能处理失败"), gt("正在处理技能"), gt("已处理技能"));
    case "code":
      return pick(gt("代码执行失败"), gt("正在执行代码"), gt("已执行代码"));
    case "vision":
      return pick(gt("图片分析失败"), gt("正在分析图片"), gt("已分析图片"));
    case "message":
      return pick(gt("发送失败"), gt("正在发送消息"), gt("已发送消息"));
    case "other":
      return action.phase === "failed"
        ? gt("{tool} 失败", { tool: action.toolName })
        : action.toolName;
  }
}

function formatPaWorkGroupLabel(gt: Translate, summary: PaWorkGroupSummary): string {
  switch (summary.kind) {
    case "reasoning":
      return gt("思考过程");
    case "tool": {
      const verb = formatPaToolVerb(gt, summary.action);
      const detail = summary.action.target ? `${verb} ${summary.action.target}` : verb;
      return summary.afterReasoning ? gt("已思考 · {detail}", { detail }) : detail;
    }
    case "tools":
      return summary.afterReasoning
        ? gt("已思考并调用 {count} 个工具", { count: summary.count })
        : gt("已调用 {count} 个工具", { count: summary.count });
  }
}

function PaToolIcon({
  kind,
  className,
}: {
  readonly kind: PaToolCategory | "reasoning";
  readonly className?: string;
}) {
  const cls = cn("block size-4 shrink-0 stroke-2", className);
  switch (kind) {
    case "reasoning":
      return <BrainIcon className={cls} aria-hidden />;
    case "terminal":
      return <TerminalIcon className={cls} aria-hidden />;
    case "file-read":
      return <EyeIcon className={cls} aria-hidden />;
    case "file-edit":
    case "skill":
      return <SquarePenIcon className={cls} aria-hidden />;
    case "search":
    case "memory":
      return <SearchIcon className={cls} aria-hidden />;
    case "web-search":
    case "web-fetch":
      return <GlobeIcon className={cls} aria-hidden />;
    case "agent":
      return <BotIcon className={cls} aria-hidden />;
    case "todo":
      return <ListTodoIcon className={cls} aria-hidden />;
    case "schedule":
      return <CalendarClockIcon className={cls} aria-hidden />;
    case "code":
      return <Code2Icon className={cls} aria-hidden />;
    case "vision":
      return <ImageIcon className={cls} aria-hidden />;
    case "message":
      return <MessageCircleIcon className={cls} aria-hidden />;
    case "other":
      return <WrenchIcon className={cls} aria-hidden />;
  }
}

function PaElapsedTimer({ startedAt }: { readonly startedAt: number }) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- drives the live 1s elapsed timer while a turn is actively running
  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  return <span className="tabular-nums">{formatPaElapsedSeconds(startedAt, nowMs)}</span>;
}

export const PaUserMessageRow = memo(function PaUserMessageRow({
  message,
}: {
  readonly message: PaMessage;
}) {
  const [expanded, setExpanded] = useState(false);
  const { ref: contentRef, tallEnough: canCollapse } = useTallEnoughToFold(
    message.text.trim().length > 0,
  );
  const isCollapsed = canCollapse && !expanded;

  return (
    <div className="group flex min-w-0 flex-col items-end gap-1 pb-4">
      <div
        className="relative min-w-0 max-w-[80%] rounded-2xl bg-message p-3 text-message-foreground"
        data-user-message-bubble=""
      >
        <div
          className={cn("relative", isCollapsed && "max-h-44 overflow-hidden")}
          style={
            isCollapsed
              ? {
                  WebkitMaskImage: COLLAPSED_USER_MESSAGE_FADE_MASK,
                  maskImage: COLLAPSED_USER_MESSAGE_FADE_MASK,
                }
              : undefined
          }
        >
          <div ref={contentRef}>
            <ChatMarkdown
              text={message.text}
              cwd={undefined}
              className="user-message-markdown text-message-foreground"
              lineBreaks
              parseRawHtml={false}
              extensions={USER_MESSAGE_MARKDOWN}
              headingLevelOffset={MESSAGE_HEADING_LEVEL}
            />
          </div>
        </div>
        {canCollapse ? (
          <div className="mt-1.5 flex items-center justify-end">
            <Button
              type="button"
              size="xs"
              variant="ghost-muted"
              aria-expanded={expanded}
              onClick={() => setExpanded((v) => !v)}
            >
              {expanded ? <T>收起</T> : <T>展开完整消息</T>}
            </Button>
          </div>
        ) : null}
      </div>

      <div
        className={cn(
          ACTIONS_REVEAL_CLASS_NAME,
          "w-full max-w-[80%] justify-end pe-1 group-hover:opacity-100",
        )}
      >
        <PaTimestamp timestamp={message.timestamp} />
        <MessageCopyButton text={message.text} variant="ghost" />
      </div>
    </div>
  );
});

export const PaAssistantMessageRow = memo(function PaAssistantMessageRow({
  text,
  timestamp,
  streaming = false,
  alwaysShowMeta = false,
  compactBottom = false,
  commentary = false,
}: {
  readonly text: string;
  readonly timestamp?: number | null;
  readonly streaming?: boolean;
  readonly alwaysShowMeta?: boolean;
  readonly compactBottom?: boolean;
  readonly commentary?: boolean;
}) {
  return (
    <div
      className={cn(
        "group/assistant relative min-w-0 px-1 py-0.5",
        compactBottom ? "pb-2" : "pb-4",
      )}
    >
      <ChatMarkdown
        text={text}
        renderInsights
        cwd={undefined}
        isStreaming={streaming}
        lineBreaks={shouldPreserveAssistantLineBreaks(text)}
        headingLevelOffset={MESSAGE_HEADING_LEVEL}
      />
      {!streaming && !commentary && text.trim().length > 0 ? (
        <div
          className={cn(
            "mt-1.5 flex items-center gap-2 text-xs tabular-nums transition-opacity duration-200",
            alwaysShowMeta
              ? "opacity-100"
              : "opacity-0 pointer-coarse:opacity-100 focus-within:opacity-100 group-hover/assistant:opacity-100",
          )}
        >
          <MessageCopyButton text={text} variant="ghost" />
          <PaTimestamp timestamp={timestamp ?? null} />
        </div>
      ) : null}
    </div>
  );
});

const PaWorkStepRow = memo(function PaWorkStepRow({
  step,
  defaultExpanded = false,
}: {
  readonly step: PaWorkStep;
  readonly defaultExpanded?: boolean;
}) {
  const gt = useGT();
  const [expanded, setExpanded] = useState(defaultExpanded);

  if (step.kind === "reasoning") {
    const active = step.streaming === true;
    const hasContent = step.text.trim().length > 0;
    const preview = hasContent
      ? step.text.slice(0, THOUGHT_PREVIEW_SOURCE_MAX_LENGTH)
      : gt("思考过程");

    return (
      <WorkLogRow
        onClick={hasContent ? () => setExpanded((v) => !v) : undefined}
        toggle={
          hasContent
            ? {
                role: "button",
                tabIndex: 0,
                "aria-expanded": expanded,
                onKeyDown: (e) => {
                  if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
                    e.preventDefault();
                    setExpanded((v) => !v);
                  }
                },
              }
            : undefined
        }
        icon={
          <span className="flex size-4 items-center justify-center text-icon-muted">
            <PaToolIcon kind="reasoning" className="opacity-70 light:brightness-60" />
          </span>
        }
        label={
          expanded ? (
            <span className="text-secondary-label">{active ? <T>思考中</T> : <T>思考过程</T>}</span>
          ) : (
            <span
              className={cn("block truncate text-secondary-label", active && "live-tool-shine")}
            >
              <ChatMarkdown
                inline
                text={preview}
                cwd={undefined}
                parseRawHtml={false}
                extensions={thoughtPreviewMarkdown(active ? gt("思考中") : gt("思考过程"))}
              />
            </span>
          )
        }
        trailing={
          hasContent ? (
            <span className="flex size-4 shrink-0 items-center justify-center" aria-hidden>
              <ChevronRightIcon
                className={cn(
                  "size-3 shrink-0 text-icon-muted opacity-70 transition-transform duration-200",
                  expanded && "rotate-90",
                )}
              />
            </span>
          ) : null
        }
      >
        {expanded && hasContent ? (
          <WorkLogDetails followLive={active}>
            <ChatMarkdown
              className="text-foreground/85"
              text={step.text}
              cwd={undefined}
              isStreaming={active}
              lineBreaks
              headingLevelOffset={MESSAGE_HEADING_LEVEL}
            />
          </WorkLogDetails>
        ) : null}
      </WorkLogRow>
    );
  }

  const action = describePaToolAction(step);
  const active = action.phase === "active";
  const failed = action.phase === "failed";
  const verb = formatPaToolVerb(gt, action);
  const target = action.target;
  const duration = formatPaDurationMs(step.durationMs);
  const inspector = formatPaToolInspectorContent(step);
  const canExpand = Boolean(inspector.command || inspector.argsJson || inspector.output);

  return (
    <WorkLogRow
      onClick={canExpand ? () => setExpanded((v) => !v) : undefined}
      toggle={
        canExpand
          ? {
              role: "button",
              tabIndex: 0,
              "aria-expanded": expanded,
              onKeyDown: (e) => {
                if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
                  e.preventDefault();
                  setExpanded((v) => !v);
                }
              },
            }
          : undefined
      }
      icon={
        <span
          className={cn(
            "flex size-4 items-center justify-center",
            failed ? failedToolIconClassName : "text-icon-muted",
          )}
        >
          <PaToolIcon
            kind={action.category}
            className={cn(!failed && "opacity-70 light:brightness-60")}
          />
        </span>
      }
      label={
        <span
          className={cn(
            "flex min-w-0 items-baseline gap-1.5 text-sm leading-relaxed",
            failed ? "text-destructive" : "text-secondary-label",
            active && "live-tool-shine",
          )}
        >
          <span className="shrink-0">{verb}</span>
          {target ? (
            <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">
              {target}
            </span>
          ) : null}
        </span>
      }
      trailing={
        <span className="flex shrink-0 items-center gap-1.5">
          {duration ? (
            <span className="text-xs text-muted-foreground/75 tabular-nums">{duration}</span>
          ) : null}
          {failed ? (
            <XIcon aria-hidden className={cn("size-3 shrink-0", failedToolIconClassName)} />
          ) : null}
          {canExpand ? (
            <span className="flex size-4 shrink-0 items-center justify-center" aria-hidden>
              <ChevronRightIcon
                className={cn(
                  "size-3 shrink-0 text-icon-muted opacity-70 transition-transform duration-200",
                  expanded && "rotate-90",
                )}
              />
            </span>
          ) : null}
        </span>
      }
    >
      {expanded && canExpand ? (
        <WorkLogDetails kind="panel">
          <div className="ms-7 space-y-2 rounded-lg border border-border/60 bg-muted/25 p-2.5">
            {inspector.command ? (
              <div className="space-y-1">
                <div className="flex items-center justify-between gap-2 text-2xs font-medium text-muted-foreground">
                  <span>
                    <T>命令</T>
                  </span>
                  <MessageCopyButton
                    text={inspector.command}
                    label={gt("复制命令")}
                    variant="ghost"
                  />
                </div>
                <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-foreground select-text">
                  {inspector.command}
                </pre>
              </div>
            ) : null}
            {inspector.argsJson ? (
              <div className="space-y-1">
                <div className="flex items-center justify-between gap-2 text-2xs font-medium text-muted-foreground">
                  <span>
                    <T>参数</T>
                  </span>
                  <MessageCopyButton
                    text={inspector.argsJson}
                    label={gt("复制参数")}
                    variant="ghost"
                  />
                </div>
                <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-2xs leading-relaxed text-muted-foreground select-text">
                  {inspector.argsJson}
                </pre>
              </div>
            ) : null}
            {inspector.output ? (
              <div className="space-y-1">
                <div className="flex items-center justify-between gap-2 text-2xs font-medium text-muted-foreground">
                  <span>
                    <T>输出</T>
                  </span>
                  <MessageCopyButton
                    text={inspector.output}
                    label={gt("复制输出")}
                    variant="ghost"
                  />
                </div>
                <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono text-2xs leading-relaxed text-secondary-label select-text">
                  {inspector.output}
                </pre>
              </div>
            ) : null}
          </div>
        </WorkLogDetails>
      ) : null}
    </WorkLogRow>
  );
});

export const PaWorkGroupRow = memo(function PaWorkGroupRow({
  steps,
  timestamp,
}: {
  readonly steps: ReadonlyArray<PaWorkStep>;
  readonly timestamp?: number | null;
}) {
  const gt = useGT();
  const [expanded, setExpanded] = useState(false);

  // A single reasoning-only block behaves like T3 Code's expandable Thought row directly.
  if (steps.length === 1 && steps[0]?.kind === "reasoning") {
    return (
      <WorkLogBlock>
        <PaWorkStepRow step={steps[0]} />
      </WorkLogBlock>
    );
  }

  const summary = summarizePaWorkGroup(steps);
  const summaryIcon =
    summary.kind === "reasoning"
      ? "reasoning"
      : summary.kind === "tool"
        ? summary.action.category
        : summary.lastCategory;
  return (
    <WorkLogBlock layout={expanded ? "group-header" : "standalone"}>
      <WorkLogButton
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
        icon={
          <span
            className={cn(
              "flex size-4 items-center justify-center",
              summary.hasFailure ? failedToolIconClassName : "text-icon-muted",
            )}
          >
            <PaToolIcon
              kind={summaryIcon}
              className={cn(!summary.hasFailure && "opacity-70 light:brightness-60")}
            />
          </span>
        }
        label={
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="truncate">{formatPaWorkGroupLabel(gt, summary)}</span>
            <ChevronRightIcon
              aria-hidden
              className={cn(
                "size-3 shrink-0 text-icon-muted opacity-70 transition-transform duration-200",
                expanded && "rotate-90",
              )}
            />
          </span>
        }
        trailing={
          <span className="pointer-events-none opacity-0 transition-opacity group-hover/timeline-row:pointer-events-auto group-hover/timeline-row:opacity-100">
            <PaTimestamp timestamp={timestamp ?? null} />
          </span>
        }
      />
      {expanded ? (
        <div className="mt-0.5 pb-1">
          <WorkLogList>
            {steps.map((step) => (
              <PaWorkStepRow key={step.id} step={step} />
            ))}
          </WorkLogList>
        </div>
      ) : null}
    </WorkLogBlock>
  );
});

function PaLiveShimmerActivityRow({
  iconKind,
  label,
  failed = false,
  active = true,
  shimmer = true,
}: {
  readonly iconKind: PaToolCategory | "reasoning";
  readonly label: React.ReactNode;
  readonly failed?: boolean;
  readonly active?: boolean;
  readonly shimmer?: boolean;
}) {
  const animated = active && !failed;
  const showShimmer = animated && shimmer;
  const content = (highlighted: boolean) => (
    <WorkLogRow
      icon={
        <span
          className={cn(
            "flex size-4 items-center justify-center",
            failed ? failedToolIconClassName : highlighted ? "text-foreground" : "text-icon-muted",
          )}
        >
          <PaToolIcon
            kind={iconKind}
            className={cn(!highlighted && !failed && "opacity-70 light:brightness-60")}
          />
        </span>
      }
      label={
        <span
          className={cn(
            "block truncate",
            highlighted && "text-foreground",
            animated && !shimmer && "live-tool-shine",
          )}
        >
          {label}
        </span>
      }
      trailing={
        failed ? (
          <XIcon aria-hidden className={cn("size-3 shrink-0", failedToolIconClassName)} />
        ) : null
      }
    />
  );

  return (
    <div
      ref={animated ? observeVisibleAnimation : undefined}
      className="relative min-h-6 w-fit max-w-full min-w-0 overflow-hidden rounded-md text-sm leading-relaxed"
    >
      {content(false)}
      {showShimmer ? <ActivityShimmerOverlay>{content(true)}</ActivityShimmerOverlay> : null}
    </div>
  );
}

function PaLiveWorkGroup({
  steps,
  statusText,
}: {
  readonly steps: ReadonlyArray<PaWorkStep>;
  readonly statusText: string | null;
}) {
  const gt = useGT();
  const [expanded, setExpanded] = useState(false);

  const activeTool = [...steps]
    .reverse()
    .find((s) => s.kind === "tool" && (s.toolStatus === "started" || s.toolStatus === "progress"));
  const lastStep = steps[steps.length - 1];
  const latestReasoning = [...steps].reverse().find((s) => s.kind === "reasoning");
  const focusStep = activeTool ?? lastStep;

  if (!focusStep) {
    return (
      <WorkLogBlock>
        <PaLiveShimmerActivityRow
          iconKind="reasoning"
          label={statusText || gt("思考中")}
          active
          shimmer
        />
      </WorkLogBlock>
    );
  }

  const thoughtLine =
    !expanded && latestReasoning?.text
      ? liveThoughtLine(latestReasoning.text.slice(0, THOUGHT_PREVIEW_SOURCE_MAX_LENGTH))
      : "";

  const toolAction = focusStep.kind === "tool" ? describePaToolAction(focusStep) : null;
  const focusActive = toolAction ? toolAction.phase === "active" : focusStep.streaming === true;
  const focusFailed = toolAction?.phase === "failed";
  const completedCount = steps.length > 1 ? steps.length - 1 : 0;

  return (
    <WorkLogBlock layout={expanded ? "group-header" : "standalone"}>
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
        className="group/live-work flex w-full max-w-full cursor-pointer flex-col items-start rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
      >
        {thoughtLine && !expanded ? (
          <WorkLogRow
            icon={
              <span className="flex size-4 items-center justify-center text-icon-muted">
                <PaToolIcon kind="reasoning" className="opacity-70 light:brightness-60" />
              </span>
            }
            label={
              <span className="line-clamp-3 text-secondary-label">
                <ChatMarkdown
                  inline
                  text={thoughtLine}
                  cwd={undefined}
                  parseRawHtml={false}
                  extensions={thoughtPreviewMarkdown(gt("思考中"))}
                />
              </span>
            }
            wrapLabel
          />
        ) : null}

        <div className="flex w-full min-w-0 items-center justify-between gap-2">
          <div className="min-w-0 flex-1">
            {toolAction ? (
              <PaLiveShimmerActivityRow
                iconKind={toolAction.category}
                failed={focusFailed}
                active={focusActive}
                shimmer={false}
                label={
                  <span className="inline-flex min-w-0 max-w-full items-baseline gap-1.5">
                    <span className="shrink-0">{formatPaToolVerb(gt, toolAction)}</span>
                    {toolAction.target ? (
                      <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">
                        {toolAction.target}
                      </span>
                    ) : null}
                  </span>
                }
              />
            ) : (
              <PaLiveShimmerActivityRow
                iconKind="reasoning"
                active
                shimmer
                label={statusText || gt("思考中")}
              />
            )}
          </div>
          <span className="flex shrink-0 items-center gap-1 pe-1 text-xs text-muted-foreground">
            {!expanded && completedCount > 0 ? (
              <span className="tabular-nums">+{completedCount}</span>
            ) : null}
            <ChevronDownIcon
              aria-hidden
              className={cn(
                "size-3.5 text-icon-muted transition-transform duration-200",
                !expanded && "-rotate-90",
              )}
            />
          </span>
        </div>
      </button>

      {expanded ? (
        <div className="mt-1 pb-1">
          <WorkLogList>
            {steps.map((step, idx) => (
              <PaWorkStepRow
                key={step.id}
                step={step}
                defaultExpanded={step.kind === "reasoning" && idx === steps.length - 1}
              />
            ))}
          </WorkLogList>
        </div>
      ) : null}
    </WorkLogBlock>
  );
}

export const PaLiveTurnView = memo(function PaLiveTurnView({
  liveTurn,
}: {
  readonly liveTurn: PaLiveTurnState;
}) {
  const gt = useGT();
  if (liveTurn.phase === "idle" && liveTurn.blocks.length === 0) return null;

  const isRunning = liveTurn.phase === "running";
  const lastBlockIndex = liveTurn.blocks.length - 1;
  const finalTextIndex = isRunning ? -1 : findPaLiveFinalTextIndex(liveTurn.blocks);

  return (
    <div className="flex min-w-0 flex-col">
      {isRunning ? (
        <div className="mb-2 border-b border-border/60 pb-2 pt-1">
          <div className="flex h-6 min-w-0 items-baseline gap-2 px-1 text-sm leading-relaxed text-muted-foreground tabular-nums">
            <span
              ref={observeVisibleAnimation}
              className="relative shrink-0 overflow-hidden whitespace-nowrap"
            >
              {liveTurn.startedAt ? (
                <>
                  <T>处理中</T> <PaElapsedTimer startedAt={liveTurn.startedAt} />
                </>
              ) : (
                <T>处理中...</T>
              )}
              <ActivityShimmerOverlay>
                {liveTurn.startedAt ? (
                  <>
                    <T>处理中</T> <PaElapsedTimer startedAt={liveTurn.startedAt} />
                  </>
                ) : (
                  <T>处理中...</T>
                )}
              </ActivityShimmerOverlay>
            </span>
            {liveTurn.statusText ? (
              <span className="min-w-0 truncate text-xs text-muted-foreground/80">
                · {liveTurn.statusText}
              </span>
            ) : null}
          </div>
        </div>
      ) : null}

      {liveTurn.blocks.map((block, idx) => {
        if (block.kind === "text") {
          return (
            <PaAssistantMessageRow
              key={block.id}
              text={block.text}
              streaming={block.streaming}
              alwaysShowMeta={idx === finalTextIndex}
              commentary={idx !== finalTextIndex}
              compactBottom={idx < lastBlockIndex}
            />
          );
        }

        const isActiveLiveGroup = isRunning && idx === lastBlockIndex;
        if (isActiveLiveGroup) {
          return (
            <PaLiveWorkGroup key={block.id} steps={block.steps} statusText={liveTurn.statusText} />
          );
        }
        return <PaWorkGroupRow key={block.id} steps={block.steps} />;
      })}

      {isRunning && liveTurn.blocks.length === 0 ? (
        <WorkLogBlock>
          <PaLiveShimmerActivityRow
            iconKind="reasoning"
            label={liveTurn.statusText || gt("思考中")}
            active
            shimmer
          />
        </WorkLogBlock>
      ) : null}
    </div>
  );
});

export const PaCompactionRow = memo(function PaCompactionRow({
  message,
}: {
  readonly message: PaMessage;
}) {
  const gt = useGT();
  const [expanded, setExpanded] = useState(false);
  const hasDetail = message.text.trim().length > 0;

  return (
    <div className="pb-3">
      <TimelineSystemDivider
        icon={Minimize2Icon}
        label={gt("上下文已压缩")}
        {...(hasDetail
          ? {
              actionLabel: expanded ? gt("收起摘要") : gt("查看压缩摘要"),
              onAction: () => setExpanded((v) => !v),
            }
          : {})}
      />
      {expanded && hasDetail ? (
        <div className="mt-1 rounded-xl border border-border/60 bg-muted/30 px-3.5 py-2.5">
          <ChatMarkdown
            text={message.text}
            cwd={undefined}
            headingLevelOffset={MESSAGE_HEADING_LEVEL}
          />
        </div>
      ) : null}
    </div>
  );
});

export const PaSystemOutputRow = memo(function PaSystemOutputRow({
  message,
}: {
  readonly message: PaMessage;
}) {
  return (
    <div className="group/system min-w-0 pb-4">
      <div className="min-w-0 overflow-hidden rounded-xl border border-border/60 bg-muted/30 px-3.5 py-2.5">
        <div className="mb-1.5 flex items-center justify-between gap-2 text-2xs font-medium text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <TerminalIcon className="size-3" />
            <span>
              <T>命令输出</T>
            </span>
          </span>
          <div className="flex items-center gap-1 opacity-0 transition-opacity pointer-coarse:opacity-100 group-hover/system:opacity-100">
            <PaTimestamp timestamp={message.timestamp} />
            <MessageCopyButton text={message.text} variant="ghost" />
          </div>
        </div>
        <ChatMarkdown
          text={message.text}
          cwd={undefined}
          lineBreaks
          headingLevelOffset={MESSAGE_HEADING_LEVEL}
        />
      </div>
    </div>
  );
});
