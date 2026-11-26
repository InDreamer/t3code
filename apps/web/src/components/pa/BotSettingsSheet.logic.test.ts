import { expect, it } from "vite-plus/test";
import { modelConfirmationForDraft } from "./BotSettingsSheet.logic";

it("shows a confirmation for the submitted fields even when the engine pick was normalized", () => {
  const submitted = { provider: "", model: " A " };
  const confirmation = { provider: "default", model: "A", message: "confirm A" };
  expect(modelConfirmationForDraft(submitted, submitted, confirmation)).toEqual(confirmation);
  expect(
    modelConfirmationForDraft({ ...submitted, model: "B" }, submitted, confirmation),
  ).toBeNull();
  expect(
    modelConfirmationForDraft({ ...submitted, provider: "other" }, submitted, confirmation),
  ).toBeNull();
});
