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

export function loadPaBots(quiet: boolean): Promise<void> {
  if (loadInFlight) return loadInFlight;
  emit({
    ...snapshot,
    loading: !quiet && !hasLoadedOnce,
    refreshing: quiet || hasLoadedOnce,
    error: null,
  });
  loadInFlight = paApi
    .listBots()
    .then((data) => {
      hasLoadedOnce = true;
      emit({
        ...snapshot,
        instances: data.instances,
        bots: data.bots,
        loading: false,
        refreshing: false,
        error: null,
        nowMs: Date.now(),
      });
    })
    .catch((err) => {
      emit({
        ...snapshot,
        loading: false,
        refreshing: false,
        error: paErrorMessage(err, m(msg("Could not load bots"))),
      });
    })
    .finally(() => {
      loadInFlight = null;
    });
  return loadInFlight;
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

let activeVisibilitySubscribers = 0;
let removeVisibilityListener: (() => void) | null = null;

export function usePaBotsStore(): PaBotsStoreSnapshot {
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- triggers initial PA roster fetch and refreshes when the browser tab regains visibility
  useEffect(() => {
    void loadPaBots(hasLoadedOnce);
    activeVisibilitySubscribers += 1;
    if (activeVisibilitySubscribers === 1) {
      const onVisible = () => {
        if (document.visibilityState === "visible") {
          void loadPaBots(true);
        }
      };
      document.addEventListener("visibilitychange", onVisible);
      removeVisibilityListener = () => document.removeEventListener("visibilitychange", onVisible);
    }
    return () => {
      activeVisibilitySubscribers = Math.max(0, activeVisibilitySubscribers - 1);
      if (activeVisibilitySubscribers === 0 && removeVisibilityListener) {
        removeVisibilityListener();
        removeVisibilityListener = null;
      }
    };
  }, []);

  return state;
}
