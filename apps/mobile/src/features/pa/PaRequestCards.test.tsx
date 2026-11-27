import { act, useLayoutEffect, useRef, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

import type { SecretTextInputProps } from "../../components/ui/SecretTextInput.types";
import { PaSecretRequestCard } from "./PaRequestCards";

vi.mock("react-native", () => ({ View: "div", Pressable: "button" }));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));
vi.mock("../../components/ui/Button", () => ({ Button: () => null }));
vi.mock("../../lib/copyTextWithHaptic", () => ({}));
vi.mock("../../components/ui/SecretTextInput", () => ({
  SecretTextInput(props: SecretTextInputProps) {
    const ref = useRef<HTMLInputElement>(null);
    useLayoutEffect(() => {
      props.onMount?.({ focus: () => ref.current?.focus() });
      return () => props.onMount?.(null);
    }, [props.onMount]);
    return (
      <input
        ref={ref}
        aria-label={props.accessibilityLabel}
        defaultValue={props.value}
        onInput={(event) => props.onChangeText(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") props.onSubmitEditing(event.currentTarget.value);
        }}
      />
    );
  },
}));

it("advances to the next secret and includes the native Done event's final character", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  using _root = {
    [Symbol.dispose]: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
  const answer = vi.fn(async () => true);
  act(() =>
    root.render(
      <PaSecretRequestCard
        request={{
          kind: "secret",
          requestId: "login",
          title: "Login",
          detail: "",
          fields: [
            { id: "user", label: "User", required: true },
            { id: "key", label: "Key", required: true },
          ],
        }}
        responding={false}
        onAnswer={answer}
      />,
    ),
  );
  const [user, key] = container.querySelectorAll("input");
  act(() => {
    user!.value = "sam";
    user!.dispatchEvent(new Event("input", { bubbles: true }));
    user!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
  expect(document.activeElement).toBe(key);
  expect(answer).not.toHaveBeenCalled();
  await act(async () => {
    key!.value = "complete";
    key!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
  expect(answer).toHaveBeenCalledWith({ type: "submit", values: { user: "sam", key: "complete" } });
});
