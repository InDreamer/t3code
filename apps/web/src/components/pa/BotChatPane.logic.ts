import { isPermanentPaFailure } from "@t3tools/client-runtime/pa/environment";
import type { PaSendResult } from "@t3tools/contracts";

export async function sendPaChatMessage(
  failedSends: Map<string, { text: string; inputId: string }>,
  sessionId: string,
  text: string,
  newInputId: () => string,
  send: (inputId: string) => Promise<PaSendResult>,
) {
  const previous = failedSends.get(sessionId);
  const inputId = previous?.text === text ? previous.inputId : newInputId();
  try {
    const result = await send(inputId);
    failedSends.delete(sessionId);
    return { result, inputId };
  } catch (err) {
    if (isPermanentPaFailure(err)) failedSends.delete(sessionId);
    else failedSends.set(sessionId, { text, inputId });
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
  if (result.kind !== "turn") return false;
  const ended = result.settled === true || endedMeanwhile;
  const pending = pendingRows.get(sessionId) ?? new Map<string, boolean>();
  pending.set(rowId, ended);
  pendingRows.set(sessionId, pending);
  return ended;
}
