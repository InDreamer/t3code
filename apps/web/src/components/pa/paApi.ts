import {
  createPaEnvironmentCommands,
  isPermanentPaFailure,
} from "@t3tools/client-runtime/pa/environment";
import {
  runAtomCommand,
  squashAtomCommandFailure,
  type AtomCommand,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  PaAttachment,
  PaConfigSectionValue,
  PaCreateBotInput,
  PaGetMessagesInput,
  PaListSessionsInput,
  PaManageQueuedItemInput,
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
export const paSendPermissionAtom = pa.sendMessage.permissionAtom;

const PRIMARY_ENVIRONMENT_WAIT_MS = 15_000;

/** The primary environment's id, waiting briefly while the app is still discovering it. */
function primaryEnvironmentId(): Promise<EnvironmentId> {
  const ready = readPrimaryEnvironmentId();
  if (ready !== null) return Promise.resolve(ready);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(m(msg("Not connected to the server yet"))));
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
  environmentId?: EnvironmentId,
): Promise<A> {
  const result = await runAtomCommand(
    appAtomRegistry,
    command,
    { environmentId: environmentId ?? (await primaryEnvironmentId()), input },
    { reportFailure: false },
  );
  if (result._tag === "Success") return result.value;
  throw squashAtomCommandFailure(result);
}

export function paErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

// StrictMode mounts twice; without sharing the in-flight create each mount mints its own session.
const primarySessionCreates = new Map<
  string,
  {
    requestId: string;
    inFlight?: Promise<PaSessionSummary>;
  }
>();

/** An idempotency key: the engine applies a retried request with the same key once. */
export function makePaRequestKey(prefix: string): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return `${prefix}-${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

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
  listSessions: (botId: string, page?: Omit<PaListSessionsInput, "botId">) =>
    call(pa.listSessions, { botId, ...page }),
  /** `requestId` makes a retried create (after a lost answer) return the same session. */
  createSession: (botId: string, requestId: string, title?: string) =>
    call(pa.createSession, { botId, setPrimary: true, requestId, ...(title ? { title } : {}) }),
  renameSession: (botId: string, sessionId: string, title: string, requestId: string) =>
    call(pa.mutateSession, { botId, sessionId, action: "rename", requestId, title }),
  /** Creates the Bot's primary session once, however many mounts ask concurrently. */
  async ensurePrimarySession(botId: string) {
    const environmentId = await primaryEnvironmentId();
    const key = JSON.stringify([environmentId, botId]);
    const attempt = primarySessionCreates.get(key) ?? { requestId: makePaRequestKey("pa-session") };
    if (attempt.inFlight) return attempt.inFlight;
    primarySessionCreates.set(key, attempt);
    attempt.inFlight = call(
      pa.createSession,
      {
        botId,
        setPrimary: true,
        requestId: attempt.requestId,
      },
      environmentId,
    );
    try {
      const created = await attempt.inFlight;
      primarySessionCreates.delete(key);
      return created;
    } catch (error) {
      if (isPermanentPaFailure(error)) primarySessionCreates.delete(key);
      throw error;
    } finally {
      delete attempt.inFlight;
    }
  },
  /** One transcript page; omit `cursor` for the newest. */
  getMessages: (
    botId: string,
    sessionId: string,
    page?: Omit<PaGetMessagesInput, "botId" | "sessionId">,
  ) => call(pa.getMessages, { botId, sessionId, ...page }),
  /** `queued`: sent behind a running turn, so a queued admission is reported as waiting. */
  sendMessage: (
    botId: string,
    sessionId: string,
    text: string,
    inputId: string,
    queued = false,
    attachments?: ReadonlyArray<PaAttachment>,
  ) =>
    call(pa.sendMessage, {
      botId,
      sessionId,
      text,
      inputId,
      ...(attachments?.length ? { attachments } : {}),
      ...(queued ? { queued: true } : {}),
    }),
  interruptSession: (botId: string, sessionId: string) =>
    call(pa.interruptSession, { botId, sessionId }),
  steerSession: (botId: string, sessionId: string, text: string) =>
    call(pa.steerSession, { botId, sessionId, text }),
  manageQueuedItem: (
    botId: string,
    sessionId: string,
    itemId: string,
    action: PaManageQueuedItemInput["action"],
  ) => call(pa.manageQueuedItem, { botId, sessionId, itemId, action }),
  respondRequest: (input: PaRespondRequestInput) => call(pa.respondRequest, input),
  /** Streams a session over the environment connection; resumes on its own after drops. */
  followSession(
    botId: string,
    sessionId: string,
    handlers: {
      readonly onEvent: (event: PaStreamEvent) => void;
      readonly onFailure: (error: unknown, status: { readonly retrying: boolean }) => void;
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
        if (!stopped) handlers.onFailure(error, { retrying: false });
      },
    );
    return () => {
      stopped = true;
      stop?.();
    };
  },
};
