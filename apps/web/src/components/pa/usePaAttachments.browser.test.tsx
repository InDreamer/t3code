import { useEffect } from "react";
import { Atom } from "effect/reactivity";
import { EnvironmentId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { act, render } from "../../../test/render";
import { attachmentEnvironment } from "../../state/attachments";
import { useAttachmentUploadStore } from "../../lib/attachmentUploadQueue";
import { usePaAttachments } from "./usePaAttachments";

const transfer = vi.hoisted(() => ({ start: vi.fn(), release: vi.fn(), prepare: vi.fn() }));
vi.mock("../../lib/attachmentUploadQueue", async (original) => ({
  ...(await original<typeof import("../../lib/attachmentUploadQueue")>()),
  startAttachmentUpload: transfer.start,
  releaseAttachmentUpload: transfer.release,
}));
vi.mock("../../lib/imageCompression", async (original) => ({
  ...(await original<typeof import("../../lib/imageCompression")>()),
  prepareImageForAttachment: transfer.prepare,
}));

const environmentId = EnvironmentId.make("pa-test");
type Intake = ReturnType<typeof usePaAttachments>;
function Probe({
  receive,
  maxImages = 10,
}: {
  receive: (value: Intake) => void;
  maxImages?: number;
}) {
  const intake = usePaAttachments(environmentId, { images: true, files: true, maxImages });
  useEffect(() => receive(intake));
  return null;
}

it("blocks an unfinished file, sends only its upload metadata, and releases removed selects", async () => {
  using _permission = vi
    .spyOn(attachmentEnvironment.createUploadUrl, "permissionAtom")
    .mockReturnValue(Atom.make(true));
  let intake!: Intake;
  await using screen = await render(
    <Probe
      receive={(value) => {
        intake = value;
      }}
    />,
  );
  const pdf = new File(["%PDF-1.4"], "paper.pdf", { type: "application/pdf" });
  await act(() => intake.add([pdf]));
  const id = intake.files[0]!.id;
  expect(transfer.start).toHaveBeenCalledWith({
    environmentId,
    image: expect.objectContaining({ id, file: pdf }),
  });
  expect(intake.blocked).toBe(true);
  await act(() =>
    useAttachmentUploadStore.setState({
      uploadsByImageId: {
        [id]: { status: "ready", environmentId, attachmentId: "pending-pdf" },
      },
    }),
  );
  expect(intake.blocked).toBe(false);
  expect(intake.ready).toEqual([
    { id: "pending-pdf", type: "file", name: pdf.name, mimeType: pdf.type, sizeBytes: pdf.size },
  ]);
  await act(() => intake.remove(id));
  expect(transfer.release).toHaveBeenCalledWith(id);
  expect(intake.ready).toEqual([]);
  await screen.unmount();
  useAttachmentUploadStore.setState({ uploadsByImageId: {} });
});

it("does not upload a prepared image after its session composer unmounts", async () => {
  using _permission = vi
    .spyOn(attachmentEnvironment.createUploadUrl, "permissionAtom")
    .mockReturnValue(Atom.make(true));
  const file = new File(["png"], "photo.png", { type: "image/png" });
  const prepared = Promise.withResolvers<{ ok: true; file: File }>();
  transfer.prepare.mockReturnValueOnce(prepared.promise);
  transfer.start.mockClear();
  let intake!: Intake;
  await using screen = await render(
    <Probe
      receive={(value) => {
        intake = value;
      }}
    />,
  );
  let adding!: Promise<boolean>;
  await act(() => {
    adding = intake.add([file]);
  });
  expect(intake.preparing).toHaveLength(1);
  await screen.unmount();
  prepared.resolve({ ok: true, file });
  await adding;
  expect(transfer.start).not.toHaveBeenCalled();
});

it("holds handed-off uploads until the send settles after unmount", async () => {
  using _permission = vi
    .spyOn(attachmentEnvironment.createUploadUrl, "permissionAtom")
    .mockReturnValue(Atom.make(true));
  let intake!: Intake;
  await using screen = await render(
    <Probe
      receive={(value) => {
        intake = value;
      }}
    />,
  );
  await act(() => intake.add([new File(["<svg/>"], "s".repeat(255), { type: "image/svg+xml" })]));
  const file = intake.files[0]!;
  expect(file.name).toBe("s".repeat(251) + ".svg");
  const finish = intake.handoff();
  await screen.unmount();
  expect(transfer.release).not.toHaveBeenCalledWith(file.id);
  finish(true);
  expect(transfer.release).toHaveBeenCalledWith(file.id);
});

it("accepts a PDF later in the batch when the image limit is reached", async () => {
  using _permission = vi
    .spyOn(attachmentEnvironment.createUploadUrl, "permissionAtom")
    .mockReturnValue(Atom.make(true));
  let intake!: Intake;
  await using _screen = await render(
    <Probe
      maxImages={0}
      receive={(value) => {
        intake = value;
      }}
    />,
  );
  const photo = new File(["image"], "p.png", { type: "image/png" });
  const paper = new File(["pdf"], "p.pdf", { type: "application/pdf" });
  await act(() => intake.add([photo, paper]));
  expect(intake.images).toHaveLength(0);
  expect(intake.files.map((item) => item.name)).toEqual(["p.pdf"]);
});
