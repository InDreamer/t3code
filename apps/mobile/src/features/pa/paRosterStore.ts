import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import { paCreatableInstances } from "@t3tools/client-runtime/pa/roster";
import type { PaBotSummary, PaCapabilities, PaInstanceStatus } from "@t3tools/contracts";
import { msg } from "gt-react-native";
import { useEffect, useSyncExternalStore } from "react";
import { AppState } from "react-native";

import { m } from "../../i18n/messages";
import { workspaceConnections } from "../../state/workspace";
import { paCreateBotPermissionAtom, paClient, paErrorMessage } from "./paApi";

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
}

const EMPTY_ENTRY: PaRosterEntry = {
  instances: [],
  bots: [],
  loading: true,
  refreshing: false,
  error: null,
  loadedAt: null,
};

let entries: ReadonlyMap<string, PaRosterEntry> = new Map();
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

export function clearPaRosterEnvironment(environmentId: string) {
  inFlight.delete(environmentId);
  const next = new Map(entries);
  if (!next.delete(environmentId)) return;
  entries = next;
  for (const listener of listeners) listener();
}

export function readPaRosterEntry(environmentId: string): PaRosterEntry {
  return entries.get(environmentId) ?? EMPTY_ENTRY;
}

/** Reads one environment's roster again; concurrent asks share one read. */
export function refreshPaRoster(environmentId: string): Promise<void> {
  const running = inFlight.get(environmentId);
  if (running) return running;
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
        if (inFlight.get(environmentId) !== read) return;
        setEntry(environmentId, () => ({
          instances: result.instances,
          bots: result.bots,
          loading: false,
          refreshing: false,
          error: null,
          loadedAt: Date.now(),
        }));
      },
      (error: unknown) => {
        if (inFlight.get(environmentId) !== read) return;
        setEntry(environmentId, (entry) => ({
          ...entry,
          loading: false,
          refreshing: false,
          error: paErrorMessage(error, m(msg("Could not load bots"))),
        }));
      },
    )
    .finally(() => {
      if (inFlight.get(environmentId) === read) inFlight.delete(environmentId);
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
  const stale = inFlight.delete(environmentId);
  setEntry(environmentId, (entry) => ({
    ...entry,
    bots: entry.bots.map((bot) => (bot.botId === botId ? { ...bot, ...patch } : bot)),
  }));
  if (stale) void refreshPaRoster(environmentId);
}

export function addPaBot(environmentId: string, bot: PaBotSummary) {
  if (!entries.has(environmentId)) return;
  inFlight.delete(environmentId);
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
    if (readPaRosterEntry(environmentId).loadedAt === null) void refreshPaRoster(environmentId);
  }, [environmentId]);
  const bot = entry.bots.find((item) => item.botId === botId) ?? null;
  const capabilities: PaCapabilities | null =
    (bot && entry.instances.find((item) => item.instanceId === bot.instanceId)?.capabilities) ??
    null;
  return { bot, capabilities, instances: entry.instances, entry };
}

/** Keeps the given environments' rosters current: now, and whenever the app comes back. */
export function usePaRosterRefresh(environmentIds: ReadonlyArray<string>) {
  const key = environmentIds.join("\u0000");
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the engines change Bots outside this app, so rosters reread on mount and on return to the foreground
  useEffect(() => {
    const ids = key ? key.split("\u0000") : [];
    for (const id of ids) void refreshPaRoster(id);
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") for (const id of ids) void refreshPaRoster(id);
    });
    return () => subscription.remove();
  }, [key]);
}

export function refreshPaRosters(environmentIds: ReadonlyArray<string>) {
  return Promise.all(environmentIds.map(refreshPaRoster)).then(() => undefined);
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
