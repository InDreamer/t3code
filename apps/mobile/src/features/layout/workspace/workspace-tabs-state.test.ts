import { describe, expect, it, vi } from "vite-plus/test";
import { act, createElement, createContext, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { WorkspaceRootScreen } from "./WorkspaceRootScreen.android";
import {
  initialWorkspaceTabsState,
  workspaceTabsReducer,
  shouldRestoreNativeSearch,
  workspaceTabForNativeSlot,
  resolveWorkspaceTabOrder,
  workspaceSearchBottomClearance,
  workspaceDockBottomClearance,
  workspaceUsesColumns,
  type WorkspaceTab,
  type WorkspaceTabsState,
} from "./workspace-tabs-state";

describe("compact list clearance", () => {
  it.each([
    { bottomInset: 34, keyboardHeight: 300, clearance: 380 },
    { bottomInset: 34, keyboardHeight: 0, clearance: 114 },
    { bottomInset: 34, keyboardHeight: 20, clearance: 114 },
  ])("keeps the last result above the keyboard and dock: %j", ({ clearance, ...input }) => {
    expect(workspaceDockBottomClearance(input)).toBe(clearance);
  });
});

describe("Duo list clearance", () => {
  it.each([18, 60])(
    "scrolls the last row above search with a %s-point native bar inset",
    (bottomBarInset) => {
      const clearance = workspaceSearchBottomClearance({
        bottomInset: 34,
        bottomBarInset,
        keyboardHeight: 0,
      });
      expect(clearance).toBe(bottomBarInset + 48 + 16);
    },
  );

  it("keeps the last row above search when the keyboard lifts the field", () => {
    expect(
      workspaceSearchBottomClearance({ bottomInset: 34, bottomBarInset: 18, keyboardHeight: 300 }),
    ).toBe(300 + 8 + 48 + 16);
  });

  it("falls back to the field's safe-area spacing before native bar metrics arrive", () => {
    expect(workspaceSearchBottomClearance({ bottomInset: 34, keyboardHeight: 0 })).toBe(
      34 + 48 + 16,
    );
    expect(workspaceSearchBottomClearance({ bottomInset: 0, keyboardHeight: 0 })).toBe(
      12 + 48 + 16,
    );
  });
});

describe("workspace root navigation", () => {
  it("pairs Settings, chats and pull requests with a detail column, and keeps Usage one page", () => {
    expect(workspaceUsesColumns("usage")).toBe(false);
    expect(workspaceUsesColumns("workflows")).toBe(false);
    expect(workspaceUsesColumns("usage", true)).toBe(true);
    expect(workspaceUsesColumns("threads")).toBe(true);
    expect(workspaceUsesColumns("pullRequests")).toBe(true);
    expect(workspaceUsesColumns("bots")).toBe(true);
  });

  it("keeps the registered defaults while customization is unavailable", () => {
    expect(resolveWorkspaceTabOrder(undefined)).toEqual([
      "threads",
      "bots",
      "pullRequests",
      "issues",
      "usage",
    ]);
    expect(resolveWorkspaceTabOrder(["home", "usage", "issues", "threads"])).toEqual(
      resolveWorkspaceTabOrder(undefined),
    );
  });

  it("retains separate queries and positions across tabs, and cancels only the current search", () => {
    let state = initialWorkspaceTabsState();
    state = workspaceTabsReducer(state, { type: "scroll", tab: "threads", offset: 640 });
    state = workspaceTabsReducer(state, { type: "search" });
    state = workspaceTabsReducer(state, { type: "query", query: "keyboard" });
    state = workspaceTabsReducer(state, { type: "scroll", tab: "threads", offset: 160 });
    state = workspaceTabsReducer(state, { type: "expand" });
    state = workspaceTabsReducer(state, { type: "select", tab: "pullRequests" });
    expect(state.tabs.pullRequests.query).toBe("");
    state = workspaceTabsReducer(state, { type: "scroll", tab: "pullRequests", offset: 240 });
    state = workspaceTabsReducer(state, { type: "search" });
    state = workspaceTabsReducer(state, { type: "query", query: "navigation" });
    state = workspaceTabsReducer(state, { type: "select", tab: "threads" });
    expect(state.tabs.threads).toMatchObject({
      query: "keyboard",
      scrollOffset: 160,
      searchMode: "expanded",
    });
    state = workspaceTabsReducer(state, { type: "cancel" });
    expect(state.tabs.threads).toMatchObject({
      query: "",
      scrollOffset: 640,
      searchMode: "resting",
    });
    expect(state.tabs.pullRequests).toMatchObject({
      query: "navigation",
      scrollOffset: 240,
      searchMode: "active",
    });
  });

  it("clear keeps search active without losing the position cancel restores", () => {
    let state = initialWorkspaceTabsState();
    state = workspaceTabsReducer(state, { type: "scroll", tab: "threads", offset: 500 });
    state = workspaceTabsReducer(state, { type: "search" });
    state = workspaceTabsReducer(state, { type: "query", query: "diff" });
    state = workspaceTabsReducer(state, { type: "scroll", tab: "threads", offset: 80 });
    state = workspaceTabsReducer(state, { type: "query", query: "" });
    state = workspaceTabsReducer(state, { type: "search" });
    expect(state.tabs.threads).toMatchObject({
      query: "",
      searchMode: "active",
      searchEntryOffset: 500,
    });
    expect(workspaceTabsReducer(state, { type: "cancel" }).tabs.threads.scrollOffset).toBe(500);
  });

  it("keeps the Settings search apart from the tab Settings opened over", () => {
    let state = workspaceTabsReducer(initialWorkspaceTabsState(), {
      type: "query",
      query: "diff",
      tab: "threads",
    });
    state = workspaceTabsReducer(state, { type: "search", tab: "settings" });
    state = workspaceTabsReducer(state, { type: "query", query: "theme", tab: "settings" });
    expect(state.tabs.settings).toMatchObject({ query: "theme", searchMode: "active" });
    state = workspaceTabsReducer(state, { type: "cancel", tab: "settings" });
    expect(state.tabs.settings).toMatchObject({ query: "", searchMode: "resting" });
    expect(state.tabs.threads.query).toBe("diff");
  });

  it("applying an empty-query view resets the position that search cancellation restores", () => {
    let state = initialWorkspaceTabsState();
    state = workspaceTabsReducer(state, { type: "scroll", tab: "pullRequests", offset: 640 });
    state = workspaceTabsReducer(state, { type: "search", tab: "pullRequests" });
    state = workspaceTabsReducer(state, { type: "query", tab: "pullRequests", query: "old query" });
    state = workspaceTabsReducer(state, { type: "scroll", tab: "pullRequests", offset: 80 });
    state = workspaceTabsReducer(state, { type: "cancel", tab: "pullRequests", scrollToTop: true });
    expect(state.tabs.pullRequests).toEqual({
      query: "",
      searchMode: "resting",
      scrollOffset: 0,
      searchEntryOffset: 0,
    });
  });

  it("a late native blur cannot reopen a cancelled search", () => {
    let state = workspaceTabsReducer(initialWorkspaceTabsState(), { type: "search" });
    state = workspaceTabsReducer(state, { type: "cancel" });
    expect(workspaceTabsReducer(state, { type: "expand" })).toBe(state);
  });

  it("a blur from the previous native tab cannot open search in the selected tab", () => {
    let state = workspaceTabsReducer(initialWorkspaceTabsState(), { type: "search" });
    state = workspaceTabsReducer(state, { type: "query", query: "keyboard" });
    state = workspaceTabsReducer(state, { type: "select", tab: "pullRequests" });
    state = workspaceTabsReducer(state, { type: "expand", tab: "threads" });
    expect(state.tabs.threads).toMatchObject({ query: "keyboard", searchMode: "expanded" });
    expect(state.tabs.pullRequests.searchMode).toBe("resting");
    expect(workspaceTabsReducer(state, { type: "select", tab: "pullRequests" })).toBe(state);
  });

  it("keeps an empty search closed after iOS closes it with only a blur", () => {
    const opened = workspaceTabsReducer(initialWorkspaceTabsState(), { type: "search" });
    const closed = workspaceTabsReducer(opened, { type: "expand" });
    const filtered = workspaceTabsReducer(closed, { type: "query", query: "skia" });

    expect(shouldRestoreNativeSearch(closed.tabs.threads, false)).toBe(false);
    expect(shouldRestoreNativeSearch(closed.tabs.threads, true)).toBe(true);
    expect(shouldRestoreNativeSearch(filtered.tabs.threads, false)).toBe(true);
    expect(shouldRestoreNativeSearch(opened.tabs.threads, false)).toBe(true);
    expect(shouldRestoreNativeSearch(initialWorkspaceTabsState().tabs.threads, true)).toBe(false);
  });

  it("returns from Usage without losing list state", () => {
    let state = workspaceTabsReducer(initialWorkspaceTabsState(), {
      type: "query",
      query: "retained",
      tab: "threads",
    });
    for (const tab of ["usage"] as const) {
      state = workspaceTabsReducer(state, { type: "select", tab });
      expect(state.selectedTab).toBe(tab);
      expect(workspaceTabsReducer(state, { type: "search" })).toBe(state);
    }
    state = workspaceTabsReducer(state, { type: "select", tab: "threads" });
    expect(state.tabs.threads.query).toBe("retained");
  });
  it("opens Settings on native reselection instead of selecting its overflow section", () => {
    const order = ["threads", "pullRequests", "usage"] as const;
    expect(workspaceTabForNativeSlot(order, "settings")).toBe("settings");
    expect(workspaceTabForNativeSlot(order, "first")).toBe("threads");
    expect(workspaceTabForNativeSlot(order, "third")).toBe("usage");
    expect(workspaceTabForNativeSlot(order, "removed")).toBeNull();
  });
});

const mocks = vi.hoisted(() => ({
  split: false,
  floating: false,
  sidebar: false,
  top: "Home",
  canCreate: true,
  rosterError: false,
  navigate: vi.fn(),
  state: undefined as WorkspaceTabsState | undefined,
  openWorkspaceTab: (_tab: string) => {},
  backListeners: new Set<() => boolean>(),
}));

vi.mock("../../settings/appearance/AppearancePreferencesProvider", () => ({
  useAndroidFloatingTabs: () => mocks.floating,
}));
vi.mock("react-native", () => ({
  BackHandler: {
    addEventListener: (_event: string, listener: () => boolean) => {
      mocks.backListeners.add(listener);
      return { remove: () => mocks.backListeners.delete(listener) };
    },
  },
  Keyboard: { dismiss: () => undefined, isVisible: () => false },
  Platform: { OS: "android" },
  useWindowDimensions: () => ({ width: 400, height: 800 }),
  View: ({ children }: { children: ReactNode }) => createElement("div", null, children),
}));
vi.mock("react-native-safe-area-context", () => ({
  SafeAreaInsetsContext: createContext({ top: 0, right: 0, bottom: 24, left: 0 }),
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 24, left: 0 }),
}));
vi.mock("../AdaptiveWorkspaceLayout", () => ({
  useAdaptiveWorkspaceLayout: () => ({
    layout: { usesSplitView: mocks.split },
    startNewTask: () => undefined,
  }),
}));
vi.mock("@react-navigation/native", () => ({
  useIsFocused: () => true,
  useNavigationState: () => null,
  useNavigation: () => ({
    navigate: mocks.navigate,
    getState: () => ({ index: 1, routes: [{ name: "Home" }, { name: mocks.top }] }),
  }),
}));
vi.mock("../adaptive-workspace-context", () => ({
  useAdaptiveWorkspaceLayout: () => ({ openWorkspaceTab: mocks.openWorkspaceTab }),
}));
vi.mock("./navigation-tabs", () => ({
  useEnabledNavigationTabs: () => ["threads", "pullRequests", "usage"],
}));
vi.mock("./WorkspaceTabsContext", () => ({
  WorkspaceTabsContext: createContext(null),
  useWorkspaceTabs: () => ({
    state: mocks.state,
    dispatch: () => undefined,
    getScrollOffset: () => 0,
    recordScrollOffset: () => undefined,
    isTabActive: (tab: string) => mocks.state?.selectedTab === tab,
  }),
}));
vi.mock("./WorkspaceExtraTab", () => ({
  WorkspaceExtraTab: function UsageProbe() {
    const [tab, setTab] = useState("Limits");
    return createElement("button", { onClick: () => setTab("Usage") }, tab);
  },
}));
vi.mock("../../../native/StackHeader", () => ({ NativeStackScreenOptions: () => null }));
vi.mock("../../../components/ui/AppBar", () => ({ AppBar: () => null }));
vi.mock("../WorkspaceEmptyDetail", () => ({ WorkspaceEmptyDetail: () => null }));
vi.mock("../../../components/ui/ScreenContent", () => ({
  ScreenContent: ({ children }: { children: ReactNode }) => createElement("div", null, children),
}));
vi.mock("../../../components/ui/useAndroidControlSizing", () => ({
  useAndroidControlSizing: () => ({ fabClearance: 64, scale: 1, fabSize: 56 }),
}));
vi.mock("../../home/HomeRouteScreen", () => ({ HomeRouteScreen: () => null }));
vi.mock("../../pull-requests/PullRequestFilterMenuContext", () => ({
  PullRequestFilterMenuProvider: ({ children }: { children: ReactNode }) =>
    createElement("div", null, children),
}));
vi.mock("../../pull-requests/PullRequestsScreen", () => ({ PullRequestsScreen: () => null }));
vi.mock("../../issues/IssuesScreen", () => ({ IssuesScreen: () => null }));
vi.mock("../../../components/ui/AppText", () => ({ AppText: "span" }));
vi.mock("../../../components/ui/AppActivityIndicator", () => ({
  AppActivityIndicator: () => null,
}));
vi.mock("../../../components/ui/Button", () => ({
  Button: ({ label, onPress }: { label: string; onPress: () => void }) =>
    createElement("button", { onClick: onPress }, label),
}));
vi.mock("../../../components/ui/Dialog", () => ({}));
vi.mock("../../../components/ui/EmptyState", () => ({
  EmptyState: ({ title, action }: { title: string; action?: ReactNode }) =>
    createElement("div", null, title, action),
}));
vi.mock("../../../components/ui/RefreshControl", () => ({ RefreshControl: () => null }));
vi.mock("../../../components/ui/useBarInset", () => ({ useContentTopInset: () => 0 }));
vi.mock("../../../native/NativeScrollViewMarker", () => ({ NativeScrollView: () => null }));
vi.mock("../../../native/native-layout-metrics", () => ({
  useNativeColumnLayoutMetrics: () => null,
}));
vi.mock("../../../native/v5-workspace-context", () => ({
  NativePrimaryColumnContext: createContext(null),
}));
vi.mock("../../../state/workspace", () => ({
  useWorkspaceEnvironments: () => [
    { environmentId: "env", isEnabled: true, connectionState: "connected" },
  ],
}));
vi.mock("./useSearchScrollRestoration", () => ({ useSearchScrollRestoration: () => undefined }));
vi.mock("./useSelectWorkspaceDetail", () => ({ useSelectWorkspaceDetail: () => vi.fn() }));
vi.mock("../../threads/useMessageTimeFormatter", () => ({ useMessageTimeFormatter: () => String }));
vi.mock("../../pa/paApi", () => ({}));
vi.mock("../../pa/PaBotRow", () => ({
  PaBotRow: ({ bot }: { bot: { name: string } }) => createElement("div", null, bot.name),
}));
vi.mock("../../pa/paRosterStore", () => ({
  usePaCreatableEngines: () => (mocks.canCreate ? ["engine"] : []),
  usePaRosterRefresh: () => undefined,
  usePaRosterEntries: () =>
    new Map([
      [
        "env",
        {
          instances: [{ online: true }],
          bots: mocks.rosterError ? [] : [{ name: "Helper bot", botId: "helper" }],
          loading: false,
          error: mocks.rosterError ? "Offline" : null,
          loadedAt: 1,
        },
      ],
    ]),
}));
vi.mock("@legendapp/list/react-native", () => ({
  LegendList: ({
    data,
    renderItem,
    ListHeaderComponent,
    ListFooterComponent,
  }: {
    data: { key: string }[];
    renderItem: (props: { item: { key: string } }) => ReactNode;
    ListHeaderComponent?: ReactNode;
    ListFooterComponent?: ReactNode;
  }) =>
    createElement(
      "div",
      null,
      ListHeaderComponent,
      data.map((item) => createElement("div", { key: item.key }, renderItem({ item }))),
      ListFooterComponent,
    ),
}));
vi.mock("../../keyboard/hardwareKeyboardCommands", () => ({
  useHardwareKeyboardCommand: () => undefined,
}));
vi.mock("../../home/WorkspaceConnectionTitle", () => ({ WorkspaceConnectionTitle: () => null }));
vi.mock("./SharedSlotTitle", () => ({ SharedSlotTitle: () => null }));
vi.mock("../../settings/settings-navigation", () => ({}));
vi.mock("./AndroidWorkspaceTabsProvider", () => ({ useAndroidWorkspaceRoot: () => null }));
vi.mock("./WorkspaceThreadSidebar", () => ({ WorkspaceThreadSidebar: () => null }));
vi.mock("../../home/AndroidHomeFab", () => ({ AndroidHomeFabLayout: () => null }));
vi.mock("./AndroidWorkspaceNavigation", () => ({
  AndroidWorkspaceNavigation: () => null,
  FloatingWorkspaceTabs: () => null,
}));
vi.mock("./WorkspaceNoTabs", () => ({ WorkspaceNoTabs: () => null }));
vi.mock("../../../components/ui/Pane", () => ({
  usePaneRole: () => (mocks.sidebar ? "sidebar" : "screen"),
}));
vi.mock("../../../components/ui/WorkspaceAppBar.android", () => ({
  WorkspaceAppBarScope: ({ children }: { children: ReactNode }) => children,
}));

function setup(split: boolean, floating: boolean, state = selected("usage")) {
  mocks.sidebar = false;
  mocks.canCreate = true;
  mocks.rosterError = false;
  mocks.top = "Home";
  mocks.split = split;
  mocks.floating = floating;
  mocks.state = state;
  mocks.openWorkspaceTab = () => undefined;
  mocks.backListeners.clear();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  return { [Symbol.dispose]: () => vi.unstubAllGlobals() };
}

function selected(tab: WorkspaceTab) {
  return workspaceTabsReducer(initialWorkspaceTabsState(), { type: "select", tab });
}

/** Android calls the newest listener first and stops at the first that handles Back. */
function pressBack() {
  return [...mocks.backListeners].reverse().some((listener) => listener());
}

it("Back from the Pulls tab returns to Threads instead of leaving the app", async () => {
  using _actEnvironment = setup(false, false, selected("pullRequests"));
  const opened: string[] = [];
  mocks.openWorkspaceTab = (tab) => opened.push(tab);
  const root = createRoot(document.createElement("div"));
  using _root = { [Symbol.dispose]: () => act(() => root.unmount()) };
  await act(async () => root.render(createElement(WorkspaceRootScreen)));

  expect(pressBack()).toBe(true);
  expect(opened).toEqual(["threads"]);
});

it.each([
  [false, false],
  [true, false],
  [false, true],
  [true, true],
])(
  "keeps the Usage page mounted through layout transitions (split: %s, floating: %s)",
  async (split, floating) => {
    using _actEnvironment = setup(split, floating);
    const container = document.createElement("div");
    const root = createRoot(container);
    using _root = { [Symbol.dispose]: () => act(() => root.unmount()) };
    await act(async () => root.render(createElement(WorkspaceRootScreen)));

    const button = container.querySelector("button")!;
    await act(async () => button.click());
    expect(button.textContent).toBe("Usage");

    for (const nextSplit of [!split, split, !split, split]) {
      mocks.split = nextSplit;
      await act(async () => root.render(createElement(WorkspaceRootScreen)));
      expect(container.querySelector("button")?.textContent).toBe("Usage");
      expect(container.querySelector("button")).toBe(button);
    }
  },
);

it.each([false, true])(
  "opens Create from a populated Android Bots list (sidebar %s)",
  (sidebar) => {
    using _actEnvironment = setup(sidebar, false, selected("bots"));
    mocks.sidebar = sidebar;
    const container = document.createElement("div");
    const root = createRoot(container);
    using _root = { [Symbol.dispose]: () => act(() => root.unmount()) };
    const show = () =>
      act(() =>
        root.render(
          createElement(WorkspaceRootScreen, { key: String(mocks.canCreate) + mocks.rosterError }),
        ),
      );
    show();
    expect(container.textContent).toContain("Helper bot");
    const create = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Create bot",
    );
    expect(create).toBeDefined();
    act(() => create!.click());
    expect(mocks.navigate).toHaveBeenCalledWith("PaCreateBot", {});
    mocks.rosterError = true;
    show();
    expect(container.textContent).toContain("Offline");
    expect(container.textContent).toContain("No bots yet");
    expect(container.textContent).toContain("Create bot");
    mocks.canCreate = false;
    show();
    expect(container.textContent).not.toContain("Create bot");
  },
);

it("keeps Android sidebar search from swallowing Back over a sheet", () => {
  using _actEnvironment = setup(
    true,
    false,
    workspaceTabsReducer(selected("bots"), { type: "search", tab: "bots" }),
  );
  mocks.sidebar = true;
  const root = createRoot(document.createElement("div"));
  using _root = { [Symbol.dispose]: () => act(() => root.unmount()) };
  act(() => root.render(createElement(WorkspaceRootScreen)));
  for (const top of ["PaCreateBot", "PaBotSettings", "PaModel", "Settings"]) {
    mocks.top = top;
    expect(pressBack()).toBe(false);
  }
  for (const top of ["PaBot", "Thread", "PullRequest", "Issue", "Home"]) {
    mocks.top = top;
    expect(pressBack()).toBe(true);
  }
});
