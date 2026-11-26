type ModelDraft = { readonly provider: string; readonly model: string };

export function modelConfirmationForDraft(
  current: ModelDraft,
  submitted: ModelDraft,
  confirmation: ModelDraft & { readonly message: string },
) {
  return current.provider === submitted.provider && current.model === submitted.model
    ? confirmation
    : null;
}
