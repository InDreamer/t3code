import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

import { PaCreateBotSheet } from "./PaCreateBotSheet";

const { Children } = vi.hoisted(() => ({
  Children: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));
vi.mock("react-native", () => ({ View: Children, Pressable: Children }));
vi.mock("@react-navigation/native", () => ({ useNavigation: () => ({}) }));
vi.mock("../layout/workspace/useSelectWorkspaceDetail", () => ({
  useSelectWorkspaceDetail: () => vi.fn(),
}));
vi.mock("./paRosterStore", () => ({ usePaCreatableEngines: () => [] }));
vi.mock("./paApi", () => ({}));
vi.mock("./BotAvatar", () => ({ BotAvatar: Children }));
vi.mock("../../components/ui/AppBar", () => ({
  AppBar: ({ title }: { title: string }) => <h1>{title}</h1>,
}));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: Children }));
vi.mock("../../components/ui/AppText", () => ({ AppText: Children, AppTextInput: Children }));
vi.mock("../../components/ui/EmptyState", () => ({
  EmptyState: ({ title }: { title: string }) => <p>{title}</p>,
}));
vi.mock("../../components/ui/Menu", () => ({ Menu: Children }));
vi.mock("../../components/ui/ListSection", () => ({ ListSection: Children }));
vi.mock("../../components/ui/ListToggleRow", () => ({ ListToggleRow: Children }));
vi.mock("../../components/ui/ScreenContent", () => ({ ScreenContent: Children }));
vi.mock("../../native/NativeScrollViewMarker", () => ({ NativeScrollView: Children }));

it("opens a cold /bots/new link without a preferred environment", () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    act(() => root.render(<PaCreateBotSheet route={{ params: undefined }} />));
    expect(container.textContent).toContain("Create bot");
    expect(container.textContent).toContain("No bot engines");
  } finally {
    act(() => root.unmount());
  }
});
