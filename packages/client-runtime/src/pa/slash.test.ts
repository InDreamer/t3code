import type { PaSlashCommand } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  isCompletePaSlashCommand,
  parsePaClientSlashAction,
  rankPaSlashCommands,
} from "./slash.ts";

const command = (
  name: string,
  description: string,
  patch: Partial<PaSlashCommand> = {},
): PaSlashCommand => ({
  name,
  description,
  group: "command",
  handling: "engine",
  requiredScope: "operate",
  ...patch,
});

const catalog: ReadonlyArray<PaSlashCommand> = [
  command("/new", "Start a new session", { handling: "client:new-session", featured: true }),
  command("/model", "Switch model", { handling: "client:model-picker", featured: true }),
  command("/status", "Show session status", { featured: true }),
  command("/clear", "Start fresh", { handling: "client:new-session" }),
  command("/stop", "Stop the turn", { handling: "client:interrupt" }),
  command("/logs", "Tail plugin logs", { group: "plugin", requiredScope: "manage" }),
  command("/renew-news", "Daily news digest", { group: "skill", requiredScope: "manage" }),
  ...Array.from({ length: 30 }, (_, i) =>
    command(`/skill-${i}`, `Skill number ${i}`, { group: "skill" }),
  ),
];

describe("PA slash commands", () => {
  it("runs the commands the catalog marks client-handled on the client", () => {
    expect(parsePaClientSlashAction("/new", catalog)).toEqual({ kind: "new-session", title: "" });
    expect(parsePaClientSlashAction("  /NEW  Weekly notes ", catalog)).toEqual({
      kind: "new-session",
      title: "Weekly notes",
    });
    expect(parsePaClientSlashAction("/stop", catalog)).toEqual({ kind: "interrupt" });
    expect(parsePaClientSlashAction("/model gpt", catalog)).toEqual({
      kind: "model-picker",
      query: "gpt",
    });
    expect(parsePaClientSlashAction("/status", catalog)).toBeNull();
    expect(parsePaClientSlashAction("/newsletter", catalog)).toBeNull();
    expect(parsePaClientSlashAction("hello /new", catalog)).toBeNull();
    expect(parsePaClientSlashAction("/new", [])).toBeNull();
  });

  it("lists every match without a cap, exact and prefix matches first", () => {
    expect(rankPaSlashCommands(catalog, "skill")).toHaveLength(30);
    expect(rankPaSlashCommands(catalog, "new").map((c) => c.name)).toEqual(["/new", "/renew-news"]);
    expect(rankPaSlashCommands(catalog, "digest").map((c) => c.name)).toEqual(["/renew-news"]);
  });

  it("treats a fully typed command as ready to send instead of completing it", () => {
    expect(isCompletePaSlashCommand("/new", catalog)).toBe(true);
    expect(isCompletePaSlashCommand("/status now", catalog)).toBe(true);
    expect(isCompletePaSlashCommand("/sta", catalog)).toBe(false);
    expect(isCompletePaSlashCommand("/", catalog)).toBe(false);
  });

  it("lists featured, commands, plugins, then skills on a bare / and searches them all", () => {
    const names = rankPaSlashCommands(catalog, "").map((c) => c.name);
    expect(names).toHaveLength(catalog.length);
    expect(names.slice(0, 7)).toEqual([
      "/new",
      "/model",
      "/status",
      "/clear",
      "/stop",
      "/logs",
      "/renew-news",
    ]);
    expect(
      rankPaSlashCommands(
        [
          command("/tidy", "Tidy up", { group: "skill" }),
          command("/logs", "Tail logs", { group: "plugin" }),
          command("/help", "Help"),
          command("/digest", "Digest", { group: "skill", featured: true }),
        ],
        "/",
      ).map((c) => c.name),
    ).toEqual(["/digest", "/help", "/logs", "/tidy"]);
    expect(rankPaSlashCommands(catalog, "renew").map((c) => c.name)).toEqual(["/renew-news"]);
    expect(rankPaSlashCommands(catalog, "log").map((c) => c.group)).toEqual(["plugin"]);
  });
});
