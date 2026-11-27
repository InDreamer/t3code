import type { PaModelCatalog } from "@t3tools/contracts";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

import type { PaClient } from "./paApi";
import { PaModelSheet } from "./PaModelSheet";

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
vi.mock("../../components/ui/AppText", () => ({ AppText: "span", AppTextInput: "input" }));
vi.mock("../../components/ui/Menu", () => ({ Menu: () => null }));
vi.mock("../../components/ui/Button", () => ({
  Button: ({ label, onPress }: { label: string; onPress: () => void }) => (
    <button onClick={onPress}>{label}</button>
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

it.each(["model", "reasoning"])(
  "applies a late %s result to the session that requested it",
  async (kind) => {
    ui.sessionId = null;
    ui.models.mockResolvedValue(catalog);
    ui.goBack.mockClear();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const container = document.createElement("div");
    const root = createRoot(container);
    using _root = { [Symbol.dispose]: () => act(() => root.unmount()) };
    const show = () =>
      act(async () =>
        root.render(<PaModelSheet route={{ params: { environmentId: "env", botId: "bot" } }} />),
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
        botId: "bot",
        sessionId: "original",
        reasoningEffort: "high",
        confirm: true,
      });
    } else {
      ui.select.mockReturnValueOnce(receipt.promise);
      act(() => button("another").click());
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
