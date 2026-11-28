import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import { paErrorReason } from "@t3tools/client-runtime/pa/environment";
import {
  PA_ROSTER_REFRESH_MS,
  paCreatableInstances,
  reconcilePaRoster,
} from "@t3tools/client-runtime/pa/roster";
import {
  EnvironmentAuthorizationError,
  EnvironmentId,
  type PaBotSummary,
  type PaCapabilities,
  type PaInstanceStatus,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { msg } from "gt-react-native";
import { useEffect, useSyncExternalStore } from "react";

import { m } from "../../i18n/messages";
import { workspaceConnections } from "../../state/workspace";
import { paCache, paCreateBotPermissionAtom, paClient, paErrorMessage } from "./paApi";

const isAuthorizationError = Schema.is(EnvironmentAuthorizationError);
const removedBotListeners = new Set<(environmentId: string, botId: string) => void>();

export function onPaBotsRemoved(listener: (environmentId: string, botId: string) => void) {
  removedBotListeners.add(listener);
  return () => {
    removedBotListeners.delete(listener);
  };
}

function notifyBotRemoved(environmentId: string, botId: string) {
  for (const listener of removedBotListeners) listener(environmentId, botId);
}

/** One environment's Bot roster as last read. */
export interface PaRosterEntry {
  readonly instances: ReadonlyArray<PaInstanceStatus>;
  readonly bots: ReadonlyArray<PaBotSummary>;
  /** Never read yet: nothing to show. */
  readonly loading: boolean;
  /** Reading again over what is shown. */
  readonly refreshing: boolean;
  readonly error: string | null;
  readonly loadedAt: number | null;
  /** True when restored from disk cache and awaiting a live roster read. */
  readonly stale?: boolean;
}

const EMPTY_ENTRY: PaRosterEntry = {
  instances: [],
  bots: [],
  loading: true,
  refreshing: false,
  error: null,
  loadedAt: null,
  stale: false,
};

let entries: ReadonlyMap<string, PaRosterEntry> = new Map();
const lastSessionsByEnvironment = new Map<string, Record<string, string>>();
const hydratedEnvironments = new Set<string>();
const dirty = new Set<string>();
const inFlight = new Map<string, Promise<void>>();
const listeners = new Set<() => void>();

function setEntry(environmentId: string, update: (entry: PaRosterEntry) => PaRosterEntry) {
  const next = new Map(entries);
  next.set(environmentId, update(entries.get(environmentId) ?? EMPTY_ENTRY));
  entries = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const getEntries = () => entries;

function persistRosterSnapshot(environmentId: string) {
  const entry = entries.get(environmentId);
  if (!entry || entry.loadedAt === null || entry.stale) return;
  const lastSessionByBot = lastSessionsByEnvironment.get(environmentId) ?? {};
  void paCache
    ?.saveRoster(EnvironmentId.make(environmentId), {
      result: { instances: entry.instances, bots: entry.bots },
      lastSessionByBot,
      lastBotId: null,
    })
    .catch(() => undefined);
}

/** Hydrates one environment's persisted roster so Bots paint before the network answers. */
export function hydratePaRoster(environmentId: string): void {
  if (hydratedEnvironments.has(environmentId) || entries.has(environmentId)) return;
  hydratedEnvironments.add(environmentId);
  void paCache
    ?.loadRoster(EnvironmentId.make(environmentId))
    .then((cached) => {
      if (!cached) return;
      const existingSessions = lastSessionsByEnvironment.get(environmentId) ?? {};
      lastSessionsByEnvironment.set(environmentId, {
        ...cached.lastSessionByBot,
        ...existingSessions,
      });
      if (entries.get(environmentId)?.loadedAt !== null && entries.has(environmentId)) return;
      setEntry(environmentId, (entry) =>
        entry.loadedAt !== null
          ? entry
          : {
              instances: cached.result.instances,
              bots: cached.result.bots,
              loading: false,
              refreshing: entry.refreshing,
              error: null,
              loadedAt: cached.savedAt,
              stale: true,
            },
      );
    })
    .catch(() => undefined);
}

export function rememberPaBotSession(environmentId: string, botId: string, sessionId: string) {
  const current = lastSessionsByEnvironment.get(environmentId) ?? {};
  if (current[botId] === sessionId) return;
  lastSessionsByEnvironment.set(environmentId, { ...current, [botId]: sessionId });
  persistRosterSnapshot(environmentId);
}

export function forgetPaBotSession(environmentId: string, botId: string, sessionId: string) {
  const current = lastSessionsByEnvironment.get(environmentId);
  if (!current || current[botId] !== sessionId) return;
  const next = { ...current };
  delete next[botId];
  lastSessionsByEnvironment.set(environmentId, next);
  persistRosterSnapshot(environmentId);
}

export function getRememberedPaBotSession(environmentId: string, botId: string): string | null {
  return lastSessionsByEnvironment.get(environmentId)?.[botId] ?? null;
}

export function clearPaRosterEnvironment(environmentId: string) {
  paCache?.bumpEnvironmentGeneration(EnvironmentId.make(environmentId));
  inFlight.delete(environmentId);
  dirty.delete(environmentId);
  hydratedEnvironments.delete(environmentId);
  lastSessionsByEnvironment.delete(environmentId);
  const next = new Map(entries);
  if (!next.delete(environmentId)) return;
  entries = next;
  for (const listener of listeners) listener();
}

export function readPaRosterEntry(environmentId: string): PaRosterEntry {
  return entries.get(environmentId) ?? EMPTY_ENTRY;
}

/** Reads one environment's roster again; concurrent asks share one read. */
export function refreshPaRoster(environmentId: string, background = false): Promise<void> {
  hydratePaRoster(environmentId);
  const running = inFlight.get(environmentId);
  if (running) return running;
  if (!background || !entries.has(environmentId))
    setEntry(environmentId, (entry) => ({
      ...entry,
      refreshing: entry.loadedAt !== null,
      loading: entry.loadedAt === null,
      error: null,
    }));
  const read = paClient(environmentId)
    .listBots()
    .then(
      (result) => {
        if (inFlight.get(environmentId) !== read || dirty.has(environmentId)) return;
        const previousBots = entries.get(environmentId)?.bots ?? [];
        const reconciled = reconcilePaRoster(previousBots, result);
        const onlineInstances = new Set(
          result.instances
            .filter((instance) => instance.online)
            .map((instance) => instance.instanceId),
        );
        const currentIds = new Set(reconciled.map((bot) => bot.botId));
        const removedBotIds = previousBots
          .filter((bot) => onlineInstances.has(bot.instanceId) && !currentIds.has(bot.botId))
          .map((bot) => bot.botId);
        if (removedBotIds.length > 0) {
          const remembered = lastSessionsByEnvironment.get(environmentId);
          if (remembered) {
            const nextRemembered = { ...remembered };
            for (const botId of removedBotIds) delete nextRemembered[botId];
            lastSessionsByEnvironment.set(environmentId, nextRemembered);
          }
          for (const botId of removedBotIds) {
            notifyBotRemoved(environmentId, botId);
            void paCache
              ?.removeBotSessions(EnvironmentId.make(environmentId), botId)
              .catch(() => undefined);
          }
        }
        setEntry(environmentId, () => ({
          instances: result.instances,
          bots: reconciled,
          loading: false,
          refreshing: false,
          error: null,
          loadedAt: Date.now(),
          stale: false,
        }));
        persistRosterSnapshot(environmentId);
      },
      (error: unknown) => {
        if (inFlight.get(environmentId) !== read || dirty.has(environmentId)) return;
        if (isAuthorizationError(error) || paErrorReason(error) === "Forbidden") {
          const envId = EnvironmentId.make(environmentId);
          const previousBots = entries.get(environmentId)?.bots ?? [];
          paCache?.bumpEnvironmentGeneration(envId);
          lastSessionsByEnvironment.delete(environmentId);
          for (const bot of previousBots) {
            notifyBotRemoved(environmentId, bot.botId);
          }
          void paCache?.removeEnvironment(envId).catch(() => undefined);
          setEntry(environmentId, () => ({
            instances: [],
            bots: [],
            loading: false,
            refreshing: false,
            error: paErrorMessage(error, m(msg("Could not load bots"))),
            loadedAt: null,
            stale: false,
          }));
          return;
        }
        setEntry(environmentId, (entry) => ({
          ...entry,
          loading: false,
          refreshing: false,
          error: paErrorMessage(error, m(msg("Could not load bots"))),
        }));
      },
    )
    .finally(() => {
      if (inFlight.get(environmentId) !== read) return;
      inFlight.delete(environmentId);
      if (dirty.delete(environmentId)) void refreshPaRoster(environmentId, true);
    });
  inFlight.set(environmentId, read);
  return read;
}

/** Shows a change the engine already accepted until the next read confirms it. */
export function patchPaBot(
  environmentId: string,
  botId: string,
  patch: Partial<
    Pick<
      PaBotSummary,
      | "pinned"
      | "unread"
      | "running"
      | "awaiting"
      | "name"
      | "description"
      | "avatarColor"
      | "avatarShape"
      | "model"
      | "provider"
    >
  >,
) {
  if (!entries.has(environmentId)) return;
  if (inFlight.has(environmentId)) dirty.add(environmentId);
  setEntry(environmentId, (entry) => ({
    ...entry,
    bots: entry.bots.map((bot) => (bot.botId === botId ? { ...bot, ...patch } : bot)),
  }));
}

export function notePaBotActivity(
  environmentId: string,
  botId: string,
  patch?: { running?: true; awaiting?: true },
) {
  if (patch) patchPaBot(environmentId, botId, patch);
  if (inFlight.has(environmentId)) dirty.add(environmentId);
  else void refreshPaRoster(environmentId, true);
}

export function addPaBot(environmentId: string, bot: PaBotSummary) {
  if (!entries.has(environmentId)) return;
  if (inFlight.has(environmentId)) dirty.add(environmentId);
  setEntry(environmentId, (entry) => ({
    ...entry,
    bots: [bot, ...entry.bots.filter((item) => item.botId !== bot.botId)],
  }));
  void refreshPaRoster(environmentId);
}

export function usePaRosterEntries(): ReadonlyMap<string, PaRosterEntry> {
  return useSyncExternalStore(subscribe, getEntries, getEntries);
}

/** One Bot and its engine's capabilities, reading the roster when it was never read. */
export function usePaBot(environmentId: string, botId: string) {
  const entry = usePaRosterEntries().get(environmentId) ?? EMPTY_ENTRY;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a Bot opened from a link reads its environment's roster on its own
  useEffect(() => {
    hydratePaRoster(environmentId);
    const current = readPaRosterEntry(environmentId);
    if (current.loadedAt === null || current.stale)
      void refreshPaRoster(environmentId, current.stale);
  }, [environmentId]);
  const bot = entry.bots.find((item) => item.botId === botId) ?? null;
  const capabilities: PaCapabilities | null =
    (bot && entry.instances.find((item) => item.instanceId === bot.instanceId)?.capabilities) ??
    null;
  return { bot, capabilities, instances: entry.instances, entry };
}

/** The list supplies only its visible, connected environments. */
export function usePaRosterRefresh(environmentIds: ReadonlyArray<string>) {
  const key = environmentIds.join("\u0000");
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a visible list observes turns that continue after their chat feed unmounts
  useEffect(() => {
    if (!key) return;
    const ids = key.split("\u0000");
    const read = () => {
      for (const id of ids) void refreshPaRoster(id, true);
    };
    read();
    const timer = setInterval(read, PA_ROSTER_REFRESH_MS);
    return () => clearInterval(timer);
  }, [key]);
}

export function refreshPaRosters(environmentIds: ReadonlyArray<string>) {
  return Promise.all(environmentIds.map((id) => refreshPaRoster(id))).then(() => undefined);
}

const permittedEnginesAtom = Atom.make((get) =>
  get(workspaceConnections.environmentsAtom).filter(
    (environment) =>
      environment.isEnabled &&
      environment.connectionState === "connected" &&
      get(paCreateBotPermissionAtom(environment.environmentId)),
  ),
);

export function usePaCreateOptions(active = true) {
  const environments = useAtomValue(permittedEnginesAtom);
  const rosters = usePaRosterEntries();
  const ids = JSON.stringify(environments.map((environment) => environment.environmentId));
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a creation entry point may open before the roster tab has read its engines
  useEffect(() => {
    if (!active) return;
    const connected: string[] = JSON.parse(ids);
    for (const id of connected) if (!entries.has(id)) void refreshPaRoster(id);
  }, [active, ids]);
  const engines = environments.flatMap((environment) =>
    paCreatableInstances(rosters.get(environment.environmentId)?.instances ?? []).map(
      (instance) => ({
        key: JSON.stringify([environment.environmentId, instance.instanceId]),
        environmentId: environment.environmentId,
        environmentLabel: environment.environmentLabel,
        instance,
      }),
    ),
  );
  return {
    engines,
    environments: environments.map(({ environmentId, environmentLabel }) => ({
      environmentId,
      environmentLabel,
      entry: rosters.get(environmentId) ?? EMPTY_ENTRY,
    })),
  };
}

export function usePaCreatableEngines(active = true) {
  return usePaCreateOptions(active).engines;
}
