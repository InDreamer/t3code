/** What the composer's primary action does with the draft. */
export type PaComposerSendMode = "send" | "queue" | "blocked";

export function resolvePaComposerSendMode(input: {
  readonly running: boolean;
  readonly draft: string;
  readonly isClientCommand: boolean;
  readonly hasOpenRequests: boolean;
  readonly canQueue: boolean;
  readonly hasAttachments?: boolean;
  readonly attachmentsBlocked?: boolean;
}): PaComposerSendMode {
  if (input.attachmentsBlocked || (!input.draft.trim() && !input.hasAttachments)) return "blocked";
  if (!input.running || (input.isClientCommand && !input.hasAttachments)) return "send";
  // An engine without a queue, or a turn waiting on the user's answer, takes nothing new.
  if (!input.canQueue || input.hasOpenRequests) return "blocked";
  // The engine runs or refuses a command itself; only plain text waits behind the turn.
  return !input.hasAttachments && input.draft.trimStart().startsWith("/") ? "send" : "queue";
}
