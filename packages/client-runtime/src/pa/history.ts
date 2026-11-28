import type { PaMessage, PaSessionSummary } from "@t3tools/contracts";

/** An admitted local row may share its caption with another message, including an empty caption. */
export function paUserMessageContentKey(message: PaMessage): string {
  return JSON.stringify([
    message.text.trim(),
    message.attachments?.map((attachment) => attachment.id) ?? [],
  ]);
}

/** A transcript as shown: contiguous rows, oldest first, and where to read the page before them. */
export interface PaTranscriptWindow {
  readonly messages: ReadonlyArray<PaMessage>;
  /** Reads the page before `messages[0]`; null once the conversation's start is shown. */
  readonly olderCursor: string | null;
}

export interface PaMessagePageInput {
  readonly messages: ReadonlyArray<PaMessage>;
  readonly nextCursor?: string | null | undefined;
  readonly reset?: boolean | undefined;
}

const pageWindow = (page: PaMessagePageInput): PaTranscriptWindow => ({
  messages: page.messages,
  olderCursor: page.nextCursor ?? null,
});

function samePaMessage(a: PaMessage, b: PaMessage): boolean {
  if (a === b) return true;
  if (
    a.id !== b.id ||
    a.role !== b.role ||
    a.text !== b.text ||
    a.timestamp !== b.timestamp ||
    a.rowKind !== b.rowKind ||
    a.commentary !== b.commentary ||
    a.rowId !== b.rowId ||
    a.submissionId !== b.submissionId ||
    a.truncated !== b.truncated ||
    a.compactedMessages !== b.compactedMessages ||
    a.reasoning !== b.reasoning ||
    a.toolCallId !== b.toolCallId ||
    a.toolName !== b.toolName ||
    a.toolCategory !== b.toolCategory ||
    a.toolContext !== b.toolContext ||
    a.toolFailed !== b.toolFailed
  ) {
    return false;
  }
  const aAtt = a.attachments;
  const bAtt = b.attachments;
  if ((aAtt?.length ?? 0) !== (bAtt?.length ?? 0)) return false;
  if (aAtt && bAtt) {
    for (let i = 0; i < aAtt.length; i += 1) {
      const left = aAtt[i]!;
      const right = bAtt[i]!;
      if (
        left.id !== right.id ||
        left.type !== right.type ||
        left.name !== right.name ||
        left.mimeType !== right.mimeType ||
        left.sizeBytes !== right.sizeBytes ||
        left.unavailable !== right.unavailable
      ) {
        return false;
      }
    }
  }
  if (a.toolArgs !== b.toolArgs) {
    if (JSON.stringify(a.toolArgs ?? null) !== JSON.stringify(b.toolArgs ?? null)) return false;
  }
  return true;
}

/** True when two transcript windows hold the exact same cursor and normalized rows. */
function samePaTranscriptWindow(a: PaTranscriptWindow, b: PaTranscriptWindow): boolean {
  if (a === b) return true;
  if (a.olderCursor !== b.olderCursor || a.messages.length !== b.messages.length) return false;
  for (let i = 0; i < a.messages.length; i += 1) {
    if (!samePaMessage(a.messages[i]!, b.messages[i]!)) return false;
  }
  return true;
}

/**
 * Applies a fresh read of the newest page. Older pages the reader already loaded stay above it
 * when the two overlap; a page that does not reach back to what is shown (more new rows than one
 * page holds) or a `reset` replaces the window, since stitching across the gap would hide rows.
 */
export function mergePaLatestPage(
  current: PaTranscriptWindow | null,
  page: PaMessagePageInput,
): PaTranscriptWindow {
  let next: PaTranscriptWindow;
  if (
    page.nextCursor == null ||
    current === null ||
    page.reset === true ||
    current.messages.length === 0
  ) {
    next = pageWindow(page);
  } else {
    const first = page.messages[0];
    if (first === undefined) {
      // An emptied transcript (a rewind or reset) shows as empty.
      next = pageWindow(page);
    } else {
      const overlap = current.messages.findIndex((message) => message.id === first.id);
      if (overlap <= 0) {
        next = pageWindow(page);
      } else {
        const fresh = new Set(page.messages.map((message) => message.id));
        const kept = current.messages.slice(0, overlap).filter((message) => !fresh.has(message.id));
        // The kept rows start where the window did, so its cursor still reads the page before them.
        next = { messages: [...kept, ...page.messages], olderCursor: current.olderCursor };
      }
    }
  }
  return current !== null && samePaTranscriptWindow(current, next) ? current : next;
}

/** Puts an older page above what is shown; a `reset` page is the newest page and replaces it. */
export function prependPaOlderPage(
  current: PaTranscriptWindow,
  page: PaMessagePageInput,
): PaTranscriptWindow {
  if (page.reset === true) return pageWindow(page);
  const shown = new Set(current.messages.map((message) => message.id));
  const older = page.messages.flatMap((message) => {
    if (!shown.has(message.id)) return [message];
    // Older Hermes adapters hashed anonymous rows without the page cursor.
    if (message.rowId == null && !message.submissionId && message.id.startsWith("h-")) {
      const id = JSON.stringify([current.olderCursor, message.id]);
      if (!shown.has(id)) return [{ ...message, id }];
    }
    return [];
  });
  return {
    messages: older.length === 0 ? current.messages : [...older, ...current.messages],
    olderCursor: page.nextCursor ?? null,
  };
}

/** Appends a further page of sessions, keeping the first listing of each id. */
export function appendPaSessionPage(
  current: ReadonlyArray<PaSessionSummary>,
  page: ReadonlyArray<PaSessionSummary>,
): ReadonlyArray<PaSessionSummary> {
  const listed = new Set(current.map((session) => session.sessionId));
  const added = page.filter((session) => !listed.has(session.sessionId));
  return added.length === 0 ? current : [...current, ...added];
}
