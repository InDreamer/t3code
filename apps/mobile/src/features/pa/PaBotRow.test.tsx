import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import { PaBotRow, type PaRosterBot } from "./PaBotRow";
import { PaRowVisibility } from "./paRowVisibility";

const { Children } = vi.hoisted(() => ({
  Children: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => true }));
vi.mock("react-native", () => ({ View: Children, Pressable: Children }));
vi.mock("../../components/ui/AppText", () => ({ AppText: Children }));
vi.mock("../../components/ui/Menu", () => ({ Menu: Children }));
vi.mock("../threads/thread-list-v2-row-appearance", () => ({
  selectedThreadRowColors: {},
  THREAD_LIST_V2_SIDEBAR_ROW_STYLE: {},
  THREAD_LIST_V2_SIDEBAR_ROW_CONTAINER_STYLE: {},
}));
vi.mock("./paApi", () => ({ paUpdateMetaPermissionAtom: vi.fn() }));
vi.mock("./BotAvatar", () => ({
  BotAvatar: ({ visible, running }: { visible: boolean; running: boolean }) => (
    <span data-working-avatar={String(visible && running)} />
  ),
}));

it("gates a working avatar on both row and page visibility, including when the row is recycled", () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  const root = createRoot(container);
  using _root = { [Symbol.dispose]: () => act(() => root.unmount()) };
  const viewport = new PaRowVisibility();
  const renderRow = (key: string, visible: boolean) => {
    const bot: PaRosterBot = {
      key,
      environmentId: "env",
      environmentLabel: null,
      botId: "engine:" + key,
      instanceId: "engine",
      driver: "hermes",
      engineLabel: "Hermes",
      agentRef: key,
      name: key,
      description: "",
      avatarColor: "#14b8a6",
      avatarShape: "blob",
      pinned: false,
      isDefault: false,
      model: null,
      provider: null,
      online: true,
      running: true,
      unread: false,
      lastMessagePreview: null,
      lastActivityAt: null,
      primarySessionId: null,
    };
    act(() =>
      root.render(
        <PaBotRow
          bot={bot}
          preview=""
          time=""
          selected={false}
          sidebar={false}
          visible={visible}
          rowVisibility={viewport}
          onSelect={() => {}}
          onAction={() => {}}
        />,
      ),
    );
  };
  const working = () => container.querySelector("span")?.dataset.workingAvatar;
  renderRow("a", true);
  expect(working()).toBe("false");
  act(() => viewport.update([{ key: "a", isViewable: true }]));
  expect(working()).toBe("true");
  renderRow("a", false);
  expect(working()).toBe("false");
  renderRow("b", true);
  expect(working()).toBe("false");
  act(() => viewport.update([{ key: "b", isViewable: true }]));
  expect(working()).toBe("true");
  act(() => viewport.update([{ key: "b", isViewable: false }]));
  expect(working()).toBe("false");
});
