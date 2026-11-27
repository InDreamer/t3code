import { useAtomValue } from "@effect/atom-react";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  formatPaReasoningLabel,
  getSelectableReasoningLevels,
} from "@t3tools/client-runtime/pa/reasoning";
import { EnvironmentId, type PaModelCatalog, type PaModelProvider } from "@t3tools/contracts";
import { T, useGT, useMessages } from "gt-react-native";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { Pressable, View } from "react-native";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text, AppTextInput as TextInput } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { Menu } from "../../components/ui/Menu";
import { SelectionRow } from "../../components/ui/SelectionRow";
import { cn } from "../../lib/cn";
import { NativeScrollView } from "../../native/NativeScrollViewMarker";
import { PullRequestSearchSheet } from "../pull-requests/PullRequestSearchSheet";
import { paClient, paErrorMessage, paSelectModelPermissionAtom } from "./paApi";
import type { PaBotParams } from "./paBotParams";
import { patchPaBot, usePaBot } from "./paRosterStore";
import { usePaBotChat } from "./usePaBotChat";

type PaModelParams = PaBotParams & { readonly query?: string };

function filterProvider(option: PaModelProvider, needle: string): PaModelProvider {
  if (!needle) return option;
  return {
    ...option,
    models: option.models.filter(
      (model) =>
        model.id.toLowerCase().includes(needle) ||
        option.label.toLowerCase().includes(needle) ||
        option.id.toLowerCase().includes(needle),
    ),
  };
}

/** Switches the Bot's (or the session's) model and reasoning effort. */
export function PaModelSheet({ route }: StaticScreenProps<PaModelParams>) {
  const { environmentId, botId } = route.params;
  const { chat, state } = usePaBotChat(environmentId, botId);
  return (
    <PaModelPicker
      key={JSON.stringify([environmentId, botId, state.activeSessionId])}
      params={route.params}
      chat={chat}
      state={state}
    />
  );
}

function PaModelPicker({
  params,
  chat,
  state,
}: { readonly params: PaModelParams } & ReturnType<typeof usePaBotChat>) {
  const gt = useGT();
  const messages = useMessages();
  const navigation = useNavigation();
  const { environmentId, botId } = params;
  const { bot, capabilities } = usePaBot(environmentId, botId);
  const sessionId = state.activeSessionId;
  const canSelect = useAtomValue(paSelectModelPermissionAtom(EnvironmentId.make(environmentId)));
  const [customProvider, setCustomProvider] = useState<string | null>(null);
  const [query, setQuery] = useState(params.query ?? "");
  const [catalog, setCatalog] = useState<PaModelCatalog | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{
    readonly provider: string;
    readonly model: string;
    readonly message: string;
  } | null>(null);
  const [showDetected, setShowDetected] = useState(false);
  const [custom, setCustom] = useState("");
  const request = useRef(0);

  const fetchCatalog = () => {
    const id = ++request.current;
    paClient(environmentId)
      .getBotModels(botId, sessionId)
      .then(
        (next) => {
          if (request.current !== id) return;
          setCatalog(next);
          setError(null);
        },
        (cause: unknown) => {
          if (request.current === id) setError(paErrorMessage(cause, gt("Could not load models")));
        },
      )
      .finally(() => {
        if (request.current === id) setLoading(false);
      });
  };
  const loadOnOpen = useEffectEvent(fetchCatalog);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the engine's live model catalog when the sheet opens
  useEffect(() => {
    loadOnOpen();
    return () => {
      request.current += 1;
    };
  }, []);
  const retry = () => {
    setLoading(true);
    fetchCatalog();
  };

  const currentProvider = catalog?.current?.provider ?? null;
  const customProviderId = customProvider ?? currentProvider;
  const currentModel =
    catalog?.current?.model ??
    (capabilities?.models.scope === "session"
      ? state.sessions.find((s) => s.sessionId === sessionId)?.model
      : null) ??
    bot?.model ??
    null;
  const liveEffort =
    state.sessionReasoning?.sessionId === sessionId &&
    state.sessionReasoning.settingsVersion === state.settingsVersion
      ? state.sessionReasoning.effort
      : null;
  const currentEffort = liveEffort ?? catalog?.current?.reasoningEffort ?? null;
  const levels = getSelectableReasoningLevels(catalog, currentProvider, currentModel);
  const needle = query.trim().toLowerCase();
  const options = (catalog?.providers ?? []).filter((option) => option.models.length > 0);
  const primary = options.filter((option) => option.tier === "primary");
  const detected = options.filter((option) => option.tier === "detected");
  const groups = needle
    ? options.map((option) => filterProvider(option, needle)).filter((o) => o.models.length > 0)
    : [...primary, ...(showDetected ? detected : [])];

  const apply = async (
    input: {
      readonly provider?: string;
      readonly model?: string;
      readonly reasoningEffort?: string;
    },
    confirmed = false,
  ) => {
    if (saving || !canSelect || !catalog) return;
    const generation = request.current;
    const key = input.reasoningEffort ?? `${input.provider ?? ""}/${input.model ?? ""}`;
    setSaving(key);
    setError(null);
    const result = await paClient(environmentId)
      .selectBotModel({
        botId,
        ...(sessionId ? { sessionId } : {}),
        ...input,
        ...(confirmed ? { confirm: true } : {}),
      })
      .catch((cause: unknown) => {
        if (generation !== request.current) return null;
        setError(
          paErrorMessage(
            cause,
            input.reasoningEffort
              ? gt("Could not change reasoning effort")
              : gt("Could not switch model"),
          ),
        );
        return null;
      });
    if (generation !== request.current || chat.getState().activeSessionId !== sessionId) return;
    setSaving(null);
    if (!result) return;
    if (result.status === "confirmRequired" && input.model) {
      setConfirm({ provider: input.provider ?? "", model: input.model, message: result.message });
      return;
    }
    if (result.status !== "applied") return;
    setConfirm(null);
    const current = {
      ...(catalog?.current?.reasoningEffort !== undefined
        ? { reasoningEffort: catalog.current.reasoningEffort }
        : {}),
      ...result.current,
    };
    setCatalog({ ...catalog, current });
    if (input.reasoningEffort) {
      chat.setReasoning(result.current.reasoningEffort ?? input.reasoningEffort);
      return;
    }
    // Agent-scoped models are the Bot's own; the roster shows them.
    if (catalog.scope === "session") {
      if (sessionId) chat.patchSession(sessionId, { model: result.current.model });
    } else {
      patchPaBot(environmentId, botId, {
        model: result.current.model,
        provider: result.current.provider,
      });
    }
    chat.bumpSettings();
    navigation.goBack();
  };

  const renderGroup = (option: PaModelProvider) => (
    <View key={option.id} className="gap-1 pb-3">
      <View className="flex-row items-center justify-between px-1">
        <Text className="text-xs font-t3-medium text-foreground-muted">{option.label}</Text>
        {option.badge === "current" ? (
          <Text className="text-2xs text-foreground-tertiary">
            <T>Current</T>
          </Text>
        ) : option.badge === "custom" ? (
          <Text className="text-2xs text-foreground-tertiary">
            <T>Custom</T>
          </Text>
        ) : null}
      </View>
      {option.models.map((model, index) => {
        const selected =
          model.id === currentModel && (currentProvider === null || option.id === currentProvider);
        return (
          <SelectionRow
            key={model.id}
            title={model.id}
            role="radio"
            selected={selected}
            disabled={!canSelect || saving !== null}
            isFirst={index === 0}
            isLast={index === option.models.length - 1}
            onPress={() => void apply({ provider: option.id, model: model.id })}
          />
        );
      })}
    </View>
  );

  return (
    <PullRequestSearchSheet
      title={gt("Model")}
      placeholder={gt("Search models or providers")}
      closeAccessibilityLabel={gt("Close model picker")}
      clearAccessibilityLabel={gt("Clear search")}
      query={query}
      onQueryChange={setQuery}
    >
      {({ paddingBottom }) => (
        <NativeScrollView
          className="flex-1"
          contentInsetAdjustmentBehavior="automatic"
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 16, paddingBottom, gap: 12 }}
        >
          {levels.length > 0 ? (
            <View className="gap-1.5">
              <Text className="px-1 text-xs font-t3-medium text-foreground-muted">
                <T>Reasoning effort</T>
              </Text>
              <View className="flex-row flex-wrap gap-1.5">
                {levels.map((level) => {
                  const selected = level.id.toLowerCase() === (currentEffort ?? "").toLowerCase();
                  return (
                    <Pressable
                      key={level.id}
                      accessibilityRole="radio"
                      accessibilityState={{ checked: selected, disabled: saving !== null }}
                      disabled={!canSelect || saving !== null || selected}
                      onPress={() => void apply({ reasoningEffort: level.id })}
                      className={cn(
                        "rounded-full border px-3 py-1.5 active:opacity-70",
                        selected ? "border-primary bg-subtle" : "border-border-subtle",
                      )}
                    >
                      <Text
                        className={cn(
                          "text-xs",
                          selected ? "font-t3-medium text-foreground" : "text-foreground-muted",
                        )}
                      >
                        {formatPaReasoningLabel(level.id, level.label, messages)}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            </View>
          ) : null}
          {confirm ? (
            <View className="gap-2 rounded-xl border border-warning-border bg-card p-3">
              <Text selectable className="text-sm text-foreground">
                {confirm.message}
              </Text>
              <View className="flex-row justify-end gap-2">
                <Button
                  size="compact"
                  tone="text"
                  label={gt("Cancel")}
                  onPress={() => setConfirm(null)}
                />
                <Button
                  size="compact"
                  label={gt("Confirm switch")}
                  disabled={!canSelect || saving !== null}
                  onPress={() =>
                    void apply(
                      {
                        ...(confirm.provider ? { provider: confirm.provider } : {}),
                        model: confirm.model,
                      },
                      true,
                    )
                  }
                />
              </View>
            </View>
          ) : null}
          {error ? (
            <View className="flex-row items-center gap-2">
              <Text selectable className="min-w-0 flex-1 text-sm text-danger">
                {error}
              </Text>
              <Button size="compact" tone="text" label={gt("Retry")} onPress={retry} />
            </View>
          ) : null}
          {!catalog && loading ? <AppActivityIndicator className="my-8" /> : null}
          {catalog && groups.length === 0 && (needle || detected.length === 0) ? (
            <Text className="py-6 text-center text-sm text-foreground-muted">
              {needle ? <T>No matching models</T> : <T>No models available</T>}
            </Text>
          ) : null}
          <View>{groups.map(renderGroup)}</View>
          {!needle && detected.length > 0 ? (
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ expanded: showDetected }}
              onPress={() => setShowDetected((open) => !open)}
              className="flex-row items-center gap-1.5 px-1 py-2 active:opacity-70"
            >
              <SymbolView
                name={showDetected ? "chevron.down" : "chevron.right"}
                size={10}
                tintColorClassName="accent-icon-subtle"
              />
              <Text className="min-w-0 flex-1 text-xs text-foreground-muted" numberOfLines={1}>
                {gt("Other detected providers ({names} · {count})", {
                  names: detected.map((option) => option.label).join(" / "),
                  count: detected.reduce((sum, option) => sum + option.models.length, 0),
                })}
              </Text>
            </Pressable>
          ) : null}
          {canSelect && catalog?.allowCustom ? (
            <View className="gap-1.5">
              <Text className="px-1 text-xs font-t3-medium text-foreground-muted">
                <T>Custom model</T>
              </Text>
              {catalog.providers.length > 0 && (
                <Menu
                  title={gt("Provider")}
                  actions={catalog.providers.map((p) => ({
                    id: p.id,
                    title: p.label,
                    state: p.id === customProviderId ? ("on" as const) : ("off" as const),
                  }))}
                  onPressAction={({ nativeEvent }) => setCustomProvider(nativeEvent.event)}
                >
                  <Pressable accessibilityRole="button" className="rounded-xl bg-subtle px-3 py-2">
                    <Text className="text-sm text-foreground">
                      {catalog.providers.find((p) => p.id === customProviderId)?.label ??
                        gt("Provider")}
                    </Text>
                  </Pressable>
                </Menu>
              )}
              <View className="flex-row items-center gap-2">
                <TextInput
                  accessibilityLabel={gt("Custom model")}
                  placeholder={gt("Enter a model name")}
                  placeholderTextColorClassName="accent-foreground-muted"
                  value={custom}
                  onChangeText={setCustom}
                  autoCapitalize="none"
                  autoCorrect={false}
                  className="min-w-0 flex-1 rounded-xl border border-input-border bg-input px-3 py-2 font-mono text-sm text-foreground"
                />
                <Button
                  size="compact"
                  label={gt("Use")}
                  disabled={!canSelect || !custom.trim() || saving !== null}
                  onPress={() =>
                    void apply({
                      ...(customProviderId ? { provider: customProviderId } : {}),
                      model: custom.trim(),
                    })
                  }
                />
              </View>
            </View>
          ) : null}
        </NativeScrollView>
      )}
    </PullRequestSearchSheet>
  );
}
