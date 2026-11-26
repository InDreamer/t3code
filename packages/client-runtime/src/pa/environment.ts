import {
  WS_METHODS,
  type EnvironmentId,
  type PaStreamEvent,
  type PaSubscribeSessionInput,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
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
  readonly onEvent: (event: PaStreamEvent) => void;
  /** A failed attempt; the feed retries on its own, resuming from the last event applied. */
  readonly onFailure: (error: unknown) => void;
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
    getMessages: command(WS_METHODS.paGetMessages),
    sendMessage: command(WS_METHODS.paSendMessage),
    interruptSession: command(WS_METHODS.paInterruptSession),
    respondRequest: command(WS_METHODS.paRespondRequest),
    /**
     * Streams a session until the returned stop is called. Every reconnect, including after a
     * new connection to the environment, resumes from the last event's token, so the server
     * replays only what was missed or answers `snapshotRequired`.
     */
    followSession: (registry: AtomRegistry.AtomRegistry, follower: PaSessionFollower) => {
      let resumeToken: string | undefined;
      const input = (): PaSubscribeSessionInput => ({
        botId: follower.botId,
        sessionId: follower.sessionId,
        ...(resumeToken !== undefined ? { resumeToken } : {}),
      });
      const fiber = Effect.runFork(
        followStreamInEnvironment(
          follower.environmentId,
          subscribeDynamic(WS_METHODS.paSubscribeSession, () => Effect.sync(input), {
            retryExpectedFailureAfter: "1 second",
            onExpectedFailure: (cause) =>
              Effect.sync(() => follower.onFailure(Cause.squash(cause))),
          }),
        ).pipe(
          Stream.runForEach((event) =>
            Effect.sync(() => {
              resumeToken = event.resumeToken;
              follower.onEvent(event);
            }),
          ),
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.void
              : Effect.sync(() => follower.onFailure(Cause.squash(cause))),
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
