import { EnvironmentId, PaError } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { paApi } from "./paApi";

const mocks = vi.hoisted(() => ({
  environment: vi.fn<() => EnvironmentId>(),
  run: vi.fn<
    (
      _registry: unknown,
      _command: unknown,
      args: { environmentId: EnvironmentId; input: { requestId: string } },
    ) => Promise<unknown>
  >(),
}));
vi.mock("../../state/environments", () => ({ readPrimaryEnvironmentId: mocks.environment }));
vi.mock("@t3tools/client-runtime/state/runtime", async (original) => ({
  ...(await original<typeof import("@t3tools/client-runtime/state/runtime")>()),
  runAtomCommand: mocks.run,
}));

it("shares primary creates across mounts and retries a lost receipt only in its original environment", async () => {
  const first = EnvironmentId.make("one");
  const second = EnvironmentId.make("two");
  mocks.environment.mockReturnValue(first);
  const lost = Promise.withResolvers<unknown>();
  mocks.run
    .mockReturnValueOnce(lost.promise)
    .mockResolvedValue({ _tag: "Success", value: { sessionId: "s" } });
  const attempts = Promise.allSettled([
    paApi.ensurePrimarySession("bot"),
    paApi.ensurePrimarySession("bot"),
  ]);
  lost.reject(new PaError({ reason: "Unavailable", message: "lost receipt" }));
  expect((await attempts).map((outcome) => outcome.status)).toEqual(["rejected", "rejected"]);
  mocks.environment.mockReturnValue(second);
  await paApi.ensurePrimarySession("bot");
  mocks.environment.mockReturnValue(first);
  await paApi.ensurePrimarySession("bot");
  await paApi.ensurePrimarySession("bot");
  const calls = mocks.run.mock.calls.map((call) => call[2]);
  expect(calls.map(({ environmentId }) => environmentId)).toEqual([first, second, first, first]);
  expect(calls[2]?.input.requestId).toBe(calls[0]?.input.requestId);
  expect(new Set(calls.map(({ input }) => input.requestId)).size).toBe(3);
});
