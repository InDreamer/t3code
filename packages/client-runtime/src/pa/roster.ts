// @effect-diagnostics globalDate:off - Local calendar-day labels for roster rows, computed outside an Effect runtime.
import type { PaBotSummary, PaInstanceStatus } from "@t3tools/contracts";
import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";

/** Pinned Bots show as large avatars; more than this would push the list off screen. */
const PA_MAX_PINNED_SHOWN = 6;

/** Bots whose name, agent, description or last message contains `query`. */
export function filterPaBots<Bot extends PaBotSummary>(
  bots: ReadonlyArray<Bot>,
  query: string,
): ReadonlyArray<Bot> {
  const needle = query.trim().toLowerCase();
  if (!needle) return bots;
  return bots.filter(
    (bot) =>
      bot.name.toLowerCase().includes(needle) ||
      bot.agentRef.toLowerCase().includes(needle) ||
      bot.description.toLowerCase().includes(needle) ||
      (bot.lastMessagePreview ?? "").toLowerCase().includes(needle),
  );
}

/** Splits the roster into the pinned shortcuts and the rest, keeping the engine's order. */
export function groupPaBots<Bot extends PaBotSummary>(
  bots: ReadonlyArray<Bot>,
): { readonly pinned: ReadonlyArray<Bot>; readonly others: ReadonlyArray<Bot> } {
  const pinned = bots.filter((bot) => bot.pinned).slice(0, PA_MAX_PINNED_SHOWN);
  const shown = new Set(pinned);
  return { pinned, others: bots.filter((bot) => !shown.has(bot)) };
}

/** The Bot a page without a pick opens: the one asked for, the last one, the default, the first. */
export function resolveActivePaBot<Bot extends PaBotSummary>(
  bots: ReadonlyArray<Bot>,
  requested: string | null | undefined,
  last: string | null | undefined,
): Bot | null {
  return (
    (requested ? bots.find((bot) => bot.botId === requested) : undefined) ??
    (last ? bots.find((bot) => bot.botId === last) : undefined) ??
    bots.find((bot) => bot.isDefault) ??
    bots[0] ??
    null
  );
}

/** The row's second line when the Bot has said nothing yet. */
export function paBotPreview(bot: PaBotSummary): string {
  return (
    bot.lastMessagePreview || bot.description || `${bot.engineLabel} · ${bot.model || bot.agentRef}`
  );
}

export function paOfflineInstances(
  instances: ReadonlyArray<PaInstanceStatus>,
): ReadonlyArray<PaInstanceStatus> {
  return instances.filter((instance) => !instance.online);
}

/** Engines that can create Bots, online ones first as the form preselects the first. */
export function paCreatableInstances(
  instances: ReadonlyArray<PaInstanceStatus>,
): ReadonlyArray<PaInstanceStatus> {
  return instances
    .filter((instance) => instance.capabilities.lifecycle.create)
    .sort((a, b) => Number(b.online) - Number(a.online));
}

/** The agent id a create form submits: the typed id, else one derived from the name. */
export function derivePaAgentSlug(agentRef: string, name: string): string {
  return (agentRef || name)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[^a-z0-9]+|-+$/g, "")
    .slice(0, 64);
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How a roster row dates its last activity: the time today, "Yesterday", a weekday within the
 * week, else month/day. Times are formatted by the caller in the host's locale.
 */
export function formatPaRosterTime(
  timestamp: number | null,
  nowMs: number,
  formatTime: (date: Date) => string,
  resolve: MFunctionType = mFallback,
): string {
  if (!timestamp) return "";
  const now = new Date(nowMs);
  const target = new Date(timestamp);
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfTarget = new Date(
    target.getFullYear(),
    target.getMonth(),
    target.getDate(),
  ).getTime();
  const dayDiff = Math.round((startOfToday - startOfTarget) / DAY_MS);
  if (dayDiff === 0) return formatTime(target);
  if (dayDiff === 1) return resolve(msg("Yesterday"));
  if (dayDiff > 1 && dayDiff < 7) {
    const weekdays = [
      msg("Sun"),
      msg("Mon"),
      msg("Tue"),
      msg("Wed"),
      msg("Thu"),
      msg("Fri"),
      msg("Sat"),
    ];
    return resolve(weekdays[target.getDay()]!);
  }
  return resolve(msg("{month}/{day}", { month: target.getMonth() + 1, day: target.getDate() }));
}
