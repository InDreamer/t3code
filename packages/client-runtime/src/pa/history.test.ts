import type { PaMessage, PaSessionSummary } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  appendPaSessionPage,
  mergePaLatestPage,
  paUserMessageContentKey,
  prependPaOlderPage,
} from "./history.ts";

const row = (n: number): PaMessage => ({
  id: `row-${n}`,
  role: n % 2 === 0 ? "assistant" : "user",
  text: `m${n}`,
  timestamp: n,
  rowKind: "message",
  rowId: n,
});
const rows = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => row(from + i));
const ids = (messages: ReadonlyArray<PaMessage>) => messages.map((m) => m.rowId);

describe("PA transcript paging", () => {
  it("distinguishes attachment-only rows when reconciling a local admission", () => {
    const blank = { ...row(1), text: "" };
    const attachment = {
      id: "one",
      name: "scan.pdf",
      mimeType: "application/pdf",
      sizeBytes: 42,
      type: "file" as const,
    };
    const first = { ...blank, attachments: [attachment] };
    expect(paUserMessageContentKey(first)).toBe(paUserMessageContentKey({ ...first, id: "local" }));
    expect(paUserMessageContentKey(first)).not.toBe(paUserMessageContentKey(blank));
    expect(paUserMessageContentKey(first)).not.toBe(
      paUserMessageContentKey({ ...blank, attachments: [{ ...attachment, id: "two" }] }),
    );
  });
  it("keeps older pages the reader loaded when the newest page is read again", () => {
    let window = mergePaLatestPage(null, { messages: rows(11, 20), nextCursor: "c-10" });
    expect(window.olderCursor).toBe("c-10");
    window = prependPaOlderPage(window, { messages: rows(1, 10), nextCursor: null });
    expect(ids(window.messages)).toEqual(ids(rows(1, 20)));
    expect(window.olderCursor).toBeNull();

    // A turn ended: the newest page moved on by two rows but still overlaps what is shown.
    window = mergePaLatestPage(window, { messages: rows(13, 22), nextCursor: "c-12" });
    expect(ids(window.messages)).toEqual(ids(rows(1, 22)));
    expect(window.olderCursor).toBeNull();
  });

  it("replaces the window on a reset or a page that no longer reaches what is shown", () => {
    const loaded = prependPaOlderPage(
      mergePaLatestPage(null, { messages: rows(11, 20), nextCursor: "c-10" }),
      { messages: rows(1, 10), nextCursor: null },
    );
    expect(
      mergePaLatestPage(loaded, { messages: rows(15, 24), nextCursor: "c-14", reset: true }),
    ).toEqual({ messages: rows(15, 24), olderCursor: "c-14" });
    // More new rows than a page holds: stitching across the gap would hide rows.
    expect(mergePaLatestPage(loaded, { messages: rows(40, 49), nextCursor: "c-39" })).toEqual({
      messages: rows(40, 49),
      olderCursor: "c-39",
    });
    // A stale cursor answers the newest page again, which replaces what is shown.
    expect(prependPaOlderPage(loaded, { messages: rows(30, 39), reset: true })).toEqual({
      messages: rows(30, 39),
      olderCursor: null,
    });
  });

  it("replaces a removed prefix when the latest page is complete", () => {
    expect(
      mergePaLatestPage(
        { messages: rows(1, 4), olderCursor: null },
        { messages: rows(3, 5), nextCursor: null },
      ).messages,
    ).toEqual(rows(3, 5));
  });
  it("refreshes the cursor when the newest page starts where the window does", () => {
    const window = mergePaLatestPage(null, { messages: rows(1, 3), nextCursor: "old" });
    expect(mergePaLatestPage(window, { messages: rows(1, 4), nextCursor: "new" })).toEqual({
      messages: rows(1, 4),
      olderCursor: "new",
    });
  });

  it.each([null, 1700000000])("preserves identical page-scoped replies at %s", (timestamp) => {
    const reply = {
      role: "assistant" as const,
      text: "OK",
      rowKind: "message" as const,
      timestamp,
    };
    const current = mergePaLatestPage(null, {
      messages: [{ ...reply, id: "h-latest" }],
      nextCursor: "older",
    });
    const window = prependPaOlderPage(current, {
      messages: [{ ...reply, id: "h-older" }],
      nextCursor: null,
    });
    expect(window.messages.map((message) => message.text)).toEqual(["OK", "OK"]);
    const legacy = prependPaOlderPage(current, { messages: current.messages, nextCursor: null });
    expect(legacy.messages.map((message) => message.text)).toEqual(["OK", "OK"]);
    expect(new Set(legacy.messages.map((message) => message.id)).size).toBe(2);
  });

  it("drops rows a page repeats so ids stay unique", () => {
    const window = mergePaLatestPage(null, { messages: rows(5, 8), nextCursor: "c-4" });
    const merged = prependPaOlderPage(window, { messages: rows(3, 6), nextCursor: "c-2" });
    expect(ids(merged.messages)).toEqual([3, 4, 5, 6, 7, 8]);
    expect(merged.olderCursor).toBe("c-2");
  });
});

describe("PA session paging", () => {
  const session = (sessionId: string): PaSessionSummary => ({
    sessionId,
    title: sessionId,
    source: "gui",
    model: null,
    messageCount: 0,
    running: false,
    startedAt: null,
    lastActivityAt: null,
    isPrimary: false,
  });

  it("appends a further page without listing a session twice", () => {
    const first = [session("a"), session("b")];
    expect(
      appendPaSessionPage(first, [session("b"), session("c")]).map((s) => s.sessionId),
    ).toEqual(["a", "b", "c"]);
    expect(appendPaSessionPage(first, [session("a")])).toBe(first);
  });
});
