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
