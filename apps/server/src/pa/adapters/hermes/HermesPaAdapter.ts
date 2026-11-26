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
  HermesConnectionError,
  HermesConnectionPool,
  HermesRpcError,
  isValidHermesProfile,
  type HermesRpcConnection,
  type HermesRpcEventFrame,
  type HermesServerRequestFrame,
} from "./HermesGatewayClient.ts";
import { invalid, isPaError, withPaErrors } from "./HermesErrors.ts";
import {
  acceptHermesSeq,
  HermesEventMapper,
  hermesResolvedRequestIds,
  type HermesSeqCursor,
} from "./HermesEventMapper.ts";
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
  readonly profile: string;
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
  readonly requests: Map<string, FeedRequest>;
  /** Kept across a same-epoch resume so a segment streamed before the drop keeps its id. */
  mapper: HermesEventMapper | null;
}

type FeedRequest = HermesTrackedRequest & { readonly connection?: HermesRpcConnection };

interface HermesSubmitReceipt {
  readonly admission_id?: string;
  readonly submission_id?: string;
  /** `AdmissionStatus.status`: a retried input whose turn already ended answers `terminal`. */
  readonly status?: string;
  /** `CanonicalVoiceStopped`: a stop phrase ended voice chat and nothing was admitted. */
  readonly voice_stopped?: boolean;
}

/** What `slash.exec` resolved a command to; a rewritten prompt is still submitted per attempt. */
type SlashOutcome =
  | { readonly kind: "output"; readonly output: string }
  | { readonly kind: "prompt"; readonly message: string; readonly notice: string | undefined };

interface SlashRun {
  readonly text: string;
  /** `unknown`: the request may have reached Hermes, so the command must not run again. */
  status: "pending" | "settled" | "unknown";
  readonly outcome: Promise<SlashOutcome>;
}

type BufferedFeedItem =
  | { readonly kind: "event"; readonly frame: HermesRpcEventFrame }
  | { readonly kind: "request"; readonly frame: HermesServerRequestFrame };

/** Results of recent slash commands by input id: Hermes has no input-id dedupe for `slash.exec`. */
const SLASH_RESULT_CACHE_SIZE = 256;
/** Above Hermes's 30s quick-command limit, so a slow command is not reported as lost. */
const SLASH_EXEC_TIMEOUT_MS = 40_000;

const SLASH_REFUSALS = new Set([
  "unsupported_command",
  "invalid_params",
  "not_found",
  "forbidden",
  "permission_denied",
  "profile_mismatch",
]);
function isSlashRefusal(error: unknown): boolean {
  if (isPaError(error)) return error.reason === "Unsupported";
  return (
    error instanceof HermesRpcError &&
    error.code !== 5001 &&
    (error.code === -32601 || error.code === -32602 || SLASH_REFUSALS.has(error.message))
  );
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
  private readonly slashRuns = new Map<string, SlashRun>();
  private readonly settledSlashRuns = new Map<string, SlashRun>();
  /** Answers in flight by `profile::requestId`: Hermes request ids are unique per gateway. */
  private readonly answering = new Map<string, symbol>();
  private versionCache: string | null = null;
  private versionProbe: Promise<void> | null = null;

  constructor(options?: { readonly instanceId?: string; readonly pool?: HermesConnectionPool }) {
    this.instanceId = options?.instanceId ?? "hermes";
    this.pool = options?.pool ?? new HermesConnectionPool();
  }

  dispose = (): void => {
    this.answering.clear();
    this.slashRuns.clear();
    this.settledSlashRuns.clear();
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
        profile,
        executionGeneration: 0,
        replayEpoch: null,
        subscriptionId: null,
        attachedConn: null,
        canonicalSessionId: null,
        subscribers: 0,
        cursor: { epoch: undefined, lastSeq: 0 },
        requests: new Map(),
        mapper: null,
      };
      this.sessionStates.set(key, state);
    }
    return state;
  }

  /** An answered prompt is gone for every alias of its session on this profile. */
  private forgetRequest(profile: string, requestId: string): void {
    for (const state of this.sessionStates.values()) {
      if (state.profile === profile) state.requests.delete(requestId);
    }
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
      // Hermes canonical `prompt.submit` strictly requires `input_id` or `submission_id`.
      const clientInputId = options.inputId?.trim();
      const inputId = clientInputId || NodeCrypto.randomUUID();
      if (!trimmed.startsWith("/")) {
        return this.submitPrompt(profile, sessionId, trimmed, inputId, undefined);
      }
      const outcome = await this.runSlash(profile, sessionId, trimmed, clientInputId);
      if (outcome.kind === "output") {
        return { kind: "output", sessionId, output: outcome.output };
      }
      // The same input id each attempt: `prompt.submit` dedupes it and reports a finished turn.
      return this.submitPrompt(profile, sessionId, outcome.message, inputId, outcome.notice);
    });

  /** A retry after a lost response must not run a command (or a plugin) a second time. */
  private async runSlash(
    profile: string,
    sessionId: string,
    trimmed: string,
    clientInputId: string | undefined,
  ): Promise<SlashOutcome> {
    const keyFor = (canonicalId: string) => JSON.stringify([profile, canonicalId, clientInputId]);
    const cached = (key: string) => {
      const existing = this.slashRuns.get(key) ?? this.settledSlashRuns.get(key);
      if (!existing) return undefined;
      if (existing.text !== trimmed) {
        throw new PaError({
          reason: "Conflict",
          message: "This input id was already used for a different message",
        });
      }
      if (existing.status === "unknown") {
        throw new PaError({
          reason: "Conflict",
          message:
            "The earlier attempt of this command may already have run; check the conversation before sending it again",
        });
      }
      return existing.outcome;
    };
    if (clientInputId) {
      const known = this.sessionStates.get(this.sessionKey(profile, sessionId));
      const previous = cached(keyFor(known?.canonicalSessionId ?? sessionId));
      if (previous) return previous;
    }
    const conn = await this.pool.getConnection(profile);
    const state = await this.ensureSessionAttached(profile, conn, sessionId);
    const canonicalId = state.canonicalSessionId ?? sessionId;
    if (!clientInputId) return this.execSlash(conn, canonicalId, trimmed);
    // Concurrent aliases can discover the same canonical id while awaiting resume.
    const key = keyFor(canonicalId);
    const previous = cached(key);
    if (previous) return previous;
    if (this.slashRuns.size >= SLASH_RESULT_CACHE_SIZE) {
      throw new PaError({
        reason: "Unavailable",
        message: "Too many commands have pending or uncertain outcomes",
      });
    }
    const outcome = this.execSlash(conn, canonicalId, trimmed);
    const run: SlashRun = { text: trimmed, status: "pending", outcome };
    this.slashRuns.set(key, run);
    try {
      const result = await outcome;
      if (this.slashRuns.get(key) === run) {
        this.slashRuns.delete(key);
        run.status = "settled";
        this.settledSlashRuns.set(key, run);
        if (this.settledSlashRuns.size > SLASH_RESULT_CACHE_SIZE) {
          this.settledSlashRuns.delete(this.settledSlashRuns.keys().next().value!);
        }
      }
      return result;
    } catch (err) {
      if (this.slashRuns.get(key) === run) {
        if (isSlashRefusal(err)) this.slashRuns.delete(key);
        else run.status = "unknown";
      }
      throw err;
    }
  }

  private async execSlash(
    conn: HermesRpcConnection,
    sessionId: string,
    trimmed: string,
  ): Promise<SlashOutcome> {
    const execRes = await conn
      .call<{
        output?: string | null;
        warning?: string | null;
        type?: string | null;
        message?: string | null;
        notice?: string | null;
        display?: string | null;
      }>(
        "slash.exec",
        { session_id: sessionId, command: trimmed, profile: conn.profile },
        SLASH_EXEC_TIMEOUT_MS,
      )
      .catch((err: unknown) => {
        // `slash.exec` refuses client-local commands (session switches, terminal-only tools).
        if (
          err instanceof HermesRpcError &&
          err.code !== 5001 &&
          err.message === "unsupported_command"
        ) {
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

    if (
      (execRes.type === "send" || execRes.type === "skill") &&
      typeof execRes.message === "string" &&
      execRes.message.trim().length > 0
    ) {
      return {
        kind: "prompt",
        message: execRes.message,
        notice: execRes.notice ?? execRes.display ?? undefined,
      };
    }
    const output = [execRes.output, execRes.warning, execRes.notice, execRes.display]
      .filter((part): part is string => typeof part === "string" && part.trim().length > 0)
      .join("\n\n");
    return { kind: "output", output: output || "Command executed." };
  }

  private async submitPrompt(
    profile: string,
    sessionId: string,
    prompt: string,
    inputId: string,
    notice: string | undefined,
  ): Promise<PaSendResult> {
    const conn = await this.pool.getConnection(profile);
    const state = await this.ensureSessionAttached(profile, conn, sessionId);
    const res = await conn.call<HermesSubmitReceipt>("prompt.submit", {
      session_id: state.canonicalSessionId ?? sessionId,
      text: prompt,
      input_id: inputId,
    });
    if (res.voice_stopped === true) {
      return { kind: "output", sessionId, output: "Voice chat stopped. Nothing was sent." };
    }
    return {
      kind: "turn",
      sessionId,
      submissionId: res.admission_id ?? res.submission_id ?? inputId,
      ...(res.status === "terminal" ? { settled: true } : {}),
      ...(notice ? { notice } : {}),
    };
  }

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
        // Claimed before the first await: two viewers (or two aliases of one session) answering
        // at once must not both succeed. Released however the answer ends.
        const claimKey = `${profile}::${input.requestId}`;
        if (this.answering.has(claimKey)) {
          throw new PaError({
            reason: "Conflict",
            message: "This request is already being answered",
          });
        }
        const claim = Symbol(claimKey);
        this.answering.set(claimKey, claim);
        try {
          const outcome = await this.answerRequest(
            profile,
            sessionId,
            state,
            tracked,
            input,
            decision,
          );
          this.forgetRequest(profile, input.requestId);
          if (outcome === "already_resolved") {
            throw new PaError({
              reason: "Conflict",
              message: "This request was already answered elsewhere",
            });
          }
        } finally {
          if (this.answering.get(claimKey) === claim) this.answering.delete(claimKey);
        }
      }),
  };

  private async answerRequest(
    profile: string,
    sessionId: string,
    state: TrackedSessionState,
    tracked: FeedRequest,
    input: {
      readonly requestId: string;
      readonly answers?: Readonly<Record<string, string | ReadonlyArray<string>>>;
    },
    decision: string,
  ): Promise<"resolved" | "already_resolved"> {
    const { request } = tracked;
    const conn = await this.pool.getConnection(profile);
    const questions = request.questions ?? [];
    if (tracked.channel === "server_request") {
      if (
        state.requests.get(input.requestId) !== tracked ||
        state.attachedConn !== conn ||
        tracked.connection !== conn ||
        !conn.isOpen()
      ) {
        throw new PaError({
          reason: "Unavailable",
          message: "The request changed or its feed disconnected. Wait for the session to refresh.",
        });
      }
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
      return "resolved";
    }
    const base = {
      session_id: state.canonicalSessionId ?? sessionId,
      execution_generation: tracked.executionGeneration ?? state.executionGeneration,
      prompt_id: input.requestId,
    };
    const first = questions[0]?.id;
    // `session_pending_controls.respond`: the losing viewer of a race gets `already_resolved`.
    const res =
      request.kind === "approval"
        ? await conn.call<{ status?: string }>("approval.respond", { ...base, choice: decision })
        : await conn.call<{ status?: string }>("clarify.respond", {
            ...base,
            answer: encodeClarifyAnswer(first !== undefined ? input.answers?.[first] : undefined),
          });
    return res?.status === "already_resolved" ? "already_resolved" : "resolved";
  }

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
    const makeMapper = () =>
      new HermesEventMapper(sessionId, {
        currentGeneration: () => state.executionGeneration,
        onGeneration: (generation) => {
          state.executionGeneration = generation;
        },
        onRequestOpened: (tracked) => state.requests.set(tracked.request.requestId, tracked),
        onRequestResolved: (requestId) => {
          state.requests.delete(requestId);
        },
        onTurnBoundary: () => {
          for (const [id, tracked] of state.requests) {
            if (tracked.channel === "canonical") state.requests.delete(id);
          }
        },
      });
    let mapper: HermesEventMapper | null = null;

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
        state.mapper = null;
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
      for (const event of mapper!.map(frame)) emit(event);
    };

    const deliverRequest = (req: HermesServerRequestFrame) => {
      // Session ids repeat across the profile socket: only surface this session's requests. Checked
      // on delivery, so one buffered before `session.resume` names the canonical id is kept.
      if (closed || !req.session_id || !ownsSession(req.session_id)) return;
      const tracked = normalizePendingRequest(
        req.request_id,
        req.method,
        req.params,
        "server_request",
        state.executionGeneration,
      );
      if (!tracked || state.requests.has(tracked.request.requestId)) return;
      state.requests.set(tracked.request.requestId, { ...tracked, connection: conn });
      emit({ type: "request.opened", sessionId, request: tracked.request });
    };

    // Live frames and prompts wait while replay and resume complete so nothing arrives out of
    // order, and a prompt raised mid-handshake is not wiped by the snapshot that replaces requests.
    let bootstrapping = true;
    const buffered: BufferedFeedItem[] = [];
    const unsubEvent = conn.onEvent((frame) => {
      if (bootstrapping) buffered.push({ kind: "event", frame });
      else deliver(frame);
    });
    const unsubRequest = conn.onServerRequest((req: HermesServerRequestFrame) => {
      if (closed) return;
      if (bootstrapping) buffered.push({ kind: "request", frame: req });
      else deliverRequest(req);
    });
    const unsubClose = conn.onClose(() => {
      if (state.attachedConn === conn) {
        state.subscriptionId = null;
        state.attachedConn = null;
        state.requests.clear();
      }
      // While bootstrapping the open itself fails; only an established feed reports a close.
      if (bootstrapping) release();
      else closeFeed("Hermes gateway connection closed");
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
      if (!subId || state.attachedConn !== conn) return;
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
    const throwIfClosed = () => {
      if (!closed) return;
      release();
      throw new HermesConnectionError("Hermes gateway connection closed");
    };

    // A cursor from an earlier feed can replay even from seq 0: a session that was empty when
    // the feed dropped must still get the turn that ran while it was away.
    const sinceSeq = resume ? state.cursor.lastSeq : 0;
    const canReplay = resume && state.cursor.epoch !== undefined;
    let snapshot: HermesResumeSnapshot;
    let replayFrames: HermesRpcEventFrame[] = [];
    let replayEpoch: string | undefined;
    let snapshotRequired = false;
    try {
      // Hermes's reconnect contract: `session.events.since` BEFORE `session.resume`. The resume
      // then writes whatever was published in between ahead of its reply (SessionEvents.catch_up).
      if (canReplay) {
        const targetEpoch = state.cursor.epoch;
        const replay = await conn
          .call<HermesReplayResult>("session.events.since", {
            session_id: state.canonicalSessionId ?? sessionId,
            last_sequence: sinceSeq,
            replay_epoch: targetEpoch,
          })
          .catch(() => null);
        throwIfClosed();
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
      throwIfClosed();
    } catch (err) {
      // No fake idle snapshot: the caller reports the failure and retries.
      release();
      throw err;
    }
    this.applyResumeSnapshot(state, conn, snapshot);
    if (canReplay && !snapshotRequired && replayEpoch && replayEpoch !== state.replayEpoch) {
      // The epoch rolled over between `events.since` and `resume`; reload instead of mixing.
      snapshotRequired = true;
      replayFrames = [];
    }
    const replaying = canReplay && !snapshotRequired;
    if (resume && !replaying && (snapshot.last_sequence ?? 0) > sinceSeq) {
      // Events were published that this feed cannot replay: the client must reload.
      snapshotRequired = true;
    }

    // A replay starts from our own cursor so every replayed frame (seq > sinceSeq) is accepted;
    // otherwise the snapshot's watermark is the baseline for live frames.
    state.cursor.epoch = state.replayEpoch ?? undefined;
    state.cursor.lastSeq = replaying ? sinceSeq : (snapshot.last_sequence ?? 0);
    // Only a gapless same-epoch resume continues the previous feed's turn and segment ids.
    mapper = replaying && state.mapper !== null ? state.mapper : makeMapper();
    state.mapper = mapper;
    const items = buffered.splice(0);
    // A prompt settled or cancelled later in the same backlog never reaches the viewer.
    const settledLater = new Set<string>();
    const skip = new Set<BufferedFeedItem>();
    for (let i = items.length - 1; i >= 0; i -= 1) {
      const item = items[i]!;
      if (!ownsSession(item.frame.session_id)) continue;
      if (item.kind === "event") {
        for (const id of hermesResolvedRequestIds(item.frame) ?? []) settledLater.add(id);
      } else if (settledLater.has(item.frame.request_id)) {
        skip.add(item);
      }
    }
    const preSnapshot: HermesRpcEventFrame[] = [];
    const postSnapshot: BufferedFeedItem[] = [];
    for (const item of items) {
      if (skip.has(item)) continue;
      if (
        replaying &&
        item.kind === "event" &&
        item.frame.event !== "session.replay_gap" &&
        typeof snapshot.last_sequence === "number" &&
        typeof item.frame.seq === "number" &&
        item.frame.seq <= snapshot.last_sequence &&
        (item.frame.replay_epoch === undefined || item.frame.replay_epoch === state.replayEpoch)
      ) {
        preSnapshot.push(item.frame);
      } else {
        postSnapshot.push(item);
      }
    }

    // Replayed frames all predate the snapshot, so they go first: an old turn's completion must
    // not end the turn, or clear the prompts, that the snapshot reports as current.
    for (const frame of replayFrames) deliver(frame);
    for (const frame of preSnapshot) deliver(frame);
    // Hermes silently omits catch_up when its ring truncated before resume.
    if (
      replaying &&
      typeof snapshot.last_sequence === "number" &&
      state.cursor.lastSeq < snapshot.last_sequence
    ) {
      snapshotRequired = true;
      state.cursor.lastSeq = snapshot.last_sequence;
      mapper = makeMapper();
      state.mapper = mapper;
    }
    if (typeof snapshot.execution_generation === "number") {
      state.executionGeneration = snapshot.execution_generation;
    }

    // The snapshot is authoritative: prompts settled while detached cannot linger and be answered.
    const authoritative = new Map<string, FeedRequest>();
    for (const entry of snapshot.open_requests ?? []) {
      const tracked = normalizePendingRequest(
        entry.id ?? entry.request_id ?? "",
        entry.method,
        entry.params,
        "server_request",
        state.executionGeneration,
      );
      if (tracked) authoritative.set(tracked.request.requestId, { ...tracked, connection: conn });
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
      if (tracked && !authoritative.has(tracked.request.requestId)) {
        authoritative.set(tracked.request.requestId, tracked);
      }
    }
    state.requests.clear();
    for (const [requestId, tracked] of authoritative) state.requests.set(requestId, tracked);

    emit({
      type: "snapshot",
      sessionId,
      running: snapshot.running === true,
      openRequests: openRequests(),
      snapshotRequired,
    });
    bootstrapping = false;
    for (const item of [...postSnapshot, ...buffered.splice(0)]) {
      if (item.kind === "event") deliver(item.frame);
      else deliverRequest(item.frame);
    }
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
        const provider = input.provider.trim();
        // `profiles.configure` silently skips a model pin without its provider.
        if (!provider) throw invalid("Choose a provider for this model");
        const res = await this.configure(profile, {
          model: input.model,
          provider,
          ...(input.confirm ? { confirm_expensive_model: true } : {}),
        });
        if (res.confirm_required) {
          return {
            status: "confirmRequired" as const,
            message: res.confirm_message ?? "Confirm before switching to this model.",
          };
        }
        if (res.applied?.model !== true) {
          throw new PaError({
            reason: "Upstream",
            message: res.error || "Hermes did not save the model change",
          });
        }
        return {
          status: "applied" as const,
          current: { provider, model: input.model },
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
      applied?: Record<string, unknown>;
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
