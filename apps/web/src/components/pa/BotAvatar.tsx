import { msg } from "gt-react";
import { StarIcon } from "lucide-react";

import { cn } from "../../lib/utils";
import type { PaAvatarShape } from "./paTypes";

export const PA_AVATAR_COLORS = [
  { label: msg("橙色"), value: "#f97316" },
  { label: msg("青绿"), value: "#14b8a6" },
  { label: msg("海蓝"), value: "#3b82f6" },
  { label: msg("翠绿"), value: "#10b981" },
  { label: msg("紫罗兰"), value: "#8b5cf6" },
  { label: msg("绯红"), value: "#ef4444" },
  { label: msg("琥珀"), value: "#f59e0b" },
  { label: msg("岩灰"), value: "#64748b" },
] as const;

export const PA_AVATAR_SHAPES = [
  { label: msg("南瓜"), value: "pumpkin" },
  { label: msg("圆球"), value: "circle" },
  { label: msg("团子"), value: "blob" },
  { label: msg("云朵"), value: "cloud" },
  { label: msg("胶囊"), value: "pill" },
  { label: msg("水滴"), value: "drop" },
] as const satisfies ReadonlyArray<{
  readonly label: ReturnType<typeof msg>;
  readonly value: PaAvatarShape;
}>;

const SAFE_HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

function sanitizeAvatarColor(color: string): string {
  return SAFE_HEX_COLOR_RE.test(color) ? color : PA_AVATAR_COLORS[0].value;
}

function ShapePath({ shape, color }: { readonly shape: PaAvatarShape; readonly color: string }) {
  const safeColor = sanitizeAvatarColor(color);
  switch (shape) {
    case "pumpkin":
      return (
        <>
          <path
            d="M29 14c0-5 2-8 6-9"
            className="text-muted-foreground"
            stroke="currentColor"
            strokeWidth="4.2"
            strokeLinecap="round"
            fill="none"
          />
          <path
            d="M32 15c13.5 0 24 8.5 23.5 21.5C55 48.5 45.5 55 32 55S9 48.5 8.5 36.5C8 23.5 18.5 15 32 15Z"
            fill={safeColor}
          />
        </>
      );
    case "cloud":
      return (
        <path
          d="M20 51c-7.5 0-13-5-13-11.5 0-5.4 3.8-9.8 9.2-11C18 20.4 24.4 15 32.5 15c8.4 0 15.1 5.8 16.4 13.7C54 29.7 58 34 58 39.5 58 46 52.5 51 45 51H20Z"
          fill={safeColor}
        />
      );
    case "drop":
      return (
        <path
          d="M30 9c8 8 22 18.5 22 30.5C52 49.5 43.2 56 32 56S12 49.5 12 39.5C12 27.5 22 17 30 9Z"
          fill={safeColor}
        />
      );
    case "pill":
      return (
        <rect
          x="10"
          y="12"
          width="44"
          height="42"
          rx="16"
          transform="rotate(-8 32 33)"
          fill={safeColor}
        />
      );
    case "blob":
      return (
        <path
          d="M34 10c12.5 0 22 8.2 22 21.8C56 45.5 46.8 55 32.5 55 18 55 8 46.5 8 33.5 8 19.5 20.5 10 34 10Z"
          fill={safeColor}
        />
      );
    case "circle":
    default:
      return <circle cx="32" cy="33" r="23" fill={safeColor} />;
  }
}

export function BotAvatar({
  color,
  shape,
  size = "md",
  starred = false,
  unread = false,
  running = false,
  className,
}: {
  readonly color: string;
  readonly shape: PaAvatarShape;
  readonly size?: "sm" | "md" | "lg";
  readonly starred?: boolean;
  readonly unread?: boolean;
  readonly running?: boolean;
  readonly className?: string;
}) {
  const dimension = size === "lg" ? "size-20" : size === "sm" ? "size-8" : "size-11";

  return (
    <div
      className={cn(
        "relative inline-flex shrink-0 items-center justify-center",
        dimension,
        className,
      )}
    >
      <svg
        viewBox="0 0 64 64"
        className={cn("size-full drop-shadow-xs", running && "animate-pulse")}
        aria-hidden="true"
      >
        <ShapePath shape={shape} color={color} />
        <g className="text-background">
          <ellipse
            cx="34"
            cy="32"
            rx="2.9"
            ry="6.1"
            transform="rotate(-12 34 32)"
            fill="currentColor"
            fillOpacity="0.88"
          />
          <ellipse
            cx="43"
            cy="30.5"
            rx="2.9"
            ry="6.1"
            transform="rotate(-12 43 30.5)"
            fill="currentColor"
            fillOpacity="0.88"
          />
        </g>
      </svg>

      {starred ? (
        <span
          className={cn(
            "absolute right-0 bottom-0 flex items-center justify-center rounded-full border-2 border-background bg-warning text-warning-foreground shadow-xs",
            size === "lg" ? "size-6" : "size-4",
          )}
        >
          <StarIcon className={cn("fill-current", size === "lg" ? "size-3.5" : "size-2.5")} />
        </span>
      ) : null}

      {unread && !starred ? (
        <span
          className={cn(
            "absolute right-0.5 bottom-0.5 rounded-full border-2 border-background bg-info",
            size === "lg" ? "size-3.5" : "size-2.5",
          )}
        />
      ) : null}
    </div>
  );
}
