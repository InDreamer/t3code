import { useAtomValue } from "@effect/atom-react";
import { useNavigation, StackActions, type StaticScreenProps } from "@react-navigation/native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import {
  filterPaModelProviders,
  formatPaModelLabel,
  paProviderIconKey,
  resolvePaModelSelection,
} from "@t3tools/client-runtime/pa/models";
import {
  EnvironmentId,
  type PaModelProvider,
  type PaSelectBotModelInput,
} from "@t3tools/contracts";
import { T, useGT, useMessages } from "gt-react-native";
import { createContext, use, useEffect, useRef, useState } from "react";
import { Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppBar, type AppBarSearch } from "../../components/ui/AppBar";
import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text, AppTextInput as TextInput } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { READABLE_WIDTH_STYLE } from "../../components/ui/listMetrics";
import { Menu } from "../../components/ui/Menu";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { useSearchToolbarInset } from "../../components/ui/useBarInset";
import { cn } from "../../lib/cn";
import { createV5StackNavigator } from "../../native/createV5StackNavigator";
import { NativeScrollView } from "../../native/NativeScrollViewMarker";
import { useSheetStackOptions } from "../layout/nested-stacks";
import { ChoiceRow } from "../threads/ThreadSettingsRows";
import { DisclosureRow, ProviderHeader } from "../threads/ThreadSettingsSections";
import { paClient, paErrorMessage, paSelectModelPermissionAtom } from "./paApi";
import type { PaBotParams } from "./paBotParams";
import { patchPaBot, usePaBot } from "./paRosterStore";
import { usePaBotChat } from "./usePaBotChat";
import { paModelCatalogs, usePaModelCatalog } from "./usePaModelCatalog";

type ModelSelection = Pick<PaSelectBotModelInput, "provider" | "model" | "reasoningEffort">;

type PaModelParams = PaBotParams & {
  readonly query?: string;
  readonly draftTab?: "profile" | "toggles" | "schedules";
  readonly fromSettings?: "keepDrafts" | "close";
};

type PaModelStackParams = {
  PaModelList: undefined;
  PaModelEffort: undefined;
};

const PaModelStack = createV5StackNavigator<PaModelStackParams>();
const PaModelPickerContext = createContext<ReturnType<typeof usePaModelPicker> | null>(null);

function usePaModelPickerContext() {
  const picker = use(PaModelPickerContext);
  if (!picker) throw new Error("usePaModelPickerContext must be used inside PaModelSheet.");
  return picker;
}

/** Switches the Bot's (or the session's) model and reasoning effort, laid out like Code's picker. */
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

function PaModelPicker(
  props: { readonly params: PaModelParams } & ReturnType<typeof usePaBotChat>,
) {
  const gt = useGT();
  const picker = usePaModelPicker(props);
  const screenOptions = useSheetStackOptions();
  return (
    <PaModelPickerContext value={picker}>
      <PaModelStack.Navigator initialRouteName="PaModelList" screenOptions={screenOptions}>
        <PaModelStack.Screen
          name="PaModelList"
          component={PaModelListScreen}
          options={{ headerBackVisible: false, title: gt("Model") }}
        />
        <PaModelStack.Screen
          name="PaModelEffort"
          component={PaModelEffortScreen}
          options={{ title: picker.descriptor?.label ?? gt("Reasoning effort") }}
        />
      </PaModelStack.Navigator>
    </PaModelPickerContext>
  );
}

function usePaModelPicker({
  params,
  chat,
  state,
}: { readonly params: PaModelParams } & ReturnType<typeof usePaBotChat>) {
  // The sheet's own route: closing and returning to Bot settings act on the outer stack.
  const navigation = useNavigation();
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
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
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
  const customProviderId = customProvider ?? selection.provider;
  const loadError = entry.error ? paErrorMessage(entry.error, gt("Could not load models")) : null;

  const canApply =
    canSelect && catalog !== null && (catalog.scope !== "session" || sessionId !== null);
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
    if (params.fromSettings && navigation.isFocused()) {
      navigation.dispatch(
        params.fromSettings === "keepDrafts"
          ? StackActions.popTo(
              "PaBotSettings",
              { environmentId, botId, tab: params.draftTab ?? "profile" },
              { merge: true },
            )
          : StackActions.pop(2),
      );
    }
  };

  return {
    catalog,
    loading: entry.loading,
    selection,
    descriptor: selection.reasoning,
    error: actionError ?? loadError,
    retry,
    canSelect,
    canApply,
    saving,
    apply,
    confirm,
    dismissConfirm: () => setConfirm(null),
    query,
    setQuery,
    expanded,
    toggleProvider: (id: string) =>
      setExpanded((open) => {
        const next = new Set(open);
        if (!next.delete(id)) next.add(id);
        return next;
      }),
    custom,
    setCustom,
    customProviderId,
    setCustomProvider,
    close: () => navigation.goBack(),
  };
}

function PaModelListScreen({
  navigation,
}: NativeStackScreenProps<PaModelStackParams, "PaModelList">) {
  const gt = useGT();
  const insets = useSafeAreaInsets();
  const picker = usePaModelPickerContext();
  const { catalog, descriptor, saving, canApply } = picker;
  const search: AppBarSearch = {
    value: picker.query,
    onChangeText: picker.setQuery,
    placeholder: gt("Search models or providers"),
    clearAccessibilityLabel: gt("Clear search"),
    mode: "inline",
    compactToolbar: true,
  };
  const searchToolbarInset = useSearchToolbarInset(search);
  const needle = picker.query.trim();
  const groups = filterPaModelProviders(catalog?.providers ?? [], picker.query);
  const currentProvider = picker.selection.provider;
  const currentModel = picker.selection.model;
  // Hermes saves a model only with its provider.
  const canUseCustom = picker.custom.trim().length > 0 && picker.customProviderId !== null;

  const renderProvider = (provider: PaModelProvider) => {
    // Detected providers fold away like Code's secondary providers, unless a search is open.
    const collapsible = provider.tier === "detected" && !needle;
    const collapsed = collapsible && !picker.expanded.has(provider.id);
    const iconKey = paProviderIconKey(provider.id);
    return (
      <View key={provider.id} className="pb-2">
        <ProviderHeader
          driver={iconKey ?? undefined}
          iconUrl={undefined}
          nested={iconKey === null}
          label={provider.label}
          collapsible={collapsible}
          collapsed={collapsed}
          modelCount={provider.models.length}
          onToggle={() => picker.toggleProvider(provider.id)}
        />
        {collapsed
          ? null
          : provider.models.map((model, index) => {
              const selected =
                model.id === currentModel &&
                (currentProvider === null || provider.id === currentProvider);
              const title = model.label ?? formatPaModelLabel(model.id);
              return (
                <PaModelRow
                  key={model.id}
                  title={title}
                  subtitle={title === model.id ? undefined : model.id}
                  selected={selected}
                  saving={saving === `${provider.id}/${model.id}`}
                  disabled={!canApply || saving !== null}
                  isFirst={index === 0}
                  isLast={index === provider.models.length - 1}
                  onPress={() => {
                    if (!selected) void picker.apply({ provider: provider.id, model: model.id });
                  }}
                />
              );
            })}
      </View>
    );
  };

  return (
    <>
      <AppBar
        title={gt("Model")}
        onClose={picker.close}
        closeAccessibilityLabel={gt("Close model picker")}
        search={search}
        confirm={{
          label: gt("Done", { $context: "button that closes the sheet" }),
          onPress: picker.close,
        }}
        hideBottomBorder
      />
      <ScreenContent>
        <NativeScrollView
          className="flex-1 bg-sheet"
          style={READABLE_WIDTH_STYLE}
          contentInsetAdjustmentBehavior="automatic"
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{
            paddingTop: 4,
            paddingBottom: insets.bottom + searchToolbarInset + 12,
          }}
        >
          {picker.confirm ? (
            <View className="mx-4 mb-3 gap-3 rounded-2xl border border-warning-border bg-grouped-card p-4">
              <View className="flex-row items-start gap-2">
                <SymbolView
                  name="exclamationmark.triangle"
                  size={14}
                  tintColorClassName="accent-warning-foreground"
                />
                <Text selectable className="min-w-0 flex-1 text-sm text-foreground">
                  {picker.confirm.message}
                </Text>
              </View>
              <View className="flex-row justify-end gap-2">
                <Button
                  size="compact"
                  tone="text"
                  label={gt("Cancel")}
                  onPress={picker.dismissConfirm}
                />
                <Button
                  size="compact"
                  label={gt("Confirm switch")}
                  disabled={!canApply || saving !== null}
                  onPress={() => {
                    if (picker.confirm) void picker.apply(picker.confirm.input, true);
                  }}
                />
              </View>
            </View>
          ) : null}
          {picker.error ? (
            <View className="mx-4 mb-3 flex-row items-center gap-2 rounded-2xl bg-grouped-card py-2 pl-4 pr-2">
              <Text selectable className="min-w-0 flex-1 text-sm text-danger">
                {picker.error}
              </Text>
              <Button size="compact" tone="text" label={gt("Retry")} onPress={picker.retry} />
            </View>
          ) : null}
          {!catalog && picker.loading ? <AppActivityIndicator className="my-8" /> : null}
          {catalog && groups.length === 0 ? (
            <View className="items-center px-8 py-14">
              <Text className="text-center text-sm text-foreground-muted">
                {needle ? <T>No matching models</T> : <T>No models available</T>}
              </Text>
            </View>
          ) : null}
          {groups.map(renderProvider)}
          {descriptor ? (
            <>
              <Text className="px-5 pb-2 pt-5 text-sm font-t3-medium text-foreground-muted">
                <T>Options</T>
              </Text>
              <View className="mx-4 overflow-hidden rounded-2xl bg-grouped-card">
                <DisclosureRow
                  isLast
                  label={descriptor.label}
                  value={
                    descriptor.options.find((option) => option.id === descriptor.currentValue)
                      ?.label ??
                    picker.selection.reasoningLabel ??
                    undefined
                  }
                  onPress={() => navigation.navigate("PaModelEffort")}
                />
              </View>
            </>
          ) : null}
          {picker.canSelect && catalog?.allowCustom ? (
            <>
              <Text className="px-5 pb-2 pt-7 text-sm font-t3-medium text-foreground-muted">
                <T>Custom model</T>
              </Text>
              <View className="mx-4 overflow-hidden rounded-2xl bg-grouped-card">
                {catalog.providers.length > 0 ? (
                  <Menu
                    title={gt("Provider")}
                    actions={catalog.providers.map((p) => ({
                      id: p.id,
                      title: p.label,
                      state: p.id === picker.customProviderId ? ("on" as const) : ("off" as const),
                    }))}
                    onPressAction={({ nativeEvent }) => picker.setCustomProvider(nativeEvent.event)}
                  >
                    <Pressable
                      accessibilityRole="button"
                      className="min-h-[44px] flex-row items-center gap-2 border-b border-border-subtle px-4 py-2 active:bg-subtle"
                    >
                      <Text className="text-sm font-t3-medium text-foreground">
                        <T>Provider</T>
                      </Text>
                      <View className="flex-1" />
                      <Text className="text-sm text-foreground-muted" numberOfLines={1}>
                        {catalog.providers.find((p) => p.id === picker.customProviderId)?.label ??
                          gt("Choose")}
                      </Text>
                      <SymbolView
                        name="chevron.down"
                        size={12}
                        tintColorClassName="accent-icon-subtle"
                        type="monochrome"
                      />
                    </Pressable>
                  </Menu>
                ) : null}
                <View className="min-h-[44px] flex-row items-center gap-2 py-1.5 pl-4 pr-2">
                  <TextInput
                    accessibilityLabel={gt("Custom model")}
                    placeholder={gt("Enter a model name")}
                    placeholderTextColorClassName="accent-foreground-muted"
                    value={picker.custom}
                    onChangeText={picker.setCustom}
                    autoCapitalize="none"
                    autoCorrect={false}
                    className="min-w-0 flex-1 py-1.5 font-mono text-sm text-foreground"
                  />
                  <Button
                    size="compact"
                    label={gt("Use")}
                    disabled={!canApply || !canUseCustom || saving !== null}
                    onPress={() => {
                      if (picker.customProviderId)
                        void picker.apply({
                          provider: picker.customProviderId,
                          model: picker.custom.trim(),
                        });
                    }}
                  />
                </View>
              </View>
            </>
          ) : null}
        </NativeScrollView>
      </ScreenContent>
    </>
  );
}

function PaModelEffortScreen({
  navigation,
}: NativeStackScreenProps<PaModelStackParams, "PaModelEffort">) {
  const gt = useGT();
  const insets = useSafeAreaInsets();
  const picker = usePaModelPickerContext();
  const descriptor = picker.descriptor;
  const levels = descriptor?.options ?? [];
  return (
    <>
      <AppBar
        title={descriptor?.label ?? gt("Reasoning effort")}
        onBack={() => navigation.goBack()}
        hideBottomBorder
      />
      <ScreenContent>
        <NativeScrollView
          className="flex-1 bg-sheet"
          style={READABLE_WIDTH_STYLE}
          contentInsetAdjustmentBehavior="automatic"
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{
            paddingBottom: insets.bottom + 12,
            paddingHorizontal: 16,
            paddingTop: 16,
          }}
        >
          <View className="overflow-hidden rounded-2xl bg-grouped-card">
            {levels.map((level, index) => {
              const selected = level.id === descriptor?.currentValue;
              return (
                <ChoiceRow
                  key={level.id}
                  label={level.label}
                  isLast={index === levels.length - 1}
                  selected={selected}
                  disabled={!picker.canApply || picker.saving !== null}
                  onPress={() => {
                    // Like Code's submenus, the pick returns to the list, which shows its outcome.
                    navigation.goBack();
                    if (!selected) void picker.apply({ reasoningEffort: level.id });
                  }}
                />
              );
            })}
          </View>
        </NativeScrollView>
      </ScreenContent>
    </>
  );
}

function PaModelRow(props: {
  readonly title: string;
  readonly subtitle: string | undefined;
  readonly selected: boolean;
  readonly saving: boolean;
  readonly disabled: boolean;
  readonly isFirst: boolean;
  readonly isLast: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityLabel={[props.title, props.subtitle].filter(Boolean).join(", ")}
      accessibilityRole="radio"
      accessibilityState={{ checked: props.selected, disabled: props.disabled, busy: props.saving }}
      disabled={props.disabled}
      onPress={props.onPress}
      className={cn(
        "mx-4 min-h-[44px] flex-row items-center gap-2 bg-grouped-card px-4 active:opacity-70 android:min-h-[48px]",
        props.isFirst && "rounded-t-2xl",
        props.isLast ? "rounded-b-2xl" : "border-b border-border-subtle",
      )}
    >
      <View className="min-w-0 flex-1 py-2">
        <Text className="text-base font-t3-medium text-foreground" numberOfLines={1}>
          {props.title}
        </Text>
        {props.subtitle ? (
          <Text className="text-xs text-foreground-muted" numberOfLines={1}>
            {props.subtitle}
          </Text>
        ) : null}
      </View>
      {props.saving ? (
        <AppActivityIndicator colorClassName="accent-icon" />
      ) : props.selected ? (
        <SymbolView
          name="checkmark"
          size={16}
          tintColorClassName="accent-icon"
          type="monochrome"
          weight="semibold"
        />
      ) : null}
    </Pressable>
  );
}
