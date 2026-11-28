// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeOS from "node:os";
// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { PaStore } from "./PaStore.ts";

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) NodeFS.rmSync(dir, { recursive: true, force: true });
});

const makeStore = () => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-pa-store-"));
  tempDirs.push(dir);
  return { dir, store: new PaStore(dir) };
};

describe("PaStore", () => {
  it("backs up unparseable JSON instead of silently wiping user state", () => {
    const { dir, store } = makeStore();
    NodeFS.writeFileSync(NodePath.join(dir, "pa-bots.json"), "{corrupt json", "utf8");
    expect(store.getBotMeta("hermes:default")).toEqual({});
    const backups = NodeFS.readdirSync(dir).filter((f) => f.startsWith("pa-bots.json.corrupt-"));
    expect(backups).toHaveLength(1);
    expect(NodeFS.readFileSync(NodePath.join(dir, backups[0]!), "utf8")).toBe("{corrupt json");
  });

  it("backs up structurally invalid JSON and keeps only well-typed fields", () => {
    const { dir, store } = makeStore();
    const file = NodePath.join(dir, "pa-bots.json");
    const raw = JSON.stringify({
      version: 1,
      bots: {
        "hermes:a": { displayName: "A", pinned: "yes", lastReadAt: 5, avatarShape: "hexagon" },
        "hermes:b": "not an object",
      },
    });
    NodeFS.writeFileSync(file, raw, "utf8");
    expect(store.getBotMeta("hermes:a")).toEqual({ displayName: "A", lastReadAt: 5 });
    expect(store.getBotMeta("hermes:b")).toEqual({});
    const backups = NodeFS.readdirSync(dir).filter((f) => f.startsWith("pa-bots.json.corrupt-"));
    expect(backups).toHaveLength(1);

    const { dir: dir2, store: store2 } = makeStore();
    NodeFS.writeFileSync(NodePath.join(dir2, "pa-bots.json"), JSON.stringify({ bots: [] }), "utf8");
    expect(store2.getBotMeta("hermes:a")).toEqual({});
    expect(NodeFS.readdirSync(dir2).some((f) => f.includes(".corrupt-"))).toBe(true);
  });

  it("keeps hermes:<profile> metadata written by earlier versions", () => {
    const { dir, store } = makeStore();
    NodeFS.writeFileSync(
      NodePath.join(dir, "pa-bots.json"),
      JSON.stringify({
        version: 1,
        bots: { "hermes:feedbot": { displayName: "Feed", pinned: true, primarySessionId: "s-9" } },
      }),
      "utf8",
    );
    expect(store.getBotMeta("hermes:feedbot")).toEqual({
      displayName: "Feed",
      pinned: true,
      primarySessionId: "s-9",
    });
    store.updateBotMeta("hermes:feedbot", { lastReadAt: 42 });
    expect(new PaStore(dir).getBotMeta("hermes:feedbot")).toMatchObject({
      displayName: "Feed",
      lastReadAt: 42,
    });
  });
});

it("joins completion and transcript identities without reopening an acknowledged reply", () => {
  const { dir, store } = makeStore();
  const bot = "hermes:bot";
  store.rememberReplies(bot, [{ sessionId: "tip", ids: ["row-10"], timestamp: 30 }], "history");
  store.updateBotMeta(bot, store.readPatch(bot, 35, { sessionId: "tip", id: "row-10" }));
  store.rememberReplies(bot, [{ sessionId: "tip", ids: ["admission:1"], timestamp: 40 }], "feed");
  store.rememberReplies(
    bot,
    [{ sessionId: "tip", ids: ["admission:1", "row-10"], timestamp: 50 }],
    "feed",
  );
  expect(new PaStore(dir).getBotMeta(bot).replies).toEqual([
    {
      sessionId: "tip",
      ids: ["row-10", "admission:1"],
      timestamp: 30,
      read: true,
    },
  ]);
});

it("reads through the transcript row at the same millisecond in its canonical session", () => {
  const { store } = makeStore();
  const bot = "hermes:a";
  const reply = (sessionId: string, row: number) => ({
    sessionId,
    ids: ["row-" + row],
    timestamp: 80,
  });
  store.rememberReplies(
    bot,
    [reply("alias", 8), reply("owner", 7), reply("owner", 9), reply("other", 6)],
    "history",
  );
  store.bindReplySession(bot, "alias", "owner");
  store.updateBotMeta(bot, store.readPatch(bot, 90, { sessionId: "owner", id: "row-8" }));
  expect(
    store
      .getBotMeta(bot)
      .replies?.filter((r) => !r.read)
      .map((r) => r.ids[0]),
  ).toEqual(["row-9", "row-6"]);
});

it("bounds 700 durable replies and aliases and ignores evicted replays without rewriting the file", () => {
  const { store, dir } = makeStore();
  const bot = "hermes:bot";
  const sessionId = "owner";
  const replies = Array.from({ length: 700 }, (_, i) => ({
    sessionId,
    ids: ["row-" + (i + 1), "turn:" + i],
    timestamp: i + 1,
  }));
  for (const reply of replies) store.rememberReplies(bot, [reply], "history");
  store.updateBotMeta(bot, store.readPatch(bot, 701, { sessionId, id: "row-700" }));
  store.rememberReplies(
    bot,
    [
      {
        ...replies[699]!,
        ids: ["row-700", ...Array.from({ length: 200 }, (_, i) => "alias:" + i)],
      },
    ],
    "feed",
  );
  const file = NodePath.join(dir, "pa-bots.json");
  expect(NodeFS.statSync(file).size).toBeLessThan(20_000);
  const restarted = new PaStore(dir);
  expect(restarted.getBotMeta(bot).replies!.length).toBeLessThanOrEqual(50);
  expect(restarted.getBotMeta(bot).replies!.every((reply) => reply.ids.length <= 8)).toBe(true);
  const inode = NodeFS.statSync(file).ino;
  restarted.rememberReplies(bot, [{ ...replies[0]!, timestamp: 900 }], "feed");
  expect(
    restarted.rememberReplies(bot, [{ sessionId, ids: ["turn:0"], timestamp: 901 }], "feed"),
  ).toBe(false);
  restarted.rememberReplies(bot, replies, "history");
  restarted.updateBotMeta(bot, restarted.readPatch(bot, 902, { sessionId, id: "row-700" }));
  expect(restarted.getBotMeta(bot).replies!.some((reply) => !reply.read)).toBe(false);
  expect(NodeFS.statSync(file).ino).toBe(inode);
});

it("migrates legacy cursor-only completions and carries read watermarks to the canonical owner", () => {
  const { store, dir } = makeStore();
  const bot = "hermes:a";
  NodeFS.writeFileSync(
    NodePath.join(dir, "pa-bots.json"),
    JSON.stringify({
      version: 1,
      bots: {
        [bot]: {
          replies: [
            { sessionId: "segment", ids: ["row-7", '["ep",1]'], timestamp: 77, read: true },
            { sessionId: "segment", ids: ['["ep",2]'], timestamp: 90, read: false },
          ],
        },
      },
    }),
  );
  store.bindReplySession(bot, "segment", "owner");
  store.rememberReplies(bot, [{ sessionId: "owner", ids: ["row-5"], timestamp: 120 }], "feed");
  expect(new PaStore(dir).getBotMeta(bot)).toMatchObject({
    replies: [{ sessionId: "owner", ids: ["row-7"], read: true }],
    progress: [{ sessionId: "owner", read: { id: "row-7", timestamp: 77 } }],
  });
});
