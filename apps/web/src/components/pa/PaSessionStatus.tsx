import { summarizePaTodos } from "@t3tools/client-runtime/pa/timeline";
import type { PaContextUsage, PaQueuedItem, PaTodoState } from "@t3tools/contracts";
import { T, useGT } from "gt-react";
import {
  ChevronDownIcon,
  CircleCheckIcon,
  CircleDotIcon,
  CircleIcon,
  CircleSlashIcon,
  CornerUpRightIcon,
  GaugeIcon,
  ListTodoIcon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react";
import { useState } from "react";

import { formatContextWindowTokens } from "../../lib/contextWindow";
import { cn } from "../../lib/utils";
import { ThreadDetailsContext } from "../chat/ThreadDetailsUsage";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { hasPaContextUsage, paContextWindowSnapshot } from "./paSessionStatus.logic";

const STATUS_CARD =
  "mb-2 min-w-0 rounded-2xl border border-border/80 bg-card/95 shadow-sm backdrop-blur-md";

function TodoStatusIcon({ status }: { readonly status: PaTodoState["items"][number]["status"] }) {
  switch (status) {
    case "completed":
      return <CircleCheckIcon className="size-3.5 shrink-0 text-success" />;
    case "in_progress":
      return <CircleDotIcon className="size-3.5 shrink-0 text-info" />;
    case "cancelled":
      return <CircleSlashIcon className="size-3.5 shrink-0 text-muted-foreground/70" />;
    case "pending":
      return <CircleIcon className="size-3.5 shrink-0 text-muted-foreground/70" />;
  }
}

/** The agent's task list: progress and the current item folded, every item when opened. */
export function PaTodoProgressBar({ todos }: { readonly todos: PaTodoState | null }) {
  const gt = useGT();
  const [expanded, setExpanded] = useState(false);
  const progress = summarizePaTodos(todos);
  if (!todos || !progress || progress.total === 0) return null;
  return (
    <div className={STATUS_CARD}>
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((open) => !open)}
        className="flex w-full min-w-0 items-center gap-2 px-3 py-2 text-left text-xs"
      >
        <ListTodoIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="shrink-0 font-medium text-foreground">
          {gt("Task progress {done}/{total}", { done: progress.completed, total: progress.total })}
        </span>
        {progress.active ? (
          <span className="min-w-0 flex-1 truncate text-muted-foreground">
            {progress.active.text}
          </span>
        ) : (
          <span className="flex-1" />
        )}
        <ChevronDownIcon
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground transition-transform",
            expanded && "rotate-180",
          )}
        />
      </button>
      {expanded ? (
        <ul className="max-h-48 space-y-1 overflow-y-auto overscroll-contain border-t border-border/50 px-3 py-2">
          {todos.items.map((item) => (
            <li key={item.id} className="flex min-w-0 items-start gap-2 text-xs">
              <span className="pt-0.5">
                <TodoStatusIcon status={item.status} />
              </span>
              <span
                className={cn(
                  "min-w-0 flex-1 break-words leading-5",
                  item.status === "completed" || item.status === "cancelled"
                    ? "text-muted-foreground"
                    : "text-foreground",
                  item.status === "cancelled" && "line-through",
                )}
              >
                {item.text}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** Messages waiting behind the running turn, as the engine holds them. */
export function PaQueueBar({
  items,
  canOperate,
  canSteer,
  busyIds,
  onSteer,
  onCancel,
  onResolveUnknown,
}: {
  readonly items: ReadonlyArray<PaQueuedItem>;
  readonly canOperate: boolean;
  readonly canSteer: boolean;
  readonly busyIds: ReadonlySet<string>;
  readonly onSteer: (item: PaQueuedItem) => void;
  readonly onCancel: (item: PaQueuedItem) => void;
  readonly onResolveUnknown: (item: PaQueuedItem) => void;
}) {
  const gt = useGT();
  if (items.length === 0) return null;
  return (
    <div className={cn(STATUS_CARD, "max-h-44 overflow-y-auto overscroll-contain px-1.5 py-1")}>
      {items.map((item) => {
        const busy = !canOperate || busyIds.has(item.id);
        const label =
          item.text ||
          (item.attachmentCount
            ? gt("{count} attachments", { count: item.attachmentCount })
            : gt("Queued message"));
        if (item.status === "unknown") {
          return (
            <div
              key={item.id}
              role="alert"
              className="flex min-w-0 flex-wrap items-center gap-2 rounded-xl px-1.5 py-1.5 text-xs text-warning-foreground"
            >
              <TriangleAlertIcon className="size-3.5 shrink-0 text-warning" />
              <span className="min-w-0 flex-1">
                <span className="block">
                  <T>The interrupted task has an unknown outcome. Later messages are waiting.</T>
                </span>
                <span className="block truncate text-muted-foreground">{label}</span>
              </span>
              <Button
                type="button"
                size="xs"
                variant="warning-outline"
                disabled={busy}
                onClick={() => onResolveUnknown(item)}
              >
                <T>Skip task and resume queue</T>
              </Button>
            </div>
          );
        }
        return (
          <div
            key={item.id}
            className="flex min-w-0 items-center gap-1.5 rounded-xl px-1.5 py-1 text-xs"
          >
            <span className="min-w-0 flex-1 truncate text-foreground/85">{label}</span>
            {item.status === "steering" ? (
              <Badge variant="info" size="sm" className="shrink-0">
                <T>Moving into the current turn</T>
              </Badge>
            ) : (
              <>
                {canSteer && item.canSteer ? (
                  <Button
                    type="button"
                    size="xs"
                    variant="ghost-muted"
                    disabled={busy}
                    aria-label={gt("Steer the current turn with this message")}
                    onClick={() => onSteer(item)}
                  >
                    <CornerUpRightIcon />
                    <T>Steer</T>
                  </Button>
                ) : null}
                <Button
                  type="button"
                  size="icon-xs"
                  variant="ghost-muted"
                  disabled={busy}
                  aria-label={gt("Cancel queued message")}
                  onClick={() => onCancel(item)}
                >
                  <XIcon />
                </Button>
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** How full the session's context is; hidden until the engine reports it. */
export function PaContextUsageButton({ usage }: { readonly usage: PaContextUsage | null }) {
  const gt = useGT();
  if (!hasPaContextUsage(usage)) return null;
  const label =
    usage.contextPercent !== null
      ? `${Math.round(usage.contextPercent)}%`
      : formatContextWindowTokens(usage.contextUsed);
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            type="button"
            size="xs"
            variant="ghost-muted"
            aria-label={gt("Context usage {label}", { label })}
          >
            <GaugeIcon className="size-3.5" />
            <span className="tabular-nums">{label}</span>
          </Button>
        }
      />
      <PopoverPopup align="end" className="w-72">
        <div className="space-y-2">
          <ThreadDetailsContext usage={paContextWindowSnapshot(usage)} />
          {usage.totalTokens !== undefined || usage.compressionCount !== undefined ? (
            <div className="flex flex-wrap gap-x-3 gap-y-1 text-2xs text-muted-foreground">
              {usage.totalTokens !== undefined ? (
                <span>
                  {gt("{tokens} tokens used in this session", {
                    tokens: formatContextWindowTokens(usage.totalTokens),
                  })}
                </span>
              ) : null}
              {usage.compressionCount !== undefined && usage.compressionCount > 0 ? (
                <span>{gt("Compactions: {count}", { count: usage.compressionCount })}</span>
              ) : null}
            </div>
          ) : null}
        </div>
      </PopoverPopup>
    </Popover>
  );
}
