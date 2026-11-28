import { useAtomValue } from "@effect/atom-react";
import {
  createPaBotChat,
  type PaBotChat,
  type PaBotChatClient,
} from "@t3tools/client-runtime/pa/bot-chat";
import { EnvironmentId, PaError } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { useEffect, useLayoutEffect, useSyncExternalStore } from "react";

import { m } from "../../i18n/messages";
import { readPrimaryEnvironmentId } from "../../state/environments";
import { paApi, paCache } from "./paApi";
import {
  forgetPaBotSession,
  getRememberedPaBotSession,
  onWebPaBotsRemoved,
  rememberPaBotSession,
} from "./paBotsStore";

// Matches Code's THREAD_SNAPSHOT_IDLE_TTL_MS: keep memory cache + resume tokens for 5 minutes
// while `chat.hold()` releases the live stream immediately on unmount.
const PA_CHAT_IDLE_TTL_MS = 5 * 60_000;

interface WebPaChatHandlers {
  readonly onActivity: (patch?: { running?: true; awaiting?: true }) => void;
  readonly onSessionSelected: (sessionId: string) => void;
  readonly onVoiceStopped: () => void;
}

const NOOP_HANDLERS: WebPaChatHandlers = {
  onActivity: () => undefined,
  onSessionSelected: () => undefined,
  onVoiceStopped: () => undefined,
};

interface WebPaChatBinding {
  token: symbol | null;
  handlers: WebPaChatHandlers;
}

function assertPrimaryMatches(environmentId: EnvironmentId | null): void {
  if (environmentId === null) {
    throw new PaError({ reason: "Unavailable", message: "Not connected to the server yet" });
  }
  const primary = readPrimaryEnvironmentId();
  if (primary !== null && primary !== environmentId) {
    throw new PaError({ reason: "Unavailable", message: "Environment changed" });
  }
}

function webPaClientFor(environmentId: EnvironmentId | null): PaBotChatClient {
  const guard = <T>(run: () => Promise<T>): Promise<T> => {
    try {
      assertPrimaryMatches(environmentId);
      return run();
    } catch (error) {
      return Promise.reject(error);
    }
  };
  return {
    listSessions: (botId, page) => guard(() => paApi.listSessions(botId, page)),
    createSession: (botId, requestId, title) =>
      guard(() => paApi.createSession(botId, requestId, title)),
    ensurePrimarySession: (botId) => guard(() => paApi.ensurePrimarySession(botId)),
    getMessages: (botId, sessionId, page) =>
      guard(() =>
        page ? paApi.getMessages(botId, sessionId, page) : paApi.getMessages(botId, sessionId),
      ),
    listCommands: (botId) => guard(() => paApi.listCommands(botId)),
    markRead: (botId, seenReply) => guard(() => paApi.markRead(botId, seenReply)),
    sendMessage: (botId, sessionId, text, inputId, queued, attachments) =>
      guard(() => paApi.sendMessage(botId, sessionId, text, inputId, queued, attachments)),
    steerSession: (botId, sessionId, text) =>
      guard(() => paApi.steerSession(botId, sessionId, text)),
    interruptSession: (botId, sessionId) => guard(() => paApi.interruptSession(botId, sessionId)),
    manageQueuedItem: (botId, sessionId, itemId, action) =>
      guard(() => paApi.manageQueuedItem(botId, sessionId, itemId, action)),
    respondRequest: (input) => guard(() => paApi.respondRequest(input)),
    followSession: (botId, sessionId, handlers) => {
      try {
        assertPrimaryMatches(environmentId);
      } catch (error) {
        handlers.onFailure(error, { retrying: false });
        return () => undefined;
      }
      return paApi.followSession(botId, sessionId, handlers);
    },
  };
}

const environmentGenerations = new Map<string, number>();
const botGenerations = new Map<string, number>();
const activeChats = new Map<string, PaBotChat>();
const chatBindings = new WeakMap<PaBotChat, WebPaChatBinding>();

function environmentGeneration(environmentId: string): number {
  return environmentGenerations.get(environmentId) ?? 0;
}

function botGenerationKey(environmentId: string, botId: string): string {
  return JSON.stringify([environmentId, botId]);
}

function botGeneration(environmentId: string, botId: string): number {
  return botGenerations.get(botGenerationKey(environmentId, botId)) ?? 0;
}

function chatAtomKey(environmentId: EnvironmentId | null, botId: string): string {
  if (environmentId === null) return JSON.stringify([null, botId, 0, 0]);
  return JSON.stringify([
    environmentId,
    botId,
    environmentGeneration(environmentId),
    botGeneration(environmentId, botId),
  ]);
}

function bindWebPaChat(chat: PaBotChat, handlers: WebPaChatHandlers): () => void {
  const binding = chatBindings.get(chat);
  if (!binding) return () => undefined;
  const token = Symbol("web-pa-chat-binding");
  binding.token = token;
  binding.handlers = handlers;
  return () => {
    if (binding.token === token) {
      binding.token = null;
      binding.handlers = NOOP_HANDLERS;
    }
  };
}

const chatAtom = Atom.family((key: string) =>
  Atom.make((get) => {
    const [environmentId, botId]: [string | null, string, number, number] = JSON.parse(key);
    const envId = environmentId ? EnvironmentId.make(environmentId) : null;
    const binding: WebPaChatBinding = {
      token: null,
      handlers: NOOP_HANDLERS,
    };
    const chat = createPaBotChat({
      api: webPaClientFor(envId),
      botId,
      resolveMessage: m,
      persistence: envId
        ? {
            loadSession: (sessionId) =>
              paCache?.loadSession(envId, botId, sessionId) ?? Promise.resolve(null),
            saveSession: (sessionId, page, pageTag) =>
              paCache?.saveSession(envId, botId, sessionId, page, pageTag) ?? Promise.resolve(),
            removeSession: (sessionId) =>
              paCache?.removeSession(envId, botId, sessionId) ?? Promise.resolve(),
            removeBotSessions: () => paCache?.removeBotSessions(envId, botId) ?? Promise.resolve(),
            rememberLastSession: (sessionId) => rememberPaBotSession(envId, botId, sessionId),
            forgetLastSession: (sessionId) => forgetPaBotSession(envId, botId, sessionId),
            getRememberedSession: () => getRememberedPaBotSession(envId, botId),
          }
        : undefined,
      onActivity: (patch) => binding.handlers.onActivity(patch),
      onSessionSelected: (sessionId) => binding.handlers.onSessionSelected(sessionId),
      onVoiceStopped: () => binding.handlers.onVoiceStopped(),
    });
    chatBindings.set(chat, binding);
    activeChats.set(key, chat);
    get.addFinalizer(() => {
      if (activeChats.get(key) === chat) activeChats.delete(key);
      chat.dispose();
    });
    return chat;
  }).pipe(Atom.setIdleTTL(PA_CHAT_IDLE_TTL_MS)),
);

function disposeChatKey(key: string, chat: PaBotChat): void {
  activeChats.delete(key);
  chat.dispose({ discardPending: true });
}

onWebPaBotsRemoved((environmentId, botId) => {
  const genKey = botGenerationKey(environmentId, botId);
  botGenerations.set(genKey, botGeneration(environmentId, botId) + 1);
  for (const [key, chat] of Array.from(activeChats.entries())) {
    const [envId, entryBotId]: [string | null, string, number, number] = JSON.parse(key);
    if (envId !== environmentId || entryBotId !== botId) continue;
    disposeChatKey(key, chat);
  }
});

export function clearPaBotChatsEnvironment(environmentId: string): void {
  if (environmentId.trim().length > 0) {
    paCache?.bumpEnvironmentGeneration(EnvironmentId.make(environmentId));
  }
  environmentGenerations.set(environmentId, environmentGeneration(environmentId) + 1);
  for (const [key, chat] of Array.from(activeChats.entries())) {
    const [envId]: [string | null, string, number, number] = JSON.parse(key);
    if (envId !== environmentId) continue;
    disposeChatKey(key, chat);
  }
}

export function usePaBotChat(
  environmentId: EnvironmentId | null,
  botId: string,
  handlers: {
    readonly selectedSessionId: string | null;
    readonly onActivity: (patch?: { running?: true; awaiting?: true }) => void;
    readonly onSessionSelected: (sessionId: string) => void;
    readonly onVoiceStopped: () => void;
  },
) {
  const chat = useAtomValue(chatAtom(chatAtomKey(environmentId, botId)));
  const { onActivity, onSessionSelected, onVoiceStopped } = handlers;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- binds the retained controller's React callbacks while mounted and unbinds on unmount so late completions cannot navigate back to a bot the user left
  useLayoutEffect(
    () => bindWebPaChat(chat, { onActivity, onSessionSelected, onVoiceStopped }),
    [chat, onActivity, onSessionSelected, onVoiceStopped],
  );

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- holds the live stream while mounted; releasing stops the feed while keeping the 5-minute memory cache
  useEffect(() => chat.hold(), [chat]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- synchronizes an explicit URL session selection onto the shared controller
  useEffect(() => {
    if (handlers.selectedSessionId) {
      chat.showSession(handlers.selectedSessionId);
    }
  }, [chat, handlers.selectedSessionId]);

  const state = useSyncExternalStore(chat.subscribe, chat.getState, chat.getState);
  return { chat, state };
}
