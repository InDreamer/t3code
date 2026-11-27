import { EnvironmentId, type AssetResource, type PaAttachment } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "../../../test/render";
import { useAssetUrls, useAssetUrlRefresh } from "../../assets/assetUrls";
import { PaUserMessageRow } from "./PaTimelineRows";
import "~/index.css";

vi.mock(import("../../assets/assetUrls"), async (original) => ({
  ...(await original()),
  useAssetUrls: vi.fn(),
  useAssetUrlRefresh: vi.fn(),
}));

it("pages through claimed images, opens the PDF by its asset id, and leaves external media inert", async () => {
  const pixel = URL.createObjectURL(
    new Blob(['<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>'], {
      type: "image/svg+xml",
    }),
  );
  using _pixel = { [Symbol.dispose]: () => URL.revokeObjectURL(pixel) };
  const urls = vi
    .mocked(useAssetUrls)
    .mockImplementation((_env, resources) => resources.map(() => pixel));
  const refresh = vi.fn(async () => null);
  vi.mocked(useAssetUrlRefresh).mockReturnValue(refresh);
  const env = EnvironmentId.make("remote-pa");
  const image = (id: string): PaAttachment => ({
    id,
    type: "image",
    name: id + ".png",
    mimeType: "image/png",
    sizeBytes: 100,
  });
  const pdf: PaAttachment = {
    id: "paper",
    type: "file",
    name: "report.pdf",
    mimeType: "application/pdf",
    sizeBytes: 1_024,
  };
  const images = [image("first"), image("second")];
  await using screen = await render(
    <PaUserMessageRow
      environmentId={env}
      message={{
        id: "row-2",
        role: "user",
        rowKind: "message",
        timestamp: null,
        text: "",
        attachments: [...images, pdf, { ...image("external"), unavailable: true }],
      }}
    />,
  );
  expect(screen.container.querySelector("[data-user-message-bubble]")?.children).toHaveLength(1);
  const resources: AssetResource[] = images.map((item) => ({
    _tag: "attachment",
    attachmentId: item.id,
    fileName: item.name,
    mimeType: item.mimeType,
  }));
  expect(
    urls.mock.calls.every(
      ([environment, requested]) =>
        environment === env &&
        requested.every((item) => item._tag === "attachment" && item.attachmentId !== "external"),
    ),
  ).toBe(true);
  expect(urls).toHaveBeenCalledWith(env, resources);
  await expect.element(screen.getByRole("button", { name: /external\.png/ })).toBeDisabled();
  await userEvent.click(screen.getByRole("button", { name: /second\.png/ }));
  await expect.element(page.getByRole("region", { name: /second\.png/ })).toBeVisible();
  await userEvent.click(page.getByRole("button", { name: "Previous media" }));
  await expect.element(page.getByRole("region", { name: /first\.png/ })).toBeVisible();
  await userEvent.keyboard("{Escape}");
  await userEvent.click(screen.getByRole("button", { name: /report\.pdf/ }));
  await expect.element(page.getByRole("dialog", { name: pdf.name })).toBeVisible();
  expect(useAssetUrlRefresh).toHaveBeenCalledWith(env, {
    _tag: "attachment",
    attachmentId: pdf.id,
    fileName: pdf.name,
    mimeType: pdf.mimeType,
    disposition: "inline",
  });
});
