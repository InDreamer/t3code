import { useAtomValue } from "@effect/atom-react";
import { CommonActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  isPaAvatarObsidian,
  paAvatarColorOptions,
  PA_AVATAR_SHAPES,
} from "@t3tools/client-runtime/pa/avatar";
import {
  changedPaConfigSections,
  filterToggleItems,
  findPaMinEnabledViolation,
  parseSafePaConsoleUrl,
  paConfigDrafts,
  paginateItems,
  rebasePaConfigDrafts,
  TOGGLE_PAGE_SIZE,
  type ToggleFilterMode,
} from "@t3tools/client-runtime/pa/settings";
import {
  EnvironmentId,
  paProfileDescription,
  type PaAvatarShape,
  type PaBotConfig,
  type PaBotSummary,
  type PaCapabilities,
  type PaConfigSection,
  type PaConfigSectionValue,
  type PaMutateScheduleInput,
  type PaSchedule,
} from "@t3tools/contracts";
import { T, useGT, useMessages } from "gt-react-native";
import { useEffect, useEffectEvent, useState, type Dispatch, type SetStateAction } from "react";
import { Keyboard, Pressable, View } from "react-native";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppBar } from "../../components/ui/AppBar";
import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text, AppTextInput as TextInput } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/EmptyState";
import { ListSection } from "../../components/ui/ListSection";
import { ListToggleRow } from "../../components/ui/ListToggleRow";
import { Menu } from "../../components/ui/Menu";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { SegmentedControl } from "../../components/ui/SegmentedControl";
import { cn } from "../../lib/cn";
import { tryOpenExternalUrl } from "../../lib/openExternalUrl";
import { useMountedRef } from "../../lib/useMountedRef";
import { NativeScrollView } from "../../native/NativeScrollViewMarker";
import { BotAvatar } from "./BotAvatar";
import {
  paClient,
  paErrorMessage,
  paUpdateMetaPermissionAtom,
  paSelectModelPermissionAtom,
  paPatchConfigPermissionAtom,
  paMutateSchedulePermissionAtom,
} from "./paApi";
import { paBotKey, type PaBotParams } from "./paBotParams";
import { patchPaBot, refreshPaRoster, usePaBot } from "./paRosterStore";
import { bumpPaBotSettingsIfActive } from "./usePaBotChat";

type SettingsTab = "profile" | "model" | "toggles" | "schedules";
const INPUT = "rounded-xl border border-input-border bg-input px-3 py-2.5 text-sm text-foreground";
const TOGGLE_FILTER_THRESHOLD = 8;

function FieldLabel(props: { readonly children: string; readonly detail?: string }) {
  return (
    <Text className="px-1 text-xs font-t3-medium text-foreground-muted">
      {props.detail ? `${props.children} · ${props.detail}` : props.children}
    </Text>
  );
}

function ToggleListSection(props: {
  readonly section: Extract<PaConfigSection, { kind: "toggleList" }>;
  readonly value: ReadonlyArray<string>;
  readonly onChange: (enabled: ReadonlyArray<string>) => void;
}) {
  const gt = useGT();
  const [filter, setFilter] = useState("");
  const [mode, setMode] = useState<ToggleFilterMode>("all");
  const [page, setPage] = useState(1);
  const enabled = new Set(props.value);
  const items = filterToggleItems(props.section.items, enabled, filter, mode);
  const slice = paginateItems(items, page, TOGGLE_PAGE_SIZE);
  return (
    <View className="gap-2">
      <FieldLabel
        detail={gt("{enabled} of {total} enabled", {
          enabled: enabled.size,
          total: props.section.items.length,
        })}
      >
        {props.section.label}
      </FieldLabel>
      {props.section.description ? (
        <Text className="px-1 text-xs text-foreground-tertiary">{props.section.description}</Text>
      ) : null}
      {props.section.items.length > TOGGLE_FILTER_THRESHOLD ? (
        <>
          <TextInput
            accessibilityLabel={gt("Search {section}", { section: props.section.label })}
            placeholder={gt("Search names, categories or descriptions…")}
            placeholderTextColorClassName="accent-foreground-muted"
            value={filter}
            onChangeText={(value) => {
              setFilter(value);
              setPage(1);
            }}
            className={INPUT}
          />
          <SegmentedControl
            size="compact"
            options={[
              { value: "all", label: gt("All") },
              { value: "enabled", label: gt("Enabled") },
              { value: "disabled", label: gt("Disabled") },
            ]}
            selected={mode}
            onSelect={(value) => {
              setMode(value);
              setPage(1);
            }}
          />
        </>
      ) : null}
      <ListSection>
        {slice.items.length === 0 ? (
          <Text className="px-4 py-3 text-sm text-foreground-muted">
            <T>Nothing matches</T>
          </Text>
        ) : (
          slice.items.map((item) => (
            <ListToggleRow
              key={item.id}
              label={item.label}
              {...(item.description ? { description: item.description } : {})}
              value={enabled.has(item.id)}
              onValueChange={(on) =>
                props.onChange(
                  on
                    ? [...props.value.filter((id) => id !== item.id), item.id]
                    : props.value.filter((id) => id !== item.id),
                )
              }
            />
          ))
        )}
      </ListSection>
      {slice.totalPages > 1 ? (
        <View className="flex-row items-center justify-center gap-3">
          <Button
            size="compact"
            tone="text"
            label={gt("Previous")}
            disabled={slice.page <= 1}
            onPress={() => setPage(slice.page - 1)}
          />
          <Text className="text-xs tabular-nums text-foreground-muted">
            {gt("{page} of {total}", { page: slice.page, total: slice.totalPages })}
          </Text>
          <Button
            size="compact"
            tone="text"
            label={gt("Next")}
            disabled={slice.page >= slice.totalPages}
            onPress={() => setPage(slice.page + 1)}
          />
        </View>
      ) : null}
    </View>
  );
}

function OptionsSection(props: {
  readonly section: Extract<PaConfigSection, { kind: "options" }>;
  readonly value: Readonly<Record<string, string | boolean>>;
  readonly onChange: (values: Readonly<Record<string, string | boolean>>) => void;
}) {
  return (
    <View className="gap-3">
      {props.section.fields.map((field) => {
        const current = props.value[field.id];
        const set = (next: string | boolean) =>
          props.onChange({ ...props.value, [field.id]: next });
        switch (field.kind) {
          case "text":
            return (
              <View key={field.id} className="gap-1.5">
                <FieldLabel>{field.label}</FieldLabel>
                <TextInput
                  accessibilityLabel={field.label}
                  value={typeof current === "string" ? current : ""}
                  placeholder={field.placeholder}
                  placeholderTextColorClassName="accent-foreground-muted"
                  onChangeText={set}
                  className={INPUT}
                />
              </View>
            );
          case "toggle":
            return (
              <ListSection key={field.id}>
                <ListToggleRow label={field.label} value={current === true} onValueChange={set} />
              </ListSection>
            );
          case "select": {
            const choice = field.choices.find((item) => item.id === current);
            return (
              <View key={field.id} className="gap-1.5">
                <FieldLabel>{field.label}</FieldLabel>
                <Menu
                  title={field.label}
                  actions={field.choices.map((item) => ({
                    id: item.id,
                    title: item.label,
                    state: item.id === current ? ("on" as const) : ("off" as const),
                  }))}
                  onPressAction={({ nativeEvent }) => set(nativeEvent.event)}
                >
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={field.label}
                    className={cn(INPUT, "flex-row items-center justify-between")}
                  >
                    <Text className="text-sm text-foreground">{choice?.label ?? ""}</Text>
                    <SymbolView
                      name="chevron.down"
                      size={11}
                      tintColorClassName="accent-icon-subtle"
                    />
                  </Pressable>
                </Menu>
              </View>
            );
          }
        }
      })}
    </View>
  );
}

const EMPTY_SCHEDULE = { name: "", spec: "every 1h", prompt: "", deliver: "" };

function Schedules(props: {
  readonly draft: typeof EMPTY_SCHEDULE;
  readonly onDraftChange: Dispatch<SetStateAction<typeof EMPTY_SCHEDULE>>;
  readonly schedules: ReadonlyArray<PaSchedule>;
  readonly busy: boolean;
  readonly onMutate: (
    input: Omit<PaMutateScheduleInput, "botId">,
    fallback: string,
  ) => Promise<boolean>;
}) {
  const gt = useGT();
  const [page, setPage] = useState(1);
  const slice = paginateItems(props.schedules, page, 5);
  if (page !== slice.page) setPage(slice.page);
  const { name, spec, prompt, deliver } = props.draft;
  const add = async () => {
    const added = await props.onMutate(
      {
        action: "add",
        ...(name.trim() ? { name: name.trim() } : {}),
        schedule: spec.trim(),
        prompt: prompt.trim(),
        ...(deliver.trim() ? { deliver: deliver.trim() } : {}),
      },
      gt("Could not add scheduled task"),
    );
    if (added) {
      setPage(1);
      props.onDraftChange((current) => ({
        name: current.name === name ? "" : current.name,
        spec: current.spec,
        prompt: current.prompt === prompt ? "" : current.prompt,
        deliver: current.deliver === deliver ? "" : current.deliver,
      }));
    }
  };
  return (
    <View className="gap-4">
      <View className="gap-2 rounded-xl border border-border-subtle p-3">
        <FieldLabel>{gt("New scheduled task")}</FieldLabel>
        <TextInput
          accessibilityLabel={gt("Task name")}
          placeholder={gt("Task name (e.g. daily briefing)")}
          placeholderTextColorClassName="accent-foreground-muted"
          value={name}
          onChangeText={(name) => props.onDraftChange({ ...props.draft, name })}
          className={INPUT}
        />
        <TextInput
          accessibilityLabel={gt("Schedule")}
          placeholder={gt("Schedule (e.g. every 1h or 0 9 * * *)")}
          placeholderTextColorClassName="accent-foreground-muted"
          value={spec}
          onChangeText={(spec) => props.onDraftChange({ ...props.draft, spec })}
          autoCapitalize="none"
          autoCorrect={false}
          className={INPUT}
        />
        <TextInput
          accessibilityLabel={gt("Instructions")}
          placeholder={gt("Instructions for the bot when the task runs…")}
          placeholderTextColorClassName="accent-foreground-muted"
          value={prompt}
          onChangeText={(prompt) => props.onDraftChange({ ...props.draft, prompt })}
          multiline
          className={cn(INPUT, "min-h-[60px]")}
        />
        <TextInput
          accessibilityLabel={gt("Delivery target")}
          placeholder={gt("Delivery target (optional, e.g. local, origin or {example})", {
            example: "telegram:<id>",
          })}
          placeholderTextColorClassName="accent-foreground-muted"
          value={deliver}
          maxLength={200}
          onChangeText={(deliver) => props.onDraftChange({ ...props.draft, deliver })}
          autoCapitalize="none"
          className={INPUT}
        />
        <Button
          tone="secondary"
          icon="plus"
          label={gt("Add scheduled task")}
          loading={props.busy}
          disabled={props.busy || !prompt.trim() || !spec.trim()}
          onPress={() => void add()}
        />
      </View>
      <FieldLabel>{gt("Scheduled tasks ({count})", { count: props.schedules.length })}</FieldLabel>
      {props.schedules.length === 0 ? (
        <EmptyState
          title={gt("No scheduled tasks")}
          detail={gt("This bot has no scheduled tasks yet")}
          variant="plain"
        />
      ) : (
        <View className="gap-2">
          {slice.items.map((job) => (
            <View
              key={job.id}
              className={cn(
                "gap-1 rounded-xl border border-border-subtle bg-card p-3",
                !job.enabled && "opacity-70",
              )}
            >
              <View className="flex-row items-center gap-2">
                <View className="min-w-0 flex-1">
                  <Text className="text-sm font-t3-medium text-foreground" numberOfLines={1}>
                    {job.enabled ? job.name : gt("{name} (paused)", { name: job.name })}
                  </Text>
                  <Text className="text-xs text-foreground-muted" numberOfLines={1}>
                    {job.nextRunAt
                      ? gt("{schedule} · Next run {nextRunAt}", {
                          schedule: job.schedule,
                          nextRunAt: job.nextRunAt,
                        })
                      : job.schedule}
                  </Text>
                </View>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={job.enabled ? gt("Pause") : gt("Resume")}
                  disabled={props.busy}
                  hitSlop={8}
                  onPress={() =>
                    void props.onMutate(
                      { action: job.enabled ? "pause" : "resume", scheduleId: job.id },
                      gt("Schedule operation failed"),
                    )
                  }
                >
                  <SymbolView
                    name={job.enabled ? "pause" : "play"}
                    size={15}
                    tintColorClassName="accent-icon"
                  />
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={gt("Delete")}
                  disabled={props.busy}
                  hitSlop={8}
                  onPress={() =>
                    void props.onMutate(
                      { action: "remove", scheduleId: job.id },
                      gt("Schedule operation failed"),
                    )
                  }
                >
                  <SymbolView name="trash" size={15} tintColorClassName="accent-danger" />
                </Pressable>
              </View>
              {job.prompt ? (
                <Text className="text-xs text-foreground-muted" numberOfLines={2}>
                  {job.prompt}
                </Text>
              ) : null}
              {job.deliver ? (
                <Text className="text-xs text-foreground-tertiary" numberOfLines={1}>
                  {gt("Deliver to {deliver}", { deliver: job.deliver })}
                </Text>
              ) : null}
            </View>
          ))}
        </View>
      )}
      {slice.totalPages > 1 && (
        <View className="flex-row items-center justify-between gap-2">
          <Button
            size="compact"
            tone="text"
            label={gt("Previous")}
            disabled={slice.page <= 1}
            onPress={() => setPage(slice.page - 1)}
          />
          <Text className="text-xs tabular-nums text-foreground-muted">
            {gt("{page} of {total}", { page: slice.page, total: slice.totalPages })}
          </Text>
          <Button
            size="compact"
            tone="text"
            label={gt("Next")}
            disabled={slice.page >= slice.totalPages}
            onPress={() => setPage(slice.page + 1)}
          />
        </View>
      )}
    </View>
  );
}

/** A Bot's name, look, instructions, capabilities and scheduled tasks. */
export function PaBotSettingsSheet({
  route,
}: StaticScreenProps<PaBotParams & { tab?: SettingsTab }>) {
  const gt = useGT();
  const navigation = useNavigation();
  const { bot, capabilities, entry } = usePaBot(route.params.environmentId, route.params.botId);
  if (!bot) {
    return (
      <View className="flex-1 bg-sheet">
        <AppBar title={gt("Bot settings")} onClose={() => navigation.goBack()} />
        <ScreenContent surface="sheet">
          {entry.loading ? (
            <AppActivityIndicator className="my-12" />
          ) : (
            <EmptyState
              title={gt("Bot not found")}
              detail={entry.error ?? gt("This bot is no longer available.")}
              variant="plain"
            />
          )}
        </ScreenContent>
      </View>
    );
  }
  return (
    <PaBotSettings
      key={paBotKey(route.params.environmentId, bot.botId)}
      environmentId={route.params.environmentId}
      bot={bot}
      capabilities={capabilities}
      tab={route.params.tab ?? "profile"}
      onSelectTab={(tab) => navigation.dispatch(CommonActions.setParams({ tab }))}
    />
  );
}

function PaBotSettings(props: {
  readonly environmentId: string;
  readonly tab: SettingsTab;
  readonly onSelectTab: (tab: SettingsTab) => void;
  readonly bot: PaBotSummary;
  readonly capabilities: PaCapabilities | null;
}) {
  const gt = useGT();
  const messages = useMessages();
  const navigation = useNavigation();
  const { bot, environmentId } = props;
  const client = paClient(environmentId);
  const mounted = useMountedRef();
  const id = EnvironmentId.make(environmentId);
  const canEditMeta = useAtomValue(paUpdateMetaPermissionAtom(id));
  const canEditConfig = useAtomValue(paPatchConfigPermissionAtom(id));
  const canSelectModel = useAtomValue(paSelectModelPermissionAtom(id));
  const canMutateSchedule = useAtomValue(paMutateSchedulePermissionAtom(id));
  const configSupported = canEditConfig && props.capabilities?.config.supported === true;
  const modelsSupported = canSelectModel && props.capabilities?.models.supported === true;
  const schedulesSupported = canMutateSchedule && props.capabilities?.schedules.supported === true;
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState(bot.name);
  const [avatarColor, setAvatarColor] = useState(bot.avatarColor);
  const [avatarShape, setAvatarShape] = useState<PaAvatarShape>(bot.avatarShape);
  const [pinned, setPinned] = useState(bot.pinned);
  const [savedMeta, setSavedMeta] = useState({
    name: bot.name,
    avatarColor: bot.avatarColor,
    avatarShape: bot.avatarShape,
    pinned: bot.pinned,
  });
  const [config, setConfig] = useState<PaBotConfig | null>(null);
  const [drafts, setDrafts] = useState<Record<string, PaConfigSectionValue>>({});
  const [schedules, setSchedules] = useState<ReadonlyArray<PaSchedule> | null>(null);
  const [savedScheduleSpec, setSavedScheduleSpec] = useState(EMPTY_SCHEDULE.spec);
  const [scheduleDraft, setScheduleDraft] = useState(EMPTY_SCHEDULE);
  const [scheduleBusy, setScheduleBusy] = useState(false);

  const loading = !error && ((configSupported && !config) || (schedulesSupported && !schedules));
  const load = useEffectEvent(
    (signal: AbortSignal, readConfig: boolean, readSchedules: boolean) => {
      const loads: Array<Promise<unknown>> = [];
      if (readConfig) {
        loads.push(
          client.getBotConfig(bot.botId).then((loaded) => {
            if (signal.aborted) return;
            setConfig(loaded);
            setDrafts(paConfigDrafts(loaded));
          }),
        );
      }
      if (readSchedules)
        loads.push(
          client.listSchedules(bot.botId).then((next) => {
            if (!signal.aborted) setSchedules(next);
          }),
        );
      void Promise.all(loads).catch(
        (cause: unknown) =>
          !signal.aborted && setError(paErrorMessage(cause, gt("Could not load bot settings"))),
      );
    },
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the Bot's config sections and schedules when the sheet opens
  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal, configSupported, schedulesSupported);
    return () => controller.abort();
  }, [configSupported, schedulesSupported]);

  const sections = configSupported ? (config?.sections ?? []) : [];
  const profileSections = sections.filter((section) => section.kind !== "toggleList");
  const toggleSections = sections.filter(
    (section): section is Extract<PaConfigSection, { kind: "toggleList" }> =>
      section.kind === "toggleList",
  );
  const tabs: ReadonlyArray<{ readonly value: SettingsTab; readonly label: string }> = [
    { value: "profile", label: gt("Profile") },
    ...(modelsSupported ? [{ value: "model" as const, label: gt("Model") }] : []),
    ...(toggleSections.length > 0
      ? [{ value: "toggles" as const, label: gt("Capabilities") }]
      : []),
    ...(schedulesSupported ? [{ value: "schedules" as const, label: gt("Schedule") }] : []),
  ];
  const activeTab = tabs.some((item) => item.value === props.tab) ? props.tab : "profile";

  const nextName = name.trim() || bot.agentRef;
  const metaPatch = {
    ...(nextName !== savedMeta.name ? { name: nextName } : {}),
    ...(avatarColor.toLowerCase() !== savedMeta.avatarColor.toLowerCase() ? { avatarColor } : {}),
    ...(avatarShape !== savedMeta.avatarShape ? { avatarShape } : {}),
    ...(pinned !== savedMeta.pinned ? { pinned } : {}),
  };
  const changedSections = changedPaConfigSections(sections, drafts);
  const settingsDirty =
    (canEditMeta && Object.keys(metaPatch).length > 0) || changedSections.length > 0;
  const scheduleDirty =
    scheduleDraft.name !== "" ||
    scheduleDraft.prompt !== "" ||
    scheduleDraft.deliver !== "" ||
    scheduleDraft.spec !== savedScheduleSpec;
  const dirty = settingsDirty || scheduleDirty;

  const saved = () => {
    void refreshPaRoster(environmentId);
    bumpPaBotSettingsIfActive(environmentId, bot.botId);
  };
  const save = async () => {
    if (!settingsDirty || saving) return;
    const belowMinimum = findPaMinEnabledViolation(changedSections, drafts);
    if (belowMinimum) {
      setError(
        gt("Enable at least {count} items in {section}", {
          section: belowMinimum.label,
          count: belowMinimum.minEnabled ?? 0,
        }),
      );
      return;
    }
    setSaving(true);
    Keyboard.dismiss();
    setError(null);
    // Each block that lands becomes the new baseline at once, so a later failure cannot leave
    // saved edits looking unsaved; drafts typed during the save are kept, not overwritten.
    const persist = async () => {
      if (canEditMeta && Object.keys(metaPatch).length > 0) {
        await client.updateBotMeta({ botId: bot.botId, ...metaPatch });
        patchPaBot(environmentId, bot.botId, metaPatch);
        if (!mounted.current) return;
        setSavedMeta({ name: nextName, avatarColor, avatarShape, pinned });
        const submittedName = name;
        setName((current) => (current === submittedName ? nextName : current));
      }
      let baseline = config;
      for (const section of changedSections) {
        const submitted = drafts[section.id]!;
        const next = await client.patchBotConfig(bot.botId, section.id, submitted);
        const description = paProfileDescription(next);
        if (description !== undefined) patchPaBot(environmentId, bot.botId, { description });
        if (!mounted.current) return;
        setConfig(next);
        const previous = baseline;
        baseline = next;
        setDrafts((current) =>
          rebasePaConfigDrafts(current, previous, next, section.id, submitted),
        );
      }
    };
    await persist().then(
      () => {
        saved();
        if (mounted.current && navigation.isFocused()) navigation.goBack();
      },
      (cause: unknown) => mounted.current && setError(paErrorMessage(cause, gt("Could not save"))),
    );
    if (mounted.current) setSaving(false);
  };
  const mutateSchedule = async (input: Omit<PaMutateScheduleInput, "botId">, fallback: string) => {
    if (!schedulesSupported || scheduleBusy) return false;
    setScheduleBusy(true);
    setError(null);
    const ok = await client.mutateSchedule({ botId: bot.botId, ...input }).then(
      (next) => {
        if (!mounted.current) return false;
        setSchedules(next);
        if (input.action === "add") setSavedScheduleSpec(scheduleDraft.spec);
        return true;
      },
      (cause: unknown) => {
        if (mounted.current) setError(paErrorMessage(cause, fallback));
        return false;
      },
    );
    if (mounted.current) setScheduleBusy(false);
    return ok;
  };
  const nativeConsoleUrl = configSupported ? parseSafePaConsoleUrl(config?.nativeConsoleUrl) : null;

  return (
    <View className="flex-1 bg-sheet">
      <AppBar
        title={name || bot.name}
        subtitle={gt("{engine} · {agent}", { engine: bot.engineLabel, agent: bot.agentRef })}
        onClose={() => navigation.goBack()}
        {...(activeTab === "schedules" || activeTab === "model"
          ? {}
          : {
              confirm: {
                label: gt("Save & Close"),
                onPress: () => void save(),
                disabled: !settingsDirty || loading,
                loading: saving,
              },
            })}
        actions={
          nativeConsoleUrl
            ? [
                {
                  accessibilityLabel: gt("Advanced settings"),
                  icon: "arrow.up.right",
                  onPress: () => void tryOpenExternalUrl(nativeConsoleUrl),
                },
              ]
            : []
        }
      />
      <ScreenContent surface="sheet">
        <NativeScrollView
          pointerEvents={saving ? "none" : "auto"}
          className="flex-1"
          contentInsetAdjustmentBehavior="automatic"
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
          automaticallyAdjustKeyboardInsets
          contentContainerStyle={{ padding: 16, gap: 16, paddingBottom: 40 }}
        >
          {tabs.length > 1 ? (
            <SegmentedControl options={tabs} selected={activeTab} onSelect={props.onSelectTab} />
          ) : null}
          {error ? (
            <Text selectable className="text-sm text-danger">
              {error}
            </Text>
          ) : null}
          {loading ? <AppActivityIndicator className="my-8" /> : null}
          {!loading && activeTab === "profile" ? (
            <View className="gap-4">
              <View className="items-center">
                <BotAvatar
                  color={avatarColor}
                  shape={avatarShape}
                  size="lg"
                  starred={bot.isDefault}
                />
                {!bot.online && (
                  <Text className="text-xs text-foreground-muted">{gt("Offline")}</Text>
                )}
              </View>
              <View className="gap-1.5">
                <FieldLabel>{gt("Name")}</FieldLabel>
                <TextInput
                  accessibilityLabel={gt("Name")}
                  value={name}
                  editable={canEditMeta}
                  onChangeText={setName}
                  className={INPUT}
                />
              </View>
              <ListSection>
                <ListToggleRow
                  label={gt("Pin to top")}
                  description={gt("Show in the pinned bots section")}
                  value={pinned}
                  disabled={!canEditMeta}
                  onValueChange={setPinned}
                />
              </ListSection>
              <View className="gap-2">
                <FieldLabel>{gt("Avatar appearance")}</FieldLabel>
                <View className="flex-row flex-wrap gap-2">
                  {PA_AVATAR_SHAPES.map((item) => (
                    <Pressable
                      key={item.value}
                      accessibilityRole="radio"
                      accessibilityLabel={messages(item.label)}
                      accessibilityState={{ checked: avatarShape === item.value }}
                      disabled={!canEditMeta}
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
                  {paAvatarColorOptions(bot.avatarColor).map((swatch) => (
                    <Pressable
                      key={swatch.value}
                      accessibilityRole="radio"
                      accessibilityLabel={messages(swatch.label)}
                      accessibilityState={{ checked: avatarColor.toLowerCase() === swatch.value }}
                      disabled={!canEditMeta}
                      onPress={() => setAvatarColor(swatch.value)}
                      className={cn(
                        "size-9 items-center justify-center rounded-full",
                        avatarColor.toLowerCase() === swatch.value && "border-2 border-foreground",
                      )}
                    >
                      <View
                        className={cn(
                          "size-7 rounded-full",
                          isPaAvatarObsidian(swatch.value) && "bg-foreground",
                        )}
                        style={
                          isPaAvatarObsidian(swatch.value)
                            ? undefined
                            : { backgroundColor: swatch.value }
                        }
                      />
                    </Pressable>
                  ))}
                </View>
              </View>
              {profileSections.map((section) => {
                const draft = drafts[section.id];
                if (section.kind === "document" && draft?.kind === "document") {
                  return (
                    <View key={section.id} className="gap-1.5">
                      <FieldLabel {...(section.description ? { detail: section.description } : {})}>
                        {section.label}
                      </FieldLabel>
                      <TextInput
                        accessibilityLabel={section.label}
                        multiline
                        value={draft.text}
                        placeholder={
                          section.placeholder ?? gt("Enter system instructions for this bot…")
                        }
                        placeholderTextColorClassName="accent-foreground-muted"
                        onChangeText={(text) =>
                          setDrafts((current) => ({
                            ...current,
                            [section.id]: { kind: "document", text },
                          }))
                        }
                        className={cn(INPUT, "min-h-[160px]")}
                        textAlignVertical="top"
                      />
                    </View>
                  );
                }
                if (section.kind === "options" && draft?.kind === "options") {
                  return (
                    <OptionsSection
                      key={section.id}
                      section={section}
                      value={draft.values}
                      onChange={(values) =>
                        setDrafts((current) => ({
                          ...current,
                          [section.id]: { kind: "options", values },
                        }))
                      }
                    />
                  );
                }
                return null;
              })}
            </View>
          ) : null}
          {!loading && activeTab === "model" ? (
            <View className="gap-3">
              <Text className="text-sm text-foreground-muted">
                {bot.model
                  ? gt("This bot uses {model}.", { model: bot.model })
                  : gt("This bot uses its engine's default model.")}
              </Text>
              <Button
                tone="secondary"
                icon="brain"
                label={gt("Change model")}
                onPress={() =>
                  navigation.navigate("PaModel", {
                    fromSettings: dirty ? "keepDrafts" : "close",
                    ...(dirty
                      ? {
                          draftTab: scheduleDirty
                            ? "schedules"
                            : Object.keys(metaPatch).length ||
                                changedSections.some((section) => section.kind !== "toggleList")
                              ? ("profile" as const)
                              : ("toggles" as const),
                        }
                      : {}),
                    environmentId,
                    botId: bot.botId,
                    ...(bot.primarySessionId ? { sessionId: bot.primarySessionId } : {}),
                  })
                }
              />
            </View>
          ) : null}
          {!loading && activeTab === "toggles" ? (
            <View className="gap-6">
              {toggleSections.map((section) => {
                const draft = drafts[section.id];
                return (
                  <ToggleListSection
                    key={section.id}
                    section={section}
                    value={draft?.kind === "toggleList" ? draft.enabled : []}
                    onChange={(enabled) =>
                      setDrafts((current) => ({
                        ...current,
                        [section.id]: { kind: "toggleList", enabled },
                      }))
                    }
                  />
                );
              })}
            </View>
          ) : null}
          {!loading && activeTab === "schedules" ? (
            <Schedules
              draft={scheduleDraft}
              onDraftChange={setScheduleDraft}
              schedules={schedules ?? []}
              busy={scheduleBusy}
              onMutate={mutateSchedule}
            />
          ) : null}
        </NativeScrollView>
      </ScreenContent>
    </View>
  );
}
