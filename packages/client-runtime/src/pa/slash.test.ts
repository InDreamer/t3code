import type { PaSlashCommand } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  countPaSlashTabs,
  isCompletePaSlashCommand,
  parsePaClientSlashAction,
  rankPaSlashCommands,
  selectPaSlashCommands,
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

  it("curates featured, all commands and skills on a bare /, and searches across all of them", () => {
    expect(countPaSlashTabs(catalog)).toEqual({ common: 3, commands: 6, skills: 31 });
    expect(selectPaSlashCommands(catalog, "", "common").map((c) => c.name)).toEqual([
      "/new",
      "/model",
      "/status",
    ]);
    expect(selectPaSlashCommands(catalog, "", "commands").map((c) => c.name)).toEqual([
      "/new",
      "/model",
      "/status",
      "/clear",
      "/stop",
      "/logs",
    ]);
    expect(selectPaSlashCommands(catalog, "", "skills")).toHaveLength(31);
    expect(selectPaSlashCommands(catalog, "renew", "common").map((c) => c.name)).toEqual([
      "/renew-news",
    ]);
    // Without featured commands the common tab falls back to the first commands.
    expect(
      selectPaSlashCommands([command("/a", "a"), command("/b", "b")], "", "common").map(
        (c) => c.name,
      ),
    ).toEqual(["/a", "/b"]);
  });
});
