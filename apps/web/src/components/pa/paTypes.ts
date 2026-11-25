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
