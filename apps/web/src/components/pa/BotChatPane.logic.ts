import { isPermanentPaFailure } from "@t3tools/client-runtime/pa/environment";
import type { PaSendResult } from "@t3tools/contracts";

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
