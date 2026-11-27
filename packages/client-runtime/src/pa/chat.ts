import { isPermanentPaFailure } from "./environment.ts";
import type { PaMessage, PaSendResult, PaSlashCommand } from "@t3tools/contracts";

import type { PaLiveTurnState } from "./timeline.ts";

export async function sendPaChatMessage(
  failedSends: Map<string, { text: string; inputId: string; attachmentKey?: string }>,
  sessionId: string,
  text: string,
  newInputId: () => string,
  send: (inputId: string) => Promise<PaSendResult>,
  attachmentIds: ReadonlyArray<string> = [],
) {
  const previous = failedSends.get(sessionId);
  const attachmentKey = JSON.stringify(attachmentIds);
  const inputId =
    previous?.text === text && previous.attachmentKey === attachmentKey
      ? previous.inputId
      : newInputId();
  try {
    const result = await send(inputId);
    failedSends.delete(sessionId);
    return { result, inputId };
  } catch (err) {
    if (isPermanentPaFailure(err)) failedSends.delete(sessionId);
    else failedSends.set(sessionId, { text, inputId, attachmentKey });
    throw err;
  }
}

export function trackAdmittedPaRow(
  pendingRows: Map<string, Map<string, boolean>>,
  sessionId: string,
  rowId: string,
  result: PaSendResult,
  endedMeanwhile: boolean,
) {
  // A queued send is shown from the queue until its own turn stores it: nothing local to reconcile.
  if (result.kind !== "turn" || result.queued === true) return false;
  const ended = result.settled === true || endedMeanwhile;
  const pending = pendingRows.get(sessionId) ?? new Map<string, boolean>();
  pending.set(rowId, ended);
  pendingRows.set(sessionId, pending);
  return ended;
}

function randomHex128(): string {
  const bytes = new Uint8Array(16);
  const crypto = globalThis.crypto;
  if (typeof crypto?.getRandomValues === "function") crypto.getRandomValues(bytes);
  // @effect-diagnostics-next-line globalRandom:off - Runtimes without Web Crypto still need a key.
  else for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** An idempotency key: the engine applies a retried request with the same key once. */
export function makePaRequestKey(prefix: string, random: () => string = randomHex128): string {
  return `${prefix}-${random()}`;
}

/**
 * Creates each Bot's primary session once, however many mounts ask concurrently. A transient
 * failure keeps its request key, so the retry returns the session a lost answer already made.
 */
export function createPaPrimarySessionCreates<T>(newRequestKey: () => string) {
  const attempts = new Map<string, { readonly requestId: string; inFlight?: Promise<T> }>();
  return async (key: string, create: (requestId: string) => Promise<T>): Promise<T> => {
    const attempt = attempts.get(key) ?? { requestId: newRequestKey() };
    if (attempt.inFlight) return attempt.inFlight;
    attempts.set(key, attempt);
    attempt.inFlight = create(attempt.requestId);
    try {
      const created = await attempt.inFlight;
      attempts.delete(key);
      return created;
    } catch (error) {
      if (isPermanentPaFailure(error)) attempts.delete(key);
      throw error;
    } finally {
      delete attempt.inFlight;
    }
  };
}

let localMessageSeq = 0;

/** A row shown on this device until the stored transcript carries it. */
export function createPaLocalMessage(
  role: PaMessage["role"],
  text: string,
  timestamp: number,
): PaMessage {
  localMessageSeq += 1;
  return { id: `local-${role}-${localMessageSeq}`, role, text, timestamp, rowKind: "message" };
}

/** Grows whenever the live turn shows more, so a reader following the end stays there. */
export function paLiveTurnScrollSignature(turn: PaLiveTurnState): number {
  let score = turn.blocks.length * 10 + turn.openRequests.length * 100;
  for (const block of turn.blocks) {
    if (block.kind === "text") {
      score += block.text.length;
    } else {
      score += block.steps.length * 20;
      for (const step of block.steps) {
        score += step.text.length + (step.toolResult?.length ?? 0);
      }
    }
  }
  return score;
}

/** Everyday engine commands that answer at once, offered on an empty conversation. */
export function selectPaQuickCommands(
  commands: ReadonlyArray<PaSlashCommand>,
  count = 3,
): ReadonlyArray<string> {
  return commands
    .filter(
      (command) =>
        command.featured === true &&
        command.group === "command" &&
        command.requiredScope === "operate" &&
        (command.handling === "engine" || command.handling === "client:model-picker"),
    )
    .slice(0, count)
    .map((command) => command.name);
}
