import type { PaSlashCommand } from "@t3tools/contracts";
import { useGT } from "gt-react-native";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";

import { SymbolView, type AppSymbolName } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { PopoverSurface } from "../threads/ComposerCommandPopover";

const GROUP_SYMBOL: Readonly<Record<PaSlashCommand["group"], AppSymbolName>> = {
  command: "terminal",
  skill: "cube",
  plugin: "square.grid.2x2",
};

/** The thread composer's command popover for PA: commands, skills and plugins in one list. */
export function PaSlashCommandPopover(props: {
  readonly commands: ReadonlyArray<PaSlashCommand>;
  readonly onSelect: (command: PaSlashCommand) => void;
}) {
  const gt = useGT();
  return (
    <PopoverSurface>
      <View className="px-3.5 pt-2.5 pb-1">
        <Text className="text-3xs font-t3-bold tracking-[0.8px] uppercase text-foreground-muted">
          {gt("Commands")}
        </Text>
      </View>
      <ScrollView
        className="max-h-[200px]"
        keyboardShouldPersistTaps="always"
        showsVerticalScrollIndicator={false}
      >
        {props.commands.map((command, index) => (
          <Pressable
            key={command.name}
            accessibilityRole="button"
            onPress={() => props.onSelect(command)}
            className="flex-row items-center gap-2.5 border-border px-3.5 py-2.5 active:opacity-60"
            style={{
              borderBottomWidth: index === props.commands.length - 1 ? 0 : StyleSheet.hairlineWidth,
            }}
          >
            <SymbolView
              name={GROUP_SYMBOL[command.group]}
              size={14}
              tintColorClassName="accent-icon-subtle"
              type="monochrome"
            />
            <Text className="shrink-0 text-base font-t3-medium text-foreground" numberOfLines={1}>
              {command.name}
            </Text>
            <Text className="min-w-0 flex-1 text-xs text-foreground-muted" numberOfLines={1}>
              {command.description}
            </Text>
            {command.group === "command" ? null : (
              <Text className="shrink-0 rounded bg-subtle-strong px-1.5 text-2xs text-foreground-muted">
                {command.group === "skill" ? gt("Skill") : gt("Plugin")}
              </Text>
            )}
          </Pressable>
        ))}
      </ScrollView>
    </PopoverSurface>
  );
}
