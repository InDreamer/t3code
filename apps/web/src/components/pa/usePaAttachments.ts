import { useEffect, useRef, useState } from "react";
import { useGT } from "gt-react";
import { useShallow } from "zustand/react/shallow";
import {
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  type EnvironmentId,
  type PaCapabilities,
  type PaAttachment,
} from "@t3tools/contracts";
import type { ComposerFileAttachment, ComposerImageAttachment } from "../../composerDraftStore";
import { prepareImageForAttachment } from "../../lib/imageCompression";
import {
  releaseAttachmentUpload,
  startAttachmentUpload,
  useAttachmentUploadStore,
} from "../../lib/attachmentUploadQueue";
import { useAtomValue } from "@effect/atom-react";
import { attachmentEnvironment } from "../../state/attachments";
import {
  classifyComposerAttachmentFile,
  composerFileAttachmentMimeType,
  normalizeComposerImageFileMimeType,
} from "../chat/composerAttachmentFiles";
import type { PreparingComposerImage } from "../chat/preparingComposerImages";
import { makePaRequestKey } from "./paApi";

type DraftItem =
  | ComposerImageAttachment
  | ComposerFileAttachment
  | (PreparingComposerImage & { type: "preparing" });

function release(item: DraftItem) {
  releaseAttachmentUpload(item.id);
  if (item.type === "image") URL.revokeObjectURL(item.previewUrl);
}

export function usePaAttachments(
  environmentId: EnvironmentId | null,
  caps: PaCapabilities["attachments"],
) {
  const gt = useGT();
  const canUpload = useAtomValue(
    attachmentEnvironment.createUploadUrl.permissionAtom(environmentId),
  );
  const enabled = canUpload && Boolean(caps?.images || caps?.files);
  const owned = useRef(new Map<string, DraftItem>());
  const handedOff = useRef(new Set<string>());
  const [items, setItems] = useState<DraftItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const publish = () => setItems(Array.from(owned.current.values()));

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the keyed composer owns these uploads and blob URLs until it unmounts.
  useEffect(() => {
    const uploads = owned.current;
    const inFlight = handedOff.current;
    return () => {
      for (const item of uploads.values()) if (!inFlight.has(item.id)) release(item);
      uploads.clear();
    };
  }, []);

  const remove = (id: string) => {
    const item = owned.current.get(id);
    if (!item || handedOff.current.has(id)) return;
    owned.current.delete(id);
    release(item);
    publish();
  };
  const add = async (files: File[]) => {
    if (!environmentId || !enabled) return false;
    setError(null);
    const preparing: PreparingComposerImage[] = [];
    for (const file of files) {
      const type = classifyComposerAttachmentFile(file);
      const imageCount = [...owned.current.values()].filter((item) => item.type !== "file").length;
      if (
        owned.current.size >= PROVIDER_SEND_TURN_MAX_ATTACHMENTS ||
        (type === "image" && caps?.maxImages !== undefined && imageCount >= caps.maxImages)
      ) {
        setError(gt("Attachment limit reached for this message"));
        if (owned.current.size >= PROVIDER_SEND_TURN_MAX_ATTACHMENTS) break;
        continue;
      }
      if (
        !file.size ||
        type === "unsupported-image" ||
        (type === "image" ? !caps?.images : !caps?.files)
      ) {
        setError(gt("Could not add {name}", { name: file.name }));
        continue;
      }
      const id = makePaRequestKey("pa-upload");
      if (type === "image") {
        const item = { id, type: "preparing" as const, name: file.name, file, hidden: false };
        owned.current.set(id, item);
        preparing.push(item);
      } else {
        if (
          file.size > Math.min(PROVIDER_SEND_TURN_MAX_FILE_BYTES, caps?.maxFileBytes ?? Infinity)
        ) {
          setError(gt("File {name} exceeds the size limit", { name: file.name }));
          continue;
        }
        const mimeType = composerFileAttachmentMimeType(file);
        const name =
          mimeType === "image/svg+xml" && !/\.svg$/i.test(file.name)
            ? file.name.slice(0, 251) + ".svg"
            : file.name;
        const item: ComposerFileAttachment = {
          id,
          type: "file",
          name,
          mimeType,
          sizeBytes: file.size,
          file,
        };
        owned.current.set(id, item);
        startAttachmentUpload({ environmentId, image: item });
      }
    }
    publish();
    for (const original of preparing) {
      if (!owned.current.has(original.id)) continue;
      const result = await prepareImageForAttachment(
        normalizeComposerImageFileMimeType(original.file),
        PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
      ).catch(() => null);
      if (!owned.current.has(original.id)) continue;
      if (!result?.ok) {
        owned.current.delete(original.id);
        setError(gt("Could not process image {name}", { name: original.name }));
      } else {
        const { file } = result;
        const image: ComposerImageAttachment = {
          id: original.id,
          type: "image",
          name: file.name,
          mimeType: file.type,
          sizeBytes: file.size,
          file,
          previewUrl: URL.createObjectURL(file),
        };
        owned.current.set(image.id, image);
        startAttachmentUpload({ environmentId, image });
      }
      publish();
    }
    return false;
  };
  const uploads = useAttachmentUploadStore(
    useShallow((state) =>
      items.map((item) => {
        const upload = state.uploadsByImageId[item.id];
        return upload?.status === "ready" && upload.environmentId === environmentId
          ? upload.attachmentId
          : null;
      }),
    ),
  );
  const ready: PaAttachment[] = [];
  for (const [index, item] of items.entries()) {
    const id = uploads[index];
    if (item.type !== "preparing" && id) {
      ready.push({
        id,
        type: item.type,
        name: item.name,
        mimeType: item.mimeType,
        sizeBytes: item.sizeBytes,
      });
    }
  }
  return {
    enabled,
    handoff: () => {
      const sent = [...owned.current.values()];
      for (const item of sent) handedOff.current.add(item.id);
      return (accepted: boolean) => {
        for (const item of sent) {
          handedOff.current.delete(item.id);
          if (!owned.current.has(item.id)) release(item);
          else if (accepted) remove(item.id);
        }
      };
    },
    add,
    remove,
    error,
    dismissError: () => setError(null),
    items,
    ready,
    blocked: items.length !== ready.length || (items.length > 0 && !enabled),
    images: items.filter((item) => item.type === "image"),
    files: items.filter((item) => item.type === "file"),
    preparing: items.filter((item) => item.type === "preparing"),
  };
}
