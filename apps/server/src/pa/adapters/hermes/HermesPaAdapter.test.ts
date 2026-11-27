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
  readonly calls: Array<{
    method: string;
    params: Record<string, unknown>;
    timeoutMs: number | undefined;
  }> = [];
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
    timeoutMs?: number,
  ): Promise<T> {
    this.calls.push({ method, params, timeoutMs });
    if (typeof params.profile === "string" && params.profile !== this.profile) {
      throw new HermesRpcError("profile_mismatch", 4001);
    }
    const handler = this.handlers.get(method);
    if (!handler) throw new HermesRpcError(`Unhandled RPC method: ${method}`, -32601);
    return (await handler(params)) as T;
  }

  respondServerRequest(requestId: string, result: Record<string, unknown>): void {
    if (!this.open) throw new HermesConnectionError("socket closed");
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
        : { ok: true, applied: p.model && p.provider ? { model: true } : {} },
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

  it("reads and updates reasoning effort without re-triggering model confirmation", async () => {
    const defaultConn = new FakeHermesConnection("default");
    const feedbotConn = new FakeHermesConnection("feedbot");
    defaultConn.onMethod("profiles.describe", () => ({
      name: "feedbot",
      model: { default: "expensive-opus", provider: "anthropic" },
    }));
    defaultConn.onMethod("profiles.configure", (p) =>
      p.model === "expensive-opus" && !p.confirm_expensive_model
        ? { ok: false, confirm_required: true, confirm_message: "Expensive model confirmation" }
        : { ok: true, applied: { model: true } },
    );
    feedbotConn.onMethod("model.options", () => ({
      providers: [
        {
          slug: "anthropic",
          name: "Anthropic",
          is_current: true,
          models: ["expensive-opus"],
          capabilities: {
            "expensive-opus": { reasoning: true, can_disable_reasoning: true },
          },
        },
      ],
    }));
    feedbotConn.onMethod("config.get", (p) =>
      p.key === "reasoning" ? { value: "medium", display: "show" } : {},
    );
    feedbotConn.onMethod("config.set", (p) => ({ key: p.key, value: p.value }));

    const { adapter } = makeAdapter({ default: defaultConn, feedbot: feedbotConn });

    const catalog = await adapter.models.getCatalog("feedbot", "sess-1");
    expect(catalog.current).toEqual({
      provider: "anthropic",
      model: "expensive-opus",
      reasoningEffort: "medium",
    });
    expect(feedbotConn.callsOf("config.get")[0]?.params).toEqual({
      key: "reasoning",
      session_id: "sess-1",
    });

    // Reasoning-only change skips `profiles.configure` so an already-selected expensive model never re-prompts.
    const updated = await adapter.models.select("feedbot", {
      sessionId: "sess-1",
      reasoningEffort: "xhigh",
      confirm: false,
    });
    expect(updated).toEqual({
      status: "applied",
      current: {
        provider: "anthropic",
        model: "expensive-opus",
        reasoningEffort: "xhigh",
      },
    });
    expect(defaultConn.callsOf("profiles.configure")).toEqual([]);
    expect(feedbotConn.callsOf("config.set")[0]?.params).toEqual({
      key: "reasoning",
      value: "xhigh",
      scope: "global",
      session_id: "sess-1",
    });

    // Invalid reasoning effort fails before touching `profiles.configure`.
    await expect(
      adapter.models.select("feedbot", {
        provider: "anthropic",
        model: "expensive-opus",
        reasoningEffort: "turbo",
        confirm: true,
      }),
    ).rejects.toMatchObject({ reason: "Invalid" });
    expect(defaultConn.callsOf("profiles.configure")).toEqual([]);
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
    // Replayed history first, then the snapshot that is current as of the resume, then live.
    expect(second.events.map((e) => (e.type === "tool.updated" ? e.status : e.type))).toEqual([
      "started",
      "snapshot",
      "completed",
    ]);
    expect(second.events[0]).toMatchObject({ toolId: "c1", toolCategory: "web-search" });
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

describe("HermesPaAdapter handshake and retries", () => {
  it("holds a prompt raised mid-handshake and opens it after the snapshot", async () => {
    const feedbotConn = makeFeedbotConn();
    const resume = feedbotConn["handlers"].get("session.resume")!;
    const midHandshake = {
      request_id: "srq-mid",
      method: "approval",
      session_id: "s-1",
      params: { command: "rm -rf build" },
    };
    feedbotConn.onMethod("session.resume", (p) => {
      feedbotConn.emitRequest(midHandshake);
      return resume(p);
    });
    const { adapter } = makeAdapter({ feedbot: feedbotConn });
    const feed = collect();
    await adapter.subscribeSession("feedbot", "s-1", feed.subscriber, LIVE);
    expect(feed.events.map((e) => e.type)).toEqual(["snapshot", "request.opened"]);
    expect(feed.events[0]).toMatchObject({ openRequests: [] });

    await adapter.requests.respond("feedbot", "s-1", { requestId: "srq-mid", decision: "once" });
    expect(feedbotConn.serverResponses).toEqual([
      { requestId: "srq-mid", result: { choice: "once" } },
    ]);

    // Already in the snapshot: not opened a second time.
    const sameSession = collect();
    feedbotConn.onMethod("session.resume", (p) => {
      feedbotConn.emitRequest({ ...midHandshake, session_id: "s-3" });
      return {
        ...(resume(p) as object),
        open_requests: [{ id: "srq-mid", ...midHandshake, session_id: "s-3" }],
      };
    });
    await adapter.subscribeSession("feedbot", "s-3", sameSession.subscriber, LIVE);
    expect(sameSession.events.map((e) => e.type)).toEqual(["snapshot"]);
    expect(sameSession.events[0]).toMatchObject({
      openRequests: [expect.objectContaining({ requestId: "srq-mid" })],
    });
  });

  it("fails an open whose socket closes mid-handshake instead of ending the feed", async () => {
    const feedbotConn = makeFeedbotConn();
    const resume = feedbotConn["handlers"].get("session.resume")!;
    feedbotConn.onMethod("session.resume", (p) => {
      const snapshot = resume(p);
      feedbotConn.simulateClose();
      return snapshot;
    });
    const { adapter } = makeAdapter({ feedbot: feedbotConn });
    const feed = collect();
    await expect(
      adapter.subscribeSession("feedbot", "s-1", feed.subscriber, LIVE),
    ).rejects.toMatchObject({ reason: "Unavailable" });
    // The hub owns the retry: no close callback, no events, and the dead socket is not kept.
    expect(feed.closes).toEqual([]);
    expect(feed.events).toEqual([]);
    feedbotConn.onMethod("session.resume", resume);
    const resumes = feedbotConn.callsOf("session.resume").length;
    await adapter.sendMessage("feedbot", "s-1", "hello", {});
    expect(feedbotConn.callsOf("session.resume").length).toBe(resumes + 1);
  });

  it("lets only one of two concurrent answers to a request through", async () => {
    const feedbotConn = makeFeedbotConn();
    const { adapter } = makeAdapter({ feedbot: feedbotConn });
    await adapter.subscribeSession("feedbot", "s-1", collect().subscriber, LIVE);
    feedbotConn.emitRequest({
      request_id: "srq-1",
      method: "approval",
      session_id: "s-1",
      params: { command: "ls" },
    });
    const results = await Promise.allSettled([
      adapter.requests.respond("feedbot", "s-1", { requestId: "srq-1", decision: "once" }),
      adapter.requests.respond("feedbot", "s-1", { requestId: "srq-1", decision: "deny" }),
    ]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected"]);
    expect(results[1]).toMatchObject({ reason: expect.objectContaining({ reason: "Conflict" }) });
    expect(feedbotConn.serverResponses).toEqual([
      { requestId: "srq-1", result: { choice: "once" } },
    ]);
  });

  it("runs a retried slash command once and replays its result", async () => {
    const feedbotConn = makeFeedbotConn();
    let runs = 0;
    feedbotConn.onMethod("slash.exec", () => {
      runs += 1;
      return { output: `ran ${runs}` };
    });
    const { adapter } = makeAdapter({ feedbot: feedbotConn });
    const [first, concurrent] = await Promise.all([
      adapter.sendMessage("feedbot", "s-1", "/plugin deploy", { inputId: "in-7" }),
      adapter.sendMessage("feedbot", "s-1", "/plugin deploy", { inputId: "in-7" }),
    ]);
    const retried = await adapter.sendMessage("feedbot", "s-1", " /plugin deploy ", {
      inputId: "in-7",
    });
    expect(runs).toBe(1);
    expect([first, concurrent, retried]).toEqual(
      Array.from({ length: 3 }, () => ({ kind: "output", sessionId: "s-1", output: "ran 1" })),
    );
    await expect(
      adapter.sendMessage("feedbot", "s-1", "/plugin rollback", { inputId: "in-7" }),
    ).rejects.toMatchObject({ reason: "Conflict" });
    await adapter.sendMessage("feedbot", "s-1", "/plugin deploy", { inputId: "in-8" });
    expect(runs).toBe(2);
  });

  it("reports a retried message whose turn already ended as settled", async () => {
    const feedbotConn = makeFeedbotConn();
    feedbotConn.onMethod("prompt.submit", () => ({
      admission_id: "adm-1",
      status: "terminal",
      outcome: "completed",
    }));
    const { adapter } = makeAdapter({ feedbot: feedbotConn });
    expect(await adapter.sendMessage("feedbot", "s-1", "hello", { inputId: "in-1" })).toEqual({
      kind: "turn",
      sessionId: "s-1",
      submissionId: "adm-1",
      settled: true,
    });
  });

  it("maps a stale generation or a conflicting admission to Conflict", async () => {
    const feedbotConn = makeFeedbotConn();
    const { adapter } = makeAdapter({ feedbot: feedbotConn });
    feedbotConn.onMethod("prompt.submit", () => {
      throw new HermesRpcError("admission_conflict", 4090);
    });
    await expect(
      adapter.sendMessage("feedbot", "s-1", "hello", { inputId: "in-1" }),
    ).rejects.toMatchObject({ reason: "Conflict" });
    feedbotConn.onMethod("session.interrupt", () => {
      throw new HermesRpcError("stale_generation", 4009);
    });
    await expect(adapter.interruptSession("feedbot", "s-1")).rejects.toMatchObject({
      reason: "Conflict",
    });
  });

  it("replays from seq 0 when the session was empty as the feed dropped", async () => {
    const feedbotConn = makeFeedbotConn();
    const resume = feedbotConn["handlers"].get("session.resume")!;
    feedbotConn.onMethod("session.resume", (p) => ({
      ...(resume(p) as object),
      running: false,
      last_sequence: 0,
    }));
    const { adapter } = makeAdapter({ feedbot: feedbotConn });
    (await adapter.subscribeSession("feedbot", "s-1", collect().subscriber, LIVE))();

    feedbotConn.onMethod("session.events.since", () => ({
      replay_epoch: "ep-A",
      events: [
        { type: "message.start", session_id: "s-1", seq: 1, payload: { turn_id: "t1" } },
        { type: "message.complete", session_id: "s-1", seq: 2, payload: { text: "First" } },
      ],
    }));
    feedbotConn.onMethod("session.resume", (p) => ({ ...(resume(p) as object), last_sequence: 2 }));
    const resumed = collect();
    const release = await adapter.subscribeSession("feedbot", "s-1", resumed.subscriber, {
      resume: true,
    });
    expect(feedbotConn.callsOf("session.events.since")[0]?.params).toMatchObject({
      last_sequence: 0,
      replay_epoch: "ep-A",
    });
    expect(resumed.events.map((e) => e.type)).toEqual([
      "turn.started",
      "turn.completed",
      "snapshot",
    ]);
    expect(resumed.events[2]).toMatchObject({ snapshotRequired: false });
    release();
  });

  it("asks for a reload when a resumed feed cannot replay what it missed", async () => {
    const feedbotConn = new FakeHermesConnection("feedbot");
    let lastSequence = 0;
    // A gateway that hands out no replay epoch cannot serve `session.events.since`.
    feedbotConn.onMethod("session.resume", (p) => ({
      session_id: p.session_id,
      running: false,
      last_sequence: lastSequence,
      subscription_id: "sub-1",
    }));
    feedbotConn.onMethod("session.detach", () => ({ ok: true }));
    const { adapter } = makeAdapter({ feedbot: feedbotConn });
    (await adapter.subscribeSession("feedbot", "s-1", collect().subscriber, LIVE))();
    lastSequence = 3;
    const resumed = collect();
    await adapter.subscribeSession("feedbot", "s-1", resumed.subscriber, { resume: true });
    expect(feedbotConn.callsOf("session.events.since")).toEqual([]);
    expect(resumed.events).toEqual([expect.objectContaining({ snapshotRequired: true })]);
  });

  it("keeps a streaming segment's id across a gapless same-epoch reconnect", async () => {
    const feedbotConn = makeFeedbotConn();
    const { adapter } = makeAdapter({ feedbot: feedbotConn });
    const first = collect();
    const release = await adapter.subscribeSession("feedbot", "s-1", first.subscriber, LIVE);
    feedbotConn.emitEvent({
      event: "message.start",
      session_id: "s-1",
      seq: 13,
      replay_epoch: "ep-A",
      payload: {},
    });
    feedbotConn.emitEvent({
      event: "message.delta",
      session_id: "s-1",
      seq: 14,
      replay_epoch: "ep-A",
      payload: { text: "Hello", offset: 0 },
    });
    release();
    const streamed = first.events.at(-1);
    expect(streamed).toMatchObject({ type: "text.delta", text: "Hello" });

    feedbotConn.onMethod("session.events.since", () => ({
      replay_epoch: "ep-A",
      events: [
        {
          type: "message.delta",
          session_id: "s-1",
          seq: 15,
          payload: { text: "Hello world", offset: 0 },
        },
        {
          type: "message.interim",
          session_id: "s-1",
          seq: 16,
          payload: { text: "Hello world", already_streamed: true },
        },
      ],
    }));
    const second = collect();
    await adapter.subscribeSession("feedbot", "s-1", second.subscriber, { resume: true });
    const segmentId = streamed?.type === "text.delta" ? streamed.segmentId : undefined;
    // Only the unseen suffix streams, into the same segment, which then turns into commentary.
    expect(
      second.events.flatMap((e) =>
        e.type === "text.delta" ? [[e.role, e.text, e.segmentId]] : [],
      ),
    ).toEqual([
      ["answer", " world", segmentId],
      ["commentary", "", segmentId],
    ]);
  });

  it("refuses a model pick without a provider and one Hermes did not write", async () => {
    const defaultConn = new FakeHermesConnection("default");
    defaultConn.onMethod("profiles.configure", () => ({ ok: true, applied: {} }));
    const { adapter } = makeAdapter({ default: defaultConn });
    await expect(
      adapter.models.select("feedbot", { provider: " ", model: "m", confirm: false }),
    ).rejects.toMatchObject({ reason: "Invalid" });
    expect(defaultConn.callsOf("profiles.configure")).toEqual([]);
    await expect(
      adapter.models.select("feedbot", { provider: "openrouter", model: "m", confirm: false }),
    ).rejects.toMatchObject({ reason: "Upstream" });
    expect(defaultConn.callsOf("profiles.configure")[0]?.params).toMatchObject({
      name: "feedbot",
      provider: "openrouter",
      model: "m",
    });
  });
});

describe("HermesPaAdapter slash command retries", () => {
  it("re-submits a rewritten command on retry so Hermes reports its finished turn", async () => {
    const feedbotConn = makeFeedbotConn();
    let execs = 0;
    feedbotConn.onMethod("slash.exec", () => {
      execs += 1;
      return { type: "skill", message: "Expand the brief", notice: "Loaded skill" };
    });
    let turnEnded = false;
    feedbotConn.onMethod("prompt.submit", () =>
      turnEnded ? { admission_id: "adm-1", status: "terminal" } : { admission_id: "adm-1" },
    );
    const { adapter } = makeAdapter({ feedbot: feedbotConn });
    expect(await adapter.sendMessage("feedbot", "s-1", "/brief", { inputId: "in-1" })).toEqual({
      kind: "turn",
      sessionId: "s-1",
      submissionId: "adm-1",
      notice: "Loaded skill",
    });
    turnEnded = true;
    expect(await adapter.sendMessage("feedbot", "s-1", "/brief", { inputId: "in-1" })).toEqual({
      kind: "turn",
      sessionId: "s-1",
      submissionId: "adm-1",
      settled: true,
      notice: "Loaded skill",
    });
    expect(execs).toBe(1);
    expect(feedbotConn.callsOf("prompt.submit").map((c) => c.params)).toEqual([
      { session_id: "s-1", text: "Expand the brief", input_id: "in-1" },
      { session_id: "s-1", text: "Expand the brief", input_id: "in-1" },
    ]);
    expect(feedbotConn.callsOf("slash.exec")[0]?.timeoutMs).toBe(40_000);
  });

  it("does not leave a turn running when a stop phrase only ended voice chat", async () => {
    const feedbotConn = makeFeedbotConn();
    feedbotConn.onMethod("prompt.submit", () => ({ voice_stopped: true }));
    const { adapter } = makeAdapter({ feedbot: feedbotConn });
    const result = await adapter.sendMessage("feedbot", "s-1", "stop", { inputId: "in-1" });
    expect(result).toMatchObject({ kind: "output", sessionId: "s-1" });
  });

  it("never re-runs a command whose first attempt may have reached Hermes", async () => {
    const feedbotConn = makeFeedbotConn();
    let execs = 0;
    feedbotConn.onMethod("slash.exec", (p) => {
      execs += 1;
      if (p.command === "/deploy") throw new HermesConnectionError("timed out");
      if (p.command === "/typo") throw new HermesRpcError("invalid_params", 4000);
      return { output: "ok" };
    });
    const { adapter } = makeAdapter({ feedbot: feedbotConn });
    await expect(
      adapter.sendMessage("feedbot", "s-1", "/deploy", { inputId: "in-1" }),
    ).rejects.toMatchObject({ reason: "Unavailable" });
    await expect(
      adapter.sendMessage("feedbot", "s-1", "/deploy", { inputId: "in-1" }),
    ).rejects.toMatchObject({ reason: "Conflict" });
    expect(execs).toBe(1);

    // A refusal ran nothing, so the same input id may try again.
    await expect(
      adapter.sendMessage("feedbot", "s-1", "/typo", { inputId: "in-2" }),
    ).rejects.toMatchObject({ reason: "Invalid" });
    await expect(
      adapter.sendMessage("feedbot", "s-1", "/typo", { inputId: "in-2" }),
    ).rejects.toMatchObject({ reason: "Invalid" });
    expect(execs).toBe(3);
  });

  it.each([
    ["unsupported_command", 4001],
    ["invalid_params", 4001],
    ["not_found", 4004],
    ["forbidden", 4003],
    ["permission_denied", 4003],
    ["profile_mismatch", 4001],
    ["method missing", -32601],
    ["invalid parameters", -32602],
  ] as const)(
    "allows a corrected retry after the pre-execution refusal %s",
    async (message, code) => {
      const conn = makeFeedbotConn();
      conn.onMethod("slash.exec", () => {
        throw new HermesRpcError(message, code);
      });
      const { adapter } = makeAdapter({ feedbot: conn });
      const send = () => adapter.sendMessage("feedbot", "s-1", "/run", { inputId: "in" });
      await expect(send()).rejects.toThrow();
      conn.onMethod("slash.exec", () => ({ output: "ok" }));
      await expect(send()).resolves.toMatchObject({ output: "ok" });
      expect(conn.callsOf("slash.exec")).toHaveLength(2);
    },
  );

  it("shares concurrent, settled and uncertain results across a redirect", async () => {
    const conn = makeFeedbotConn({ canonical: "s-tip" });
    conn.onMethod("slash.exec", ({ command }) => {
      if (command === "/deploy") throw new HermesRpcError("storage_unavailable", 5001);
      return { output: "ok" };
    });
    const { adapter } = makeAdapter({ feedbot: conn });
    const send = (sessionId: string, text: string) =>
      adapter.sendMessage("feedbot", sessionId, text, { inputId: text });
    await Promise.all([send("s-alias", "/run"), send("s-tip", "/run")]);
    await send("s-tip", "/run");
    await expect(send("s-alias", "/deploy")).rejects.toMatchObject({ reason: "Upstream" });
    await expect(send("s-tip", "/deploy")).rejects.toMatchObject({ reason: "Conflict" });
    expect(conn.callsOf("slash.exec")).toHaveLength(2);
  });

  it("keeps the last 256 settled results independently of uncertain commands and bounds outstanding runs", async () => {
    const conn = makeFeedbotConn();
    conn.onMethod("slash.exec", ({ command }) => {
      if (command === "/lost") throw new HermesRpcError("storage_unavailable", 5001);
      return { output: "done" };
    });
    const { adapter } = makeAdapter({ feedbot: conn });
    const send = (text: string, id: number) =>
      adapter.sendMessage("feedbot", "s-1", text, { inputId: String(id) });
    for (let i = 0; i < 255; i++)
      await expect(send("/lost", i)).rejects.toMatchObject({ reason: "Upstream" });
    for (let i = 255; i < 511; i++) await send("/ok", i);
    await send("/ok", 255);
    await expect(send("/lost", 511)).rejects.toMatchObject({ reason: "Upstream" });
    await expect(send("/new", 512)).rejects.toMatchObject({ reason: "Unavailable" });
    await expect(send("/lost", 0)).rejects.toMatchObject({ reason: "Conflict" });
    await send("/ok", 510);
    expect(conn.callsOf("slash.exec")).toHaveLength(512);
    adapter.dispose();
    await send("/ok", 510);
    expect(conn.callsOf("slash.exec")).toHaveLength(513);
  });

  it("evicts only finished runs when the result cache is full", async () => {
    const feedbotConn = makeFeedbotConn();
    let execs = 0;
    let finishSlow: (value: unknown) => void = () => undefined;
    feedbotConn.onMethod("slash.exec", (p) => {
      execs += 1;
      if (p.command === "/slow") return new Promise((resolve) => (finishSlow = resolve));
      if (p.command === "/lost") throw new HermesConnectionError("socket closed");
      return { output: `ran ${String(p.command)}` };
    });
    const { adapter } = makeAdapter({ feedbot: feedbotConn });
    const slow = adapter.sendMessage("feedbot", "s-1", "/slow", { inputId: "in-slow" });
    await expect(
      adapter.sendMessage("feedbot", "s-1", "/lost", { inputId: "in-lost" }),
    ).rejects.toMatchObject({ reason: "Unavailable" });
    for (let i = 0; i < 300; i += 1) {
      await adapter.sendMessage("feedbot", "s-1", `/n${i}`, { inputId: `in-${i}` });
    }
    const before = execs;
    const slowRetry = adapter.sendMessage("feedbot", "s-1", "/slow", { inputId: "in-slow" });
    await expect(
      adapter.sendMessage("feedbot", "s-1", "/lost", { inputId: "in-lost" }),
    ).rejects.toMatchObject({ reason: "Conflict" });
    finishSlow({ output: "slow done" });
    expect(await slow).toEqual({ kind: "output", sessionId: "s-1", output: "slow done" });
    expect(await slowRetry).toEqual({ kind: "output", sessionId: "s-1", output: "slow done" });
    expect(execs).toBe(before);
  });
});

describe("HermesPaAdapter answer claims", () => {
  const approval = (requestId: string, sessionId = "s-1") => ({
    request_id: requestId,
    method: "approval",
    session_id: sessionId,
    params: { command: "ls" },
  });

  it("releases the claim when sending fails, and after a reconnect snapshot", async () => {
    const feedbotConn = makeFeedbotConn();
    const resume = feedbotConn["handlers"].get("session.resume")!;
    feedbotConn.onMethod("session.resume", (p) => ({
      ...(resume(p) as object),
      open_requests: [{ id: "srq-1", method: "approval", params: { command: "ls" } }],
    }));
    const { adapter } = makeAdapter({ feedbot: feedbotConn });
    await adapter.subscribeSession("feedbot", "s-1", collect().subscriber, LIVE);
    const original = feedbotConn.respondServerRequest.bind(feedbotConn);
    let failSend = true;
    feedbotConn.respondServerRequest = (requestId, result) => {
      if (failSend) throw new HermesConnectionError("send failed");
      original(requestId, result);
    };
    await expect(
      adapter.requests.respond("feedbot", "s-1", { requestId: "srq-1", decision: "once" }),
    ).rejects.toMatchObject({ reason: "Unavailable" });
    failSend = false;

    // The card survives a reconnect: the new feed's snapshot still lists it, and it is answerable.
    await adapter.subscribeSession("feedbot", "s-1", collect().subscriber, LIVE);
    await adapter.requests.respond("feedbot", "s-1", { requestId: "srq-1", decision: "once" });
    expect(feedbotConn.serverResponses).toEqual([
      { requestId: "srq-1", result: { choice: "once" } },
    ]);
  });

  it("lets only one answer through across a session alias and its canonical id", async () => {
    const feedbotConn = makeFeedbotConn({ canonical: "s-tip" });
    const { adapter } = makeAdapter({ feedbot: feedbotConn });
    await adapter.subscribeSession("feedbot", "s-root", collect().subscriber, LIVE);
    await adapter.subscribeSession("feedbot", "s-tip", collect().subscriber, LIVE);
    feedbotConn.emitRequest(approval("srq-1", "s-tip"));
    const results = await Promise.allSettled([
      adapter.requests.respond("feedbot", "s-root", { requestId: "srq-1", decision: "once" }),
      adapter.requests.respond("feedbot", "s-tip", { requestId: "srq-1", decision: "deny" }),
    ]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected"]);
    expect(results[1]).toMatchObject({ reason: expect.objectContaining({ reason: "Conflict" }) });
    expect(feedbotConn.serverResponses).toEqual([
      { requestId: "srq-1", result: { choice: "once" } },
    ]);
    // Answered for every alias: the other viewer's later click finds nothing open.
    await expect(
      adapter.requests.respond("feedbot", "s-tip", { requestId: "srq-1", decision: "deny" }),
    ).rejects.toMatchObject({ reason: "NotFound" });
  });

  it("keeps the canonical answer claimed while an alias detaches and reattaches", async () => {
    const conn = makeFeedbotConn({ canonical: "s-tip" });
    const started = Promise.withResolvers<void>();
    const reply = Promise.withResolvers<{ status: string }>();
    conn.onMethod("approval.respond", () => {
      started.resolve();
      return conn.callsOf("approval.respond").length === 1 ? reply.promise : { status: "resolved" };
    });
    const resume = conn["handlers"].get("session.resume")!;
    conn.onMethod("session.resume", (p) => ({
      ...(resume(p) as object),
      prompts: [{ prompt_id: "apr", kind: "approval" }],
    }));
    const { adapter } = makeAdapter({ feedbot: conn });
    await adapter.subscribeSession("feedbot", "s-tip", collect().subscriber, LIVE);
    const detach = await adapter.subscribeSession("feedbot", "s-root", collect().subscriber, LIVE);
    const answer = { requestId: "apr", decision: "once" };
    const first = adapter.requests.respond("feedbot", "s-tip", answer);
    await started.promise;
    detach();
    conn.emitEvent({ event: "approval.settled", session_id: "s-tip", payload: { id: "apr" } });
    await adapter.subscribeSession("feedbot", "s-root", collect().subscriber, LIVE);
    await expect(adapter.requests.respond("feedbot", "s-root", answer)).rejects.toMatchObject({
      reason: "Conflict",
    });
    reply.resolve({ status: "resolved" });
    await first;
    expect(conn.callsOf("approval.respond")).toHaveLength(1);
  });

  it("answers a server request only on the socket and open card that supplied it", async () => {
    const conn = makeFeedbotConn();
    const replacement = makeFeedbotConn();
    const connections = { feedbot: conn };
    const { adapter } = makeAdapter(connections);
    await adapter.subscribeSession("feedbot", "s-1", collect().subscriber, LIVE);
    conn.emitRequest(approval("srq-1"));
    const answer = { requestId: "srq-1", decision: "once" };
    connections.feedbot = replacement;
    const respond = () => adapter.requests.respond("feedbot", "s-1", answer);
    await expect(respond()).rejects.toMatchObject({ reason: "Unavailable" });
    // A separate RPC attached the new socket without rebuilding the old feed's cards.
    await adapter.interruptSession("feedbot", "s-1");
    await expect(respond()).rejects.toMatchObject({ reason: "Unavailable" });
    expect(replacement.serverResponses).toEqual([]);
    const resume = replacement["handlers"].get("session.resume")!;
    replacement.onMethod("session.resume", (p) => ({
      ...(resume(p) as object),
      open_requests: [{ id: "srq-1", method: "approval" }],
    }));
    await adapter.subscribeSession("feedbot", "s-1", collect().subscriber, LIVE);
    conn.simulateClose();
    const cancelled = respond();
    replacement.emitEvent({ event: "request.cancel", session_id: "s-1", payload: { id: "srq-1" } });
    await expect(cancelled).rejects.toMatchObject({ reason: "Unavailable" });
    expect(replacement.serverResponses).toEqual([]);
    await adapter.subscribeSession("feedbot", "s-1", collect().subscriber, LIVE);
    await respond();
    expect(replacement.serverResponses).toEqual([
      { requestId: "srq-1", result: { choice: "once" } },
    ]);
  });

  it.each(["message.start", "message.complete", "error"])(
    "keeps a plugin choice answerable across %s and retires the turn prompt",
    async (event) => {
      const conn = makeFeedbotConn();
      const { adapter } = makeAdapter({ feedbot: conn });
      const feed = collect();
      await adapter.subscribeSession("feedbot", "s-1", feed.subscriber, LIVE);
      conn.emitRequest({ request_id: "srq-choice", method: "clarify", session_id: "s-1" });
      expect(feed.events.at(-1)).toMatchObject({
        type: "request.opened",
        request: { requestId: "srq-choice", scope: "session" },
      });
      conn.emitEvent({ event: "approval.request", payload: { prompt_id: "apr" } });
      conn.emitEvent({ event });
      await expect(
        adapter.requests.respond("feedbot", "s-1", { requestId: "apr" }),
      ).rejects.toMatchObject({ reason: "NotFound" });
      await adapter.requests.respond("feedbot", "s-1", {
        requestId: "srq-choice",
        answers: { q0: "first" },
      });
      expect(conn.serverResponses).toEqual([
        { requestId: "srq-choice", result: { answers: { q0: "first" } } },
      ]);
    },
  );

  it("reports a canonical prompt another viewer already answered as a conflict", async () => {
    const feedbotConn = makeFeedbotConn();
    feedbotConn.onMethod("approval.respond", (p) => ({
      status: "already_resolved",
      prompt_id: p.prompt_id,
    }));
    const { adapter } = makeAdapter({ feedbot: feedbotConn });
    await adapter.subscribeSession("feedbot", "s-1", collect().subscriber, LIVE);
    feedbotConn.emitEvent({
      event: "approval.request",
      session_id: "s-1",
      seq: 13,
      replay_epoch: "ep-A",
      payload: { prompt_id: "apr-1", command: "ls" },
    });
    await expect(
      adapter.requests.respond("feedbot", "s-1", { requestId: "apr-1", decision: "once" }),
    ).rejects.toMatchObject({ reason: "Conflict" });
    await expect(
      adapter.requests.respond("feedbot", "s-1", { requestId: "apr-1", decision: "once" }),
    ).rejects.toMatchObject({ reason: "NotFound" });
  });
});

describe("HermesPaAdapter bootstrap buffering", () => {
  it("keeps a prompt raised for the canonical id before resume names it", async () => {
    const feedbotConn = makeFeedbotConn({ canonical: "s-tip" });
    const resume = feedbotConn["handlers"].get("session.resume")!;
    feedbotConn.onMethod("session.resume", (p) => {
      feedbotConn.emitRequest({
        request_id: "srq-early",
        method: "approval",
        session_id: "s-tip",
        params: { command: "ls" },
      });
      feedbotConn.emitRequest({
        request_id: "srq-other",
        method: "approval",
        session_id: "s-other",
        params: { command: "ls" },
      });
      return resume(p);
    });
    const { adapter } = makeAdapter({ feedbot: feedbotConn });
    const feed = collect();
    await adapter.subscribeSession("feedbot", "s-root", feed.subscriber, LIVE);
    expect(
      feed.events.flatMap((e) => (e.type === "request.opened" ? [e.request.requestId] : [])),
    ).toEqual(["srq-early"]);
  });

  it("does not open a buffered prompt that a later buffered frame already cancelled", async () => {
    const feedbotConn = makeFeedbotConn();
    const resume = feedbotConn["handlers"].get("session.resume")!;
    feedbotConn.onMethod("session.resume", (p) => {
      feedbotConn.emitRequest({
        request_id: "srq-gone",
        method: "approval",
        session_id: "s-1",
        params: { command: "ls" },
      });
      // Already covered by the snapshot watermark (12), yet it still settles the buffered prompt.
      feedbotConn.emitEvent({
        event: "request.cancel",
        session_id: "s-1",
        seq: 11,
        replay_epoch: "ep-A",
        payload: { request_id: "srq-gone" },
      });
      return resume(p);
    });
    const { adapter } = makeAdapter({ feedbot: feedbotConn });
    const feed = collect();
    await adapter.subscribeSession("feedbot", "s-1", feed.subscriber, LIVE);
    expect(feed.events.some((e) => e.type === "request.opened")).toBe(false);
    await expect(
      adapter.requests.respond("feedbot", "s-1", { requestId: "srq-gone", decision: "once" }),
    ).rejects.toMatchObject({ reason: "NotFound" });
  });

  it("keeps the snapshot's new prompt when the replay ends the previous turn", async () => {
    const feedbotConn = makeFeedbotConn();
    const { adapter } = makeAdapter({ feedbot: feedbotConn });
    (await adapter.subscribeSession("feedbot", "s-1", collect().subscriber, LIVE))();

    feedbotConn.onMethod("session.events.since", () => ({
      replay_epoch: "ep-A",
      events: [{ type: "message.complete", session_id: "s-1", seq: 13, payload: { text: "Old" } }],
    }));
    const resume = feedbotConn["handlers"].get("session.resume")!;
    feedbotConn.onMethod("session.resume", (p) => ({
      ...(resume(p) as object),
      last_sequence: 13,
      open_requests: [{ id: "srq-new", method: "approval", params: { command: "ls" } }],
    }));
    const resumed = collect();
    await adapter.subscribeSession("feedbot", "s-1", resumed.subscriber, { resume: true });
    expect(resumed.events.map((e) => e.type)).toEqual(["turn.completed", "snapshot"]);
    expect(resumed.events.at(-1)).toMatchObject({
      running: true,
      openRequests: [expect.objectContaining({ requestId: "srq-new", scope: "session" })],
    });
    await adapter.requests.respond("feedbot", "s-1", { requestId: "srq-new", decision: "once" });
    expect(feedbotConn.serverResponses).toEqual([
      { requestId: "srq-new", result: { choice: "once" } },
    ]);
  });
  it("delivers catch-up before the authoritative snapshot, then drains live and reentrant frames", async () => {
    const conn = makeFeedbotConn();
    const { adapter } = makeAdapter({ feedbot: conn });
    (await adapter.subscribeSession("feedbot", "s-1", collect().subscriber, LIVE))();
    conn.onMethod("session.events.since", () => ({
      replay_epoch: "ep-A",
      events: [{ type: "message.delta", seq: 13, payload: { text: "old" } }],
    }));
    conn.onMethod("session.resume", () => {
      conn.emitEvent({ event: "message.complete", seq: 14, execution_generation: 4 });
      conn.emitEvent({ event: "notice", seq: 15, payload: { text: "live" }, replay_epoch: "ep-A" });
      return {
        last_sequence: 14,
        replay_epoch: "ep-A",
        running: true,
        subscription_id: "sub",
        execution_generation: 7,
        prompts: [{ prompt_id: "new", kind: "clarify" }],
      };
    });
    const feed = collect();
    await adapter.subscribeSession(
      "feedbot",
      "s-1",
      {
        ...feed.subscriber,
        onEvent(event) {
          feed.subscriber.onEvent(event);
          if (event.type === "snapshot")
            conn.emitEvent({ event: "notice", seq: 16, payload: { text: "during snapshot" } });
        },
      },
      { resume: true },
    );
    expect(feed.events.map((e) => (e.type === "notice" ? e.message : e.type))).toEqual([
      "text.delta",
      "turn.completed",
      "snapshot",
      "live",
      "during snapshot",
    ]);
    expect(feed.events[2]).toMatchObject({
      snapshotRequired: false,
      openRequests: [expect.objectContaining({ requestId: "new" })],
    });
    await adapter.requests.respond("feedbot", "s-1", { requestId: "new" });
    expect(conn.callsOf("clarify.respond")[0]?.params.execution_generation).toBe(7);
  });

  it("reloads and resets the mapper and watermark when catch-up silently omits frames", async () => {
    const conn = makeFeedbotConn();
    const { adapter } = makeAdapter({ feedbot: conn });
    const detach = await adapter.subscribeSession("feedbot", "s-1", collect().subscriber, LIVE);
    conn.emitEvent({ event: "message.delta", seq: 13, payload: { offset: 0, text: "old text" } });
    detach();
    conn.onMethod("session.events.since", () => ({ replay_epoch: "ep-A", events: [] }));
    conn.onMethod("session.resume", () => ({
      last_sequence: 18,
      replay_epoch: "ep-A",
      running: true,
      subscription_id: "sub",
    }));
    const resumed = collect();
    const release = await adapter.subscribeSession("feedbot", "s-1", resumed.subscriber, {
      resume: true,
    });
    expect(resumed.events).toEqual([
      expect.objectContaining({ type: "snapshot", snapshotRequired: true }),
    ]);
    conn.emitEvent({ event: "notice", seq: 18, payload: { text: "old" } });
    conn.emitEvent({ event: "message.delta", seq: 19, payload: { offset: 0, text: "new" } });
    expect(resumed.events.slice(1)).toEqual([
      expect.objectContaining({ type: "text.delta", text: "new" }),
    ]);
    release();
    await adapter.subscribeSession("feedbot", "s-1", collect().subscriber, { resume: true });
    expect(conn.callsOf("session.events.since").at(-1)?.params.last_sequence).toBe(19);
  });
});
