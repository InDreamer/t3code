import { useAtomValue } from "@effect/atom-react";
import type { StaticScreenProps } from "@react-navigation/native";
import {
  filterPaModelProviders,
  formatPaModelLabel,
  resolvePaModelSelection,
} from "@t3tools/client-runtime/pa/models";
import {
  EnvironmentId,
  type PaModelProvider,
  type PaSelectBotModelInput,
} from "@t3tools/contracts";
import { T, useGT, useMessages } from "gt-react-native";
import { useEffect, useRef, useState } from "react";
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
import { paModelCatalogs, usePaModelCatalog } from "./usePaModelCatalog";

type ModelSelection = Pick<PaSelectBotModelInput, "provider" | "model" | "reasoningEffort">;

type PaModelParams = PaBotParams & { readonly query?: string };

/** Switches the Bot's (or the session's) model and reasoning effort. */
export function PaModelSheet({ route }: StaticScreenProps<PaModelParams>) {
  const { environmentId, botId } = route.params;
  const { chat, state } = usePaBotChat(environmentId, botId);
  return (
    <PaModelPicker
      key={JSON.stringify([environmentId, botId, state.activeSessionId ?? route.params.sessionId])}
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
  const { environmentId, botId } = params;
  const { bot, capabilities } = usePaBot(environmentId, botId);
  const sessionId = state.activeSessionId ?? params.sessionId ?? null;
  const canSelect = useAtomValue(paSelectModelPermissionAtom(EnvironmentId.make(environmentId)));
  const catalogKey = { environmentId, botId, sessionId };
  const entry = usePaModelCatalog(catalogKey);
  const catalog = entry.catalog;
  const [customProvider, setCustomProvider] = useState<string | null>(null);
  const [query, setQuery] = useState(params.query ?? "");
  const [actionError, setActionError] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const inFlightRef = useRef(false);
  const [confirm, setConfirm] = useState<{
    readonly input: ModelSelection;
    readonly message: string;
  } | null>(null);
  const [showDetected, setShowDetected] = useState(false);
  const [custom, setCustom] = useState("");
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- revalidates the composer's cached catalog when the sheet opens without duplicating an in-flight read
  useEffect(() => {
    const target = { environmentId, botId, sessionId };
    void paModelCatalogs.load(target, {
      revision: state.settingsVersion,
      force: !paModelCatalogs.read(target).loading,
    });
  }, [environmentId, botId, sessionId, state.settingsVersion]);
  const retry = () => {
    setActionError(null);
    void paModelCatalogs.refresh(catalogKey, state.settingsVersion);
  };

  const reasoning = sessionId ? state.sessionReasoning[sessionId] : undefined;
  const selection = resolvePaModelSelection({
    catalog,
    bot,
    scope: capabilities?.models.scope,
    sessionModel: state.sessions.find((s) => s.sessionId === sessionId)?.model,
    liveReasoningEffort:
      reasoning?.settingsVersion === state.settingsVersion ? reasoning.effort : null,
    resolve: messages,
  });
  const currentProvider = selection.provider;
  const currentModel = selection.model;
  const customProviderId = customProvider ?? currentProvider;
  const descriptor = selection.reasoning;
  const loadError = entry.error ? paErrorMessage(entry.error, gt("Could not load models")) : null;
  const error = actionError ?? loadError;
  const options = filterPaModelProviders(catalog?.providers ?? [], query);
  const needle = query.trim();
  const primary = options.filter((option) => option.tier === "primary");
  const detected = options.filter((option) => option.tier === "detected");
  const groups = needle ? options : [...primary, ...(showDetected ? detected : [])];

  const canApply =
    canSelect && catalog !== null && (catalog.scope !== "session" || sessionId !== null);
  // Hermes saves a model only with its provider.
  const canUseCustom = custom.trim().length > 0 && customProviderId !== null;
  // The sheet is keyed by session; a late result must not touch the next session's sheet.
  const isStale = () => chat.getState().activeSessionId !== state.activeSessionId;
  const apply = async (input: ModelSelection, confirmed = false) => {
    if (inFlightRef.current || !canApply || !catalog) return;
    inFlightRef.current = true;
    const target = { environmentId, botId, sessionId };
    const key = input.reasoningEffort ?? `${input.provider ?? ""}/${input.model ?? ""}`;
    setSaving(key);
    setActionError(null);
    const result = await paClient(environmentId)
      .selectBotModel({
        botId,
        ...(sessionId ? { sessionId } : {}),
        ...input,
        ...(confirmed ? { confirm: true } : {}),
      })
      .catch((cause: unknown) => {
        if (!isStale()) {
          setActionError(
            paErrorMessage(
              cause,
              input.reasoningEffort
                ? gt("Could not change reasoning effort")
                : gt("Could not switch model"),
            ),
          );
        }
        return null;
      });
    inFlightRef.current = false;
    if (result?.status === "applied") {
      paModelCatalogs.applyCurrent(target, result.current);
      if (input.reasoningEffort) {
        if (catalog.scope !== "session") chat.bumpSettings();
        chat.setReasoning(sessionId, result.current.reasoningEffort ?? input.reasoningEffort);
      } else {
        if (catalog.scope === "session" && sessionId) {
          chat.patchSession(sessionId, { model: result.current.model });
        } else {
          patchPaBot(environmentId, botId, {
            model: result.current.model,
            provider: result.current.provider,
          });
        }
        chat.bumpSettings();
      }
    }
    if (isStale()) return;
    setSaving(null);
    if (!result) return;
    if (result.status === "confirmRequired") {
      setConfirm({ input, message: result.message });
      return;
    }
    setConfirm(null);
    if (!input.reasoningEffort) setCustom("");
  };

  const renderGroup = (option: PaModelProvider) => (
    <View key={option.id} className="gap-1 pb-3">
      <View className="flex-row items-center justify-between px-1">
        <Text className="text-xs font-t3-medium text-foreground-muted">{option.label}</Text>
        {option.id === currentProvider ? (
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
        const title = model.label ?? formatPaModelLabel(model.id);
        return (
          <SelectionRow
            key={model.id}
            title={title}
            {...(title === model.id ? {} : { subtitle: model.id })}
            role="radio"
            selected={selected}
            disabled={!canApply || saving !== null}
            isFirst={index === 0}
            isLast={index === option.models.length - 1}
            onPress={() => {
              if (!selected) void apply({ provider: option.id, model: model.id });
            }}
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
          {descriptor ? (
            <View className="gap-1.5">
              <Text className="px-1 text-xs font-t3-medium text-foreground-muted">
                {descriptor.label}
              </Text>
              <View
                accessibilityRole="radiogroup"
                accessibilityLabel={descriptor.label}
                className="flex-row flex-wrap gap-1.5"
              >
                {descriptor.options.map((level) => {
                  const selected = level.id === descriptor.currentValue;
                  return (
                    <Pressable
                      key={level.id}
                      accessibilityRole="radio"
                      accessibilityLabel={level.label}
                      accessibilityState={{
                        checked: selected,
                        disabled: !canApply || saving !== null,
                        busy: saving === level.id,
                      }}
                      disabled={!canApply || saving !== null || selected}
                      onPress={() => void apply({ reasoningEffort: level.id })}
                      className={cn(
                        "rounded-full border px-3 py-1.5 active:opacity-70",
                        selected ? "border-primary bg-subtle" : "border-border-subtle",
                        saving === level.id && "opacity-60",
                      )}
                    >
                      <Text
                        className={cn(
                          "text-xs",
                          selected ? "font-t3-medium text-foreground" : "text-foreground-muted",
                        )}
                      >
                        {level.label}
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
                  disabled={!canApply || saving !== null}
                  onPress={() => void apply(confirm.input, true)}
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
          {!catalog && entry.loading ? <AppActivityIndicator className="my-8" /> : null}
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
                  disabled={!canApply || !canUseCustom || saving !== null}
                  onPress={() => {
                    if (customProviderId)
                      void apply({ provider: customProviderId, model: custom.trim() });
                  }}
                />
              </View>
            </View>
          ) : null}
        </NativeScrollView>
      )}
    </PullRequestSearchSheet>
  );
}
