import type { PaSlashCommand } from "@t3tools/contracts";
import { BlocksIcon, PackageIcon, TerminalIcon, type LucideIcon } from "lucide-react";
import { T, useGT } from "gt-react";
import { useLayoutEffect, useRef } from "react";

import { ComposerBanner } from "../chat/ComposerBanner";
import { composerSuggestionOptionId } from "../chat/ComposerCommandMenu";
import { Badge } from "../ui/badge";
import { Command, CommandGroup, CommandItem, CommandList } from "../ui/command";

const GROUP_ICON: Readonly<Record<PaSlashCommand["group"], LucideIcon>> = {
  command: TerminalIcon,
  skill: PackageIcon,
  plugin: BlocksIcon,
};

/** The chat composer's command menu for PA: commands, skills and plugins in one list. */
export function PaSlashCommandMenu(props: {
  readonly listId: string;
  readonly commands: ReadonlyArray<PaSlashCommand>;
  readonly activeName: string | null;
  readonly onHighlight: (name: string | null) => void;
  readonly onSelect: (command: PaSlashCommand) => void;
}) {
  const gt = useGT();
  const listRef = useRef<HTMLDivElement>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- scrolls the highlighted menu item's DOM node into view
  useLayoutEffect(() => {
    if (!props.activeName || !listRef.current) return;
    const el = listRef.current.querySelector<HTMLElement>(
      `[data-composer-item-id="${CSS.escape(props.activeName)}"]`,
    );
    el?.scrollIntoView({ block: "nearest" });
  }, [props.activeName]);

  return (
    <Command
      autoHighlight={false}
      mode="none"
      onItemHighlighted={(value) => props.onHighlight(typeof value === "string" ? value : null)}
    >
      <ComposerBanner.Surface
        ref={listRef}
        className="flex min-h-0 w-full flex-col overflow-hidden pb-(--chat-composer-attachment-overlap) **:data-[slot=command-item]:rounded-lg **:data-[slot=scroll-area-scrollbar]:data-[orientation=vertical]:my-4"
        data-composer-command-drawer="true"
      >
        <CommandList
          id={props.listId}
          aria-label={gt("Commands")}
          className="max-h-72 min-h-0 scroll-pb-6"
        >
          <CommandGroup>
            {props.commands.map((command) => {
              const Icon = GROUP_ICON[command.group];
              const active = props.activeName === command.name;
              return (
                <CommandItem
                  key={command.name}
                  render={<div id={composerSuggestionOptionId(props.listId, command.name)} />}
                  aria-selected={active}
                  value={command.name}
                  data-composer-item-id={command.name}
                  active={active}
                  onMouseMove={() => {
                    if (!active) props.onHighlight(command.name);
                  }}
                  // Keeps textarea focus (and the soft keyboard) while picking.
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => props.onSelect(command)}
                >
                  <Icon aria-hidden="true" className="size-4 shrink-0 text-secondary-label" />
                  <span className="flex min-w-0 flex-1 items-center gap-2">
                    <span className="min-w-0 max-w-[45%] shrink-0 truncate font-sans text-xs font-medium">
                      {command.name}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-left text-secondary-label text-xs">
                      {command.description}
                    </span>
                    {command.group === "skill" ? (
                      <Badge className="ms-auto" variant="secondary">
                        <T>Skill</T>
                      </Badge>
                    ) : command.group === "plugin" ? (
                      <Badge className="ms-auto" variant="outline">
                        <T>Plugin</T>
                      </Badge>
                    ) : null}
                  </span>
                </CommandItem>
              );
            })}
          </CommandGroup>
        </CommandList>
      </ComposerBanner.Surface>
    </Command>
  );
}
