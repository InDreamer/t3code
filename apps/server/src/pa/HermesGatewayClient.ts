// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";

import { isValidPaProfile } from "./types.ts";

const execFileAsync = NodeUtil.promisify(NodeChildProcess.execFile);
const textDecoder = new TextDecoder();

export interface HermesAttachResult {
  readonly url: string;
  readonly protocols: ReadonlyArray<string>;
  readonly protocol?: string | undefined;
  readonly state?: string | undefined;
  readonly endpoint?:
    | {
        readonly profile_id?: string | undefined;
        readonly code_sha?: string | undefined;
        readonly capabilities?: ReadonlyArray<string> | undefined;
      }
    | undefined;
}

export interface HermesRpcEventFrame {
  readonly event: string;
  readonly session_id?: string | undefined;
  readonly seq?: number | undefined;
  readonly replay_epoch?: string | undefined;
  readonly execution_generation?: number | undefined;
  readonly payload?: Record<string, unknown> | undefined;
}

export interface HermesServerRequestFrame {
  readonly request_id: string;
  readonly method: string;
  readonly session_id?: string | undefined;
  readonly params?: Record<string, unknown> | undefined;
}

/** A JSON-RPC error answered by the Hermes gateway (as opposed to a transport failure). */
// @effect-diagnostics-next-line extendsNativeError:off -- rejected from plain Promises, mapped to HTTP status in PaHttp.
export class HermesRpcError extends Error {
  readonly code: number | string | undefined;
  constructor(message: string, code: number | string | undefined) {
    super(message);
    this.name = "HermesRpcError";
    this.code = code;
  }
}

/** The gateway could not be reached or the socket dropped. */
// @effect-diagnostics-next-line extendsNativeError:off -- rejected from plain Promises, mapped to HTTP 503 in PaHttp.
export class HermesConnectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HermesConnectionError";
  }
}

export interface HermesSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  addEventListener(type: "close" | "error", listener: () => void): void;
}

export interface HermesRpcConnection {
  readonly profile: string;
  call<T = Record<string, unknown>>(
    method: string,
    params?: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<T>;
  respondServerRequest(requestId: string, result: Record<string, unknown>): void;
  rejectServerRequest(requestId: string, code: number, message: string): void;
  onEvent(listener: (frame: HermesRpcEventFrame) => void): () => void;
  /**
   * Hermes settles a server request with the FIRST response from any attached viewer (TUI, desktop,
   * other PA tabs), so unclaimed requests are never answered here.
   */
  onServerRequest(listener: (frame: HermesServerRequestFrame) => void): () => void;
  onClose(listener: () => void): () => void;
  isOpen(): boolean;
  close(): void;
}

export type HermesAttachFn = (profile: string) => Promise<HermesAttachResult>;

const DEFAULT_RPC_TIMEOUT_MS = 20_000;
const ATTACH_TIMEOUT_MS = 12_000;
const PING_INTERVAL_MS = 25_000;
const WS_OPEN = 1;

export type ParsedHermesWireFrame =
  | {
      readonly kind: "response";
      readonly id: string;
      readonly result: unknown;
      readonly error?: { code?: unknown; message?: unknown } | undefined;
    }
  | { readonly kind: "event"; readonly frame: HermesRpcEventFrame }
  | { readonly kind: "server_request"; readonly frame: HermesServerRequestFrame }
  | { readonly kind: "unknown" };

/**
 * Pure decoder for Hermes `hermes-gateway-v1` newline-delimited JSON-RPC 2.0 frames.
 * - Notifications: `{ jsonrpc: "2.0", method: "event", params: { type, session_id, seq, replay_epoch, execution_generation, payload } }`
 * - Server→client requests: `{ jsonrpc: "2.0", id: "srq-...", method: "approval"|"clarify"|..., params: { session_id, ... } }`
 * - RPC responses: `{ jsonrpc: "2.0", id: "pa-...", result | error }`
 */
export function parseHermesGatewayFrame(frame: Record<string, unknown>): ParsedHermesWireFrame {
  // 1. Standard JSON-RPC 2.0 notification (`method === "event"`)
  if (frame.method === "event") {
    const params =
      frame.params && typeof frame.params === "object"
        ? (frame.params as Record<string, unknown>)
        : {};
    const eventType = typeof params.type === "string" ? params.type : undefined;
    if (!eventType) return { kind: "unknown" };
    const payload =
      params.payload && typeof params.payload === "object"
        ? (params.payload as Record<string, unknown>)
        : undefined;
    const sessionId =
      typeof params.session_id === "string"
        ? params.session_id
        : typeof payload?.session_id === "string"
          ? payload.session_id
          : undefined;
    return {
      kind: "event",
      frame: {
        event: eventType,
        session_id: sessionId,
        seq: typeof params.seq === "number" ? params.seq : undefined,
        replay_epoch: typeof params.replay_epoch === "string" ? params.replay_epoch : undefined,
        execution_generation:
          typeof params.execution_generation === "number" ? params.execution_generation : undefined,
        payload,
      },
    };
  }

  // 2. Server -> client interactive request (`id` string + `method` string !== "event")
  if (typeof frame.id === "string" && typeof frame.method === "string") {
    const params =
      frame.params && typeof frame.params === "object"
        ? (frame.params as Record<string, unknown>)
        : undefined;
    const sessionId =
      typeof params?.session_id === "string"
        ? params.session_id
        : typeof frame.session_id === "string"
          ? frame.session_id
          : undefined;
    return {
      kind: "server_request",
      frame: {
        request_id: frame.id,
        method: frame.method,
        session_id: sessionId,
        params,
      },
    };
  }

  // 3. Response to an outbound client RPC call
  if (typeof frame.id === "string" && ("result" in frame || "error" in frame)) {
    return {
      kind: "response",
      id: frame.id,
      result: frame.result,
      error:
        frame.error && typeof frame.error === "object"
          ? (frame.error as { code?: unknown; message?: unknown })
          : undefined,
    };
  }

  // 4. Legacy fallback event shape (`frame.event`)
  if (typeof frame.event === "string") {
    const payload =
      frame.payload && typeof frame.payload === "object"
        ? (frame.payload as Record<string, unknown>)
        : undefined;
    const sessionId =
      typeof frame.session_id === "string"
        ? frame.session_id
        : typeof payload?.session_id === "string"
          ? payload.session_id
          : undefined;
    return {
      kind: "event",
      frame: {
        event: frame.event,
        session_id: sessionId,
        seq:
          typeof frame.seq === "number"
            ? frame.seq
            : typeof payload?.seq === "number"
              ? payload.seq
              : undefined,
        replay_epoch: typeof frame.replay_epoch === "string" ? frame.replay_epoch : undefined,
        execution_generation:
          typeof frame.execution_generation === "number" ? frame.execution_generation : undefined,
        payload,
      },
    };
  }

  return { kind: "unknown" };
}

export function decodeWebSocketMessageData(data: unknown): string {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return textDecoder.decode(new Uint8Array(data));
  if (ArrayBuffer.isView(data)) {
    return textDecoder.decode(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  }
  return "";
}

export function hermesAttachArgs(profile: string): ReadonlyArray<string> {
  // Always pass `-p`: without it the CLI follows HERMES_HOME / the sticky `active_profile`.
  return ["-p", profile, "gateway", "attach", "--json"];
}

async function defaultHermesAttach(profile: string): Promise<HermesAttachResult> {
  if (!isValidPaProfile(profile)) {
    throw new Error(`Invalid Hermes profile name "${profile}"`);
  }
  const args = [...hermesAttachArgs(profile)];
  const { stdout } = await execFileAsync("hermes", args, {
    timeout: ATTACH_TIMEOUT_MS,
    maxBuffer: 2 * 1024 * 1024,
  });
  const parsed = JSON.parse(stdout) as Partial<HermesAttachResult>;
  if (!parsed || typeof parsed.url !== "string" || !Array.isArray(parsed.protocols)) {
    throw new Error(`Invalid hermes gateway attach payload for profile "${profile}"`);
  }
  return {
    url: parsed.url,
    protocols: parsed.protocols.filter((item): item is string => typeof item === "string"),
    protocol: parsed.protocol,
    state: parsed.state,
    endpoint: parsed.endpoint,
  };
}

export class LiveHermesRpcConnection implements HermesRpcConnection {
  readonly profile: string;
  private readonly ws: HermesSocketLike;
  private readonly pending = new Map<
    string,
    {
      readonly resolve: (value: unknown) => void;
      readonly reject: (reason: Error) => void;
      readonly timer: ReturnType<typeof setTimeout>;
    }
  >();
  private readonly eventListeners = new Set<(frame: HermesRpcEventFrame) => void>();
  private readonly requestListeners = new Set<(frame: HermesServerRequestFrame) => void>();
  private readonly closeListeners = new Set<() => void>();
  private readonly pingTimer: ReturnType<typeof setInterval> | null;
  private nextId = 1;
  private closed = false;

  constructor(profile: string, ws: HermesSocketLike, options?: { readonly enablePing?: boolean }) {
    this.profile = profile;
    this.ws = ws;
    ws.addEventListener("message", (event) => {
      if (typeof Blob !== "undefined" && event.data instanceof Blob) {
        void event.data.text().then(
          (text) => this.handleRaw(text),
          () => undefined,
        );
        return;
      }
      this.handleRaw(decodeWebSocketMessageData(event.data));
    });

    const handleDrop = () => {
      this.cleanupAndNotifyClose();
    };
    ws.addEventListener("close", handleDrop);
    ws.addEventListener("error", handleDrop);

    if (options?.enablePing !== false) {
      // @effect-diagnostics globalTimers:off
      this.pingTimer = setInterval(() => {
        if (!this.isOpen()) return;
        void this.call("gateway.ping", {}, 5_000).catch(() => {
          this.close();
        });
      }, PING_INTERVAL_MS);
      this.pingTimer.unref?.();
    } else {
      this.pingTimer = null;
    }
  }

  private cleanupAndNotifyClose(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.pingTimer !== null) {
      clearInterval(this.pingTimer);
    }
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(
        new HermesConnectionError(`Hermes gateway connection closed while awaiting ${id}`),
      );
    }
    this.pending.clear();
    for (const listener of this.closeListeners) {
      notifySafely(listener, undefined);
    }
  }

  private handleRaw(raw: string): void {
    if (!raw) return;
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue;
      }
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      this.handleParsedObject(parsed as Record<string, unknown>);
    }
  }

  private handleParsedObject(rawFrame: Record<string, unknown>): void {
    const decoded = parseHermesGatewayFrame(rawFrame);

    if (decoded.kind === "response") {
      const entry = this.pending.get(decoded.id);
      if (!entry) return;
      this.pending.delete(decoded.id);
      clearTimeout(entry.timer);
      if (decoded.error) {
        const message =
          typeof decoded.error.message === "string"
            ? decoded.error.message
            : `Hermes RPC error (${String(decoded.error.code ?? "unknown")})`;
        const code = decoded.error.code;
        entry.reject(
          new HermesRpcError(
            message,
            typeof code === "number" || typeof code === "string" ? code : undefined,
          ),
        );
      } else {
        entry.resolve(decoded.result);
      }
      return;
    }

    if (decoded.kind === "event") {
      for (const listener of this.eventListeners) {
        notifySafely(listener, decoded.frame);
      }
      return;
    }

    if (decoded.kind === "server_request") {
      for (const listener of this.requestListeners) {
        notifySafely(listener, decoded.frame);
      }
    }
  }

  isOpen(): boolean {
    return !this.closed && this.ws.readyState === WS_OPEN;
  }

  call<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = DEFAULT_RPC_TIMEOUT_MS,
  ): Promise<T> {
    if (!this.isOpen()) {
      return Promise.reject(
        new HermesConnectionError(`Hermes gateway socket for "${this.profile}" is not open`),
      );
    }
    const id = `pa-${this.nextId++}`;
    return new Promise<T>((resolve, reject) => {
      // @effect-diagnostics globalTimers:off
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new HermesConnectionError(`Hermes RPC "${method}" timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      try {
        this.ws.send(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(
          new HermesConnectionError(
            `Failed to send Hermes RPC "${method}": ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
      }
    });
  }

  respondServerRequest(requestId: string, result: Record<string, unknown>): void {
    if (!this.isOpen()) {
      throw new HermesConnectionError(`Hermes gateway socket for "${this.profile}" is closed`);
    }
    this.ws.send(`${JSON.stringify({ jsonrpc: "2.0", id: requestId, result })}\n`);
  }

  rejectServerRequest(requestId: string, code: number, message: string): void {
    if (!this.isOpen()) return;
    this.ws.send(
      `${JSON.stringify({ jsonrpc: "2.0", id: requestId, error: { code, message } })}\n`,
    );
  }

  onEvent(listener: (frame: HermesRpcEventFrame) => void): () => void {
    this.eventListeners.add(listener);
    return () => {
      this.eventListeners.delete(listener);
    };
  }

  onServerRequest(listener: (frame: HermesServerRequestFrame) => void): () => void {
    this.requestListeners.add(listener);
    return () => {
      this.requestListeners.delete(listener);
    };
  }

  onClose(listener: () => void): () => void {
    this.closeListeners.add(listener);
    return () => {
      this.closeListeners.delete(listener);
    };
  }

  close(): void {
    this.cleanupAndNotifyClose();
    try {
      this.ws.close();
    } catch {
      // Ignore close errors.
    }
  }
}

function notifySafely<A>(listener: (value: A) => void, value: A): void {
  try {
    listener(value);
  } catch {
    // One failing subscriber must not starve the others sharing this profile socket.
  }
}

export class HermesConnectionPool {
  private readonly attachFn: HermesAttachFn;
  private readonly connections = new Map<string, Promise<HermesRpcConnection>>();
  private readonly live = new Map<string, HermesRpcConnection>();

  constructor(attachFn: HermesAttachFn = defaultHermesAttach) {
    this.attachFn = attachFn;
  }

  getConnection(profile: string): Promise<HermesRpcConnection> {
    const active = this.live.get(profile);
    if (active && active.isOpen()) {
      return Promise.resolve(active);
    }
    if (active) {
      this.live.delete(profile);
    }
    // Deduplicate concurrent callers so only one attach/WebSocket opens per profile.
    const inFlight = this.connections.get(profile);
    if (inFlight) return inFlight;

    return this.connect(profile);
  }

  private connect(profile: string): Promise<HermesRpcConnection> {
    const promise = (async () => {
      const attach = await this.attachFn(profile).catch((err: unknown) => {
        throw new HermesConnectionError(
          `Hermes gateway attach failed for "${profile}": ${err instanceof Error ? err.message : String(err)}`,
        );
      });
      const ws = new WebSocket(attach.url, [...attach.protocols]);
      ws.binaryType = "arraybuffer";
      await new Promise<void>((resolve, reject) => {
        const onOpen = () => {
          clearTimeout(timer);
          ws.removeEventListener("error", onError);
          resolve();
        };
        const onError = () => {
          clearTimeout(timer);
          ws.removeEventListener("open", onOpen);
          reject(
            new HermesConnectionError(`Failed to open Hermes gateway WebSocket for "${profile}"`),
          );
        };
        // @effect-diagnostics globalTimers:off
        const timer = setTimeout(() => {
          ws.removeEventListener("open", onOpen);
          ws.removeEventListener("error", onError);
          try {
            ws.close();
          } catch {
            // Ignore close errors on timeout.
          }
          reject(
            new HermesConnectionError(`Timed out connecting to Hermes gateway for "${profile}"`),
          );
        }, 8_000);
        ws.addEventListener("open", onOpen, { once: true });
        ws.addEventListener("error", onError, { once: true });
      });

      const conn = new LiveHermesRpcConnection(profile, ws);
      this.live.set(profile, conn);
      conn.onClose(() => {
        if (this.live.get(profile) === conn) {
          this.live.delete(profile);
        }
        if (this.connections.get(profile) === promise) {
          this.connections.delete(profile);
        }
      });

      await conn
        .call("client.capabilities", { server_requests: true }, 4_000)
        .catch(() => undefined);

      return conn;
    })();

    this.connections.set(profile, promise);
    // `.finally()` would return a second promise that re-rejects with nobody listening, crashing Node
    // with an unhandledRejection whenever attach fails. `.then(f, f)` always settles fulfilled.
    const forget = () => {
      if (this.connections.get(profile) === promise) {
        this.connections.delete(profile);
      }
    };
    void promise.then(forget, forget);
    return promise;
  }

  closeAll(): void {
    for (const conn of this.live.values()) {
      conn.close();
    }
    this.live.clear();
    for (const promise of this.connections.values()) {
      void promise.then((conn) => conn.close()).catch(() => undefined);
    }
    this.connections.clear();
  }
}
