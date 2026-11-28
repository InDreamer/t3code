import type { PaModelCatalog } from "@t3tools/contracts";
import { act, type ReactNode } from "react";
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
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => true }));
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ goBack: ui.goBack, isFocused: () => true }),
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
vi.mock("../../components/ui/SelectionRow", () => ({
  SelectionRow: ({
    title,
    onPress,
    disabled,
  }: {
    title: string;
    onPress: () => void;
    disabled: boolean;
  }) => (
    <button onClick={onPress} disabled={disabled}>
      {title}
    </button>
  ),
}));
vi.mock("../../native/NativeScrollViewMarker", () => ({
  NativeScrollView: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../pull-requests/PullRequestSearchSheet", () => ({
  PullRequestSearchSheet: ({
    children,
  }: {
    children: (insets: { paddingBottom: number }) => ReactNode;
  }) => children({ paddingBottom: 0 }),
}));
vi.mock("./paApi", () => ({
  paClient: () => ({ getBotModels: ui.models, selectBotModel: ui.select }),
  paSelectModelPermissionAtom: () => true,
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
      await act(async () => button("High").click());
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
