import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import { HermesPaAdapter } from "./HermesPaAdapter.ts";
import { PaStore } from "./PaStore.ts";
import {
  PaRequestError,
  parsePaBotId,
  type PaAdapter,
  type PaAdapterKind,
  type PaAdapterStatus,
  type PaBotDetail,
  type PaBotSummary,
  type PaCreateBotInput,
  type PaCronJob,
  type PaCronMutationInput,
  type PaMessage,
  type PaRespondRequestInput,
  type PaSendResult,
  type PaSessionSummary,
  type PaSlashCommand,
  type PaStreamEvent,
  type PaUpdateBotInput,
} from "./types.ts";

export interface PaServiceShape {
  readonly getHealth: () => Promise<{ readonly adapters: ReadonlyArray<PaAdapterStatus> }>;
  readonly listBots: () => Promise<{
    readonly adapters: ReadonlyArray<PaAdapterStatus>;
    readonly bots: ReadonlyArray<PaBotSummary>;
  }>;
  readonly getBotDetail: (botId: string) => Promise<PaBotDetail>;
  readonly createBot: (input: PaCreateBotInput) => Promise<PaBotSummary>;
  readonly updateBot: (botId: string, patch: PaUpdateBotInput) => Promise<PaBotDetail | null>;
  readonly manageCron: (
    botId: string,
    input: PaCronMutationInput,
  ) => Promise<ReadonlyArray<PaCronJob>>;
  readonly listSlashCommands: (botId: string) => Promise<ReadonlyArray<PaSlashCommand>>;
  readonly listSessions: (botId: string) => Promise<{
    readonly primarySessionId: string | null;
    readonly sessions: ReadonlyArray<PaSessionSummary>;
  }>;
  readonly createSession: (
    botId: string,
    options?: { readonly setPrimary?: boolean },
  ) => Promise<PaSessionSummary>;
  readonly getMessages: (
    botId: string,
    sessionId: string,
    limit?: number,
  ) => Promise<ReadonlyArray<PaMessage>>;
  readonly sendMessage: (
    botId: string,
    sessionId: string,
    text: string,
    options?: { readonly inputId?: string | undefined },
  ) => Promise<PaSendResult>;
  readonly interruptSession: (botId: string, sessionId: string) => Promise<void>;
  readonly respondRequest: (
    botId: string,
    sessionId: string,
    input: PaRespondRequestInput,
  ) => Promise<void>;
  readonly subscribeSession: (
    botId: string,
    sessionId: string,
    options: {
      readonly sinceSeq?: number | undefined;
      readonly replayEpoch?: string | undefined;
      readonly onEvent: (event: PaStreamEvent) => void;
      readonly onClose?: ((reason?: string) => void) | undefined;
    },
  ) => Promise<() => void>;
}

export class PaService extends Context.Service<PaService, PaServiceShape>()("t3/pa/PaService") {}

export function createPaService(adapters: ReadonlyArray<PaAdapter>): PaServiceShape {
  const byKind = new Map<PaAdapterKind, PaAdapter>();
  for (const adapter of adapters) {
    byKind.set(adapter.kind, adapter);
  }

  const resolveBot = (botId: string): { readonly adapter: PaAdapter; readonly profile: string } => {
    const parsed = parsePaBotId(botId);
    if (!parsed) {
      throw new PaRequestError(400, `Invalid bot id "${botId}"`);
    }
    const adapter = byKind.get(parsed.adapter);
    if (!adapter) {
      throw new PaRequestError(404, `PA adapter "${parsed.adapter}" is not registered`);
    }
    return { adapter, profile: parsed.profile };
  };

  return {
    async getHealth() {
      const statuses = await Promise.all(adapters.map((adapter) => adapter.getStatus()));
      return { adapters: statuses };
    },
    async listBots() {
      const results = await Promise.all(
        adapters.map(async (adapter) => {
          try {
            const bots = await adapter.listBots();
            return {
              status: {
                kind: adapter.kind,
                label: adapter.label,
                available: true,
                online: true,
                version: null,
                botCount: bots.length,
                error: null,
                capabilities: adapter.capabilities,
              } satisfies PaAdapterStatus,
              bots,
            };
          } catch (err) {
            return {
              status: {
                kind: adapter.kind,
                label: adapter.label,
                available: true,
                online: false,
                version: null,
                botCount: 0,
                error: err instanceof Error ? err.message : String(err),
                capabilities: adapter.capabilities,
              } satisfies PaAdapterStatus,
              bots: [] as ReadonlyArray<PaBotSummary>,
            };
          }
        }),
      );
      const bots = results
        .flatMap((entry) => entry.bots)
        .sort((a, b) => {
          if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
          return (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0);
        });
      return {
        adapters: results.map((entry) => entry.status),
        bots,
      };
    },
    async getBotDetail(botId) {
      const { adapter, profile } = resolveBot(botId);
      return adapter.getBotDetail(profile);
    },
    async createBot(input) {
      const adapter = byKind.get(input.adapter);
      if (!adapter) {
        throw new PaRequestError(404, `PA adapter "${input.adapter}" is not available yet`);
      }
      return adapter.createBot(input);
    },
    async updateBot(botId, patch) {
      const { adapter, profile } = resolveBot(botId);
      return adapter.updateBot(profile, patch);
    },
    async manageCron(botId, input) {
      const { adapter, profile } = resolveBot(botId);
      return adapter.manageCron(profile, input);
    },
    async listSlashCommands(botId) {
      const { adapter, profile } = resolveBot(botId);
      return adapter.listSlashCommands(profile);
    },
    async listSessions(botId) {
      const { adapter, profile } = resolveBot(botId);
      return adapter.listSessions(profile);
    },
    async createSession(botId, options) {
      const { adapter, profile } = resolveBot(botId);
      return adapter.createSession(profile, options);
    },
    async getMessages(botId, sessionId, limit) {
      const { adapter, profile } = resolveBot(botId);
      return adapter.getMessages(profile, sessionId, limit);
    },
    async sendMessage(botId, sessionId, text, options) {
      const { adapter, profile } = resolveBot(botId);
      return adapter.sendMessage(profile, sessionId, text, options);
    },
    async interruptSession(botId, sessionId) {
      const { adapter, profile } = resolveBot(botId);
      return adapter.interruptSession(profile, sessionId);
    },
    async respondRequest(botId, sessionId, input) {
      const { adapter, profile } = resolveBot(botId);
      return adapter.respondRequest(profile, sessionId, input);
    },
    async subscribeSession(botId, sessionId, options) {
      const { adapter, profile } = resolveBot(botId);
      return adapter.subscribeSession(profile, sessionId, options);
    },
  };
}

export const layerLive = Layer.effect(
  PaService,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const store = new PaStore(config.stateDir);
    const hermes = new HermesPaAdapter(store);
    const adapters: ReadonlyArray<PaAdapter> = [hermes];
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        for (const adapter of adapters) {
          adapter.dispose?.();
        }
      }),
    );
    return createPaService(adapters);
  }),
);
