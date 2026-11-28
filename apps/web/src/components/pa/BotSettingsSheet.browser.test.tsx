import { Atom } from "effect/reactivity";
import { EnvironmentId, type PaBotSummary, type PaSchedule } from "@t3tools/contracts";
import { GTProvider } from "gt-react";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import "~/index.css";

import { act, render } from "../../../test/render";
import { BotSettingsSheet } from "./BotSettingsSheet";
import { usePaBotsStore, applyPaBotWrite, loadPaBots } from "./paBotsStore";
import { paApi } from "./paApi";

vi.mock(import("./paApi"), async (original) => {
  const allowed = Atom.make(true);
  return {
    ...(await original()),
    paUpdateMetaPermissionAtom: () => allowed,
    paMutateSchedulePermissionAtom: () => allowed,
  };
});

vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  usePrimaryEnvironmentId: () => EnvironmentId.make("settings-test"),
}));

const bot: PaBotSummary = {
  botId: "engine:main",
  instanceId: "engine",
  driver: "hermes",
  engineLabel: "Engine",
  agentRef: "main",
  name: "Main",
  description: "",
  avatarColor: "#64748B",
  avatarShape: "blob",
  pinned: false,
  isDefault: true,
  model: null,
  provider: null,
  online: false,
  running: false,
  unread: false,
  lastMessagePreview: null,
  lastActivityAt: null,
  primarySessionId: null,
};

function sheet(onOpenChange: (open: boolean) => void, selected: PaBotSummary = bot) {
  return (
    <GTProvider locale="en" translations={{}}>
      <BotSettingsSheet
        open
        bot={selected}
        capabilities={{
          sessions: { create: false, rename: false },
          execution: { interrupt: false, clarify: false, approvals: false },
          config: { supported: false },
          models: { supported: false, scope: "none", allowCustom: false },
          schedules: { supported: true },
          commands: { supported: false },
          lifecycle: { create: false, delete: false },
        }}
        onSaved={() => {}}
        onOpenChange={onOpenChange}
      />
    </GTProvider>
  );
}

it("keeps an offline Bot's legacy swatch and closes only after a successful retry", async () => {
  using spies = new DisposableStack();
  spies.use(vi.spyOn(paApi, "listSchedules")).mockResolvedValue([]);
  const save = spies
    .use(vi.spyOn(paApi, "updateBotMeta"))
    .mockRejectedValueOnce(new Error("Unavailable"))
    .mockResolvedValue(undefined);
  const close = vi.fn();
  await using _screen = await render(sheet(close));
  const swatch = page.getByRole("button", { name: "Current color" });
  await expect.element(swatch).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Teal" }).click();
  await swatch.click();
  await page.getByRole("textbox", { name: "Name", exact: true }).fill("Renamed");
  const submit = page.getByRole("button", { name: "Save & Close" });
  await submit.click();
  await expect.element(page.getByText("Unavailable")).toBeVisible();
  expect(close).not.toHaveBeenCalled();
  await submit.click();
  await expect.poll(() => close.mock.calls).toEqual([[false]]);
  expect(save).toHaveBeenCalledTimes(2);
});

it("keeps the create form first and corrects the page after a deletion or addition", async () => {
  using spies = new DisposableStack();
  const jobs: PaSchedule[] = Array.from({ length: 6 }, (_, i) => ({
    id: String(i),
    name: "Job " + i,
    prompt: "",
    schedule: "every 1h",
    enabled: true,
  }));
  spies.use(vi.spyOn(paApi, "listSchedules")).mockResolvedValue(jobs);
  spies
    .use(vi.spyOn(paApi, "mutateSchedule"))
    .mockResolvedValueOnce(jobs.slice(0, 5))
    .mockResolvedValueOnce([{ ...jobs[0]!, id: "new", name: "New job" }, ...jobs.slice(0, 5)]);
  const close = vi.fn();
  await using _screen = await render(sheet(close));
  await page.getByRole("button", { name: "Schedule", exact: true }).click();
  const create = page.getByRole("button", { name: "Add scheduled task" });
  await expect.element(page.getByText("Job 0", { exact: true })).toBeVisible();
  expect(
    create.element().compareDocumentPosition(page.getByText("Job 0", { exact: true }).element()) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  await page.getByRole("button", { name: "Next page" }).click();
  await expect.element(page.getByText("2 of 2")).toBeVisible();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await expect.element(page.getByText("Job 0", { exact: true })).toBeVisible();
  await page.getByPlaceholder("Instructions for the bot when the task runs…").fill("Brief me");
  await create.click();
  await expect.element(page.getByText("New job", { exact: true })).toBeVisible();
  await expect.element(page.getByText("1 of 2")).toBeVisible();
  expect(close).not.toHaveBeenCalled();
});

it("keeps the settings draft through an offline read and ignores pre-write poll successes and failures", async () => {
  using spies = new DisposableStack();
  spies.use(vi.spyOn(paApi, "listSchedules")).mockResolvedValue([]);
  const list = spies.use(vi.spyOn(paApi, "listBots"));
  type Roster = Awaited<ReturnType<typeof paApi.listBots>>;
  const beforeCreate = Promise.withResolvers<Roster>();
  const beforeSave = Promise.withResolvers<Roster>();
  const afterSave = Promise.withResolvers<Roster>();
  list
    .mockReturnValueOnce(beforeCreate.promise)
    .mockReturnValueOnce(beforeSave.promise)
    .mockReturnValueOnce(afterSave.promise);
  const close = vi.fn();
  function Settings() {
    const { bots, error } = usePaBotsStore(false);
    const selected = bots.find((item) => item.botId === bot.botId);
    return (
      <>
        {error}
        <span>{selected?.name}</span>
        {selected && sheet(close, selected)}
      </>
    );
  }
  await using screen = await render(<Settings />);
  const stale = loadPaBots(true);
  let created!: Promise<void>;
  await act(() => {
    created = applyPaBotWrite(bot);
  });
  expect(list).toHaveBeenCalledTimes(2);
  const field = page.getByRole("textbox", { name: "Name", exact: true });
  await field.fill("Unsaved");
  let saved!: Promise<void>;
  await act(() => {
    saved = applyPaBotWrite(bot, { name: "Accepted" });
  });
  expect(list).toHaveBeenCalledTimes(3);
  await act(async () => {
    beforeCreate.resolve({ bots: [], instances: [] });
    beforeSave.reject(new Error("obsolete"));
    await Promise.all([created, stale]);
  });
  await expect.element(screen.getByText("Accepted", { exact: true })).toBeVisible();
  await expect.element(field).toHaveValue("Unsaved");
  expect(screen.container.textContent).not.toContain("obsolete");
  await act(async () => {
    afterSave.resolve({
      bots: [],
      instances: [
        {
          instanceId: bot.instanceId,
          driver: bot.driver,
          label: bot.engineLabel,
          version: null,
          online: false,
          botCount: 0,
          error: "offline",
          capabilities: {
            sessions: { create: false, rename: false },
            execution: { interrupt: false, clarify: false, approvals: false },
            config: { supported: false },
            models: { supported: false, scope: "none", allowCustom: false },
            commands: { supported: false },
            schedules: { supported: true },
            lifecycle: { create: false, delete: false },
          },
        },
      ],
    });
    await saved;
  });
  await expect.element(field).toHaveValue("Unsaved");
  list.mockResolvedValueOnce({ bots: [], instances: [] });
  await act(async () => {
    await loadPaBots(true);
  });
  await expect.element(field).not.toBeInTheDocument();
});
