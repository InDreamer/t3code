import { describe, expect, it } from "vite-plus/test";

import { resolvePaComposerSendMode } from "./PaComposer.logic";

const base = {
  running: true,
  draft: "also check the tests",
  isClientCommand: false,
  hasOpenRequests: false,
  canQueue: true,
};

describe("PA composer send mode", () => {
  it("sends or queues a ready attachment without a caption and blocks incomplete uploads", () => {
    const imageOnly = { ...base, draft: "", hasAttachments: true };
    expect(resolvePaComposerSendMode(imageOnly)).toBe("queue");
    expect(resolvePaComposerSendMode({ ...imageOnly, running: false })).toBe("send");
    expect(resolvePaComposerSendMode({ ...imageOnly, attachmentsBlocked: true })).toBe("blocked");
    expect(resolvePaComposerSendMode({ ...imageOnly, draft: "/stop", isClientCommand: true })).toBe(
      "queue",
    );
  });
  it("queues plain text behind a running turn and sends everything else as before", () => {
    expect(resolvePaComposerSendMode(base)).toBe("queue");
    expect(resolvePaComposerSendMode({ ...base, running: false })).toBe("send");
    expect(resolvePaComposerSendMode({ ...base, draft: "/stop", isClientCommand: true })).toBe(
      "send",
    );
    expect(resolvePaComposerSendMode({ ...base, draft: "  /usage" })).toBe("send");
  });

  it("takes nothing new while the turn waits on an answer or the engine has no queue", () => {
    expect(resolvePaComposerSendMode({ ...base, hasOpenRequests: true })).toBe("blocked");
    expect(resolvePaComposerSendMode({ ...base, canQueue: false })).toBe("blocked");
    expect(resolvePaComposerSendMode({ ...base, canQueue: false, draft: "/usage" })).toBe(
      "blocked",
    );
  });
});
