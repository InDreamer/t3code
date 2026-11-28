import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import { PaBotSettingsSheet } from "./PaBotSettingsSheet";
import { refreshPaRoster, clearPaRosterEnvironment } from "./paRosterStore";
import type { PaClient } from "./paApi";

const ui = vi.hoisted(() => ({
  list: vi.fn<PaClient["listBots"]>(),
  schedules: vi.fn<PaClient["listSchedules"]>(),
  save: vi.fn<PaClient["updateBotMeta"]>(),
  navigate: vi.fn(),
  dispatch: vi.fn(),
  back: vi.fn(),
  Children: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => true }));
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({
    navigate: ui.navigate,
    dispatch: ui.dispatch,
    goBack: ui.back,
    isFocused: () => true,
  }),
  CommonActions: { setParams: (params: object) => params },
}));
vi.mock("react-native", () => ({
  View: ui.Children,
  Pressable: ui.Children,
  Keyboard: { dismiss: () => {} },
}));
vi.mock("../../state/workspace", () => ({ workspaceConnections: {} }));
vi.mock("./usePaBotChat", () => ({ bumpPaBotSettingsIfActive: vi.fn() }));
vi.mock("../../lib/openExternalUrl", () => ({ tryOpenExternalUrl: vi.fn() }));
vi.mock("./paApi", () => ({
  paClient: () => ({ listBots: ui.list, listSchedules: ui.schedules, updateBotMeta: ui.save }),
  paErrorMessage: (err: Error) => err.message,
  paUpdateMetaPermissionAtom: vi.fn(),
  paSelectModelPermissionAtom: vi.fn(),
  paPatchConfigPermissionAtom: vi.fn(),
  paMutateSchedulePermissionAtom: vi.fn(),
}));
vi.mock("./BotAvatar", () => ({ BotAvatar: ui.Children }));
vi.mock("../../components/ui/AppBar", () => ({
  AppBar: ({ confirm }: { confirm?: { label: string; onPress: () => void } }) =>
    confirm && <button onClick={confirm.onPress}>{confirm.label}</button>,
}));
vi.mock("../../components/ui/Button", () => ({
  Button: ({ label, onPress }: { label: string; onPress: () => void }) => (
    <button onClick={onPress}>{label}</button>
  ),
}));
vi.mock("../../components/ui/SegmentedControl", () => ({
  SegmentedControl: ({
    options,
    onSelect,
  }: {
    options: { value: string; label: string }[];
    onSelect: (tab: string) => void;
  }) =>
    options.map((option) => (
      <button key={option.value} onClick={() => onSelect(option.value)}>
        {option.label}
      </button>
    )),
}));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: ui.Children }));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ui.Children,
  AppTextInput: ({
    value,
    onChangeText,
  }: {
    value: string;
    onChangeText: (text: string) => void;
  }) => <input value={value} onChange={(e) => onChangeText(e.target.value)} />,
}));
vi.mock("../../components/ui/AppActivityIndicator", () => ({ AppActivityIndicator: ui.Children }));
vi.mock("../../components/ui/EmptyState", () => ({
  EmptyState: ({ title }: { title: string }) => <p>{title}</p>,
}));
vi.mock("../../components/ui/Menu", () => ({ Menu: ui.Children }));
vi.mock("../../components/ui/ListSection", () => ({ ListSection: ui.Children }));
vi.mock("../../components/ui/ListToggleRow", () => ({ ListToggleRow: ui.Children }));
vi.mock("../../components/ui/ScreenContent", () => ({ ScreenContent: ui.Children }));
vi.mock("../../native/NativeScrollViewMarker", () => ({ NativeScrollView: ui.Children }));

const instance = {
  instanceId: "engine",
  label: "Hermes",
  driver: "hermes",
  version: null,
  online: true,
  botCount: 1,
  error: null,
  capabilities: {
    sessions: { create: false, rename: false },
    execution: { interrupt: false, clarify: false, approvals: false },
    config: { supported: false },
    models: { supported: true, scope: "agent" as const, allowCustom: false },
    schedules: { supported: true },
    commands: { supported: false },
    lifecycle: { create: false, delete: false },
  },
};
const bot = {
  botId: "engine:a",
  instanceId: "engine",
  agentRef: "a",
  driver: "hermes",
  engineLabel: "Hermes",
  name: "Original",
  description: "",
  pinned: false,
  avatarColor: "#14b8a6",
  avatarShape: "blob" as const,
  isDefault: false,
  model: null,
  provider: null,
  online: true,
  running: false,
  unread: false,
  lastMessagePreview: null,
  lastActivityAt: null,
  primarySessionId: null,
};

it("keeps the edited profile through an offline poll and failed save, then restores its save button after model selection", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const env = "settings-env";
  ui.schedules.mockResolvedValue([]);
  ui.list
    .mockResolvedValueOnce({ bots: [bot], instances: [instance] })
    .mockResolvedValue({ bots: [], instances: [{ ...instance, online: false }] });
  ui.save.mockRejectedValueOnce(new Error("Offline")).mockResolvedValue(undefined);
  await refreshPaRoster(env);
  const container = document.createElement("div");
  const root = createRoot(container);
  using _root = {
    [Symbol.dispose]: () => {
      act(() => root.unmount());
      clearPaRosterEnvironment(env);
    },
  };
  const params = { environmentId: env, botId: bot.botId };
  const show = (tab?: "profile" | "model") =>
    act(async () =>
      root.render(
        <PaBotSettingsSheet route={{ params: { ...params, ...(tab ? { tab } : {}) } }} />,
      ),
    );
  const button = (label: string) =>
    [...container.querySelectorAll("button")].find((item) => item.textContent === label)!;
  await show();
  const input = container.querySelector("input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
      input,
      "Unsaved",
    );
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await refreshPaRoster(env);
  });
  expect(input.value).toBe("Unsaved");
  await act(async () => button("Save & Close").click());
  expect(ui.back).not.toHaveBeenCalled();
  expect(ui.list).toHaveBeenCalledTimes(2);
  expect(container.querySelector("input")?.value).toBe("Unsaved");
  await act(async () => button("Model").click());
  expect(ui.dispatch).toHaveBeenLastCalledWith({ tab: "model" });
  await show("model");
  await act(async () => button("Change model").click());
  expect(ui.navigate).toHaveBeenCalledWith("PaModel", {
    ...params,
    fromSettings: "keepDrafts",
    draftTab: "profile",
  });
  await show("profile");
  expect(container.querySelector("input")?.value).toBe("Unsaved");
  await act(async () => button("Save & Close").click());
  expect(ui.save).toHaveBeenLastCalledWith({ botId: bot.botId, name: "Unsaved" });
  expect(ui.back).toHaveBeenCalledOnce();
});

it("restores a scheduled task draft after navigating to the model picker", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const environmentId = "schedule-env";
  ui.list.mockResolvedValue({ bots: [bot], instances: [instance] });
  ui.schedules.mockResolvedValue([]);
  await refreshPaRoster(environmentId);
  const container = document.createElement("div");
  const root = createRoot(container);
  using _root = {
    [Symbol.dispose]: () => {
      act(() => root.unmount());
      clearPaRosterEnvironment(environmentId);
    },
  };
  const params = { environmentId, botId: bot.botId };
  const show = (tab: "schedules" | "model") =>
    act(async () => root.render(<PaBotSettingsSheet route={{ params: { ...params, tab } }} />));
  await show("schedules");
  await act(async () => {
    for (const [index, value] of [
      [0, "Morning briefing"],
      [2, "Summarize news"],
    ] as const) {
      const input = container.querySelectorAll("input")[index]!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
  });
  await show("model");
  await act(async () =>
    [...container.querySelectorAll("button")]
      .find((item) => item.textContent === "Change model")!
      .click(),
  );
  expect(ui.navigate).toHaveBeenLastCalledWith("PaModel", {
    ...params,
    fromSettings: "keepDrafts",
    draftTab: "schedules",
  });
  await show("schedules");
  expect([...container.querySelectorAll("input")].map((input) => input.value)).toEqual([
    "Morning briefing",
    "every 1h",
    "Summarize news",
    "",
  ]);
});
