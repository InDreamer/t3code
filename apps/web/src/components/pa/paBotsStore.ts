import { PA_ROSTER_REFRESH_MS, reconcilePaRoster } from "@t3tools/client-runtime/pa/roster";
import { getDocumentActivity, subscribeDocumentActivity } from "../../lib/documentActivity";
import { msg } from "gt-react";
import { useEffect, useSyncExternalStore } from "react";

import { m } from "../../i18n/messages";
import { paApi, paErrorMessage } from "./paApi";
import type { PaBotSummary, PaInstanceStatus } from "@t3tools/contracts";

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
};

let snapshot: PaBotsStoreSnapshot = INITIAL_SNAPSHOT;
let hasLoadedOnce = false;
let rosterRevision = 0;
let loadInFlight: Promise<void> | null = null;
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

export function loadPaBots(quiet: boolean, background = false): Promise<void> {
  if (loadInFlight) return loadInFlight;
  const revision = rosterRevision;
  if (!background)
    emit({
      ...snapshot,
      loading: !quiet && !hasLoadedOnce,
      refreshing: quiet || hasLoadedOnce,
      error: null,
    });
  const read = paApi
    .listBots()
    .then((data) => {
      if (revision !== rosterRevision) return;
      hasLoadedOnce = true;
      emit({
        ...snapshot,
        instances: data.instances,
        bots: reconcilePaRoster(snapshot.bots, data),
        loading: false,
        refreshing: false,
        error: null,
        nowMs: Date.now(),
      });
    })
    .catch((err) => {
      if (revision !== rosterRevision) return;
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

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- visible PA surfaces share one roster read for turns that continue after chat unmounts
  useEffect(() => {
    if (active) return holdRoster();
  }, [active]);

  return state;
}
