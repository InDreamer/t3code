import * as Schema from "effect/Schema";
import { ChatAttachmentId, PROVIDER_SEND_TURN_MAX_ATTACHMENTS } from "./chatAttachment.ts";
import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

const PA_SLUG_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
const PA_OPAQUE_REF_PATTERN = /^[^\s\p{Cc}]+$/u;
const PA_SESSION_ID_PATTERN = /^(?!.*\.\.)[^\s\p{Cc}]{1,200}$/u;

/** An engine implementation (`hermes`, `openclaw`, ...); any slug, so new engines need no contract change. */
export const PaEngineDriverKind = Schema.String.check(Schema.isPattern(PA_SLUG_PATTERN));
export type PaEngineDriverKind = typeof PaEngineDriverKind.Type;

/** One configured engine endpoint; the local default Hermes is `hermes`. */
export const PaInstanceId = Schema.String.check(Schema.isPattern(PA_SLUG_PATTERN));
export type PaInstanceId = typeof PaInstanceId.Type;

/** The engine's own agent identifier, opaque to T3; each adapter validates its own refs. */
export const PaAgentRef = Schema.String.check(
  Schema.isMaxLength(200),
  Schema.isPattern(PA_OPAQUE_REF_PATTERN),
);
export type PaAgentRef = typeof PaAgentRef.Type;

/** `<instanceId>:<agentRef>`, stable across restarts (`hermes:<profile>` predates instances). */
export const PaBotId = Schema.String.check(
  Schema.isMaxLength(266),
  Schema.isPattern(/^[a-z][a-z0-9_-]{0,63}:[^\s\p{Cc}]+$/u),
);
export type PaBotId = typeof PaBotId.Type;

export const PaSessionId = Schema.String.check(Schema.isPattern(PA_SESSION_ID_PATTERN));
export type PaSessionId = typeof PaSessionId.Type;

export function makePaBotId(instanceId: string, agentRef: string): string {
  return `${instanceId}:${agentRef}`;
}

export function parsePaBotId(
  botId: string,
): { readonly instanceId: string; readonly agentRef: string } | null {
  const index = botId.indexOf(":");
  if (index <= 0 || index === botId.length - 1) return null;
  const instanceId = botId.slice(0, index);
  const agentRef = botId.slice(index + 1);
  if (!PA_SLUG_PATTERN.test(instanceId) || !PA_OPAQUE_REF_PATTERN.test(agentRef)) return null;
  return { instanceId, agentRef };
}

export const PaErrorReason = Schema.Literals([
  "Unavailable",
  "NotFound",
  "Invalid",
  "Conflict",
  "Forbidden",
  "Upstream",
  "Unsupported",
]);
export type PaErrorReason = typeof PaErrorReason.Type;

export class PaError extends Schema.TaggedError<PaError>()("PaError", {
  reason: PaErrorReason,
  message: Schema.String,
}) {}

export const PaAvatarShape = Schema.Literals([
  "blob",
  "pumpkin",
  "cloud",
  "drop",
  "pill",
  "circle",
]);
export type PaAvatarShape = typeof PaAvatarShape.Type;

const PaAvatarColor = Schema.String.check(Schema.isPattern(/^#[0-9a-fA-F]{6}$/));

export const PaCapabilities = Schema.Struct({
  attachments: Schema.optionalKey(
    Schema.Struct({
      images: Schema.Boolean,
      files: Schema.Boolean,
      maxImages: Schema.optionalKey(NonNegativeInt),
      maxFileBytes: Schema.optionalKey(NonNegativeInt),
    }),
  ),
  sessions: Schema.Struct({
    create: Schema.Boolean,
    rename: Schema.Boolean,
    renameExisting: Schema.optionalKey(Schema.Boolean),
  }),
  execution: Schema.Struct({
    interrupt: Schema.Boolean,
    approvals: Schema.Boolean,
    clarify: Schema.Boolean,
    /** Masked credential prompts (`secret` requests); absent from servers that predate them. */
    secrets: Schema.optionalKey(Schema.Boolean),
    /** Messages sent while a turn runs wait in the engine's queue (`queuedItems`). */
    queue: Schema.optionalKey(Schema.Boolean),
    /** Plain text can be handed to the running turn (`pa.steerSession`). */
    steer: Schema.optionalKey(Schema.Boolean),
  }),
  models: Schema.Struct({
    supported: Schema.Boolean,
    scope: Schema.Literals(["agent", "session", "none"]),
    allowCustom: Schema.Boolean,
  }),
  commands: Schema.Struct({ supported: Schema.Boolean }),
  config: Schema.Struct({ supported: Schema.Boolean }),
  schedules: Schema.Struct({ supported: Schema.Boolean }),
  lifecycle: Schema.Struct({ create: Schema.Boolean, delete: Schema.Boolean }),
});
export type PaCapabilities = typeof PaCapabilities.Type;

export const PaInstanceStatus = Schema.Struct({
  instanceId: PaInstanceId,
  driver: PaEngineDriverKind,
  label: Schema.String,
  online: Schema.Boolean,
  version: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
  botCount: Schema.Number,
  capabilities: PaCapabilities,
});
export type PaInstanceStatus = typeof PaInstanceStatus.Type;

export const PaBotSummary = Schema.Struct({
  botId: PaBotId,
  instanceId: PaInstanceId,
  driver: PaEngineDriverKind,
  engineLabel: Schema.String,
  agentRef: PaAgentRef,
  name: Schema.String,
  description: Schema.String,
  avatarColor: Schema.String,
  avatarShape: PaAvatarShape,
  pinned: Schema.Boolean,
  isDefault: Schema.Boolean,
  model: Schema.NullOr(Schema.String),
  provider: Schema.NullOr(Schema.String),
  online: Schema.Boolean,
  running: Schema.Boolean,
  unread: Schema.Boolean,
  lastMessagePreview: Schema.NullOr(Schema.String),
  lastActivityAt: Schema.NullOr(Schema.Number),
  primarySessionId: Schema.NullOr(Schema.String),
});
export type PaBotSummary = typeof PaBotSummary.Type;

export const PaListBotsResult = Schema.Struct({
  instances: Schema.Array(PaInstanceStatus),
  bots: Schema.Array(PaBotSummary),
});
export type PaListBotsResult = typeof PaListBotsResult.Type;

export const PaBotInput = Schema.Struct({ botId: PaBotId });
export const PaSessionInput = Schema.Struct({ botId: PaBotId, sessionId: PaSessionId });

// Models

export const PaReasoningLevel = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
});
export type PaReasoningLevel = typeof PaReasoningLevel.Type;

export const PaModelOption = Schema.Struct({
  id: Schema.String,
  /** Display name from the engine; clients fall back to a short form of `id`. */
  label: Schema.optionalKey(Schema.String),
  reasoning: Schema.optionalKey(Schema.Boolean),
  canDisableReasoning: Schema.optionalKey(Schema.Boolean),
  /** Per-model effort levels; overrides the catalog-wide `reasoningLevels` when present. */
  reasoningLevels: Schema.optionalKey(Schema.Array(PaReasoningLevel)),
});
export type PaModelOption = typeof PaModelOption.Type;

export const PaModelProvider = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  /** `primary` providers are listed up front; `detected` ones fold away behind a disclosure. */
  tier: Schema.Literals(["primary", "detected"]),
  badge: Schema.optionalKey(Schema.Literals(["current", "custom", "detected"])),
  isCurrent: Schema.Boolean,
  models: Schema.Array(PaModelOption),
});
export type PaModelProvider = typeof PaModelProvider.Type;

const PaModelSelection = Schema.Struct({
  provider: Schema.NullOr(Schema.String),
  model: Schema.String,
  reasoningEffort: Schema.optionalKey(Schema.NullOr(Schema.String)),
});

export const PaModelCatalog = Schema.Struct({
  scope: Schema.Literals(["agent", "session", "none"]),
  allowCustom: Schema.Boolean,
  current: Schema.NullOr(PaModelSelection),
  providers: Schema.Array(PaModelProvider),
  /** Reasoning effort levels this engine offers (ascending); absent when unsupported. */
  reasoningLevels: Schema.optionalKey(Schema.Array(PaReasoningLevel)),
});
export type PaModelCatalog = typeof PaModelCatalog.Type;

export const PaGetBotModelsInput = Schema.Struct({
  botId: PaBotId,
  sessionId: Schema.optionalKey(PaSessionId),
});
export type PaGetBotModelsInput = typeof PaGetBotModelsInput.Type;

export const PaSelectBotModelInput = Schema.Struct({
  botId: PaBotId,
  sessionId: Schema.optionalKey(PaSessionId),
  provider: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(120))),
  model: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200))),
  reasoningEffort: Schema.optionalKey(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
  ),
  /** Set after the engine answered `confirmRequired` and the user accepted. */
  confirm: Schema.optionalKey(Schema.Boolean),
});
export type PaSelectBotModelInput = typeof PaSelectBotModelInput.Type;

export const PaSelectBotModelResult = Schema.Union([
  Schema.Struct({ status: Schema.Literal("applied"), current: PaModelSelection }),
  Schema.Struct({ status: Schema.Literal("confirmRequired"), message: Schema.String }),
]);
export type PaSelectBotModelResult = typeof PaSelectBotModelResult.Type;

// Config

const PaSectionHeader = {
  id: Schema.String,
  label: Schema.String,
  description: Schema.optionalKey(Schema.String),
};

export const PaToggleItem = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  description: Schema.optionalKey(Schema.String),
  group: Schema.optionalKey(Schema.String),
  enabled: Schema.Boolean,
});
export type PaToggleItem = typeof PaToggleItem.Type;

const PaOptionField = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("text"),
    ...PaSectionHeader,
    value: Schema.String,
    placeholder: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({ kind: Schema.Literal("toggle"), ...PaSectionHeader, value: Schema.Boolean }),
  Schema.Struct({
    kind: Schema.Literal("select"),
    ...PaSectionHeader,
    value: Schema.String,
    choices: Schema.Array(Schema.Struct({ id: Schema.String, label: Schema.String })),
  }),
]);
export type PaOptionField = typeof PaOptionField.Type;

export const PaConfigSection = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("document"),
    ...PaSectionHeader,
    text: Schema.String,
    placeholder: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({
    kind: Schema.Literal("toggleList"),
    ...PaSectionHeader,
    items: Schema.Array(PaToggleItem),
    minEnabled: Schema.optionalKey(Schema.Number),
  }),
  Schema.Struct({
    kind: Schema.Literal("options"),
    ...PaSectionHeader,
    fields: Schema.Array(PaOptionField),
  }),
]);
export type PaConfigSection = typeof PaConfigSection.Type;

export const PaBotConfig = Schema.Struct({
  sections: Schema.Array(PaConfigSection),
  nativeConsoleUrl: Schema.optionalKey(Schema.String),
});
export type PaBotConfig = typeof PaBotConfig.Type;

export const PaConfigSectionValue = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("document"),
    text: Schema.String.check(Schema.isMaxLength(64_000)),
  }),
  Schema.Struct({
    kind: Schema.Literal("toggleList"),
    enabled: Schema.Array(Schema.String.check(Schema.isMaxLength(160))).check(
      Schema.isMaxLength(2_000),
    ),
  }),
  Schema.Struct({
    kind: Schema.Literal("options"),
    values: Schema.Record(
      Schema.String,
      Schema.Union([Schema.String.check(Schema.isMaxLength(2_000)), Schema.Boolean]),
    ),
  }),
]);
export type PaConfigSectionValue = typeof PaConfigSectionValue.Type;

export const PaPatchBotConfigInput = Schema.Struct({
  botId: PaBotId,
  sectionId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(120)),
  value: PaConfigSectionValue,
});
export type PaPatchBotConfigInput = typeof PaPatchBotConfigInput.Type;

// Local T3 metadata

export const PaUpdateBotMetaInput = Schema.Struct({
  botId: PaBotId,
  name: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(120))),
  avatarColor: Schema.optionalKey(PaAvatarColor),
  avatarShape: Schema.optionalKey(PaAvatarShape),
  pinned: Schema.optionalKey(Schema.Boolean),
  markRead: Schema.optionalKey(Schema.Boolean),
});
export type PaUpdateBotMetaInput = typeof PaUpdateBotMetaInput.Type;

// Schedules

export const PaSchedule = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  schedule: Schema.String,
  prompt: Schema.String,
  enabled: Schema.Boolean,
  deliver: Schema.optionalKey(Schema.String),
  nextRunAt: Schema.optionalKey(Schema.String),
  lastRunAt: Schema.optionalKey(Schema.String),
  lastStatus: Schema.optionalKey(Schema.String),
});
export type PaSchedule = typeof PaSchedule.Type;

export const PaSchedulesResult = Schema.Struct({ schedules: Schema.Array(PaSchedule) });

export const PaMutateScheduleInput = Schema.Struct({
  botId: PaBotId,
  action: Schema.Literals(["add", "remove", "pause", "resume"]),
  scheduleId: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(200))),
  name: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(200))),
  schedule: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(200))),
  prompt: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(16_000))),
  deliver: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(200))),
});
export type PaMutateScheduleInput = typeof PaMutateScheduleInput.Type;

// Lifecycle

export const PaCreateBotInput = Schema.Struct({
  instanceId: PaInstanceId,
  /** Requested agent ref; the adapter may normalize it and reports the result in the summary. */
  agentRef: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
  name: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(120))),
  description: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(500))),
  instructions: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(64_000))),
  avatarColor: Schema.optionalKey(PaAvatarColor),
  avatarShape: Schema.optionalKey(PaAvatarShape),
  pinned: Schema.optionalKey(Schema.Boolean),
});
export type PaCreateBotInput = typeof PaCreateBotInput.Type;

// Commands

export const PaSlashCommand = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  group: Schema.Literals(["command", "skill", "plugin"]),
  featured: Schema.optionalKey(Schema.Boolean),
  /** `engine` sends the text to the engine; `client:*` commands are handled by the client. */
  handling: Schema.Literals([
    "engine",
    "prompt",
    "client:new-session",
    "client:interrupt",
    "client:model-picker",
  ]),
  requiredScope: Schema.Literals(["operate", "manage"]),
});
export type PaSlashCommand = typeof PaSlashCommand.Type;

export const PaListCommandsResult = Schema.Struct({ commands: Schema.Array(PaSlashCommand) });

// Sessions & messages

export const PaSessionSummary = Schema.Struct({
  sessionId: Schema.String,
  title: Schema.String,
  /** Where the session started (`gui`, `cli`, `cron`, a chat platform...), as the engine names it. */
  source: Schema.String,
  model: Schema.NullOr(Schema.String),
  messageCount: Schema.Number,
  running: Schema.Boolean,
  startedAt: Schema.NullOr(Schema.Number),
  lastActivityAt: Schema.NullOr(Schema.Number),
  isPrimary: Schema.Boolean,
});
export type PaSessionSummary = typeof PaSessionSummary.Type;

const PaPageCursor = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2_000));
const PaRequestKey = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128));

export const PaListSessionsInput = Schema.Struct({
  botId: PaBotId,
  /** Matches a session's title or id, not its messages. */
  query: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200))),
  /** The previous page's `nextCursor`, with the same `query`. */
  cursor: Schema.optionalKey(PaPageCursor),
  limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 200 }))),
});
export type PaListSessionsInput = typeof PaListSessionsInput.Type;

export const PaListSessionsResult = Schema.Struct({
  primarySessionId: Schema.NullOr(Schema.String),
  sessions: Schema.Array(PaSessionSummary),
  /** Absent or null once there is nothing older to list. */
  nextCursor: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
export type PaListSessionsResult = typeof PaListSessionsResult.Type;

export const PaCreateSessionInput = Schema.Struct({
  botId: PaBotId,
  setPrimary: Schema.optionalKey(Schema.Boolean),
  title: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(200))),
  /** Idempotency key: a retried create with the same id returns the same session. */
  requestId: Schema.optionalKey(PaRequestKey),
});
export type PaCreateSessionInput = typeof PaCreateSessionInput.Type;

/** Session edits; one member per action so later actions extend the union. */
export const PaMutateSessionInput = Schema.Union([
  Schema.Struct({
    botId: PaBotId,
    sessionId: PaSessionId,
    action: Schema.Literal("rename"),
    /** Idempotency key: a retried edit with the same id is applied once. */
    requestId: PaRequestKey,
    title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  }),
]);
export type PaMutateSessionInput = typeof PaMutateSessionInput.Type;

export const PaMutateSessionResult = Schema.Struct({
  sessionId: Schema.String,
  title: Schema.optionalKey(Schema.String),
});
export type PaMutateSessionResult = typeof PaMutateSessionResult.Type;

export const PaToolCategory = Schema.Literals([
  "terminal",
  "file-read",
  "file-edit",
  "search",
  "web-search",
  "web-fetch",
  "memory",
  "agent",
  "todo",
  "schedule",
  "skill",
  "code",
  "vision",
  "message",
  "other",
]);
export type PaToolCategory = typeof PaToolCategory.Type;

const PaToolArgs = Schema.Record(Schema.String, Schema.Unknown);

export const PaAttachment = Schema.Struct({
  id: ChatAttachmentId,
  type: Schema.Literals(["image", "file"]),
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(255)),
  mimeType: TrimmedNonEmptyString.check(Schema.isMaxLength(100)),
  sizeBytes: NonNegativeInt,
  unavailable: Schema.optionalKey(Schema.Boolean),
});
export type PaAttachment = typeof PaAttachment.Type;

export const PaMessage = Schema.Struct({
  id: Schema.String,
  role: Schema.Literals(["user", "assistant", "system", "tool"]),
  text: Schema.String,
  attachments: Schema.optionalKey(Schema.Array(PaAttachment)),
  reasoning: Schema.optionalKey(Schema.String),
  toolCallId: Schema.optionalKey(Schema.String),
  toolName: Schema.optionalKey(Schema.String),
  toolCategory: Schema.optionalKey(PaToolCategory),
  toolContext: Schema.optionalKey(Schema.String),
  toolArgs: Schema.optionalKey(PaToolArgs),
  toolFailed: Schema.optionalKey(Schema.Boolean),
  timestamp: Schema.NullOr(Schema.Number),
  rowKind: Schema.Literals(["message", "compaction"]),
  /** Text the agent published before a tool step, not its answer. */
  commentary: Schema.optionalKey(Schema.Boolean),
  /** The engine's durable row number, when it has one; orders rows across pages. */
  rowId: Schema.optionalKey(Schema.Number),
  submissionId: Schema.optionalKey(Schema.String),
  /** The row was too large to page whole: only the head of its text is here. */
  truncated: Schema.optionalKey(Schema.Boolean),
  /** Compaction rows: how many messages the summary replaced. */
  compactedMessages: Schema.optionalKey(Schema.Number),
});
export type PaMessage = typeof PaMessage.Type;

export const PaGetMessagesInput = Schema.Struct({
  botId: PaBotId,
  sessionId: PaSessionId,
  limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 500 }))),
  /** The previous page's `nextCursor`: reads the page before it. Omitted for the newest page. */
  cursor: Schema.optionalKey(PaPageCursor),
});
export type PaGetMessagesInput = typeof PaGetMessagesInput.Type;

/** One page of a transcript, oldest row first, read from the newest end backwards. */
export const PaGetMessagesResult = Schema.Struct({
  messages: Schema.Array(PaMessage),
  /** Reads the page before this one; absent or null at the start of the conversation. */
  nextCursor: Schema.optionalKey(Schema.NullOr(Schema.String)),
  /** The rows the cursor covered changed: this is the newest page again and replaces what is shown. */
  reset: Schema.optionalKey(Schema.Boolean),
});
export type PaGetMessagesResult = typeof PaGetMessagesResult.Type;

export const PaSendMessageInput = Schema.Struct({
  botId: PaBotId,
  sessionId: PaSessionId,
  text: Schema.String.check(Schema.isMaxLength(64_000)),
  attachments: Schema.optionalKey(
    Schema.Array(PaAttachment).check(Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_ATTACHMENTS)),
  ),
  /** Idempotency key: a retried send with the same id is admitted once. */
  inputId: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128))),
  /** Sent while a turn runs: the engine queues it behind that turn. */
  queued: Schema.optionalKey(Schema.Boolean),
});
export type PaSendMessageInput = typeof PaSendMessageInput.Type;

export const PaSendResult = Schema.Struct({
  attachments: Schema.optionalKey(Schema.Array(PaAttachment)),
  /** `turn` streams over the session subscription; `output` is a command's immediate result. */
  kind: Schema.Literals(["turn", "output"]),
  sessionId: Schema.String,
  submissionId: Schema.optionalKey(Schema.String),
  /** The queue item ID when the engine uses a separate transcript submission ID. */
  admissionId: Schema.optionalKey(Schema.String),
  /** A retried `inputId` whose turn already ended: nothing streams, reload the transcript. */
  settled: Schema.optionalKey(Schema.Boolean),
  output: Schema.optionalKey(Schema.String),
  notice: Schema.optionalKey(Schema.String),
  /** Waiting behind the running turn: shown from `queuedItems` until its own turn starts. */
  queued: Schema.optionalKey(Schema.Boolean),
});
export type PaSendResult = typeof PaSendResult.Type;

// Queue, steering, usage and todos

/** A message waiting behind the running turn, as the engine still holds it. */
export const PaQueuedItem = Schema.Struct({
  attachmentCount: Schema.optionalKey(NonNegativeInt),
  id: Schema.String,
  /** The original send's id, when the engine lists it before acknowledging the send. */
  inputId: Schema.optionalKey(Schema.String),
  text: Schema.String,
  /** `steering`: being handed to the running turn. `unknown`: lost across an engine restart; it holds the queue until resolved. */
  status: Schema.Literals(["queued", "steering", "unknown"]),
  canSteer: Schema.Boolean,
  canReplace: Schema.optionalKey(Schema.Boolean),
});
export type PaQueuedItem = typeof PaQueuedItem.Type;

/** The session's current context occupancy; never derived from cumulative token totals. */
export const PaContextUsage = Schema.Struct({
  contextUsed: Schema.Number,
  /** Null when the engine does not know the model's window. */
  contextMax: Schema.NullOr(Schema.Number),
  contextPercent: Schema.NullOr(Schema.Number),
  inputTokens: Schema.optionalKey(Schema.Number),
  outputTokens: Schema.optionalKey(Schema.Number),
  totalTokens: Schema.optionalKey(Schema.Number),
  cacheReadTokens: Schema.optionalKey(Schema.Number),
  compressionCount: Schema.optionalKey(Schema.Number),
});
export type PaContextUsage = typeof PaContextUsage.Type;

export const PaTodoItem = Schema.Struct({
  id: Schema.String,
  text: Schema.String,
  status: Schema.Literals(["pending", "in_progress", "completed", "cancelled"]),
});
export type PaTodoItem = typeof PaTodoItem.Type;

/** The agent's whole task list; a higher `revision` replaces it, an empty one clears it. */
export const PaTodoState = Schema.Struct({
  revision: Schema.Number,
  items: Schema.Array(PaTodoItem),
});
export type PaTodoState = typeof PaTodoState.Type;

export const PaSteerSessionInput = Schema.Struct({
  botId: PaBotId,
  sessionId: PaSessionId,
  text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64_000)),
});
export type PaSteerSessionInput = typeof PaSteerSessionInput.Type;

export const PaSteerSessionResult = Schema.Struct({
  /** `notDelivered`: the turn ended before taking it and nothing saw it, so it is safe to send normally. */
  status: Schema.Literals(["delivered", "notDelivered", "voiceStopped"]),
});
export type PaSteerSessionResult = typeof PaSteerSessionResult.Type;

export const PaManageQueuedItemInput = Schema.Struct({
  botId: PaBotId,
  sessionId: PaSessionId,
  itemId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  /** `resolveUnknown` gives up on a lost turn so the queue behind it runs. */
  action: Schema.Literals(["cancel", "steer", "resolveUnknown"]),
});
export type PaManageQueuedItemInput = typeof PaManageQueuedItemInput.Type;

// Requests

export const PaRequestField = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  placeholder: Schema.optionalKey(Schema.String),
  /** Masked while typed. */
  secret: Schema.optionalKey(Schema.Boolean),
  required: Schema.optionalKey(Schema.Boolean),
});
export type PaRequestField = typeof PaRequestField.Type;

export const PaPendingRequest = Schema.Struct({
  requestId: Schema.String,
  /** `secret` asks for credentials (`fields`); answering one needs providers:manage. */
  kind: Schema.Literals(["approval", "clarify", "secret"]),
  /** Defaults to turn lifetime. Session requests stay open until explicitly resolved. */
  scope: Schema.optionalKey(Schema.Literals(["turn", "session"])),
  title: Schema.String,
  detail: Schema.String,
  command: Schema.optionalKey(Schema.String),
  /** Approval choices; `id` is the engine's own decision id, sent back verbatim. */
  options: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        id: Schema.String,
        label: Schema.String,
        intent: Schema.optionalKey(Schema.Literals(["allow", "deny"])),
      }),
    ),
  ),
  questions: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        id: Schema.String,
        prompt: Schema.String,
        options: Schema.optionalKey(Schema.Array(Schema.String)),
        multiSelect: Schema.optionalKey(Schema.Boolean),
      }),
    ),
  ),
  /** `secret` requests: the values to collect, answered as `values` keyed by field id. */
  fields: Schema.optionalKey(Schema.Array(PaRequestField)),
  /** What answering does beyond this turn, such as saving the value to the agent's config. */
  sideEffectNotice: Schema.optionalKey(Schema.String),
});
export type PaPendingRequest = typeof PaPendingRequest.Type;

export const PaClarifyAnswer = Schema.Union([
  Schema.String.check(Schema.isMaxLength(16_000)),
  Schema.Array(Schema.String.check(Schema.isMaxLength(2_000))),
]);
export type PaClarifyAnswer = typeof PaClarifyAnswer.Type;

export const PaRespondRequestInput = Schema.Struct({
  botId: PaBotId,
  sessionId: PaSessionId,
  requestId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  decision: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(120))),
  answers: Schema.optionalKey(Schema.Record(Schema.String, PaClarifyAnswer)),
  /** `secret` requests: one value per field id. Never logged, stored or echoed back. */
  values: Schema.optionalKey(
    Schema.Record(
      Schema.String.check(Schema.isMaxLength(120)),
      Schema.String.check(Schema.isMaxLength(16_000)),
    ),
  ),
  /** Declines the request without answering it. */
  skip: Schema.optionalKey(Schema.Boolean),
});
export type PaRespondRequestInput = typeof PaRespondRequestInput.Type;

// Streaming

export const PaSubscribeSessionInput = Schema.Struct({
  protocolVersion: Schema.optionalKey(Schema.Int),
  botId: PaBotId,
  sessionId: PaSessionId,
  /** The last `resumeToken` this client applied; the server replays what followed it if it can. */
  resumeToken: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(200))),
});
export type PaSubscribeSessionInput = typeof PaSubscribeSessionInput.Type;

const PaEventBase = {
  sessionId: Schema.String,
  resumeToken: Schema.String,
};

export const PaStreamEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("snapshot"),
    ...PaEventBase,
    running: Schema.Boolean,
    openRequests: Schema.Array(PaPendingRequest),
    /** Events were lost since the client's token: reload the transcript. */
    snapshotRequired: Schema.Boolean,
    /** Absent: unchanged from what the client already has. */
    queuedItems: Schema.optionalKey(Schema.Array(PaQueuedItem)),
    usage: Schema.optionalKey(Schema.NullOr(PaContextUsage)),
    todos: Schema.optionalKey(Schema.NullOr(PaTodoState)),
  }),
  Schema.Struct({
    type: Schema.Literal("queue.updated"),
    ...PaEventBase,
    items: Schema.Array(PaQueuedItem),
  }),
  Schema.Struct({ type: Schema.Literal("usage.updated"), ...PaEventBase, usage: PaContextUsage }),
  Schema.Struct({ type: Schema.Literal("todos.updated"), ...PaEventBase, todos: PaTodoState }),
  Schema.Struct({
    type: Schema.Literal("session.updated"),
    ...PaEventBase,
    title: Schema.optionalKey(Schema.String),
    model: Schema.optionalKey(Schema.String),
    reasoningEffort: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal("turn.started"),
    ...PaEventBase,
    turnId: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal("text.delta"),
    ...PaEventBase,
    text: Schema.String,
    /** A segment's latest role wins: a `commentary` delta reclassifies text already streamed. */
    role: Schema.Literals(["answer", "commentary"]),
    segmentId: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({ type: Schema.Literal("reasoning.delta"), ...PaEventBase, text: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("status.updated"),
    ...PaEventBase,
    text: Schema.NullOr(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal("tool.updated"),
    ...PaEventBase,
    toolId: Schema.String,
    toolName: Schema.String,
    toolCategory: PaToolCategory,
    status: Schema.Literals(["started", "progress", "completed", "failed"]),
    preview: Schema.optionalKey(Schema.String),
    args: Schema.optionalKey(PaToolArgs),
    result: Schema.optionalKey(Schema.String),
    durationMs: Schema.optionalKey(Schema.Number),
  }),
  Schema.Struct({
    type: Schema.Literal("request.opened"),
    ...PaEventBase,
    request: PaPendingRequest,
  }),
  Schema.Struct({
    type: Schema.Literal("request.resolved"),
    ...PaEventBase,
    requestId: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("turn.completed"),
    ...PaEventBase,
    status: Schema.Literals(["complete", "error", "interrupted"]),
    /** The final answer, for engines that do not stream it as deltas. */
    text: Schema.optionalKey(Schema.String),
    error: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal("notice"),
    ...PaEventBase,
    message: Schema.String,
    /** Shown in the timeline (the engine keeps no record of it) rather than as transient status. */
    persistent: Schema.optionalKey(Schema.Boolean),
    /** The send that produced it, so its sender can skip the copy it already shows. */
    inputId: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({ type: Schema.Literal("error"), ...PaEventBase, message: Schema.String }),
]);
export type PaStreamEvent = typeof PaStreamEvent.Type;
