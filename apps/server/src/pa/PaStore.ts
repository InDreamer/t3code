// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

import * as Schema from "effect/Schema";
import type { PaAvatarShape } from "@t3tools/contracts";

import type { PaReply } from "./types.ts";

const StoredReply = Schema.Struct({
  sessionId: Schema.String,
  ids: Schema.Array(Schema.String),
  timestamp: Schema.Finite,
  read: Schema.Boolean,
});
const RECENT_REPLIES = 32;
const MAX_REPLY_IDS = 8;

const ReplyPosition = Schema.Struct({ timestamp: Schema.Finite, id: Schema.String });
type ReplyPosition = typeof ReplyPosition.Type;
const SessionProgress = Schema.Struct({
  sessionId: Schema.String,
  read: Schema.optionalKey(ReplyPosition),
  // The newest unread reply evicted from the Bot's recent identity window.
  unread: Schema.optionalKey(ReplyPosition),
});
type SessionProgress = typeof SessionProgress.Type;
const isProgress = Schema.is(Schema.Array(SessionProgress));

function position(reply: PaReply): ReplyPosition {
  return {
    timestamp: reply.timestamp,
    id: reply.ids.find((id) => /^row-\d+$/.test(id)) ?? reply.ids[0]!,
  };
}

function covers(mark: ReplyPosition | undefined, reply: ReplyPosition): boolean {
  if (!mark) return false;
  if (mark.id === reply.id) return true;
  const row = /^row-(\d+)$/.exec(reply.id);
  const through = /^row-(\d+)$/.exec(mark.id);
  // Feed timestamps are receipt times, including when an older durable row is replayed.
  if (row && through) return Number(row[1]) <= Number(through[1]);
  return reply.timestamp < mark.timestamp;
}

function cappedIds(ids: ReadonlyArray<string>) {
  const unique = [...new Set(ids)];
  const row = unique.find((id) => /^row-\d+$/.test(id));
  return (row ? [row, ...unique.filter((id) => id !== row)] : unique).slice(0, MAX_REPLY_IDS);
}

function advance(
  progress: Map<string, SessionProgress>,
  sessionId: string,
  field: "read" | "unread",
  point: ReplyPosition,
) {
  const entry = progress.get(sessionId) ?? { sessionId };
  if (covers(entry[field], point)) return;
  if (field === "unread" && covers(entry.read, point)) return;
  const next = { ...entry, [field]: point };
  if (next.unread && covers(next.read, next.unread)) delete next.unread;
  progress.set(sessionId, next);
}

function compactReplies(
  replies: ReadonlyArray<typeof StoredReply.Type>,
  progress: Map<string, SessionProgress>,
) {
  if (replies.length <= RECENT_REPLIES) return replies;
  const ordered = [...replies].sort((a, b) => a.timestamp - b.timestamp);
  for (const reply of ordered.slice(0, -RECENT_REPLIES))
    advance(progress, reply.sessionId, reply.read ? "read" : "unread", position(reply));
  return ordered.slice(-RECENT_REPLIES);
}

const isReplyHistory = Schema.is(Schema.Array(StoredReply));

const RenameAttempt = Schema.Struct({
  sessionId: Schema.String,
  requestId: Schema.String,
  title: Schema.String,
  expectedRevision: Schema.Int,
});
const isRenameHistory = Schema.is(Schema.Array(RenameAttempt));

export interface PaBotLocalMeta {
  readonly progress?: ReadonlyArray<SessionProgress>;
  readonly replies?: ReadonlyArray<typeof StoredReply.Type>;
  readonly renameAttempts?: ReadonlyArray<typeof RenameAttempt.Type>;
  readonly displayName?: string | undefined;
  readonly avatarColor?: string | undefined;
  readonly avatarShape?: PaAvatarShape | undefined;
  readonly pinned?: boolean | undefined;
  readonly primarySessionId?: string | undefined;
  readonly lastCompletedAt?: number | undefined;
  readonly lastReadAt?: number | undefined;
}

interface PaStoreData {
  readonly version: 1;
  readonly bots: Record<string, PaBotLocalMeta>;
}

const DEFAULT_AVATAR_PALETTE: ReadonlyArray<{
  readonly color: string;
  readonly shape: PaAvatarShape;
}> = [
  { color: "#f97316", shape: "pumpkin" },
  { color: "#14b8a6", shape: "circle" },
  { color: "#3b82f6", shape: "blob" },
  { color: "#10b981", shape: "cloud" },
  { color: "#8b5cf6", shape: "pill" },
  { color: "#ef4444", shape: "drop" },
];

export function defaultVisualForBot(
  botId: string,
  isDefault: boolean,
): {
  readonly avatarColor: string;
  readonly avatarShape: PaAvatarShape;
} {
  if (isDefault) {
    const first = DEFAULT_AVATAR_PALETTE[0]!;
    return { avatarColor: first.color, avatarShape: first.shape };
  }
  let hash = 0;
  for (let i = 0; i < botId.length; i += 1) {
    hash = (hash * 31 + botId.charCodeAt(i)) >>> 0;
  }
  const index = 1 + (hash % (DEFAULT_AVATAR_PALETTE.length - 1));
  const picked = DEFAULT_AVATAR_PALETTE[index] ?? DEFAULT_AVATAR_PALETTE[1]!;
  return { avatarColor: picked.color, avatarShape: picked.shape };
}

const AVATAR_SHAPES: ReadonlySet<string> = new Set([
  "blob",
  "pumpkin",
  "cloud",
  "drop",
  "pill",
  "circle",
]);

function sanitizeBotMeta(raw: unknown): { meta: PaBotLocalMeta; clean: boolean } | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const meta: Record<string, unknown> = {};
  let clean = true;
  const keep = (key: keyof PaBotLocalMeta, valid: (value: unknown) => boolean) => {
    if (!(key in record) || record[key] === undefined) return;
    if (valid(record[key])) meta[key] = record[key];
    else clean = false;
  };
  const isString = (value: unknown) => typeof value === "string";
  keep("replies", isReplyHistory);
  keep("progress", isProgress);
  keep("renameAttempts", isRenameHistory);
  keep("displayName", isString);
  keep("avatarColor", isString);
  keep("avatarShape", (value) => typeof value === "string" && AVATAR_SHAPES.has(value));
  keep("pinned", (value) => typeof value === "boolean");
  keep("primarySessionId", isString);
  keep("lastCompletedAt", (value) => typeof value === "number" && Number.isFinite(value));
  keep("lastReadAt", (value) => typeof value === "number" && Number.isFinite(value));
  return { meta: meta as PaBotLocalMeta, clean };
}

function sanitizeStoreData(parsed: unknown): {
  readonly bots: Record<string, PaBotLocalMeta>;
  readonly clean: boolean;
} {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { bots: {}, clean: false };
  }
  const rawBots = (parsed as { bots?: unknown }).bots;
  if (!rawBots || typeof rawBots !== "object" || Array.isArray(rawBots)) {
    return { bots: {}, clean: false };
  }
  const bots: Record<string, PaBotLocalMeta> = {};
  let clean = true;
  for (const [botId, value] of Object.entries(rawBots)) {
    const entry = sanitizeBotMeta(value);
    if (!entry) {
      clean = false;
      continue;
    }
    if (!entry.clean) clean = false;
    bots[botId] = entry.meta;
  }
  return { bots, clean };
}

export class PaStore {
  private readonly filePath: string;
  private cache: PaStoreData | null = null;

  constructor(stateDir: string) {
    this.filePath = NodePath.join(stateDir, "pa-bots.json");
  }

  private load(): PaStoreData {
    if (this.cache !== null) return this.cache;
    let raw: string | null = null;
    try {
      raw = NodeFS.readFileSync(this.filePath, "utf8");
    } catch (err) {
      const code = (err as { code?: unknown })?.code;
      if (code === "ENOENT") {
        this.cache = { version: 1, bots: {} };
        return this.cache;
      }
      throw err;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = undefined;
    }
    const sanitized = sanitizeStoreData(parsed);
    if (!sanitized.clean) {
      // Back up corrupt metadata rather than silently wiping it on the next write.
      try {
        // @effect-diagnostics globalDate:off
        NodeFS.copyFileSync(this.filePath, `${this.filePath}.corrupt-${Date.now()}.bak`);
      } catch {
        // Best-effort backup.
      }
    }
    let migrated = false;
    for (const [botId, meta] of Object.entries(sanitized.bots)) {
      if (!meta.replies?.length) continue;
      // Earlier versions persisted replay cursors as reply IDs and kept every completion.
      const progress = new Map(meta.progress?.map((entry) => [entry.sessionId, entry]));
      const replies = meta.replies.flatMap((reply) => {
        const ids = cappedIds(reply.ids.filter((id) => !id.startsWith('["')));
        if (!ids.length) return [];
        const entry = { ...reply, ids };
        if (entry.read) advance(progress, entry.sessionId, "read", position(entry));
        return [entry];
      });
      const compact = compactReplies(replies, progress);
      const next = {
        ...meta,
        replies: compact,
        ...(progress.size ? { progress: [...progress.values()] } : {}),
      };
      if (JSON.stringify(next) !== JSON.stringify(meta)) {
        sanitized.bots[botId] = next;
        migrated = true;
      }
    }
    const data = { version: 1 as const, bots: sanitized.bots };
    if (migrated) this.persist(data);
    else this.cache = data;
    return data;
  }

  private persist(data: PaStoreData): void {
    NodeFS.mkdirSync(NodePath.dirname(this.filePath), { recursive: true });
    const tmpPath = `${this.filePath}.${process.pid}.${NodeCrypto.randomUUID()}.tmp`;
    try {
      NodeFS.writeFileSync(tmpPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
      NodeFS.renameSync(tmpPath, this.filePath);
      // Only publish cache after durable atomic rename succeeds.
      this.cache = data;
    } catch (err) {
      try {
        NodeFS.rmSync(tmpPath, { force: true });
      } catch {
        // Ignore cleanup errors.
      }
      throw err;
    }
  }

  getBotMeta(botId: string): PaBotLocalMeta {
    return this.load().bots[botId] ?? {};
  }

  rememberReplies(
    botId: string,
    observed: ReadonlyArray<PaReply>,
    source: "history" | "feed",
  ): boolean {
    if (!observed.length) return true;
    const meta = this.getBotMeta(botId);
    const replies = [...(meta.replies ?? [])];
    const progress = new Map(meta.progress?.map((entry) => [entry.sessionId, entry]));
    let changed = false;
    let needsHistory = false;
    for (const reply of observed) {
      if (!reply.ids.length) continue;
      const matches = replies.filter(
        (entry) =>
          reply.sessionId === entry.sessionId && reply.ids.some((id) => entry.ids.includes(id)),
      );
      const previous = matches[0];
      const ids = cappedIds([...matches.flatMap((entry) => entry.ids), ...reply.ids]);
      const timestamp =
        source === "history" ? reply.timestamp : (previous?.timestamp ?? reply.timestamp);
      const point = position({ ...reply, ids, timestamp });
      const known = progress.get(reply.sessionId);
      const acknowledged =
        covers(known?.read, point) || (source === "history" && timestamp <= (meta.lastReadAt ?? 0));
      if (!previous && acknowledged) {
        // Preserve the row order even when an older, Bot-wide mark already covers this history.
        if (!covers(known?.read, point)) {
          advance(progress, reply.sessionId, "read", point);
          changed = true;
        }
        continue;
      }
      // An expired opaque ID has no order. Only history can place it against a saved watermark.
      if (!previous && source === "feed" && known?.read && !/^row-\d+$/.test(point.id)) {
        needsHistory = true;
        continue;
      }
      const read = acknowledged || matches.some((entry) => entry.read);
      if (
        previous &&
        matches.length === 1 &&
        timestamp === previous.timestamp &&
        read === previous.read &&
        ids.length === previous.ids.length &&
        ids.every((id, index) => id === previous.ids[index])
      )
        continue;
      const entry = { sessionId: reply.sessionId, timestamp, ids, read };
      if (previous) {
        replies[replies.indexOf(previous)] = entry;
        for (const duplicate of matches.slice(1)) replies.splice(replies.indexOf(duplicate), 1);
      } else replies.push(entry);
      if (read) advance(progress, reply.sessionId, "read", point);
      changed = true;
    }
    if (changed)
      this.updateBotMeta(botId, {
        replies: compactReplies(replies, progress),
        progress: [...progress.values()],
      });
    return !needsHistory;
  }

  bindReplySession(botId: string, alias: string, owner: string) {
    if (alias === owner) return;
    const meta = this.getBotMeta(botId);
    const replies = meta.replies ?? [];
    const progress = new Map(meta.progress?.map((entry) => [entry.sessionId, entry]));
    const aliasProgress = progress.get(alias);
    if (!aliasProgress && !replies.some((reply) => reply.sessionId === alias)) return;
    progress.delete(alias);
    if (aliasProgress?.read) advance(progress, owner, "read", aliasProgress.read);
    if (aliasProgress?.unread) advance(progress, owner, "unread", aliasProgress.unread);
    const merged = replies.filter((reply) => reply.sessionId !== alias);
    for (const reply of replies.filter((entry) => entry.sessionId === alias)) {
      const index = merged.findIndex(
        (entry) => entry.sessionId === owner && entry.ids.some((id) => reply.ids.includes(id)),
      );
      const existing = merged[index];
      if (existing)
        merged[index] = {
          ...existing,
          ids: cappedIds([...existing.ids, ...reply.ids]),
          read: existing.read || reply.read,
        };
      else merged.push({ ...reply, sessionId: owner });
    }
    const read = progress.get(owner)?.read;
    this.updateBotMeta(botId, {
      progress: [...progress.values()],
      replies: merged.map((reply) =>
        !reply.read && reply.sessionId === owner && covers(read, position(reply))
          ? { ...reply, read: true }
          : reply,
      ),
    });
  }

  readPatch(botId: string, now: number, seen?: { sessionId: string; id: string }) {
    const meta = this.getBotMeta(botId);
    const replies = meta.replies ?? [];
    const progress = new Map(meta.progress?.map((entry) => [entry.sessionId, entry]));
    const observed =
      seen &&
      replies.find((reply) => reply.sessionId === seen.sessionId && reply.ids.includes(seen.id));
    const overflow = seen && progress.get(seen.sessionId)?.unread;
    const through = observed
      ? position(observed)
      : overflow && overflow.id === seen?.id
        ? overflow
        : undefined;
    if (seen && !through) return {};
    if (seen && through) advance(progress, seen.sessionId, "read", through);
    if (!seen) {
      for (const entry of progress.values())
        if (entry.unread) advance(progress, entry.sessionId, "read", entry.unread);
      for (const reply of replies) advance(progress, reply.sessionId, "read", position(reply));
    }
    const marked = replies.map((reply) =>
      !reply.read &&
      (!seen || (reply.sessionId === seen.sessionId && covers(through, position(reply))))
        ? { ...reply, read: true }
        : reply,
    );
    return {
      progress: [...progress.values()],
      replies: marked,
      ...(!seen
        ? { lastReadAt: Math.max(now, meta.lastReadAt ?? 0, meta.lastCompletedAt ?? 0) }
        : meta.lastCompletedAt !== undefined && through && meta.lastCompletedAt <= through.timestamp
          ? { lastReadAt: Math.max(meta.lastReadAt ?? 0, meta.lastCompletedAt) }
          : {}),
    };
  }

  rememberRename(botId: string, attempt: typeof RenameAttempt.Type) {
    const previous = this.getBotMeta(botId).renameAttempts ?? [];
    const retained = previous.filter(
      (item) => item.sessionId !== attempt.sessionId || item.requestId !== attempt.requestId,
    );
    this.updateBotMeta(botId, { renameAttempts: [...retained.slice(-255), attempt] });
  }

  updateBotMeta(botId: string, patch: Partial<PaBotLocalMeta>): PaBotLocalMeta {
    const current = this.load();
    const existing = current.bots[botId] ?? {};
    if (
      Object.entries(patch).every(
        ([key, value]) =>
          value === undefined ||
          JSON.stringify(existing[key as keyof PaBotLocalMeta]) === JSON.stringify(value),
      )
    )
      return existing;
    const next: PaBotLocalMeta = {
      ...existing,
      ...Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)),
    };
    this.persist({
      version: 1,
      bots: {
        ...current.bots,
        [botId]: next,
      },
    });
    return next;
  }
}
