import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

import { PaCreateBotSheet } from "./PaCreateBotSheet";

const { Children, createOptions, retry } = vi.hoisted(() => ({
  createOptions: vi.fn(),
  retry: vi.fn(),
  Children: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));
vi.mock("react-native", () => ({ View: Children, Pressable: Children }));
vi.mock("@react-navigation/native", () => ({ useNavigation: () => ({}) }));
vi.mock("../layout/workspace/useSelectWorkspaceDetail", () => ({
  useSelectWorkspaceDetail: () => vi.fn(),
}));
vi.mock("./paRosterStore", () => ({ usePaCreateOptions: createOptions, refreshPaRoster: retry }));
vi.mock("./paApi", () => ({}));
vi.mock("./BotAvatar", () => ({ BotAvatar: Children }));
vi.mock("../../components/ui/AppBar", () => ({
  AppBar: ({ title }: { title: string }) => <h1>{title}</h1>,
}));
vi.mock("../../components/ui/Button", () => ({
  Button: ({ label, onPress }: { label: string; onPress: () => void }) => (
    <button onClick={onPress}>{label}</button>
  ),
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
  createOptions.mockReturnValue({ environments: [], engines: [] });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
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

it("waits for the preferred environment, exposes its load failure and retries it", () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  const root = createRoot(container);
  using _root = { [Symbol.dispose]: () => act(() => root.unmount()) };
  const engine = (id: string) => ({
    key: id,
    environmentId: id,
    environmentLabel: id,
    instance: { label: id + " engine", online: true },
  });
  const show = (loading: boolean, error: string | null, engines: ReturnType<typeof engine>[]) => {
    createOptions.mockReturnValue({
      engines,
      environments: [
        { environmentId: "preferred", environmentLabel: "Preferred", entry: { loading, error } },
      ],
    });
    act(() => root.render(<PaCreateBotSheet route={{ params: { environmentId: "preferred" } }} />));
  };
  show(true, null, [engine("fallback")]);
  expect(container.textContent).toContain("Loading bots");
  expect(container.textContent).not.toContain("fallback engine");
  show(false, "connection lost", []);
  expect(container.textContent).toContain("connection lost");
  expect(container.textContent).not.toContain("No bot engines");
  act(() => container.querySelector("button")!.click());
  expect(retry).toHaveBeenCalledWith("preferred");
  show(false, null, [engine("fallback"), engine("preferred")]);
  expect(container.textContent).toContain("preferred engine");
});
