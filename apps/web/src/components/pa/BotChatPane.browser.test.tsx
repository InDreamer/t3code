import { GTProvider } from "gt-react";
import { page, userEvent } from "vite-plus/test/browser";
import * as sessionState from "../../state/session";
import { Atom } from "effect/reactivity";
import {
  EnvironmentId,
  PaError,
  type PaCapabilities,
  type PaModelCatalog,
  type PaStreamEvent,
  type PaSteerSessionResult,
} from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { act, render } from "../../../test/render";
import { BotChatPane } from "./BotChatPane";
import { attachmentEnvironment } from "../../state/attachments";
import { SecretRequestField } from "../chat/SecretRequestField";
import { paApi, paModelCatalogs, paSelectModelPermissionAtom, paSendPermissionAtom } from "./paApi";
import { toastManager } from "../ui/toast";
import type { useEnvironmentSpeechInput } from "../../speech/useEnvironmentSpeechInput";

const voice = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  const store = {
    available: false,
    phase: "idle" as "idle" | "recording",
    input: null as Parameters<typeof useEnvironmentSpeechInput>[0] | null,
    queued: null as ((text: string) => void) | null,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setPhase: (phase: "idle" | "recording") => {
      store.phase = phase;
      for (const listener of listeners) listener();
    },
  };
  return store;
});

vi.mock(import("./paApi"), async (original) => {
  const allowed = Atom.make(true);
  const api = await original();
  return {
    ...api,
    paSendPermissionAtom: vi.fn(() => allowed),
    paSelectModelPermissionAtom: vi.fn(api.paSelectModelPermissionAtom),
  };
});
vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  usePrimaryEnvironmentId: () => EnvironmentId.make("pa-browser"),
}));

// The recording itself is the speech hook's to test; here only the composer's side of it matters.
vi.mock(import("../../speech/useEnvironmentSpeechInput"), async (original) => {
  const { useSyncExternalStore } = await import("react");
  return {
    ...(await original()),
    useEnvironmentSpeechInput: (input: Parameters<typeof useEnvironmentSpeechInput>[0]) => {
      voice.input = input;
      const phase = useSyncExternalStore(voice.subscribe, () => voice.phase);
      const active = phase !== "idle";
      return {
        available: voice.available,
        status: null,
        transcriptionEnvironmentId: null,
        transcriptionEnvironmentLabel: null,
        setup: {
          open: false,
          step: 0,
          model: null,
          language: null,
          downloading: false,
          catalogFailed: false,
          error: null,
          setOpen: () => undefined,
          retryCatalog: null,
          download: async () => undefined,
          cancelDownload: async () => undefined,
          startRecording: async () => undefined,
        },
        state: { phase, error: null, errorAction: null },
        preview: active ? { committed: "there", tentative: "" } : null,
        level: 0,
        recordingStartedAt: null,
        preparing: false,
        blocksSubmission: active,
        freezesEditor: active,
        start: async () => voice.setPhase("recording"),
        submitAfterDictation: (submit: (text: string) => void) => {
          voice.queued = submit;
        },
        stop: async () => undefined,
        cancel: () => voice.setPhase("idle"),
        skipPostProcessing: () => undefined,
      };
    },
  };
});

vi.mock(import("../../state/session"), async (original) => ({
  ...(await original()),
  useEnvironmentScope: vi.fn(() => true),
}));

const bot = {
  botId: "hermes:main",
  instanceId: "hermes",
  driver: "hermes",
  engineLabel: "Hermes",
  agentRef: "main",
  name: "Test bot",
  description: "",
  avatarColor: "#64748b",
  avatarShape: "circle" as const,
  pinned: false,
  isDefault: false,
  model: null,
  provider: null,
  online: true,
  running: false,
  unread: false,
  lastMessagePreview: null,
  lastActivityAt: null,
  primarySessionId: "primary",
};
const capabilities: PaCapabilities = {
  sessions: { create: true, rename: true, renameExisting: true },
  execution: { interrupt: true, approvals: true, clarify: true, queue: true, steer: true },
  models: { supported: false, scope: "none", allowCustom: false },
  commands: { supported: false },
  config: { supported: false },
  lifecycle: { create: false, delete: false },
  schedules: { supported: false },
};
const translations = {};
function setup(spies: DisposableStack) {
  const select = vi.fn();
  const read = spies
    .use(vi.spyOn(paApi, "getMessages"))
    .mockResolvedValue({ messages: [], nextCursor: null });
  const list = spies.use(vi.spyOn(paApi, "listSessions")).mockResolvedValue({
    sessions: [],
    primarySessionId: "primary",
    nextCursor: "next",
  });
  spies.use(vi.spyOn(paApi, "markRead")).mockResolvedValue(undefined);
  let emit!: (event: PaStreamEvent) => void;
  let fail!: Parameters<typeof paApi.followSession>[2]["onFailure"];
  spies.use(vi.spyOn(paApi, "followSession")).mockImplementation((_bot, sessionId, handlers) => {
    fail = handlers.onFailure;
    emit = handlers.onEvent;
    emit({
      type: "snapshot",
      sessionId,
      running: true,
      openRequests: [],
      snapshotRequired: false,
      resumeToken: "1",
    });
    return () => undefined;
  });
  const send = spies
    .use(vi.spyOn(paApi, "sendMessage"))
    .mockResolvedValue({ kind: "turn", sessionId: "deep", queued: true });
  const ack = Promise.withResolvers<PaSteerSessionResult>();
  const steer = spies.use(vi.spyOn(paApi, "steerSession")).mockReturnValue(ack.promise);
  const view = (sessionId: string, caps = capabilities) => (
    <GTProvider locale="en" translations={translations}>
      <BotChatPane
        bot={bot}
        capabilities={caps}
        selectedSessionId={sessionId}
        onSelectSession={select}
        onActivity={() => undefined}
        onOpenSettings={() => undefined}
      />
    </GTProvider>
  );
  return {
    select,
    list,
    read,
    send,
    steer,
    ack,
    view,
    fail: (reason: "Unavailable" | "NotFound") =>
      fail(new PaError({ reason, message: reason }), { retrying: false }),
    emit: (event: PaStreamEvent) => emit(event),
  };
}
it.each(["complete", "switched", "queued", "voice"] as const)(
  "handles a pending steer when the session is %s",
  async (scenario) => {
    using spies = new DisposableStack();
    const flow = setup(spies);
    using toast = vi.spyOn(toastManager, "add");
    await using screen = await render(flow.view("deep"));
    expect(flow.select).not.toHaveBeenCalled();
    expect(flow.read).toHaveBeenCalledWith(bot.botId, "deep");
    await screen.getByRole("textbox").fill("focus on tests");
    await screen.getByRole("button", { name: "Steer the current turn" }).click();
    expect(flow.steer).toHaveBeenCalledWith(bot.botId, "deep", "focus on tests");
    if (scenario === "complete") {
      await act(() =>
        flow.emit({
          type: "turn.completed",
          status: "complete",
          sessionId: "deep",
          resumeToken: "2",
        }),
      );
      flow.read.mockClear();
    }
    if (scenario === "switched") await screen.rerender(flow.view("other"));
    await act(async () => {
      flow.ack.resolve({
        status:
          scenario === "voice"
            ? "voiceStopped"
            : scenario === "complete"
              ? "delivered"
              : "notDelivered",
      });
      await flow.ack.promise;
    });
    if (scenario === "queued")
      expect(flow.send).toHaveBeenCalledWith(
        bot.botId,
        "deep",
        "focus on tests",
        expect.any(String),
        true,
        [],
      );
    else expect(flow.send).not.toHaveBeenCalled();
    if (scenario === "switched") {
      await expect.element(screen.getByRole("textbox")).toHaveValue("");
      await screen.rerender(flow.view("deep"));
      await expect.element(screen.getByRole("textbox")).toHaveValue("focus on tests");
    }
    if (scenario === "complete") expect(flow.read).toHaveBeenCalledWith(bot.botId, "deep");
    if (scenario === "voice")
      expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Voice chat stopped." }));
    expect(screen.container.querySelector("[data-user-message-bubble]")).toBeNull();
  },
);

it.each(["lost reply", "idle snapshot"] as const)(
  "settles a pending send after a %s",
  async (scenario) => {
    using spies = new DisposableStack();
    const flow = setup(spies);
    const receipt = Promise.withResolvers<Awaited<ReturnType<typeof paApi.sendMessage>>>();
    flow.send.mockReturnValueOnce(receipt.promise);
    await using screen = await render(flow.view("deep"));
    const idle = {
      type: "snapshot",
      running: false,
      sessionId: "deep",
      resumeToken: "idle",
      openRequests: [],
      snapshotRequired: true,
    } as const;
    await act(() => flow.emit(idle));
    await screen.getByRole("textbox").fill("plan");
    await userEvent.keyboard("{Enter}");
    expect(flow.send).toHaveBeenCalledOnce();
    if (scenario === "lost reply") {
      await screen.rerender(flow.view("other"));
      await screen.getByRole("textbox").fill("another draft");
      await act(async () => {
        receipt.reject(new Error("lost"));
        await receipt.promise.catch(() => undefined);
      });
      await expect.element(screen.getByRole("textbox")).toHaveValue("another draft");
      await screen.rerender(flow.view("deep"));
      await expect.element(screen.getByRole("textbox")).toHaveValue("plan");
    } else {
      await act(() => flow.emit({ type: "turn.started", sessionId: "deep", resumeToken: "start" }));
      flow.read.mockResolvedValue({
        messages: [
          { id: "user", rowKind: "message", role: "user", text: "rewritten plan", timestamp: 1 },
        ],
      });
      await act(() => flow.emit(idle));
      await act(async () => {
        receipt.resolve({ kind: "turn", sessionId: "deep" });
        await receipt.promise;
      });
      await expect.element(screen.getByText("rewritten plan", { exact: true })).toBeVisible();
      await expect.element(screen.getByText("plan", { exact: true })).not.toBeInTheDocument();
    }
  },
);

it("settles the live reply when a delivered steer supersedes the outstanding history read", async () => {
  using spies = new DisposableStack();
  const flow = setup(spies);
  await using screen = await render(flow.view("deep"));
  await screen.getByRole("textbox").fill("focus");
  await screen.getByRole("button", { name: "Steer the current turn" }).click();
  const text = "The persisted answer.";
  const delayed = Promise.withResolvers<Awaited<ReturnType<typeof paApi.getMessages>>>();
  const history = {
    messages: [
      {
        role: "assistant" as const,
        rowKind: "message" as const,
        id: "row-2",
        rowId: 2,
        text,
        timestamp: null,
      },
    ],
    nextCursor: null,
  };
  flow.read.mockReturnValueOnce(delayed.promise).mockResolvedValue(history);
  await act(() =>
    flow.emit({
      type: "turn.completed",
      status: "complete",
      text,
      sessionId: "deep",
      resumeToken: "2",
    }),
  );
  await expect.element(screen.getByText(text, { exact: true })).toBeVisible();
  await act(async () => {
    flow.ack.resolve({ status: "delivered" });
    await flow.ack.promise;
  });
  expect(flow.read).toHaveBeenCalledTimes(3);
  await act(async () => {
    delayed.resolve({ messages: [], nextCursor: null });
    await delayed.promise;
  });
  expect(screen.getByText(text, { exact: true }).elements()).toHaveLength(1);
  await expect.element(screen.getByRole("button", { name: /copy/i }).last()).toBeVisible();
});

it("reuses an uncertain new-conversation request from the picker", async () => {
  using spies = new DisposableStack();
  const flow = setup(spies);
  using create = vi
    .spyOn(paApi, "createSession")
    .mockRejectedValueOnce(new PaError({ reason: "Unavailable", message: "lost receipt" }))
    .mockResolvedValue({
      sessionId: "new",
      title: "New conversation",
      source: "gui",
      model: null,
      running: false,
      messageCount: 0,
      startedAt: null,
      lastActivityAt: null,
      isPrimary: true,
    });
  await using screen = await render(flow.view("deep"));
  for (let i = 0; i < 2; i++) {
    await screen.getByRole("button", { name: "Session", exact: true }).click();
    await page.getByRole("button", { name: "New conversation", exact: true }).click();
  }
  expect(create).toHaveBeenCalledTimes(2);
  expect(create.mock.calls[0]).toEqual(create.mock.calls[1]);
  expect(flow.select).toHaveBeenCalledWith("new");
});

it("disables featured commands on an empty read-only conversation", async () => {
  using spies = new DisposableStack();
  spies.use(vi.spyOn(paApi, "listCommands")).mockResolvedValue([
    {
      name: "/status",
      description: "Status",
      group: "command",
      featured: true,
      handling: "engine",
      requiredScope: "operate",
    },
  ]);
  const denied = Atom.make(false);
  const allowed = Atom.make(true);
  vi.mocked(paSendPermissionAtom).mockImplementation(() => denied);
  spies.defer(() => vi.mocked(paSendPermissionAtom).mockImplementation(() => allowed));
  const flow = setup(spies);
  await using screen = await render(
    flow.view("deep", { ...capabilities, commands: { supported: true } }),
  );
  await act(() =>
    flow.emit({ type: "turn.completed", status: "complete", sessionId: "deep", resumeToken: "2" }),
  );
  await expect.element(screen.getByRole("button", { name: "/status", exact: true })).toBeDisabled();
});

it("keeps an operate-only user's model command in the composer", async () => {
  using spies = new DisposableStack();
  const flow = setup(spies);
  spies.use(vi.spyOn(paApi, "listCommands")).mockResolvedValue([
    {
      name: "/model",
      description: "Models",
      group: "command",
      featured: true,
      handling: "client:model-picker",
      requiredScope: "operate",
    },
  ]);
  await using screen = await render(
    flow.view("deep", {
      ...capabilities,
      commands: { supported: true },
      models: { supported: true, scope: "session", allowCustom: false },
    }),
  );
  await act(() =>
    flow.emit({
      type: "snapshot",
      sessionId: "deep",
      running: false,
      openRequests: [],
      snapshotRequired: true,
      resumeToken: "idle",
    }),
  );
  expect(screen.getByRole("button", { name: /^Switch model/ }).elements()).toHaveLength(0);
  expect(screen.getByRole("button", { name: "/model", exact: true }).elements()).toHaveLength(0);
  const draft = screen.getByRole("textbox");
  await draft.fill("/model");
  await userEvent.keyboard("{Enter}");
  await expect.element(draft).toHaveValue("/model");
  expect(flow.send).not.toHaveBeenCalled();
});

it("confirms the exact cross-provider search match in the composer's environment, not an IME Enter", async () => {
  using spies = new DisposableStack();
  const flow = setup(spies);
  const allowed = Atom.make(true);
  vi.mocked(paSelectModelPermissionAtom).mockReturnValue(allowed);
  spies.defer(() => vi.mocked(paSelectModelPermissionAtom).mockReset());
  spies.defer(() => paModelCatalogs.clear());
  const catalog: PaModelCatalog = {
    scope: "agent",
    allowCustom: false,
    current: { provider: "p1", model: "old" },
    providers: [
      {
        id: "p1",
        label: "First",
        isCurrent: true,
        badge: "current",
        tier: "primary",
        models: [{ id: "old" }, { id: "fast-preview" }],
      },
      { id: "p2", label: "Second", isCurrent: false, tier: "primary", models: [{ id: "fast" }] },
    ],
  };
  const read = spies.use(vi.spyOn(paApi, "getBotModels")).mockResolvedValue(catalog);
  const current = { provider: "p2", model: "fast" };
  const write = spies
    .use(vi.spyOn(paApi, "selectBotModel"))
    .mockResolvedValueOnce({ status: "confirmRequired", message: "Confirm this model" })
    .mockResolvedValueOnce({ status: "applied", current });
  await using screen = await render(
    flow.view("deep", {
      ...capabilities,
      models: { supported: true, scope: "agent", allowCustom: false },
    }),
  );
  const refreshed = Promise.withResolvers<PaModelCatalog>();
  read.mockReturnValueOnce(refreshed.promise);
  await screen.getByRole("button", { name: "Switch model: old" }).click();
  const search = page.getByRole("searchbox", { name: "Search models or providers" });
  await search.fill("fast");
  await expect.element(page.getByRole("radio", { name: "fast", exact: true })).toBeVisible();
  expect(read).toHaveBeenCalledTimes(2);
  await act(async () => {
    refreshed.resolve(catalog);
    await refreshed.promise;
  });
  await act(() => {
    for (const composition of [{ isComposing: true }, { keyCode: 229 }]) {
      search
        .element()
        .dispatchEvent(
          new KeyboardEvent("keydown", { key: "Enter", bubbles: true, ...composition }),
        );
    }
  });
  expect(write).not.toHaveBeenCalled();
  await userEvent.keyboard("{Enter}");
  await expect.element(page.getByText("Confirm this model")).toBeVisible();
  const change = { botId: bot.botId, sessionId: "deep", ...current };
  expect(write).toHaveBeenCalledExactlyOnceWith(EnvironmentId.make("pa-browser"), change);
  const switched = Promise.withResolvers<PaModelCatalog>();
  read.mockReturnValueOnce(switched.promise);
  await page.getByRole("button", { name: "Confirm switch" }).click();
  await expect
    .element(page.getByRole("radiogroup", { name: "Second" }).getByText("Current"))
    .toBeVisible();
  expect(write).toHaveBeenLastCalledWith(EnvironmentId.make("pa-browser"), {
    ...change,
    confirm: true,
  });
  expect(read).toHaveBeenCalledTimes(3);
  await act(async () => {
    switched.resolve({ ...catalog, current });
    await switched.promise;
  });
});

it("drops clarify answers after the request resolves or the session changes", async () => {
  using spies = new DisposableStack();
  const flow = setup(spies);
  await using screen = await render(flow.view("deep"));
  const open = (sessionId: string) =>
    act(() =>
      flow.emit({
        type: "request.opened",
        sessionId,
        resumeToken: "open",
        request: {
          kind: "clarify",
          requestId: "same",
          title: "Question",
          detail: "",
          questions: [{ id: "answer", prompt: "Reply" }],
        },
      }),
    );
  const answer = screen.getByPlaceholder("Enter your reply…");
  await open("deep");
  await answer.fill("first");
  await act(() =>
    flow.emit({
      type: "request.resolved",
      sessionId: "deep",
      requestId: "same",
      resumeToken: "end",
    }),
  );
  await open("deep");
  await expect.element(answer).toHaveValue("");
  await answer.fill("second");
  await screen.rerender(flow.view("other"));
  await open("other");
  await expect.element(answer).toHaveValue("");
});

it("leaves ordinary secret inputs unlimited and applies the PA response limit", async () => {
  using spies = new DisposableStack();
  const flow = setup(spies);
  await using screen = await render(flow.view("deep"));
  await act(() =>
    flow.emit({
      type: "request.opened",
      sessionId: "deep",
      resumeToken: "key",
      request: {
        requestId: "secret",
        kind: "secret",
        title: "API key",
        detail: "",
        fields: [{ id: "key", label: "API key", required: true }],
      },
    }),
  );
  expect(screen.container.querySelector('input[type="password"]')?.getAttribute("maxlength")).toBe(
    "16000",
  );
  await screen.rerender(
    <SecretRequestField
      id="normal"
      input={{ key: "key", label: "Key", secret: true, placeholder: "" }}
      label="Key"
      value=""
      invalid={false}
      disabled={false}
      describedBy=""
      onChange={() => undefined}
    />,
  );
  expect(screen.container.querySelector('input[type="password"]')).not.toHaveAttribute("maxlength");
});

it("leaves text-only paste native and consumes the companion text of an attachment paste", async () => {
  using spies = new DisposableStack();
  spies
    .use(vi.spyOn(attachmentEnvironment.createUploadUrl, "permissionAtom"))
    .mockReturnValue(Atom.make(true));
  const flow = setup(spies);
  await using screen = await render(
    flow.view("deep", { ...capabilities, attachments: { files: true, images: false } }),
  );
  const textbox = screen.getByRole("textbox").element();
  const paste = async (data: DataTransfer) => {
    const event = new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
      clipboardData: data,
    });
    await act(() => {
      textbox.dispatchEvent(event);
    });
    return event.defaultPrevented;
  };
  const data = new DataTransfer();
  data.setData("text/plain", "Native paste");
  using read = vi.spyOn(data, "getData");
  expect(await paste(data)).toBe(false);
  expect(read).not.toHaveBeenCalled();
  data.items.add(new File(["<svg/>"], "diagram.svg", { type: "image/svg+xml" }));
  expect(await paste(data)).toBe(true);
});

it("shows a credential request as read-only without provider management permission", async () => {
  using _scope = vi.spyOn(sessionState, "useEnvironmentScope").mockReturnValue(false);
  using spies = new DisposableStack();
  const flow = setup(spies);
  await using screen = await render(flow.view("deep"));
  await act(() =>
    flow.emit({
      type: "request.opened",
      sessionId: "deep",
      resumeToken: "key",
      request: {
        requestId: "secret",
        kind: "secret",
        title: "API key",
        detail: "",
        fields: [{ id: "key", label: "API key", secret: true, required: true }],
      },
    }),
  );
  await expect.element(screen.getByText(/You need permission to operate this chat/)).toBeVisible();
  expect(screen.container.querySelector('input[type="password"]')).toBeNull();
  expect(screen.getByRole("button", { name: "Skip" }).elements()).toHaveLength(0);
});

it("keeps the URL session through a connection error and falls back after NotFound", async () => {
  using spies = new DisposableStack();
  const flow = setup(spies);
  await using screen = await render(flow.view("deep"));
  await act(() => flow.fail("Unavailable"));
  expect(flow.select).not.toHaveBeenCalled();
  await act(() => flow.fail("NotFound"));
  expect(flow.select).toHaveBeenCalledWith("primary");
  expect(flow.list).toHaveBeenCalledTimes(2);
  await screen.unmount();
});
it("keeps the rename error in the picker and refocuses the title for a retry", async () => {
  using spies = new DisposableStack();
  const flow = setup(spies);
  flow.list.mockResolvedValue({
    sessions: [
      {
        sessionId: "deep",
        title: "Trip",
        source: "gui",
        model: null,
        running: false,
        messageCount: 0,
        startedAt: null,
        lastActivityAt: null,
        isPrimary: false,
      },
    ],
    primarySessionId: "primary",
    nextCursor: null,
  });
  using rename = vi
    .spyOn(paApi, "renameSession")
    .mockRejectedValueOnce(new PaError({ reason: "Unavailable", message: "lost reply" }))
    .mockResolvedValue({ sessionId: "deep", title: "Plans" });
  await using screen = await render(flow.view("deep"));
  await screen.getByRole("button", { name: "T3 Web", exact: true }).click();
  await page.getByRole("button", { name: "Rename conversation" }).click();
  const title = page.getByRole("textbox", { name: "Conversation title" });
  await title.fill("Plans");
  await userEvent.keyboard("{Enter}");
  await expect.element(page.getByRole("alert")).toHaveTextContent("lost reply");
  await expect.element(title).toHaveFocus();
  await userEvent.keyboard("{Enter}");
  await expect.element(page.getByRole("button", { name: /Plans/ }).last()).toBeVisible();
  expect(rename).toHaveBeenCalledTimes(2);
  expect(rename.mock.calls[0]).toEqual(rename.mock.calls[1]);
  await screen.rerender(
    flow.view("deep", { ...capabilities, sessions: { create: true, rename: true } }),
  );
  expect(page.getByRole("button", { name: "Rename conversation" }).elements()).toHaveLength(0);
});

it.each(["empty", "duplicate", "stale", "prepend"] as const)(
  "preserves bottom-follow behavior when an older page is %s",
  async (scenario) => {
    using spies = new DisposableStack();
    const flow = setup(spies);
    using scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
    const message = (id: string) => ({
      id,
      role: "user" as const,
      rowKind: "message" as const,
      text: id,
      timestamp: null,
    });
    const latest = message("latest");
    const newer = message("newer");
    const pending = Promise.withResolvers<Awaited<ReturnType<typeof paApi.getMessages>>>();
    flow.read.mockResolvedValue({ messages: [latest], nextCursor: "first" });
    await using screen = await render(flow.view("deep"));
    flow.read.mockReturnValueOnce(pending.promise);
    await screen.getByRole("button", { name: "Load earlier messages" }).click();
    if (scenario === "stale") {
      flow.read.mockResolvedValue({ messages: [latest, newer], nextCursor: "changed" });
      await act(() =>
        flow.emit({
          type: "turn.completed",
          status: "complete",
          sessionId: "deep",
          resumeToken: "2",
        }),
      );
    }
    scroll.mockClear();
    await act(async () => {
      pending.resolve({
        messages:
          scenario === "empty" ? [] : scenario === "duplicate" ? [latest] : [message("very old")],
        nextCursor: null,
      });
      await pending.promise;
    });
    expect(screen.getByText("very old", { exact: true }).elements()).toHaveLength(
      scenario === "prepend" ? 1 : 0,
    );
    expect(scroll).not.toHaveBeenCalled();
    flow.read.mockResolvedValue({ messages: [latest, newer, message("last")], nextCursor: "next" });
    await act(() =>
      flow.emit({
        type: "turn.completed",
        status: "complete",
        sessionId: "deep",
        resumeToken: "3",
      }),
    );
    expect(scroll.mock.calls.length > 0).toBe(scenario !== "prepend");
  },
);

function enableVoice(spies: DisposableStack) {
  voice.available = true;
  spies.defer(() => {
    voice.available = false;
    voice.input = null;
    voice.queued = null;
    voice.phase = "idle";
  });
}

/** What the speech session does when a recording ends: commit the transcript, then go idle. */
function finishDictation(text: string, caret: number) {
  voice.input?.commitDraft(text, { start: caret, end: caret });
  voice.setPhase("idle");
}

it("dictates at the caret and freezes the draft while recording", async () => {
  using spies = new DisposableStack();
  const flow = setup(spies);
  enableVoice(spies);
  await using screen = await render(flow.view("deep"));
  expect(voice.input?.offerSetup).toBe(true);
  await screen.getByRole("textbox").fill("hello world");
  const field = screen.container.querySelector("textarea");
  if (!field) throw new Error("The composer has no textarea");
  field.setSelectionRange(5, 5);
  expect(voice.input?.ownerKey).toBe(JSON.stringify(["pa", "pa-browser", bot.botId, "deep"]));
  expect(voice.input?.label).toBe(bot.name);
  expect(voice.input?.offerSetup).toBe(false);
  expect(voice.input?.persistentDraft).toBeUndefined();
  expect(voice.input?.readDraft()).toEqual({
    text: "hello world",
    selection: { start: 5, end: 5 },
  });

  await screen.getByRole("button", { name: "Start voice input" }).click();
  await expect.element(screen.getByRole("textbox")).toHaveAttribute("readonly");
  await expect
    .element(screen.getByRole("status", { name: "Live transcription" }))
    .toHaveTextContent("there");

  await act(() => finishDictation("hello there world", 11));
  await expect.element(screen.getByRole("textbox")).toHaveValue("hello there world");
  await expect.element(screen.getByRole("textbox")).not.toHaveAttribute("readonly");
  await vi.waitFor(() => {
    expect(document.activeElement).toBe(field);
    expect([field.selectionStart, field.selectionEnd]).toEqual([11, 11]);
  });
  expect(flow.send).not.toHaveBeenCalled();
});

it("only fills the draft when dictation finishes, even with a command", async () => {
  using spies = new DisposableStack();
  const flow = setup(spies);
  enableVoice(spies);
  const interrupt = spies.use(vi.spyOn(paApi, "interruptSession")).mockResolvedValue(undefined);
  spies.use(vi.spyOn(paApi, "listCommands")).mockResolvedValue([
    {
      name: "/stop",
      description: "Stop",
      group: "command",
      featured: false,
      handling: "client:interrupt",
      requiredScope: "operate",
    },
  ]);
  await using screen = await render(
    flow.view("deep", { ...capabilities, commands: { supported: true } }),
  );
  await screen.getByRole("button", { name: "Start voice input" }).click();
  await act(() => finishDictation("/stop", 5));
  const draft = screen.getByRole("combobox");
  await expect.element(draft).toHaveValue("/stop");
  const activeId = draft.element().getAttribute("aria-activedescendant");
  expect(document.getElementById(activeId ?? "")?.textContent).toContain("/stop");
  expect(flow.send).not.toHaveBeenCalled();
  expect(interrupt).not.toHaveBeenCalled();
});

it("sends the finished transcript when Send is pressed mid-recording", async () => {
  using spies = new DisposableStack();
  const flow = setup(spies);
  enableVoice(spies);
  await using screen = await render(flow.view("deep"));
  await screen.getByRole("button", { name: "Start voice input" }).click();
  await screen.getByRole("button", { name: "Send" }).click();
  expect(voice.queued).not.toBeNull();
  expect(flow.send).not.toHaveBeenCalled();

  await act(() => {
    finishDictation("plan the release", 16);
    voice.queued?.("plan the release");
  });
  expect(flow.send).toHaveBeenCalledWith(
    bot.botId,
    "deep",
    "plan the release",
    expect.any(String),
    true,
    [],
  );
  await expect.element(screen.getByRole("textbox")).toHaveValue("");
});
