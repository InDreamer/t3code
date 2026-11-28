import {
  PaError,
  WS_METHODS,
  type EnvironmentId,
  type PaStreamEvent,
  type PaSubscribeSessionInput,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type { Atom, AtomRegistry } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { subscribeDynamic, type EnvironmentUnaryRpcTag } from "../rpc/client.ts";
import { followStreamInEnvironment } from "../state/environmentStreams.ts";
import { createEnvironmentRpcCommand, provideAtomRuntime } from "../state/runtime.ts";

export interface PaSessionFollower {
  readonly environmentId: EnvironmentId;
  readonly botId: string;
  readonly sessionId: string;
  /** Optional resume token retained across remounts for exact hub replay. */
  readonly initialResumeToken?: string | undefined;
  /** Requests the latest transcript page bundled with the initial snapshot (1-RTT open). */
  readonly latestPage?:
    | {
        readonly limit?: number | undefined;
        readonly getKnownPageTag?: (() => string | null | undefined) | undefined;
      }
    | undefined;
  readonly onEvent: (event: PaStreamEvent) => void;
  readonly onResumeToken?: ((token: string) => void) | undefined;
  /**
   * A failed attempt. While `retrying` the feed reconnects on its own, resuming from the last
   * event applied; otherwise the engine refused this session for good and the feed has ended.
   */
  readonly onFailure: (error: unknown, status: { readonly retrying: boolean }) => void;
}

const isPaError = Schema.is(PaError);
const PERMANENT_PA_REASONS: ReadonlySet<PaError["reason"]> = new Set([
  "NotFound",
  "Invalid",
  "Forbidden",
  "Unsupported",
  "Conflict",
]);

export function paErrorReason(error: unknown): PaError["reason"] | null {
  return isPaError(error) ? error.reason : null;
}

/** A refusal that reconnecting cannot fix: the session is gone, malformed or off limits. */
export function isPermanentPaFailure(error: unknown): boolean {
  const reason = paErrorReason(error);
  return (
    (reason !== null && PERMANENT_PA_REASONS.has(reason)) ||
    (typeof error === "object" &&
      error !== null &&
      "_tag" in error &&
      error._tag === "EnvironmentAuthorizationError")
  );
}

/**
 * One session's live feed over the current environment session. Every reconnect, including
 * after a new connection to the environment, resumes from the last event's token, so the server
 * replays only what was missed or answers `snapshotRequired`. A permanent refusal ends it, and a
 * rerun of the stream (the environment entry was rebuilt) neither resets the token nor retries it.
 */
export function paSessionEvents(
  follower: Pick<
    PaSessionFollower,
    | "botId"
    | "sessionId"
    | "initialResumeToken"
    | "latestPage"
    | "onFailure"
    | "onEvent"
    | "onResumeToken"
  >,
) {
  let resumeToken: string | undefined = follower.initialResumeToken;
  let refusedForGood = false;
  const input = (): PaSubscribeSessionInput => {
    const latestPage = follower.latestPage
      ? (() => {
          const knownPageTag = follower.latestPage.getKnownPageTag?.() ?? undefined;
          return {
            ...(follower.latestPage.limit !== undefined
              ? { limit: follower.latestPage.limit }
              : {}),
            ...(knownPageTag ? { knownPageTag } : {}),
          };
        })()
      : undefined;
    return {
      botId: follower.botId,
      sessionId: follower.sessionId,
      protocolVersion:
        latestPage !== undefined || follower.initialResumeToken !== undefined ? 3 : 2,
      ...(resumeToken !== undefined ? { resumeToken } : {}),
      ...(latestPage !== undefined ? { latestPage } : {}),
    };
  };
  const events = Stream.unwrap(
    Effect.gen(function* () {
      if (refusedForGood) return Stream.empty;
      const refused = yield* Deferred.make<void>();
      return subscribeDynamic(WS_METHODS.paSubscribeSession, () => Effect.sync(input), {
        retryExpectedFailureAfter: "1 second",
        onExpectedFailure: (cause) =>
          Effect.suspend(() => {
            const error = Cause.squash(cause);
            const permanent = isPermanentPaFailure(error);
            follower.onFailure(error, { retrying: !permanent });
            if (!permanent) return Effect.void;
            refusedForGood = true;
            return Deferred.succeed(refused, undefined);
          }),
      }).pipe(Stream.interruptWhen(Deferred.await(refused)));
    }),
  );
  const deliver = (event: PaStreamEvent) =>
    Effect.sync(() => {
      follower.onEvent(event);
      resumeToken = event.resumeToken;
      follower.onResumeToken?.(event.resumeToken);
    });
  return { events, deliver };
}

/** Personal agent RPCs for one client runtime, shared by web and mobile. */
export function createPaEnvironmentCommands<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const command = <TTag extends EnvironmentUnaryRpcTag>(tag: TTag) =>
    createEnvironmentRpcCommand(runtime, { label: `environment-data:${tag}`, tag });

  return {
    listBots: command(WS_METHODS.paListBots),
    createBot: command(WS_METHODS.paCreateBot),
    updateBotMeta: command(WS_METHODS.paUpdateBotMeta),
    getBotModels: command(WS_METHODS.paGetBotModels),
    selectBotModel: command(WS_METHODS.paSelectBotModel),
    getBotConfig: command(WS_METHODS.paGetBotConfig),
    patchBotConfig: command(WS_METHODS.paPatchBotConfig),
    listSchedules: command(WS_METHODS.paListSchedules),
    mutateSchedule: command(WS_METHODS.paMutateSchedule),
    listCommands: command(WS_METHODS.paListCommands),
    listSessions: command(WS_METHODS.paListSessions),
    createSession: command(WS_METHODS.paCreateSession),
    mutateSession: command(WS_METHODS.paMutateSession),
    getMessages: command(WS_METHODS.paGetMessages),
    sendMessage: command(WS_METHODS.paSendMessage),
    interruptSession: command(WS_METHODS.paInterruptSession),
    steerSession: command(WS_METHODS.paSteerSession),
    manageQueuedItem: command(WS_METHODS.paManageQueuedItem),
    respondRequest: command(WS_METHODS.paRespondRequest),
    /** Streams a session until the returned stop is called or the engine refuses it for good. */
    followSession: (registry: AtomRegistry.AtomRegistry, follower: PaSessionFollower) => {
      const { events, deliver } = paSessionEvents(follower);
      const fiber = Effect.runFork(
        followStreamInEnvironment(follower.environmentId, events).pipe(
          Stream.runForEach(deliver),
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.void
              : Effect.sync(() => follower.onFailure(Cause.squash(cause), { retrying: false })),
          ),
          provideAtomRuntime(registry, runtime),
        ),
      );
      return () => {
        Effect.runFork(Fiber.interrupt(fiber));
      };
    },
  };
}
