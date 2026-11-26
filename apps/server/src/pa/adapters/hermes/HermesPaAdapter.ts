// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeUtil from "node:util";

import {
  PaError,
  type PaBotConfig,
  type PaCapabilities,
  type PaConfigSectionValue,
  type PaSchedule,
  type PaSendResult,
} from "@t3tools/contracts";

import type {
  PaAdapterEvent,
  PaAdapterSession,
  PaEngineInstance,
  PaSessionSubscriber,
} from "../../types.ts";
import {
  HermesConnectionPool,
  HermesRpcError,
  isValidHermesProfile,
  type HermesRpcConnection,
  type HermesRpcEventFrame,
  type HermesServerRequestFrame,
} from "./HermesGatewayClient.ts";
import { invalid, withPaErrors } from "./HermesErrors.ts";
import { acceptHermesSeq, HermesEventMapper, type HermesSeqCursor } from "./HermesEventMapper.ts";
import {
  HERMES_SECTION,
  hermesRequiredScope,
  mergeSessionRows,
  normalizeCronJobs,
  normalizeModelCatalog,
  normalizePendingRequest,
  normalizeProfileConfig,
  normalizeProfileRow,
  normalizeSlashCatalog,
  normalizeTranscriptRows,
  type HermesModelOptionsResult,
  type HermesProfileDescription,
  type HermesProfileRow,
  type HermesSessionRow,
  type HermesTrackedRequest,
  type HermesTranscriptRow,
} from "./HermesNormalizers.ts";

function nowMs(): number {
  // @effect-diagnostics globalDate:off
  return Date.now();
}

const execFileAsync = NodeUtil.promisify(NodeChildProcess.execFile);
const VALID_SESSION_ID_PATTERN = /^[^\s\p{Cc}]{1,200}$/u;

interface HermesResumeSnapshot {
  readonly session_id?: string;
  readonly running?: boolean;
  readonly last_sequence?: number;
  readonly replay_epoch?: string;
  readonly execution_generation?: number;
  readonly subscription_id?: string;
  readonly prompts?: ReadonlyArray<
    Record<string, unknown> & {
      readonly prompt_id?: string;
      readonly id?: string;
      readonly kind?: string;
      readonly execution_generation?: number;
      readonly payload?: Record<string, unknown>;
      readonly params?: Record<string, unknown>;
    }
  >;
  readonly open_requests?: ReadonlyArray<{
    readonly id?: string;
    readonly request_id?: string;
    readonly method: string;
    readonly params?: Record<string, unknown>;
  }>;
}

interface HermesReplayResult {
  readonly replay_epoch?: string;
  readonly snapshot_required?: boolean;
  readonly truncated?: boolean;
  readonly events?: ReadonlyArray<{
    readonly type: string;
    readonly session_id?: string;
    readonly seq?: number;
    readonly replay_epoch?: string;
    readonly execution_generation?: number;
    readonly payload?: Record<string, unknown>;
  }>;
}

interface TrackedSessionState {
  executionGeneration: number;
  replayEpoch: string | null;
  subscriptionId: string | null;
  /** The connection `subscriptionId` belongs to; a reconnected socket must resume again. */
  attachedConn: HermesRpcConnection | null;
  /** `session.resume` may redirect to a canonical id (a compression tip, a lineage root). */
  canonicalSessionId: string | null;
  subscribers: number;
  /** Where the last feed for this session stopped, so a resumed feed replays only the gap. */
  readonly cursor: HermesSeqCursor;
  /** Open prompts this adapter has shown; `respond` only answers these. */
  readonly requests: Map<string, HermesTrackedRequest>;
}

const HERMES_CAPABILITIES: PaCapabilities = {
  sessions: { create: true, rename: true },
  execution: { interrupt: true, approvals: true, clarify: true },
  models: { supported: true, scope: "agent", allowCustom: true },
  commands: { supported: true },
  config: { supported: true },
  schedules: { supported: true },
  lifecycle: { create: true, delete: false },
};

function assertSession(profile: string, sessionId: string): void {
  if (
    !isValidHermesProfile(profile) ||
    !VALID_SESSION_ID_PATTERN.test(sessionId) ||
    sessionId.includes("..")
  ) {
    throw invalid("Invalid profile or session id");
  }
}

function assertProfile(profile: string): void {
  if (!isValidHermesProfile(profile)) throw invalid(`Invalid profile "${profile}"`);
}

function encodeClarifyAnswer(value: string | ReadonlyArray<string> | undefined): string {
  if (value === undefined) return "";
  // Hermes `clarify_tool.py._clean_answer` parses a multi-select JSON label array verbatim.
  return typeof value === "string" ? value : JSON.stringify(value);
}

export class HermesPaAdapter implements PaEngineInstance {
  readonly instanceId: string;
  readonly driver = "hermes";
  readonly label = "Hermes";
  readonly capabilities = HERMES_CAPABILITIES;

  private readonly pool: HermesConnectionPool;
  private readonly sessionStates = new Map<string, TrackedSessionState>();
  private versionCache: string | null = null;
  private versionProbe: Promise<void> | null = null;

  constructor(options?: { readonly instanceId?: string; readonly pool?: HermesConnectionPool }) {
    this.instanceId = options?.instanceId ?? "hermes";
    this.pool = options?.pool ?? new HermesConnectionPool();
  }

  dispose = (): void => {
    this.sessionStates.clear();
    this.pool.closeAll();
  };

  isValidAgentRef = (agentRef: string): boolean => isValidHermesProfile(agentRef);

  version = (): string | null => {
    this.versionProbe ??= execFileAsync("hermes", ["--version"], { timeout: 4_000 }).then(
      ({ stdout }) => {
        this.versionCache = stdout.trim().split("\n")[0]?.trim() || null;
      },
      () => undefined,
    );
    return this.versionCache;
  };

  private sessionKey(profile: string, sessionId: string): string {
    return `${profile}::${sessionId}`;
  }

  private getOrCreateSessionState(profile: string, sessionId: string): TrackedSessionState {
    const key = this.sessionKey(profile, sessionId);
    let state = this.sessionStates.get(key);
    if (!state) {
      state = {
        executionGeneration: 0,
        replayEpoch: null,
        subscriptionId: null,
        attachedConn: null,
        canonicalSessionId: null,
        subscribers: 0,
        cursor: { epoch: undefined, lastSeq: 0 },
        requests: new Map(),
      };
      this.sessionStates.set(key, state);
    }
    return state;
  }

  listAgents = () =>
    withPaErrors(async () => {
      const defaultConn = await this.pool.getConnection("default");
      const listRes = await defaultConn.call<{ profiles?: ReadonlyArray<HermesProfileRow> }>(
        "profiles.list",
        { include_sessions: true },
      );
      // One `profiles.describe` over the already-open default socket, and only for a profile
      // whose row omits its model: no per-profile attach on every roster refresh.
      return Promise.all(
        (listRes.profiles ?? []).map(async (row) => {
          const agent = normalizeProfileRow(row);
          if (agent.model) return agent;
          const described = await defaultConn
            .call<HermesProfileDescription>("profiles.describe", { name: row.name })
            .catch(() => null);
          return {
            ...agent,
            model: described?.model?.default || null,
            provider: described?.model?.provider || agent.provider,
          };
        }),
      );
    });

  listSessions = (profile: string) =>
    withPaErrors(async () => {
      assertProfile(profile);
      const conn = await this.pool.getConnection(profile);
      // `stored` omits sessions that are live right now; `live` omits closed ones. Ask both.
      const listScope = (scope: "live" | "stored") =>
        conn.call<{ sessions?: ReadonlyArray<HermesSessionRow> }>("session.list", {
          scope,
          limit: 30,
          picker: true,
        });
      const [liveRes, storedRes] = await Promise.allSettled([
        listScope("live"),
        listScope("stored"),
      ]);
      if (liveRes.status === "rejected" && storedRes.status === "rejected") {
        throw storedRes.reason;
      }
      return mergeSessionRows(
        liveRes.status === "fulfilled" ? (liveRes.value.sessions ?? []) : [],
        storedRes.status === "fulfilled" ? (storedRes.value.sessions ?? []) : [],
      );
    });

  createSession = (profile: string, options: { readonly title?: string | undefined }) =>
    withPaErrors(async (): Promise<PaAdapterSession> => {
      assertProfile(profile);
      const conn = await this.pool.getConnection(profile);
      const created = await conn.call<{
        session_id: string;
        execution_generation?: number;
        replay_epoch?: string;
        subscription_id?: string;
      }>("session.create", { source: "gui", follow_profile_config: true });
      const sessionId = created.session_id;
      const state = this.getOrCreateSessionState(profile, sessionId);
      if (typeof created.execution_generation === "number") {
        state.executionGeneration = created.execution_generation;
      }
      if (typeof created.replay_epoch === "string") state.replayEpoch = created.replay_epoch;
      if (typeof created.subscription_id === "string") {
        state.subscriptionId = created.subscription_id;
        state.attachedConn = conn;
      }
      const requestedTitle = options.title?.trim();
      // The session exists either way; a title Hermes refuses leaves the default one.
      const titled = requestedTitle
        ? await conn
            .call("slash.exec", {
              session_id: sessionId,
              command: `/title ${requestedTitle}`,
              profile,
            })
            .then(
              () => true,
              () => false,
            )
        : false;
      return {
        sessionId,
        title: titled && requestedTitle ? requestedTitle : "New conversation",
        source: "gui",
        model: null,
        messageCount: 0,
        running: false,
        startedAt: nowMs(),
        lastActivityAt: nowMs(),
      };
    });

  getMessages = (profile: string, sessionId: string, limit: number) =>
    withPaErrors(async () => {
      assertSession(profile, sessionId);
      const conn = await this.pool.getConnection(profile);
      try {
        const res = await conn.call<{ rows?: ReadonlyArray<HermesTranscriptRow> }>(
          "session.transcript",
          { session_id: sessionId, limit, order: "latest" },
        );
        return normalizeTranscriptRows(res.rows ?? []);
      } catch (err) {
        // A brand-new session has no stored transcript yet.
        if (err instanceof Error && /not_found/i.test(err.message)) return [];
        throw err;
      }
    });

  private applyResumeSnapshot(
    state: TrackedSessionState,
    conn: HermesRpcConnection,
    snap: HermesResumeSnapshot,
  ): void {
    if (typeof snap.session_id === "string" && snap.session_id) {
      state.canonicalSessionId = snap.session_id;
    }
    if (typeof snap.execution_generation === "number") {
      state.executionGeneration = snap.execution_generation;
    }
    if (typeof snap.replay_epoch === "string") state.replayEpoch = snap.replay_epoch;
    if (typeof snap.subscription_id === "string") {
      state.subscriptionId = snap.subscription_id;
      state.attachedConn = conn;
    }
  }

  /** `refresh` re-reads the execution generation even when attached (interrupt needs it current). */
  private async ensureSessionAttached(
    profile: string,
    conn: HermesRpcConnection,
    sessionId: string,
    options?: { readonly refresh?: boolean },
  ): Promise<TrackedSessionState> {
    const state = this.getOrCreateSessionState(profile, sessionId);
    if (state.subscriptionId !== null && state.attachedConn === conn && !options?.refresh) {
      return state;
    }
    const snap = await conn.call<HermesResumeSnapshot>("session.resume", {
      session_id: state.canonicalSessionId ?? sessionId,
      omit_messages: true,
      defer_history: true,
    });
    this.applyResumeSnapshot(state, conn, snap);
    return state;
  }

  sendMessage = (
    profile: string,
    sessionId: string,
    text: string,
    options: { readonly inputId?: string | undefined },
  ) =>
    withPaErrors(async (): Promise<PaSendResult> => {
      assertSession(profile, sessionId);
      const trimmed = text.trim();
      if (!trimmed) throw invalid("Message cannot be empty");
      const conn = await this.pool.getConnection(profile);
      const state = await this.ensureSessionAttached(profile, conn, sessionId);
      const hermesSessionId = state.canonicalSessionId ?? sessionId;
      // Hermes canonical `prompt.submit` strictly requires `input_id` or `submission_id`.
      const inputId = options.inputId?.trim() || NodeCrypto.randomUUID();
      const submit = async (prompt: string) => {
        const res = await conn.call<{ admission_id?: string; submission_id?: string }>(
          "prompt.submit",
          { session_id: hermesSessionId, text: prompt, input_id: inputId },
        );
        return res.admission_id ?? res.submission_id ?? inputId;
      };

      if (!trimmed.startsWith("/")) {
        return { kind: "turn", sessionId, submissionId: await submit(trimmed) };
      }

      const execRes = await conn
        .call<{
          output?: string | null;
          warning?: string | null;
          type?: string | null;
          message?: string | null;
          notice?: string | null;
          display?: string | null;
        }>("slash.exec", { session_id: hermesSessionId, command: trimmed, profile })
        .catch((err: unknown) => {
          // `slash.exec` refuses client-local commands (session switches, terminal-only tools).
          if (err instanceof HermesRpcError && /\bunsupported_command\b/.test(err.message)) {
            const name = trimmed.split(/\s+/, 1)[0]!;
            throw new PaError({
              reason: "Unsupported",
              message: [`${name} is not available in a web chat session.`, err.detail]
                .filter(Boolean)
                .join(" "),
            });
          }
          throw err;
        });

      const notice = execRes.notice ?? execRes.display ?? undefined;
      if (
        (execRes.type === "send" || execRes.type === "skill") &&
        typeof execRes.message === "string" &&
        execRes.message.trim().length > 0
      ) {
        return {
          kind: "turn",
          sessionId,
          submissionId: await submit(execRes.message),
          ...(notice ? { notice } : {}),
        };
      }
      const output = [execRes.output, execRes.warning, execRes.notice, execRes.display]
        .filter((part): part is string => typeof part === "string" && part.trim().length > 0)
        .join("\n\n");
      return { kind: "output", sessionId, output: output || "Command executed." };
    });

  interruptSession = (profile: string, sessionId: string) =>
    withPaErrors(async () => {
      assertSession(profile, sessionId);
      const conn = await this.pool.getConnection(profile);
      // The tracked generation goes stale while nothing reads events; a stale one is a no-op.
      const state = await this.ensureSessionAttached(profile, conn, sessionId, { refresh: true });
      await conn.call("session.interrupt", {
        session_id: state.canonicalSessionId ?? sessionId,
        execution_generation: state.executionGeneration,
      });
    });

  readonly requests = {
    respond: (
      profile: string,
      sessionId: string,
      input: {
        readonly requestId: string;
        readonly decision?: string;
        readonly answers?: Readonly<Record<string, string | ReadonlyArray<string>>>;
      },
    ) =>
      withPaErrors(async () => {
        assertSession(profile, sessionId);
        const state = this.sessionStates.get(this.sessionKey(profile, sessionId));
        const tracked = state?.requests.get(input.requestId);
        // The profile socket is shared by every session: never answer a request it did not open.
        if (!state || !tracked) {
          throw new PaError({
            reason: "NotFound",
            message: "This request is no longer open for this session",
          });
        }
        const { request } = tracked;
        const decision = input.decision ?? "deny";
        if (
          request.kind === "approval" &&
          request.options !== undefined &&
          !request.options.some((option) => option.id === decision)
        ) {
          throw invalid(`"${decision}" is not one of this request's choices`);
        }
        const conn = await this.pool.getConnection(profile);
        const questions = request.questions ?? [];

        if (tracked.channel === "server_request") {
          if (request.kind === "approval") {
            conn.respondServerRequest(input.requestId, { choice: decision });
          } else {
            const locked = tracked.lockedAnswers ?? {};
            const answers: Record<string, string> = {};
            for (const question of questions) {
              const provided = encodeClarifyAnswer(input.answers?.[question.id]);
              // Omit untouched questions another viewer already locked: `clarify_batch.py`
              // overlays the submitted map onto the locked one, so "" would wipe their answer.
              if (provided !== "" || !(question.id in locked)) answers[question.id] = provided;
            }
            conn.respondServerRequest(input.requestId, { answers });
          }
        } else {
          const base = {
            session_id: state.canonicalSessionId ?? sessionId,
            execution_generation: tracked.executionGeneration ?? state.executionGeneration,
            prompt_id: input.requestId,
          };
          if (request.kind === "approval") {
            await conn.call("approval.respond", { ...base, choice: decision });
          } else {
            const first = questions[0]?.id;
            await conn.call("clarify.respond", {
              ...base,
              answer: encodeClarifyAnswer(first !== undefined ? input.answers?.[first] : undefined),
            });
          }
        }
        state.requests.delete(input.requestId);
      }),
  };

  subscribeSession = (
    profile: string,
    sessionId: string,
    subscriber: PaSessionSubscriber,
    options: { readonly resume: boolean },
  ) =>
    withPaErrors(async () => {
      assertSession(profile, sessionId);
      const conn = await this.pool.getConnection(profile);
      return this.openFeed(profile, sessionId, conn, subscriber, options.resume);
    });

  private async openFeed(
    profile: string,
    sessionId: string,
    conn: HermesRpcConnection,
    subscriber: PaSessionSubscriber,
    resume: boolean,
  ): Promise<() => void> {
    const state = this.getOrCreateSessionState(profile, sessionId);
    state.subscribers += 1;
    const ownsSession = (id: string | undefined) =>
      id === undefined || id === sessionId || id === state.canonicalSessionId;
    const openRequests = () => Array.from(state.requests.values(), (tracked) => tracked.request);
    const mapper = new HermesEventMapper(sessionId, {
      currentGeneration: () => state.executionGeneration,
      onGeneration: (generation) => {
        state.executionGeneration = generation;
      },
      onRequestOpened: (tracked) => state.requests.set(tracked.request.requestId, tracked),
      onRequestResolved: (requestId) => state.requests.delete(requestId),
    });

    let closed = false;
    let release = () => {};
    const closeFeed = (reason?: string) => {
      if (closed) return;
      release();
      subscriber.onClose(reason);
    };
    const emit = (event: PaAdapterEvent) => {
      if (!closed) subscriber.onEvent(event);
    };

    const deliver = (frame: HermesRpcEventFrame) => {
      if (closed || !ownsSession(frame.session_id)) return;
      if (typeof frame.replay_epoch === "string") state.replayEpoch = frame.replay_epoch;
      if (frame.event === "session.replay_gap") {
        // Hermes retired this socket's subscription after its send buffer overflowed: nothing
        // more arrives on it. Ask for a reload and end the feed so the next one attaches fresh.
        state.subscriptionId = null;
        state.attachedConn = null;
        state.cursor.epoch = undefined;
        state.cursor.lastSeq = 0;
        emit({
          type: "snapshot",
          sessionId,
          running: true,
          openRequests: openRequests(),
          snapshotRequired: true,
        });
        closeFeed();
        return;
      }
      if (!acceptHermesSeq(state.cursor, frame.seq, frame.replay_epoch)) return;
      for (const event of mapper.map(frame)) emit(event);
    };

    // Live frames wait while replay and resume complete so nothing arrives out of order.
    let bootstrapping = true;
    const bufferedLive: HermesRpcEventFrame[] = [];
    const unsubEvent = conn.onEvent((frame) => {
      if (bootstrapping) bufferedLive.push(frame);
      else deliver(frame);
    });
    const unsubRequest = conn.onServerRequest((req: HermesServerRequestFrame) => {
      // Session ids repeat across the profile socket: only surface this session's requests.
      if (closed || !req.session_id || !ownsSession(req.session_id)) return;
      const tracked = normalizePendingRequest(
        req.request_id,
        req.method,
        req.params,
        "server_request",
        state.executionGeneration,
      );
      if (!tracked) return;
      state.requests.set(tracked.request.requestId, tracked);
      emit({ type: "request.opened", sessionId, request: tracked.request });
    });
    const unsubClose = conn.onClose(() => {
      state.subscriptionId = null;
      state.attachedConn = null;
      state.requests.clear();
      closeFeed("Hermes gateway connection closed");
    });

    release = () => {
      if (closed) return;
      closed = true;
      unsubEvent();
      unsubRequest();
      unsubClose();
      state.subscribers = Math.max(0, state.subscribers - 1);
      if (state.subscribers > 0) return;
      state.requests.clear();
      const subId = state.subscriptionId;
      if (!subId) return;
      state.subscriptionId = null;
      state.attachedConn = null;
      // A redirected session and its canonical id share one Hermes subscription_id on this
      // socket: detach only once no active feed holds it.
      const stillShared = Array.from(this.sessionStates.values()).some(
        (other) =>
          other.attachedConn === conn && other.subscriptionId === subId && other.subscribers > 0,
      );
      if (!stillShared && conn.isOpen()) {
        void conn
          .call(
            "session.detach",
            { session_id: state.canonicalSessionId ?? sessionId, subscription_id: subId },
            4_000,
          )
          .catch(() => undefined);
      }
    };

    const sinceSeq = resume ? state.cursor.lastSeq : 0;
    let snapshot: HermesResumeSnapshot;
    let replayFrames: HermesRpcEventFrame[] = [];
    let replayEpoch: string | undefined;
    let snapshotRequired = false;
    try {
      // Hermes's reconnect contract: `session.events.since` BEFORE `session.resume`. The resume
      // then writes whatever was published in between ahead of its reply (SessionEvents.catch_up).
      if (sinceSeq > 0) {
        const targetEpoch = state.cursor.epoch ?? state.replayEpoch ?? undefined;
        const replay = targetEpoch
          ? await conn
              .call<HermesReplayResult>("session.events.since", {
                session_id: state.canonicalSessionId ?? sessionId,
                last_sequence: sinceSeq,
                replay_epoch: targetEpoch,
              })
              .catch(() => null)
          : null;
        if (!replay || replay.snapshot_required || replay.truncated) {
          snapshotRequired = true;
        } else {
          replayEpoch = replay.replay_epoch ?? targetEpoch;
          replayFrames = (replay.events ?? []).map((ev) => ({
            event: ev.type,
            session_id: ev.session_id,
            seq: ev.seq,
            replay_epoch: ev.replay_epoch ?? replayEpoch,
            execution_generation: ev.execution_generation,
            payload: ev.payload,
          }));
        }
      }
      snapshot = await conn.call<HermesResumeSnapshot>("session.resume", {
        session_id: state.canonicalSessionId ?? sessionId,
        omit_messages: true,
        defer_history: true,
      });
    } catch (err) {
      // No fake idle snapshot: the caller reports the failure and retries.
      release();
      throw err;
    }
    this.applyResumeSnapshot(state, conn, snapshot);
    if (sinceSeq > 0 && !snapshotRequired && replayEpoch && replayEpoch !== state.replayEpoch) {
      // The epoch rolled over between `events.since` and `resume`; reload instead of mixing.
      snapshotRequired = true;
      replayFrames = [];
    }

    // The snapshot is authoritative: prompts settled while detached cannot linger and be answered.
    state.requests.clear();
    for (const entry of snapshot.open_requests ?? []) {
      const tracked = normalizePendingRequest(
        entry.id ?? entry.request_id ?? "",
        entry.method,
        entry.params,
        "server_request",
        state.executionGeneration,
      );
      if (tracked) state.requests.set(tracked.request.requestId, tracked);
    }
    for (const prompt of snapshot.prompts ?? []) {
      const tracked = normalizePendingRequest(
        prompt.prompt_id ?? prompt.id ?? "",
        prompt.kind === "clarify" ? "clarify" : "approval",
        prompt.payload ?? prompt.params ?? prompt,
        "canonical",
        typeof prompt.execution_generation === "number"
          ? prompt.execution_generation
          : state.executionGeneration,
      );
      if (tracked && !state.requests.has(tracked.request.requestId)) {
        state.requests.set(tracked.request.requestId, tracked);
      }
    }

    // A replay starts from our own cursor so every replayed frame (seq > sinceSeq) is accepted;
    // otherwise the snapshot's watermark is the baseline for live frames.
    const replaying = sinceSeq > 0 && !snapshotRequired;
    state.cursor.epoch = state.replayEpoch ?? undefined;
    state.cursor.lastSeq = replaying ? sinceSeq : (snapshot.last_sequence ?? 0);
    emit({
      type: "snapshot",
      sessionId,
      running: snapshot.running === true,
      openRequests: openRequests(),
      snapshotRequired,
    });
    for (const frame of replayFrames) deliver(frame);
    bootstrapping = false;
    for (const frame of bufferedLive.splice(0)) deliver(frame);
    return release;
  }

  readonly models = {
    getCatalog: (profile: string) =>
      withPaErrors(async () => {
        assertProfile(profile);
        const [defaultConn, profileConn] = await Promise.all([
          this.pool.getConnection("default"),
          this.pool.getConnection(profile),
        ]);
        // `model.options` must run on the profile's own socket to avoid `profile_mismatch`.
        const [description, options] = await Promise.all([
          defaultConn.call<HermesProfileDescription>("profiles.describe", { name: profile }),
          profileConn
            .call<HermesModelOptionsResult>("model.options", { explicit_only: true })
            .catch((): HermesModelOptionsResult => ({ providers: [] })),
        ]);
        return normalizeModelCatalog(options, description);
      }),
    select: (
      profile: string,
      input: { readonly provider: string; readonly model: string; readonly confirm: boolean },
    ) =>
      withPaErrors(async () => {
        assertProfile(profile);
        const res = await this.configure(profile, {
          model: input.model,
          ...(input.provider ? { provider: input.provider } : {}),
          ...(input.confirm ? { confirm_expensive_model: true } : {}),
        });
        if (res.confirm_required) {
          return {
            status: "confirmRequired" as const,
            message: res.confirm_message ?? "Confirm before switching to this model.",
          };
        }
        return {
          status: "applied" as const,
          current: { provider: input.provider || null, model: input.model },
        };
      }),
  };

  private async configure(profile: string, params: Record<string, unknown>) {
    const defaultConn = await this.pool.getConnection("default");
    const res = await defaultConn.call<{
      ok?: boolean;
      confirm_required?: boolean | null;
      confirm_message?: string | null;
      error?: string | null;
    }>("profiles.configure", { name: profile, ...params });
    if (!res.confirm_required && res.ok === false) {
      throw new PaError({
        reason: "Upstream",
        message: res.error || "Hermes rejected the profile configuration",
      });
    }
    return res;
  }

  readonly commands = {
    list: (profile: string) =>
      withPaErrors(async () => {
        assertProfile(profile);
        const conn = await this.pool.getConnection(profile);
        const raw = await conn.call<Record<string, unknown>>("commands.catalog", { profile });
        return normalizeSlashCatalog(raw);
      }),
    requiredScope: hermesRequiredScope,
  };

  readonly config = {
    get: (profile: string) => withPaErrors(() => this.readConfig(profile)),
    patch: (profile: string, sectionId: string, value: PaConfigSectionValue) =>
      withPaErrors(async () => {
        const current = await this.readConfig(profile);
        const section = current.sections.find((entry) => entry.id === sectionId);
        if (!section) throw invalid(`Unknown config section "${sectionId}"`);
        if (section.kind !== value.kind) {
          throw invalid(`Section "${sectionId}" takes a ${section.kind} value`);
        }
        await this.configure(profile, configureParams(section, value));
        return this.readConfig(profile);
      }),
  };

  private async readConfig(profile: string): Promise<PaBotConfig> {
    assertProfile(profile);
    const [defaultConn, profileConn] = await Promise.all([
      this.pool.getConnection("default"),
      this.pool.getConnection(profile),
    ]);
    // A profile-bound gateway ticket answers `profile_mismatch` for another profile's skills.
    const [description, catalog] = await Promise.all([
      defaultConn.call<HermesProfileDescription>("profiles.describe", { name: profile }),
      profileConn
        .call<{ skills?: Record<string, ReadonlyArray<string>> }>("skills.manage", {
          action: "list",
          profile,
        })
        .catch(() => ({ skills: {} })),
    ]);
    return normalizeProfileConfig(description, catalog.skills ?? {});
  }

  readonly schedules = {
    list: (profile: string) =>
      withPaErrors(async () => {
        assertProfile(profile);
        const conn = await this.pool.getConnection(profile);
        return this.listCron(conn, profile);
      }),
    mutate: (
      profile: string,
      input: {
        readonly action: "add" | "remove" | "pause" | "resume";
        readonly scheduleId?: string;
        readonly name?: string;
        readonly schedule?: string;
        readonly prompt?: string;
        readonly deliver?: string;
      },
    ) =>
      withPaErrors(async (): Promise<ReadonlyArray<PaSchedule>> => {
        assertProfile(profile);
        const conn = await this.pool.getConnection(profile);
        const target = input.scheduleId ?? input.name;
        const res = await conn.call<Record<string, unknown>>("cron.manage", {
          action: input.action,
          profile,
          ...(target !== undefined ? { name: target } : {}),
          ...(input.schedule !== undefined ? { schedule: input.schedule } : {}),
          ...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
          ...(input.deliver !== undefined ? { deliver: input.deliver } : {}),
        });
        if (res.success === false || typeof res.error === "string") {
          throw new PaError({
            reason: "Invalid",
            message: typeof res.error === "string" ? res.error : "Schedule change failed",
          });
        }
        return this.listCron(conn, profile);
      }),
  };

  private async listCron(conn: HermesRpcConnection, profile: string) {
    const res = await conn.call<Record<string, unknown>>("cron.manage", {
      action: "list",
      profile,
      include_disabled: true,
    });
    return normalizeCronJobs(res);
  }

  readonly lifecycle = {
    create: (input: {
      readonly agentRef: string;
      readonly description?: string;
      readonly instructions?: string;
    }) =>
      withPaErrors(async () => {
        const profile = input.agentRef
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9_-]+/g, "-")
          .replace(/^[-_]+|[-_]+$/g, "");
        if (!isValidHermesProfile(profile)) {
          throw invalid("Profile id must start with a letter or digit and use only [a-z0-9_-]");
        }
        const defaultConn = await this.pool.getConnection("default");
        await defaultConn.call("profiles.create", {
          name: profile,
          description: input.description ?? "",
          soul: input.instructions || undefined,
          mirror_credentials: true,
        });
        return { agentRef: profile };
      }),
  };
}

function configureParams(
  section: PaBotConfig["sections"][number],
  value: PaConfigSectionValue,
): Record<string, unknown> {
  switch (value.kind) {
    case "document":
      if (section.id !== HERMES_SECTION.persona) break;
      return { soul: value.text };
    case "options": {
      if (section.id !== HERMES_SECTION.profile) break;
      const description = value.values.description;
      if (typeof description !== "string") throw invalid("Description must be text");
      return { description };
    }
    case "toggleList": {
      if (section.kind !== "toggleList") break;
      const known = new Set(section.items.map((item) => item.id));
      const enabled = value.enabled.filter((id) => known.has(id));
      if (section.minEnabled !== undefined && enabled.length < section.minEnabled) {
        throw invalid(`Keep at least ${section.minEnabled} of "${section.label}" enabled`);
      }
      if (section.id === HERMES_SECTION.skills) {
        const on = new Set(enabled);
        return {
          disabled_skills: section.items.filter((item) => !on.has(item.id)).map((i) => i.id),
        };
      }
      if (section.id === HERMES_SECTION.toolsets) return { enabled_toolsets: enabled };
      if (section.id === HERMES_SECTION.mcpServers) return { enabled_mcp_servers: enabled };
      break;
    }
  }
  throw invalid(`Section "${section.id}" cannot be edited`);
}
