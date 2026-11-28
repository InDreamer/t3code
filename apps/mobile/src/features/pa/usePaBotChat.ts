import { useAtomValue } from "@effect/atom-react";
import { CommonActions, useNavigation } from "@react-navigation/native";
import { sessionDeniesScope } from "@t3tools/client-runtime/state/session";
import { AuthOrchestrationReadScope, EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { useEffect, useSyncExternalStore } from "react";

import { appAtomRegistry } from "../../state/atom-registry";
import { connectedEnvironmentIdsAtom } from "../../state/presentation";
import { environmentSession } from "../../state/session";
import { paCache, paClient } from "./paApi";
import { createPaBotChat, type PaBotChat } from "./paBotChat";
import { paBotKey } from "./paBotParams";
import {
  forgetPaBotSession,
  getRememberedPaBotSession,
  notePaBotActivity,
  onPaBotsRemoved,
  readPaRosterEntry,
  rememberPaBotSession,
} from "./paRosterStore";

// Matches Code's THREAD_SNAPSHOT_IDLE_TTL_MS: keep memory cache + resume tokens for 5 minutes
// while `chat.hold()` releases the live stream immediately on unmount.
const PA_CHAT_IDLE_TTL_MS = 5 * 60_000;
// Long enough for the opened screen to mount and take over `hold()`.
const OPENING_PA_BOT_HOLD_MS = 3_000;

const environmentGenerations = new Map<string, number>();
const botGenerations = new Map<string, number>();
const activeChats = new Map<string, { readonly chat: PaBotChat; readonly botKey: string }>();
const activeByBotKey = new Map<string, PaBotChat>();

function environmentGeneration(environmentId: string): number {
  return environmentGenerations.get(environmentId) ?? 0;
}

function botGeneration(environmentId: string, botId: string): number {
  return botGenerations.get(paBotKey(environmentId, botId)) ?? 0;
}

function chatAtomKey(environmentId: string, botId: string): string {
  return JSON.stringify([
    environmentId,
    botId,
    environmentGeneration(environmentId),
    botGeneration(environmentId, botId),
  ]);
}

const chatAtom = Atom.family((key: string) =>
  Atom.make((get) => {
    const [environmentId, botId]: [string, string, number, number] = JSON.parse(key);
    const botKey = paBotKey(environmentId, botId);
    const envId = EnvironmentId.make(environmentId);
    const chat = createPaBotChat({
      api: paClient(environmentId),
      botId,
      persistence: {
        loadSession: (sessionId) => paCache.loadSession(envId, botId, sessionId),
        saveSession: (sessionId, page, pageTag) =>
          paCache.saveSession(envId, botId, sessionId, page, pageTag),
        removeSession: (sessionId) => paCache.removeSession(envId, botId, sessionId),
        removeBotSessions: () => paCache.removeBotSessions(envId, botId),
        rememberLastSession: (sessionId) => rememberPaBotSession(environmentId, botId, sessionId),
        forgetLastSession: (sessionId) => forgetPaBotSession(environmentId, botId, sessionId),
        getRememberedSession: () => getRememberedPaBotSession(environmentId, botId),
      },
      onActivity: (patch) => notePaBotActivity(environmentId, botId, patch),
    });
    const entry = { chat, botKey };
    activeChats.set(key, entry);
    activeByBotKey.set(botKey, chat);
    get.addFinalizer(() => {
      if (activeChats.get(key) === entry) activeChats.delete(key);
      if (activeByBotKey.get(botKey) === chat) activeByBotKey.delete(botKey);
      chat.dispose();
    });
    return chat;
  }).pipe(Atom.setIdleTTL(PA_CHAT_IDLE_TTL_MS)),
);

function disposeActiveEntry(
  key: string,
  entry: { readonly chat: PaBotChat; readonly botKey: string },
) {
  activeChats.delete(key);
  if (activeByBotKey.get(entry.botKey) === entry.chat) activeByBotKey.delete(entry.botKey);
  entry.chat.dispose({ discardPending: true });
}

onPaBotsRemoved((environmentId, botId) => {
  const targetBotKey = paBotKey(environmentId, botId);
  botGenerations.set(targetBotKey, botGeneration(environmentId, botId) + 1);
  for (const [key, entry] of Array.from(activeChats.entries())) {
    if (entry.botKey !== targetBotKey) continue;
    disposeActiveEntry(key, entry);
  }
});

export function bumpPaBotSettingsIfActive(environmentId: string, botId: string) {
  activeByBotKey.get(paBotKey(environmentId, botId))?.bumpSettings();
}

export function clearPaBotChatsEnvironment(environmentId: string) {
  paCache.bumpEnvironmentGeneration(EnvironmentId.make(environmentId));
  environmentGenerations.set(environmentId, environmentGeneration(environmentId) + 1);
  for (const [key, entry] of Array.from(activeChats.entries())) {
    const [envId]: [string, string, number, number] = JSON.parse(key);
    if (envId !== environmentId) continue;
    disposeActiveEntry(key, entry);
  }
}

/** Starts loading a selected PA Bot before navigation commits, matching `startOpeningEnvironmentThread`. */
export function startOpeningPaBot(environmentId: string, botId: string, sessionId?: string) {
  const envId = EnvironmentId.make(environmentId);
  const readDenied = sessionDeniesScope(
    appAtomRegistry.get(environmentSession.sessionStateAtom(envId)),
    AuthOrchestrationReadScope,
  );
  if (readDenied) return;
  const connected = appAtomRegistry.get(connectedEnvironmentIdsAtom).includes(envId);
  const atom = chatAtom(chatAtomKey(environmentId, botId));
  const unmount = appAtomRegistry.mount(atom);
  const chat = appAtomRegistry.get(atom);
  const entry = readPaRosterEntry(environmentId);
  const bot = entry.bots.find((item) => item.botId === botId) ?? null;
  const capabilities =
    (bot && entry.instances.find((item) => item.instanceId === bot.instanceId)?.capabilities) ??
    null;
  if (sessionId) chat.showSession(sessionId);
  else if (bot?.primarySessionId && !chat.getState().activeSessionId) {
    chat.showSession(bot.primarySessionId);
  }
  const releaseHold = chat.hold();
  chat.prime({
    capabilities,
    primarySessionId: bot?.primarySessionId ?? null,
    connected,
    readDenied,
  });
  setTimeout(() => {
    releaseHold();
    unmount();
  }, OPENING_PA_BOT_HOLD_MS);
}

export function usePaBotChat(environmentId: string, botId: string, initialSessionId?: string) {
  const navigation = useNavigation();
  const chat = useAtomValue(chatAtom(chatAtomKey(environmentId, botId)));
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- holds the live session stream while mounted; releasing stops the feed without evicting the 5-minute memory cache
  useEffect(() => chat.hold(), [chat]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a new explicit route selects its session on the shared feed
  useEffect(() => {
    if (!initialSessionId) return;
    chat.showSession(initialSessionId);
    navigation.dispatch(CommonActions.replaceParams({ environmentId, botId }));
  }, [chat, initialSessionId, navigation, environmentId, botId]);
  const state = useSyncExternalStore(chat.subscribe, chat.getState, chat.getState);
  return { chat, state };
}
