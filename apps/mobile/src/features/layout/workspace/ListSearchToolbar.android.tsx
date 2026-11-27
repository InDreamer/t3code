import { useNavigation } from "@react-navigation/native";
import { useGT } from "gt-react-native";
import { useEffect } from "react";
import { BackHandler, Keyboard } from "react-native";
import { usePaneRole } from "../../../components/ui/Pane";
import { isWorkspaceDetailRoute } from "./workspace-detail-selection";
import { AppBar } from "../../../components/ui/AppBar";
import { AppText as Text } from "../../../components/ui/AppText";
import { useAndroidControlSizing } from "../../../components/ui/useAndroidControlSizing";
import { appBarMenuItemsFromActions } from "../../../components/ui/menuActionItems";
import { useHardwareKeyboardCommand } from "../../keyboard/hardwareKeyboardCommands";
import { WorkspaceConnectionTitle } from "../../home/WorkspaceConnectionTitle";
import type { SharedSlotTab } from "./navigation-tab-order";
import { SharedSlotTitle } from "./SharedSlotTitle";
import { useWorkspaceTabs } from "./WorkspaceTabsContext";
import type { PullRequestFilterMenu } from "../../pull-requests/PullRequestListFilters";
import { openSettings } from "../../settings/settings-navigation";

/** Pull request, issue and Bot search share the thread list's Android header. */
export function ListSearchToolbar(props: {
  readonly tab: SharedSlotTab | "bots";
  readonly filters?: PullRequestFilterMenu | null;
  readonly onRequestVisibility?: () => void;
}) {
  const gt = useGT();
  const navigation = useNavigation();
  const { scale } = useAndroidControlSizing();
  const { filters, tab: section } = props;
  const sidebar = usePaneRole() === "sidebar";
  const workspace = useWorkspaceTabs()!;
  const { dispatch, getScrollOffset, recordScrollOffset, isTabActive } = workspace;
  const { onRequestVisibility } = props;
  const tab = workspace.state.tabs[section];
  const searching = tab.searchMode !== "resting";
  const openSearch = () => {
    onRequestVisibility?.();
    dispatch({
      type: "scroll",
      tab: section,
      offset: getScrollOffset(section),
    });
    dispatch({ type: "search", tab: section });
    return true;
  };
  useHardwareKeyboardCommand("focusSearch", openSearch);
  const closeSearch = () => {
    Keyboard.dismiss();
    recordScrollOffset(section, tab.searchEntryOffset);
    dispatch({ type: "cancel", tab: section });
  };
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to BackHandler while searching to close the list search on Android back
  useEffect(() => {
    if (!searching) return;
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      // Frozen Home screens stay mounted under a detail route or another tab,
      // so back only applies while this list is in front.
      const state = navigation.getState();
      const top = state?.routes[state.index]?.name;
      if (
        (top !== "Home" && !(sidebar && top && isWorkspaceDetailRoute(top))) ||
        !isTabActive(section)
      )
        return false;
      if (Keyboard.isVisible()) Keyboard.dismiss();
      else closeSearch();
      return true;
    });
    return () => subscription.remove();
  }, [searching, closeSearch, navigation, isTabActive, section, sidebar]);
  return (
    <AppBar
      title="T3 Code"
      titleContent={
        <WorkspaceConnectionTitle
          grow
          onPress={() => openSettings(navigation, "SettingsEnvironments")}
          brand={
            section === "bots" ? (
              <Text
                numberOfLines={1}
                maxFontSizeMultiplier={1.4}
                className="font-t3-bold text-foreground"
                style={{ fontSize: 20 * scale, letterSpacing: -0.4 * scale }}
              >
                {gt("Bots", { $context: "navigation tab, personal agent bots" })}
              </Text>
            ) : (
              <SharedSlotTitle tab={section} />
            )
          }
        />
      }
      search={{
        value: tab.query,
        onChangeText: (query) => dispatch({ type: "query", tab: section, query }),
        placeholder:
          section === "issues"
            ? gt("Search issues")
            : section === "bots"
              ? gt("Search bots")
              : gt("Search pull requests"),
        active: searching,
        onOpen: openSearch,
        onClose: closeSearch,
      }}
      menus={
        filters
          ? [
              {
                title: section === "issues" ? gt("Filter issues") : gt("Filter pull requests"),
                icon: filters.customized
                  ? "line.3.horizontal.decrease.circle.fill"
                  : "line.3.horizontal.decrease.circle",
                items: appBarMenuItemsFromActions(filters.actions, filters.onSelect),
              },
            ]
          : undefined
      }
    />
  );
}
