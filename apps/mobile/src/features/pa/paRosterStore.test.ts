import type { PaBotSummary } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import type { PaClient } from "./paApi";
import { addPaBot, patchPaBot, readPaRosterEntry, refreshPaRoster } from "./paRosterStore";

const { listBots } = vi.hoisted(() => ({ listBots: vi.fn<PaClient["listBots"]>() }));
vi.mock("./paApi", () => ({ paClient: () => ({ listBots }) }));
vi.mock("react-native", () => ({ AppState: {} }));
vi.mock("../../state/workspace", () => ({ workspaceConnections: {} }));
vi.mock("../../i18n/messages", () => ({ m: String }));

it("preserves an accepted create and metadata patch over older roster reads", async () => {
  const bot: PaBotSummary = {
    botId: "one",
    instanceId: "engine",
    driver: "hermes",
    engineLabel: "Hermes",
    agentRef: "one",
    name: "One",
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
  };
  const initial = Promise.withResolvers<Awaited<ReturnType<PaClient["listBots"]>>>();
  const afterCreate = Promise.withResolvers<Awaited<ReturnType<PaClient["listBots"]>>>();
  const afterPatch = Promise.withResolvers<Awaited<ReturnType<PaClient["listBots"]>>>();
  listBots
    .mockReturnValueOnce(initial.promise)
    .mockReturnValueOnce(afterCreate.promise)
    .mockReturnValueOnce(afterPatch.promise);
  const stale = refreshPaRoster("env");
  addPaBot("env", bot);
  initial.resolve({ bots: [], instances: [] });
  await stale;
  expect(readPaRosterEntry("env").bots).toEqual([bot]);
  const stalePatch = refreshPaRoster("env");
  patchPaBot("env", bot.botId, { pinned: true });
  afterCreate.resolve({ bots: [bot], instances: [] });
  await stalePatch;
  expect(readPaRosterEntry("env").bots[0]?.pinned).toBe(true);
  const latest = refreshPaRoster("env");
  afterPatch.resolve({ bots: [{ ...bot, pinned: true }], instances: [] });
  await latest;
  expect(readPaRosterEntry("env").refreshing).toBe(false);
});
