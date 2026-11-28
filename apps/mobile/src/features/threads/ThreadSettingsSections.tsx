import { useGT } from "gt-react-native";
import { Pressable, View } from "react-native";

import { ProviderIcon } from "../../components/ProviderIcon";
import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { ROW_MIN_HEIGHT } from "../../components/ui/listMetrics";
import { cn } from "../../lib/cn";

/** A provider section's heading in a model picker, collapsible when the section folds away. */
export function ProviderHeader(props: {
  readonly driver: string | undefined;
  readonly iconUrl: string | undefined;
  readonly label: string;
  /** A backend inside a provider's section, such as one of fx's: no icon. */
  readonly nested?: boolean;
  /** Why the section has no usable models, such as a signed-out backend. */
  readonly detail?: string | undefined;
  readonly collapsible: boolean;
  readonly collapsed: boolean;
  readonly modelCount: number;
  readonly onToggle: () => void;
}) {
  const gt = useGT();
  const content = (
    <>
      {props.nested ? null : (
        <ProviderIcon iconUrl={props.iconUrl} provider={props.driver} size={15} />
      )}
      {props.detail ? (
        <View className="min-w-0 flex-1 py-1">
          <Text className="text-sm font-t3-medium text-foreground-muted">{props.label}</Text>
          <Text className="text-xs text-foreground-muted">{props.detail}</Text>
        </View>
      ) : (
        <Text className="text-sm font-t3-medium text-foreground-muted">{props.label}</Text>
      )}
      {props.collapsible ? (
        <>
          <View className="flex-1" />
          {props.collapsed ? (
            <Text className="text-2xs font-t3-medium text-foreground-muted">
              {props.modelCount}
            </Text>
          ) : null}
          <SymbolView
            name={props.collapsed ? "chevron.down" : "chevron.up"}
            size={12}
            tintColorClassName="accent-icon-subtle"
            type="monochrome"
          />
        </>
      ) : null}
    </>
  );

  if (props.collapsible) {
    return (
      <Pressable
        accessibilityLabel={gt(
          "{provider}, {count, plural, one {{count} model} other {{count} models}}",
          {
            provider: props.label,
            count: props.modelCount,
          },
        )}
        accessibilityRole="button"
        accessibilityState={{ expanded: !props.collapsed }}
        className="mx-4 mt-1 flex-row items-center gap-2 rounded-xl px-1 pt-2 active:opacity-60"
        style={{ minHeight: ROW_MIN_HEIGHT.control }}
        onPress={props.onToggle}
      >
        {content}
      </Pressable>
    );
  }

  return (
    <View
      accessibilityRole="header"
      className={cn("mx-4 min-h-9 flex-row items-center gap-2 px-1 pt-1", props.nested && "mt-1")}
    >
      {content}
    </View>
  );
}

/** A grouped-card row that opens a submenu, showing its current value. */
export function DisclosureRow(props: {
  readonly label: string;
  readonly value: string | undefined;
  readonly onPress: () => void;
  readonly isLast?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={props.onPress}
      className={cn(
        "flex-row items-center gap-2 bg-grouped-card px-4 py-2 active:bg-subtle",
        !props.isLast && "border-b border-border-subtle",
      )}
      style={{ minHeight: ROW_MIN_HEIGHT.item }}
    >
      <Text className="text-sm font-t3-medium text-foreground">{props.label}</Text>
      <View className="flex-1" />
      {props.value ? (
        <Text className="text-sm text-foreground-muted" numberOfLines={1}>
          {props.value}
        </Text>
      ) : null}
      <SymbolView
        name="chevron.right"
        size={12}
        tintColorClassName="accent-icon-subtle"
        type="monochrome"
      />
    </Pressable>
  );
}
