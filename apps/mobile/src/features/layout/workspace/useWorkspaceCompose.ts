import { usePaCreatableEngines } from "../../pa/paRosterStore";
import { useGT } from "gt-react-native";

import { rootNavigationRef } from "../../../lib/rootNavigation";
import { useAdaptiveWorkspaceLayout } from "../adaptive-workspace-context";
import { useWorkspaceTabs } from "./WorkspaceTabsContext";

/** What the compose button starts on the selected tab; null where the tab has nothing to start. */
export function useWorkspaceCompose() {
  const gt = useGT();
  const workspace = useWorkspaceTabs();
  const { startNewTask } = useAdaptiveWorkspaceLayout();
  const canCreate = usePaCreatableEngines(workspace?.state.selectedTab === "bots").length > 0;
  if (!workspace || workspace.settingsOpen) return null;
  if (workspace.state.selectedTab === "bots") {
    if (!canCreate) return null;
    // Also used by the navigator's own views, which sit outside any screen's navigation.
    const openCreate = () => {
      if (rootNavigationRef.isReady()) rootNavigationRef.navigate("PaCreateBot", {});
    };
    return { label: gt("Create bot"), onPress: openCreate } as const;
  }
  if (workspace.state.selectedTab !== "threads") return null;
  return { label: gt("New chat"), headerLabel: gt("New task"), onPress: startNewTask } as const;
}
