import { useAtomValue } from "@effect/atom-react";
import { EnvironmentId, type PaBotSummary } from "@t3tools/contracts";
import { paBotStatusLabels } from "@t3tools/client-runtime/pa/roster";
import { useGT, useMessages } from "gt-react-native";
import { memo, useSyncExternalStore } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Menu } from "../../components/ui/Menu";
import { cn } from "../../lib/cn";
import {
  selectedThreadRowColors,
  THREAD_LIST_V2_SIDEBAR_ROW_CONTAINER_STYLE,
  THREAD_LIST_V2_SIDEBAR_ROW_STYLE,
} from "../threads/thread-list-v2-row-appearance";
import type { PaRowVisibility } from "./paRowVisibility";
import { BotAvatar } from "./BotAvatar";
import { paUpdateMetaPermissionAtom } from "./paApi";

export interface PaRosterBot extends PaBotSummary {
  readonly environmentId: string;
  /** Shown only when Bots from more than one environment are listed. */
  readonly environmentLabel: string | null;
  readonly key: string;
}

export type PaBotRowAction = "settings" | "pin" | "unpin" | "markRead";

export const PaBotRow = memo(function PaBotRow(props: {
  readonly bot: PaRosterBot;
  readonly preview: string;
  readonly time: string;
  readonly selected: boolean;
  readonly sidebar: boolean;
  readonly visible: boolean;
  readonly rowVisibility: PaRowVisibility;
  readonly onSelect: (bot: PaRosterBot) => void;
  readonly onAction: (bot: PaRosterBot, action: PaBotRowAction) => void;
}) {
  const gt = useGT();
  const { bot } = props;
  const inViewport = useSyncExternalStore(
    (listener) => props.rowVisibility.subscribe(bot.key, listener),
    () => props.rowVisibility.has(bot.key),
  );
  const canEdit = useAtomValue(paUpdateMetaPermissionAtom(EnvironmentId.make(bot.environmentId)));
  const foreground = props.selected
    ? selectedThreadRowColors.foregroundClassName
    : props.sidebar
      ? "text-drawer-foreground"
      : "text-foreground";
  const muted = props.selected
    ? selectedThreadRowColors.mutedForegroundClassName
    : props.sidebar
      ? "text-drawer-foreground-muted"
      : "text-foreground-muted";
  const messages = useMessages();
  const actions = [
    { id: "settings", title: gt("Bot settings"), image: "gearshape" },
    ...(canEdit
      ? [
          bot.pinned
            ? { id: "unpin", title: gt("Unpin"), image: "pin.slash" }
            : { id: "pin", title: gt("Pin"), image: "pin" },
          ...(bot.unread
            ? [{ id: "markRead", title: gt("Mark as read"), image: "checkmark.circle" }]
            : []),
        ]
      : []),
  ];
  return (
    <View style={props.sidebar ? THREAD_LIST_V2_SIDEBAR_ROW_CONTAINER_STYLE : undefined}>
      <Menu
        shouldOpenOnLongPress
        title={bot.name}
        actions={actions}
        onPressAction={({ nativeEvent }) =>
          props.onAction(bot, nativeEvent.event as PaBotRowAction)
        }
      >
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ selected: props.selected }}
          accessibilityLabel={[
            bot.name,
            bot.engineLabel,
            ...paBotStatusLabels(bot, messages),
            bot.pinned ? gt("Pinned") : null,
            props.preview,
          ]
            .filter(Boolean)
            .join(", ")}
          onPress={() => props.onSelect(bot)}
          style={props.sidebar ? THREAD_LIST_V2_SIDEBAR_ROW_STYLE : undefined}
          className={cn(
            "flex-row items-center gap-3 overflow-hidden",
            !props.sidebar && "px-4 active:bg-row-hover",
            props.sidebar && "bg-drawer",
            props.sidebar && !props.selected && "active:bg-thread-hover",
            props.selected && "bg-thread-selected",
          )}
        >
          <BotAvatar
            color={bot.avatarColor}
            shape={bot.avatarShape}
            size={props.sidebar ? "sm" : "md"}
            online={bot.online}
            visible={props.visible && inViewport}
            running={bot.running}
            awaiting={bot.awaiting ?? false}
            unread={bot.unread}
            starred={bot.isDefault}
          />
          <View
            className={cn(
              "min-w-0 flex-1 gap-0.5",
              !props.sidebar && "border-b border-border-subtle py-3",
            )}
          >
            <View className="flex-row items-center gap-1.5">
              <Text
                className={cn("min-w-0 flex-1 text-base font-t3-medium", foreground)}
                numberOfLines={1}
              >
                {bot.name}
              </Text>
              {props.time ? (
                <Text className={cn("shrink-0 text-2xs tabular-nums", muted)} numberOfLines={1}>
                  {props.time}
                </Text>
              ) : null}
            </View>
            <Text className={cn("text-sm", muted)} numberOfLines={1}>
              {props.preview}
            </Text>
            <Text className={cn("text-2xs", muted)} numberOfLines={1}>
              {bot.environmentLabel
                ? `${bot.engineLabel} · ${bot.environmentLabel}`
                : bot.engineLabel}
            </Text>
          </View>
        </Pressable>
      </Menu>
    </View>
  );
});
