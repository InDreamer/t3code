import type { PaAvatarShape, PaBotSummary, PaInstanceStatus } from "@t3tools/contracts";
import { T, useGT, useMessages } from "gt-react";
import { Loader2Icon, PlusIcon } from "lucide-react";
import { useState } from "react";

import { cn } from "../../lib/utils";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { PaNativeSelect } from "./PaNativeSelect";
import { BotAvatar, PA_AVATAR_COLORS, PA_AVATAR_SHAPES } from "./BotAvatar";
import { paApi, paErrorMessage } from "./paApi";

export function CreateBotDialog({
  open,
  onOpenChange,
  instances,
  onCreated,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly instances: ReadonlyArray<PaInstanceStatus>;
  readonly onCreated: (bot: PaBotSummary) => void;
}) {
  const gt = useGT();
  const m = useMessages();
  const creatable = instances.filter((i) => i.capabilities.lifecycle.create);
  const [selectedInstanceId, setSelectedInstanceId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [agentRef, setAgentRef] = useState("");
  const [description, setDescription] = useState("");
  const [instructions, setInstructions] = useState("");
  const [avatarColor, setAvatarColor] = useState<string>(PA_AVATAR_COLORS[1].value);
  const [avatarShape, setAvatarShape] = useState<PaAvatarShape>("blob");
  const [pinned, setPinned] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const activeInstance =
    creatable.find((i) => i.instanceId === selectedInstanceId) ??
    creatable.find((i) => i.online) ??
    creatable[0] ??
    null;
  const canCreate = activeInstance !== null && activeInstance.online;

  const derivedSlug = (agentRef || name)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[^a-z0-9]+|-+$/g, "")
    .slice(0, 64);

  const resetForm = () => {
    setName("");
    setAgentRef("");
    setDescription("");
    setInstructions("");
    setAvatarColor(PA_AVATAR_COLORS[1].value);
    setAvatarShape("blob");
    setPinned(false);
    setError(null);
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!activeInstance || !activeInstance.online) {
      setError(gt("No online engine can create bots"));
      return;
    }
    if (!derivedSlug) {
      setError(gt("Start the ID with a letter or number (e.g. news-bot)"));
      return;
    }
    setSubmitting(true);
    setError(null);
    let bot: PaBotSummary;
    try {
      bot = await paApi.createBot({
        instanceId: activeInstance.instanceId,
        agentRef: derivedSlug,
        name: name.trim() || derivedSlug,
        description: description.trim(),
        ...(instructions.trim() ? { instructions: instructions.trim() } : {}),
        avatarColor,
        avatarShape,
        pinned,
      });
    } catch (err) {
      setError(paErrorMessage(err, gt("Could not create bot")));
      setSubmitting(false);
      return;
    }
    setSubmitting(false);
    resetForm();
    onOpenChange(false);
    onCreated(bot);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setError(null);
        onOpenChange(next);
      }}
    >
      <DialogPopup className="max-w-lg">
        <form onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col max-sm:pb-safe">
          <DialogHeader>
            <DialogTitle>
              <T>Create bot</T>
            </DialogTitle>
            <DialogDescription>
              <T>Each bot has its own memory, instructions and model.</T>
            </DialogDescription>
          </DialogHeader>

          <DialogPanel>
            <div className="flex items-center gap-4 rounded-xl border border-border/60 bg-muted/30 p-3">
              <BotAvatar color={avatarColor} shape={avatarShape} size="md" starred={pinned} />
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium text-sm">
                  {name.trim() || derivedSlug || gt("New bot")}
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-1.5">
                  {instances.map((instance) => (
                    <Badge
                      key={instance.instanceId}
                      variant={instance.online ? "success" : "warning"}
                      size="sm"
                    >
                      {instance.online
                        ? gt("{label} online", { label: instance.label })
                        : gt("{label} offline", { label: instance.label })}
                    </Badge>
                  ))}
                </div>
              </div>
            </div>

            {creatable.length > 1 ? (
              <div className="space-y-1.5">
                <Label htmlFor="pa-create-instance">
                  <T>Engine</T>
                </Label>
                <PaNativeSelect
                  id="pa-create-instance"
                  value={activeInstance?.instanceId ?? ""}
                  onChange={(e) => setSelectedInstanceId(e.target.value)}
                >
                  {creatable.map((instance) => (
                    <option
                      key={instance.instanceId}
                      value={instance.instanceId}
                      disabled={!instance.online}
                    >
                      {instance.label}
                    </option>
                  ))}
                </PaNativeSelect>
              </div>
            ) : null}

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="pa-create-name">
                  <T>Display name</T>
                </Label>
                <Input
                  id="pa-create-name"
                  placeholder={gt("e.g. Research assistant")}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  autoFocus
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="pa-create-agent-ref">
                  <T>ID (letters and numbers)</T>
                </Label>
                <Input
                  id="pa-create-agent-ref"
                  placeholder={gt("e.g. research-bot")}
                  value={agentRef}
                  onChange={(e) => setAgentRef(e.target.value)}
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="pa-create-desc">
                <T>Short description (optional)</T>
              </Label>
              <Input
                id="pa-create-desc"
                placeholder={gt("e.g. Summarizes AI news daily")}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </div>

            <div className="space-y-2">
              <Label>
                <T>Avatar shape and color</T>
              </Label>
              <div className="flex flex-wrap gap-2">
                {PA_AVATAR_SHAPES.map((item) => (
                  <button
                    key={item.value}
                    type="button"
                    onClick={() => setAvatarShape(item.value)}
                    className={cn(
                      "flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs transition-colors",
                      avatarShape === item.value
                        ? "border-primary bg-primary/10 text-foreground"
                        : "border-border/60 bg-background text-muted-foreground hover:bg-muted/50",
                    )}
                  >
                    <BotAvatar
                      color={avatarColor}
                      shape={item.value}
                      size="sm"
                      className="size-5"
                    />
                    <span>{m(item.label)}</span>
                  </button>
                ))}
              </div>
              <div className="flex flex-wrap items-center gap-2 pt-1">
                {PA_AVATAR_COLORS.map((swatch) => (
                  <button
                    key={swatch.value}
                    type="button"
                    aria-label={m(swatch.label)}
                    onClick={() => setAvatarColor(swatch.value)}
                    className={cn(
                      "size-6 rounded-full transition-transform pointer-coarse:size-8",
                      avatarColor === swatch.value &&
                        "scale-110 ring-2 ring-foreground ring-offset-2 ring-offset-background",
                    )}
                    style={{ backgroundColor: swatch.value }}
                  />
                ))}
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="pa-create-instructions">
                <T>Instructions (optional)</T>
              </Label>
              <Textarea
                id="pa-create-instructions"
                rows={4}
                placeholder={gt("Describe the bot’s role, style and instructions…")}
                value={instructions}
                onChange={(e) => setInstructions(e.target.value)}
              />
            </div>

            <div className="flex items-center justify-between rounded-lg border border-border/60 px-3 py-2.5">
              <div>
                <div className="font-medium text-sm">
                  <T>Pin to the top of Bots</T>
                </div>
                <div className="text-muted-foreground text-xs">
                  <T>Show a large avatar in the shortcuts section</T>
                </div>
              </div>
              <Switch checked={pinned} onCheckedChange={setPinned} />
            </div>

            {error ? (
              <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-destructive text-xs">
                {error}
              </div>
            ) : null}
          </DialogPanel>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              <T>Cancel</T>
            </Button>
            <Button type="submit" disabled={submitting || !canCreate}>
              {submitting ? (
                <Loader2Icon className="mr-1.5 size-4 animate-spin" />
              ) : (
                <PlusIcon className="mr-1.5 size-4" />
              )}
              <T>Create and open chat</T>
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
