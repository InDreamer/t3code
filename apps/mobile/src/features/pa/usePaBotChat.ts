import { useAtomValue } from "@effect/atom-react";
import { CommonActions, useNavigation } from "@react-navigation/native";
import { Atom } from "effect/reactivity";
import { useEffect, useSyncExternalStore } from "react";

import { paClient } from "./paApi";
import { createPaBotChat, type PaBotChat } from "./paBotChat";
import { paBotKey } from "./paBotParams";
import { refreshPaRoster } from "./paRosterStore";

const activeChats = new Map<string, PaBotChat>();
const chatAtom = Atom.family((key: string) =>
  Atom.make((get) => {
    const [environmentId, botId]: [string, string] = JSON.parse(key);
    const chat = createPaBotChat({
      api: paClient(environmentId),
      botId,
      onActivity: () => void refreshPaRoster(environmentId),
    });
    activeChats.set(key, chat);
    get.addFinalizer(() => {
      if (activeChats.get(key) === chat) activeChats.delete(key);
      chat.dispose();
    });
    return chat;
  }).pipe(Atom.setIdleTTL(1_000)),
);

export function bumpPaBotSettingsIfActive(environmentId: string, botId: string) {
  activeChats.get(paBotKey(environmentId, botId))?.bumpSettings();
}

export function usePaBotChat(environmentId: string, botId: string, initialSessionId?: string) {
  const navigation = useNavigation();
  const chat = useAtomValue(chatAtom(paBotKey(environmentId, botId)));
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a new explicit route selects its session on the shared feed
  useEffect(() => {
    if (!initialSessionId) return;
    chat.showSession(initialSessionId);
    navigation.dispatch(CommonActions.replaceParams({ environmentId, botId }));
  }, [chat, initialSessionId, navigation, environmentId, botId]);
  const state = useSyncExternalStore(chat.subscribe, chat.getState, chat.getState);
  return { chat, state };
}
