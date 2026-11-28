import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useNavigation } from "@react-navigation/native";
import { useAdaptiveWorkspaceLayout } from "../adaptive-workspace-context";
import { startOpeningEnvironmentThread } from "../../../state/threads";
import { startOpeningPaBot } from "../../pa/usePaBotChat";
import {
  selectWorkspaceDetail,
  type WorkspaceDetail,
  type WorkspaceDetailSheet,
} from "./workspace-detail-selection";

const first = (value: string | readonly string[] | undefined) =>
  typeof value === "string" ? value : value?.[0];

/** Starts loading a selected thread or PA Bot before navigation commits. */
export function startOpeningDetail(detail: WorkspaceDetail) {
  if (detail.name === "Thread") {
    const environmentId = first(detail.params?.environmentId);
    const threadId = first(detail.params?.threadId);
    if (environmentId && threadId) {
      startOpeningEnvironmentThread(EnvironmentId.make(environmentId), ThreadId.make(threadId));
    }
    return;
  }
  if (detail.name === "PaBot") {
    const environmentId = first(detail.params?.environmentId);
    const botId = first(detail.params?.botId);
    const sessionId = first(detail.params?.sessionId);
    if (environmentId && botId) {
      startOpeningPaBot(environmentId, botId, sessionId);
    }
  }
}

/**
 * Shows a page in the detail column the way selecting its list row does. Inside the workspace
 * layout this also settles its panes; outside it, the root stack's router still does the rest.
 */
export function useSelectWorkspaceDetail() {
  const navigation = useNavigation();
  const { selectDetail } = useAdaptiveWorkspaceLayout();
  return (
    selectDetail ??
    ((detail: WorkspaceDetail, sheet?: WorkspaceDetailSheet) => {
      startOpeningDetail(detail);
      navigation.dispatch(selectWorkspaceDetail(detail, sheet));
    })
  );
}
