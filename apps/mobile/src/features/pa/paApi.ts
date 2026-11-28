import { createPaEnvironmentCache } from "@t3tools/client-runtime/pa/cache";
import { createPaPrimarySessionCreates, makePaRequestKey } from "@t3tools/client-runtime/pa/chat";
import { createPaEnvironmentCommands } from "@t3tools/client-runtime/pa/environment";
import type { PaFollowSessionOptions } from "@t3tools/client-runtime/pa/bot-chat";
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
  type PaUpdateBotMetaInput,
} from "@t3tools/contracts";

import { connectionAtomRuntime } from "../../connection/runtime";
import { appAtomRegistry } from "../../state/atom-registry";

const pa = createPaEnvironmentCommands(connectionAtomRuntime);
export const paCache = createPaEnvironmentCache(appAtomRegistry, connectionAtomRuntime);

/** Whether this connection may talk to an environment's Bots; the server stays authoritative. */
export const paCreateBotPermissionAtom = pa.createBot.permissionAtom;
export const paSelectModelPermissionAtom = pa.selectBotModel.permissionAtom;
export const paPatchConfigPermissionAtom = pa.patchBotConfig.permissionAtom;
export const paMutateSchedulePermissionAtom = pa.mutateSchedule.permissionAtom;
export const paUpdateMetaPermissionAtom = pa.updateBotMeta.permissionAtom;
export const paOperatePermissionAtom = pa.sendMessage.permissionAtom;

async function call<I, A, E>(
  command: AtomCommand<{ readonly environmentId: EnvironmentId; readonly input: I }, A, E>,
  environmentId: EnvironmentId,
  input: I,
  reportDefect = true,
): Promise<A> {
  const result = await runAtomCommand(
    appAtomRegistry,
    command,
    { environmentId, input },
    { reportFailure: false, reportDefect },
  );
  if (result._tag === "Success") return result.value;
  throw squashAtomCommandFailure(result);
}

export function paErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

// The Bot page and its sheets can both find a Bot without a session and ask for one at once.
const ensurePrimarySessionCreate = createPaPrimarySessionCreates<PaSessionSummary>(() =>
  makePaRequestKey("pa-session"),
);

/** One environment's Bot RPCs, as plain promises. */
export function paClient(environmentIdValue: string) {
  const environmentId = EnvironmentId.make(environmentIdValue);
  return {
    environmentId,
    listBots: () => call(pa.listBots, environmentId, {}),
    createBot: (input: PaCreateBotInput) => call(pa.createBot, environmentId, input),
    updateBotMeta: (input: PaUpdateBotMetaInput) => call(pa.updateBotMeta, environmentId, input),
    markRead: (botId: string, seenReply?: PaUpdateBotMetaInput["seenReply"]) =>
      call(pa.updateBotMeta, environmentId, {
        botId,
        markRead: true,
        ...(seenReply ? { seenReply } : {}),
      }),
    getBotModels: (botId: string, sessionId?: string | null) =>
      call(pa.getBotModels, environmentId, { botId, ...(sessionId ? { sessionId } : {}) }),
    selectBotModel: (input: PaSelectBotModelInput) => call(pa.selectBotModel, environmentId, input),
    getBotConfig: (botId: string) => call(pa.getBotConfig, environmentId, { botId }),
    patchBotConfig: (botId: string, sectionId: string, value: PaConfigSectionValue) =>
      call(pa.patchBotConfig, environmentId, { botId, sectionId, value }),
    listSchedules: (botId: string) =>
      call(pa.listSchedules, environmentId, { botId }).then((res) => res.schedules),
    mutateSchedule: (input: PaMutateScheduleInput) =>
      call(pa.mutateSchedule, environmentId, input).then((res) => res.schedules),
    listCommands: (botId: string) =>
      call(pa.listCommands, environmentId, { botId }).then((res) => res.commands),
    listSessions: (botId: string, page?: Omit<PaListSessionsInput, "botId">) =>
      call(pa.listSessions, environmentId, { botId, ...page }),
    /** `requestId` makes a retried create (after a lost answer) return the same session. */
    createSession: (botId: string, requestId: string, title?: string) =>
      call(pa.createSession, environmentId, {
        botId,
        setPrimary: true,
        requestId,
        ...(title ? { title } : {}),
      }),
    renameSession: (botId: string, sessionId: string, title: string, requestId: string) =>
      call(pa.mutateSession, environmentId, {
        botId,
        sessionId,
        action: "rename",
        requestId,
        title,
      }),
    /** Creates the Bot's primary session once, however many screens ask concurrently. */
    ensurePrimarySession: (botId: string) =>
      ensurePrimarySessionCreate(JSON.stringify([environmentId, botId]), (requestId) =>
        call(pa.createSession, environmentId, { botId, setPrimary: true, requestId }),
      ),
    getMessages: (
      botId: string,
      sessionId: string,
      page?: Omit<PaGetMessagesInput, "botId" | "sessionId">,
    ) => call(pa.getMessages, environmentId, { botId, sessionId, ...page }),
    sendMessage: (
      botId: string,
      sessionId: string,
      text: string,
      inputId: string,
      queued: boolean,
      attachments: ReadonlyArray<PaAttachment>,
    ) =>
      call(pa.sendMessage, environmentId, {
        botId,
        sessionId,
        text,
        inputId,
        ...(attachments.length ? { attachments } : {}),
        ...(queued ? { queued: true } : {}),
      }),
    interruptSession: (botId: string, sessionId: string) =>
      call(pa.interruptSession, environmentId, { botId, sessionId }),
    steerSession: (botId: string, sessionId: string, text: string) =>
      call(pa.steerSession, environmentId, { botId, sessionId, text }),
    manageQueuedItem: (
      botId: string,
      sessionId: string,
      itemId: string,
      action: PaManageQueuedItemInput["action"],
    ) => call(pa.manageQueuedItem, environmentId, { botId, sessionId, itemId, action }),
    /** Secret values pass straight through; nothing here keeps or reports them. */
    respondRequest: (input: PaRespondRequestInput) =>
      call(pa.respondRequest, environmentId, input, false),
    followSession: (botId: string, sessionId: string, handlers: PaFollowSessionOptions) =>
      pa.followSession(appAtomRegistry, { environmentId, botId, sessionId, ...handlers }),
  };
}

export type PaClient = ReturnType<typeof paClient>;
