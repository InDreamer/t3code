// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeOS from "node:os";
// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import {
  makePaBotId,
  PaError,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  type PaBotConfig,
  type PaCapabilities,
  type PaConfigSectionValue,
  type PaPendingRequest,
  type PaManageQueuedItemInput,
  type PaSchedule,
  type PaSendResult,
  type PaSteerSessionResult,
} from "@t3tools/contracts";

import type { PaStore } from "../../PaStore.ts";
import { isPaInputRefusal } from "../../types.ts";
import type {
  PaAdapterEvent,
  PaAdapterSession,
  PaEngineInstance,
  PaMessagePage,
  PaSendOptions,
  PaLocalAttachment,
  PaStagedAttachment,
  PaSessionPage,
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
import { invalid, isPaError, toPaError, withPaErrors } from "./HermesErrors.ts";
import { paAttachmentName } from "../../PaAttachmentStore.ts";
import { inferImageExtension } from "../../../imageMime.ts";
import {
  acceptHermesSeq,
  HermesEventMapper,
  hermesResolvedRequestIds,
  type HermesSeqCursor,
} from "./HermesEventMapper.ts";
import {
  HERMES_SECRET_FIELD,
  HERMES_SECTION,
  hermesAttachmentKey,
  hermesRequiredScope,
  mergeSessionRows,
  normalizeCronJobs,
  normalizeHermesQueue,
  normalizeHermesReasoningEffort,
  normalizeHermesTodoState,
  normalizeHermesUsage,
  normalizeModelCatalog,
  normalizePendingRequest,
  normalizeProfileConfig,
  normalizeProfileRow,
  normalizeSlashCatalog,
  normalizeTranscriptRows,
  sessionRowMatches,
  type HermesModelOptionsResult,
  type HermesPendingAdmission,
  type HermesProfileDescription,
  type HermesProfileRow,
  type HermesReasoningConfigResult,
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
  /** The session's metadata fence; `session.mutate` names it as `expected_revision`. */
  readonly revision?: number;
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
  /** Admissions not yet settled: the running one, the queue behind it, lost (`unknown`) ones. */
  readonly pending?: ReadonlyArray<HermesPendingAdmission>;
  readonly info?: { readonly usage?: unknown } & Record<string, unknown>;
  /** `TodoState`, or null when the session has no plan. */
  readonly todo_state?: unknown;
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
    readonly admission_id?: string;
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
  /** The last metadata revision Hermes reported; a rename is fenced on it. */
  revision: number | null;
  subscribers: number;
  /** Where the last feed for this session stopped, so a resumed feed replays only the gap. */
  readonly cursor: HermesSeqCursor;
  /** Open prompts this adapter has shown; `respond` only answers these. */
  readonly requests: Map<string, FeedRequest>;
  /** Kept across a same-epoch resume so a segment streamed before the drop keeps its id. */
  mapper: HermesEventMapper | null;
  /** Each pending admission's own generation, from the last resume: `resolve_unknown` is fenced on it. */
  queued: ReturnType<typeof normalizeHermesQueue>;
  admissionGenerations: Map<string, number>;
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

/** `CanonicalCorrectionAck` (or `CanonicalVoiceStopped`) from `session.steer`. */
interface HermesCorrectionAck {
  readonly status?: "queued" | "redirected" | "rejected";
  /** Only `false`, and only on a `rejected` no agent ever saw: safe to admit as a prompt. */
  readonly delivered?: boolean;
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

/** A rename's Hermes fences, so a retry with the same request id replays the committed receipt. */
interface RenameAttempt {
  readonly title: string;
  expectedRevision: number;
}

/** Hermes's `session.list` page cap. */
const SESSION_LIST_MAX = 200;
const RENAME_ATTEMPT_CACHE_SIZE = 256;

/** Results of recent slash commands by input id: Hermes has no input-id dedupe for `slash.exec`. */
const SLASH_RESULT_CACHE_SIZE = 256;
const STAGED_INPUT_TTL_MS = 30 * 60_000;
const MAX_STAGED_INPUTS = 256;
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

/** Older gateways lack the method or key; anything else is a real failure worth surfacing. */
function isUnsupportedRpc(error: unknown, method: "model.options" | "config.get"): boolean {
  return (
    error instanceof HermesRpcError &&
    (error.code === -32601 ||
      error.message === "method_not_found" ||
      (method === "config.get" &&
        (error.message === "unknown_key" || error.message === "not_found")))
  );
}

const HERMES_CAPABILITIES: PaCapabilities = {
  attachments: {
    images: true,
    files: true,
    maxImages: 10,
    maxFileBytes: PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  },
  sessions: { create: true, rename: true },
  execution: {
    interrupt: true,
    approvals: true,
    clarify: true,
    secrets: true,
    queue: true,
    steer: true,
  },
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

type HermesRequestAnswer = {
  readonly requestId: string;
  readonly decision?: string | undefined;
  readonly answers?: Readonly<Record<string, string | ReadonlyArray<string>>> | undefined;
  readonly values?: Readonly<Record<string, string>> | undefined;
  readonly skip?: boolean | undefined;
};

/**
 * A credential prompt's `ValueResult.value`; `""` declines. Never echoes a value into an error:
 * a refusal names only the field.
 */
function encodeSecretAnswer(
  method: string,
  request: PaPendingRequest,
  input: HermesRequestAnswer,
): string {
  if (input.skip === true) return "";
  const fields = request.fields ?? [];
  const read = (id: string) => input.values?.[id] ?? "";
  for (const field of fields) {
    if (field.required === true && read(field.id).length === 0) {
      throw invalid(`Enter ${field.label}, or skip this request`);
    }
  }
  if (method === "vault.save_login") {
    // `session_vault_prompt.py::save_login` parses this JSON into the vault store.
    return JSON.stringify({
      identifier: read(HERMES_SECRET_FIELD.identifier),
      password: read(HERMES_SECRET_FIELD.password),
    });
  }
  const field = fields[0];
  if (!field) throw invalid("This request has nothing to answer");
  return read(field.id);
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

  private readonly store: PaStore | undefined;
  private readonly pool: HermesConnectionPool;
  private readonly sessionStates = new Map<string, TrackedSessionState>();
  private readonly slashRuns = new Map<string, SlashRun>();
  private readonly stagedInputs = new Map<
    string,
    {
      ids: string;
      touched: number;
      parts: PaStagedAttachment[];
      staging?: Promise<void>;
    }
  >();
  private readonly settledSlashRuns = new Map<string, SlashRun>();
  /** Answers in flight by `profile::requestId`: Hermes request ids are unique per gateway. */
  private readonly answering = new Map<string, symbol>();
  /** A rename receipt belongs to its selected row, including a compressed segment. */
  private readonly renameAttempts = new Map<string, RenameAttempt>();
  private versionCache: string | null = null;
  private versionProbe: Promise<void> | null = null;

  constructor(options?: {
    readonly instanceId?: string;
    readonly pool?: HermesConnectionPool;
    readonly store?: PaStore;
  }) {
    this.instanceId = options?.instanceId ?? "hermes";
    this.store = options?.store;
    this.pool = options?.pool ?? new HermesConnectionPool();
  }

  dispose = (): void => {
    this.answering.clear();
    this.renameAttempts.clear();
    this.slashRuns.clear();
    this.stagedInputs.clear();
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
        revision: null,
        subscribers: 0,
        cursor: { epoch: undefined, lastSeq: 0 },
        requests: new Map(),
        mapper: null,
        queued: [],
        admissionGenerations: new Map(),
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

  listSessions = (
    profile: string,
    options: {
      readonly query?: string | undefined;
      readonly cursor?: string | undefined;
      readonly limit: number;
    },
  ) =>
    withPaErrors(async (): Promise<PaSessionPage> => {
      assertProfile(profile);
      const conn = await this.pool.getConnection(profile);
      const limit = Math.max(1, Math.min(SESSION_LIST_MAX, Math.trunc(options.limit)));
      const query = options.query?.trim() || undefined;
      type ListResult = {
        readonly sessions?: ReadonlyArray<HermesSessionRow>;
        readonly next_cursor?: string | null;
      };
      // Only the stored scope pages and searches; `query` and `cursor` are refused on `live`.
      const overflow = /^pa-live:(\d+)$/.exec(options.cursor ?? "");
      const offset = overflow ? Number(overflow[1]) : 0;
      const listStored = () =>
        conn.call<ListResult>("session.list", {
          scope: "stored",
          limit,
          picker: true,
          ...(query ? { query } : {}),
          ...(options.cursor && !overflow ? { cursor: options.cursor } : {}),
        });
      if (options.cursor && !overflow) {
        const stored = await listStored();
        return {
          sessions: mergeSessionRows([], stored.sessions ?? []),
          nextCursor: stored.next_cursor ?? null,
        };
      }
      // `stored` omits sessions that are live right now; `live` omits closed ones. Ask both.
      const [liveRes, storedRes] = await Promise.allSettled([
        conn.call<ListResult>("session.list", {
          scope: "live",
          limit: SESSION_LIST_MAX,
          picker: true,
        }),
        listStored(),
      ]);
      if (liveRes.status === "rejected" && storedRes.status === "rejected") {
        throw storedRes.reason;
      }
      const liveRows = liveRes.status === "fulfilled" ? (liveRes.value.sessions ?? []) : [];
      const merged = mergeSessionRows(
        query ? liveRows.filter((row) => sessionRowMatches(row, query)) : liveRows,
        storedRes.status === "fulfilled" ? (storedRes.value.sessions ?? []) : [],
      );
      return {
        sessions: merged.slice(offset, offset + limit),
        nextCursor:
          offset + limit < merged.length
            ? "pa-live:" + (offset + limit)
            : storedRes.status === "fulfilled"
              ? (storedRes.value.next_cursor ?? null)
              : null,
      };
    });

  createSession = (
    profile: string,
    options: { readonly title?: string | undefined; readonly requestId?: string | undefined },
  ) =>
    withPaErrors(async (): Promise<PaAdapterSession> => {
      assertProfile(profile);
      const conn = await this.pool.getConnection(profile);
      // Never `title`: Hermes resolves a titled create to an existing session of that title.
      const created = await conn.call<{
        session_id: string;
        revision?: number;
        execution_generation?: number;
        replay_epoch?: string;
        subscription_id?: string;
      }>("session.create", {
        source: "gui",
        follow_profile_config: true,
        // Hermes derives the session from this id, so a retried create returns the same one.
        ...(options.requestId ? { request_id: options.requestId } : {}),
      });
      const sessionId = created.session_id;
      const state = this.getOrCreateSessionState(profile, sessionId);
      if (typeof created.execution_generation === "number") {
        state.executionGeneration = created.execution_generation;
      }
      if (typeof created.revision === "number") state.revision = created.revision;
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

  getMessages = (
    profile: string,
    sessionId: string,
    options: { readonly limit: number; readonly cursor?: string | undefined },
  ) =>
    withPaErrors(async (): Promise<PaMessagePage> => {
      assertSession(profile, sessionId);
      const conn = await this.pool.getConnection(profile);
      try {
        const res = await conn.call<{
          rows?: ReadonlyArray<HermesTranscriptRow>;
          next_cursor?: string | null;
          reset?: boolean;
        }>("session.transcript", {
          session_id: sessionId,
          inline_images: false,
          limit: options.limit,
          order: "latest",
          ...(options.cursor ? { cursor: options.cursor } : {}),
        });
        return {
          messages: normalizeTranscriptRows(res.rows ?? [], res.reset ? undefined : options.cursor),
          nextCursor: res.next_cursor ?? null,
          // A read without a cursor always starts from the newest page; only a stale cursor resets.
          reset: options.cursor !== undefined && res.reset === true,
        };
      } catch (err) {
        // A brand-new session has no stored transcript yet.
        if (err instanceof Error && /not_found/i.test(err.message)) {
          return { messages: [], nextCursor: null, reset: false };
        }
        throw err;
      }
    });

  renameSession = (
    profile: string,
    sessionId: string,
    input: { readonly title: string; readonly requestId: string },
  ) =>
    withPaErrors(async () => {
      assertSession(profile, sessionId);
      const title = input.title.trim();
      if (!title) throw invalid("A title cannot be empty");
      const attemptKey = `${profile}::${sessionId}::${input.requestId}`;
      const botId = makePaBotId(this.instanceId, profile);
      const previous =
        this.renameAttempts.get(attemptKey) ??
        this.store
          ?.getBotMeta(botId)
          .renameAttempts?.find(
            (item) => item.sessionId === sessionId && item.requestId === input.requestId,
          );

      if (previous && previous.title !== title) {
        throw new PaError({
          reason: "Conflict",
          message: "This request id was already used for a different title",
        });
      }
      const conn = await this.pool.getConnection(profile);
      // A cold row's revision is unknown. Hermes returns the target row's current fence on
      // revision_conflict, including for compressed segments whose resume redirects to the owner.
      const state = this.sessionStates.get(this.sessionKey(profile, sessionId));
      const known =
        previous?.expectedRevision ??
        (state?.canonicalSessionId === sessionId ? state.revision : null) ??
        0;
      // Hermes fingerprints `expected_revision` with the request id: a retry must reuse the
      // revision its first attempt sent, or a committed rename answers `admission_conflict`.
      const attempt: RenameAttempt = { title, expectedRevision: known };
      if (!previous && known !== 0)
        this.store?.rememberRename(botId, { sessionId, requestId: input.requestId, ...attempt });
      this.renameAttempts.delete(attemptKey);
      this.renameAttempts.set(attemptKey, attempt);
      if (this.renameAttempts.size > RENAME_ATTEMPT_CACHE_SIZE) {
        this.renameAttempts.delete(this.renameAttempts.keys().next().value!);
      }
      const mutate = () =>
        conn.call<{ revision?: number | null; title?: string | null }>("session.mutate", {
          session_id: sessionId,
          request_id: input.requestId,
          expected_revision: attempt.expectedRevision,
          operation: "rename",
          payload: { title },
        });
      let res: Awaited<ReturnType<typeof mutate>>;
      try {
        res = await mutate();
      } catch (err) {
        if (!(err instanceof HermesRpcError) || err.message !== "revision_conflict") throw err;
        // Nothing committed under this request ID. The refusal carries the target row’s revision.
        const fresh = err.revision;
        if (fresh === undefined || fresh === attempt.expectedRevision) throw err;
        this.store?.rememberRename(botId, {
          sessionId,
          requestId: input.requestId,
          title,
          expectedRevision: fresh,
        });
        attempt.expectedRevision = fresh;
        res = await mutate();
      }
      if (state?.canonicalSessionId === sessionId && typeof res.revision === "number")
        state.revision = res.revision;
      return { title: typeof res.title === "string" && res.title.trim() ? res.title : title };
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
    if (typeof snap.revision === "number") state.revision = snap.revision;
    if (typeof snap.replay_epoch === "string") state.replayEpoch = snap.replay_epoch;
    if (typeof snap.subscription_id === "string") {
      state.subscriptionId = snap.subscription_id;
      state.attachedConn = conn;
    }
    if (Array.isArray(snap.pending)) {
      state.queued = normalizeHermesQueue(snap.pending);
      state.admissionGenerations.clear();
      for (const row of snap.pending) {
        if (typeof row.admission_id === "string" && typeof row.execution_generation === "number") {
          state.admissionGenerations.set(row.admission_id, row.execution_generation);
        }
      }
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

  attachmentSessionId = (profile: string, sessionId: string, readOnly: boolean) =>
    withPaErrors(async () => {
      assertSession(profile, sessionId);
      if (readOnly) {
        const known = this.sessionStates.get(
          this.sessionKey(profile, sessionId),
        )?.canonicalSessionId;
        if (known) return known;
        // Transcript replies echo the requested id. Resolve a cold segment on a short-lived
        // viewer so closing the history read never detaches another feed on the profile socket.
        const lookup = await this.pool.openConnection(profile);
        try {
          const snapshot = await lookup.call<HermesResumeSnapshot>("session.resume", {
            session_id: sessionId,
            omit_messages: true,
            defer_history: true,
          });
          const state = this.getOrCreateSessionState(profile, sessionId);
          state.canonicalSessionId ??= snapshot.session_id ?? sessionId;
          return state.canonicalSessionId;
        } finally {
          lookup.close();
        }
      }
      const conn = await this.pool.getConnection(profile);
      const state = await this.ensureSessionAttached(profile, conn, sessionId);
      return state.canonicalSessionId ?? sessionId;
    });

  sendMessage = (profile: string, sessionId: string, text: string, options: PaSendOptions) =>
    withPaErrors(async (): Promise<PaSendResult> => {
      assertSession(profile, sessionId);
      const trimmed = text.trim();
      if (!trimmed && !options.attachments?.length) throw invalid("Message cannot be empty");
      // Hermes canonical `prompt.submit` strictly requires `input_id` or `submission_id`.
      const clientInputId = options.inputId?.trim();
      const inputId = clientInputId || NodeCrypto.randomUUID();
      const queued = options.queued === true;
      const known = this.sessionStates.get(this.sessionKey(profile, sessionId));
      const key = JSON.stringify([profile, known?.canonicalSessionId ?? sessionId, inputId]);
      if (options.attachments?.length || this.stagedInputs.has(key)) {
        return this.submitPrompt(profile, sessionId, trimmed, inputId, undefined, queued, options);
      }
      if (!trimmed.startsWith("/")) {
        return this.submitPrompt(profile, sessionId, trimmed, inputId, undefined, queued);
      }
      const outcome = await this.runSlash(profile, sessionId, trimmed, clientInputId);
      if (outcome.kind === "output") {
        return { kind: "output", sessionId, output: outcome.output };
      }
      // The same input id each attempt: `prompt.submit` dedupes it and reports a finished turn.
      return this.submitPrompt(profile, sessionId, outcome.message, inputId, outcome.notice, false);
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

  private async stageFile(
    conn: HermesRpcConnection,
    sessionId: string,
    path: string,
    size: number,
    name: string,
  ) {
    const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "pa-file-"));
    // Filesystems bound a basename in bytes, while the wire accepts 255 characters.
    const extension = NodePath.extname(name);
    const suffix = Buffer.byteLength(extension) <= 32 ? extension : "";
    let stem = "";
    let remaining = 255 - Buffer.byteLength(suffix);
    for (const char of name.slice(0, name.length - suffix.length)) {
      remaining -= Buffer.byteLength(char);
      if (remaining < 0) break;
      stem += char;
    }
    const filename = stem + suffix;
    const namedPath = NodePath.join(dir, filename);
    const attach = (source: { path: string } | { data_url: string }) =>
      conn.call<{ ref_text: string; ref_path: string; uploaded?: boolean; path?: string }>(
        "file.attach",
        { session_id: sessionId, name: filename, ...source },
        "data_url" in source ? 60_000 : undefined,
      );

    try {
      try {
        await NodeFSP.link(path, namedPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") throw error;
        await NodeFSP.copyFile(path, namedPath, NodeFSP.constants.COPYFILE_EXCL);
      }
      try {
        const staged = await attach({ path: namedPath });
        // A workspace containing the temporary directory can reference the file in place.
        // Submit only a reference that survives removal of the temporary link.
        if (staged.uploaded !== false) {
          if (!staged.path) return staged;
          const localPath = await NodeFSP.realpath(namedPath);
          const stagedPath = await NodeFSP.realpath(staged.path).catch(
            (error: NodeJS.ErrnoException) => {
              if (error.code === "ENOENT") return staged.path;
              throw error;
            },
          );
          if (localPath !== stagedPath) return staged;
        }
      } catch (error) {
        if (
          !(error instanceof HermesRpcError) ||
          (error.message !== "invalid_params" && error.code !== 5028)
        )
          throw error;
      }
      // Base64 and the JSON envelope must fit the gateway's 8 MiB frame.
      if (size > 5 * 1024 * 1024)
        throw new PaError({
          reason: "Unsupported",
          message: "File uploads over the data URL transport are limited to 5 MiB",
        });
      const bytes = await NodeFSP.readFile(path);
      return await attach({
        data_url: "data:application/octet-stream;base64," + bytes.toString("base64"),
      });
    } finally {
      await NodeFSP.rm(dir, { recursive: true, force: true });
    }
  }

  private async stageAttachments(
    conn: HermesRpcConnection,
    sessionId: string,
    key: string,
    attachments: ReadonlyArray<PaLocalAttachment>,
    persisted: ReadonlyArray<PaStagedAttachment>,
  ) {
    const now = nowMs();
    for (const [id, entry] of this.stagedInputs) {
      if (!entry.staging && now - entry.touched > STAGED_INPUT_TTL_MS) this.stagedInputs.delete(id);
    }
    const ids = JSON.stringify(attachments.map((item) => item.metadata.id));
    let entry = this.stagedInputs.get(key);
    if (entry && entry.ids !== ids)
      throw new PaError({
        reason: "Conflict",
        message: "Attachment selection changed for this input",
      });
    if (!entry) {
      if (this.stagedInputs.size >= MAX_STAGED_INPUTS) {
        const oldest = [...this.stagedInputs].find(([, value]) => !value.staging);
        if (!oldest)
          throw new PaError({ reason: "Unavailable", message: "Too many concurrent uploads" });
        this.stagedInputs.delete(oldest[0]);
      }
      entry = { ids, touched: now, parts: [...persisted] };
      this.stagedInputs.set(key, entry);
    }
    const run = entry;
    run.touched = now;
    if (!run.staging && run.parts.length < attachments.length) {
      run.staging = (async () => {
        for (const { path, metadata } of attachments.slice(run.parts.length)) {
          const name = paAttachmentName(metadata.name);
          if (metadata.type === "image") {
            const bytes = await NodeFSP.readFile(path);
            const suffix = inferImageExtension({
              mimeType: metadata.mimeType,
              fileName: metadata.name,
            });
            const original = NodePath.extname(name).toLowerCase();
            const filename =
              original === suffix || (original === ".jpeg" && suffix === ".jpg")
                ? name
                : name.slice(0, 255 - suffix.length) + suffix;
            const staged = await conn.call<{ path: string; mime: string }>("image.attach_bytes", {
              session_id: sessionId,
              filename,
              content_base64: bytes.toString("base64"),
            });
            if (!staged.path || !staged.mime) throw invalid("Image staging failed");
            run.parts.push({
              key: hermesAttachmentKey("image", staged.path),
              image: { path: staged.path, mime: staged.mime },
            });
          } else {
            const staged = await this.stageFile(conn, sessionId, path, metadata.sizeBytes, name);
            if (!staged.ref_text?.startsWith("@file:")) throw invalid("File staging failed");
            const ref =
              staged.ref_path ?? staged.ref_text.slice(6).replace(/^([`"'])(.*)\1$/, "$2");
            run.parts.push({ key: hermesAttachmentKey("file", ref), fileRef: staged.ref_text });
          }
        }
      })()
        .catch((error: unknown) => {
          if (isPaInputRefusal(toPaError(error))) this.stagedInputs.delete(key);
          throw error;
        })
        .finally(() => {
          delete run.staging;
        });
    }
    await run.staging;
    return run.parts;
  }

  private async submitPrompt(
    profile: string,
    sessionId: string,
    prompt: string,
    inputId: string,
    notice: string | undefined,
    queued: boolean,
    options?: PaSendOptions,
  ): Promise<PaSendResult> {
    const conn = await this.pool.getConnection(profile);
    const state = await this.ensureSessionAttached(profile, conn, sessionId);
    const target = state.canonicalSessionId ?? sessionId;
    const stageKey = JSON.stringify([profile, target, inputId]);
    const parts = options
      ? await this.stageAttachments(
          conn,
          target,
          stageKey,
          options.attachments ?? [],
          options.staged ?? [],
        )
      : [];
    const images = parts.flatMap((part) => (part.image ? [part.image] : []));
    options?.onStaged?.(parts);
    const res = await conn
      .call<HermesSubmitReceipt>("prompt.submit", {
        session_id: target,
        text: [prompt, ...parts.flatMap((part) => (part.fileRef ? [part.fileRef] : []))]
          .filter(Boolean)
          .join("\n"),
        ...(images.length ? { attachments: images } : {}),
        input_id: inputId,
        ...(queued ? { queued: true } : {}),
      })
      .catch((error: unknown) => {
        if (isPaInputRefusal(toPaError(error))) this.stagedInputs.delete(stageKey);
        throw error;
      });
    if (res.voice_stopped === true) {
      this.stagedInputs.delete(stageKey);
      return { kind: "output", sessionId, output: "Voice chat stopped. Nothing was sent." };
    }
    return {
      kind: "turn",
      sessionId,
      submissionId: res.submission_id ?? res.admission_id ?? inputId,
      ...(res.admission_id && res.submission_id && res.admission_id !== res.submission_id
        ? { admissionId: res.admission_id }
        : {}),
      ...(res.status === "terminal" ? { settled: true } : {}),
      // Every admission answers `queued` before the drain claims it, an idle session's too: only
      // a send the client made behind a running turn is reported as waiting.
      ...(queued && res.status === "queued" ? { queued: true } : {}),
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

  steerSession = (profile: string, sessionId: string, text: string) =>
    withPaErrors(async (): Promise<PaSteerSessionResult> => {
      assertSession(profile, sessionId);
      const trimmed = text.trim();
      if (!trimmed) throw invalid("Message cannot be empty");
      const conn = await this.pool.getConnection(profile);
      // `session.steer` is fenced on the running claim's generation, which goes stale while idle.
      const state = await this.ensureSessionAttached(profile, conn, sessionId, { refresh: true });
      let res: HermesCorrectionAck;
      try {
        res = await conn.call<HermesCorrectionAck>("session.steer", {
          session_id: state.canonicalSessionId ?? sessionId,
          execution_generation: state.executionGeneration,
          text: trimmed,
        });
      } catch (err) {
        // Refused by the generation check before any agent saw the text: the turn already ended.
        if (err instanceof HermesRpcError && err.message === "stale_generation") {
          return { status: "notDelivered" };
        }
        throw err;
      }
      if (res.voice_stopped === true) return { status: "voiceStopped" };
      if (res.status === "queued" || res.status === "redirected") {
        return { status: "delivered" };
      }
      if (res.status === "rejected" && res.delivered === false) return { status: "notDelivered" };
      // A plain `rejected` can follow delivery (an ACK that timed out): sending it again could
      // make the agent read it twice.
      throw new PaError({
        reason: "Conflict",
        message:
          "The running turn did not confirm this message. It was not sent again; check the reply before resending.",
      });
    });

  manageQueuedItem = (
    profile: string,
    sessionId: string,
    input: Omit<PaManageQueuedItemInput, "botId" | "sessionId">,
    checkSteerInput?: (inputId: string) => void,
    journalInputId?: string,
  ) =>
    withPaErrors(async () => {
      assertSession(profile, sessionId);
      const conn = await this.pool.getConnection(profile);
      const state = await this.ensureSessionAttached(profile, conn, sessionId, { refresh: true });
      const target = {
        session_id: state.canonicalSessionId ?? sessionId,
        admission_id: input.itemId,
      };
      switch (input.action) {
        case "cancel": {
          const queued = state.queued.find((item) => item.id === input.itemId);
          const receipt = await conn.call<{
            admission_id?: string;
            status?: string;
            outcome?: string;
            execution_generation?: number | null;
          }>("prompt.cancel", target);
          if (
            receipt?.admission_id === input.itemId &&
            receipt.status === "terminal" &&
            receipt.outcome === "cancelled" &&
            receipt.execution_generation === null
          ) {
            const cancelledInputId = queued?.inputId ?? journalInputId ?? input.itemId;
            this.stagedInputs.delete(
              JSON.stringify([profile, target.session_id, cancelledInputId]),
            );
            return { cancelledInputId };
          }
          return;
        }
        case "steer": {
          const queued = state.queued.find((item) => item.id === input.itemId);
          if (queued?.attachmentCount)
            throw new PaError({
              reason: "Unsupported",
              message: "Queued attachments cannot be steered",
            });
          if (queued?.inputId) checkSteerInput?.(queued.inputId);
          await conn.call("prompt.steer_queued", target);
          return;
        }
        case "resolveUnknown":
          // Fenced on the lost admission's own generation, which the fresh resume listed.
          await conn.call("prompt.resolve_unknown", {
            ...target,
            execution_generation:
              state.admissionGenerations.get(input.itemId) ?? state.executionGeneration,
          });
          return;
      }
    });

  readonly requests = {
    kindOf: (profile: string, sessionId: string, requestId: string) => {
      const state = this.sessionStates.get(this.sessionKey(profile, sessionId));
      return state?.requests.get(requestId)?.request.kind ?? null;
    },
    respond: (profile: string, sessionId: string, input: HermesRequestAnswer) =>
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
    input: HermesRequestAnswer,
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
      } else if (request.kind === "secret") {
        conn.respondServerRequest(input.requestId, {
          value: encodeSecretAnswer(tracked.method, request, input),
        });
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
    if (request.kind === "secret") {
      throw invalid("This request can only be answered over its live feed");
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
      if (frame.event === "message.complete") {
        const receipt = frame.payload?.persisted_turn;
        if (
          receipt &&
          typeof receipt === "object" &&
          "submission_id" in receipt &&
          typeof receipt.submission_id === "string" &&
          "user_row_id" in receipt &&
          typeof receipt.user_row_id === "number" &&
          Number.isSafeInteger(receipt.user_row_id) &&
          receipt.user_row_id > 0
        ) {
          try {
            subscriber.onUserRowPersisted?.(receipt.submission_id, receipt.user_row_id);
          } catch {
            process.emitWarning("PA attachment receipt could not be recorded");
          }
        }
      }
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
            admission_id: ev.admission_id,
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
    subscriber.onAttachmentSession?.(state.canonicalSessionId ?? sessionId);
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

    const todos =
      "todo_state" in snapshot ? normalizeHermesTodoState(snapshot.todo_state) : undefined;
    mapper.adoptBaseline({
      usage: snapshot.info?.usage,
      ...(snapshot.pending !== undefined ? { pending: snapshot.pending } : {}),
      ...(todos !== undefined ? { todoRevision: todos?.revision ?? -1 } : {}),
    });
    const usage =
      snapshot.info && "usage" in snapshot.info
        ? normalizeHermesUsage(snapshot.info.usage)
        : undefined;
    emit({
      type: "snapshot",
      sessionId,
      running: snapshot.running === true,
      openRequests: openRequests(),
      snapshotRequired,
      // An older Hermes that omits a field leaves the viewer's copy as it was.
      ...(snapshot.pending !== undefined
        ? { queuedItems: normalizeHermesQueue(snapshot.pending) }
        : {}),
      ...(usage !== undefined ? { usage } : {}),
      ...(todos !== undefined ? { todos } : {}),
    });
    bootstrapping = false;
    for (const item of [...postSnapshot, ...buffered.splice(0)]) {
      if (item.kind === "event") deliver(item.frame);
      else deliverRequest(item.frame);
    }
    return release;
  }

  readonly models = {
    getCatalog: (profile: string, sessionId?: string) =>
      withPaErrors(async () => {
        assertProfile(profile);
        const [defaultConn, profileConn] = await Promise.all([
          this.pool.getConnection("default"),
          this.pool.getConnection(profile),
        ]);
        const tracked = sessionId
          ? this.sessionStates.get(this.sessionKey(profile, sessionId))
          : undefined;
        const canonicalSessionId = tracked?.canonicalSessionId ?? sessionId;
        // `model.options` and `config.get` must run on the profile's own socket to avoid `profile_mismatch`.
        const [description, options, reasoning] = await Promise.all([
          defaultConn.call<HermesProfileDescription>("profiles.describe", { name: profile }),
          profileConn
            .call<HermesModelOptionsResult>("model.options", { explicit_only: true })
            .catch((error: unknown) => {
              if (isUnsupportedRpc(error, "model.options")) return { providers: [] };
              throw error;
            }),
          profileConn
            .call<HermesReasoningConfigResult>("config.get", {
              key: "reasoning",
              ...(canonicalSessionId ? { session_id: canonicalSessionId } : {}),
            })
            .catch((error: unknown) => {
              if (isUnsupportedRpc(error, "config.get")) return null;
              throw error;
            }),
        ]);
        return normalizeModelCatalog(options, description, reasoning ?? undefined);
      }),
    select: (
      profile: string,
      input: {
        readonly sessionId?: string | undefined;
        readonly provider?: string | undefined;
        readonly model?: string | undefined;
        readonly reasoningEffort?: string | undefined;
        readonly confirm: boolean;
      },
    ) =>
      withPaErrors(async () => {
        assertProfile(profile);
        const hasModel = input.model !== undefined;
        const hasReasoning = input.reasoningEffort !== undefined;
        if (!hasModel && !hasReasoning) {
          throw invalid("Choose a model or reasoning effort");
        }
        if (input.provider !== undefined && !hasModel) {
          throw invalid("Choose a model for this provider");
        }
        const normalizedEffort = hasReasoning
          ? normalizeHermesReasoningEffort(input.reasoningEffort)
          : undefined;
        if (hasReasoning && !normalizedEffort) {
          throw invalid(`Unsupported reasoning effort "${input.reasoningEffort}"`);
        }
        const provider = input.provider?.trim() ?? "";
        // `profiles.configure` silently skips a model pin without its provider.
        if (hasModel && !provider) throw invalid("Choose a provider for this model");
        if (hasModel) {
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
        }
        if (normalizedEffort !== undefined) {
          const profileConn = await this.pool.getConnection(profile);
          const tracked = input.sessionId
            ? this.sessionStates.get(this.sessionKey(profile, input.sessionId))
            : undefined;
          const canonicalSessionId = tracked?.canonicalSessionId ?? input.sessionId;
          await profileConn.call("config.set", {
            key: "reasoning",
            value: normalizedEffort,
            scope: "global",
            ...(canonicalSessionId ? { session_id: canonicalSessionId } : {}),
          });
        }
        let resolvedProvider: string | null = hasModel ? provider : null;
        let resolvedModel = hasModel ? input.model! : "";
        if (!hasModel) {
          const defaultConn = await this.pool.getConnection("default");
          const description = await defaultConn
            .call<HermesProfileDescription>("profiles.describe", { name: profile })
            .catch(() => null);
          resolvedProvider = description?.model?.provider || null;
          resolvedModel = description?.model?.default || "";
        }
        return {
          status: "applied" as const,
          current: {
            provider: resolvedProvider,
            model: resolvedModel,
            ...(normalizedEffort !== undefined ? { reasoningEffort: normalizedEffort } : {}),
          },
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
