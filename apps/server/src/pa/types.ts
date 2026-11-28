import { latestPaAssistantReply } from "@t3tools/contracts";
import type {
  PaAttachment,
  PaError,
  PaBotConfig,
  PaCapabilities,
  PaConfigSectionValue,
  PaCreateBotInput,
  PaEngineDriverKind,
  PaInstanceId,
  PaMessage,
  PaModelCatalog,
  PaMutateScheduleInput,
  PaPendingRequest,
  PaRespondRequestInput,
  PaSchedule,
  PaSelectBotModelResult,
  PaSendResult,
  PaSessionSummary,
  PaManageQueuedItemInput,
  PaSlashCommand,
  PaSteerSessionResult,
  PaStreamEvent,
} from "@t3tools/contracts";

export interface PaReply {
  readonly sessionId: string;
  readonly ids: ReadonlyArray<string>;
  readonly timestamp: number;
}

export function latestTranscriptReply(
  sessionId: string,
  messages: ReadonlyArray<PaMessage>,
): PaReply | null {
  const row = latestPaAssistantReply(messages);
  if (!row || row.timestamp === null) return null;
  const user = messages
    .slice(0, messages.indexOf(row))
    .findLast((message) => message.role === "user");
  const submission = row.submissionId ?? user?.submissionId;
  return {
    sessionId,
    ids: submission ? [row.id, "submission:" + submission] : [row.id],
    timestamp: row.timestamp,
  };
}

/** What an engine reports about one of its agents; `PaService` adds the T3-local metadata. */
export interface PaAgentRow {
  readonly agentRef: string;
  readonly name: string | null;
  readonly description: string;
  readonly isDefault: boolean;
  readonly model: string | null;
  readonly provider: string | null;
  readonly running: boolean;
  readonly lastActivityAt: number | null;
  readonly completeActivity?: boolean;
  /** null means the probe failed; an empty map means it answered. */
  readonly activeSessions?: ReadonlyMap<string, "working" | "waiting" | "starting" | "idle"> | null;
  readonly replies?: ReadonlyArray<PaReply>;
  readonly lastReplyAt?: number | null;
  readonly lastMessagePreview: string | null;
}

export type PaAdapterSession = Omit<PaSessionSummary, "isPrimary">;

export interface PaSessionPage {
  readonly sessions: ReadonlyArray<PaAdapterSession>;
  readonly nextCursor: string | null;
}

/** One transcript page, oldest row first; `nextCursor` reads the page before it. */
export interface PaMessagePage {
  readonly messages: ReadonlyArray<PaMessage>;
  readonly nextCursor: string | null;
  readonly reset: boolean;
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** A stream event before `PaService` stamps it with its resume token. */
export type PaAdapterEvent = DistributiveOmit<PaStreamEvent, "resumeToken"> & {
  readonly replyAliases?: ReadonlyArray<string>;
};

export function isPaInputRefusal(error: PaError, newClaim = true) {
  return (
    ["Invalid", "Forbidden", "Unsupported", "NotFound"].includes(error.reason) ||
    (newClaim &&
      error.reason === "Conflict" &&
      "inputRefused" in error &&
      error.inputRefused === true)
  );
}

export interface PaSessionSubscriber {
  readonly onCanonicalSession?: (ownerId: string) => void;
  readonly onUserRowPersisted?: (inputId: string, userRowId: number) => void;
  readonly onEvent: (event: PaAdapterEvent) => void;
  /** The upstream subscription ended; `reason` is set when it failed. */
  readonly onClose: (reason?: string) => void;
}

export interface PaSendOptions {
  readonly attachments?: ReadonlyArray<PaLocalAttachment>;
  /** Durable transcript reference keys, recorded before dispatch so a lost reply preserves history. */
  readonly onStaged?: (parts: ReadonlyArray<PaStagedAttachment>) => void;
  readonly staged?: ReadonlyArray<PaStagedAttachment>;
  readonly inputId?: string | undefined;
  /** The client sent it while a turn ran: report a queued admission as `queued`. */
  readonly queued?: boolean | undefined;
}

export interface PaStagedAttachment {
  readonly key: string;
  readonly image?: { readonly path: string; readonly mime: string };
  readonly fileRef?: string;
}

export interface PaLocalAttachment {
  readonly metadata: PaAttachment;
  readonly path: string;
}

export type PaCommandScope = PaSlashCommand["requiredScope"];

/**
 * One engine endpoint. The core every engine implements, plus optional facets that match the
 * capabilities it declares; `PaService` reports `Unsupported` for a facet that is absent.
 * Methods reject with `PaError` for caller mistakes and engine refusals.
 */
export interface PaEngineInstance {
  readonly instanceId: PaInstanceId;
  readonly driver: PaEngineDriverKind;
  readonly label: string;
  readonly capabilities: PaCapabilities;
  /** A cached engine version; never blocks on a probe. */
  readonly version?: () => string | null;
  readonly isValidAgentRef: (agentRef: string) => boolean;
  readonly listAgents: () => Promise<ReadonlyArray<PaAgentRow>>;
  readonly listSessions: (
    agentRef: string,
    options: {
      readonly query?: string | undefined;
      readonly cursor?: string | undefined;
      readonly limit: number;
    },
  ) => Promise<PaSessionPage>;
  readonly refreshSessionActivity?: (
    agentRef: string,
    sessionId: string,
    stillDetached: () => boolean,
  ) => Promise<{ running: boolean; openRequests: ReadonlyArray<PaPendingRequest> } | undefined>;
  readonly createSession: (
    agentRef: string,
    options: { readonly title?: string | undefined; readonly requestId?: string | undefined },
  ) => Promise<PaAdapterSession>;
  /** Requires `capabilities.sessions.rename`; a retried `requestId` is applied once. */
  readonly renameSession?: (
    agentRef: string,
    sessionId: string,
    input: { readonly title: string; readonly requestId: string },
  ) => Promise<{ readonly title: string }>;
  readonly getMessages: (
    agentRef: string,
    sessionId: string,
    options: { readonly limit: number; readonly cursor?: string | undefined },
  ) => Promise<PaMessagePage>;
  readonly attachmentSessionId?: (
    agentRef: string,
    sessionId: string,
    readOnly: boolean,
  ) => Promise<string>;
  readonly sendMessage: (
    agentRef: string,
    sessionId: string,
    text: string,
    options: PaSendOptions,
  ) => Promise<PaSendResult>;
  readonly interruptSession?: (agentRef: string, sessionId: string) => Promise<void>;
  /** Requires `capabilities.execution.steer`; a steer the engine may have taken is never re-sent. */
  readonly steerSession?: (
    agentRef: string,
    sessionId: string,
    text: string,
  ) => Promise<PaSteerSessionResult>;
  /** Requires `capabilities.execution.queue` (and `steer` for its `steer` action). */
  readonly manageQueuedItem?: (
    agentRef: string,
    sessionId: string,
    input: Omit<PaManageQueuedItemInput, "botId" | "sessionId">,
    checkSteerInput?: (inputId: string) => void,
    journalInputId?: string,
  ) => Promise<void | { readonly cancelledInputId: string }>;
  /**
   * Opens the engine's live feed for a session and emits a `snapshot` first. `resume` asks the
   * adapter to replay what it missed since its previous feed for this session ended.
   */
  readonly subscribeSession: (
    agentRef: string,
    sessionId: string,
    subscriber: PaSessionSubscriber,
    options: { readonly resume: boolean },
  ) => Promise<() => void>;
  readonly models?: {
    readonly getCatalog: (agentRef: string, sessionId?: string) => Promise<PaModelCatalog>;
    readonly select: (
      agentRef: string,
      input: {
        readonly sessionId?: string | undefined;
        readonly provider?: string | undefined;
        readonly model?: string | undefined;
        readonly reasoningEffort?: string | undefined;
        readonly confirm: boolean;
      },
    ) => Promise<PaSelectBotModelResult>;
  };
  readonly commands?: {
    readonly list: (agentRef: string) => Promise<ReadonlyArray<PaSlashCommand>>;
    /** Plain text is `operate`; an unknown command must be `manage`. */
    readonly requiredScope: (text: string) => PaCommandScope;
  };
  readonly requests?: {
    /** The kind of a request this engine still has open, as it opened it; never the client's word. */
    readonly kindOf?: (
      agentRef: string,
      sessionId: string,
      requestId: string,
    ) => PaPendingRequest["kind"] | null;
    readonly respond: (
      agentRef: string,
      sessionId: string,
      input: Omit<PaRespondRequestInput, "botId" | "sessionId">,
    ) => Promise<void>;
  };
  readonly config?: {
    readonly get: (agentRef: string) => Promise<PaBotConfig>;
    readonly patch: (
      agentRef: string,
      sectionId: string,
      value: PaConfigSectionValue,
    ) => Promise<PaBotConfig>;
  };
  readonly schedules?: {
    readonly list: (agentRef: string) => Promise<ReadonlyArray<PaSchedule>>;
    readonly mutate: (
      agentRef: string,
      input: Omit<PaMutateScheduleInput, "botId">,
    ) => Promise<ReadonlyArray<PaSchedule>>;
  };
  readonly lifecycle?: {
    /** Creates the agent and resolves with the ref the engine gave it. */
    readonly create: (
      input: Omit<
        PaCreateBotInput,
        "instanceId" | "name" | "avatarColor" | "avatarShape" | "pinned"
      >,
    ) => Promise<{ readonly agentRef: string }>;
  };
  readonly dispose?: () => void;
}
