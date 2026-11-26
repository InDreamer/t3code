import { PaError } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { PaAdapterEvent, PaSessionSubscriber } from "../../types.ts";
import {
  HermesConnectionError,
  HermesRpcError,
  type HermesConnectionPool,
  type HermesRpcConnection,
  type HermesRpcEventFrame,
  type HermesServerRequestFrame,
} from "./HermesGatewayClient.ts";
import { HermesPaAdapter } from "./HermesPaAdapter.ts";

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

function makeAdapter(connections: Record<string, FakeHermesConnection>) {
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
  return { adapter: new HermesPaAdapter({ pool }), connectedProfiles };
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

function collect() {
  const events: PaAdapterEvent[] = [];
  const closes: Array<string | undefined> = [];
  const subscriber: PaSessionSubscriber = {
    onEvent: (event) => events.push(event),
    onClose: (reason) => closes.push(reason),
  };
  return { events, closes, subscriber };
}

const LIVE = { resume: false } as const;

describe("HermesPaAdapter profile routing", () => {
  it("routes profile-bound RPCs through the agent's own socket", async () => {
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
      if (p.action === "pause" && p.name === "bad-job") {
        return { success: false, error: "Job not found" };
      }
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

    const { adapter } = makeAdapter({ default: defaultConn, feedbot: feedbotConn });

    const agents = await adapter.listAgents();
    expect(agents.map((a) => [a.agentRef, a.model])).toEqual([
      ["default", "flash"],
      ["feedbot", "flash"],
    ]);
    // Only the row without a model is described, over the already-open default socket.
    expect(defaultConn.callsOf("profiles.describe").map((c) => c.params.name)).toEqual(["feedbot"]);

    expect(await adapter.schedules.list("feedbot")).toEqual([
      expect.objectContaining({ id: "job-42", prompt: "Brief me", enabled: false }),
    ]);
    const config = await adapter.config.get("feedbot");
    const skills = config.sections.find((s) => s.id === "skills");
    expect(skills?.kind === "toggleList" && skills.items).toEqual([
      { id: "digest", label: "digest", group: "news", enabled: true },
    ]);
    const catalog = await adapter.models.getCatalog("feedbot");
    expect(catalog.providers.map((p) => p.id)).toEqual(["openrouter"]);
    expect(feedbotConn.callsOf("model.options")[0]?.params).toEqual({ explicit_only: true });
    for (const method of ["cron.manage", "skills.manage", "model.options"]) {
      expect(defaultConn.callsOf(method)).toEqual([]);
    }
    expect(feedbotConn.callsOf("cron.manage")[0]?.params).toMatchObject({
      profile: "feedbot",
      include_disabled: true,
    });

    await expect(
      adapter.schedules.mutate("feedbot", { action: "pause", scheduleId: "bad-job" }),
    ).rejects.toMatchObject({ reason: "Invalid", message: "Job not found" });
    expect(
      await adapter.schedules.mutate("feedbot", { action: "resume", scheduleId: "job-42" }),
    ).toHaveLength(1);
    expect(
      feedbotConn.callsOf("cron.manage").find((c) => c.params.action === "resume")?.params,
    ).toMatchObject({ profile: "feedbot", name: "job-42" });

    expect(
      await adapter.models.select("feedbot", {
        provider: "anthropic",
        model: "expensive-opus",
        confirm: false,
      }),
    ).toEqual({ status: "confirmRequired", message: "Expensive model confirmation" });
    expect(
      await adapter.models.select("feedbot", {
        provider: "anthropic",
        model: "expensive-opus",
        confirm: true,
      }),
    ).toEqual({ status: "applied", current: { provider: "anthropic", model: "expensive-opus" } });
  });

  it("patches config sections as Hermes profile fields", async () => {
    const defaultConn = new FakeHermesConnection("default");
    const feedbotConn = new FakeHermesConnection("feedbot");
    defaultConn.onMethod("profiles.describe", () => ({
      soul: "old",
      skills: [
        { name: "digest", enabled: true },
        { name: "scrape", enabled: true },
      ],
      toolsets: [
        { name: "web", enabled: true },
        { name: "terminal", enabled: true },
      ],
    }));
    defaultConn.onMethod("profiles.configure", () => ({ ok: true }));
    feedbotConn.onMethod("skills.manage", () => ({ skills: {} }));
    const { adapter } = makeAdapter({ default: defaultConn, feedbot: feedbotConn });

    await adapter.config.patch("feedbot", "persona", { kind: "document", text: "new soul" });
    await adapter.config.patch("feedbot", "skills", { kind: "toggleList", enabled: ["digest"] });
    await adapter.config.patch("feedbot", "toolsets", { kind: "toggleList", enabled: ["web"] });
    await adapter.config.patch("feedbot", "profile", {
      kind: "options",
      values: { description: "Daily news" },
    });
    expect(defaultConn.callsOf("profiles.configure").map((c) => c.params)).toEqual([
      { name: "feedbot", soul: "new soul" },
      { name: "feedbot", disabled_skills: ["scrape"] },
      { name: "feedbot", enabled_toolsets: ["web"] },
      { name: "feedbot", description: "Daily news" },
    ]);

    // An empty pin would silently re-enable every default toolset.
    await expect(
      adapter.config.patch("feedbot", "toolsets", { kind: "toggleList", enabled: [] }),
    ).rejects.toMatchObject({ reason: "Invalid" });
    await expect(
      adapter.config.patch("feedbot", "persona", { kind: "toggleList", enabled: [] }),
    ).rejects.toMatchObject({ reason: "Invalid" });
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
    feedbotConn.onMethod("slash.exec", () => ({ output: "ok" }));
    const { adapter } = makeAdapter({ feedbot: feedbotConn });

    expect(await adapter.listSessions("feedbot")).toEqual([
      expect.objectContaining({ sessionId: "s-run", running: true, lastActivityAt: 1700000300000 }),
    ]);
    expect(feedbotConn.callsOf("session.list").map((c) => c.params)).toEqual([
      { scope: "live", limit: 30, picker: true },
      { scope: "stored", limit: 30, picker: true },
    ]);

    const created = await adapter.createSession("feedbot", { title: "Planning" });
    expect(created).toMatchObject({ sessionId: "s-new", title: "Planning" });
    expect(feedbotConn.callsOf("session.create")[0]?.params).toEqual({
      source: "gui",
      follow_profile_config: true,
    });
    expect(feedbotConn.callsOf("slash.exec")[0]?.params).toMatchObject({
      session_id: "s-new",
      command: "/title Planning",
    });
  });

  it("maps Hermes failures to neutral error reasons", async () => {
    const feedbotConn = makeFeedbotConn();
    feedbotConn.onMethod("slash.exec", () => {
      throw new HermesRpcError("unsupported_command", 4010);
    });
    const { adapter } = makeAdapter({ feedbot: feedbotConn });
    const failure = await adapter
      .sendMessage("feedbot", "s-1", "/sessions", {})
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(PaError);
    expect(failure).toMatchObject({ reason: "Unsupported" });
    await expect(adapter.listSessions("ghost")).rejects.toMatchObject({ reason: "Unavailable" });
    await expect(adapter.getMessages("feedbot", "../x", 10)).rejects.toMatchObject({
      reason: "Invalid",
    });
  });

  it("runs plain text as a turn and returns command output that Hermes does not store", async () => {
    const feedbotConn = makeFeedbotConn();
    feedbotConn.onMethod("slash.exec", (p) =>
      p.command === "/brief" ? { type: "skill", message: "Expand the brief" } : { output: "Up" },
    );
    const { adapter } = makeAdapter({ feedbot: feedbotConn });
    expect(await adapter.sendMessage("feedbot", "s-1", "hello", { inputId: "in-1" })).toEqual({
      kind: "turn",
      sessionId: "s-1",
      submissionId: "adm-1",
    });
    expect(feedbotConn.callsOf("prompt.submit")[0]?.params).toEqual({
      session_id: "s-1",
      text: "hello",
      input_id: "in-1",
    });
    expect(await adapter.sendMessage("feedbot", "s-1", "/status", {})).toEqual({
      kind: "output",
      sessionId: "s-1",
      output: "Up",
    });
    expect(await adapter.sendMessage("feedbot", "s-1", "/brief", {})).toMatchObject({
      kind: "turn",
    });
    expect(feedbotConn.callsOf("prompt.submit")[1]?.params.text).toBe("Expand the brief");
  });
});

describe("HermesPaAdapter streaming", () => {
  it("resumes a dropped feed: events.since before resume, then only the gap", async () => {
    const feedbotConn = makeFeedbotConn();
    const { adapter } = makeAdapter({ feedbot: feedbotConn });

    const first = collect();
    const release = await adapter.subscribeSession("feedbot", "s-1", first.subscriber, LIVE);
    expect(first.events[0]).toEqual({
      type: "snapshot",
      sessionId: "s-1",
      running: true,
      openRequests: [],
      snapshotRequired: false,
    });
    // Already covered by the snapshot watermark (12).
    feedbotConn.emitEvent({
      event: "message.delta",
      session_id: "s-1",
      seq: 12,
      replay_epoch: "ep-A",
      payload: { text: "old" },
    });
    feedbotConn.emitEvent({
      event: "message.delta",
      session_id: "s-1",
      seq: 13,
      replay_epoch: "ep-A",
      payload: { text: "Hi" },
    });
    expect(first.events.slice(1)).toEqual([
      expect.objectContaining({ type: "text.delta", text: "Hi", role: "answer" }),
    ]);
    release();
    expect(feedbotConn.callsOf("session.detach")).toHaveLength(1);

    feedbotConn.onMethod("session.events.since", () => ({
      replay_epoch: "ep-A",
      snapshot_required: false,
      events: [
        {
          type: "tool.start",
          session_id: "s-1",
          seq: 14,
          payload: { tool_call_id: "c1", name: "web_search", context: "q" },
        },
      ],
    }));
    const resume = feedbotConn["handlers"].get("session.resume")!;
    feedbotConn.onMethod("session.resume", (p) => {
      // Resume's catch_up re-sends seq 14 on the socket ahead of its reply.
      feedbotConn.emitEvent({
        event: "tool.start",
        session_id: "s-1",
        seq: 14,
        replay_epoch: "ep-A",
        payload: { tool_call_id: "c1" },
      });
      feedbotConn.emitEvent({
        event: "tool.complete",
        session_id: "s-1",
        seq: 15,
        replay_epoch: "ep-A",
        payload: { tool_call_id: "c1", name: "web_search" },
      });
      return resume(p);
    });
    const second = collect();
    const callsBefore = feedbotConn.calls.length;
    const release2 = await adapter.subscribeSession("feedbot", "s-1", second.subscriber, {
      resume: true,
    });
    expect(feedbotConn.calls.slice(callsBefore).map((c) => c.method)).toEqual([
      "session.events.since",
      "session.resume",
    ]);
    expect(feedbotConn.callsOf("session.events.since")[0]?.params).toMatchObject({
      last_sequence: 13,
      replay_epoch: "ep-A",
    });
    expect(second.events.map((e) => (e.type === "tool.updated" ? e.status : e.type))).toEqual([
      "snapshot",
      "started",
      "completed",
    ]);
    expect(second.events[1]).toMatchObject({ toolId: "c1", toolCategory: "web-search" });
    release2();
  });

  it("asks for a reload when the replay epoch is gone", async () => {
    const feedbotConn = makeFeedbotConn();
    const { adapter } = makeAdapter({ feedbot: feedbotConn });
    const first = collect();
    (await adapter.subscribeSession("feedbot", "s-1", first.subscriber, LIVE))();
    feedbotConn.onMethod("session.events.since", () => ({ snapshot_required: true, events: [] }));
    const second = collect();
    const release = await adapter.subscribeSession("feedbot", "s-1", second.subscriber, {
      resume: true,
    });
    expect(second.events).toEqual([expect.objectContaining({ snapshotRequired: true })]);
    release();
  });

  it("rejects instead of faking an idle snapshot when session.resume fails", async () => {
    const feedbotConn = makeFeedbotConn();
    feedbotConn.onMethod("session.resume", () => {
      throw new HermesRpcError("not_found", 4004);
    });
    const { adapter } = makeAdapter({ feedbot: feedbotConn });
    const feed = collect();
    await expect(
      adapter.subscribeSession("feedbot", "s-gone", feed.subscriber, LIVE),
    ).rejects.toMatchObject({ reason: "NotFound" });
    feedbotConn.emitEvent({
      event: "message.delta",
      session_id: "s-gone",
      seq: 1,
      payload: { text: "x" },
    });
    expect(feed.events).toEqual([]);
  });

  it("recovers from session.replay_gap: asks for a reload and ends the feed", async () => {
    const feedbotConn = makeFeedbotConn();
    const { adapter } = makeAdapter({ feedbot: feedbotConn });
    const feed = collect();
    await adapter.subscribeSession("feedbot", "s-1", feed.subscriber, LIVE);
    feedbotConn.emitEvent({
      event: "session.replay_gap",
      session_id: "s-1",
      payload: { replay_epoch: "ep-A", latest_seq: 40 },
    });
    expect(feed.events.at(-1)).toMatchObject({ type: "snapshot", snapshotRequired: true });
    expect(feed.closes).toEqual([undefined]);

    // The retired subscription is not reused: the next send re-attaches first.
    const resumesBefore = feedbotConn.callsOf("session.resume").length;
    await adapter.sendMessage("feedbot", "s-1", "hello", {});
    expect(feedbotConn.callsOf("session.resume").length).toBe(resumesBefore + 1);
  });

  it("ends the feed with a reason when the gateway socket closes", async () => {
    const feedbotConn = makeFeedbotConn();
    const { adapter } = makeAdapter({ feedbot: feedbotConn });
    const feed = collect();
    await adapter.subscribeSession("feedbot", "s-1", feed.subscriber, LIVE);
    feedbotConn.simulateClose();
    expect(feed.closes).toEqual(["Hermes gateway connection closed"]);
  });

  it("adopts the canonical session id session.resume redirects to", async () => {
    const feedbotConn = makeFeedbotConn({ canonical: "s-tip" });
    const { adapter } = makeAdapter({ feedbot: feedbotConn });
    const feed = collect();
    const release = await adapter.subscribeSession("feedbot", "s-root", feed.subscriber, LIVE);
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
    expect(feed.events.map((e) => e.type)).toEqual(["snapshot", "text.delta", "request.opened"]);

    await adapter.interruptSession("feedbot", "s-root");
    expect(feedbotConn.callsOf("session.interrupt")[0]?.params).toEqual({
      session_id: "s-tip",
      execution_generation: 5,
    });
    release();
    expect(feedbotConn.callsOf("session.detach")[0]?.params).toMatchObject({ session_id: "s-tip" });
  });

  it("keeps a shared subscription attached until the last redirected/canonical feed closes", async () => {
    const feedbotConn = makeFeedbotConn();
    feedbotConn.onMethod("session.resume", () => ({
      session_id: "canon-root",
      running: false,
      last_sequence: 10,
      replay_epoch: "ep-A",
      execution_generation: 3,
      subscription_id: "sub-shared",
    }));
    const { adapter } = makeAdapter({ feedbot: feedbotConn });
    const releaseOld = await adapter.subscribeSession(
      "feedbot",
      "legacy-id",
      collect().subscriber,
      LIVE,
    );
    const releaseCanon = await adapter.subscribeSession(
      "feedbot",
      "canon-root",
      collect().subscriber,
      LIVE,
    );
    releaseOld();
    expect(feedbotConn.callsOf("session.detach")).toHaveLength(0);
    releaseCanon();
    expect(feedbotConn.callsOf("session.detach").map((c) => c.params)).toEqual([
      { session_id: "canon-root", subscription_id: "sub-shared" },
    ]);
  });
});

describe("HermesPaAdapter prompts", () => {
  it("answers only tracked requests of the same session, keyed by each question's id", async () => {
    const feedbotConn = makeFeedbotConn();
    const { adapter } = makeAdapter({ feedbot: feedbotConn });
    const a = collect();
    const b = collect();
    await adapter.subscribeSession("feedbot", "s-a", a.subscriber, LIVE);
    await adapter.subscribeSession("feedbot", "s-b", b.subscriber, LIVE);

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
    const opened = a.events.find((e) => e.type === "request.opened");
    expect(opened?.type === "request.opened" && opened.request.questions).toEqual([
      { id: "q0", prompt: "Which env?", options: ["staging", "prod"], multiSelect: true },
      { id: "q1", prompt: "Why?" },
    ]);
    expect(b.events.some((e) => e.type === "request.opened")).toBe(false);

    // Another session (or a stale id) can never answer it over the shared profile socket.
    await expect(
      adapter.requests.respond("feedbot", "s-b", { requestId: "srq-batch", answers: { q0: "x" } }),
    ).rejects.toMatchObject({ reason: "NotFound" });
    await expect(
      adapter.requests.respond("feedbot", "s-a", { requestId: "srq-nope", decision: "once" }),
    ).rejects.toThrow(/no longer open/);
    expect(feedbotConn.serverResponses).toEqual([]);

    await adapter.requests.respond("feedbot", "s-a", {
      requestId: "srq-batch",
      answers: { q0: ["staging", "prod"], q1: "release" },
    });
    expect(feedbotConn.serverResponses).toEqual([
      { requestId: "srq-batch", result: { answers: { q0: '["staging","prod"]', q1: "release" } } },
    ]);
    await expect(
      adapter.requests.respond("feedbot", "s-a", { requestId: "srq-batch", answers: {} }),
    ).rejects.toMatchObject({ reason: "NotFound" });
  });

  it("refuses an approval decision that is not one of the request's options", async () => {
    const feedbotConn = makeFeedbotConn();
    const { adapter } = makeAdapter({ feedbot: feedbotConn });
    await adapter.subscribeSession("feedbot", "s-1", collect().subscriber, LIVE);
    feedbotConn.emitRequest({
      request_id: "srq-1",
      method: "approval",
      session_id: "s-1",
      params: { command: "ls" },
    });
    await expect(
      adapter.requests.respond("feedbot", "s-1", { requestId: "srq-1", decision: "always" }),
    ).rejects.toMatchObject({ reason: "Invalid" });
    await adapter.requests.respond("feedbot", "s-1", { requestId: "srq-1", decision: "session" });
    expect(feedbotConn.serverResponses).toEqual([
      { requestId: "srq-1", result: { choice: "session" } },
    ]);
  });

  it("answers canonical clarify prompts over clarify.respond with a JSON label array", async () => {
    const feedbotConn = makeFeedbotConn();
    const { adapter } = makeAdapter({ feedbot: feedbotConn });
    const feed = collect();
    await adapter.subscribeSession("feedbot", "s-1", feed.subscriber, LIVE);
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
    const opened = feed.events.find((e) => e.type === "request.opened");
    expect(opened?.type === "request.opened" && opened.request).toMatchObject({
      requestId: "clr-1",
      detail: "Deploy where?",
      questions: [
        {
          id: "q0",
          prompt: "Deploy where?",
          options: ["staging", "prod", "dev"],
          multiSelect: true,
        },
      ],
    });

    await adapter.requests.respond("feedbot", "s-1", {
      requestId: "clr-1",
      answers: { q0: ["staging", "dev"] },
    });
    // Hermes `clarify_tool.py._clean_answer` parses multi-select JSON arrays verbatim.
    expect(feedbotConn.callsOf("clarify.respond")[0]?.params).toEqual({
      session_id: "s-1",
      execution_generation: 6,
      prompt_id: "clr-1",
      answer: JSON.stringify(["staging", "dev"]),
    });
  });

  it("preserves locked answers on a resumed batch clarify and prunes stale requests on snapshot", async () => {
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
    const { adapter } = makeAdapter({ feedbot: feedbotConn });
    const feed = collect();
    const release1 = await adapter.subscribeSession("feedbot", "s-1", feed.subscriber, LIVE);
    expect(feed.events[0]).toMatchObject({
      type: "snapshot",
      openRequests: [expect.objectContaining({ requestId: "srq-batch" })],
    });

    // Only answer q1: q0 is omitted so Hermes keeps the locked "prod" answer.
    await adapter.requests.respond("feedbot", "s-1", {
      requestId: "srq-batch",
      answers: { q0: "", q1: "fast" },
    });
    expect(feedbotConn.serverResponses).toContainEqual({
      requestId: "srq-batch",
      result: { answers: { q1: "fast" } },
    });

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
    const release2 = await adapter.subscribeSession("feedbot", "s-1", collect().subscriber, LIVE);
    await expect(
      adapter.requests.respond("feedbot", "s-1", { requestId: "srq-stale", decision: "once" }),
    ).rejects.toMatchObject({ reason: "NotFound" });
    release1();
    release2();
  });
});
