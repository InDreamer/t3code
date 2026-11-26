import * as Schema from "effect/Schema";

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
  sessions: Schema.Struct({ create: Schema.Boolean, rename: Schema.Boolean }),
  execution: Schema.Struct({
    interrupt: Schema.Boolean,
    approvals: Schema.Boolean,
    clarify: Schema.Boolean,
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

export const PaModelProvider = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  /** `primary` providers are listed up front; `detected` ones fold away behind a disclosure. */
  tier: Schema.Literals(["primary", "detected"]),
  badge: Schema.optionalKey(Schema.Literals(["current", "custom", "detected"])),
  isCurrent: Schema.Boolean,
  models: Schema.Array(Schema.Struct({ id: Schema.String })),
});
export type PaModelProvider = typeof PaModelProvider.Type;

const PaModelSelection = Schema.Struct({
  provider: Schema.NullOr(Schema.String),
  model: Schema.String,
});

export const PaModelCatalog = Schema.Struct({
  scope: Schema.Literals(["agent", "session", "none"]),
  allowCustom: Schema.Boolean,
  current: Schema.NullOr(PaModelSelection),
  providers: Schema.Array(PaModelProvider),
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
  provider: Schema.String.check(Schema.isMaxLength(120)),
  model: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
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

export const PaListSessionsResult = Schema.Struct({
  primarySessionId: Schema.NullOr(Schema.String),
  sessions: Schema.Array(PaSessionSummary),
});
export type PaListSessionsResult = typeof PaListSessionsResult.Type;

export const PaCreateSessionInput = Schema.Struct({
  botId: PaBotId,
  setPrimary: Schema.optionalKey(Schema.Boolean),
  title: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(200))),
});
export type PaCreateSessionInput = typeof PaCreateSessionInput.Type;

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

export const PaMessage = Schema.Struct({
  id: Schema.String,
  role: Schema.Literals(["user", "assistant", "system", "tool"]),
  text: Schema.String,
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
});
export type PaMessage = typeof PaMessage.Type;

export const PaGetMessagesInput = Schema.Struct({
  botId: PaBotId,
  sessionId: PaSessionId,
  limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 500 }))),
});
export type PaGetMessagesInput = typeof PaGetMessagesInput.Type;

export const PaGetMessagesResult = Schema.Struct({ messages: Schema.Array(PaMessage) });

export const PaSendMessageInput = Schema.Struct({
  botId: PaBotId,
  sessionId: PaSessionId,
  text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64_000)),
  /** Idempotency key: a retried send with the same id is admitted once. */
  inputId: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128))),
});
export type PaSendMessageInput = typeof PaSendMessageInput.Type;

export const PaSendResult = Schema.Struct({
  /** `turn` streams over the session subscription; `output` is a command's immediate result. */
  kind: Schema.Literals(["turn", "output"]),
  sessionId: Schema.String,
  submissionId: Schema.optionalKey(Schema.String),
  /** A retried `inputId` whose turn already ended: nothing streams, reload the transcript. */
  settled: Schema.optionalKey(Schema.Boolean),
  output: Schema.optionalKey(Schema.String),
  notice: Schema.optionalKey(Schema.String),
});
export type PaSendResult = typeof PaSendResult.Type;

// Requests

export const PaPendingRequest = Schema.Struct({
  requestId: Schema.String,
  kind: Schema.Literals(["approval", "clarify"]),
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
});
export type PaRespondRequestInput = typeof PaRespondRequestInput.Type;

// Streaming

export const PaSubscribeSessionInput = Schema.Struct({
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
  }),
  Schema.Struct({
    type: Schema.Literal("session.updated"),
    ...PaEventBase,
    title: Schema.optionalKey(Schema.String),
    model: Schema.optionalKey(Schema.String),
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
