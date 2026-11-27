import { EnvironmentId, type PaCapabilities } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { act, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

import {
  registerComposerAttachmentUnusedHandler,
  retainComposerAttachmentFileForPreview,
} from "../../lib/composerAttachmentPreviewRetention";
import { isComposerAttachmentFileRetained } from "../../lib/composerAttachmentFiles";
import { loadLocalAttachmentPreview } from "../../lib/localAttachmentPreview";
import type { DraftComposerFileAttachment } from "../../lib/composerImages";
import { usePaAttachments } from "./usePaAttachments";

const { pick, upload, discard } = vi.hoisted(() => ({
  pick: vi.fn<() => Promise<{ files: DraftComposerFileAttachment[]; error: null }>>(),
  upload:
    vi.fn<
      (environment: string, item: DraftComposerFileAttachment) => Effect.Effect<string, string>
    >(),
  discard: vi.fn(),
}));
vi.mock("expo-file-system", () => ({
  File: class {
    constructor(readonly uri: string) {}
    get exists() {
      return !discard.mock.calls.some(([uri]) => uri === this.uri);
    }
  },
  Paths: { document: { uri: "file:///Documents" } },
}));
vi.mock("../../lib/attachmentDownload", () => ({ shareLocalAttachment: vi.fn() }));
vi.mock("../../state/session", () => ({ useEnvironmentScope: () => true }));
vi.mock("../../state/composer-attachment-uploads", () => ({
  uploadComposerAttachmentShared: upload,
}));
vi.mock("../../lib/composerImages", () => ({
  pickComposerFiles: pick,
  isComposerImageAttachment: () => false,
  isFileBackedComposerAttachment: () => true,
  removePersistedComposerAttachmentFile: discard,
}));

const file = (id: string): DraftComposerFileAttachment => ({
  id,
  type: "file",
  name: id,
  mimeType: "text/plain",
  sizeBytes: 1,
  fileUri: "file:///" + id,
});
const caps: PaCapabilities["attachments"] = { images: false, files: true };

it("retains successful uploads across partial failures and discards files when their session unmounts", async () => {
  registerComposerAttachmentUnusedHandler((item) => discard(item.fileUri));
  let staged!: ReturnType<typeof usePaAttachments>;
  function Composer({ environment }: { environment: string }) {
    const attachments = usePaAttachments(environment, caps);
    useLayoutEffect(() => {
      staged = attachments;
    });
    return null;
  }
  const root = createRoot(document.createElement("div"));
  const render = (environment: string, session: string) =>
    act(() => root.render(<Composer key={environment + session} environment={environment} />));
  try {
    render("one", "A");
    pick.mockResolvedValueOnce({ files: [file("a"), file("b")], error: null });
    await act(() => staged.pick("files"));
    // Closing the document preview and unwinding a failed upload each release a shared lease.
    const preview = await loadLocalAttachmentPreview(file("a"), new AbortController().signal);
    expect(preview).not.toBeNull();
    preview!.dispose();
    expect(isComposerAttachmentFileRetained(file("a").fileUri)).toBe(true);
    upload.mockReturnValueOnce(Effect.succeed("asset-a")).mockImplementationOnce((_env, item) =>
      Effect.acquireUseRelease(
        Effect.sync(() => retainComposerAttachmentFileForPreview(item)),
        () => Effect.fail("offline"),
        (release) => Effect.sync(release),
      ),
    );
    await act(async () => {
      expect(await staged.upload()).toBeNull();
    });
    expect(isComposerAttachmentFileRetained(file("b").fileUri)).toBe(true);
    expect(discard).not.toHaveBeenCalled();
    upload
      .mockReturnValueOnce(Effect.succeed("replacement-a"))
      .mockReturnValueOnce(Effect.succeed("asset-b"));
    await act(async () => {
      expect((await staged.upload())?.map((item) => item.id)).toEqual(["replacement-a", "asset-b"]);
    });
    expect(upload.mock.calls.map(([, item]) => item.id)).toEqual(["a", "b", "a", "b"]);
    expect(upload.mock.calls[2]?.[1].uploadedAttachmentId).toBe("asset-a");
    await act(async () => {
      const replay = await staged.upload(JSON.stringify(["replacement-a", "asset-b"]));
      expect(replay?.map((item) => item.id)).toEqual(["replacement-a", "asset-b"]);
      staged.clear(replay!.slice(0, 1));
    });
    expect(upload).toHaveBeenCalledTimes(4);
    expect(isComposerAttachmentFileRetained(file("a").fileUri)).toBe(false);
    const late = Promise.withResolvers<{ files: DraftComposerFileAttachment[]; error: null }>();
    pick.mockReturnValueOnce(late.promise);
    const pending = staged.pick("files");
    render("one", "B");
    late.resolve({ files: [file("late")], error: null });
    await act(() => pending);
    expect(staged.items).toEqual([]);
    expect(discard.mock.calls.flat()).toEqual(["file:///a", "file:///b", "file:///late"]);
    render("two", "B");
    pick.mockResolvedValueOnce({
      files: [
        {
          ...file("a"),
          uploadedAttachmentId: "asset-a",
          uploadEnvironmentId: EnvironmentId.make("one"),
        },
      ],
      error: null,
    });
    await act(() => staged.pick("files"));
    upload.mockReturnValueOnce(Effect.succeed("other-asset"));
    await act(async () => {
      expect((await staged.upload())?.[0]?.id).toBe("other-asset");
    });
    expect(upload.mock.calls.at(-1)?.[0]).toBe("two");
  } finally {
    act(() => root.unmount());
  }
});
