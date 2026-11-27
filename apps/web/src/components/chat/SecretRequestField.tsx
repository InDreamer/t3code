import { useGT } from "gt-react";
import { EyeIcon, EyeOffIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "../ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../ui/input-group";

/** What a field shows: `key` names its value, `secret` masks it with a toggle to show it. */
export interface SecretRequestFieldInput {
  readonly key: string;
  readonly label: string;
  readonly placeholder: string;
  readonly secret: boolean;
}

/** One masked credential input that password managers leave alone; shared by every secret card. */
export function SecretRequestField(props: {
  readonly id: string;
  readonly input: SecretRequestFieldInput;
  readonly label: string | undefined;
  readonly value: string;
  readonly maxLength?: number;
  readonly disabled: boolean;
  readonly invalid: boolean;
  readonly describedBy: string;
  readonly onChange: (value: string) => void;
}) {
  const { input } = props;
  const gt = useGT();
  const [revealed, setRevealed] = useState(false);
  const masked = input.secret && !revealed;
  const control = (
    <InputGroup>
      <InputGroupInput
        id={props.id}
        maxLength={props.maxLength}
        // A CSS-masked text field still exposes its value to screen readers.
        type={masked ? "password" : "text"}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        data-1p-ignore
        data-lpignore="true"
        data-bwignore
        placeholder={input.placeholder}
        value={props.value}
        disabled={props.disabled}
        aria-invalid={props.invalid || undefined}
        aria-describedby={props.describedBy}
        onChange={(event) => props.onChange(event.currentTarget.value)}
      />
      {input.secret ? (
        <InputGroupAddon align="inline-end">
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            aria-label={gt("Show {label}", { label: input.label })}
            aria-pressed={revealed}
            disabled={props.disabled}
            // Keep focus, and the caret, in the input.
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => setRevealed((current) => !current)}
          >
            {revealed ? <EyeOffIcon aria-hidden /> : <EyeIcon aria-hidden />}
          </Button>
        </InputGroupAddon>
      ) : null}
    </InputGroup>
  );
  if (props.label === undefined) return control;
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label htmlFor={props.id} className="text-xs font-medium text-muted-foreground">
        {props.label}
      </label>
      {control}
    </div>
  );
}
