import { T, useGT } from "gt-react";
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  Loader2Icon,
  RefreshCwIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { useStableCallback } from "~/hooks/useStableCallback";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import type { PaBotSummary, PaModelCatalog, PaModelProvider } from "@t3tools/contracts";
import { paApi, paErrorMessage } from "./paApi";

const SEARCH_THRESHOLD = 8;

interface PendingConfirm {
  readonly provider: string;
  readonly model: string;
  readonly message: string;
}

function filterProvider(option: PaModelProvider, needle: string): PaModelProvider {
  if (!needle) return option;
  return {
    ...option,
    models: option.models.filter(
      (model) =>
        model.id.toLowerCase().includes(needle) ||
        option.label.toLowerCase().includes(needle) ||
        option.id.toLowerCase().includes(needle),
    ),
  };
}

function PaModelPickerContent({
  bot,
  sessionId,
  cached,
  query,
  onQueryChange,
  onLoaded,
  onApplied,
}: {
  readonly bot: PaBotSummary;
  readonly sessionId: string | null;
  readonly cached: PaModelCatalog | null;
  readonly query: string;
  readonly onQueryChange: (value: string) => void;
  readonly onLoaded: (catalog: PaModelCatalog) => void;
  readonly onApplied: (model: string) => void;
}) {
  const gt = useGT();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<PendingConfirm | null>(null);
  const [showSecondary, setShowSecondary] = useState(false);

  const requestRef = useRef(0);
  const load = useStableCallback(() => {
    const request = ++requestRef.current;
    paApi
      .getBotModels(bot.botId, sessionId ?? undefined)
      .then((catalog) => {
        if (requestRef.current !== request) return;
        onLoaded(catalog);
        setError(null);
      })
      .catch((err) => {
        if (requestRef.current === request) setError(paErrorMessage(err, gt("加载模型列表失败")));
      })
      .finally(() => {
        if (requestRef.current === request) setLoading(false);
      });
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the agent's live provider/model catalog each time the picker opens
  useEffect(() => {
    load();
    return () => {
      requestRef.current += 1;
    };
  }, [load]);

  const catalog = cached;
  const currentProvider = catalog?.current?.provider ?? null;
  const currentModel = catalog?.current?.model ?? bot.model;
  const needle = query.trim().toLowerCase();

  const allOptions = (catalog?.providers ?? []).filter((option) => option.models.length > 0);
  const rawPrimary = allOptions.filter((option) => option.tier === "primary");
  const rawSecondary = allOptions.filter((option) => option.tier === "detected");
  const primaryModelCount = rawPrimary.reduce((sum, option) => sum + option.models.length, 0);
  const secondaryModelCount = rawSecondary.reduce((sum, option) => sum + option.models.length, 0);
  const secondaryNames = rawSecondary.map((option) => option.label).join(" / ");

  const searchGroups = needle
    ? allOptions
        .map((option) => filterProvider(option, needle))
        .filter((option) => option.models.length > 0)
    : [];
  const hasVisibleGroups = needle ? searchGroups.length > 0 : rawPrimary.length > 0;
  const showSearch = primaryModelCount > SEARCH_THRESHOLD || showSecondary || Boolean(needle);

  const choose = async (provider: string, model: string, confirm = false) => {
    if (savingKey) return;
    setSavingKey(`${provider}/${model}`);
    setError(null);
    try {
      const result = await paApi.selectBotModel({
        botId: bot.botId,
        ...(catalog?.scope === "session" && sessionId ? { sessionId } : {}),
        provider,
        model,
        ...(confirm ? { confirm: true } : {}),
      });
      if (result.status === "confirmRequired") {
        setConfirm({ provider, model, message: result.message });
        return;
      }
      setConfirm(null);
      if (catalog) onLoaded({ ...catalog, current: result.current });
      onApplied(model);
    } catch (err) {
      setError(paErrorMessage(err, gt("切换模型失败")));
    } finally {
      setSavingKey(null);
    }
  };

  const renderGroup = (option: PaModelProvider) => (
    <div key={option.id} className="pb-1.5">
      <div className="flex items-center justify-between gap-2 px-2 py-1 text-2xs font-medium text-muted-foreground">
        <span className="min-w-0 truncate">{option.label}</span>
        {option.badge === "current" ? (
          <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-2xs text-foreground/80">
            <T>当前</T>
          </span>
        ) : option.badge === "custom" ? (
          <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-2xs text-muted-foreground">
            <T>自定义</T>
          </span>
        ) : option.badge === "detected" ? (
          <span className="shrink-0 text-2xs text-muted-foreground/75">
            <T>自动检测</T>
          </span>
        ) : null}
      </div>
      {option.models.map(({ id: model }) => {
        const key = `${option.id}/${model}`;
        const selected =
          model === currentModel && (currentProvider === null || option.id === currentProvider);
        return (
          <button
            key={key}
            type="button"
            disabled={savingKey !== null}
            aria-pressed={selected}
            onClick={() => void choose(option.id, model)}
            className={cn(
              "flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors disabled:opacity-64",
              selected ? "bg-accent text-accent-foreground" : "hover:bg-muted/60",
            )}
          >
            <span className="min-w-0 flex-1 truncate font-mono">{model}</span>
            {savingKey === key ? (
              <Loader2Icon className="size-3.5 shrink-0 animate-spin" />
            ) : selected ? (
              <CheckIcon className="size-3.5 shrink-0" />
            ) : null}
          </button>
        );
      })}
    </div>
  );

  return (
    <div className="flex max-h-[min(24rem,60dvh)] min-w-0 flex-col gap-2">
      <div className="flex items-center justify-between gap-2 px-1">
        <span className="text-xs font-medium text-muted-foreground">
          <T>切换模型</T>
        </span>
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          aria-label={gt("刷新模型列表")}
          disabled={loading}
          onClick={() => {
            setLoading(true);
            load();
          }}
        >
          <RefreshCwIcon className={cn("size-3.5", loading && "animate-spin")} />
        </Button>
      </div>

      {showSearch ? (
        <Input
          size="sm"
          type="search"
          placeholder={gt("搜索模型或提供方")}
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
        />
      ) : null}

      {confirm ? (
        <div className="space-y-2 rounded-lg border border-warning/40 bg-warning/8 p-2.5 text-xs">
          <p className="whitespace-pre-wrap break-words text-foreground">{confirm.message}</p>
          <div className="flex justify-end gap-1.5">
            <Button type="button" size="xs" variant="outline" onClick={() => setConfirm(null)}>
              <T>取消</T>
            </Button>
            <Button
              type="button"
              size="xs"
              disabled={savingKey !== null}
              onClick={() => void choose(confirm.provider, confirm.model, true)}
            >
              <T>确认切换</T>
            </Button>
          </div>
        </div>
      ) : null}

      {error ? (
        <div className="rounded-lg border border-destructive/30 bg-destructive/8 px-2.5 py-2 text-xs break-words text-destructive">
          {error}
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {!catalog && loading ? (
          <div className="flex items-center justify-center gap-2 py-6 text-xs text-muted-foreground">
            <Loader2Icon className="size-3.5 animate-spin" />
            <T>正在加载模型...</T>
          </div>
        ) : null}
        {catalog && !hasVisibleGroups ? (
          <div className="py-6 text-center text-xs text-muted-foreground">
            {needle ? <T>没有匹配的模型</T> : <T>没有可选的模型</T>}
          </div>
        ) : null}
        {needle ? (
          searchGroups.map(renderGroup)
        ) : (
          <>
            {rawPrimary.map(renderGroup)}
            {rawSecondary.length > 0 ? (
              <div className="mt-1 border-t border-border/50 pt-1.5">
                <button
                  type="button"
                  aria-expanded={showSecondary}
                  onClick={() => setShowSecondary((prev) => !prev)}
                  className="flex w-full min-w-0 items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-2xs font-medium text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
                >
                  {showSecondary ? (
                    <ChevronDownIcon className="size-3 shrink-0" />
                  ) : (
                    <ChevronRightIcon className="size-3 shrink-0" />
                  )}
                  <span className="min-w-0 flex-1 truncate">
                    {gt("其他检测到的提供方（{names} · {count}）", {
                      names: secondaryNames,
                      count: secondaryModelCount,
                    })}
                  </span>
                </button>
                {showSecondary ? <div className="pt-1">{rawSecondary.map(renderGroup)}</div> : null}
              </div>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

export function PaModelPicker({
  bot,
  sessionId,
  open,
  onOpenChange,
  query,
  onQueryChange,
  onModelChanged,
}: {
  readonly bot: PaBotSummary;
  readonly sessionId: string | null;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly query: string;
  readonly onQueryChange: (value: string) => void;
  readonly onModelChanged: () => void;
}) {
  const gt = useGT();
  const [cached, setCached] = useState<{
    readonly botId: string;
    readonly catalog: PaModelCatalog;
  }>();
  // Shown until the Bot list refresh carries the new model back in `bot.model`.
  const [applied, setApplied] = useState<{
    readonly base: string | null;
    readonly model: string;
  } | null>(null);
  const label = applied && applied.base === bot.model ? applied.model : bot.model || bot.agentRef;

  return (
    <Popover open={open} onOpenChange={(next) => onOpenChange(next)}>
      <PopoverTrigger
        render={
          <Button
            type="button"
            size="xs"
            variant="ghost-muted"
            className="min-w-0 max-w-44 shrink sm:max-w-56"
            aria-label={gt("切换模型：{model}", { model: label })}
          >
            <span className="min-w-0 truncate">{label}</span>
            <ChevronDownIcon className="size-3 opacity-70" />
          </Button>
        }
      />
      <PopoverPopup
        side="top"
        align="end"
        padding="compact"
        className="w-72 max-w-[calc(100vw-1.5rem)]"
      >
        <PaModelPickerContent
          bot={bot}
          sessionId={sessionId}
          cached={cached?.botId === bot.botId ? cached.catalog : null}
          query={query}
          onQueryChange={onQueryChange}
          onLoaded={(catalog) => setCached({ botId: bot.botId, catalog })}
          onApplied={(model) => {
            setApplied({ base: bot.model, model });
            onModelChanged();
            onOpenChange(false);
          }}
        />
      </PopoverPopup>
    </Popover>
  );
}
