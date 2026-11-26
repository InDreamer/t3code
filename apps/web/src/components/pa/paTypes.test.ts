import { describe, expect, it } from "vite-plus/test";

import { acceptPaSeq, type PaSeqCursor } from "./paTypes";

describe("acceptPaSeq", () => {
  it("accepts every replayed frame after a snapshot at the replay baseline", () => {
    // Before the fix the snapshot advanced the cursor to Hermes's watermark (12) and 11/12 dropped.
    const cursor: PaSeqCursor = { epoch: "ep-A", lastSeq: 10 };
    expect([11, 12, 13].map((seq) => acceptPaSeq(cursor, seq, "ep-A"))).toEqual([true, true, true]);
    expect(cursor.lastSeq).toBe(13);
  });

  it("drops duplicates within an epoch and restarts the baseline on a new epoch", () => {
    const cursor: PaSeqCursor = { epoch: "ep-A", lastSeq: 40 };
    expect(acceptPaSeq(cursor, 40, "ep-A")).toBe(false);
    expect(acceptPaSeq(cursor, 2, "ep-B")).toBe(true);
    expect(acceptPaSeq(cursor, 3, undefined)).toBe(true);
    expect(acceptPaSeq(cursor, 3, "ep-B")).toBe(false);
    expect(acceptPaSeq(cursor, undefined, undefined)).toBe(true);
  });
});
