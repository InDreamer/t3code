import { hasPaContextUsage } from "@t3tools/client-runtime/pa/session-status";
import { summarizePaTodos } from "@t3tools/client-runtime/pa/timeline";
import type { PaContextUsage, PaQueuedItem, PaTodoState } from "@t3tools/contracts";
import { T, useGT, useLocale } from "gt-react-native";
import { useState } from "react";
import { Pressable, ScrollView, View } from "react-native";

import { SymbolView, type AppSymbolName } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { cn } from "../../lib/cn";

const CARD = "rounded-2xl border border-border-subtle bg-card";

const TODO_ICONS: Record<PaTodoState["items"][number]["status"], AppSymbolName> = {
  completed: "checkmark.circle.fill",
  in_progress: "circle.inset.filled",
  cancelled: "slash.circle",
  pending: "circle",
};

/** The agent's task list: progress and the current item folded, every item when opened. */
export function PaTodoProgress(props: { readonly todos: PaTodoState | null }) {
  const gt = useGT();
  const [expanded, setExpanded] = useState(false);
  const progress = summarizePaTodos(props.todos);
  if (!props.todos || !progress || progress.total === 0) return null;
  return (
    <View className={CARD}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        onPress={() => setExpanded((open) => !open)}
        className="flex-row items-center gap-2 px-3 py-2 active:opacity-70"
      >
        <SymbolView name="list.number" size={13} tintColorClassName="accent-icon-muted" />
        <Text className="shrink-0 text-xs font-t3-medium text-foreground">
          {gt("Task progress {done}/{total}", { done: progress.completed, total: progress.total })}
        </Text>
        <Text className="min-w-0 flex-1 text-xs text-foreground-muted" numberOfLines={1}>
          {progress.active?.text ?? ""}
        </Text>
        <SymbolView
          name={expanded ? "chevron.up" : "chevron.down"}
          size={10}
          tintColorClassName="accent-icon-subtle"
        />
      </Pressable>
      {expanded ? (
        <ScrollView style={{ maxHeight: 192 }} className="border-t border-border-subtle">
          <View className="gap-1 px-3 py-2">
            {props.todos.items.map((item) => (
              <View key={item.id} className="flex-row items-start gap-2">
                <View className="pt-0.5">
                  <SymbolView
                    name={TODO_ICONS[item.status]}
                    size={13}
                    tintColorClassName={
                      item.status === "completed" || item.status === "in_progress"
                        ? "accent-primary"
                        : "accent-icon-subtle"
                    }
                  />
                </View>
                <Text
                  className={cn(
                    "min-w-0 flex-1 text-xs",
                    item.status === "completed" || item.status === "cancelled"
                      ? "text-foreground-muted"
                      : "text-foreground",
                    item.status === "cancelled" && "line-through",
                  )}
                >
                  {item.text}
                </Text>
              </View>
            ))}
          </View>
        </ScrollView>
      ) : null}
    </View>
  );
}

/** Messages waiting behind the running turn, as the engine holds them. */
export function PaQueueStrip(props: {
  readonly items: ReadonlyArray<PaQueuedItem>;
  readonly canOperate: boolean;
  readonly canSteer: boolean;
  readonly busyIds: ReadonlySet<string>;
  readonly onSteer: (item: PaQueuedItem) => void;
  readonly onCancel: (item: PaQueuedItem) => void;
  readonly onResolveUnknown: (item: PaQueuedItem) => void;
}) {
  const gt = useGT();
  if (props.items.length === 0) return null;
  return (
    <ScrollView style={{ maxHeight: 176 }} className={CARD}>
      <View className="px-2 py-1">
        {props.items.map((item) => {
          const busy = !props.canOperate || props.busyIds.has(item.id);
          const label =
            item.text ||
            (item.attachmentCount
              ? gt("{count} attachments", { count: item.attachmentCount })
              : gt("Queued message"));
          if (item.status === "unknown") {
            return (
              <View key={item.id} className="gap-1.5 px-1 py-1.5">
                <View className="flex-row items-start gap-2">
                  <SymbolView
                    name="exclamationmark.triangle"
                    size={13}
                    tintColorClassName="accent-warning"
                  />
                  <View className="min-w-0 flex-1">
                    <Text className="text-xs text-warning-foreground">
                      <T>
                        The interrupted task has an unknown outcome. Later messages are waiting.
                      </T>
                    </Text>
                    <Text className="text-xs text-foreground-muted" numberOfLines={1}>
                      {label}
                    </Text>
                  </View>
                </View>
                <View className="items-end">
                  <Button
                    size="compact"
                    tone="secondary"
                    label={gt("Skip task and resume queue")}
                    disabled={busy}
                    onPress={() => props.onResolveUnknown(item)}
                  />
                </View>
              </View>
            );
          }
          return (
            <View key={item.id} className="min-h-[36px] flex-row items-center gap-2 px-1">
              <SymbolView
                name="tray.and.arrow.up"
                size={12}
                tintColorClassName="accent-icon-subtle"
              />
              <Text className="min-w-0 flex-1 text-xs text-foreground-secondary" numberOfLines={1}>
                {label}
              </Text>
              {item.status === "steering" ? (
                <Text className="shrink-0 text-2xs text-primary-text">
                  <T>Moving into the current turn</T>
                </Text>
              ) : (
                <>
                  {props.canSteer && item.canSteer ? (
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={gt("Steer the current turn with this message")}
                      disabled={busy}
                      hitSlop={6}
                      onPress={() => props.onSteer(item)}
                      className="flex-row items-center gap-1 rounded-full px-2 py-1 active:opacity-60"
                    >
                      <SymbolView
                        name="arrow.turn.left.up"
                        size={11}
                        tintColorClassName="accent-icon-muted"
                      />
                      <Text className="text-xs text-foreground-muted">
                        <T>Steer</T>
                      </Text>
                    </Pressable>
                  ) : null}
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={gt("Cancel queued message")}
                    disabled={busy}
                    hitSlop={8}
                    onPress={() => props.onCancel(item)}
                    className="active:opacity-60"
                  >
                    <SymbolView name="xmark" size={11} tintColorClassName="accent-icon-muted" />
                  </Pressable>
                </>
              )}
            </View>
          );
        })}
      </View>
    </ScrollView>
  );
}

const tokenFormats = new Map<string, Intl.NumberFormat>();

function useTokenFormat() {
  const locale = useLocale();
  let format = tokenFormats.get(locale);
  if (!format) {
    format = new Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: 1 });
    tokenFormats.set(locale, format);
  }
  return (tokens: number) => format.format(tokens);
}

/** How full the session's context is; hidden until the engine reports it. */
export function PaContextUsageStrip(props: { readonly usage: PaContextUsage | null }) {
  const gt = useGT();
  const tokens = useTokenFormat();
  const [expanded, setExpanded] = useState(false);
  const { usage } = props;
  if (!hasPaContextUsage(usage)) return null;
  const max = usage.contextMax !== null && usage.contextMax > 0 ? usage.contextMax : null;
  const percent = max !== null && usage.contextPercent !== null ? usage.contextPercent : null;
  return (
    <View className={CARD}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        accessibilityLabel={
          percent !== null
            ? gt("Context usage {percent}%", { percent: Math.round(percent) })
            : gt("Context usage {tokens} tokens", { tokens: tokens(usage.contextUsed) })
        }
        onPress={() => setExpanded((open) => !open)}
        className="flex-row items-center gap-2 px-3 py-2 active:opacity-70"
      >
        <SymbolView name="chart.bar.xaxis" size={13} tintColorClassName="accent-icon-muted" />
        <Text className="shrink-0 text-xs font-t3-medium text-foreground">
          <T>Context</T>
        </Text>
        <View className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-subtle-strong">
          {percent !== null ? (
            <View
              className={percent >= 85 ? "h-full bg-warning" : "h-full bg-primary"}
              style={{ width: `${Math.min(100, Math.max(0, percent))}%` }}
            />
          ) : null}
        </View>
        <Text className="shrink-0 text-xs tabular-nums text-foreground-muted">
          {percent !== null ? `${Math.round(percent)}%` : tokens(usage.contextUsed)}
        </Text>
      </Pressable>
      {expanded ? (
        <View className="gap-0.5 border-t border-border-subtle px-3 py-2">
          <Text className="text-xs text-foreground-muted">
            {max !== null
              ? gt("{used} of {max} tokens in context", {
                  used: tokens(usage.contextUsed),
                  max: tokens(max),
                })
              : gt("{used} tokens in context", { used: tokens(usage.contextUsed) })}
          </Text>
          {usage.totalTokens !== undefined ? (
            <Text className="text-xs text-foreground-muted">
              {gt("{tokens} tokens used in this session", { tokens: tokens(usage.totalTokens) })}
            </Text>
          ) : null}
          {usage.compressionCount ? (
            <Text className="text-xs text-foreground-muted">
              {gt("Compactions: {count}", { count: usage.compressionCount })}
            </Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}
