import type {
  PaBotConfig,
  PaCapabilities,
  PaConfigSectionValue,
  PaCreateBotInput,
  PaEngineDriverKind,
  PaInstanceId,
  PaMessage,
  PaModelCatalog,
  PaMutateScheduleInput,
  PaRespondRequestInput,
  PaSchedule,
  PaSelectBotModelResult,
  PaSendResult,
  PaSessionSummary,
  PaSlashCommand,
  PaStreamEvent,
} from "@t3tools/contracts";

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
  readonly lastMessagePreview: string | null;
}

export type PaAdapterSession = Omit<PaSessionSummary, "isPrimary">;

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** A stream event before `PaService` stamps it with its resume token. */
export type PaAdapterEvent = DistributiveOmit<PaStreamEvent, "resumeToken">;

export interface PaSessionSubscriber {
  readonly onEvent: (event: PaAdapterEvent) => void;
  /** The upstream subscription ended; `reason` is set when it failed. */
  readonly onClose: (reason?: string) => void;
}

export interface PaSendOptions {
  readonly inputId?: string | undefined;
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
  readonly listSessions: (agentRef: string) => Promise<ReadonlyArray<PaAdapterSession>>;
  readonly createSession: (
    agentRef: string,
    options: { readonly title?: string | undefined },
  ) => Promise<PaAdapterSession>;
  readonly getMessages: (
    agentRef: string,
    sessionId: string,
    limit: number,
  ) => Promise<ReadonlyArray<PaMessage>>;
  readonly sendMessage: (
    agentRef: string,
    sessionId: string,
    text: string,
    options: PaSendOptions,
  ) => Promise<PaSendResult>;
  readonly interruptSession?: (agentRef: string, sessionId: string) => Promise<void>;
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
