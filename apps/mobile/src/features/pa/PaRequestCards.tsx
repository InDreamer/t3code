import type { PaClarifyAnswer, PaPendingRequest } from "@t3tools/contracts";
import { T, useGT } from "gt-react-native";
import { useRef, useState } from "react";
import { Pressable, View } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text, AppTextInput as TextInput } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import type { SecretTextInputHandle } from "../../components/ui/SecretTextInput.types";
import { SecretTextInput } from "../../components/ui/SecretTextInput";
import { useMountedRef } from "../../lib/useMountedRef";
import { cn } from "../../lib/cn";
import { copyTextWithHaptic } from "../../lib/copyTextWithHaptic";
import type { PaClarifyAnswers, PaSecretAnswer } from "./paBotChat";

function RequestCommand(props: { readonly command: string }) {
  const gt = useGT();
  return (
    <View className="flex-row items-start gap-2 rounded-lg border border-border-subtle bg-subtle px-3 py-2">
      <Text
        selectable
        className="min-w-0 flex-1 font-mono text-xs text-foreground"
        numberOfLines={8}
      >
        {props.command}
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={gt("Copy command")}
        hitSlop={8}
        onPress={() => copyTextWithHaptic(props.command)}
      >
        <SymbolView name="doc.on.doc" size={13} tintColorClassName="accent-icon-subtle" />
      </Pressable>
    </View>
  );
}

function CardTitle(props: {
  readonly icon: "terminal" | "questionmark.bubble" | "exclamationmark.shield";
  readonly title: string;
}) {
  return (
    <View className="flex-row items-center gap-2">
      <SymbolView
        name={props.icon}
        size={15}
        tintColorClassName={
          props.icon === "questionmark.bubble" ? "accent-primary" : "accent-warning"
        }
      />
      <Text className="min-w-0 flex-1 text-sm font-t3-medium text-foreground">{props.title}</Text>
    </View>
  );
}

/** An approval or a clarifying question the running turn waits on. */
export function PaPendingRequestCard(props: {
  readonly request: PaPendingRequest;
  readonly responding: boolean;
  readonly answers: PaClarifyAnswers;
  readonly onAnswerChange: (questionId: string, value: PaClarifyAnswer) => void;
  readonly onRespond: (decision?: string) => void;
}) {
  const gt = useGT();
  const { request } = props;
  return (
    <View className="gap-2.5 rounded-2xl border border-border bg-card p-3.5">
      <CardTitle
        icon={request.kind === "approval" ? "terminal" : "questionmark.bubble"}
        title={
          request.title ||
          (request.kind === "approval"
            ? gt("Approval required")
            : gt("The bot needs more information"))
        }
      />
      {request.detail ? (
        <Text selectable className="text-xs text-foreground-muted">
          {request.detail}
        </Text>
      ) : null}
      {request.command ? <RequestCommand command={request.command} /> : null}
      {request.kind === "approval" ? (
        <View className="flex-row flex-wrap gap-2">
          {(request.options ?? []).map((option, index) => (
            <Button
              key={option.id}
              size="compact"
              label={option.label}
              tone={option.intent === "deny" ? "secondary" : index === 0 ? "primary" : "secondary"}
              disabled={props.responding}
              onPress={() => props.onRespond(option.id)}
            />
          ))}
        </View>
      ) : request.questions?.length ? (
        <View className="gap-3">
          {request.questions.map((question) => {
            const answer = props.answers[question.id];
            const text = typeof answer === "string" ? answer : "";
            const selected = Array.isArray(answer) ? answer : [];
            const picked = (option: string) =>
              question.multiSelect ? selected.includes(option) : text === option;
            const pick = (option: string): PaClarifyAnswer =>
              question.multiSelect
                ? selected.includes(option)
                  ? selected.filter((item) => item !== option)
                  : [...selected, option]
                : option;
            return (
              <View key={question.id} className="gap-1.5">
                <Text className="text-xs font-t3-medium text-foreground">{question.prompt}</Text>
                {question.options?.map((option, index) => (
                  <Pressable
                    key={option}
                    accessibilityRole={question.multiSelect ? "checkbox" : "radio"}
                    accessibilityState={{ checked: picked(option), disabled: props.responding }}
                    disabled={props.responding}
                    onPress={() => props.onAnswerChange(question.id, pick(option))}
                    className={cn(
                      "flex-row items-center gap-2 rounded-xl border px-3 py-2.5 active:opacity-70",
                      picked(option) ? "border-primary bg-subtle" : "border-border-subtle",
                    )}
                  >
                    {question.multiSelect ? (
                      <SymbolView
                        name={picked(option) ? "checkmark.circle.fill" : "circle"}
                        size={16}
                        tintColorClassName={
                          picked(option) ? "accent-primary" : "accent-icon-subtle"
                        }
                      />
                    ) : (
                      <Text
                        className={cn(
                          "w-5 text-center font-mono text-2xs",
                          picked(option) ? "text-primary-text" : "text-foreground-tertiary",
                        )}
                      >
                        {index + 1}
                      </Text>
                    )}
                    <Text className="min-w-0 flex-1 text-sm text-foreground">{option}</Text>
                  </Pressable>
                ))}
                {question.multiSelect ? null : (
                  <TextInput
                    accessibilityLabel={question.prompt}
                    placeholder={gt("Enter your reply…")}
                    placeholderTextColorClassName="accent-foreground-muted"
                    editable={!props.responding}
                    value={text}
                    onChangeText={(value) => props.onAnswerChange(question.id, value)}
                    className="rounded-xl border border-input-border bg-input px-3 py-2 text-sm text-foreground"
                  />
                )}
              </View>
            );
          })}
          <View className="items-end">
            <Button
              size="compact"
              label={gt("Submit answer")}
              disabled={props.responding}
              onPress={() => props.onRespond()}
            />
          </View>
        </View>
      ) : null}
    </View>
  );
}

/**
 * A credential prompt. The typed values live only in this form: they are cleared before the
 * answer is sent and come back only if it fails. Nothing here logs or echoes them.
 */
export function PaSecretRequestCard(props: {
  readonly request: PaPendingRequest;
  readonly responding: boolean;
  /** Resolves true once the engine took the answer. */
  readonly onAnswer: (answer: PaSecretAnswer) => Promise<boolean>;
}) {
  const gt = useGT();
  const [values, setValues] = useState<Readonly<Record<string, string>>>({});
  const [submitting, setSubmitting] = useState(false);
  const mounted = useMountedRef();
  const inFlight = useRef(false);
  const fields = props.request.fields ?? [];
  const busy = props.responding || submitting;
  const inputRefs = useRef<Array<SecretTextInputHandle | null>>([]);
  const canSubmit = (answers: Readonly<Record<string, string>>) =>
    fields.length > 0 &&
    fields.every((field) => field.required !== true || (answers[field.id] ?? "").length > 0);
  const send = async (answer: PaSecretAnswer) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setSubmitting(true);
    setValues({});
    const accepted = await props.onAnswer(answer).finally(() => {
      inFlight.current = false;
      if (mounted.current) setSubmitting(false);
    });
    if (mounted.current && !accepted && answer.type === "submit") setValues(answer.values);
  };
  const submit = (answers: Readonly<Record<string, string>>) => {
    if (canSubmit(answers) && !busy) void send({ type: "submit", values: answers });
  };
  return (
    <View className="gap-2.5 rounded-2xl border border-border bg-card p-3.5">
      <CardTitle
        icon="exclamationmark.shield"
        title={props.request.title || gt("The bot needs a credential")}
      />
      {props.request.detail ? (
        <Text selectable className="text-xs text-foreground-muted">
          {props.request.detail}
        </Text>
      ) : null}
      {props.request.command ? <RequestCommand command={props.request.command} /> : null}
      {fields.map((field, index) => (
        <View key={field.id} className="gap-1">
          {fields.length > 1 ? (
            <Text className="text-xs font-t3-medium text-foreground-muted">{field.label}</Text>
          ) : null}
          <SecretTextInput
            accessibilityLabel={field.label}
            placeholder={field.placeholder ?? field.label}
            value={values[field.id] ?? ""}
            secret={field.secret !== false}
            maxLength={16000}
            editable={!busy}
            returnKeyType={index < fields.length - 1 ? "next" : "done"}
            onChangeText={(value) => setValues((current) => ({ ...current, [field.id]: value }))}
            onMount={(handle) => {
              inputRefs.current[index] = handle;
            }}
            onSubmitEditing={(value) => {
              if (index === fields.length - 1) submit({ ...values, [field.id]: value });
              else inputRefs.current[index + 1]?.focus();
            }}
          />
        </View>
      ))}
      <View className="flex-row items-center gap-1.5">
        <SymbolView name="checkmark.circle" size={13} tintColorClassName="accent-icon-subtle" />
        <Text className="min-w-0 flex-1 text-xs text-foreground-muted">
          {props.request.sideEffectNotice ??
            gt("Only this bot receives your answer. It stays out of the conversation.")}
        </Text>
      </View>
      <View className="flex-row justify-end gap-2">
        <Button
          size="compact"
          tone="text"
          label={gt("Skip")}
          disabled={busy}
          onPress={() => void send({ type: "skip" })}
        />
        <Button
          size="compact"
          label={gt("Submit")}
          disabled={busy || !canSubmit(values)}
          onPress={() => submit(values)}
        />
      </View>
    </View>
  );
}

export function PaSecretRequestDenied() {
  return (
    <View className="rounded-2xl border border-border bg-card p-3.5">
      <Text className="text-sm text-foreground-muted">
        <T>
          You need permission to operate this chat and manage providers to answer this credential
          request.
        </T>
      </Text>
    </View>
  );
}
