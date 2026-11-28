// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import {
  PaError,
  type PaContextUsage,
  type PaPendingRequest,
  type PaQueuedItem,
  type PaStreamEvent,
  type PaTodoState,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import type { PaAdapterEvent, PaSessionSubscriber } from "./types.ts";

export interface PaHubListener {
  readonly onEvent: (event: PaStreamEvent) => void;
  readonly onFail: (error: PaError) => void;
}

/** Opens the engine feed the hub fans out; `resume` after an upstream drop. */
export type PaHubFeed = (
  subscriber: PaSessionSubscriber,
  options: { readonly resume: boolean },
) => Promise<() => void>;

export interface PaHubTimers {
  readonly set: (run: () => void, ms: number) => unknown;
  readonly clear: (handle: unknown) => void;
}

export interface PaHubOptions {
  /** Events kept for clients that reconnect with a resume token. */
  readonly capacity: number;
  /** How long a hub with no listeners keeps its feed and buffer for a reconnecting client. */
  readonly lingerMs: number;
  /** Delays between attempts to reopen a dropped upstream feed before giving up. */
  readonly reconnectDelaysMs: ReadonlyArray<number>;
  readonly timers: PaHubTimers;
}

export const DEFAULT_PA_HUB_OPTIONS: PaHubOptions = {
  capacity: 2_000,
  lingerMs: 60_000,
  reconnectDelaysMs: [500, 2_000, 5_000],
  timers: {
    // @effect-diagnostics globalTimers:off
    set: (run, ms) => setTimeout(run, ms),
    clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  },
};

/** Reopening cannot fix these: the session is gone, refused, or not ours to watch. */
const PERMANENT_FEED_FAILURES: ReadonlySet<PaError["reason"]> = new Set([
  "NotFound",
  "Invalid",
  "Forbidden",
  "Unsupported",
  "Conflict",
]);

const isPaError = Schema.is(PaError);

interface BufferedEvent {
  readonly seq: number;
  readonly event: PaStreamEvent;
}

/**
 * One engine feed per active session, shared by every client watching it. Each event gets a
 * monotonic resume token `<epoch>:<seq>`; a client that reconnects with a token still inside
 * the buffer gets exactly what it missed, any other token gets `snapshotRequired`.
 */
export class PaSessionHub {
  readonly sessionId: string;
  private readonly feed: PaHubFeed;
  private readonly options: PaHubOptions;
  private readonly onDispose: () => void;
  private readonly epoch = NodeCrypto.randomUUID().slice(0, 8);
  private seq = 0;
  private readonly buffer: BufferedEvent[] = [];
  private readonly listeners = new Set<PaHubListener>();
  private running = false;
  private turnRevision = 0;
  private openRequests: ReadonlyArray<PaPendingRequest> = [];
  /** The latest of each, never the history: a reconnecting viewer only needs what is current. */
  private queuedItems: ReadonlyArray<PaQueuedItem> = [];
  private usage: PaContextUsage | null = null;
  private todos: PaTodoState | null = null;
  private release: (() => void) | null = null;
  private lingerTimer: unknown = null;
  private reconnectTimer: unknown = null;
  private reconnecting = false;
  private disposed = false;
  private readonly ready: Promise<void>;

  constructor(sessionId: string, feed: PaHubFeed, options: PaHubOptions, onDispose: () => void) {
    this.sessionId = sessionId;
    this.feed = feed;
    this.options = options;
    this.onDispose = onDispose;
    this.ready = this.open(false).then(
      () => undefined,
      (cause: unknown) => {
        this.dispose();
        throw cause;
      },
    );
  }

  private token(seq: number): string {
    return `${this.epoch}:${seq}`;
  }

  private async open(resume: boolean): Promise<void> {
    let initial = !resume;
    let current: (() => void) | null = null;
    let ended = false;
    const release = await this.feed(
      {
        onEvent: (event) => {
          if (this.disposed || ended) return;
          if (initial && event.type === "snapshot") {
            initial = false;
            this.applySnapshot(event);
            return;
          }
          this.publish(event);
        },
        onClose: (reason) => {
          if (ended) return;
          ended = true;
          // Still bootstrapping: `open` sees `ended` and fails, so its caller owns the retry.
          if (current === null) return;
          if (this.release === current) this.release = null;
          this.reconnect(reason);
        },
      },
      { resume },
    );
    current = release;
    if (ended || this.disposed) {
      release();
      if (ended && !this.disposed) {
        throw new PaError({
          reason: "Unavailable",
          message: "The session feed closed while opening",
        });
      }
      return;
    }
    const previous = this.release;
    this.release = release;
    previous?.();
    if (resume && this.listeners.size === 0) this.scheduleIdleDisposal();
  }

  /** Single-flight: a feed that drops while a reconnect is running is picked up by that loop. */
  private reconnect(reason: string | undefined): void {
    if (this.disposed || this.reconnecting) return;
    this.reconnecting = true;
    void this.runReconnect(reason);
  }

  private async runReconnect(reason: string | undefined): Promise<void> {
    try {
      await this.reconnectLoop(reason);
    } finally {
      this.reconnecting = false;
    }
    // A feed that dropped after the loop last looked found `reconnecting` still set: retry it.
    if (!this.disposed && this.release === null) this.reconnect(reason);
  }

  private async reconnectLoop(reason: string | undefined): Promise<void> {
    for (const delay of this.options.reconnectDelaysMs) {
      if (this.disposed) return;
      await new Promise<void>((resolve) => {
        this.reconnectTimer = this.options.timers.set(() => {
          this.reconnectTimer = null;
          resolve();
        }, delay);
      });
      if (this.disposed) return;
      try {
        await this.open(true);
      } catch (cause) {
        if (isPaError(cause) && PERMANENT_FEED_FAILURES.has(cause.reason)) {
          this.failAll(cause);
          return;
        }
        continue;
      }
      // The reopened feed may already have dropped again; keep going until one holds.
      if (this.release !== null || this.disposed) return;
    }
    this.failAll(
      new PaError({
        reason: "Unavailable",
        message: reason ?? "The agent's session feed closed",
      }),
    );
  }

  private publish(event: PaAdapterEvent): void {
    this.seq += 1;
    const stamped = { ...event, resumeToken: this.token(this.seq) } as PaStreamEvent;
    this.buffer.push({ seq: this.seq, event: stamped });
    if (this.buffer.length > this.options.capacity) this.buffer.shift();
    switch (stamped.type) {
      case "snapshot":
        this.applySnapshot(stamped);
        break;
      case "queue.updated":
        this.queuedItems = stamped.items;
        break;
      case "usage.updated":
        this.usage = stamped.usage;
        break;
      case "todos.updated":
        if (this.todos === null || stamped.todos.revision >= this.todos.revision) {
          this.todos = stamped.todos;
        }
        break;
      case "turn.started":
      case "turn.completed":
      case "error":
        this.turnRevision++;
        this.running = stamped.type === "turn.started";
        this.openRequests = this.openRequests.filter((request) => request.scope === "session");
        break;
      case "text.delta":
      case "reasoning.delta":
        this.running = true;
        break;
      case "status.updated":
        if (stamped.text) this.running = true;
        break;
      case "tool.updated":
        if (stamped.status === "started" || stamped.status === "progress") this.running = true;
        break;
      case "request.opened":
        this.openRequests = [
          ...this.openRequests.filter((r) => r.requestId !== stamped.request.requestId),
          stamped.request,
        ];
        break;
      case "request.resolved":
        this.openRequests = this.openRequests.filter((r) => r.requestId !== stamped.requestId);
        break;
      default:
        break;
    }
    if (this.listeners.size === 0 && this.release !== null) this.scheduleIdleDisposal();
    for (const listener of this.listeners) listener.onEvent(stamped);
  }

  /** A snapshot that leaves a field out keeps the hub's last value for it. */
  private applySnapshot(snapshot: Extract<PaAdapterEvent, { type: "snapshot" }>): void {
    if (this.running !== snapshot.running) this.turnRevision++;
    this.running = snapshot.running;
    this.openRequests = snapshot.openRequests;
    if (snapshot.queuedItems !== undefined) this.queuedItems = snapshot.queuedItems;
    if (snapshot.usage !== undefined) this.usage = snapshot.usage;
    if (snapshot.todos !== undefined) this.todos = snapshot.todos;
  }

  /** An answered prompt, published at once so no viewer (or later snapshot) still offers it. */
  resolveRequest(requestId: string): void {
    if (this.disposed || !this.openRequests.some((r) => r.requestId === requestId)) return;
    this.publish({ type: "request.resolved", sessionId: this.sessionId, requestId });
  }

  openRequestKind(requestId: string): PaPendingRequest["kind"] | null {
    return this.openRequests.find((r) => r.requestId === requestId)?.kind ?? null;
  }

  /** A session edit made through T3, for viewers whose engine feed does not report it. */
  publishSessionUpdated(update: { readonly title: string }): void {
    if (this.disposed) return;
    this.publish({ type: "session.updated", sessionId: this.sessionId, title: update.title });
  }

  describeQueuedAttachments(id: string, text: string, attachmentCount: number): void {
    // The gateway may publish its queue before it answers the submitting client.
    const queued = this.queuedItems.find((item) => item.id === id);
    if (
      !queued ||
      (queued.text === text && queued.attachmentCount === attachmentCount && !queued.canSteer)
    )
      return;
    this.publish({
      type: "queue.updated",
      sessionId: this.sessionId,
      items: this.queuedItems.map((item) =>
        item.id === id ? { ...item, text, attachmentCount, canSteer: false } : item,
      ),
    });
  }

  /** For output the engine never streams or stores, such as a command's immediate result. */
  publishNotice(message: string, inputId: string | undefined): void {
    if (this.disposed) return;
    this.publish({
      type: "notice",
      sessionId: this.sessionId,
      message,
      persistent: true,
      ...(inputId ? { inputId } : {}),
    });
  }

  private replayAfter(resumeToken: string | undefined): ReadonlyArray<PaStreamEvent> | null {
    if (resumeToken === undefined) return null;
    const separator = resumeToken.lastIndexOf(":");
    if (separator <= 0 || resumeToken.slice(0, separator) !== this.epoch) return null;
    const seq = Number(resumeToken.slice(separator + 1));
    const oldest = this.buffer[0]?.seq ?? this.seq + 1;
    if (!Number.isInteger(seq) || seq > this.seq || seq < oldest - 1) return null;
    return this.buffer.filter((entry) => entry.seq > seq).map((entry) => entry.event);
  }

  async attach(listener: PaHubListener, resumeToken?: string): Promise<() => void> {
    await this.ready;
    if (this.disposed) {
      throw new PaError({ reason: "Unavailable", message: "The session feed closed" });
    }
    if (this.lingerTimer !== null) {
      this.options.timers.clear(this.lingerTimer);
      this.lingerTimer = null;
    }
    const replay = this.replayAfter(resumeToken);
    listener.onEvent({
      type: "snapshot",
      sessionId: this.sessionId,
      resumeToken:
        replay !== null && resumeToken !== undefined ? resumeToken : this.token(this.seq),
      running: this.running,
      openRequests: this.openRequests,
      snapshotRequired: resumeToken !== undefined && replay === null,
      queuedItems: this.queuedItems,
      usage: this.usage,
      todos: this.todos,
    });
    for (const event of replay ?? []) listener.onEvent(event);
    this.listeners.add(listener);
    let detached = false;
    return () => {
      if (detached) return;
      detached = true;
      this.listeners.delete(listener);
      if (this.listeners.size === 0 && !this.disposed) this.scheduleIdleDisposal();
    };
  }

  /** Detached clients still need the roster to observe the turn's completion or request resolution. */
  private scheduleIdleDisposal(): void {
    if (this.holdsActivity) {
      if (this.lingerTimer !== null) this.options.timers.clear(this.lingerTimer);
      this.lingerTimer = null;
    } else if (this.lingerTimer === null) {
      this.lingerTimer = this.options.timers.set(() => this.dispose(), this.options.lingerMs);
    }
  }

  get holdsActivity() {
    return (
      this.running || this.awaiting || this.queuedItems.some((item) => item.status !== "unknown")
    );
  }

  get isRunning() {
    return this.running;
  }
  get awaiting() {
    return this.openRequests.length > 0;
  }
  get currentTurnRevision() {
    return this.turnRevision;
  }

  admittedTurn(revision: number): void {
    if (this.disposed || this.running || this.turnRevision !== revision) return;
    // The acknowledgement can precede the engine event; only the latter starts a new timeline.
    this.running = true;
    this.turnRevision++;
    if (this.listeners.size === 0) this.scheduleIdleDisposal();
  }

  get activityRevision() {
    return this.seq + this.turnRevision;
  }

  reconcileDetached(
    state: "idle" | "working" | "waiting" | "starting",
    distinguishesWaiting: boolean,
    openRequests?: ReadonlyArray<PaPendingRequest>,
  ) {
    if (this.listeners.size || this.disposed || this.release === null) return;
    const running = state !== "idle";
    if (running !== this.running) this.turnRevision++;
    this.running = running;
    if (openRequests) this.openRequests = openRequests;
    else if (state === "idle" || (distinguishesWaiting && state !== "waiting"))
      this.openRequests = this.openRequests.filter((request) => request.scope === "session");
    if (state === "idle") {
      this.queuedItems = this.queuedItems.filter((item) => item.status === "unknown");
    }
    this.scheduleIdleDisposal();
  }

  removeBot() {
    this.failAll(new PaError({ reason: "NotFound", message: "Bot not found" }));
  }

  get listenerCount(): number {
    return this.listeners.size;
  }

  private failAll(error: PaError): void {
    const listeners = Array.from(this.listeners);
    this.dispose();
    for (const listener of listeners) listener.onFail(error);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.lingerTimer !== null) this.options.timers.clear(this.lingerTimer);
    if (this.reconnectTimer !== null) this.options.timers.clear(this.reconnectTimer);
    this.reconnectTimer = null;
    this.listeners.clear();
    this.release?.();
    this.release = null;
    this.onDispose();
  }
}
