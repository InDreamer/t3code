import { paErrorReason } from "@t3tools/client-runtime/pa/environment";
import { PA_ROSTER_REFRESH_MS, reconcilePaRoster } from "@t3tools/client-runtime/pa/roster";
import {
  EnvironmentAuthorizationError,
  EnvironmentId,
  type PaBotSummary,
  type PaInstanceStatus,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { msg } from "gt-react";
import { useEffect, useSyncExternalStore } from "react";

import { getDocumentActivity, subscribeDocumentActivity } from "../../lib/documentActivity";
import { m } from "../../i18n/messages";
import { readPrimaryEnvironmentId, usePrimaryEnvironmentId } from "../../state/environments";
import { paApi, paCache, paErrorMessage } from "./paApi";

const isAuthorizationError = Schema.is(EnvironmentAuthorizationError);
const removedBotListeners = new Set<(environmentId: EnvironmentId, botId: string) => void>();

export function onWebPaBotsRemoved(
  listener: (environmentId: EnvironmentId, botId: string) => void,
) {
  removedBotListeners.add(listener);
  return () => {
    removedBotListeners.delete(listener);
  };
}

function notifyBotRemoved(environmentId: EnvironmentId, botId: string) {
  for (const listener of removedBotListeners) listener(environmentId, botId);
}

interface PaBotsStoreSnapshot {
  readonly instances: ReadonlyArray<PaInstanceStatus>;
  readonly bots: ReadonlyArray<PaBotSummary>;
  readonly loading: boolean;
  readonly refreshing: boolean;
  readonly error: string | null;
  readonly nowMs: number;
  readonly lastBotId: string | null;
  readonly createOpen: boolean;
  readonly settingsBotId: string | null;
  readonly stale: boolean;
}

const INITIAL_SNAPSHOT: PaBotsStoreSnapshot = {
  instances: [],
  bots: [],
  loading: true,
  refreshing: false,
  error: null,
  nowMs: Date.now(),
  lastBotId: null,
  createOpen: false,
  settingsBotId: null,
  stale: false,
};

let snapshot: PaBotsStoreSnapshot = INITIAL_SNAPSHOT;
let hasLoadedOnce = false;
let rosterRevision = 0;
let loadInFlight: Promise<void> | null = null;
let ownerEnvironmentId: EnvironmentId | null = null;
let hydratedEnvironmentId: EnvironmentId | null = null;
const lastSessionsByEnvironment = new Map<string, Record<string, string>>();
const listeners = new Set<() => void>();

function emit(next: PaBotsStoreSnapshot) {
  snapshot = next;
  for (const listener of listeners) {
    listener();
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): PaBotsStoreSnapshot {
  return snapshot;
}

function syncOwnerEnvironment(environmentId: EnvironmentId | null) {
  if (ownerEnvironmentId === environmentId) return;
  ownerEnvironmentId = environmentId;
  hydratedEnvironmentId = null;
  hasLoadedOnce = false;
  rosterRevision += 1;
  loadInFlight = null;
  emit({ ...INITIAL_SNAPSHOT, nowMs: Date.now() });
}

function persistRoster(environmentId: EnvironmentId | null = ownerEnvironmentId) {
  if (!environmentId || ownerEnvironmentId !== environmentId || !hasLoadedOnce || snapshot.stale) {
    return;
  }
  const lastSessionByBot = lastSessionsByEnvironment.get(environmentId) ?? {};
  void paCache
    ?.saveRoster(environmentId, {
      result: { instances: snapshot.instances, bots: snapshot.bots },
      lastSessionByBot,
      lastBotId: snapshot.lastBotId,
    })
    .catch(() => undefined);
}

/** Restores the last confirmed PA roster from IndexedDB so refresh paints bots at once. */
function hydratePaBotsFromCache(environmentId = readPrimaryEnvironmentId()): void {
  if (!environmentId) return;
  syncOwnerEnvironment(environmentId);
  if (hydratedEnvironmentId === environmentId) return;
  hydratedEnvironmentId = environmentId;
  void paCache
    ?.loadRoster(environmentId)
    .then((cached) => {
      if (
        !cached ||
        hydratedEnvironmentId !== environmentId ||
        ownerEnvironmentId !== environmentId
      ) {
        return;
      }
      const existing = lastSessionsByEnvironment.get(environmentId) ?? {};
      lastSessionsByEnvironment.set(environmentId, {
        ...cached.lastSessionByBot,
        ...existing,
      });
      if (hasLoadedOnce) return;
      emit({
        ...snapshot,
        instances: cached.result.instances,
        bots: cached.result.bots,
        loading: false,
        error: null,
        nowMs: cached.savedAt,
        lastBotId: snapshot.lastBotId ?? cached.lastBotId,
        stale: true,
      });
    })
    .catch(() => undefined);
}

export function rememberPaBotSession(environmentId: string, botId: string, sessionId: string) {
  const current = lastSessionsByEnvironment.get(environmentId) ?? {};
  if (current[botId] === sessionId) return;
  lastSessionsByEnvironment.set(environmentId, { ...current, [botId]: sessionId });
  if (ownerEnvironmentId === environmentId) persistRoster(ownerEnvironmentId);
}

export function forgetPaBotSession(environmentId: string, botId: string, sessionId: string) {
  const current = lastSessionsByEnvironment.get(environmentId);
  if (!current || current[botId] !== sessionId) return;
  const next = { ...current };
  delete next[botId];
  lastSessionsByEnvironment.set(environmentId, next);
  if (ownerEnvironmentId === environmentId) persistRoster(ownerEnvironmentId);
}

export function getRememberedPaBotSession(environmentId: string, botId: string): string | null {
  return lastSessionsByEnvironment.get(environmentId)?.[botId] ?? null;
}

export function clearPaBotsEnvironment(environmentId: EnvironmentId): void {
  paCache?.bumpEnvironmentGeneration(environmentId);
  lastSessionsByEnvironment.delete(environmentId);
  const primary = readPrimaryEnvironmentId();
  if (
    ownerEnvironmentId !== environmentId &&
    hydratedEnvironmentId !== environmentId &&
    primary !== environmentId
  ) {
    return;
  }
  ownerEnvironmentId = null;
  hydratedEnvironmentId = null;
  hasLoadedOnce = false;
  rosterRevision += 1;
  loadInFlight = null;
  emit({ ...INITIAL_SNAPSHOT, nowMs: Date.now() });
}

export function loadPaBots(quiet: boolean, background = false): Promise<void> {
  const environmentId = readPrimaryEnvironmentId();
  if (environmentId) hydratePaBotsFromCache(environmentId);
  if (loadInFlight) return loadInFlight;
  const revision = rosterRevision;
  if (!background)
    emit({
      ...snapshot,
      loading: !quiet && !hasLoadedOnce && snapshot.bots.length === 0,
      refreshing: quiet || hasLoadedOnce || snapshot.bots.length > 0,
      error: null,
    });
  const read = paApi
    .listBots()
    .then((data) => {
      if (
        revision !== rosterRevision ||
        (environmentId !== null && readPrimaryEnvironmentId() !== environmentId)
      ) {
        return;
      }
      const targetEnvId = environmentId ?? readPrimaryEnvironmentId();
      if (targetEnvId && ownerEnvironmentId !== targetEnvId) {
        ownerEnvironmentId = targetEnvId;
      }
      const previousBots = snapshot.bots;
      const reconciled = reconcilePaRoster(previousBots, data);
      const onlineInstances = new Set(
        data.instances.filter((instance) => instance.online).map((instance) => instance.instanceId),
      );
      const currentIds = new Set(reconciled.map((bot) => bot.botId));
      const removedBotIds = previousBots
        .filter((bot) => onlineInstances.has(bot.instanceId) && !currentIds.has(bot.botId))
        .map((bot) => bot.botId);
      if (removedBotIds.length > 0 && targetEnvId) {
        const nextSessions = { ...lastSessionsByEnvironment.get(targetEnvId) };
        for (const botId of removedBotIds) {
          delete nextSessions[botId];
          notifyBotRemoved(targetEnvId, botId);
          void paCache?.removeBotSessions(targetEnvId, botId).catch(() => undefined);
        }
        lastSessionsByEnvironment.set(targetEnvId, nextSessions);
      }
      hasLoadedOnce = true;
      emit({
        ...snapshot,
        instances: data.instances,
        bots: reconciled,
        loading: false,
        refreshing: false,
        error: null,
        nowMs: Date.now(),
        stale: false,
      });
      if (targetEnvId) persistRoster(targetEnvId);
    })
    .catch((err) => {
      if (
        revision !== rosterRevision ||
        (environmentId !== null && readPrimaryEnvironmentId() !== environmentId)
      ) {
        return;
      }
      if (isAuthorizationError(err) || paErrorReason(err) === "Forbidden") {
        const targetEnvId = environmentId ?? readPrimaryEnvironmentId();
        const previousBots = snapshot.bots;
        hasLoadedOnce = false;
        if (targetEnvId) {
          paCache?.bumpEnvironmentGeneration(targetEnvId);
          lastSessionsByEnvironment.delete(targetEnvId);
          for (const bot of previousBots) {
            notifyBotRemoved(targetEnvId, bot.botId);
          }
          void paCache?.removeEnvironment(targetEnvId).catch(() => undefined);
        }
        emit({
          ...snapshot,
          instances: [],
          bots: [],
          loading: false,
          refreshing: false,
          error: paErrorMessage(err, m(msg("Could not load bots"))),
          stale: false,
        });
        return;
      }
      emit({
        ...snapshot,
        loading: false,
        refreshing: false,
        error: paErrorMessage(err, m(msg("Could not load bots"))),
      });
    })
    .finally(() => {
      if (loadInFlight !== read) return;
      loadInFlight = null;
      if (rosterRevision !== revision) void loadPaBots(true, true);
    });
  loadInFlight = read;
  return read;
}

export function applyPaBotWrite(bot: PaBotSummary, patch?: Partial<PaBotSummary>) {
  rosterRevision++;
  loadInFlight = null;
  const bots = patch
    ? snapshot.bots.map((current) =>
        current.botId === bot.botId ? { ...current, ...patch } : current,
      )
    : [bot, ...snapshot.bots.filter((current) => current.botId !== bot.botId)];
  emit({ ...snapshot, bots });
  return loadPaBots(true, true);
}

export function notePaBotActivity(botId: string, patch?: { running?: true; awaiting?: true }) {
  rosterRevision++;
  if (patch)
    emit({
      ...snapshot,
      bots: snapshot.bots.map((bot) => (bot.botId === botId ? { ...bot, ...patch } : bot)),
    });
  void loadPaBots(true, true);
}

export function rememberLastPaBotId(botId: string | null): void {
  if (!botId || snapshot.lastBotId === botId) return;
  emit({ ...snapshot, lastBotId: botId });
  persistRoster();
}

export function getLastPaBotId(): string | null {
  return snapshot.lastBotId;
}

export function setPaCreateDialogOpen(open: boolean): void {
  if (snapshot.createOpen === open) return;
  emit({ ...snapshot, createOpen: open });
}

export function setPaSettingsBotId(botId: string | null): void {
  if (snapshot.settingsBotId === botId) return;
  emit({ ...snapshot, settingsBotId: botId });
}

let activeLists = 0;
let stopWatching: (() => void) | undefined;

function holdRoster() {
  if (++activeLists === 1) stopWatching = watchRoster();
  else void loadPaBots(true, true);
  return () => {
    if (--activeLists === 0) stopWatching?.();
  };
}

function watchRoster() {
  let timer: ReturnType<typeof setInterval> | undefined;
  let visible: boolean | undefined;
  const update = () => {
    const next = getDocumentActivity().visible;
    if (visible === next) return;
    visible = next;
    clearInterval(timer);
    if (!visible) return;
    void loadPaBots(hasLoadedOnce, hasLoadedOnce);
    timer = setInterval(() => void loadPaBots(true, true), PA_ROSTER_REFRESH_MS);
  };
  const unsubscribe = subscribeDocumentActivity(update);
  update();
  return () => {
    unsubscribe();
    clearInterval(timer);
  };
}

export function usePaBotsStore(active = true): PaBotsStoreSnapshot {
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const primaryEnvironmentId = usePrimaryEnvironmentId();

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- hydrates persisted PA roster as soon as the primary environment is known so page refresh paints bots at once
  useEffect(() => {
    if (primaryEnvironmentId) hydratePaBotsFromCache(primaryEnvironmentId);
    else syncOwnerEnvironment(null);
  }, [primaryEnvironmentId]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- visible PA surfaces share one roster read for turns that continue after chat unmounts
  useEffect(() => {
    if (active) return holdRoster();
  }, [active]);

  return state;
}
