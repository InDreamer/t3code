import type { PaSlashCommand } from "@t3tools/contracts";

/** A command the client runs itself instead of sending it to the engine. */
export type PaClientSlashAction =
  | { readonly kind: "new-session"; readonly title: string }
  | { readonly kind: "interrupt" }
  | { readonly kind: "model-picker"; readonly query: string };

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

const BARE_SLASH_RANK: Readonly<Record<PaSlashCommand["group"], number>> = {
  command: 1,
  plugin: 2,
  skill: 3,
};

/**
 * Every command matching `query` (the token after `/`) as one list: exact name, then name
 * prefix, then name substring, then description substring. A bare `/` lists featured entries,
 * then commands, plugins and skills. Catalog order breaks ties.
 */
export function rankPaSlashCommands(
  commands: ReadonlyArray<PaSlashCommand>,
  query: string,
): ReadonlyArray<PaSlashCommand> {
  const needle = query.replace(/^\//, "").trim().toLowerCase();
  const scored: Array<{ readonly command: PaSlashCommand; readonly score: number }> = [];
  for (const command of commands) {
    const name = command.name.replace(/^\//, "").toLowerCase();
    let score: number;
    if (!needle) score = command.featured === true ? 0 : BARE_SLASH_RANK[command.group];
    else if (name === needle) score = 0;
    else if (name.startsWith(needle)) score = 1;
    else if (name.includes(needle)) score = 2;
    else if (command.description.toLowerCase().includes(needle)) score = 3;
    else continue;
    scored.push({ command, score });
  }
  return scored.sort((a, b) => a.score - b.score).map((entry) => entry.command);
}

/** True when `draft` already names a full command, so Enter should run it rather than complete. */
export function isCompletePaSlashCommand(
  draft: string,
  commands: ReadonlyArray<PaSlashCommand>,
): boolean {
  const { name } = commandName(draft);
  return name.startsWith("/") && name.length >= 2 && findCommand(commands, name) !== undefined;
}
