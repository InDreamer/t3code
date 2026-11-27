import { useAtomValue } from "@effect/atom-react";
import { LegendList } from "@legendapp/list/react-native";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { makePaRequestKey } from "@t3tools/client-runtime/pa/chat";
import { appendPaSessionPage } from "@t3tools/client-runtime/pa/history";
import { formatPaSessionSource } from "@t3tools/client-runtime/pa/presentation";
import { EnvironmentId, type PaSessionSummary } from "@t3tools/contracts";
import { useGT, useMessages } from "gt-react-native";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { Platform, View } from "react-native";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { EmptyState } from "../../components/ui/EmptyState";
import { Menu } from "../../components/ui/Menu";
import { SelectionRow } from "../../components/ui/SelectionRow";
import { relativeTime } from "../../lib/time";
import { useMountedRef } from "../../lib/useMountedRef";
import { NativeScrollView } from "../../native/NativeScrollViewMarker";
import { useDebouncedValue } from "../../state/queries";
import { PullRequestSearchSheet } from "../pull-requests/PullRequestSearchSheet";
import { paClient, paErrorMessage, paOperatePermissionAtom } from "./paApi";
import { paBotKey, type PaBotParams } from "./paBotParams";
import { usePaBot } from "./paRosterStore";
import { usePaBotChat } from "./usePaBotChat";

interface SessionSearch {
  readonly query: string;
  readonly sessions: ReadonlyArray<PaSessionSummary>;
  readonly nextCursor: string | null;
  readonly loading: boolean;
  readonly error: string | null;
}

/** The Bot's conversations: title-or-id search, older pages, switch, create and rename. */
export function PaSessionsSheet({ route }: StaticScreenProps<PaBotParams>) {
  return (
    <PaSessions
      key={paBotKey(route.params.environmentId, route.params.botId)}
      params={route.params}
    />
  );
}

function PaSessions({ params }: { readonly params: PaBotParams }) {
  const mounted = useMountedRef();
  const gt = useGT();
  const messages = useMessages();
  const navigation = useNavigation();
  const { environmentId, botId } = params;
  const { capabilities } = usePaBot(environmentId, botId);
  const canOperate = useAtomValue(paOperatePermissionAtom(EnvironmentId.make(environmentId)));
  const { chat, state } = usePaBotChat(environmentId, botId);
  const canCreate = canOperate && capabilities?.sessions.create === true;
  const canRename = canOperate && capabilities?.sessions.renameExisting === true;
  const [query, setQuery] = useState("");
  const debounced = useDebouncedValue(query.trim(), 250);
  const [search, setSearch] = useState<SessionSearch | null>(null);
  const searchSeq = useRef(0);
  const renameAttempts = useRef(new Map<string, { title: string; requestId: string }>());

  const fetchSearch = (needle: string, cursor?: string) => {
    const seq = ++searchSeq.current;
    paClient(environmentId)
      .listSessions(botId, { query: needle, ...(cursor ? { cursor } : {}) })
      .then(
        (page) => {
          if (searchSeq.current !== seq) return;
          setSearch((previous) => ({
            query: needle,
            sessions:
              cursor && previous?.query === needle
                ? appendPaSessionPage(previous.sessions, page.sessions)
                : page.sessions,
            nextCursor: page.nextCursor ?? null,
            loading: false,
            error: null,
          }));
        },
        (error: unknown) => {
          if (searchSeq.current !== seq) return;
          setSearch((previous) => ({
            query: needle,
            sessions: previous?.query === needle ? previous.sessions : [],
            nextCursor: previous?.query === needle ? previous.nextCursor : null,
            loading: false,
            error: paErrorMessage(error, gt("Could not search conversations")),
          }));
        },
      );
  };
  const searchFor = useEffectEvent((needle: string) => {
    if (needle) fetchSearch(needle);
    else searchSeq.current += 1;
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- searches the engine for the debounced query; an empty one shows the paged list
  useEffect(() => {
    searchFor(debounced);
    return () => {
      searchSeq.current += 1;
    };
  }, [debounced]);

  const searching = debounced.length > 0;
  // Results for an earlier query are not shown while the current one is read.
  const result = search?.query === debounced ? search : null;
  const sessions = searching ? (result?.sessions ?? []) : state.sessions;
  const hasMore = searching ? result?.nextCursor != null : state.sessionsCursor !== null;
  const loadingMore = searching ? result?.loading === true : state.loadingMoreSessions;
  const loadMore = () => {
    if (searching) {
      if (!result?.nextCursor || result.loading) return;
      setSearch({ ...result, loading: true, error: null });
      fetchSearch(debounced, result.nextCursor);
    } else void chat.loadMoreSessions();
  };

  const select = (session: PaSessionSummary) => {
    chat.selectSession(session);
    navigation.goBack();
  };
  const rename = (session: PaSessionSummary) =>
    Dialog.prompt({
      title: gt("Rename conversation"),
      initialValue: session.title,
      placeholder: gt("Conversation title"),
      confirmText: gt("Rename"),
      onConfirm: (value) => {
        const title = value.trim();
        if (!title || title === session.title) return;
        // A retry of the same title reuses its key, so the engine applies it once.
        const previous = renameAttempts.current.get(session.sessionId);
        const attempt =
          previous?.title === title
            ? previous
            : { title, requestId: makePaRequestKey("pa-rename") };
        renameAttempts.current.set(session.sessionId, attempt);
        paClient(environmentId)
          .renameSession(botId, session.sessionId, title, attempt.requestId)
          .then(
            (result) => {
              renameAttempts.current.delete(session.sessionId);
              chat.patchSession(session.sessionId, { title: result.title ?? title });
              if (!mounted.current) return;
              setSearch((current) =>
                current
                  ? {
                      ...current,
                      sessions: current.sessions.map((item) =>
                        item.sessionId === session.sessionId
                          ? { ...item, title: result.title ?? title }
                          : item,
                      ),
                    }
                  : current,
              );
            },
            (error: unknown) =>
              mounted.current &&
              Dialog.alert(
                gt("Could not rename the conversation"),
                paErrorMessage(error, gt("Try again.")),
              ),
          );
      },
    });
  const create = () => {
    void chat.createSession();
    navigation.goBack();
  };
  const describe = (session: PaSessionSummary) =>
    [
      session.isPrimary ? gt("Primary") : formatPaSessionSource(session.source, messages),
      gt("{count, plural, one {{count} message} other {{count} messages}}", {
        count: session.messageCount,
      }),
      session.running ? gt("Working") : null,
      session.lastActivityAt
        ? relativeTime(new Date(session.lastActivityAt).toISOString(), undefined, messages)
        : null,
    ]
      .filter(Boolean)
      .join(" · ");

  return (
    <PullRequestSearchSheet
      title={gt("Conversations")}
      placeholder={gt("Search conversations")}
      closeAccessibilityLabel={gt("Close conversations")}
      clearAccessibilityLabel={gt("Clear search")}
      query={query}
      onQueryChange={setQuery}
    >
      {({ paddingBottom }) => (
        <LegendList
          renderScrollComponent={NativeScrollView}
          data={sessions}
          keyExtractor={(session) => session.sessionId}
          extraData={state.activeSessionId}
          estimatedItemSize={64}
          recycleItems
          className="flex-1"
          contentInsetAdjustmentBehavior="automatic"
          automaticallyAdjustKeyboardInsets={Platform.OS === "ios"}
          keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 16, paddingBottom }}
          onEndReached={loadMore}
          onEndReachedThreshold={0.5}
          ListHeaderComponent={
            canCreate && !searching ? (
              <View className="items-start pb-3">
                <Button
                  icon="plus.bubble"
                  tone="secondary"
                  size="compact"
                  label={gt("New conversation")}
                  disabled={state.creatingSession || state.loadingSessions}
                  onPress={create}
                />
              </View>
            ) : result?.error ? (
              <Text className="pb-3 text-xs text-danger">{result.error}</Text>
            ) : undefined
          }
          renderItem={({ item, index }) => {
            const row = (
              <SelectionRow
                title={item.title || formatPaSessionSource(item.source, messages)}
                subtitle={describe(item)}
                role="radio"
                selected={item.sessionId === state.activeSessionId}
                isFirst={index === 0}
                isLast={index === sessions.length - 1}
                onPress={() => select(item)}
              />
            );
            return canRename ? (
              <Menu
                shouldOpenOnLongPress
                title={item.title}
                actions={[{ id: "rename", title: gt("Rename"), image: "pencil" }]}
                onPressAction={() => rename(item)}
              >
                {row}
              </Menu>
            ) : (
              row
            );
          }}
          ListFooterComponent={
            loadingMore ? (
              <AppActivityIndicator className="my-4" />
            ) : hasMore ? (
              <View className="items-center py-3">
                <Button size="compact" tone="text" label={gt("Load more")} onPress={loadMore} />
              </View>
            ) : undefined
          }
          ListEmptyComponent={
            (searching ? result === null || result.loading : state.loadingSessions) ? (
              <AppActivityIndicator className="my-8" />
            ) : (
              <EmptyState
                title={searching ? gt("No matching conversations") : gt("No conversations yet")}
                detail={searching ? gt("Try another title.") : gt("Send a message to start one.")}
                variant="plain"
              />
            )
          }
        />
      )}
    </PullRequestSearchSheet>
  );
}
