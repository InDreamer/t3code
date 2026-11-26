import {
  decodeWebSocketMessageData,
  HermesConnectionError,
  HermesConnectionPool,
  hermesAttachArgs,
  isValidHermesProfile,
  LiveHermesRpcConnection,
  parseHermesGatewayFrame,
  type HermesRpcEventFrame,
  type HermesSocketLike,
} from "./HermesGatewayClient.ts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

afterEach(() => {
  vi.useRealTimers();
});

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

// Node emits `unhandledRejection` only after a macrotask turn; that turn is the milestone observed.
// oxlint-disable-next-line t3code/no-real-time-wait-in-tests -- no event marks "no rejection happened"
const flushMacrotasks = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("HermesGatewayClient", () => {
  it("accepts only profile names Hermes can attach to", () => {
    expect(isValidHermesProfile("good-bot_01")).toBe(true);
    expect(isValidHermesProfile("default")).toBe(true);
    expect(isValidHermesProfile(".hidden")).toBe(false);
    expect(isValidHermesProfile("--flag")).toBe(false);
    expect(isValidHermesProfile("../evil")).toBe(false);
  });

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
