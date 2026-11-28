import {
  PA_AVATAR_VIEWBOX,
  paAvatarAnimates,
  paAvatarFrameTick,
  paAvatarLayers,
  paAvatarPalette,
  type PaAvatarTone,
} from "@t3tools/client-runtime/pa/avatar";
import type { PaAvatarShape } from "@t3tools/contracts";
import { useId, useState, useSyncExternalStore } from "react";

import { useMediaQuery } from "../../hooks/useMediaQuery";
import { getDocumentActivity, subscribeDocumentActivity } from "../../lib/documentActivity";
import { observeIntersection } from "../../lib/observeIntersection";
import { cn } from "../../lib/utils";

const STILL = () => () => {};
const documentVisible = () => getDocumentActivity().visible;
const FIRST_FRAME = () => 0;

const THEMED_TONES: Partial<Record<PaAvatarTone, string>> = {
  warn: "fill-warning-foreground",
  info: "fill-info",
  muted: "fill-muted-foreground/60",
};
const OBSIDIAN_TONES: Partial<Record<PaAvatarTone, string>> = {
  body: "fill-foreground/75",
  glow: "fill-foreground/55 dark:fill-foreground/90",
  glint: "fill-foreground/40 dark:fill-foreground",
};

/** The current frame of a working avatar; still when reduced motion is on or it is off screen. */
function useAvatarFrame(working: boolean) {
  const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const [onScreen, setOnScreen] = useState(true);
  const visible = useSyncExternalStore(
    working ? subscribeDocumentActivity : STILL,
    documentVisible,
    () => true,
  );
  const animate = working && visible && onScreen && !reducedMotion;
  const frame = useSyncExternalStore(
    animate ? paAvatarFrameTick.subscribe : STILL,
    animate ? paAvatarFrameTick.getSnapshot : FIRST_FRAME,
    FIRST_FRAME,
  );
  const ref = working
    ? (node: SVGSVGElement | null) => {
        if (!node) return;
        return observeIntersection(node, (entry) => setOnScreen(entry.isIntersecting));
      }
    : undefined;
  return { frame, ref };
}

export function BotAvatar({
  color,
  shape,
  size = "md",
  online = true,
  running = false,
  visible = true,
  awaiting = false,
  unread = false,
  starred = false,
  className,
}: {
  readonly color: string;
  readonly shape: PaAvatarShape;
  readonly size?: "sm" | "md" | "lg";
  readonly online?: boolean;
  readonly running?: boolean;
  readonly visible?: boolean;
  readonly awaiting?: boolean;
  readonly unread?: boolean;
  /** The default Bot, drawn with a small crown. */
  readonly starred?: boolean;
  readonly className?: string;
}) {
  const status = { online, working: running, awaiting, unread, isDefault: starred };
  const { frame, ref } = useAvatarFrame(visible && paAvatarAnimates(status));
  const gradientId = `pa-avatar-${useId().replace(/[^\w-]/gu, "")}`;
  const palette = paAvatarPalette(color);
  const dimension = size === "lg" ? "size-20" : size === "sm" ? "size-8" : "size-11";

  const toneFill = (tone: PaAvatarTone) => {
    if (THEMED_TONES[tone]) return { className: THEMED_TONES[tone] };
    if (!palette) return { className: OBSIDIAN_TONES[tone] };
    if (tone === "body") return { fill: `url(#${gradientId})` };
    return { fill: tone === "glow" ? palette.glow : palette.glint };
  };

  return (
    <svg
      ref={ref}
      viewBox={PA_AVATAR_VIEWBOX}
      className={cn("shrink-0", dimension, className)}
      aria-hidden="true"
    >
      {palette ? (
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor={palette.top} />
            <stop offset="1" stopColor={palette.bottom} />
          </linearGradient>
        </defs>
      ) : null}
      {paAvatarLayers(shape, status, frame).map((layer) => (
        <path key={layer.tone} d={layer.d} {...toneFill(layer.tone)} />
      ))}
    </svg>
  );
}

const EMPTY_STATE_BOTS = [
  { shape: "pumpkin", color: "#f97316" },
  { shape: "blob", color: "#14b8a6" },
  { shape: "cloud", color: "#8b5cf6" },
] as const;

/** Three Bots side by side, for empty states. */
export function BotAvatarTrio({ size = "md" }: { readonly size?: "sm" | "md" }) {
  return (
    <div className="flex items-end" aria-hidden="true">
      {EMPTY_STATE_BOTS.map((bot, index) => (
        <BotAvatar
          key={bot.shape}
          color={bot.color}
          shape={bot.shape}
          size={size}
          className={cn(index === 1 ? "-mx-1 -translate-y-1.5" : "opacity-80")}
        />
      ))}
    </div>
  );
}
