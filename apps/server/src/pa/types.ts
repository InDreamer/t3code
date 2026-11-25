export type PaAdapterKind = "hermes" | "openclaw";

export type PaAvatarShape = "blob" | "pumpkin" | "cloud" | "drop" | "pill" | "circle";

export interface PaAdapterCapabilities {
  readonly create: boolean;
  readonly cron: boolean;
  readonly slash: boolean;
  readonly skills: boolean;
  readonly toolsets: boolean;
}

export interface PaAdapterStatus {
  readonly kind: PaAdapterKind;
  readonly label: string;
  readonly available: boolean;
  readonly online: boolean;
  readonly version: string | null;
  readonly botCount: number;
  readonly error: string | null;
  readonly capabilities: PaAdapterCapabilities;
}

export interface PaBotSummary {
  readonly id: string;
  readonly adapter: PaAdapterKind;
  readonly profile: string;
  readonly name: string;
  readonly description: string;
  readonly avatarColor: string;
  readonly avatarShape: PaAvatarShape;
  readonly pinned: boolean;
  readonly isDefault: boolean;
  readonly model: string | null;
  readonly provider: string | null;
  readonly skillCount: number;
  readonly online: boolean;
  readonly running: boolean;
  readonly unread: boolean;
  readonly lastMessagePreview: string | null;
  readonly lastActivityAt: number | null;
  readonly primarySessionId: string | null;
}

export interface PaSkillEntry {
  readonly name: string;
  readonly category?: string | undefined;
  readonly enabled: boolean;
}

export interface PaToolsetEntry {
  readonly name: string;
  readonly label?: string | undefined;
  readonly description?: string | undefined;
  readonly enabled: boolean;
}

export interface PaMcpServerEntry {
  readonly name: string;
  readonly enabled: boolean;
}

export interface PaCronJob {
  readonly id: string;
  readonly name: string;
  readonly schedule: string;
  readonly prompt: string;
  readonly enabled: boolean;
  readonly deliver?: string | undefined;
  readonly nextRunAt?: string | undefined;
  readonly lastRunAt?: string | undefined;
  readonly lastStatus?: string | undefined;
}

export interface PaModelProviderOption {
  readonly slug: string;
  readonly name: string;
  readonly isCurrent: boolean;
  readonly models: ReadonlyArray<string>;
}

export interface PaBotDetail extends PaBotSummary {
  readonly soul: string;
  readonly skills: ReadonlyArray<PaSkillEntry>;
  readonly toolsets: ReadonlyArray<PaToolsetEntry>;
  readonly mcpServers: ReadonlyArray<PaMcpServerEntry>;
  readonly cronJobs: ReadonlyArray<PaCronJob>;
  readonly modelOptions: ReadonlyArray<PaModelProviderOption>;
  readonly confirmRequired?: { readonly message: string } | undefined;
}

export interface PaSessionSummary {
  readonly sessionId: string;
  readonly title: string;
  readonly source: string;
  readonly model: string | null;
  readonly messageCount: number;
  readonly running: boolean;
  readonly startedAt: number | null;
  readonly lastActivityAt: number | null;
  readonly isPrimaryWeb: boolean;
}

export interface PaMessage {
  readonly id: string;
  readonly role: "user" | "assistant" | "system" | "tool";
  readonly text: string;
  readonly reasoning?: string | undefined;
  readonly toolName?: string | undefined;
  readonly toolArgs?: Record<string, unknown> | undefined;
  readonly timestamp: number | null;
  readonly rowKind: "message" | "compaction";
}

export interface PaSlashCommand {
  readonly name: string;
  readonly description: string;
  readonly category: string;
}

export interface PaPendingRequest {
  readonly requestId: string;
  readonly kind: "approval" | "clarify";
  readonly channel: "canonical" | "server_request";
  readonly executionGeneration?: number | undefined;
  readonly title: string;
  readonly detail: string;
  readonly command?: string | undefined;
  readonly options?: ReadonlyArray<{ readonly id: string; readonly label: string }> | undefined;
  readonly questions?:
    | ReadonlyArray<{
        readonly id: string;
        readonly prompt: string;
        readonly options?: ReadonlyArray<string> | undefined;
      }>
    | undefined;
}

export interface PaCreateBotInput {
  readonly adapter: PaAdapterKind;
  readonly profile: string;
  readonly name?: string | undefined;
  readonly description?: string | undefined;
  readonly avatarColor?: string | undefined;
  readonly avatarShape?: PaAvatarShape | undefined;
  readonly pinned?: boolean | undefined;
  readonly soul?: string | undefined;
  readonly model?: string | undefined;
  readonly provider?: string | undefined;
}

export interface PaUpdateBotInput {
  readonly name?: string | undefined;
  readonly description?: string | undefined;
  readonly avatarColor?: string | undefined;
  readonly avatarShape?: PaAvatarShape | undefined;
  readonly pinned?: boolean | undefined;
  readonly soul?: string | undefined;
  readonly model?: string | undefined;
  readonly provider?: string | undefined;
  readonly confirmExpensiveModel?: boolean | undefined;
  readonly disabledSkills?: ReadonlyArray<string> | undefined;
  readonly enabledToolsets?: ReadonlyArray<string> | undefined;
  readonly enabledMcpServers?: ReadonlyArray<string> | undefined;
  readonly markRead?: boolean | undefined;
}

export interface PaCronMutationInput {
  readonly action: "add" | "remove" | "pause" | "resume";
  readonly jobId?: string | undefined;
  readonly name?: string | undefined;
  readonly schedule?: string | undefined;
  readonly prompt?: string | undefined;
  readonly deliver?: string | undefined;
}

export interface PaSendResult {
  readonly kind: "turn" | "slash";
  readonly sessionId: string;
  readonly submissionId?: string | undefined;
  readonly output?: string | undefined;
  readonly notice?: string | undefined;
  readonly directiveType?: string | undefined;
}

export interface PaRespondRequestInput {
  readonly requestId: string;
  readonly kind: "approval" | "clarify";
  readonly channel?: "canonical" | "server_request" | undefined;
  readonly executionGeneration?: number | undefined;
  readonly decision?: "once" | "always" | "deny" | "session" | undefined;
  readonly answer?: string | undefined;
  readonly answers?: Record<string, string> | undefined;
}

export type PaStreamEvent =
  | {
      readonly type: "snapshot";
      readonly sessionId: string;
      readonly running: boolean;
      readonly lastSeq: number;
      readonly replayEpoch?: string | undefined;
      readonly snapshotRequired?: boolean | undefined;
      readonly openRequests: ReadonlyArray<PaPendingRequest>;
    }
  | {
      readonly type: "message.start";
      readonly sessionId: string;
      readonly turnId?: string | undefined;
      readonly seq?: number | undefined;
    }
  | {
      readonly type: "message.delta";
      readonly sessionId: string;
      readonly text: string;
      readonly turnId?: string | undefined;
      readonly segment?: number | undefined;
      readonly offset?: number | undefined;
      readonly seq?: number | undefined;
    }
  | {
      readonly type: "message.interim";
      readonly sessionId: string;
      readonly text: string;
      readonly alreadyStreamed?: boolean | undefined;
      readonly seq?: number | undefined;
    }
  | {
      readonly type: "reasoning.delta";
      readonly sessionId: string;
      readonly text: string;
      readonly seq?: number | undefined;
    }
  | {
      readonly type: "tool.progress";
      readonly sessionId: string;
      readonly toolName: string;
      readonly status: "started" | "completed" | "failed" | "progress";
      readonly preview?: string | undefined;
      readonly seq?: number | undefined;
    }
  | {
      readonly type: "message.complete";
      readonly sessionId: string;
      readonly text: string;
      readonly reasoning?: string | undefined;
      readonly status: "complete" | "error" | "interrupted";
      readonly error?: string | undefined;
      readonly seq?: number | undefined;
    }
  | {
      readonly type: "request.open";
      readonly sessionId: string;
      readonly request: PaPendingRequest;
    }
  | {
      readonly type: "request.cancel";
      readonly sessionId: string;
      readonly requestId: string;
    }
  | {
      readonly type: "notice";
      readonly sessionId: string;
      readonly message: string;
    }
  | {
      readonly type: "error";
      readonly sessionId: string;
      readonly message: string;
    };

export interface PaAdapter {
  readonly kind: PaAdapterKind;
  readonly label: string;
  readonly capabilities: PaAdapterCapabilities;
  getStatus(): Promise<PaAdapterStatus>;
  listBots(): Promise<ReadonlyArray<PaBotSummary>>;
  getBotDetail(profile: string): Promise<PaBotDetail>;
  createBot(input: PaCreateBotInput): Promise<PaBotSummary>;
  updateBot(profile: string, patch: PaUpdateBotInput): Promise<PaBotDetail>;
  manageCron(profile: string, input: PaCronMutationInput): Promise<ReadonlyArray<PaCronJob>>;
  listSlashCommands(profile: string): Promise<ReadonlyArray<PaSlashCommand>>;
  listSessions(profile: string): Promise<{
    readonly primarySessionId: string | null;
    readonly sessions: ReadonlyArray<PaSessionSummary>;
  }>;
  createSession(
    profile: string,
    options?: { readonly setPrimary?: boolean },
  ): Promise<PaSessionSummary>;
  getMessages(
    profile: string,
    sessionId: string,
    limit?: number,
  ): Promise<ReadonlyArray<PaMessage>>;
  sendMessage(
    profile: string,
    sessionId: string,
    text: string,
    options?: { readonly inputId?: string | undefined },
  ): Promise<PaSendResult>;
  interruptSession(profile: string, sessionId: string): Promise<void>;
  respondRequest(profile: string, sessionId: string, input: PaRespondRequestInput): Promise<void>;
  subscribeSession(
    profile: string,
    sessionId: string,
    options: {
      readonly sinceSeq?: number | undefined;
      readonly replayEpoch?: string | undefined;
      readonly onEvent: (event: PaStreamEvent) => void;
      readonly onClose?: ((reason?: string) => void) | undefined;
    },
  ): Promise<() => void>;
  dispose?: (() => void) | undefined;
}

const VALID_PROFILE_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const VALID_SESSION_ID_PATTERN = /^[^\s\p{Cc}]{1,200}$/u;

export function isValidPaProfile(profile: string): boolean {
  return VALID_PROFILE_PATTERN.test(profile);
}

export function isValidPaSessionId(sessionId: string): boolean {
  return VALID_SESSION_ID_PATTERN.test(sessionId) && !sessionId.includes("..");
}

export function makePaBotId(adapter: PaAdapterKind, profile: string): string {
  return `${adapter}:${profile}`;
}

export function parsePaBotId(
  botId: string,
): { readonly adapter: PaAdapterKind; readonly profile: string } | null {
  const idx = botId.indexOf(":");
  if (idx <= 0 || idx === botId.length - 1) return null;
  const adapter = botId.slice(0, idx);
  const profile = botId.slice(idx + 1);
  if (adapter !== "hermes" && adapter !== "openclaw") return null;
  if (!isValidPaProfile(profile)) return null;
  return { adapter, profile };
}
