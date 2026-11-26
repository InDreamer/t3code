import type { PaSlashCommand } from "@t3tools/contracts";

/** A command the client runs itself instead of sending it to the engine. */
export type PaClientSlashAction =
  | { readonly kind: "new-session"; readonly title: string }
  | { readonly kind: "interrupt" }
  | { readonly kind: "model-picker"; readonly query: string };

export type PaSlashTab = "common" | "commands" | "skills";

function commandName(text: string): { readonly name: string; readonly arg: string } {
  const [head = "", ...rest] = text.trim().split(/\s+/);
  return { name: head.toLowerCase(), arg: rest.join(" ").trim() };
}

function findCommand(commands: ReadonlyArray<PaSlashCommand>, name: string) {
  return commands.find((command) => command.name.toLowerCase() === name);
}

/** The client action `text` asks for, as the engine's catalog declares it. */
export function parsePaClientSlashAction(
  text: string,
  commands: ReadonlyArray<PaSlashCommand>,
): PaClientSlashAction | null {
  if (!text.trim().startsWith("/")) return null;
  const { name, arg } = commandName(text);
  switch (findCommand(commands, name)?.handling) {
    case "client:new-session":
      return { kind: "new-session", title: arg };
    case "client:interrupt":
      return { kind: "interrupt" };
    case "client:model-picker":
      return { kind: "model-picker", query: arg };
    default:
      return null;
  }
}

/**
 * Every command matching `query` (the token after `/`): exact name, then name prefix, then
 * name substring, then description substring; catalog order breaks ties.
 */
export function rankPaSlashCommands(
  commands: ReadonlyArray<PaSlashCommand>,
  query: string,
): ReadonlyArray<PaSlashCommand> {
  const needle = query.replace(/^\//, "").toLowerCase();
  const scored: Array<{ readonly command: PaSlashCommand; readonly score: number }> = [];
  for (const command of commands) {
    const name = command.name.replace(/^\//, "").toLowerCase();
    let score: number;
    if (!needle) score = 3;
    else if (name === needle) score = 0;
    else if (name.startsWith(needle)) score = 1;
    else if (name.includes(needle)) score = 2;
    else if (command.description.toLowerCase().includes(needle)) score = 3;
    else continue;
    scored.push({ command, score });
  }
  return scored.sort((a, b) => a.score - b.score).map((entry) => entry.command);
}

function groupPaSlashCommands(commands: ReadonlyArray<PaSlashCommand>) {
  const nonSkills = commands.filter((command) => command.group !== "skill");
  const common = nonSkills.filter((command) => command.featured === true);
  return {
    common: common.length > 0 ? common : nonSkills.slice(0, 10),
    commands: nonSkills,
    skills: commands.filter((command) => command.group === "skill"),
  };
}

export function countPaSlashTabs(commands: ReadonlyArray<PaSlashCommand>): {
  readonly common: number;
  readonly commands: number;
  readonly skills: number;
} {
  const groups = groupPaSlashCommands(commands);
  return {
    common: groups.common.length,
    commands: groups.commands.length,
    skills: groups.skills.length,
  };
}

/**
 * With filter characters, searches every command and skill; on a bare `/`, returns the
 * curated slice for `tab` so the popup stays focused.
 */
export function selectPaSlashCommands(
  commands: ReadonlyArray<PaSlashCommand>,
  query: string,
  tab: PaSlashTab,
): ReadonlyArray<PaSlashCommand> {
  if (query.replace(/^\//, "").trim().length > 0) return rankPaSlashCommands(commands, query);
  const groups = groupPaSlashCommands(commands);
  switch (tab) {
    case "common":
      return groups.common.length > 0 ? groups.common : groups.skills;
    case "commands":
      return groups.commands;
    case "skills":
      return groups.skills;
  }
}

/** True when `draft` already names a full command, so Enter should run it rather than complete. */
export function isCompletePaSlashCommand(
  draft: string,
  commands: ReadonlyArray<PaSlashCommand>,
): boolean {
  const { name } = commandName(draft);
  return name.startsWith("/") && name.length >= 2 && findCommand(commands, name) !== undefined;
}
