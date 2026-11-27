import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  PA_AVATAR_COLORS,
  PA_AVATAR_SHAPES,
  PA_DEFAULT_AVATAR,
} from "@t3tools/client-runtime/pa/avatar";
import { derivePaAgentSlug } from "@t3tools/client-runtime/pa/roster";
import type { PaAvatarShape } from "@t3tools/contracts";
import { T, useGT, useMessages } from "gt-react-native";
import { useRef, useState } from "react";
import { Pressable, View } from "react-native";

import { AppBar } from "../../components/ui/AppBar";
import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text, AppTextInput as TextInput } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/EmptyState";
import { ListSection } from "../../components/ui/ListSection";
import { ListToggleRow } from "../../components/ui/ListToggleRow";
import { Menu } from "../../components/ui/Menu";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { cn } from "../../lib/cn";
import { NativeScrollView } from "../../native/NativeScrollViewMarker";
import { useMountedRef } from "../../lib/useMountedRef";
import { useSelectWorkspaceDetail } from "../layout/workspace/useSelectWorkspaceDetail";
import { BotAvatar } from "./BotAvatar";
import { paClient, paErrorMessage } from "./paApi";
import { addPaBot, refreshPaRoster, usePaCreateOptions } from "./paRosterStore";

const INPUT = "rounded-xl border border-input-border bg-input px-3 py-2.5 text-sm text-foreground";

/** Creates a Bot on any connected environment's engine that can. */
export function PaCreateBotSheet({
  route,
}: StaticScreenProps<{ readonly environmentId?: string } | undefined>) {
  const gt = useGT();
  const messages = useMessages();
  const navigation = useNavigation();
  const selectDetail = useSelectWorkspaceDetail();
  const { engines, environments } = usePaCreateOptions();
  const mounted = useMountedRef();
  const dismissed = useRef(false);
  const manyEnvironments = new Set(engines.map((engine) => engine.environmentId)).size > 1;
  const preferred = route.params?.environmentId;
  const waitingForPreferred = environments.some(
    (env) => env.environmentId === preferred && env.entry.loading,
  );
  const suggested = waitingForPreferred
    ? null
    : (engines.find((item) => item.environmentId === preferred && item.instance.online) ??
      engines.find((item) => item.instance.online) ??
      engines[0] ??
      null);
  const [chosen, setSelected] = useState<typeof suggested>(null);
  const selected = chosen ?? suggested;
  const engine = engines.find((item) => item.key === selected?.key);
  const engineLabel = (item: (typeof engines)[number]) =>
    manyEnvironments ? `${item.instance.label} · ${item.environmentLabel}` : item.instance.label;
  const [name, setName] = useState("");
  const [agentRef, setAgentRef] = useState("");
  const [description, setDescription] = useState("");
  const [instructions, setInstructions] = useState("");
  const [avatarColor, setAvatarColor] = useState<string>(PA_DEFAULT_AVATAR.color);
  const [avatarShape, setAvatarShape] = useState<PaAvatarShape>(PA_DEFAULT_AVATAR.shape);
  const [pinned, setPinned] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const slug = derivePaAgentSlug(agentRef, name);

  const create = async () => {
    if (submitting) return;
    if (!engine?.instance.online) {
      setError(gt("No online engine can create bots"));
      return;
    }
    if (!slug) {
      setError(gt("Start the ID with a letter or number (e.g. news-bot)"));
      return;
    }
    setSubmitting(true);
    setError(null);
    const instanceId = engine.instance.instanceId;
    const environmentId = engine.environmentId;
    const bot = await paClient(environmentId)
      .createBot({
        instanceId,
        agentRef: slug,
        name: name.trim() || slug,
        description: description.trim(),
        ...(instructions.trim() ? { instructions: instructions.trim() } : {}),
        avatarColor,
        avatarShape,
        pinned,
      })
      .catch((cause: unknown) => {
        if (mounted.current) setError(paErrorMessage(cause, gt("Could not create bot")));
        return null;
      });
    if (!bot) {
      if (mounted.current) setSubmitting(false);
      return;
    }
    addPaBot(environmentId, bot);
    if (!mounted.current || dismissed.current || !navigation.isFocused()) return;
    selectDetail({ name: "PaBot", params: { environmentId, botId: bot.botId } });
  };

  return (
    <View className="flex-1 bg-sheet">
      <AppBar
        title={gt("Create bot")}
        onClose={() => {
          dismissed.current = true;
          navigation.goBack();
        }}
        confirm={{
          label: gt("Create"),
          onPress: () => void create(),
          disabled: !engine?.instance.online || !slug || submitting,
          loading: submitting,
        }}
      />
      <ScreenContent surface="sheet">
        <NativeScrollView
          className="flex-1"
          contentInsetAdjustmentBehavior="automatic"
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
          automaticallyAdjustKeyboardInsets
          contentContainerStyle={{ padding: 16, gap: 16, paddingBottom: 40 }}
        >
          {environments.map(({ environmentId, environmentLabel, entry }) =>
            entry.loading ? (
              <Text key={environmentId} className="text-sm text-foreground-muted">
                {environmentLabel} · {gt("Loading bots")}
              </Text>
            ) : entry.error ? (
              <View key={environmentId} className="gap-2">
                <Text selectable className="text-sm text-danger">
                  {environmentLabel} · {entry.error}
                </Text>
                <Button
                  size="compact"
                  tone="text"
                  label={gt("Retry")}
                  onPress={() => void refreshPaRoster(environmentId)}
                />
              </View>
            ) : null,
          )}
          {!selected && !environments.some(({ entry }) => entry.loading || entry.error) ? (
            <EmptyState
              title={gt("No bot engines")}
              detail={gt("Bots appear here once an environment runs a personal agent engine.")}
              variant="plain"
            />
          ) : null}
          {selected ? (
            <>
              <View className="flex-row items-center gap-4 rounded-2xl border border-border-subtle bg-card p-3">
                <BotAvatar color={avatarColor} shape={avatarShape} size="md" />
                <View className="min-w-0 flex-1">
                  <Text className="text-sm font-t3-medium text-foreground" numberOfLines={1}>
                    {name.trim() || slug || gt("New bot")}
                  </Text>
                  <Text className="text-xs text-foreground-muted">
                    <T>Each bot has its own memory, instructions and model.</T>
                  </Text>
                </View>
              </View>
              {error ? (
                <Text selectable className="text-sm text-danger">
                  {error}
                </Text>
              ) : null}
              <View className="gap-1.5">
                <Text className="px-1 text-xs font-t3-medium text-foreground-muted">
                  <T>Engine</T>
                </Text>
                <Menu
                  title={gt("Engine")}
                  actions={engines.map((item) => ({
                    id: item.key,
                    title: engineLabel(item),
                    ...(item.instance.online ? {} : { subtitle: gt("Offline") }),
                    state: item.key === engine?.key ? ("on" as const) : ("off" as const),
                  }))}
                  onPressAction={({ nativeEvent }) =>
                    setSelected(engines.find((item) => item.key === nativeEvent.event) ?? selected)
                  }
                >
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={gt("Engine")}
                    className={cn(INPUT, "flex-row items-center justify-between")}
                  >
                    <Text className="text-sm text-foreground">
                      {engine
                        ? engine.instance.online
                          ? engineLabel(engine)
                          : gt("{engine} (offline)", { engine: engineLabel(engine) })
                        : selected
                          ? gt("{engine} (offline)", { engine: engineLabel(selected) })
                          : ""}
                    </Text>
                    <SymbolView
                      name="chevron.down"
                      size={11}
                      tintColorClassName="accent-icon-subtle"
                    />
                  </Pressable>
                </Menu>
              </View>
              <View className="gap-1.5">
                <Text className="px-1 text-xs font-t3-medium text-foreground-muted">
                  <T>Name</T>
                </Text>
                <TextInput
                  accessibilityLabel={gt("Name")}
                  placeholder={gt("e.g. News bot")}
                  placeholderTextColorClassName="accent-foreground-muted"
                  value={name}
                  maxLength={120}
                  onChangeText={setName}
                  className={INPUT}
                />
              </View>
              <View className="gap-1.5">
                <Text className="px-1 text-xs font-t3-medium text-foreground-muted">
                  {slug ? gt("ID · {slug}", { slug }) : gt("ID")}
                </Text>
                <TextInput
                  accessibilityLabel={gt("Bot ID")}
                  placeholder={gt("Derived from the name")}
                  placeholderTextColorClassName="accent-foreground-muted"
                  value={agentRef}
                  maxLength={64}
                  autoCapitalize="none"
                  autoCorrect={false}
                  onChangeText={setAgentRef}
                  className={cn(INPUT, "font-mono")}
                />
              </View>
              <View className="gap-1.5">
                <Text className="px-1 text-xs font-t3-medium text-foreground-muted">
                  <T>Description</T>
                </Text>
                <TextInput
                  accessibilityLabel={gt("Description")}
                  placeholder={gt("What is this bot for?")}
                  placeholderTextColorClassName="accent-foreground-muted"
                  value={description}
                  maxLength={500}
                  onChangeText={setDescription}
                  className={INPUT}
                />
              </View>
              <View className="gap-1.5">
                <Text className="px-1 text-xs font-t3-medium text-foreground-muted">
                  <T>Instructions</T>
                </Text>
                <TextInput
                  accessibilityLabel={gt("Instructions")}
                  placeholder={gt("Enter system instructions for this bot…")}
                  placeholderTextColorClassName="accent-foreground-muted"
                  value={instructions}
                  multiline
                  onChangeText={setInstructions}
                  textAlignVertical="top"
                  className={cn(INPUT, "min-h-[120px]")}
                />
              </View>
              <ListSection>
                <ListToggleRow
                  label={gt("Pin to top")}
                  description={gt("Show in the pinned bots section")}
                  value={pinned}
                  onValueChange={setPinned}
                />
              </ListSection>
              <View className="gap-2">
                <Text className="px-1 text-xs font-t3-medium text-foreground-muted">
                  <T>Avatar appearance</T>
                </Text>
                <View className="flex-row flex-wrap gap-2">
                  {PA_AVATAR_SHAPES.map((item) => (
                    <Pressable
                      key={item.value}
                      accessibilityRole="radio"
                      accessibilityLabel={messages(item.label)}
                      accessibilityState={{ checked: avatarShape === item.value }}
                      onPress={() => setAvatarShape(item.value)}
                      className={cn(
                        "items-center gap-1 rounded-xl border px-2 py-1.5",
                        avatarShape === item.value
                          ? "border-primary bg-subtle"
                          : "border-border-subtle",
                      )}
                    >
                      <BotAvatar color={avatarColor} shape={item.value} size="sm" />
                      <Text className="text-2xs text-foreground-muted">{messages(item.label)}</Text>
                    </Pressable>
                  ))}
                </View>
                <View className="flex-row flex-wrap gap-2.5 pt-1">
                  {PA_AVATAR_COLORS.map(({ value: color, label }) => (
                    <Pressable
                      key={color}
                      accessibilityRole="radio"
                      accessibilityLabel={messages(label)}
                      accessibilityState={{ checked: avatarColor === color }}
                      onPress={() => setAvatarColor(color)}
                      className={cn(
                        "size-9 items-center justify-center rounded-full",
                        avatarColor === color && "border-2 border-foreground",
                      )}
                    >
                      <View className="size-7 rounded-full" style={{ backgroundColor: color }} />
                    </Pressable>
                  ))}
                </View>
              </View>
            </>
          ) : null}
        </NativeScrollView>
      </ScreenContent>
    </View>
  );
}
