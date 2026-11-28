import { createPaPrimarySessionCreates, makePaRequestKey } from "@t3tools/client-runtime/pa/chat";
import { createPaEnvironmentCommands } from "@t3tools/client-runtime/pa/environment";
import { createPaModelCatalogCache } from "@t3tools/client-runtime/pa/models";
import {
  runAtomCommand,
  squashAtomCommandFailure,
  type AtomCommand,
} from "@t3tools/client-runtime/state/runtime";
import {
  EnvironmentId,
  type PaAttachment,
  type PaConfigSectionValue,
  type PaCreateBotInput,
  type PaGetMessagesInput,
  type PaListSessionsInput,
  type PaManageQueuedItemInput,
  type PaMutateScheduleInput,
  type PaRespondRequestInput,
  type PaSelectBotModelInput,
  type PaSessionSummary,
  type PaStreamEvent,
  type PaUpdateBotMetaInput,
} from "@t3tools/contracts";
import { msg } from "gt-react";

import { connectionAtomRuntime } from "../../connection/runtime";
import { m } from "../../i18n/messages";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { readPrimaryEnvironmentId } from "../../state/environments";
import { primaryEnvironmentIdAtom } from "../../state/primaryEnvironment";

const pa = createPaEnvironmentCommands(connectionAtomRuntime);
export const paCreateBotPermissionAtom = pa.createBot.permissionAtom;
export const paSelectModelPermissionAtom = pa.selectBotModel.permissionAtom;
export const paPatchConfigPermissionAtom = pa.patchBotConfig.permissionAtom;
export const paMutateSchedulePermissionAtom = pa.mutateSchedule.permissionAtom;
export const paUpdateMetaPermissionAtom = pa.updateBotMeta.permissionAtom;
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
  options?: { readonly environmentId?: EnvironmentId; readonly reportDefect?: boolean },
): Promise<A> {
  const result = await runAtomCommand(
    appAtomRegistry,
    command,
    { environmentId: options?.environmentId ?? (await primaryEnvironmentId()), input },
    { reportFailure: false, reportDefect: options?.reportDefect ?? true },
  );
  if (result._tag === "Success") return result.value;
  throw squashAtomCommandFailure(result);
}

export function paErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

// StrictMode mounts twice; without sharing the in-flight create each mount mints its own session.
const ensurePrimarySessionCreate = createPaPrimarySessionCreates<PaSessionSummary>(() =>
  makePaRequestKey("pa-session"),
);

export const paApi = {
  listBots: () => call(pa.listBots, {}),
  createBot: (input: PaCreateBotInput) => call(pa.createBot, input),
  updateBotMeta: (input: PaUpdateBotMetaInput) => call(pa.updateBotMeta, input),
  markRead: (botId: string) => call(pa.updateBotMeta, { botId, markRead: true }),
  getBotModels: (environmentId: EnvironmentId, botId: string, sessionId?: string | null) =>
    call(pa.getBotModels, { botId, ...(sessionId ? { sessionId } : {}) }, { environmentId }),
  selectBotModel: (environmentId: EnvironmentId, input: PaSelectBotModelInput) =>
    call(pa.selectBotModel, input, { environmentId }),
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
    return ensurePrimarySessionCreate(JSON.stringify([environmentId, botId]), (requestId) =>
      call(pa.createSession, { botId, setPrimary: true, requestId }, { environmentId }),
    );
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
  respondRequest: (input: PaRespondRequestInput) =>
    call(pa.respondRequest, input, { reportDefect: false }),
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

/** The composer's model trigger and its picker read one catalog per Bot and session. */
export const paModelCatalogs = createPaModelCatalogCache((key) =>
  paApi.getBotModels(EnvironmentId.make(key.environmentId), key.botId, key.sessionId),
);
