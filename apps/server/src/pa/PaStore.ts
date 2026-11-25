// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

import type { PaAvatarShape } from "./types.ts";

export interface PaBotLocalMeta {
  readonly displayName?: string | undefined;
  readonly avatarColor?: string | undefined;
  readonly avatarShape?: PaAvatarShape | undefined;
  readonly pinned?: boolean | undefined;
  readonly primarySessionId?: string | undefined;
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

    try {
      const parsed = JSON.parse(raw) as Partial<PaStoreData>;
      if (parsed && typeof parsed === "object" && parsed.bots && typeof parsed.bots === "object") {
        this.cache = { version: 1, bots: { ...parsed.bots } };
        return this.cache;
      }
    } catch {
      // Back up corrupt metadata rather than silently wiping it on next write.
      try {
        // @effect-diagnostics globalDate:off
        const backupPath = `${this.filePath}.corrupt-${Date.now()}.bak`;
        NodeFS.copyFileSync(this.filePath, backupPath);
      } catch {
        // Best-effort backup.
      }
    }
    this.cache = { version: 1, bots: {} };
    return this.cache;
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

  updateBotMeta(botId: string, patch: Partial<PaBotLocalMeta>): PaBotLocalMeta {
    const current = this.load();
    const existing = current.bots[botId] ?? {};
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
