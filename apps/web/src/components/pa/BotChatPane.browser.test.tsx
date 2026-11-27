import { GTProvider } from "gt-react";
import { page, userEvent } from "vite-plus/test/browser";
import * as sessionState from "../../state/session";
import { Atom } from "effect/reactivity";
import {
  EnvironmentId,
  PaError,
  type PaCapabilities,
  type PaStreamEvent,
  type PaSteerSessionResult,
} from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { act, render } from "../../../test/render";
import { BotChatPane } from "./BotChatPane";
import { attachmentEnvironment } from "../../state/attachments";
import { SecretRequestField } from "../chat/SecretRequestField";
import { paApi, paSendPermissionAtom } from "./paApi";
import { toastManager } from "../ui/toast";

vi.mock(import("./paApi"), async (original) => {
  const allowed = Atom.make(true);
  return { ...(await original()), paSendPermissionAtom: vi.fn(() => allowed) };
});
vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  usePrimaryEnvironmentId: () => EnvironmentId.make("pa-browser"),
}));

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
        fields: [{ id: "key", label: "API key", secret: true, required: true }],
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
