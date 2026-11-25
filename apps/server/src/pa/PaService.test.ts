// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  decodeWebSocketMessageData,
  LiveHermesRpcConnection,
  parseHermesGatewayFrame,
  type HermesConnectionPool,
  type HermesRpcConnection,
  type HermesRpcEventFrame,
  type HermesServerRequestFrame,
  type HermesSocketLike,
} from "./HermesGatewayClient.ts";
import {
  extractTranscriptText,
  HermesPaAdapter,
  normalizeHermesTimestamp,
  normalizeSlashCatalog,
  normalizeTranscriptRows,
} from "./HermesPaAdapter.ts";
import { createPaService } from "./PaService.ts";
import { PaStore } from "./PaStore.ts";
import {
  isValidPaProfile,
  isValidPaSessionId,
  makePaBotId,
  parsePaBotId,
  type PaStreamEvent,
} from "./types.ts";

class FakeSocket implements HermesSocketLike {
  readyState = 1;
  readonly sent: string[] = [];
  private readonly messageListeners: Array<(event: { data: unknown }) => void> = [];
  private readonly closeListeners: Array<() => void> = [];
  private readonly errorListeners: Array<() => void> = [];

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
    for (const listener of this.closeListeners) {
      listener();
    }
  }

  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  addEventListener(type: "close" | "error", listener: () => void): void;
  addEventListener(type: "message" | "close" | "error", listener: (event?: any) => void): void {
    if (type === "message") this.messageListeners.push(listener);
    else if (type === "close") this.closeListeners.push(listener);
    else this.errorListeners.push(listener);
  }

  receive(data: unknown): void {
    for (const listener of this.messageListeners) {
      listener({ data });
    }
  }
}

class FakeHermesConnection implements HermesRpcConnection {
  readonly profile: string;
  readonly calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  readonly serverResponses: Array<{ requestId: string; result: Record<string, unknown> }> = [];
  readonly serverRejections: Array<{ requestId: string; code: number; message: string }> = [];
  private readonly handlers = new Map<string, (params: Record<string, unknown>) => unknown>();
  private readonly eventListeners = new Set<(frame: HermesRpcEventFrame) => void>();
  private readonly requestListeners = new Set<(frame: HermesServerRequestFrame) => boolean>();
  private readonly closeListeners = new Set<() => void>();
  private open = true;

  constructor(profile: string) {
    this.profile = profile;
  }

  onMethod(method: string, handler: (params: Record<string, unknown>) => unknown): void {
    this.handlers.set(method, handler);
  }

  emitEvent(frame: HermesRpcEventFrame): void {
    for (const listener of this.eventListeners) {
      listener(frame);
    }
  }

  emitRequest(frame: HermesServerRequestFrame): boolean {
    let handled = false;
    for (const listener of this.requestListeners) {
      if (listener(frame)) {
        handled = true;
      }
    }
    if (!handled) {
      this.rejectServerRequest(
        frame.request_id,
        -32601,
        `Unhandled server request: ${frame.method}`,
      );
    }
    return handled;
  }

  simulateClose(): void {
    this.open = false;
    for (const listener of this.closeListeners) {
      listener();
    }
  }

  async call<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<T> {
    this.calls.push({ method, params });
    const handler = this.handlers.get(method);
    if (!handler) {
      throw new Error(`Unhandled RPC method: ${method}`);
    }
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

  onServerRequest(listener: (frame: HermesServerRequestFrame) => boolean): () => void {
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

describe("PA module", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  });

  const makeStore = () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-pa-test-"));
    tempDirs.push(dir);
    return { dir, store: new PaStore(dir) };
  };

  it("validates bot ids, profiles, and session ids strictly", () => {
    expect(makePaBotId("hermes", "feedbot")).toBe("hermes:feedbot");
    expect(parsePaBotId("hermes:default")).toEqual({ adapter: "hermes", profile: "default" });
    expect(parsePaBotId("openclaw:main_1")).toEqual({ adapter: "openclaw", profile: "main_1" });
    expect(parsePaBotId("unknown:foo")).toBeNull();
    expect(parsePaBotId("hermes:../evil")).toBeNull();
    expect(parsePaBotId("hermes:..")).toBeNull();
    expect(parsePaBotId("hermes:--flag")).toBeNull();
    expect(parsePaBotId("hermes:-p")).toBeNull();
    expect(isValidPaProfile("good-bot_01")).toBe(true);
    expect(isValidPaProfile(".hidden")).toBe(false);
    expect(isValidPaSessionId("sess_2026_abc")).toBe(true);
    expect(isValidPaSessionId("../bad")).toBe(false);
    expect(isValidPaSessionId("has space")).toBe(false);
  });

  it("decodes real Hermes JSON-RPC 2.0 event notifications, server requests, binary chunks, and rejects unclaimed requests", async () => {
    const socket = new FakeSocket();
    const conn = new LiveHermesRpcConnection("default", socket, { enablePing: false });

    const events: HermesRpcEventFrame[] = [];
    const claimedRequests: HermesServerRequestFrame[] = [];

    conn.onEvent((frame) => events.push(frame));
    conn.onServerRequest((frame) => {
      if (frame.method === "approval" && frame.session_id === "s-1") {
        claimedRequests.push(frame);
        return true;
      }
      return false;
    });

    // Outbound RPC call includes jsonrpc: "2.0"
    const callPromise = conn.call("session.list", { limit: 10 });
    expect(socket.sent).toHaveLength(1);
    const outbound = JSON.parse(socket.sent[0]!) as Record<string, unknown>;
    expect(outbound.jsonrpc).toBe("2.0");
    expect(outbound.method).toBe("session.list");
    expect(typeof outbound.id).toBe("string");

    // Respond + push a real JSON-RPC 2.0 notification in a single newline-delimited chunk
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
    socket.receive(`${responseLine}\n${eventLine}`);

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

    // Binary ArrayBuffer frame containing a claimed approval request + an unclaimed sudo request
    const approvalReq = JSON.stringify({
      jsonrpc: "2.0",
      id: "srq-1",
      method: "approval",
      params: { session_id: "s-1", command: "ls -la" },
    });
    const sudoReq = JSON.stringify({
      jsonrpc: "2.0",
      id: "srq-2",
      method: "sudo",
      params: { session_id: "s-1" },
    });
    const encoded = new TextEncoder().encode(`${approvalReq}\n${sudoReq}`);
    socket.receive(
      encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength),
    );

    expect(claimedRequests).toHaveLength(1);
    expect(claimedRequests[0]).toMatchObject({
      request_id: "srq-1",
      method: "approval",
      session_id: "s-1",
    });

    // Unclaimed sudo request MUST receive an immediate JSON-RPC -32601 rejection
    const rejectionFrame = JSON.parse(socket.sent.at(-1)!) as Record<string, unknown>;
    expect(rejectionFrame).toMatchObject({
      jsonrpc: "2.0",
      id: "srq-2",
      error: { code: -32601 },
    });

    // Closing the connection rejects in-flight RPC calls cleanly and triggers onClose
    let closedCalled = false;
    conn.onClose(() => {
      closedCalled = true;
    });
    const inFlight = conn.call("prompt.submit", {
      session_id: "s-1",
      text: "hi",
      input_id: "id-1",
    });
    conn.close();
    await expect(inFlight).rejects.toThrow(/closed/i);
    expect(closedCalled).toBe(true);

    // Pure decoder helper checks
    expect(decodeWebSocketMessageData(new Uint8Array([65, 66]))).toBe("AB");
    expect(parseHermesGatewayFrame({ method: "event", params: {} })).toEqual({ kind: "unknown" });
  });

  it("normalizes Hermes timestamps, transcripts, and array-shaped slash command catalogs", () => {
    expect(normalizeHermesTimestamp(1795613800.5)).toBe(1795613800500);
    expect(normalizeHermesTimestamp(1795613800500)).toBe(1795613800500);
    expect(normalizeHermesTimestamp(null)).toBeNull();

    expect(
      extractTranscriptText({
        content: [{ type: "text", text: "Hello" }, { text: "world" }],
      }),
    ).toBe("Hello\nworld");

    const messages = normalizeTranscriptRows([
      { role: "user", text: "/status", row_id: 1, timestamp: 1700000000 },
      {
        role: "assistant",
        text: "All systems operational",
        reasoning_content: "Checked gateway",
        row_id: 2,
        timestamp: 1700000001,
      },
      { role: "assistant", text: "", row_id: 3 },
      { role: "system", text: "Compacted 12 messages", row_kind: "compaction", row_id: 4 },
    ]);
    expect(messages).toHaveLength(3);
    expect(messages[0]?.role).toBe("user");
    expect(messages[1]?.reasoning).toBe("Checked gateway");
    expect(messages[2]?.rowKind).toBe("compaction");

    const commands = normalizeSlashCatalog({
      pairs: [
        ["/status", "Show gateway status"],
        ["model", "Switch active model"],
      ],
      categories: [
        { name: "Session", pairs: [["/status", "Show gateway status"]] },
        { id: "config", commands: ["model"] },
      ],
      skills: {
        "daily-brief": { description: "Compile morning digest" },
      },
    });
    expect(commands).toEqual([
      { name: "/status", description: "Show gateway status", category: "Session" },
      { name: "/model", description: "Switch active model", category: "config" },
      { name: "/daily-brief", description: "Compile morning digest", category: "skill" },
    ]);
  });

  it("backs up corrupt PaStore JSON instead of silently wiping user state", () => {
    const { dir, store } = makeStore();
    const stateFile = NodePath.join(dir, "pa-bots.json");
    NodeFS.writeFileSync(stateFile, "{corrupt json", "utf8");

    expect(store.getBotMeta("hermes:default")).toEqual({});
    const backups = NodeFS.readdirSync(dir).filter((f) => f.startsWith("pa-bots.json.corrupt-"));
    expect(backups).toHaveLength(1);
    expect(NodeFS.readFileSync(NodePath.join(dir, backups[0]!), "utf8")).toBe("{corrupt json");
  });

  it("enforces Hermes protocol contracts: input_id, execution_generation, replay, tool events, session-isolated approvals, profile-scoped model.options, and cron errors", async () => {
    const { store } = makeStore();
    const defaultConn = new FakeHermesConnection("default");
    const feedbotConn = new FakeHermesConnection("feedbot");

    defaultConn.onMethod("profiles.list", () => ({
      profiles: [
        {
          name: "default",
          is_default: true,
          model: "deepseek-flash",
          provider: "deepseek",
          skill_count: 10,
        },
        { name: "feedbot", is_default: false, model: "", provider: "", skill_count: 2 },
      ],
    }));
    defaultConn.onMethod("profiles.describe", (p) => ({
      name: p.name,
      soul: `Soul for ${String(p.name)}`,
      model: { default: "deepseek-flash", provider: "deepseek" },
      skills: [{ name: "digest", enabled: true }],
      toolsets: [{ name: "web", label: "Web", enabled: true }],
      mcp_servers: [],
    }));
    defaultConn.onMethod("profiles.configure", (p) => {
      if (p.model === "expensive-opus" && !p.confirm_expensive_model) {
        return {
          ok: false,
          confirm_required: true,
          confirm_message: "Expensive model confirmation needed",
        };
      }
      return { ok: true };
    });
    defaultConn.onMethod("session.list", () => ({
      sessions: [
        {
          session_id: "s-def-1",
          title: "Main chat",
          source: "gui",
          message_count: 4,
          last_active: 1700000100,
        },
      ],
    }));

    defaultConn.onMethod("cron.manage", (p) => {
      if (p.action === "pause" && p.name === "bad-job") {
        return { success: false, error: "Job not found" };
      }
      return {
        success: true,
        jobs: [
          { id: "job-42", name: "Morning", schedule: "0 9 * * *", prompt: "Brief", enabled: false },
        ],
      };
    });
    defaultConn.onMethod("skills.manage", () => ({ skills: { news: ["digest"] } }));

    feedbotConn.onMethod("model.options", () => ({
      providers: [
        { slug: "openrouter", name: "OpenRouter", is_current: true, models: ["deepseek-flash"] },
      ],
    }));
    feedbotConn.onMethod("session.list", () => ({
      sessions: [
        {
          session_id: "s-feed-1",
          title: "Daily Digest",
          source: "feishu",
          message_count: 2,
          last_active: 1700000200,
        },
      ],
    }));
    feedbotConn.onMethod("session.resume", (p) => ({
      running: true,
      last_sequence: 12,
      replay_epoch: "ep-A",
      execution_generation: 5,
      subscription_id: `sub-${String(p.session_id)}`,
      open_requests: [
        { id: "srq-open-1", method: "approval", params: { command: "rm -rf /tmp/foo" } },
      ],
      prompts: [
        {
          prompt_id: "prm-1",
          kind: "clarify",
          execution_generation: 5,
          question: "Which feed?",
          questions: [{ id: "q1", prompt: "Which feed?" }],
        },
      ],
    }));
    feedbotConn.onMethod("session.events.since", () => ({
      replay_epoch: "ep-A",
      snapshot_required: false,
      events: [
        {
          type: "tool.start",
          session_id: "s-feed-1",
          seq: 11,
          payload: { tool_name: "web_search", preview: "query" },
        },
        {
          type: "tool.complete",
          session_id: "s-feed-1",
          seq: 12,
          payload: { tool_name: "web_search" },
        },
      ],
    }));
    feedbotConn.onMethod("session.detach", () => ({ ok: true }));
    feedbotConn.onMethod("session.interrupt", () => ({ ok: true }));
    feedbotConn.onMethod("approval.respond", () => ({ ok: true }));
    feedbotConn.onMethod("clarify.respond", () => ({ ok: true }));
    feedbotConn.onMethod("session.transcript", () => ({
      rows: [{ role: "assistant", text: "Hello", row_id: 1, timestamp: 1700000201 }],
    }));
    feedbotConn.onMethod("slash.exec", (p) => ({
      type: "exec",
      output: `Native slash output for ${String(p.command)}`,
    }));
    feedbotConn.onMethod("prompt.submit", () => ({
      admission_id: "adm-123",
    }));

    const connectedProfiles: string[] = [];
    const fakePool = {
      getConnection: async (profile: string) => {
        connectedProfiles.push(profile);
        return profile === "feedbot" ? feedbotConn : defaultConn;
      },
      closeAll: () => undefined,
    } as unknown as HermesConnectionPool;

    const adapter = new HermesPaAdapter(store, fakePool);
    const service = createPaService([adapter]);

    // 1. listBots does NOT spawn N+1 secondary profile gateway connections
    const listed = await service.listBots();
    expect(listed.bots).toHaveLength(2);
    expect(connectedProfiles).toEqual(["default"]);

    // 2. getBotDetail calls model.options on feedbotConn (not defaultConn) and cron.manage with include_disabled: true
    const detail = await service.getBotDetail("hermes:feedbot");
    expect(detail.modelOptions[0]?.slug).toBe("openrouter");
    expect(defaultConn.calls.some((c) => c.method === "model.options")).toBe(false);
    expect(
      defaultConn.calls.find((c) => c.method === "cron.manage" && c.params.action === "list")
        ?.params,
    ).toMatchObject({ profile: "feedbot", include_disabled: true });

    // 3. profiles.configure propagates confirm_required without throwing
    const confirmDetail = await service.updateBot("hermes:feedbot", { model: "expensive-opus" });
    expect(confirmDetail.confirmRequired?.message).toContain("Expensive model");

    // 4. cron.manage sends jobId via Hermes `name` parameter and throws on gateway error
    await expect(
      service.manageCron("hermes:feedbot", { action: "pause", jobId: "bad-job" }),
    ).rejects.toThrow("Job not found");
    const jobs = await service.manageCron("hermes:feedbot", { action: "resume", jobId: "job-42" });
    expect(jobs).toHaveLength(1);
    expect(
      defaultConn.calls.find((c) => c.method === "cron.manage" && c.params.action === "resume")
        ?.params,
    ).toMatchObject({ profile: "feedbot", name: "job-42" });

    // 5. prompt.submit always includes input_id
    const turnResult = await service.sendMessage("hermes:feedbot", "s-feed-1", "Summarize today", {
      inputId: "client-input-99",
    });
    expect(turnResult.kind).toBe("turn");
    expect(feedbotConn.calls.find((c) => c.method === "prompt.submit")?.params).toMatchObject({
      session_id: "s-feed-1",
      text: "Summarize today",
      input_id: "client-input-99",
    });

    // 6. getMessages has zero write side effects (does NOT mutate lastReadAt in store)
    store.updateBotMeta("hermes:feedbot", { lastReadAt: 100 });
    await service.getMessages("hermes:feedbot", "s-feed-1");
    expect(store.getBotMeta("hermes:feedbot").lastReadAt).toBe(100);

    // 7. subscribeSession sends last_sequence + replay_epoch, merges open_requests + prompts, and isolates sessions
    const receivedA: PaStreamEvent[] = [];
    const receivedB: PaStreamEvent[] = [];
    let closedReasonA: string | undefined;

    const unsubA = await service.subscribeSession("hermes:feedbot", "s-feed-1", {
      sinceSeq: 10,
      replayEpoch: "ep-A",
      onEvent: (event) => receivedA.push(event),
      onClose: (reason) => {
        closedReasonA = reason;
      },
    });
    const unsubB = await service.subscribeSession("hermes:feedbot", "s-feed-2", {
      onEvent: (event) => receivedB.push(event),
    });

    expect(
      feedbotConn.calls.find((c) => c.method === "session.events.since")?.params,
    ).toMatchObject({
      session_id: "s-feed-1",
      last_sequence: 10,
      replay_epoch: "ep-A",
    });

    // Snapshot includes both server_request open_requests[].id and canonical prompts[]
    const snapshotA = receivedA[0];
    expect(snapshotA?.type).toBe("snapshot");
    if (snapshotA?.type === "snapshot") {
      expect(snapshotA.replayEpoch).toBe("ep-A");
      expect(snapshotA.openRequests.map((r) => `${r.channel}:${r.requestId}`)).toEqual([
        "server_request:srq-open-1",
        "canonical:prm-1",
      ]);
    }
    // Replay mapped tool.start + tool.complete -> tool.progress
    expect(receivedA.slice(1).map((e) => (e.type === "tool.progress" ? e.status : e.type))).toEqual(
      ["started", "completed"],
    );

    // Session-scoped server request for s-feed-1 does NOT leak to s-feed-2
    const claimed = feedbotConn.emitRequest({
      request_id: "srq-live-1",
      method: "approval",
      session_id: "s-feed-1",
      params: { session_id: "s-feed-1", command: "git push" },
    });
    expect(claimed).toBe(true);
    expect(
      receivedA.some((e) => e.type === "request.open" && e.request.requestId === "srq-live-1"),
    ).toBe(true);
    expect(receivedB.some((e) => e.type === "request.open")).toBe(false);

    // session.interrupt passes tracked execution_generation: 5
    await service.interruptSession("hermes:feedbot", "s-feed-1");
    expect(feedbotConn.calls.find((c) => c.method === "session.interrupt")?.params).toEqual({
      session_id: "s-feed-1",
      execution_generation: 5,
    });

    // Canonical clarify.respond uses prompt_id + execution_generation
    await service.respondRequest("hermes:feedbot", "s-feed-1", {
      requestId: "prm-1",
      kind: "clarify",
      channel: "canonical",
      answer: "Tech news",
      answers: { q1: "Tech news" },
    });
    expect(feedbotConn.calls.find((c) => c.method === "clarify.respond")?.params).toEqual({
      session_id: "s-feed-1",
      execution_generation: 5,
      prompt_id: "prm-1",
      answer: "Tech news",
    });

    // Server-request approval uses respondServerRequest
    await service.respondRequest("hermes:feedbot", "s-feed-1", {
      requestId: "srq-live-1",
      kind: "approval",
      channel: "server_request",
      decision: "once",
    });
    expect(feedbotConn.serverResponses).toContainEqual({
      requestId: "srq-live-1",
      result: { choice: "once" },
    });

    // Unsubscribing last listener for s-feed-2 triggers session.detach
    unsubB();
    expect(
      feedbotConn.calls.some(
        (c) => c.method === "session.detach" && c.params.session_id === "s-feed-2",
      ),
    ).toBe(true);

    // Dropping the upstream connection notifies active SSE subscriber via onClose
    feedbotConn.simulateClose();
    expect(closedReasonA).toBeTruthy();
    unsubA();
  });
});
