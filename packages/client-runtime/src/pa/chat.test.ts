import { PaError, type PaSendResult } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { createPaPrimarySessionCreates, sendPaChatMessage, trackAdmittedPaRow } from "./chat.ts";

describe("PA send receipts", () => {
  it("reuses the input id only while the text and uploaded attachment ids match", async () => {
    const failed = new Map<string, { text: string; inputId: string; attachmentKey?: string }>();
    const send = vi
      .fn<(id: string) => Promise<PaSendResult>>()
      .mockRejectedValue(new PaError({ reason: "Unavailable", message: "lost" }));
    let next = 0;
    for (const ids of [["a"], ["a"], ["b"]]) {
      await expect(
        sendPaChatMessage(failed, "s", "", () => String(++next), send, ids),
      ).rejects.toMatchObject({ reason: "Unavailable" });
    }
    expect(send.mock.calls.map(([id]) => id)).toEqual(["1", "1", "2"]);
  });
  it("preserves another session's retry id and retires a command id after permanent conflict", async () => {
    const failed = new Map<string, { text: string; inputId: string }>();
    const send = vi
      .fn<(id: string) => Promise<PaSendResult>>()
      .mockRejectedValueOnce(new PaError({ reason: "Unavailable", message: "lost" }))
      .mockResolvedValueOnce({ kind: "output", sessionId: "b", output: "ok" })
      .mockRejectedValueOnce(new PaError({ reason: "Conflict", message: "unknown" }))
      .mockResolvedValueOnce({ kind: "output", sessionId: "a", output: "ok" });
    let serial = 0;
    const attempt = (sessionId: string) =>
      sendPaChatMessage(failed, sessionId, "/deploy", () => String(++serial), send);
    await expect(attempt("a")).rejects.toMatchObject({ reason: "Unavailable" });
    await attempt("b");
    await expect(attempt("a")).rejects.toMatchObject({ reason: "Conflict" });
    await attempt("a");
    expect(send.mock.calls.map(([id]) => id)).toEqual(["1", "2", "1", "3"]);
    expect(failed.size).toBe(0);
  });

  it("marks a rewritten prompt for transcript reconciliation when the feed settles before its receipt", async () => {
    const rows = new Map<string, Map<string, boolean>>();
    const receipt = Promise.withResolvers<PaSendResult>();
    const pending = sendPaChatMessage(
      new Map(),
      "a",
      "/brief",
      () => "input",
      () => receipt.promise,
    );
    let completionToken = 0;
    const beforeSend = completionToken;
    completionToken += 1;
    receipt.resolve({ kind: "turn", sessionId: "a", submissionId: "admitted" });
    const { result } = await pending;
    expect(
      trackAdmittedPaRow(rows, "a", "optimistic-row", result, completionToken !== beforeSend),
    ).toBe(true);
    expect(rows.get("a")?.get("optimistic-row")).toBe(true);
  });

  it("keeps no local row for a send that waits in the engine's queue", () => {
    const rows = new Map<string, Map<string, boolean>>();
    const queued: PaSendResult = { kind: "turn", sessionId: "a", submissionId: "q", queued: true };
    expect(trackAdmittedPaRow(rows, "a", "optimistic-row", queued, false)).toBe(false);
    expect(rows.has("a")).toBe(false);
  });
});

describe("PA primary session creates", () => {
  it("shares one in-flight create and reuses its key only after a transient failure", async () => {
    let keys = 0;
    const ensure = createPaPrimarySessionCreates<string>(() => `key-${++keys}`);
    const lost = Promise.withResolvers<string>();
    const create = vi
      .fn<(requestId: string) => Promise<string>>()
      .mockReturnValueOnce(lost.promise)
      .mockRejectedValueOnce(new PaError({ reason: "Forbidden", message: "no" }))
      .mockResolvedValue("session");
    const attempts = Promise.allSettled([ensure("bot", create), ensure("bot", create)]);
    lost.reject(new PaError({ reason: "Unavailable", message: "lost receipt" }));
    expect((await attempts).map((outcome) => outcome.status)).toEqual(["rejected", "rejected"]);
    await expect(ensure("bot", create)).rejects.toMatchObject({ reason: "Forbidden" });
    await expect(ensure("bot", create)).resolves.toBe("session");
    expect(create.mock.calls.map(([requestId]) => requestId)).toEqual(["key-1", "key-1", "key-2"]);
  });
});
