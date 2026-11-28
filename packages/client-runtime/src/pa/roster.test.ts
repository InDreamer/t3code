// @effect-diagnostics globalDate:off - Fixtures in local calendar time, matching what the roster labels.
import type { PaBotSummary } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  derivePaAgentSlug,
  filterPaBots,
  paBotStatusLabels,
  formatPaRosterTime,
  groupPaBots,
  resolveActivePaBot,
} from "./roster.ts";

const bot = (botId: string, patch: Partial<PaBotSummary> = {}): PaBotSummary => ({
  botId,
  instanceId: "hermes",
  driver: "hermes",
  engineLabel: "Hermes",
  agentRef: botId.split(":")[1] ?? botId,
  name: botId,
  description: "",
  avatarColor: "#14b8a6",
  avatarShape: "blob",
  pinned: false,
  isDefault: false,
  model: null,
  provider: null,
  online: true,
  running: false,
  unread: false,
  lastMessagePreview: null,
  lastActivityAt: null,
  primarySessionId: null,
  ...patch,
});

describe("PA roster", () => {
  it("searches previews and caps the pinned shortcuts", () => {
    const bots = [
      bot("hermes:news", { lastMessagePreview: "Daily AI digest" }),
      ...Array.from({ length: 7 }, (_, i) => bot(`hermes:p${i}`, { pinned: true })),
    ];
    expect(filterPaBots(bots, " digest ").map((b) => b.botId)).toEqual(["hermes:news"]);
    const { pinned, others } = groupPaBots(bots);
    expect(pinned).toHaveLength(6);
    expect(others.map((b) => b.botId)).toEqual(["hermes:news", "hermes:p6"]);
  });

  it("opens the requested Bot, then the last one, then the default", () => {
    const bots = [bot("hermes:a"), bot("hermes:b", { isDefault: true }), bot("hermes:c")];
    expect(resolveActivePaBot(bots, "hermes:c", "hermes:a")?.botId).toBe("hermes:c");
    expect(resolveActivePaBot(bots, "hermes:gone", "hermes:a")?.botId).toBe("hermes:a");
    expect(resolveActivePaBot(bots, null, "hermes:gone")?.botId).toBe("hermes:b");
    expect(resolveActivePaBot([], null, null)).toBeNull();
  });

  it("derives an agent id the engine accepts", () => {
    expect(derivePaAgentSlug("", "  Research Assistant! ")).toBe("research-assistant");
    expect(derivePaAgentSlug("--News_Bot--", "ignored")).toBe("news_bot");
    expect(derivePaAgentSlug("", "!!!")).toBe("");
  });

  it("dates activity by calendar day", () => {
    const now = new Date(2026, 10, 27, 9, 0).getTime();
    const at = (day: number, hour = 12) => new Date(2026, 10, day, hour).getTime();
    const time = () => "TIME";
    expect(formatPaRosterTime(at(27, 1), now, time)).toBe("TIME");
    expect(formatPaRosterTime(at(26, 23), now, time)).toBe("Yesterday");
    expect(formatPaRosterTime(at(24), now, time)).toBe("Tue");
    expect(formatPaRosterTime(at(2), now, time)).toBe("11/2");
    expect(formatPaRosterTime(null, now, time)).toBe("");
  });
});

it("announces the same priority as the avatar on old and new rosters", () => {
  expect(paBotStatusLabels(bot("one", { running: true, unread: true, isDefault: true }))).toEqual([
    "Working",
    "Default bot",
  ]);
  expect(paBotStatusLabels(bot("one", { running: true, awaiting: true, unread: true }))).toEqual([
    "Waiting for input",
    "Unread",
  ]);
});
