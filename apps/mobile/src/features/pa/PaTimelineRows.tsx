import { formatPaToolVerb, formatPaWorkGroupLabel } from "@t3tools/client-runtime/pa/presentation";
import {
  describePaToolAction,
  findPaLiveFinalTextIndex,
  formatPaDurationMs,
  formatPaElapsedSeconds,
  formatPaToolInspectorContent,
  summarizePaWorkGroup,
  type PaLiveTurnState,
  type PaWorkStep,
} from "@t3tools/client-runtime/pa/timeline";
import { liveThoughtLine } from "@t3tools/client-runtime/work-log/presentation";
import type { EnvironmentId, PaAttachment, PaMessage, PaToolCategory } from "@t3tools/contracts";
import { Image } from "expo-image";
import { T, useGT, useMessages } from "gt-react-native";
import { createContext, use, memo, useEffect, useState } from "react";
import { Pressable, View } from "react-native";

import { SymbolView, type AppSymbolName } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { tryOpenWebLink } from "../../lib/openExternalUrl";
import { FilePreviewModal, type FilePreviewSource } from "../../components/ui/FilePreviewModal";
import { formatMessageTimestamp } from "../threads/messageTimestamp";
import { assetImageSource } from "../../lib/assetImageSource";
import { cn } from "../../lib/cn";
import { copyTextWithHaptic } from "../../lib/copyTextWithHaptic";
import { SelectableMarkdownText } from "../../native/SelectableMarkdownText";
import { useAssetUrl } from "../../state/assets";
import { useMarkdownPreviewStyles } from "../files/FileMarkdownPreview";

const TOOL_ICONS: Record<PaToolCategory | "reasoning", AppSymbolName> = {
  reasoning: "brain",
  terminal: "terminal",
  "file-read": "eye",
  "file-edit": "pencil",
  skill: "pencil",
  search: "magnifyingglass",
  memory: "magnifyingglass",
  "web-search": "globe",
  "web-fetch": "globe",
  agent: "person.2",
  todo: "list.number",
  schedule: "calendar.badge.clock",
  code: "chevron.left.forwardslash.chevron.right",
  vision: "photo",
  message: "bubble.left",
  other: "wrench.and.screwdriver",
};
const COLLAPSE_USER_MESSAGE_CHARS = 600;
const THOUGHT_PREVIEW_CHARS = 400;

export const PaMessageTimeContext = createContext(formatMessageTimestamp);

function PaTime(props: { readonly timestamp: number | null | undefined }) {
  const format = use(PaMessageTimeContext);
  if (!props.timestamp) return null;
  return (
    <Text className="text-2xs tabular-nums text-foreground-tertiary">
      {format(new Date(props.timestamp).toISOString())}
    </Text>
  );
}

function CopyButton(props: { readonly text: string; readonly label?: string }) {
  const gt = useGT();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label ?? gt("Copy message")}
      hitSlop={8}
      onPress={() => copyTextWithHaptic(props.text)}
      className="active:opacity-60"
    >
      <SymbolView name="doc.on.doc" size={13} tintColorClassName="accent-icon-subtle" />
    </Pressable>
  );
}

function PaMarkdown(props: { readonly text: string; readonly muted?: boolean }) {
  const styles = useMarkdownPreviewStyles();
  return (
    <SelectableMarkdownText
      markdown={props.text}
      textStyle={
        props.muted
          ? { ...styles.nativeTextStyle, color: styles.nativeTextStyle.mutedColor }
          : styles.nativeTextStyle
      }
      onLinkPress={(href) => void tryOpenWebLink(href, "markdown-link")}
      preserveSoftBreaks
    />
  );
}

function PaAttachmentImage(props: {
  readonly environmentId: EnvironmentId;
  readonly attachment: PaAttachment;
}) {
  const resource = {
    _tag: "attachment",
    attachmentId: props.attachment.id,
    fileName: props.attachment.name,
    mimeType: props.attachment.mimeType,
    disposition: "inline",
  } as const;
  const url = useAssetUrl(props.environmentId, resource);
  return url === null ? (
    <View className="size-24 rounded-xl bg-subtle" />
  ) : (
    <Image
      source={assetImageSource(props.environmentId, resource, url)}
      cachePolicy="memory-disk"
      contentFit="cover"
      style={{ width: 96, height: 96, borderRadius: 12 }}
      accessibilityLabel={props.attachment.name}
      accessibilityIgnoresInvertColors
    />
  );
}

function PaMessageAttachments(props: {
  readonly environmentId: EnvironmentId;
  readonly attachments: ReadonlyArray<PaAttachment>;
}) {
  const gt = useGT();
  const [preview, setPreview] = useState<FilePreviewSource | null>(null);
  return (
    <View className="flex-row flex-wrap justify-end gap-1.5">
      <FilePreviewModal source={preview} onRequestClose={() => setPreview(null)} />
      {props.attachments.map((attachment) => (
        <Pressable
          key={attachment.id}
          accessibilityLabel={attachment.name}
          accessibilityRole="button"
          disabled={attachment.unavailable}
          onPress={() =>
            setPreview({
              environmentId: props.environmentId,
              resource: {
                _tag: "attachment",
                attachmentId: attachment.id,
                fileName: attachment.name,
                mimeType: attachment.mimeType,
                disposition: "inline",
              },
              name: attachment.name,
              mimeType: attachment.mimeType,
              kind:
                attachment.type === "image"
                  ? "image"
                  : attachment.mimeType === "application/pdf"
                    ? "pdf"
                    : "document",
            })
          }
        >
          {attachment.type === "image" && !attachment.unavailable ? (
            <PaAttachmentImage environmentId={props.environmentId} attachment={attachment} />
          ) : (
            <View className="max-w-[240px] flex-row items-center gap-1.5 rounded-lg bg-subtle px-2 py-1.5">
              <SymbolView
                name={attachment.type === "image" ? "photo" : "doc"}
                size={13}
                tintColorClassName="accent-icon-muted"
              />
              <Text className="min-w-0 shrink text-xs text-foreground-muted" numberOfLines={1}>
                {attachment.unavailable
                  ? gt("{name} (unavailable)", { name: attachment.name })
                  : attachment.name}
              </Text>
            </View>
          )}
        </Pressable>
      ))}
    </View>
  );
}

export const PaUserMessageRow = memo(function PaUserMessageRow(props: {
  readonly message: PaMessage;
  readonly environmentId: EnvironmentId;
}) {
  const { message } = props;
  const [expanded, setExpanded] = useState(false);
  const text = message.text.trim();
  const collapsible = text.length > COLLAPSE_USER_MESSAGE_CHARS;
  return (
    <View className="items-end gap-1 pb-4">
      {message.attachments?.length ? (
        <View className="max-w-[85%]">
          <PaMessageAttachments
            environmentId={props.environmentId}
            attachments={message.attachments}
          />
        </View>
      ) : null}
      {text ? (
        <View className="max-w-[85%] rounded-2xl bg-user-bubble px-3.5 py-2.5">
          <Text
            selectable
            className="text-base text-user-bubble-foreground"
            numberOfLines={collapsible && !expanded ? 8 : undefined}
          >
            {message.text}
          </Text>
          {collapsible ? (
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ expanded }}
              onPress={() => setExpanded((value) => !value)}
              className="mt-1 self-end active:opacity-60"
            >
              <Text className="text-xs font-t3-medium text-user-bubble-foreground-muted">
                {expanded ? <T>Collapse</T> : <T>Show full message</T>}
              </Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
      <View className="flex-row items-center gap-3 pe-1">
        <PaTime timestamp={message.timestamp} />
        {text ? <CopyButton text={message.text} /> : null}
      </View>
    </View>
  );
});

export const PaAssistantMessageRow = memo(function PaAssistantMessageRow(props: {
  readonly text: string;
  readonly timestamp?: number | null;
  readonly streaming?: boolean;
  readonly showMeta?: boolean;
  readonly commentary?: boolean;
  readonly compactBottom?: boolean;
  readonly truncated?: boolean;
}) {
  return (
    <View className={props.compactBottom ? "px-1 pb-2" : "px-1 pb-4"}>
      <PaMarkdown text={props.text} muted={props.commentary} />
      {props.truncated ? (
        <Text className="mt-1 text-2xs text-foreground-tertiary">
          <T>Message shortened: only its beginning is shown.</T>
        </Text>
      ) : null}
      {props.showMeta && !props.streaming && !props.commentary && props.text.trim() ? (
        <View className="mt-1.5 flex-row items-center gap-3">
          <CopyButton text={props.text} />
          <PaTime timestamp={props.timestamp} />
        </View>
      ) : null}
    </View>
  );
});

function Chevron(props: { readonly expanded: boolean }) {
  return (
    <SymbolView
      name={props.expanded ? "chevron.down" : "chevron.right"}
      size={10}
      tintColorClassName="accent-icon-subtle"
    />
  );
}

function InspectorBlock(props: {
  readonly title: string;
  readonly copyLabel: string;
  readonly text: string;
}) {
  return (
    <View className="gap-1">
      <View className="flex-row items-center justify-between">
        <Text className="text-2xs font-t3-medium text-foreground-muted">{props.title}</Text>
        <CopyButton text={props.text} label={props.copyLabel} />
      </View>
      <Text selectable className="font-mono text-xs text-foreground-secondary" numberOfLines={40}>
        {props.text}
      </Text>
    </View>
  );
}

const PaWorkStepRow = memo(function PaWorkStepRow(props: {
  readonly step: PaWorkStep;
  readonly defaultExpanded?: boolean;
}) {
  const gt = useGT();
  const messages = useMessages();
  const { step } = props;
  const [expanded, setExpanded] = useState(props.defaultExpanded === true);
  if (step.kind === "reasoning") {
    const active = step.streaming === true;
    const hasContent = step.text.trim().length > 0;
    return (
      <View className="gap-1 py-1">
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded }}
          disabled={!hasContent}
          onPress={() => setExpanded((value) => !value)}
          className="flex-row items-center gap-2 active:opacity-70"
        >
          <SymbolView name="brain" size={14} tintColorClassName="accent-icon-muted" />
          <Text className="min-w-0 flex-1 text-sm text-foreground-muted" numberOfLines={1}>
            {expanded || !hasContent
              ? active
                ? gt("Thinking")
                : gt("Reasoning details")
              : liveThoughtLine(step.text.slice(0, THOUGHT_PREVIEW_CHARS))}
          </Text>
          {hasContent ? <Chevron expanded={expanded} /> : null}
        </Pressable>
        {expanded && hasContent ? (
          <View className="ms-6">
            <PaMarkdown text={step.text} muted />
          </View>
        ) : null}
      </View>
    );
  }
  const action = describePaToolAction(step);
  const failed = action.phase === "failed";
  const duration = formatPaDurationMs(step.durationMs);
  const inspector = formatPaToolInspectorContent(step);
  const canExpand = Boolean(inspector.command || inspector.argsJson || inspector.output);
  return (
    <View className="gap-1 py-1">
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        disabled={!canExpand}
        onPress={() => setExpanded((value) => !value)}
        className="flex-row items-center gap-2 active:opacity-70"
      >
        <SymbolView
          name={TOOL_ICONS[action.category]}
          size={14}
          tintColorClassName={failed ? "accent-danger" : "accent-icon-muted"}
        />
        <Text className={cn("shrink-0 text-sm", failed ? "text-danger" : "text-foreground-muted")}>
          {formatPaToolVerb(action, messages)}
        </Text>
        <Text
          className="min-w-0 flex-1 font-mono text-xs text-foreground-tertiary"
          numberOfLines={1}
        >
          {action.target ?? ""}
        </Text>
        {duration ? (
          <Text className="text-2xs tabular-nums text-foreground-tertiary">{duration}</Text>
        ) : null}
        {failed ? <SymbolView name="xmark" size={10} tintColorClassName="accent-danger" /> : null}
        {canExpand ? <Chevron expanded={expanded} /> : null}
      </Pressable>
      {expanded && canExpand ? (
        <View className="ms-6 gap-2 rounded-lg border border-border-subtle bg-subtle p-2.5">
          {inspector.command ? (
            <InspectorBlock
              title={gt("Command")}
              copyLabel={gt("Copy command")}
              text={inspector.command}
            />
          ) : null}
          {inspector.argsJson ? (
            <InspectorBlock
              title={gt("Arguments")}
              copyLabel={gt("Copy arguments")}
              text={inspector.argsJson}
            />
          ) : null}
          {inspector.output ? (
            <InspectorBlock
              title={gt("Output")}
              copyLabel={gt("Copy output")}
              text={inspector.output}
            />
          ) : null}
        </View>
      ) : null}
    </View>
  );
});

export const PaWorkGroupRow = memo(function PaWorkGroupRow(props: {
  readonly steps: ReadonlyArray<PaWorkStep>;
}) {
  const messages = useMessages();
  const [expanded, setExpanded] = useState(false);
  const only = props.steps[0];
  if (props.steps.length === 1 && only?.kind === "reasoning") {
    return (
      <View className="px-1 pb-2">
        <PaWorkStepRow step={only} />
      </View>
    );
  }
  const summary = summarizePaWorkGroup(props.steps);
  const icon =
    summary.kind === "reasoning"
      ? "reasoning"
      : summary.kind === "tool"
        ? summary.action.category
        : summary.lastCategory;
  return (
    <View className="px-1 pb-2">
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        onPress={() => setExpanded((value) => !value)}
        className="flex-row items-center gap-2 py-1 active:opacity-70"
      >
        <SymbolView
          name={TOOL_ICONS[icon]}
          size={14}
          tintColorClassName={summary.hasFailure ? "accent-danger" : "accent-icon-muted"}
        />
        <Text className="min-w-0 shrink text-sm text-foreground-muted" numberOfLines={1}>
          {formatPaWorkGroupLabel(summary, messages)}
        </Text>
        <Chevron expanded={expanded} />
      </Pressable>
      {expanded ? (
        <View className="ms-1 border-s border-border-subtle ps-3">
          {props.steps.map((step) => (
            <PaWorkStepRow key={step.id} step={step} />
          ))}
        </View>
      ) : null}
    </View>
  );
});

function PaElapsed(props: { readonly startedAt: number }) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- ticks the running turn's elapsed seconds
  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);
  return <>{formatPaElapsedSeconds(props.startedAt, nowMs)}</>;
}

function PaLiveWorkGroup(props: {
  readonly steps: ReadonlyArray<PaWorkStep>;
  readonly statusText: string | null;
}) {
  const gt = useGT();
  const messages = useMessages();
  const [expanded, setExpanded] = useState(false);
  const activeTool = props.steps.findLast(
    (step) =>
      step.kind === "tool" && (step.toolStatus === "started" || step.toolStatus === "progress"),
  );
  const focus = activeTool ?? props.steps.at(-1);
  const reasoning = props.steps.findLast((step) => step.kind === "reasoning");
  const action = focus?.kind === "tool" ? describePaToolAction(focus) : null;
  const completed = props.steps.length > 1 ? props.steps.length - 1 : 0;
  return (
    <View className="px-1 pb-2">
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        onPress={() => setExpanded((value) => !value)}
        className="gap-1 py-1 active:opacity-70"
      >
        {!expanded && reasoning?.text ? (
          <View className="flex-row items-start gap-2">
            <SymbolView name="brain" size={14} tintColorClassName="accent-icon-muted" />
            <Text className="min-w-0 flex-1 text-sm text-foreground-muted" numberOfLines={3}>
              {liveThoughtLine(reasoning.text.slice(0, THOUGHT_PREVIEW_CHARS))}
            </Text>
          </View>
        ) : null}
        <View className="flex-row items-center gap-2">
          <SymbolView
            name={action ? TOOL_ICONS[action.category] : "brain"}
            size={14}
            tintColorClassName={action?.phase === "failed" ? "accent-danger" : "accent-icon"}
          />
          <Text className="shrink-0 text-sm text-foreground">
            {action ? formatPaToolVerb(action, messages) : props.statusText || gt("Thinking")}
          </Text>
          <Text
            className="min-w-0 flex-1 font-mono text-xs text-foreground-tertiary"
            numberOfLines={1}
          >
            {action?.target ?? ""}
          </Text>
          {!expanded && completed > 0 ? (
            <Text className="text-xs tabular-nums text-foreground-tertiary">+{completed}</Text>
          ) : null}
          <Chevron expanded={expanded} />
        </View>
      </Pressable>
      {expanded ? (
        <View className="ms-1 border-s border-border-subtle ps-3">
          {props.steps.map((step, index) => (
            <PaWorkStepRow
              key={step.id}
              step={step}
              defaultExpanded={step.kind === "reasoning" && index === props.steps.length - 1}
            />
          ))}
        </View>
      ) : null}
    </View>
  );
}

export const PaLiveTurnView = memo(function PaLiveTurnView(props: {
  readonly liveTurn: PaLiveTurnState;
}) {
  const gt = useGT();
  const { liveTurn } = props;
  if (liveTurn.phase === "idle" && liveTurn.blocks.length === 0) return null;
  const running = liveTurn.phase === "running";
  const lastIndex = liveTurn.blocks.length - 1;
  const finalTextIndex = running ? -1 : findPaLiveFinalTextIndex(liveTurn.blocks);
  return (
    <View>
      {running ? (
        <View className="mb-2 flex-row items-baseline gap-2 border-b border-border-subtle px-1 pb-2">
          <Text className="text-sm tabular-nums text-foreground-muted">
            {liveTurn.startedAt ? (
              <>
                {gt("Working")} <PaElapsed startedAt={liveTurn.startedAt} />
              </>
            ) : (
              gt("Working…")
            )}
          </Text>
          {liveTurn.statusText ? (
            <Text className="min-w-0 flex-1 text-xs text-foreground-tertiary" numberOfLines={1}>
              · {liveTurn.statusText}
            </Text>
          ) : null}
        </View>
      ) : null}
      {liveTurn.blocks.map((block, index) =>
        block.kind === "text" ? (
          <PaAssistantMessageRow
            key={block.id}
            text={block.text}
            streaming={block.streaming}
            showMeta={index === finalTextIndex}
            commentary={index !== finalTextIndex}
            compactBottom={index < lastIndex}
          />
        ) : running && index === lastIndex ? (
          <PaLiveWorkGroup key={block.id} steps={block.steps} statusText={liveTurn.statusText} />
        ) : (
          <PaWorkGroupRow key={block.id} steps={block.steps} />
        ),
      )}
      {running && liveTurn.blocks.length === 0 ? (
        <View className="flex-row items-center gap-2 px-1 pb-2">
          <SymbolView name="brain" size={14} tintColorClassName="accent-icon" />
          <Text className="text-sm text-foreground-muted">
            {liveTurn.statusText || gt("Thinking")}
          </Text>
        </View>
      ) : null}
    </View>
  );
});

export const PaCompactionRow = memo(function PaCompactionRow(props: {
  readonly message: PaMessage;
}) {
  const gt = useGT();
  const [expanded, setExpanded] = useState(false);
  const hasDetail = props.message.text.trim().length > 0;
  return (
    <View className="pb-3">
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        disabled={!hasDetail}
        onPress={() => setExpanded((value) => !value)}
        className="flex-row items-center gap-2 py-1 active:opacity-70"
      >
        <View className="h-px flex-1 bg-border-subtle" />
        <SymbolView
          name="arrow.down.right.and.arrow.up.left"
          size={12}
          tintColorClassName="accent-icon-subtle"
        />
        <Text className="text-xs text-foreground-tertiary">
          {props.message.compactedMessages
            ? gt("Context compacted · {count} messages", {
                count: props.message.compactedMessages,
              })
            : gt("Context compacted")}
        </Text>
        {hasDetail ? <Chevron expanded={expanded} /> : null}
        <View className="h-px flex-1 bg-border-subtle" />
      </Pressable>
      {expanded && hasDetail ? (
        <View className="mt-1 rounded-xl border border-border-subtle bg-subtle px-3.5 py-2.5">
          <PaMarkdown text={props.message.text} />
        </View>
      ) : null}
    </View>
  );
});

export const PaSystemOutputRow = memo(function PaSystemOutputRow(props: {
  readonly message: PaMessage;
}) {
  return (
    <View className="pb-4">
      <View className="rounded-xl border border-border-subtle bg-subtle px-3.5 py-2.5">
        <View className="mb-1.5 flex-row items-center gap-1.5">
          <SymbolView name="terminal" size={12} tintColorClassName="accent-icon-muted" />
          <Text className="flex-1 text-2xs font-t3-medium text-foreground-muted">
            <T>Command output</T>
          </Text>
          <PaTime timestamp={props.message.timestamp} />
          <CopyButton text={props.message.text} />
        </View>
        <PaMarkdown text={props.message.text} />
      </View>
    </View>
  );
});
