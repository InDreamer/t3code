// @effect-diagnostics globalDate:off - Local calendar dates for roster rows, computed outside an Effect runtime.
import type { PaBotSummary, PaInstanceStatus, PaListBotsResult } from "@t3tools/contracts";
import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";

/** Pinned Bots show as large avatars; more than this would push the list off screen. */
const PA_MAX_PINNED_SHOWN = 6;

export const PA_ROSTER_REFRESH_MS = 5_000;

/** Offline instances cannot confirm deletions, including after their server restarts. */
export function reconcilePaRoster(previous: ReadonlyArray<PaBotSummary>, result: PaListBotsResult) {
  const offline = new Set(
    result.instances.filter((instance) => !instance.online).map((instance) => instance.instanceId),
  );
  if (!offline.size && result.bots.every((bot) => bot.online)) return result.bots;
  const cached = new Map(previous.map((bot) => [bot.botId, bot]));
  const listed = new Set(result.bots.map((bot) => bot.botId));
  const retained = previous.filter((bot) => offline.has(bot.instanceId) && !listed.has(bot.botId));
  const bots = result.bots.map((bot) => {
    if (bot.online && !offline.has(bot.instanceId)) return bot;
    const saved = cached.get(bot.botId);
    return saved
      ? {
          ...bot,
          online: false,
          name: saved.name,
          avatarColor: saved.avatarColor,
          avatarShape: saved.avatarShape,
          pinned: saved.pinned,
          description: saved.description,
          model: saved.model,
          provider: saved.provider,
        }
      : bot;
  });
  return [...bots, ...retained.map((bot) => ({ ...bot, online: false }))];
}

export function paBotStatusLabels(bot: PaBotSummary, resolve: MFunctionType = mFallback) {
  return [
    !bot.online
      ? resolve(msg("Offline"))
      : bot.awaiting
        ? resolve(msg("Waiting for input"))
        : bot.running
          ? resolve(msg("Working"))
          : resolve(msg("Online")),
    bot.unread && (!bot.running || bot.awaiting) ? resolve(msg("Unread")) : null,
    bot.isDefault ? resolve(msg("Default bot")) : null,
  ].filter((label) => label !== null);
}

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

const pad2 = (value: number) => String(value % 100).padStart(2, "0");

/** How a roster row dates its last activity: a fixed-width local `YY/MM/DD`, empty when unknown. */
export function formatPaRosterTime(timestamp: number | null): string {
  if (!timestamp) return "";
  const date = new Date(timestamp);
  return `${pad2(date.getFullYear())}/${pad2(date.getMonth() + 1)}/${pad2(date.getDate())}`;
}
