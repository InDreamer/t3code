import {
  AuthOrchestrationOperateScope,
  EnvironmentId,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  type PaAttachment,
  type PaCapabilities,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { useGT } from "gt-react-native";
import { useLayoutEffect, useRef, useState } from "react";

import {
  isComposerImageAttachment,
  isFileBackedComposerAttachment,
  pickComposerFiles,
  pickComposerMedia,
  removePersistedComposerAttachmentFile,
  type DraftComposerAttachment,
} from "../../lib/composerImages";
import { retainComposerAttachmentFileForPreview } from "../../lib/composerAttachmentPreviewRetention";
import { uploadComposerAttachmentShared } from "../../state/composer-attachment-uploads";
import { useEnvironmentScope } from "../../state/session";

function discard(attachments: ReadonlyArray<DraftComposerAttachment>) {
  for (const attachment of attachments) {
    if (isFileBackedComposerAttachment(attachment)) {
      void removePersistedComposerAttachmentFile(attachment.fileUri);
    }
  }
}

/** The Bot composer's pending attachments: picked here, uploaded when the message is sent. */
export function usePaAttachments(environmentIdValue: string, caps: PaCapabilities["attachments"]) {
  const gt = useGT();
  const environmentId = EnvironmentId.make(environmentIdValue);
  const canUpload = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const enabled = canUpload && Boolean(caps?.images || caps?.files);
  const [items, setItems] = useState<ReadonlyArray<DraftComposerAttachment>>([]);
  const staged = useRef<ReadonlyArray<DraftComposerAttachment>>([]);
  const leases = useRef(new Map<string, () => void>());
  const release = (items: ReadonlyArray<DraftComposerAttachment>) => {
    for (const item of items) {
      leases.current.get(item.id)?.();
      leases.current.delete(item.id);
    }
  };
  const active = useRef(false);
  const uploadingRef = useRef(false);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- releases copied picker files when the session composer unmounts
  useLayoutEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      for (const releaseLease of leases.current.values()) releaseLease();
      leases.current.clear();
      staged.current = [];
    };
  }, []);
  const replace = (next: ReadonlyArray<DraftComposerAttachment>) => {
    staged.current = next;
    setItems(next);
  };
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  const add = (picked: ReadonlyArray<DraftComposerAttachment>) => {
    const allowed: DraftComposerAttachment[] = [];
    const rejected: DraftComposerAttachment[] = [];
    if (!active.current || uploadingRef.current) {
      discard(picked);
      return;
    }
    let images = staged.current.filter(isComposerImageAttachment).length;
    for (const attachment of picked) {
      const image = isComposerImageAttachment(attachment);
      const fits = image
        ? caps?.images === true && (caps.maxImages === undefined || images < caps.maxImages)
        : caps?.files === true &&
          attachment.sizeBytes <=
            Math.min(PROVIDER_SEND_TURN_MAX_FILE_BYTES, caps.maxFileBytes ?? Infinity);
      if (fits) {
        if (isFileBackedComposerAttachment(attachment)) {
          leases.current.set(attachment.id, retainComposerAttachmentFileForPreview(attachment));
        }
        allowed.push(attachment);
        if (image) images += 1;
      } else rejected.push(attachment);
    }
    discard(rejected);
    if (rejected.length > 0) setError(gt("Some attachments are not supported by this bot"));
    if (allowed.length > 0) replace([...staged.current, ...allowed]);
  };

  const uploadStaged = async (replayKey?: string) => {
    // A lost admission reply must replay the original payload, even if its pending uploads expired.
    const replay =
      replayKey === JSON.stringify(staged.current.map((item) => item.uploadedAttachmentId));
    const result: PaAttachment[] = [];
    for (const item of staged.current) {
      const id =
        replay && item.uploadEnvironmentId === environmentId && item.uploadedAttachmentId
          ? item.uploadedAttachmentId
          : await Effect.runPromise(uploadComposerAttachmentShared(environmentId, item));
      if (!active.current) return null;
      replace(
        staged.current.map((attachment) =>
          attachment.id === item.id
            ? { ...attachment, uploadedAttachmentId: id, uploadEnvironmentId: environmentId }
            : attachment,
        ),
      );
      result.push({
        id,
        type: isComposerImageAttachment(item) ? "image" : "file",
        name: item.name,
        mimeType: item.mimeType,
        sizeBytes: item.sizeBytes,
      });
    }
    return result;
  };
  return {
    enabled,
    items,
    imageCount: items.filter(isComposerImageAttachment).length,
    uploading,
    error,
    dismissError: () => setError(null),
    async pick(kind: "media" | "files") {
      if (!enabled) return;
      setError(null);
      const result =
        kind === "files"
          ? await pickComposerFiles({ existingCount: items.length, maxBytes: caps?.maxFileBytes })
          : await pickComposerMedia({
              existingCount: items.length,
              selectionLimit:
                caps?.maxImages === undefined
                  ? undefined
                  : caps.maxImages - items.filter(isComposerImageAttachment).length,
              acceptSelection: () => active.current,
            });
      if (active.current && result.error) setError(result.error);
      add("files" in result ? result.files : result.attachments);
    },
    remove(id: string) {
      if (!active.current || uploadingRef.current) return;
      const removed = staged.current.filter((item) => item.id === id);
      release(removed);
      replace(staged.current.filter((item) => item.id !== id));
    },
    /** Uploads every pending attachment; null when one failed and the message should wait. */
    async upload(replayKey?: string): Promise<ReadonlyArray<PaAttachment> | null> {
      if (!active.current || uploadingRef.current || (!enabled && staged.current.length > 0))
        return null;
      if (!staged.current.length) return [];
      uploadingRef.current = true;
      setUploading(true);
      setError(null);
      return uploadStaged(replayKey)
        .catch(() => {
          if (active.current) setError(gt("Could not upload the attachments"));
          return null;
        })
        .finally(() => {
          uploadingRef.current = false;
          if (active.current) setUploading(false);
        });
    },
    clear(uploaded: ReadonlyArray<PaAttachment>) {
      if (!active.current) return;
      const ids = new Set(uploaded.map((item) => item.id));
      const wasSent = (item: DraftComposerAttachment) =>
        !!item.uploadedAttachmentId && ids.has(item.uploadedAttachmentId);
      release(staged.current.filter(wasSent));
      replace(staged.current.filter((item) => !wasSent(item)));
    },
  };
}
