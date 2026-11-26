import { createPaEnvironmentCommands } from "@t3tools/client-runtime/pa/environment";
import {
  runAtomCommand,
  squashAtomCommandFailure,
  type AtomCommand,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  PaConfigSectionValue,
  PaCreateBotInput,
  PaMutateScheduleInput,
  PaRespondRequestInput,
  PaSelectBotModelInput,
  PaSessionSummary,
  PaStreamEvent,
  PaUpdateBotMetaInput,
} from "@t3tools/contracts";
import { msg } from "gt-react";

import { connectionAtomRuntime } from "../../connection/runtime";
import { m } from "../../i18n/messages";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { readPrimaryEnvironmentId } from "../../state/environments";
import { primaryEnvironmentIdAtom } from "../../state/primaryEnvironment";

const pa = createPaEnvironmentCommands(connectionAtomRuntime);

const PRIMARY_ENVIRONMENT_WAIT_MS = 15_000;

/** The primary environment's id, waiting briefly while the app is still discovering it. */
function primaryEnvironmentId(): Promise<EnvironmentId> {
  const ready = readPrimaryEnvironmentId();
  if (ready !== null) return Promise.resolve(ready);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(m(msg("还没有连接到服务器"))));
    }, PRIMARY_ENVIRONMENT_WAIT_MS);
    const unsubscribe = appAtomRegistry.subscribe(primaryEnvironmentIdAtom, (environmentId) => {
      if (environmentId === null) return;
      clearTimeout(timer);
      unsubscribe();
      resolve(environmentId);
    });
  });
}

async function call<I, A, E>(
  command: AtomCommand<{ readonly environmentId: EnvironmentId; readonly input: I }, A, E>,
  input: I,
): Promise<A> {
  const result = await runAtomCommand(
    appAtomRegistry,
    command,
    { environmentId: await primaryEnvironmentId(), input },
    { reportFailure: false },
  );
  if (result._tag === "Success") return result.value;
  throw squashAtomCommandFailure(result);
}

export function paErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

// StrictMode mounts twice; without sharing the in-flight create each mount mints its own session.
const primarySessionCreates = new Map<string, Promise<PaSessionSummary>>();

export const paApi = {
  listBots: () => call(pa.listBots, {}),
  createBot: (input: PaCreateBotInput) => call(pa.createBot, input),
  updateBotMeta: (input: PaUpdateBotMetaInput) => call(pa.updateBotMeta, input),
  markRead: (botId: string) => call(pa.updateBotMeta, { botId, markRead: true }),
  getBotModels: (botId: string, sessionId?: string) =>
    call(pa.getBotModels, { botId, ...(sessionId ? { sessionId } : {}) }),
  selectBotModel: (input: PaSelectBotModelInput) => call(pa.selectBotModel, input),
  getBotConfig: (botId: string) => call(pa.getBotConfig, { botId }),
  patchBotConfig: (botId: string, sectionId: string, value: PaConfigSectionValue) =>
    call(pa.patchBotConfig, { botId, sectionId, value }),
  listSchedules: (botId: string) => call(pa.listSchedules, { botId }).then((res) => res.schedules),
  mutateSchedule: (input: PaMutateScheduleInput) =>
    call(pa.mutateSchedule, input).then((res) => res.schedules),
  listCommands: (botId: string) => call(pa.listCommands, { botId }).then((res) => res.commands),
  listSessions: (botId: string) => call(pa.listSessions, { botId }),
  createSession: (botId: string, title?: string) =>
    call(pa.createSession, { botId, setPrimary: true, ...(title ? { title } : {}) }),
  /** Creates the Bot's primary session once, however many mounts ask concurrently. */
  ensurePrimarySession(botId: string) {
    const inFlight = primarySessionCreates.get(botId);
    if (inFlight) return inFlight;
    const created = call(pa.createSession, { botId, setPrimary: true });
    primarySessionCreates.set(botId, created);
    const forget = () => {
      if (primarySessionCreates.get(botId) === created) primarySessionCreates.delete(botId);
    };
    void created.then(forget, forget);
    return created;
  },
  getMessages: (botId: string, sessionId: string) =>
    call(pa.getMessages, { botId, sessionId }).then((res) => res.messages),
  sendMessage: (botId: string, sessionId: string, text: string, inputId: string) =>
    call(pa.sendMessage, { botId, sessionId, text, inputId }),
  interruptSession: (botId: string, sessionId: string) =>
    call(pa.interruptSession, { botId, sessionId }),
  respondRequest: (input: PaRespondRequestInput) => call(pa.respondRequest, input),
  /** Streams a session over the environment connection; resumes on its own after drops. */
  followSession(
    botId: string,
    sessionId: string,
    handlers: {
      readonly onEvent: (event: PaStreamEvent) => void;
      readonly onFailure: (error: unknown) => void;
    },
  ): () => void {
    let stop: (() => void) | null = null;
    let stopped = false;
    primaryEnvironmentId().then(
      (environmentId) => {
        if (stopped) return;
        stop = pa.followSession(appAtomRegistry, { environmentId, botId, sessionId, ...handlers });
      },
      (error: unknown) => {
        if (!stopped) handlers.onFailure(error);
      },
    );
    return () => {
      stopped = true;
      stop?.();
    };
  },
};
