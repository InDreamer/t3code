import { PaError, type PaSendResult } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { sendPaChatMessage, trackAdmittedPaRow } from "./BotChatPane.logic";

describe("PA send receipts", () => {
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
});
