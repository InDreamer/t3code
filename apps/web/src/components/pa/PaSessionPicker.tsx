import { appendPaSessionPage } from "@t3tools/client-runtime/pa/history";
import type { PaSessionSummary } from "@t3tools/contracts";
import { T, useGT } from "gt-react";
import {
  ChevronDownIcon,
  HistoryIcon,
  Loader2Icon,
  MessageSquarePlusIcon,
  PencilIcon,
  SearchIcon,
} from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";

import { cn } from "../../lib/utils";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../ui/input-group";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { makePaRequestKey, paApi, paErrorMessage } from "./paApi";

const SEARCH_DEBOUNCE_MS = 250;

interface SessionSearch {
  readonly query: string;
  readonly sessions: ReadonlyArray<PaSessionSummary>;
  readonly nextCursor: string | null;
  readonly loading: boolean;
}

interface RenameDraft {
  readonly sessionId: string;
  readonly title: string;
  /** The key of the last attempt, reused while its title is unchanged so a retry applies once. */
  readonly attempt: { readonly title: string; readonly requestId: string } | null;
}

/** The session switcher: title-or-id search, older pages and inline rename. */
export function PaSessionPicker({
  botId,
  open,
  onOpenChange,
  triggerLabel,
  sessions,
  hasMoreSessions,
  loadingMoreSessions,
  activeSessionId,
  canCreateSession,
  canRenameSession,
  formatSourceLabel,
  onSelectSession,
  onCreateSession,
  onLoadMoreSessions,
  onSessionRenamed,
  onError,
}: {
  readonly botId: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly triggerLabel: string;
  readonly sessions: ReadonlyArray<PaSessionSummary>;
  readonly hasMoreSessions: boolean;
  readonly loadingMoreSessions: boolean;
  readonly activeSessionId: string | null;
  readonly canCreateSession: boolean;
  readonly canRenameSession: boolean;
  readonly formatSourceLabel: (source: string) => string;
  /** A search can pick a session the unfiltered list has not paged in yet. */
  readonly onSelectSession: (session: PaSessionSummary) => void;
  readonly onCreateSession: () => void;
  readonly onLoadMoreSessions: () => void;
  readonly onSessionRenamed: (sessionId: string, title: string) => void;
  readonly onError: (message: string) => void;
}) {
  const gt = useGT();
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState<SessionSearch | null>(null);
  const [rename, setRename] = useState<RenameDraft | null>(null);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchSeqRef = useRef(0);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- cancels the pending timer and invalidates in-flight search replies on unmount.
  useEffect(
    () => () => {
      if (searchTimerRef.current !== null) clearTimeout(searchTimerRef.current);
      searchSeqRef.current += 1;
    },
    [],
  );

  const runSearch = (nextQuery: string, cursor?: string) => {
    const seq = searchSeqRef.current + 1;
    searchSeqRef.current = seq;
    setSearch((prev) => ({
      query: nextQuery,
      sessions: cursor && prev?.query === nextQuery ? prev.sessions : [],
      nextCursor: cursor && prev?.query === nextQuery ? prev.nextCursor : null,
      loading: true,
    }));
    paApi
      .listSessions(botId, { query: nextQuery, ...(cursor ? { cursor } : {}) })
      .then((res) => {
        if (searchSeqRef.current !== seq) return;
        setSearch((prev) => ({
          query: nextQuery,
          sessions:
            cursor && prev?.query === nextQuery
              ? appendPaSessionPage(prev.sessions, res.sessions)
              : res.sessions,
          nextCursor: res.nextCursor ?? null,
          loading: false,
        }));
      })
      .catch((err: unknown) => {
        if (searchSeqRef.current !== seq) return;
        setSearch((prev) => (prev ? { ...prev, loading: false } : prev));
        onError(paErrorMessage(err, gt("Could not search conversations")));
      });
  };

  const handleQueryChange = (value: string) => {
    setQuery(value);
    if (searchTimerRef.current !== null) clearTimeout(searchTimerRef.current);
    const trimmed = value.trim();
    if (!trimmed) {
      searchSeqRef.current += 1;
      setSearch(null);
      return;
    }
    searchTimerRef.current = setTimeout(() => {
      searchTimerRef.current = null;
      runSearch(trimmed);
    }, SEARCH_DEBOUNCE_MS);
  };

  const resetPicker = () => {
    if (searchTimerRef.current !== null) clearTimeout(searchTimerRef.current);
    searchTimerRef.current = null;
    searchSeqRef.current += 1;
    setQuery("");
    setSearch(null);
    setRename(null);
  };

  const handleOpenChange = (next: boolean) => {
    if (!next) resetPicker();
    onOpenChange(next);
  };

  const commitRename = async () => {
    const draft = rename;
    if (!draft || renaming || !canRenameSession) return;
    const title = draft.title.trim();
    const current = [...sessions, ...(search?.sessions ?? [])].find(
      (item) => item.sessionId === draft.sessionId,
    );
    if (!title || title === current?.title) {
      setRename(null);
      return;
    }
    const attempt =
      draft.attempt?.title === title
        ? draft.attempt
        : { title, requestId: makePaRequestKey("pa-rename") };
    setRename({ ...draft, attempt });
    setRenaming(true);
    setRenameError(null);
    try {
      const res = await paApi.renameSession(botId, draft.sessionId, title, attempt.requestId);
      const renamed = res.title ?? title;
      onSessionRenamed(draft.sessionId, renamed);
      setSearch((prev) =>
        prev
          ? {
              ...prev,
              sessions: prev.sessions.map((item) =>
                item.sessionId === draft.sessionId ? { ...item, title: renamed } : item,
              ),
            }
          : prev,
      );
      setRename((prev) => (prev?.sessionId === draft.sessionId ? null : prev));
    } catch (err) {
      setRenameError(paErrorMessage(err, gt("Could not rename conversation")));
    }
    setRenaming(false);
  };

  const searching = search !== null;
  const shown = search?.sessions ?? sessions;
  const hasMore = searching ? search.nextCursor !== null : hasMoreSessions;
  const loadingMore = searching
    ? search.loading && search.sessions.length > 0
    : loadingMoreSessions;

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger
        render={
          <Button type="button" size="xs" variant="ghost-muted">
            <HistoryIcon className="size-3.5" />
            <span className="hidden max-w-28 truncate sm:inline">{triggerLabel}</span>
            <ChevronDownIcon className="size-3" />
          </Button>
        }
      />
      <PopoverPopup align="end" className="w-72">
        <div className="mb-1.5 flex items-center justify-between px-1 py-1">
          <span className="text-xs font-medium text-muted-foreground">
            <T>Switch conversation</T>
          </span>
          {canCreateSession ? (
            <Button
              type="button"
              size="xs"
              variant="ghost"
              onClick={() => {
                resetPicker();
                onCreateSession();
              }}
            >
              <MessageSquarePlusIcon className="size-3" />
              <T>New conversation</T>
            </Button>
          ) : null}
        </div>
        <div className="mb-1.5 px-1">
          <InputGroup>
            <InputGroupAddon>
              {searching && search.loading ? (
                <Loader2Icon aria-hidden className="animate-spin" />
              ) : (
                <SearchIcon aria-hidden />
              )}
            </InputGroupAddon>
            {/* Titles and ids only: Hermes does not search message text here. */}
            <InputGroupInput
              type="text"
              role="searchbox"
              size="sm"
              value={query}
              onChange={(event) => handleQueryChange(event.currentTarget.value)}
              placeholder={gt("Search by title or ID")}
              aria-label={gt("Search conversations by title or ID")}
            />
          </InputGroup>
        </div>
        <div className="max-h-72 space-y-1 overflow-y-auto">
          {searching && search.loading && search.sessions.length === 0 ? (
            <div className="flex items-center justify-center py-4 text-xs text-muted-foreground">
              <Loader2Icon className="mr-1.5 size-3.5 animate-spin" />
              <T>Searching…</T>
            </div>
          ) : null}
          {searching && !search.loading && search.sessions.length === 0 ? (
            <p className="py-4 text-center text-xs text-muted-foreground">
              <T>No matching conversations</T>
            </p>
          ) : null}
          {shown.map((item) =>
            rename?.sessionId === item.sessionId ? (
              <PaSessionRenameInput
                key={item.sessionId}
                title={rename.title}
                error={renameError}
                disabled={renaming || !canRenameSession}
                onTitleChange={(title) => setRename((prev) => (prev ? { ...prev, title } : prev))}
                onCommit={() => void commitRename()}
                onCancel={() => setRename(null)}
              />
            ) : (
              <div
                key={item.sessionId}
                className={cn(
                  "group/session flex items-stretch rounded-lg transition-colors",
                  item.sessionId === activeSessionId
                    ? "bg-primary/10 text-foreground"
                    : "text-foreground/85 hover:bg-muted/60",
                )}
              >
                <button
                  type="button"
                  onClick={() => {
                    resetPicker();
                    onSelectSession(item);
                  }}
                  className="flex min-w-0 flex-1 flex-col gap-0.5 px-2.5 py-2 text-left"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-xs font-medium">{item.title}</span>
                    <Badge variant="outline" size="sm" className="shrink-0">
                      {item.isPrimary ? gt("Primary conversation") : formatSourceLabel(item.source)}
                    </Badge>
                  </div>
                  <div className="text-3xs text-muted-foreground">
                    {item.model
                      ? gt("{count} messages · {model}", {
                          count: item.messageCount,
                          model: item.model,
                        })
                      : gt("{count} messages", { count: item.messageCount })}
                  </div>
                </button>
                {canRenameSession ? (
                  // Always shown on touch; on a pointer it appears with the row's hover or focus.
                  <span className="my-auto me-1 shrink-0 sm:opacity-0 sm:group-hover/session:opacity-100 sm:has-focus-visible:opacity-100">
                    <Button
                      type="button"
                      size="icon-xs"
                      variant="ghost-muted"
                      aria-label={gt("Rename conversation")}
                      onClick={() => {
                        setRenameError(null);
                        setRename({ sessionId: item.sessionId, title: item.title, attempt: null });
                      }}
                    >
                      <PencilIcon className="size-3" />
                    </Button>
                  </span>
                ) : null}
              </div>
            ),
          )}
          {hasMore ? (
            <div className="flex justify-center py-0.5">
              <Button
                type="button"
                size="xs"
                variant="ghost-muted"
                disabled={loadingMore}
                onClick={() => {
                  if (searching) {
                    if (search.nextCursor) runSearch(search.query, search.nextCursor);
                  } else {
                    onLoadMoreSessions();
                  }
                }}
              >
                {loadingMore ? <Loader2Icon className="size-3 animate-spin" /> : null}
                {loadingMore ? <T>Loading…</T> : <T>Load more</T>}
              </Button>
            </div>
          ) : null}
        </div>
      </PopoverPopup>
    </Popover>
  );
}

// Mounted only while renaming, so each rename starts uncommitted.
function PaSessionRenameInput(props: {
  readonly title: string;
  readonly error: string | null;
  readonly disabled: boolean;
  readonly onTitleChange: (title: string) => void;
  readonly onCommit: () => void;
  readonly onCancel: () => void;
}) {
  const gt = useGT();
  // Enter and Escape blur the input as it unmounts; that blur must not commit again.
  const settledRef = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- returns keyboard focus to the editable title after the server refuses a rename.
  useEffect(() => {
    if (!props.disabled && props.error) {
      settledRef.current = false;
      inputRef.current?.focus();
    }
  }, [props.disabled, props.error]);
  const handleKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    event.stopPropagation();
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === "Enter") {
      event.preventDefault();
      settledRef.current = true;
      props.onCommit();
    } else if (event.key === "Escape") {
      event.preventDefault();
      settledRef.current = true;
      props.onCancel();
    }
  };
  return (
    <div className="px-1 py-1">
      <Input
        ref={inputRef}
        autoFocus
        size="sm"
        value={props.title}
        disabled={props.disabled}
        dir="auto"
        maxLength={200}
        aria-label={gt("Conversation title")}
        onChange={(event) => {
          settledRef.current = false;
          props.onTitleChange(event.target.value);
        }}
        onFocus={(event) => event.currentTarget.select()}
        onKeyDown={handleKeyDown}
        onBlur={() => {
          if (!settledRef.current) props.onCommit();
        }}
      />
      {props.error ? (
        <p role="alert" className="text-xs text-destructive">
          {props.error}
        </p>
      ) : null}
    </div>
  );
}
