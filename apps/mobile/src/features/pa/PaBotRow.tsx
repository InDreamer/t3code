import { useAtomValue } from "@effect/atom-react";
import { EnvironmentId, type PaBotSummary } from "@t3tools/contracts";
import { useGT } from "gt-react-native";
import { memo } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Menu } from "../../components/ui/Menu";
import { cn } from "../../lib/cn";
import {
  selectedThreadRowColors,
  THREAD_LIST_V2_SIDEBAR_ROW_CONTAINER_STYLE,
  THREAD_LIST_V2_SIDEBAR_ROW_STYLE,
} from "../threads/thread-list-v2-row-appearance";
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
  readonly onSelect: (bot: PaRosterBot) => void;
  readonly onAction: (bot: PaRosterBot, action: PaBotRowAction) => void;
}) {
  const gt = useGT();
  const { bot } = props;
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
  const status = bot.running ? gt("Working") : bot.online ? gt("Online") : gt("Offline");
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
            status,
            bot.unread ? gt("Unread") : null,
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
            starred={bot.isDefault}
            unread={bot.unread}
          />
          <View
            className={cn(
              "min-w-0 flex-1 gap-0.5",
              !props.sidebar && "border-b border-border-subtle py-3",
            )}
          >
            <View className="flex-row items-center gap-1.5">
              <View
                accessibilityElementsHidden
                importantForAccessibility="no"
                className={cn(
                  "size-1.5 rounded-full",
                  bot.running
                    ? "bg-warning"
                    : bot.online
                      ? "bg-emerald-500"
                      : "bg-foreground-tertiary",
                )}
              />
              <Text
                className={cn("min-w-0 flex-1 text-base font-t3-medium", foreground)}
                numberOfLines={1}
              >
                {bot.name}
              </Text>
              <Text className={cn("text-2xs tabular-nums", muted)}>{props.time}</Text>
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
          {bot.unread ? (
            <View
              accessibilityElementsHidden
              importantForAccessibility="no"
              className="size-2 rounded-full bg-primary"
            />
          ) : null}
        </Pressable>
      </Menu>
    </View>
  );
});
