import {
  createPaBotChat as createSharedPaBotChat,
  paBotChatView,
  type PaBotChat,
  type PaBotChatClient,
  type PaBotChatContext,
  type PaBotChatPersistence,
  type PaBotChatState,
  type PaCachedSessionWindow,
  type PaClarifyAnswers,
  type PaFollowSessionOptions,
  type PaSecretAnswer,
} from "@t3tools/client-runtime/pa/bot-chat";

import { m } from "../../i18n/messages";

export {
  paBotChatView,
  type PaBotChat,
  type PaBotChatClient,
  type PaBotChatContext,
  type PaBotChatPersistence,
  type PaBotChatState,
  type PaCachedSessionWindow,
  type PaClarifyAnswers,
  type PaFollowSessionOptions,
  type PaSecretAnswer,
};

export function createPaBotChat(
  input: Omit<Parameters<typeof createSharedPaBotChat>[0], "resolveMessage">,
): PaBotChat {
  return createSharedPaBotChat({ ...input, resolveMessage: m });
}
