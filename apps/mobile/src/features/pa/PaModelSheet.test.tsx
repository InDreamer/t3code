import type { PaModelCatalog } from "@t3tools/contracts";
import { act, type ComponentType, type ReactElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";

import type { PaClient } from "./paApi";
import { PaModelSheet } from "./PaModelSheet";
import { paModelCatalogs } from "./usePaModelCatalog";

const ui = vi.hoisted(() => ({
  sessionId: null as string | null,
  models: vi.fn<PaClient["getBotModels"]>(),
  select: vi.fn<PaClient["selectBotModel"]>(),
  patch: vi.fn(),
  setReasoning: vi.fn(),
  bump: vi.fn(),
  goBack: vi.fn(),
  dispatch: vi.fn(),
  navigate: vi.fn(),
  nestedBack: vi.fn(),
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => true }));
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ goBack: ui.goBack, dispatch: ui.dispatch, isFocused: () => true }),
  StackActions: {
    popTo: (name: string, params: object) => ({ type: "POP_TO", name, params }),
    pop: (count: number) => ({ type: "POP", payload: { count } }),
  },
}));
vi.mock("react-native", () => ({
  View: "div",
  Pressable: ({
    children,
    onPress,
    disabled,
  }: {
    children: ReactNode;
    onPress: () => void;
    disabled: boolean;
  }) => (
    <button onClick={onPress} disabled={disabled}>
      {children}
    </button>
  ),
}));
// Both picker pages render at once; the pages get the nested stack's navigation as props.
vi.mock("../../native/createV5StackNavigator", async () => {
  const { Children } = await vi.importActual<typeof import("react")>("react");
  type ScreenElement = ReactElement<{
    name: string;
    component: ComponentType<{ navigation: object }>;
  }>;
  return {
    createV5StackNavigator: () => ({
      Navigator: ({ children }: { children: ReactNode }) =>
        (Children.toArray(children) as ScreenElement[]).map((screen) => {
          const Screen = screen.props.component;
          return (
            <Screen
              key={screen.props.name}
              navigation={{ navigate: ui.navigate, goBack: ui.nestedBack }}
            />
          );
        }),
      Screen: () => null,
    }),
  };
});
vi.mock("../layout/nested-stacks", () => ({ useSheetStackOptions: () => ({}) }));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock("../../components/ui/AppBar", () => ({
  AppBar: ({
    title,
    onClose,
    confirm,
  }: {
    title: string;
    onClose?: () => void;
    confirm?: { label: string; onPress: () => void };
  }) => (
    <header>
      {onClose ? <button onClick={onClose}>{`Close ${title}`}</button> : null}
      {confirm ? <button onClick={confirm.onPress}>{confirm.label}</button> : null}
    </header>
  ),
}));
vi.mock("../../components/ui/ScreenContent", () => ({
  ScreenContent: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../../components/ui/useBarInset", () => ({ useSearchToolbarInset: () => 0 }));
vi.mock("../threads/ThreadSettingsRows", () => ({
  ChoiceRow: ({
    label,
    onPress,
    disabled,
  }: {
    label: string;
    onPress: () => void;
    disabled?: boolean;
  }) => (
    <button onClick={onPress} disabled={disabled}>
      {label}
    </button>
  ),
}));
vi.mock("../threads/ThreadSettingsSections", () => ({
  ProviderHeader: ({
    label,
    collapsible,
    collapsed,
    modelCount,
    onToggle,
  }: {
    label: string;
    collapsible: boolean;
    collapsed: boolean;
    modelCount: number;
    onToggle: () => void;
  }) =>
    collapsible ? (
      <button onClick={onToggle}>{`${label} ${collapsed ? modelCount : "open"}`}</button>
    ) : (
      <span>{label}</span>
    ),
  DisclosureRow: ({
    label,
    value,
    onPress,
  }: {
    label: string;
    value?: string;
    onPress: () => void;
  }) => <button onClick={onPress}>{`${label}: ${value ?? ""}`}</button>,
}));
vi.mock("../../components/ui/AppActivityIndicator", () => ({ AppActivityIndicator: () => null }));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../components/ui/AppText", () => ({
  AppText: "span",
  AppTextInput: ({
    value,
    onChangeText,
  }: {
    value: string;
    onChangeText: (text: string) => void;
  }) => <input value={value} onChange={(event) => onChangeText(event.target.value)} />,
}));
vi.mock("../../components/ui/Menu", () => ({ Menu: () => null }));
vi.mock("../../components/ui/Button", () => ({
  Button: ({
    label,
    onPress,
    disabled,
  }: {
    label: string;
    onPress: () => void;
    disabled?: boolean;
  }) => (
    <button onClick={onPress} disabled={disabled}>
      {label}
    </button>
  ),
}));
vi.mock("../../native/NativeScrollViewMarker", () => ({
  NativeScrollView: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("./paApi", () => ({
  paClient: () => ({ getBotModels: ui.models, selectBotModel: ui.select }),
  paSelectModelPermissionAtom: () => true,
  paErrorMessage: (error: Error) => error.message,
}));
vi.mock("./paRosterStore", () => ({
  usePaBot: () => ({ bot: {}, capabilities: { models: { scope: "session" } } }),
  patchPaBot: ui.patch,
}));
vi.mock("./usePaBotChat", () => ({
  usePaBotChat: () => ({
    state: {
      activeSessionId: ui.sessionId,
      sessionReasoning: {},
      settingsVersion: 0,
      sessions: [],
    },
    chat: {
      getState: () => ({ activeSessionId: ui.sessionId }),
      patchSession: ui.patch,
      setReasoning: ui.setReasoning,
      bumpSettings: ui.bump,
    },
  }),
}));

const catalog: PaModelCatalog = {
  scope: "session",
  allowCustom: false,
  current: { provider: "p", model: "current" },
  providers: [
    { id: "p", label: "Provider", tier: "primary", isCurrent: true, models: [{ id: "another" }] },
  ],
  reasoningLevels: [{ id: "high", label: "High" }],
};

afterEach(() => paModelCatalogs.clear());

it.each([
  ["keepDrafts", "profile"],
  ["keepDrafts", "toggles"],
  ["keepDrafts", "schedules"],
  ["close", "profile"],
] as const)(
  "preserves the settings stack on failure and pops the right sheets on success (%s)",
  async (fromSettings, draftTab) => {
    ui.sessionId = "selected";
    ui.dispatch.mockClear();
    ui.models.mockResolvedValue(catalog);
    ui.select.mockRejectedValueOnce(new Error("Unavailable")).mockResolvedValueOnce({
      status: "applied",
      current: { model: "another", provider: "p" },
    });
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const container = document.createElement("div");
    const root = createRoot(container);
    using _root = { [Symbol.dispose]: () => act(() => root.unmount()) };
    await act(async () =>
      root.render(
        <PaModelSheet
          route={{
            params: { environmentId: "env", botId: "settings-bot", fromSettings, draftTab },
          }}
        />,
      ),
    );
    const model = [...container.querySelectorAll("button")].find(
      (item) => item.textContent === "another",
    )!;
    await act(async () => model.click());
    expect(container.textContent).toContain("Unavailable");
    expect(ui.dispatch).not.toHaveBeenCalled();
    await act(async () => model.click());
    expect(ui.dispatch.mock.calls).toEqual([
      [
        fromSettings === "close"
          ? { type: "POP", payload: { count: 2 } }
          : {
              type: "POP_TO",
              name: "PaBotSettings",
              params: { environmentId: "env", botId: "settings-bot", tab: draftTab },
            },
      ],
    ]);
  },
);

it.each(["model", "reasoning"])(
  "applies a late %s result to the session that requested it",
  async (kind) => {
    ui.sessionId = null;
    ui.select.mockClear();
    ui.models.mockResolvedValue(catalog);
    ui.goBack.mockClear();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const container = document.createElement("div");
    const root = createRoot(container);
    using _root = { [Symbol.dispose]: () => act(() => root.unmount()) };
    const botId = "bot";
    const show = () =>
      act(async () =>
        root.render(<PaModelSheet route={{ params: { environmentId: "env", botId } }} />),
      );
    const button = (name: string) =>
      [...container.querySelectorAll("button")].find((item) => item.textContent === name)!;
    await show();
    expect(button("another").disabled).toBe(true);
    ui.sessionId = "original";
    await show();
    const receipt = Promise.withResolvers<Awaited<ReturnType<PaClient["selectBotModel"]>>>();
    if (kind === "reasoning") {
      ui.select.mockResolvedValueOnce({ status: "confirmRequired", message: "Confirm effort" });
      ui.nestedBack.mockClear();
      await act(async () => button("High").click());
      // The effort page returns to the list, where the confirmation shows.
      expect(ui.nestedBack).toHaveBeenCalledTimes(1);
      expect(container.textContent).toContain("Confirm effort");
      ui.select.mockReturnValueOnce(receipt.promise);
      act(() => button("Confirm switch").click());
      expect(ui.select).toHaveBeenLastCalledWith({
        botId,
        sessionId: "original",
        reasoningEffort: "high",
        confirm: true,
      });
    } else {
      ui.select.mockReturnValueOnce(receipt.promise);
      act(() => {
        button("another").click();
        button("another").click();
      });
      expect(ui.select).toHaveBeenCalledTimes(1);
    }
    ui.sessionId = "next";
    await show();
    await act(async () => {
      receipt.resolve({
        status: "applied",
        current: { model: "another", provider: "p", reasoningEffort: "high" },
      });
      await receipt.promise;
    });
    if (kind === "reasoning") expect(ui.setReasoning).toHaveBeenCalledWith("original", "high");
    else expect(ui.patch).toHaveBeenCalledWith("original", { model: "another" });
    expect(ui.goBack).not.toHaveBeenCalled();
  },
);

it("keeps a custom model unsubmittable until a provider is chosen", async () => {
  ui.sessionId = "custom";
  ui.models.mockResolvedValue({
    ...catalog,
    allowCustom: true,
    current: { provider: null, model: "current" },
  });
  ui.select.mockClear();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  const root = createRoot(container);
  using _root = { [Symbol.dispose]: () => act(() => root.unmount()) };
  await act(async () =>
    root.render(<PaModelSheet route={{ params: { environmentId: "env", botId: "bot-custom" } }} />),
  );
  const input = container.querySelector("input")!;
  await act(async () => {
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setValue.call(input, "my-model");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(input.value).toBe("my-model");
  const use = [...container.querySelectorAll("button")].find((item) => item.textContent === "Use")!;
  expect(use.disabled).toBe(true);
  await act(async () => use.click());
  expect(ui.select).not.toHaveBeenCalled();
});

const button = (container: HTMLElement, name: string) =>
  [...container.querySelectorAll("button")].find((item) => item.textContent === name);

async function renderSheet(botId: string, query?: string) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <PaModelSheet
        route={{ params: { environmentId: "env", botId, ...(query ? { query } : {}) } }}
      />,
    ),
  );
  return { container, [Symbol.dispose]: () => act(() => root.unmount()) };
}

it("folds detected providers behind their header, opens them on tap or search, and closes from the bar", async () => {
  ui.sessionId = "detected";
  ui.goBack.mockClear();
  ui.navigate.mockClear();
  ui.models.mockResolvedValue({
    ...catalog,
    current: { provider: "p", model: "another", reasoningEffort: "high" },
    providers: [
      ...catalog.providers,
      {
        id: "found",
        label: "Found",
        tier: "detected",
        isCurrent: false,
        models: [{ id: "local-a" }, { id: "local-b" }],
      },
    ],
  });
  using sheet = await renderSheet("bot-detected");
  const { container } = sheet;
  expect(button(container, "local-a")).toBeUndefined();
  await act(async () => button(container, "Found 2")!.click());
  expect(button(container, "local-a")).toBeDefined();
  await act(async () => button(container, "Found open")!.click());
  expect(button(container, "local-a")).toBeUndefined();

  const effort = [...container.querySelectorAll("button")].find((item) =>
    item.textContent?.endsWith(": High"),
  )!;
  await act(async () => effort.click());
  expect(ui.navigate).toHaveBeenCalledWith("PaModelEffort");

  await act(async () => button(container, "Done")!.click());
  await act(async () => button(container, "Close Model")!.click());
  expect(ui.goBack).toHaveBeenCalledTimes(2);
});

it("opens with the /model query searching every provider, detected ones included", async () => {
  ui.sessionId = "query";
  ui.models.mockResolvedValue({
    ...catalog,
    providers: [
      ...catalog.providers,
      {
        id: "found",
        label: "Found",
        tier: "detected",
        isCurrent: false,
        models: [{ id: "local-a" }],
      },
    ],
  });
  using sheet = await renderSheet("bot-query", "local");
  expect(button(sheet.container, "local-a")).toBeDefined();
  expect(button(sheet.container, "another")).toBeUndefined();
});
