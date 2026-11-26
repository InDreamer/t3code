// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthProvidersManageScope,
  AuthSessionId,
  type AuthEnvironmentScope,
} from "@t3tools/contracts";
import * as ByteSize from "effect/ByteSize";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest } from "effect/http";
import * as HttpIncomingMessage from "effect/http/HttpIncomingMessage";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import {
  decodeWebSocketMessageData,
  HermesConnectionError,
  HermesConnectionPool,
  HermesRpcError,
  hermesAttachArgs,
  LiveHermesRpcConnection,
  parseHermesGatewayFrame,
  type HermesRpcConnection,
  type HermesRpcEventFrame,
  type HermesServerRequestFrame,
  type HermesSocketLike,
} from "./HermesGatewayClient.ts";
import {
  extractTranscriptText,
  HermesPaAdapter,
  mergeSessionRows,
  normalizeHermesTimestamp,
  normalizeSlashCatalog,
  normalizeTranscriptRows,
} from "./HermesPaAdapter.ts";
import {
  makePaRequestHandler,
  paErrorStatus,
  slashCommandRequiresProvidersManage,
} from "./PaHttp.ts";
import { createPaService, type PaServiceShape } from "./PaService.ts";
import { PaStore } from "./PaStore.ts";
import {
  acceptPaSeq,
  isValidPaProfile,
  isValidPaSessionId,
  makePaBotId,
  PaRequestError,
  parsePaBotId,
  type PaStreamEvent,
} from "./types.ts";

class FakeSocket implements HermesSocketLike {
  readyState = 1;
  readonly sent: string[] = [];
  failSends = false;
  private readonly messageListeners: Array<(event: { data: unknown }) => void> = [];
  private readonly closeListeners: Array<() => void> = [];

  send(data: string): void {
    if (this.failSends) throw new Error("socket buffer full");
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
    for (const listener of this.closeListeners) listener();
  }

  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  addEventListener(type: "close" | "error", listener: () => void): void;
  addEventListener(type: "message" | "close" | "error", listener: (event?: any) => void): void {
    if (type === "message") this.messageListeners.push(listener);
    else if (type === "close") this.closeListeners.push(listener);
  }

  receive(data: unknown): void {
    for (const listener of this.messageListeners) listener({ data });
  }

  sentFrames(): Array<Record<string, unknown>> {
    return this.sent.map((line) => JSON.parse(line) as Record<string, unknown>);
  }
}

// Profile-bound like a real Hermes ticket: any RPC naming another profile fails `profile_mismatch`.
class FakeHermesConnection implements HermesRpcConnection {
  readonly profile: string;
  readonly calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  readonly serverResponses: Array<{ requestId: string; result: Record<string, unknown> }> = [];
  readonly serverRejections: Array<{ requestId: string; code: number; message: string }> = [];
  private readonly handlers = new Map<string, (params: Record<string, unknown>) => unknown>();
  private readonly eventListeners = new Set<(frame: HermesRpcEventFrame) => void>();
  private readonly requestListeners = new Set<(frame: HermesServerRequestFrame) => void>();
  private readonly closeListeners = new Set<() => void>();
  private open = true;

  constructor(profile: string) {
    this.profile = profile;
  }

  onMethod(method: string, handler: (params: Record<string, unknown>) => unknown): void {
    this.handlers.set(method, handler);
  }

  emitEvent(frame: HermesRpcEventFrame): void {
    for (const listener of this.eventListeners) listener(frame);
  }

  emitRequest(frame: HermesServerRequestFrame): void {
    for (const listener of this.requestListeners) listener(frame);
  }

  simulateClose(): void {
    this.open = false;
    for (const listener of this.closeListeners) listener();
  }

  callsOf(method: string) {
    return this.calls.filter((c) => c.method === method);
  }

  async call<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<T> {
    this.calls.push({ method, params });
    if (typeof params.profile === "string" && params.profile !== this.profile) {
      throw new HermesRpcError("profile_mismatch", 4001);
    }
    const handler = this.handlers.get(method);
    if (!handler) throw new HermesRpcError(`Unhandled RPC method: ${method}`, -32601);
    return (await handler(params)) as T;
  }

  respondServerRequest(requestId: string, result: Record<string, unknown>): void {
    this.serverResponses.push({ requestId, result });
  }

  rejectServerRequest(requestId: string, code: number, message: string): void {
    this.serverRejections.push({ requestId, code, message });
  }

  onEvent(listener: (frame: HermesRpcEventFrame) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  onServerRequest(listener: (frame: HermesServerRequestFrame) => void): () => void {
    this.requestListeners.add(listener);
    return () => this.requestListeners.delete(listener);
  }

  onClose(listener: () => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  isOpen(): boolean {
    return this.open;
  }

  close(): void {
    this.simulateClose();
  }
}

const tempDirs: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const dir of tempDirs.splice(0)) {
    NodeFS.rmSync(dir, { recursive: true, force: true });
  }
});

const makeStore = () => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-pa-test-"));
  tempDirs.push(dir);
  return { dir, store: new PaStore(dir) };
};

function makeAdapter(connections: Record<string, FakeHermesConnection>) {
  const { store } = makeStore();
  const connectedProfiles: string[] = [];
  const pool = {
    getConnection: async (profile: string) => {
      connectedProfiles.push(profile);
      const conn = connections[profile];
      if (!conn) throw new HermesConnectionError(`no fake for ${profile}`);
      return conn;
    },
    closeAll: () => undefined,
  } as unknown as HermesConnectionPool;
  const adapter = new HermesPaAdapter(store, pool);
  return { adapter, store, connectedProfiles, service: createPaService([adapter]) };
}

/** A feedbot socket that resumes `session_id` as itself unless `canonical` redirects it. */
function makeFeedbotConn(options?: { readonly canonical?: string }) {
  const conn = new FakeHermesConnection("feedbot");
  conn.onMethod("session.resume", (p) => ({
    session_id: options?.canonical ?? p.session_id,
    running: true,
    last_sequence: 12,
    replay_epoch: "ep-A",
    execution_generation: 5,
    subscription_id: `sub-${String(p.session_id)}`,
    open_requests: [],
    prompts: [],
  }));
  conn.onMethod("session.detach", () => ({ ok: true }));
  conn.onMethod("session.interrupt", () => ({ ok: true }));
  conn.onMethod("approval.respond", () => ({ status: "resolved" }));
  conn.onMethod("clarify.respond", () => ({ status: "resolved" }));
  conn.onMethod("prompt.submit", () => ({ admission_id: "adm-1" }));
  return conn;
}

// Node emits `unhandledRejection` only after a macrotask turn; that turn is the milestone observed.
// oxlint-disable-next-line t3code/no-real-time-wait-in-tests -- no event marks "no rejection happened"
const flushMacrotasks = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("PA ids", () => {
  it("validates bot ids, profiles, and session ids strictly", () => {
    expect(makePaBotId("hermes", "feedbot")).toBe("hermes:feedbot");
    expect(parsePaBotId("hermes:default")).toEqual({ adapter: "hermes", profile: "default" });
    expect(parsePaBotId("openclaw:main_1")).toEqual({ adapter: "openclaw", profile: "main_1" });
    expect(parsePaBotId("unknown:foo")).toBeNull();
    expect(parsePaBotId("hermes:../evil")).toBeNull();
    expect(parsePaBotId("hermes:--flag")).toBeNull();
    expect(isValidPaProfile("good-bot_01")).toBe(true);
    expect(isValidPaProfile(".hidden")).toBe(false);
    expect(isValidPaSessionId("sess_2026_abc")).toBe(true);
    expect(isValidPaSessionId("../bad")).toBe(false);
    expect(isValidPaSessionId("has space")).toBe(false);
  });
});

describe("HermesGatewayClient", () => {
  it("decodes JSON-RPC events, responses and binary frames", async () => {
    const socket = new FakeSocket();
    const conn = new LiveHermesRpcConnection("default", socket, { enablePing: false });
    const events: HermesRpcEventFrame[] = [];
    conn.onEvent((frame) => events.push(frame));

    const callPromise = conn.call("session.list", { limit: 10 });
    const outbound = socket.sentFrames()[0]!;
    expect(outbound).toMatchObject({ jsonrpc: "2.0", method: "session.list" });

    const responseLine = JSON.stringify({
      jsonrpc: "2.0",
      id: outbound.id,
      result: { sessions: [] },
    });
    const eventLine = JSON.stringify({
      jsonrpc: "2.0",
      method: "event",
      params: {
        type: "message.delta",
        session_id: "s-1",
        seq: 7,
        replay_epoch: "epoch-1",
        execution_generation: 3,
        payload: { text: "Hello", offset: 0 },
      },
    });
    const encoded = new TextEncoder().encode(`${responseLine}\n${eventLine}`);
    socket.receive(
      encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength),
    );

    await expect(callPromise).resolves.toEqual({ sessions: [] });
    expect(events).toEqual([
      {
        event: "message.delta",
        session_id: "s-1",
        seq: 7,
        replay_epoch: "epoch-1",
        execution_generation: 3,
        payload: { text: "Hello", offset: 0 },
      },
    ]);
    expect(decodeWebSocketMessageData(new Uint8Array([65, 66]))).toBe("AB");
    expect(parseHermesGatewayFrame({ method: "event", params: {} })).toEqual({ kind: "unknown" });
    conn.close();
  });

  it("never answers an unclaimed server request: Hermes settles on the first viewer response", () => {
    const socket = new FakeSocket();
    const conn = new LiveHermesRpcConnection("default", socket, { enablePing: false });
    const seen: string[] = [];
    conn.onServerRequest((frame) => seen.push(frame.request_id));

    socket.receive(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "srq-2",
        method: "sudo",
        params: { session_id: "s-9" },
      }),
    );

    expect(seen).toEqual(["srq-2"]);
    expect(socket.sent).toEqual([]);
    conn.close();
  });

  it("survives null/primitive JSON lines and isolates a throwing listener", () => {
    const socket = new FakeSocket();
    const conn = new LiveHermesRpcConnection("default", socket, { enablePing: false });
    const received: string[] = [];
    conn.onEvent(() => {
      throw new Error("bad subscriber");
    });
    conn.onEvent((frame) => received.push(frame.event));

    const event = JSON.stringify({ jsonrpc: "2.0", method: "event", params: { type: "notice" } });
    expect(() => socket.receive(`null\n42\n"str"\n[1]\n${event}`)).not.toThrow();
    expect(received).toEqual(["notice"]);
    conn.close();
  });

  it("cleans up the pending entry when ws.send throws synchronously", async () => {
    const socket = new FakeSocket();
    const conn = new LiveHermesRpcConnection("default", socket, { enablePing: false });
    socket.failSends = true;
    await expect(conn.call("session.list")).rejects.toBeInstanceOf(HermesConnectionError);
    socket.failSends = false;
    conn.close();
    // Nothing is left pending for close() to reject.
    expect(socket.sent).toEqual([]);
  });

  it("heartbeats with gateway.ping", () => {
    vi.useFakeTimers();
    const socket = new FakeSocket();
    const conn = new LiveHermesRpcConnection("default", socket);
    vi.advanceTimersByTime(25_000);
    expect(socket.sentFrames().map((f) => f.method)).toEqual(["gateway.ping"]);
    conn.close();
  });

  it("pins the profile explicitly when attaching, including default", () => {
    expect(hermesAttachArgs("default")).toEqual(["-p", "default", "gateway", "attach", "--json"]);
    expect(hermesAttachArgs("feedbot")).toEqual(["-p", "feedbot", "gateway", "attach", "--json"]);
  });

  it("a failed connect rejects its callers without any unhandledRejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const pool = new HermesConnectionPool(async () => {
        throw new Error("spawn hermes ENOENT");
      });
      const [first, second] = await Promise.allSettled([
        pool.getConnection("default"),
        pool.getConnection("default"),
      ]);
      expect(first.status).toBe("rejected");
      expect(second.status).toBe("rejected");
      if (first.status === "rejected") {
        expect(first.reason).toBeInstanceOf(HermesConnectionError);
      }
      // The failed attempt is forgotten, so a later call retries instead of replaying the failure.
      await expect(pool.getConnection("default")).rejects.toThrow(/ENOENT/);
      await flushMacrotasks();
      await flushMacrotasks();
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});

describe("Hermes normalizers", () => {
  it("normalizes timestamps, transcripts, and array-shaped slash catalogs", () => {
    expect(normalizeHermesTimestamp(1795613800.5)).toBe(1795613800500);
    expect(normalizeHermesTimestamp(1795613800500)).toBe(1795613800500);
    expect(normalizeHermesTimestamp(null)).toBeNull();
    expect(
      extractTranscriptText({ content: [{ type: "text", text: "Hello" }, { text: "world" }] }),
    ).toBe("Hello\nworld");

    const messages = normalizeTranscriptRows([
      { role: "user", text: "/status", row_id: 1, timestamp: 1700000000 },
      { role: "assistant", text: "ok", reasoning_content: "Checked", row_id: 2 },
      { role: "assistant", text: "", row_id: 3 },
      { role: "system", text: "Compacted", row_kind: "compaction", row_id: 4 },
    ]);
    expect(messages.map((m) => m.rowKind)).toEqual(["message", "message", "compaction"]);
    expect(messages[1]?.reasoning).toBe("Checked");

    expect(
      normalizeSlashCatalog({
        pairs: [
          ["/status", "Show gateway status"],
          ["model", "Switch active model"],
        ],
        categories: [
          { name: "Session", pairs: [["/status", "Show gateway status"]] },
          { id: "config", commands: ["model"] },
        ],
        skills: { "daily-brief": { description: "Compile morning digest" } },
      }),
    ).toEqual([
      { name: "/status", description: "Show gateway status", category: "Session" },
      { name: "/model", description: "Switch active model", category: "config" },
      { name: "/daily-brief", description: "Compile morning digest", category: "skill" },
    ]);
  });

  it("merges live + stored session rows, preferring live state and reading last_active_at", () => {
    const sessions = mergeSessionRows(
      [{ session_id: "s-live", title: "Live now", running: true, model: "flash", started_at: 100 }],
      [
        {
          session_id: "s-live",
          title: "Stored title",
          running: false,
          message_count: 9,
          last_active_at: 1700000500,
          started_at: 100,
        },
        { session_id: "s-old", title: "Old", last_active: 1700000100, started_at: 50 },
      ],
      "s-old",
    );
    expect(sessions.map((s) => s.sessionId)).toEqual(["s-live", "s-old"]);
    expect(sessions[0]).toMatchObject({
      title: "Live now",
      running: true,
      model: "flash",
      messageCount: 9,
      lastActivityAt: 1700000500000,
      isPrimaryWeb: false,
    });
    expect(sessions[1]).toMatchObject({ lastActivityAt: 1700000100000, isPrimaryWeb: true });
  });
});

describe("PaStore", () => {
  it("backs up unparseable JSON instead of silently wiping user state", () => {
    const { dir, store } = makeStore();
    NodeFS.writeFileSync(NodePath.join(dir, "pa-bots.json"), "{corrupt json", "utf8");
    expect(store.getBotMeta("hermes:default")).toEqual({});
    const backups = NodeFS.readdirSync(dir).filter((f) => f.startsWith("pa-bots.json.corrupt-"));
    expect(backups).toHaveLength(1);
    expect(NodeFS.readFileSync(NodePath.join(dir, backups[0]!), "utf8")).toBe("{corrupt json");
  });

  it("backs up structurally invalid JSON and keeps only well-typed fields", () => {
    const { dir, store } = makeStore();
    const file = NodePath.join(dir, "pa-bots.json");
    const raw = JSON.stringify({
      version: 1,
      bots: {
        "hermes:a": { displayName: "A", pinned: "yes", lastReadAt: 5, avatarShape: "hexagon" },
        "hermes:b": "not an object",
      },
    });
    NodeFS.writeFileSync(file, raw, "utf8");
    expect(store.getBotMeta("hermes:a")).toEqual({ displayName: "A", lastReadAt: 5 });
    expect(store.getBotMeta("hermes:b")).toEqual({});
    const backups = NodeFS.readdirSync(dir).filter((f) => f.startsWith("pa-bots.json.corrupt-"));
    expect(backups).toHaveLength(1);

    const { dir: dir2, store: store2 } = makeStore();
    NodeFS.writeFileSync(NodePath.join(dir2, "pa-bots.json"), JSON.stringify({ bots: [] }), "utf8");
    expect(store2.getBotMeta("hermes:a")).toEqual({});
    expect(NodeFS.readdirSync(dir2).some((f) => f.includes(".corrupt-"))).toBe(true);
  });
});

describe("HermesPaAdapter profile routing", () => {
  it("routes cron.manage and skills.manage through the bot's own profile socket", async () => {
    const defaultConn = new FakeHermesConnection("default");
    const feedbotConn = new FakeHermesConnection("feedbot");
    defaultConn.onMethod("profiles.list", () => ({
      profiles: [
        { name: "default", is_default: true, model: "flash", provider: "deepseek" },
        { name: "feedbot", model: "", provider: "" },
      ],
    }));
    defaultConn.onMethod("profiles.describe", (p) => ({
      name: p.name,
      soul: "soul",
      model: { default: "flash", provider: "deepseek" },
      skills: [{ name: "digest", enabled: true }],
    }));
    defaultConn.onMethod("profiles.configure", (p) =>
      p.model === "expensive-opus" && !p.confirm_expensive_model
        ? { ok: false, confirm_required: true, confirm_message: "Expensive model confirmation" }
        : { ok: true },
    );
    feedbotConn.onMethod("model.options", () => ({
      providers: [{ slug: "openrouter", name: "OpenRouter", is_current: true, models: ["m"] }],
    }));
    feedbotConn.onMethod("cron.manage", (p) => {
      if (p.action === "pause" && p.name === "bad-job")
        return { success: false, error: "Job not found" };
      return {
        success: true,
        jobs: [
          {
            job_id: "job-42",
            name: "Morning",
            schedule: "0 9 * * *",
            prompt_preview: "Brief me",
            enabled: false,
          },
        ],
      };
    });
    feedbotConn.onMethod("skills.manage", () => ({ skills: { news: ["digest"] } }));

    const { service, store } = makeAdapter({ default: defaultConn, feedbot: feedbotConn });

    const listed = await service.listBots();
    expect(listed.bots).toHaveLength(2);

    const detail = await service.getBotDetail("hermes:feedbot");
    expect(detail.cronJobs).toEqual([
      expect.objectContaining({ id: "job-42", prompt: "Brief me", enabled: false }),
    ]);
    expect(detail.skills).toEqual([{ name: "digest", category: "news", enabled: true }]);
    expect(detail.modelOptions[0]?.slug).toBe("openrouter");
    for (const method of ["cron.manage", "skills.manage", "model.options"]) {
      expect(defaultConn.callsOf(method)).toEqual([]);
    }
    expect(feedbotConn.callsOf("cron.manage")[0]?.params).toMatchObject({
      profile: "feedbot",
      include_disabled: true,
    });

    // The fake rejects cross-profile calls exactly like a profile-bound Hermes ticket.
    await expect(defaultConn.call("cron.manage", { profile: "feedbot" })).rejects.toThrow(
      "profile_mismatch",
    );

    await expect(
      service.manageCron("hermes:feedbot", { action: "pause", jobId: "bad-job" }),
    ).rejects.toThrow("Job not found");
    const jobs = await service.manageCron("hermes:feedbot", { action: "resume", jobId: "job-42" });
    expect(jobs).toHaveLength(1);
    expect(
      feedbotConn.callsOf("cron.manage").find((c) => c.params.action === "resume")?.params,
    ).toMatchObject({ profile: "feedbot", name: "job-42" });

    const confirm = await service.updateBot("hermes:feedbot", { model: "expensive-opus" });
    expect(confirm?.confirmRequired?.message).toContain("Expensive model");

    // A read marker is local-only: no Hermes round trip at all.
    const before = defaultConn.calls.length + feedbotConn.calls.length;
    await expect(service.updateBot("hermes:feedbot", { markRead: true })).resolves.toBeNull();
    expect(defaultConn.calls.length + feedbotConn.calls.length).toBe(before);
    expect(store.getBotMeta("hermes:feedbot").lastReadAt).toBeTypeOf("number");
  });

  it("lists both live and stored sessions and follows the profile config on create", async () => {
    const feedbotConn = makeFeedbotConn();
    feedbotConn.onMethod("session.list", (p) =>
      p.scope === "live"
        ? { scope: "live", sessions: [{ session_id: "s-run", title: "Busy", running: true }] }
        : {
            scope: "stored",
            sessions: [{ session_id: "s-run", title: "Busy", last_active_at: 1700000300 }],
          },
    );
    feedbotConn.onMethod("session.create", () => ({ session_id: "s-new" }));
    const { service } = makeAdapter({ feedbot: feedbotConn });

    const listed = await service.listSessions("hermes:feedbot");
    expect(listed.sessions).toEqual([
      expect.objectContaining({ sessionId: "s-run", running: true, lastActivityAt: 1700000300000 }),
    ]);
    expect(feedbotConn.callsOf("session.list").map((c) => c.params)).toEqual([
      { scope: "live", limit: 30, picker: true },
      { scope: "stored", limit: 30, picker: true },
    ]);

    await service.createSession("hermes:feedbot");
    expect(feedbotConn.callsOf("session.create")[0]?.params).toEqual({
      source: "gui",
      follow_profile_config: true,
    });
  });
});

describe("HermesPaAdapter streaming", () => {
  it("replays a reconnect: events.since before resume, snapshot at the browser cursor, no duplicates", async () => {
    const feedbotConn = makeFeedbotConn();
    feedbotConn.onMethod("session.events.since", () => ({
      replay_epoch: "ep-A",
      snapshot_required: false,
      events: [
        {
          type: "tool.start",
          session_id: "s-1",
          seq: 11,
          payload: { tool_call_id: "c1", name: "web_search", context: "q" },
        },
        {
          type: "tool.complete",
          session_id: "s-1",
          seq: 12,
          payload: { tool_call_id: "c1", name: "web_search" },
        },
      ],
    }));
    // Resume's catch_up re-sends seq 12 on the socket ahead of its reply.
    const resume = feedbotConn["handlers"].get("session.resume")!;
    feedbotConn.onMethod("session.resume", (p) => {
      feedbotConn.emitEvent({
        event: "tool.complete",
        session_id: "s-1",
        seq: 12,
        replay_epoch: "ep-A",
        payload: { tool_call_id: "c1" },
      });
      feedbotConn.emitEvent({
        event: "message.delta",
        session_id: "s-1",
        seq: 13,
        replay_epoch: "ep-A",
        payload: { text: "Hi" },
      });
      return resume(p);
    });
    const { service } = makeAdapter({ feedbot: feedbotConn });

    const events: PaStreamEvent[] = [];
    const unsubscribe = await service.subscribeSession("hermes:feedbot", "s-1", {
      sinceSeq: 10,
      replayEpoch: "ep-A",
      onEvent: (event) => events.push(event),
    });

    expect(feedbotConn.calls.map((c) => c.method)).toEqual([
      "session.events.since",
      "session.resume",
    ]);
    expect(events[0]).toMatchObject({
      type: "snapshot",
      lastSeq: 10,
      replayEpoch: "ep-A",
      snapshotRequired: false,
    });
    expect(events.slice(1).map((e) => ("seq" in e ? e.seq : null))).toEqual([11, 12, 13]);
    expect(events[1]).toMatchObject({
      type: "tool.progress",
      toolId: "c1",
      preview: "q",
      status: "started",
    });

    // The browser's cursor accepts every replayed frame after adopting the snapshot baseline.
    const browser = { epoch: undefined as string | undefined, lastSeq: 12 };
    const snapshot = events[0]!;
    if (snapshot.type === "snapshot") {
      browser.epoch = snapshot.replayEpoch;
      browser.lastSeq = snapshot.lastSeq;
    }
    const accepted = events
      .slice(1)
      .filter((e) => "seq" in e && acceptPaSeq(browser, e.seq, e.replayEpoch));
    expect(accepted).toHaveLength(3);

    // A new replay epoch restarts numbering; its low sequences must not be suppressed.
    feedbotConn.emitEvent({
      event: "message.start",
      session_id: "s-1",
      seq: 1,
      replay_epoch: "ep-B",
      payload: {},
    });
    expect(events.at(-1)).toMatchObject({ type: "message.start", seq: 1, replayEpoch: "ep-B" });
    expect(acceptPaSeq(browser, 1, "ep-B")).toBe(true);
    expect(acceptPaSeq(browser, 1, "ep-B")).toBe(false);
    unsubscribe();
  });

  it("asks for a snapshot reload when the replay epoch is gone", async () => {
    const feedbotConn = makeFeedbotConn();
    feedbotConn.onMethod("session.events.since", () => ({ snapshot_required: true, events: [] }));
    const { service } = makeAdapter({ feedbot: feedbotConn });
    const events: PaStreamEvent[] = [];
    const unsubscribe = await service.subscribeSession("hermes:feedbot", "s-1", {
      sinceSeq: 4,
      replayEpoch: "ep-old",
      onEvent: (event) => events.push(event),
    });
    expect(events).toEqual([
      expect.objectContaining({ type: "snapshot", snapshotRequired: true, lastSeq: 12 }),
    ]);
    unsubscribe();
  });

  it("rejects instead of faking an idle snapshot when session.resume fails", async () => {
    const feedbotConn = makeFeedbotConn();
    feedbotConn.onMethod("session.resume", () => {
      throw new HermesRpcError("not_found", 4004);
    });
    const { service } = makeAdapter({ feedbot: feedbotConn });
    const events: PaStreamEvent[] = [];
    await expect(
      service.subscribeSession("hermes:feedbot", "s-gone", { onEvent: (e) => events.push(e) }),
    ).rejects.toThrow("not_found");
    expect(events).toEqual([]);
    // Listeners were released: later frames go nowhere.
    feedbotConn.emitEvent({
      event: "message.delta",
      session_id: "s-gone",
      seq: 1,
      payload: { text: "x" },
    });
    expect(events).toEqual([]);
  });

  it("recovers from session.replay_gap: clears the subscription, asks for a reload, ends the stream", async () => {
    const feedbotConn = makeFeedbotConn();
    const { service } = makeAdapter({ feedbot: feedbotConn });
    const events: PaStreamEvent[] = [];
    const closeReasons: Array<string | undefined> = [];
    await service.subscribeSession("hermes:feedbot", "s-1", {
      onEvent: (event) => events.push(event),
      onClose: (reason) => closeReasons.push(reason),
    });
    feedbotConn.emitEvent({
      event: "session.replay_gap",
      session_id: "s-1",
      payload: { replay_epoch: "ep-A", latest_seq: 40 },
    });
    expect(events.at(-1)).toMatchObject({ type: "snapshot", snapshotRequired: true, lastSeq: 40 });
    expect(closeReasons).toEqual([undefined]);

    // The retired subscription is not reused: the next send re-attaches first.
    const resumesBefore = feedbotConn.callsOf("session.resume").length;
    await service.sendMessage("hermes:feedbot", "s-1", "hello");
    expect(feedbotConn.callsOf("session.resume").length).toBe(resumesBefore + 1);
  });

  it("adopts the canonical session id session.resume redirects to", async () => {
    const feedbotConn = makeFeedbotConn({ canonical: "s-tip" });
    const { service } = makeAdapter({ feedbot: feedbotConn });
    const events: PaStreamEvent[] = [];
    const unsubscribe = await service.subscribeSession("hermes:feedbot", "s-root", {
      onEvent: (event) => events.push(event),
    });
    feedbotConn.emitEvent({
      event: "message.delta",
      session_id: "s-tip",
      seq: 13,
      replay_epoch: "ep-A",
      payload: { text: "tip" },
    });
    feedbotConn.emitEvent({
      event: "message.delta",
      session_id: "s-other",
      seq: 14,
      replay_epoch: "ep-A",
      payload: { text: "leak" },
    });
    feedbotConn.emitRequest({
      request_id: "srq-1",
      method: "approval",
      session_id: "s-tip",
      params: { command: "ls" },
    });
    expect(events.map((e) => e.type)).toEqual(["snapshot", "message.delta", "request.open"]);

    await service.interruptSession("hermes:feedbot", "s-root");
    expect(feedbotConn.callsOf("session.interrupt")[0]?.params).toEqual({
      session_id: "s-tip",
      execution_generation: 5,
    });
    unsubscribe();
    expect(feedbotConn.callsOf("session.detach")[0]?.params).toMatchObject({ session_id: "s-tip" });
  });
});

describe("HermesPaAdapter prompts", () => {
  it("answers only tracked requests of the same session, keyed by each question's qid", async () => {
    const feedbotConn = makeFeedbotConn();
    const { service } = makeAdapter({ feedbot: feedbotConn });
    const a: PaStreamEvent[] = [];
    const b: PaStreamEvent[] = [];
    await service.subscribeSession("hermes:feedbot", "s-a", { onEvent: (e) => a.push(e) });
    await service.subscribeSession("hermes:feedbot", "s-b", { onEvent: (e) => b.push(e) });

    feedbotConn.emitRequest({
      request_id: "srq-batch",
      method: "clarify",
      session_id: "s-a",
      params: {
        session_id: "s-a",
        questions: [
          { qid: "q0", question: "Which env?", choices: ["staging", "prod"], multi_select: true },
          { qid: "q1", question: "Why?" },
        ],
      },
    });
    const opened = a.find((e) => e.type === "request.open");
    expect(opened?.type === "request.open" && opened.request.questions).toEqual([
      { id: "q0", prompt: "Which env?", options: ["staging", "prod"], multiSelect: true },
      { id: "q1", prompt: "Why?", options: undefined, multiSelect: false },
    ]);
    expect(b.some((e) => e.type === "request.open")).toBe(false);

    // Another session (or a stale id) can never answer it over the shared profile socket.
    await expect(
      service.respondRequest("hermes:feedbot", "s-b", {
        requestId: "srq-batch",
        kind: "clarify",
        answer: "x",
      }),
    ).rejects.toBeInstanceOf(PaRequestError);
    await expect(
      service.respondRequest("hermes:feedbot", "s-a", {
        requestId: "srq-nope",
        kind: "approval",
        decision: "once",
      }),
    ).rejects.toThrow(/no longer open/);
    expect(feedbotConn.serverResponses).toEqual([]);

    await service.respondRequest("hermes:feedbot", "s-a", {
      requestId: "srq-batch",
      kind: "clarify",
      answers: { q0: JSON.stringify(["staging", "prod"]), q1: "release" },
    });
    expect(feedbotConn.serverResponses).toEqual([
      { requestId: "srq-batch", result: { answers: { q0: '["staging","prod"]', q1: "release" } } },
    ]);
    // Answered once; a replay of the same answer is refused.
    await expect(
      service.respondRequest("hermes:feedbot", "s-a", {
        requestId: "srq-batch",
        kind: "clarify",
        answer: "x",
      }),
    ).rejects.toBeInstanceOf(PaRequestError);
  });

  it("normalizes canonical clarify prompts with top-level question/choices/multi_select", async () => {
    const feedbotConn = makeFeedbotConn();
    const { service } = makeAdapter({ feedbot: feedbotConn });
    const events: PaStreamEvent[] = [];
    await service.subscribeSession("hermes:feedbot", "s-1", { onEvent: (e) => events.push(e) });
    feedbotConn.emitEvent({
      event: "clarify.request",
      session_id: "s-1",
      seq: 13,
      replay_epoch: "ep-A",
      payload: {
        kind: "clarify",
        prompt_id: "clr-1",
        execution_generation: 6,
        question: "Deploy where?",
        choices: ["staging", "prod", "dev"],
        multi_select: true,
      },
    });
    const opened = events.find((e) => e.type === "request.open");
    expect(opened?.type === "request.open" && opened.request).toMatchObject({
      requestId: "clr-1",
      channel: "canonical",
      detail: "Deploy where?",
      executionGeneration: 6,
      questions: [
        {
          id: "q0",
          prompt: "Deploy where?",
          options: ["staging", "prod", "dev"],
          multiSelect: true,
        },
      ],
    });

    await service.respondRequest("hermes:feedbot", "s-1", {
      requestId: "clr-1",
      kind: "clarify",
      channel: "canonical",
      answers: { q0: JSON.stringify(["staging", "dev"]) },
    });
    // Hermes `clarify_tool.py._clean_answer` parses multi-select JSON arrays verbatim.
    expect(feedbotConn.callsOf("clarify.respond")[0]?.params).toEqual({
      session_id: "s-1",
      execution_generation: 6,
      prompt_id: "clr-1",
      answer: JSON.stringify(["staging", "dev"]),
    });
  });

  it("preserves locked answers on resumed batch clarify and prunes stale requests on snapshot", async () => {
    const feedbotConn = makeFeedbotConn();
    feedbotConn.onMethod("session.resume", () => ({
      session_id: "s-1",
      running: true,
      last_sequence: 5,
      replay_epoch: "ep-A",
      execution_generation: 2,
      subscription_id: "sub-locked",
      open_requests: [
        {
          id: "srq-batch",
          method: "clarify",
          params: {
            questions: [
              { qid: "q0", question: "Env?", choices: ["prod", "staging"] },
              { qid: "q1", question: "Speed?", choices: ["fast", "safe"] },
            ],
            answers: { q0: "prod" },
          },
        },
      ],
    }));
    const { service } = makeAdapter({ feedbot: feedbotConn });
    const unsub1 = await service.subscribeSession("hermes:feedbot", "s-1", { onEvent: () => {} });

    // Only answer q1: q0 is omitted so Hermes keeps the locked "prod" answer.
    await service.respondRequest("hermes:feedbot", "s-1", {
      requestId: "srq-batch",
      kind: "clarify",
      channel: "server_request",
      answers: { q0: "", q1: "fast" },
    });
    expect(feedbotConn.serverResponses).toContainEqual({
      requestId: "srq-batch",
      result: { answers: { q1: "fast" } },
    });

    // A fresh snapshot with no open_requests prunes any previously tracked request.
    feedbotConn.emitRequest({
      request_id: "srq-stale",
      method: "approval",
      session_id: "s-1",
      params: { command: "ls" },
    });
    feedbotConn.onMethod("session.resume", () => ({
      session_id: "s-1",
      running: false,
      last_sequence: 6,
      replay_epoch: "ep-A",
      execution_generation: 2,
      subscription_id: "sub-locked",
      open_requests: [],
    }));
    const unsub2 = await service.subscribeSession("hermes:feedbot", "s-1", { onEvent: () => {} });
    await expect(
      service.respondRequest("hermes:feedbot", "s-1", {
        requestId: "srq-stale",
        kind: "approval",
        channel: "server_request",
        decision: "once",
      }),
    ).rejects.toBeInstanceOf(PaRequestError);
    unsub1();
    unsub2();
  });

  it("keeps a shared subscription attached until the last redirected/canonical tab closes", async () => {
    const feedbotConn = makeFeedbotConn();
    feedbotConn.onMethod("session.resume", () => ({
      session_id: "canon-root",
      running: false,
      last_sequence: 10,
      replay_epoch: "ep-A",
      execution_generation: 3,
      subscription_id: "sub-shared",
    }));
    const { service } = makeAdapter({ feedbot: feedbotConn });
    const unsubOld = await service.subscribeSession("hermes:feedbot", "legacy-id", {
      onEvent: () => {},
    });
    const unsubCanon = await service.subscribeSession("hermes:feedbot", "canon-root", {
      onEvent: () => {},
    });

    // Closing the redirected tab must NOT detach while the canonical tab shares sub-shared.
    unsubOld();
    expect(feedbotConn.callsOf("session.detach")).toHaveLength(0);

    // Closing the final tab detaches once.
    unsubCanon();
    expect(feedbotConn.callsOf("session.detach")).toEqual([
      {
        method: "session.detach",
        params: { session_id: "canon-root", subscription_id: "sub-shared" },
      },
    ]);
  });
});

describe("PaHttp", () => {
  const fakePa = (overrides: Partial<PaServiceShape>) =>
    ({
      manageCron: async () => [],
      sendMessage: async (_bot: string, sessionId: string) => ({ kind: "turn", sessionId }),
      ...overrides,
    }) as unknown as PaServiceShape;

  const run = (
    pa: PaServiceShape,
    request: Request,
    scopes: ReadonlyArray<AuthEnvironmentScope>,
    maxBody = 1024,
  ) =>
    makePaRequestHandler(pa).pipe(
      Effect.provideService(
        HttpServerRequest.HttpServerRequest,
        HttpServerRequest.fromWeb(request),
      ),
      Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.bytes(maxBody)),
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(EnvironmentAuth.EnvironmentAuth, {
            authenticateHttpRequest: () =>
              Effect.succeed({
                sessionId: AuthSessionId.make("pa-test"),
                subject: "pa-test",
                method: "bearer-access-token" as const,
                scopes: [...scopes],
              }),
          }),
          Layer.mock(SessionStore.SessionStore, { cookieName: "t3", legacyCookieName: undefined }),
        ),
      ),
      Effect.runPromise,
    );

  const post = (path: string, body: string) =>
    new Request(`http://127.0.0.1/api/pa${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });

  const operate = [AuthOrchestrationReadScope, AuthOrchestrationOperateScope];
  const manage = [AuthOrchestrationReadScope, AuthProvidersManageScope];

  it("requires both providers:manage and orchestration:operate for cron mutations", async () => {
    const calls: string[] = [];
    const pa = fakePa({ manageCron: async () => (calls.push("cron"), []) });
    const body = JSON.stringify({ action: "pause", jobId: "j" });
    expect((await run(pa, post("/bots/hermes:feedbot/cron", body), operate)).status).toBe(403);
    expect((await run(pa, post("/bots/hermes:feedbot/cron", body), manage)).status).toBe(403);
    expect(
      (
        await run(pa, post("/bots/hermes:feedbot/cron", body), [
          ...manage,
          AuthOrchestrationOperateScope,
        ])
      ).status,
    ).toBe(200);
    expect(calls).toEqual(["cron"]);
  });

  it("requires providers:manage for non-allowlisted slash commands including multi-slash and aliases", async () => {
    const sent: string[] = [];
    const pa = fakePa({
      sendMessage: async (_bot, sessionId, text) => (sent.push(text), { kind: "turn", sessionId }),
    });
    const send = (text: string) =>
      post("/bots/hermes:feedbot/sessions/s-1/send", JSON.stringify({ text }));
    expect((await run(pa, send("/model gpt-5"), operate)).status).toBe(403);
    expect((await run(pa, send("  /CRON add"), operate)).status).toBe(403);
    expect((await run(pa, send("//config set model.default x"), operate)).status).toBe(403);
    expect((await run(pa, send("//yolo"), operate)).status).toBe(403);
    expect((await run(pa, send("/config\x1fset x"), operate)).status).toBe(403);
    expect((await run(pa, send("/my-profile-alias"), operate)).status).toBe(403);
    expect((await run(pa, send("/heartbeat every 5m check"), operate)).status).toBe(403);
    expect((await run(pa, send("/status"), operate)).status).toBe(200);
    expect((await run(pa, send("//status"), operate)).status).toBe(200);
    expect((await run(pa, send("tell me about /model"), operate)).status).toBe(200);
    expect(
      (await run(pa, send("/model gpt-5"), [...operate, AuthProvidersManageScope])).status,
    ).toBe(200);
    expect(sent).toEqual(["/status", "//status", "tell me about /model", "/model gpt-5"]);

    expect(slashCommandRequiresProvidersManage("/personality pirate")).toBe(true);
    expect(slashCommandRequiresProvidersManage("/reload-mcp")).toBe(true);
    expect(slashCommandRequiresProvidersManage("///")).toBe(true);
    expect(slashCommandRequiresProvidersManage("/compact")).toBe(false);
  });

  it("returns real HTTP 404 when SSE subscribeSession fails with not_found", async () => {
    const pa = fakePa({
      subscribeSession: async () => {
        throw new HermesRpcError("session not_found", 4004);
      },
    });
    const req = new Request("http://127.0.0.1/api/pa/bots/hermes:feedbot/sessions/s-gone/events", {
      method: "GET",
    });
    const res = await run(pa, req, operate);
    expect(res.status).toBe(404);
  });

  it("returns 413 for an oversized JSON body and 400 for malformed JSON", async () => {
    const pa = fakePa({});
    const huge = JSON.stringify({ text: "x".repeat(4096) });
    expect(
      (await run(pa, post("/bots/hermes:feedbot/sessions/s-1/send", huge), operate)).status,
    ).toBe(413);
    expect(
      (await run(pa, post("/bots/hermes:feedbot/sessions/s-1/send", "{nope"), operate)).status,
    ).toBe(400);
  });

  it("maps caller errors to 4xx and only gateway failures to 5xx", async () => {
    expect(paErrorStatus(new PaRequestError(404, "gone"))).toBe(404);
    expect(paErrorStatus(new HermesRpcError("not_found", 4004))).toBe(404);
    expect(paErrorStatus(new HermesRpcError("profile 'ghost' not found", 5063))).toBe(404);
    expect(paErrorStatus(new HermesRpcError("Profile already exists", 4062))).toBe(409);
    expect(paErrorStatus(new HermesRpcError("invalid_params", 4002))).toBe(400);
    expect(paErrorStatus(new HermesConnectionError("down"))).toBe(503);
    expect(paErrorStatus(new Error("boom"))).toBe(502);

    const pa = fakePa({
      sendMessage: async () => {
        throw new PaRequestError(400, "Message cannot be empty");
      },
    });
    const res = await run(
      pa,
      post("/bots/hermes:feedbot/sessions/s-1/send", JSON.stringify({ text: " " })),
      operate,
    );
    expect(res.status).toBe(400);
  });
});
