// @effect-diagnostics nodeBuiltinImport:off -- PA owns atomic journal writes and immutable upload links.
import * as NodeCrypto from "node:crypto";
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import {
  PaError,
  getProviderAttachmentLimitError,
  isProviderSendTurnSupportedImageMimeType,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  PaAttachment,
  type PaCapabilities,
  type PaMessage,
  type PaQueuedItem,
} from "@t3tools/contracts";
import {
  PA_ATTACHMENT_SEGMENT,
  PENDING_ATTACHMENT_THREAD_SEGMENT,
  parseAttachmentFileExtension,
  parseThreadSegmentFromAttachmentId,
  resolveAttachmentPath,
  resolveAttachmentPathById,
} from "../attachmentStore.ts";
import * as Schema from "effect/Schema";
import type { PaLocalAttachment, PaStagedAttachment } from "./types.ts";
import { isSvgAttachment } from "@t3tools/shared/image";

const Journal = Schema.Array(
  Schema.Struct({
    inputId: Schema.String,
    text: Schema.String,
    textDigest: Schema.String,
    uploads: Schema.Array(Schema.String),
    attachments: Schema.Array(
      PaAttachment.check(
        Schema.makeFilter(
          (item) => parseThreadSegmentFromAttachmentId(item.id) === PA_ATTACHMENT_SEGMENT,
        ),
      ),
    ),
    referenceKeys: Schema.Array(Schema.String),
    staged: Schema.optionalKey(
      Schema.Array(
        Schema.Union([
          Schema.Struct({ key: Schema.String, fileRef: Schema.String }),
          Schema.Struct({
            key: Schema.String,
            image: Schema.Struct({ path: Schema.String, mime: Schema.String }),
          }),
        ]),
      ),
    ),
    submissionId: Schema.optionalKey(Schema.String),
    admissionId: Schema.optionalKey(Schema.String),
    rowId: Schema.optionalKey(Schema.Int),
  }),
);
interface AttachmentRecord extends Omit<(typeof Journal.Type)[number], "staged"> {
  readonly staged?: ReadonlyArray<PaStagedAttachment>;
}
const validJournal = Schema.is(Journal);

// Hermes gateway/session_api_media.py inserts this caption for an image without text.
const HERMES_DEFAULT_IMAGE_CAPTION = "What do you see in this image?";

export function paAttachmentName(raw: string) {
  const name = raw
    .split(/[\\/]/)
    .at(-1)
    ?.replace(/\p{Cc}/gu, "")
    .trim()
    .slice(0, 255)
    .trimEnd();
  return name && name !== "." && name !== ".." ? name : "attachment";
}

const invalid = (message: string) => new PaError({ reason: "Invalid", message });
const MAX_CACHED_JOURNALS = 8;
const PREVIEW_CHARS = 1_024;
const digest = (text: string) => NodeCrypto.createHash("sha256").update(text).digest("hex");

export class PaAttachmentStore {
  private readonly stateDir: string;
  private readonly attachmentsDir: string;
  private readonly recent = new Map<string, AttachmentRecord[]>();
  private readonly ownerKnown = new Set<string>();
  constructor(stateDir: string, attachmentsDir: string) {
    this.stateDir = stateDir;
    this.attachmentsDir = attachmentsDir;
  }

  private ownerCacheKey(botId: string, sessionId: string) {
    return `${botId}\u0000${sessionId}`;
  }

  private file(botId: string, sessionId: string) {
    const dir = NodePath.join(this.stateDir, "pa-attachments", digest(botId));
    const key = digest(sessionId);
    const file = NodePath.join(dir, key + ".json");
    // Journals written before per-bot cleanup used a flat, opaque composite key.
    const legacy = NodePath.join(
      NodePath.dirname(dir),
      digest(JSON.stringify([botId, sessionId])) + ".json",
    );
    if (NodeFS.existsSync(legacy) && !NodeFS.existsSync(file)) {
      NodeFS.mkdirSync(dir, { recursive: true });
      NodeFS.renameSync(legacy, file);
    }
    const alias = NodePath.join(dir, key + ".alias");
    if (!NodeFS.existsSync(alias)) return file;
    try {
      const canonicalKey = NodeFS.readFileSync(alias, "utf8");
      if (/^[a-f0-9]{64}$/.test(canonicalKey)) return NodePath.join(dir, canonicalKey + ".json");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return file;
  }

  private rememberOwnerKnown(botId: string, sessionId: string) {
    const key = this.ownerCacheKey(botId, sessionId);
    this.ownerKnown.delete(key);
    if (this.ownerKnown.size >= 2_048) {
      const oldest = this.ownerKnown.values().next().value;
      if (oldest !== undefined) this.ownerKnown.delete(oldest);
    }
    this.ownerKnown.add(key);
  }

  private clearOwnerKnown(botId: string) {
    const prefix = `${botId}\u0000`;
    for (const key of Array.from(this.ownerKnown)) {
      if (key.startsWith(prefix)) this.ownerKnown.delete(key);
    }
  }

  needsOwnerLookup(botId: string, sessionId: string) {
    if (this.ownerKnown.has(this.ownerCacheKey(botId, sessionId))) return false;
    const base = NodePath.join(this.stateDir, "pa-attachments");
    if (!NodeFS.existsSync(base)) return false;
    const dir = NodePath.join(base, digest(botId));
    if (!NodeFS.existsSync(dir))
      return NodeFS.readdirSync(base).some((name) => name.endsWith(".json"));
    const hasAlias = NodeFS.existsSync(NodePath.join(dir, digest(sessionId) + ".alias"));
    if (hasAlias) this.rememberOwnerKnown(botId, sessionId);
    return !hasAlias;
  }

  markOwnerKnown(botId: string, sessionId: string, canonicalId: string) {
    if (sessionId !== canonicalId) {
      this.bindSession(botId, sessionId, canonicalId);
      return;
    }
    const aliasPath = NodePath.join(
      this.stateDir,
      "pa-attachments",
      digest(botId),
      digest(sessionId) + ".alias",
    );
    NodeFS.rmSync(aliasPath, { force: true });
    this.rememberOwnerKnown(botId, sessionId);
  }

  bindSession(botId: string, sessionId: string, canonicalId: string) {
    if (sessionId === canonicalId) {
      this.markOwnerKnown(botId, sessionId, canonicalId);
      return;
    }
    const dir = NodePath.join(this.stateDir, "pa-attachments", digest(botId));
    const directFrom = NodePath.join(dir, digest(sessionId) + ".json");
    const to = this.file(botId, canonicalId);
    if (directFrom !== to && NodeFS.existsSync(directFrom)) {
      const previous = this.read(directFrom);
      if (previous.length) {
        const current = this.read(to);
        const ids = new Set(current.map((entry) => entry.inputId));
        this.write(to, [...current, ...previous.filter((entry) => !ids.has(entry.inputId))]);
        NodeFS.rmSync(directFrom, { force: true });
        this.recent.delete(directFrom);
      }
    }
    NodeFS.mkdirSync(NodePath.dirname(to), { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(NodePath.dirname(to), digest(sessionId) + ".alias"),
      NodePath.basename(to, ".json"),
    );
    this.rememberOwnerKnown(botId, sessionId);
    this.rememberOwnerKnown(botId, canonicalId);
  }

  private cache(file: string, records: AttachmentRecord[]) {
    this.recent.delete(file);
    if (this.recent.size >= MAX_CACHED_JOURNALS)
      this.recent.delete(this.recent.keys().next().value!);
    this.recent.set(file, records);
  }

  private read(file: string): AttachmentRecord[] {
    const cached = this.recent.get(file);
    if (cached) {
      this.cache(file, cached);
      return cached;
    }
    let raw: string;
    try {
      raw = NodeFS.readFileSync(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    let records: AttachmentRecord[] = [];
    try {
      const decoded: unknown = JSON.parse(raw);
      if (!validJournal(decoded)) throw invalid("Invalid attachment journal");
      records = [...decoded];
    } catch {
      NodeFS.renameSync(file, file + ".corrupt-" + NodeCrypto.randomUUID() + ".bak");
      process.emitWarning("PA attachment journal was backed up after a decode failure");
    }
    this.cache(file, records);
    return records;
  }

  private write(file: string, records: AttachmentRecord[]) {
    NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
    const tmp = file + "." + NodeCrypto.randomUUID() + ".tmp";
    try {
      NodeFS.writeFileSync(tmp, JSON.stringify(records), { mode: 0o600 });
      NodeFS.renameSync(tmp, file);
      this.cache(file, records);
    } finally {
      NodeFS.rmSync(tmp, { force: true });
    }
  }

  async claim(
    botId: string,
    sessionId: string,
    inputId: string,
    text: string,
    uploads: ReadonlyArray<PaAttachment>,
    caps: NonNullable<PaCapabilities["attachments"]>,
  ): Promise<PaLocalAttachment[]> {
    const ids = uploads.map((item) => item.id);
    if (ids.length !== new Set(ids).size) throw invalid("Duplicate attachments");
    const limit = getProviderAttachmentLimitError(uploads);
    if (limit) throw invalid(limit);
    const imageCount = uploads.filter((item) => item.type === "image").length;
    if (caps.maxImages !== undefined && imageCount > caps.maxImages)
      throw invalid("Too many images");
    const file = this.file(botId, sessionId);
    const records = this.read(file);
    const previous = records.find((record) => record.inputId === inputId);
    const replay = (previous: AttachmentRecord) => {
      if (
        JSON.stringify(ids) !== JSON.stringify(previous.uploads) ||
        digest(text) !== previous.textDigest
      ) {
        throw new PaError({
          reason: "Conflict",
          message: "This input already has different content",
        });
      }
      return previous.attachments.map((metadata) => ({
        metadata,
        path: this.assetPath(metadata),
      }));
    };
    if (previous) return replay(previous);
    const created: PaLocalAttachment[] = [];
    try {
      for (const raw of uploads) {
        const name = paAttachmentName(raw.name);
        const upload =
          raw.type === "file" && isSvgAttachment(raw) && !/\.svg$/i.test(name)
            ? { ...raw, name: name.slice(0, 251) + ".svg" }
            : { ...raw, name };
        const { id, type, sizeBytes } = upload;
        if (
          upload.unavailable ||
          sizeBytes < 1 ||
          parseThreadSegmentFromAttachmentId(id) !== PENDING_ATTACHMENT_THREAD_SEGMENT
        ) {
          throw invalid("Expected a pending upload");
        }
        const suffix = parseAttachmentFileExtension(id);
        if (
          type === "image"
            ? !caps.images ||
              suffix !== null ||
              sizeBytes > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES ||
              !isProviderSendTurnSupportedImageMimeType(upload.mimeType)
            : !caps.files ||
              suffix === null ||
              sizeBytes > Math.min(caps.maxFileBytes ?? Infinity, PROVIDER_SEND_TURN_MAX_FILE_BYTES)
        ) {
          throw invalid("Unsupported attachment type or size");
        }
        const source = resolveAttachmentPathById({
          attachmentsDir: this.attachmentsDir,
          attachmentId: id,
        });
        if (!source || source !== this.assetPath(upload))
          throw invalid("Upload missing or type mismatch");
        const stat = NodeFS.lstatSync(source);
        if (!stat.isFile() || stat.size !== sizeBytes) throw invalid("Upload size mismatch");
        const metadata = {
          ...upload,
          id: PA_ATTACHMENT_SEGMENT + "-" + NodeCrypto.randomUUID() + (suffix ? "-" + suffix : ""),
        };
        const destination = this.assetPath(metadata);
        try {
          NodeFS.linkSync(source, destination);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EEXIST") throw error;
          await NodeFS.promises.copyFile(source, destination, NodeFS.constants.COPYFILE_EXCL);
        }
        created.push({ metadata, path: destination });
      }
      // A cross-device copy yielded. Another send may have claimed this input or appended a record.
      const current = this.read(file);
      const concurrent = current.find((record) => record.inputId === inputId);
      if (concurrent) {
        for (const item of created) NodeFS.rmSync(item.path, { force: true });
        return replay(concurrent);
      }
      const next = [
        ...current,
        {
          inputId,
          text: text.slice(0, PREVIEW_CHARS),
          textDigest: digest(text),
          uploads: ids,
          attachments: created.map((item) => item.metadata),
          referenceKeys: [],
        },
      ];
      this.write(file, next);
    } catch (error) {
      for (const item of created) NodeFS.rmSync(item.path, { force: true });
      throw error;
    }
    return created;
  }

  find(botId: string, sessionId: string, id: string) {
    return this.read(this.file(botId, sessionId)).find(
      (entry) => entry.inputId === id || entry.submissionId === id || entry.admissionId === id,
    );
  }

  unclaim(botId: string, sessionId: string, id: string, cancelledBeforeExecution = false) {
    const file = this.file(botId, sessionId);
    const records = this.read(file);
    const record = records.find((entry) => entry.inputId === id);
    if (
      !record ||
      record.rowId !== undefined ||
      (!cancelledBeforeExecution && record.submissionId !== undefined)
    )
      return;
    this.write(
      file,
      records.filter((entry) => entry !== record),
    );
    for (const item of record.attachments) NodeFS.rmSync(this.assetPath(item), { force: true });
  }

  forget(botId: string, sessionId?: string) {
    this.clearOwnerKnown(botId);
    const dir = NodePath.join(this.stateDir, "pa-attachments", digest(botId));
    const files =
      sessionId === undefined
        ? NodeFS.existsSync(dir)
          ? NodeFS.readdirSync(dir)
              .filter((name) => name.endsWith(".json"))
              .map((name) => NodePath.join(dir, name))
          : []
        : [this.file(botId, sessionId)];
    for (const file of files) {
      for (const record of this.read(file)) {
        for (const item of record.attachments) NodeFS.rmSync(this.assetPath(item), { force: true });
      }
      NodeFS.rmSync(file, { force: true });
      this.recent.delete(file);
    }
    if (sessionId === undefined) {
      NodeFS.rmSync(dir, { recursive: true, force: true });
    } else if (NodeFS.existsSync(dir)) {
      const canonical = NodePath.basename(files[0]!, ".json");
      for (const name of NodeFS.readdirSync(dir)) {
        const path = NodePath.join(dir, name);
        if (name.endsWith(".alias") && NodeFS.readFileSync(path, "utf8") === canonical)
          NodeFS.rmSync(path, { force: true });
      }
    }
  }

  private assetPath(attachment: PaAttachment) {
    const result = resolveAttachmentPath({ attachmentsDir: this.attachmentsDir, attachment });
    if (!result) throw invalid("Invalid attachment metadata");
    return result;
  }

  record(
    botId: string,
    sessionId: string,
    inputId: string,
    patch: Partial<
      Pick<AttachmentRecord, "submissionId" | "admissionId" | "referenceKeys" | "rowId" | "staged">
    >,
  ) {
    const file = this.file(botId, sessionId);
    const records = this.read(file);
    const match = records.find(
      (record) =>
        record.inputId === inputId ||
        record.submissionId === inputId ||
        record.admissionId === inputId,
    );
    if (!match) return;
    this.write(
      file,
      records.map((record) => (record === match ? { ...record, ...patch } : record)),
    );
  }

  queue(botId: string, sessionId: string, items: ReadonlyArray<PaQueuedItem>) {
    const records = this.read(this.file(botId, sessionId));
    if (!records.length) return items;
    return items.map((item) => {
      const record = records.find(
        (entry) =>
          entry.admissionId === item.id ||
          entry.submissionId === item.id ||
          entry.inputId === item.inputId,
      );
      return record
        ? {
            ...item,
            text: record.text,
            attachmentCount: record.attachments.length,
            canSteer: false,
          }
        : item;
    });
  }

  hydrate(botId: string, sessionId: string, messages: ReadonlyArray<PaMessage>) {
    if (!messages.some((message) => message.role === "user")) return messages;
    const file = this.file(botId, sessionId);
    const records = this.read(file);
    if (!records.length) return messages;
    const receipts = new Map(
      records.flatMap((record) =>
        record.rowId === undefined ? [] : [[record.rowId, record] as const],
      ),
    );
    const bindings = new Map<AttachmentRecord, number>();
    const authoritative = messages.map((message) => {
      if (message.role !== "user") return;
      if (message.submissionId) {
        const record = records.find(
          (entry) =>
            entry.submissionId === message.submissionId ||
            entry.admissionId === message.submissionId ||
            entry.inputId === message.submissionId,
        );
        if (record) {
          if (message.rowId !== undefined && record.rowId !== message.rowId)
            bindings.set(record, message.rowId);
          return record;
        }
      }
      return message.rowId !== undefined ? receipts.get(message.rowId) : undefined;
    });
    const claimed = new Set(authoritative.filter((record) => record !== undefined));
    const candidates = new Map<AttachmentRecord, number>();
    const matches = messages.map((message, index) => {
      if (authoritative[index] || message.role !== "user" || !message.attachments?.length) return;
      const keys = new Set(message.attachments.map((item) => item.id));
      const captionDigest = digest(message.text);
      const matching = records.filter(
        (record) =>
          record.referenceKeys.length === keys.size &&
          record.referenceKeys.every((key) => keys.has(key)) &&
          (record.textDigest === captionDigest ||
            (!record.text &&
              message.text === HERMES_DEFAULT_IMAGE_CAPTION &&
              record.attachments.some((item) => item.type === "image"))),
      );
      for (const record of matching) candidates.set(record, (candidates.get(record) ?? 0) + 1);
      return matching.length === 1 ? matching[0] : undefined;
    });
    const hydrated = messages.map((message, index) => {
      const direct = authoritative[index];
      const fallback = matches[index];
      // A unique caption and set of references on this page can also be a copy on another page.
      let match = direct;
      if (direct && bindings.has(direct) && bindings.get(direct) !== message.rowId)
        match = undefined;
      if (
        fallback &&
        fallback.rowId === undefined &&
        !claimed.has(fallback) &&
        candidates.get(fallback) === 1
      )
        match = fallback;
      return match
        ? {
            ...message,
            text: match.text.length < PREVIEW_CHARS ? match.text : message.text,
            attachments: match.attachments,
          }
        : message;
    });
    if (bindings.size)
      this.write(
        file,
        records.map((record) => {
          const rowId = bindings.get(record);
          return rowId === undefined ? record : { ...record, rowId };
        }),
      );
    return hydrated;
  }
}
