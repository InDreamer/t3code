import type { PaPendingRequest } from "@t3tools/contracts";
import { T, useGT } from "gt-react";
import { KeyRoundIcon, ShieldCheckIcon } from "lucide-react";
import { useId, useRef, useState, type FormEvent } from "react";

import { SecretRequestField } from "../chat/SecretRequestField";
import { MessageCopyButton } from "../chat/MessageCopyButton";
import { Button } from "../ui/button";

export type PaSecretAnswer =
  | { readonly type: "submit"; readonly values: Readonly<Record<string, string>> }
  | { readonly type: "skip" };

/**
 * A credential prompt (sudo, an API key, a vault unlock, code or login). The typed values live
 * only in this form: they are cleared before the answer is sent and come back only if it fails.
 */
export function PaSecretRequestForm({
  req,
  responding,
  onAnswer,
}: {
  readonly req: PaPendingRequest;
  readonly responding: boolean;
  /** Resolves `true` once the engine took the answer. */
  readonly onAnswer: (answer: PaSecretAnswer) => Promise<boolean>;
}) {
  const gt = useGT();
  const formId = useId();
  const noticeId = useId();
  const [values, setValues] = useState<Readonly<Record<string, string>>>({});
  const [submitting, setSubmitting] = useState(false);
  // Enter and a click can both submit before a render.
  const inFlight = useRef(false);
  const fields = req.fields ?? [];
  const busy = responding || submitting;
  const canSubmit =
    fields.length > 0 &&
    fields.every((field) => field.required !== true || (values[field.id] ?? "").length > 0);

  const send = async (answer: PaSecretAnswer) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setSubmitting(true);
    // A password field that leaves the page with text in it can prompt to save a login.
    const typed = values;
    setValues({});
    const accepted = await onAnswer(answer).finally(() => {
      inFlight.current = false;
      setSubmitting(false);
    });
    if (!accepted && answer.type === "submit") setValues(typed);
  };

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSubmit || busy) return;
    void send({ type: "submit", values });
  };

  const inputId = (index: number) => `${formId}-${index}`;
  const single = fields.length === 1;

  return (
    <form
      className="mb-2 space-y-2.5 rounded-2xl border border-border/80 bg-card/95 p-3.5 shadow-sm backdrop-blur-md"
      onSubmit={onSubmit}
      autoComplete="off"
    >
      <div className="flex items-center gap-2 text-sm font-medium text-foreground">
        <KeyRoundIcon className="size-4 shrink-0 text-warning" />
        {single ? (
          <label htmlFor={inputId(0)} className="min-w-0 break-words">
            {req.title || gt("The bot needs a credential")}
          </label>
        ) : (
          <span className="min-w-0 break-words">
            {req.title || gt("The bot needs a credential")}
          </span>
        )}
      </div>

      {req.detail ? (
        <p className="whitespace-pre-wrap break-words text-xs leading-relaxed text-muted-foreground">
          {req.detail}
        </p>
      ) : null}

      {req.command ? (
        <div className="relative rounded-lg border border-border/60 bg-muted/40 px-3 py-2">
          <div className="flex items-start justify-between gap-2">
            <pre className="max-h-36 flex-1 overflow-auto whitespace-pre-wrap break-words font-mono text-xs leading-5 text-foreground select-text">
              {req.command}
            </pre>
            <MessageCopyButton text={req.command} label={gt("Copy command")} variant="ghost" />
          </div>
        </div>
      ) : null}

      <div className="flex min-w-0 flex-col gap-2">
        {fields.map((field, index) => (
          <SecretRequestField
            maxLength={16000}
            key={field.id}
            id={inputId(index)}
            input={{
              key: field.id,
              label: field.label,
              placeholder: field.placeholder ?? "",
              secret: field.secret === true,
            }}
            // A single input is labelled by the card title.
            label={single ? undefined : field.label}
            value={values[field.id] ?? ""}
            disabled={busy}
            invalid={false}
            describedBy={noticeId}
            onChange={(value) => setValues((current) => ({ ...current, [field.id]: value }))}
          />
        ))}
      </div>

      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <p
          id={noticeId}
          className="flex min-w-0 grow basis-52 items-center gap-1.5 text-xs text-muted-foreground"
        >
          <ShieldCheckIcon className="size-3.5 shrink-0" aria-hidden />
          <span className="min-w-0 break-words">
            {req.sideEffectNotice ??
              gt("Only this bot receives your answer. It stays out of the conversation.")}
          </span>
        </p>
        <div className="ms-auto flex shrink-0 items-center gap-1.5">
          <Button
            type="button"
            size="xs"
            variant="ghost-muted"
            disabled={busy}
            onClick={() => void send({ type: "skip" })}
          >
            <T>Skip</T>
          </Button>
          <Button type="submit" size="xs" disabled={busy || !canSubmit}>
            <T>Submit</T>
          </Button>
        </div>
      </div>
    </form>
  );
}
